#!/usr/bin/env node
/**
 * Claude Pacer — keeps your Claude subscription pace. Works on any plan that signs into Claude Code
 * (Pro / Max / Team): it reads the Claude Code OAuth credential from the keychain. Claude only.
 *
 *   pacer tick     sample the usage API + local transcripts, append to samples.jsonl, write status.json
 *   pacer status   print the current status (and refresh it from stored samples only — no network)
 *   pacer fit      show the fitted per-model weights and the data behind them
 *
 * Two data sources, joined here for the first time:
 *   1. https://api.anthropic.com/api/oauth/usage — server truth, percent per window, no breakdown.
 *   2. ~/.claude/projects/** /*.jsonl — every assistant message with model + token usage.
 * Each tick records both. Over days, a least-squares fit of Δpercent against tokens-by-model gives
 * MEASURED weights ("Fable burns N× Sonnet") instead of API-price guesses, and tests whether cache
 * reads are discounted. Nobody publishes these; your own account is the only honest source.
 *
 * The PACE number: for each limit window, where you will land at reset if you keep the average
 * speed shown since the window opened (long windows) or the last 45 min (the 5-hour session).
 * The headline is the worst window. 100 = you run out exactly at reset. >80 amber, >100 red.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const DIR = join(homedir(), '.claude', 'pacer')
const SAMPLES = join(DIR, 'samples.jsonl')
const STATUS = join(DIR, 'status.json')
const PROJECTS = join(homedir(), '.claude', 'projects')
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const TARGET = 80
const WINDOW_MIN = { session: 5 * 60, weekly_all: 7 * 24 * 60, weekly_scoped: 7 * 24 * 60 }
const LONG_WINDOW_MIN = 6 * 60
const RATE_WINDOW_MIN = 45
const MIN_ELAPSED = 0.02

// Token classes, and the API-price ratios used ONLY as the prior for how classes relate within a
// model (input 1, output 5, cache write 1.25, cache read 0.1). The per-model weight is what gets fitted.
const CLASSES = ['input', 'output', 'cache_write', 'cache_read']
const CLASS_PRIOR = { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 }
// Price-ratio priors per model relative to sonnet, used until the fit has enough trustworthy data.
const PRIOR_WEIGHT = { haiku: 0.3, sonnet: 1, opus: 5, fable: 10, mythos: 10, other: 5 }

mkdirSync(DIR, { recursive: true })

// ---------------------------------------------------------------- usage API
function oauthToken() {
  const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' }).trim()
  return JSON.parse(raw).claudeAiOauth?.accessToken
}
async function fetchUsage() {
  const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${oauthToken()}`, 'anthropic-beta': 'oauth-2025-04-20' } })
  if (!res.ok) throw new Error(`usage ${res.status}`)
  const j = await res.json()
  // Two response shapes have been seen in the wild: `limits[]`, and top-level five_hour/seven_day objects.
  if (Array.isArray(j.limits)) return j.limits.map(l => ({ kind: l.kind, scope: l.scope?.model?.display_name || null, percent: l.percent, resetsAt: Date.parse(l.resets_at) }))
  const out = []
  if (j.five_hour) out.push({ kind: 'session', scope: null, percent: j.five_hour.utilization, resetsAt: Date.parse(j.five_hour.resets_at) })
  if (j.seven_day) out.push({ kind: 'weekly_all', scope: null, percent: j.seven_day.utilization, resetsAt: Date.parse(j.seven_day.resets_at) })
  for (const [k, v] of Object.entries(j)) if (k.startsWith('seven_day_') && v?.utilization != null) out.push({ kind: 'weekly_scoped', scope: k.slice(10), percent: v.utilization, resetsAt: Date.parse(v.resets_at) })
  return out
}

// ---------------------------------------------------------------- local transcripts
function modelFamily(model) {
  const m = String(model || '').toLowerCase()
  for (const f of ['fable', 'mythos', 'opus', 'sonnet', 'haiku']) if (m.includes(f)) return f
  return m ? 'other' : null
}
function* jsonlFiles(dir) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* jsonlFiles(p)
    else if (e.name.endsWith('.jsonl')) yield p
  }
}
/** Tokens per model×class for assistant messages with timestamp in (since, until]. Deduped on requestId. */
function scanTokens(since, until) {
  const seen = new Map()   // requestId → { model, usage } (last row wins: streaming rows are cumulative)
  for (const f of jsonlFiles(PROJECTS)) {
    let st
    try { st = statSync(f) } catch { continue }
    if (st.mtimeMs < since) continue
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.includes('"usage"')) continue
      let d
      try { d = JSON.parse(line) } catch { continue }
      const t = Date.parse(d.timestamp)
      if (!(t > since && t <= until)) continue
      const u = d.message?.usage
      if (!u) continue
      seen.set(d.requestId || d.message?.id || `${f}:${t}`, { model: modelFamily(d.message?.model), u })
    }
  }
  const tokens = {}
  for (const { model, u } of seen.values()) {
    if (!model) continue
    const row = tokens[model] ||= { input: 0, output: 0, cache_write: 0, cache_read: 0, requests: 0 }
    row.input += u.input_tokens || 0
    row.output += u.output_tokens || 0
    row.cache_write += u.cache_creation_input_tokens || 0
    row.cache_read += u.cache_read_input_tokens || 0
    row.requests++
  }
  return tokens
}

// ---------------------------------------------------------------- samples
function loadSamples() {
  if (!existsSync(SAMPLES)) return []
  return readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// ---------------------------------------------------------------- pace
function windows(limits, samples, now) {
  return limits.map(l => {
    const key = l.kind + (l.scope ? ':' + l.scope : '')
    const percent = Number.isFinite(l.percent) ? l.percent : 0
    // An idle window (no usage yet) has resets_at: null — Date.parse(null) is NaN, and NaN here
    // poisoned everything downstream (pace showed "—", advice said "ease off for the next NaNh").
    // No reset time = the window hasn't started; it is idle by definition: speed 0, projected = used.
    if (!Number.isFinite(l.resetsAt)) {
      return { key, kind: l.kind, scope: l.scope, percent, long: (WINDOW_MIN[l.kind] || 300) > LONG_WINDOW_MIN, elapsed: 0, minutesLeft: null, speed: 0, rate: 0, projected: percent, allowedPerHour: null, resetsAt: null, idle: true }
    }
    const minutesLeft = Math.max(1, (l.resetsAt - now) / 60000)
    const length = WINDOW_MIN[l.kind] || Math.max(minutesLeft, 5 * 60)
    const long = length > LONG_WINDOW_MIN
    const elapsed = Math.min(1, Math.max(0, 1 - minutesLeft / length))
    // Short window: rate over the last 45 min projected to the reset.
    const hist = samples.filter(s => now - s.t <= RATE_WINDOW_MIN * 60000).map(s => ({ t: s.t, p: s.limits.find(m => m.kind === l.kind && (m.scope || null) === (l.scope || null))?.percent })).filter(x => x.p != null)
    let rate = 0
    const first = hist.find(x => Number.isFinite(x.p) && x.p <= percent)
    if (first && now - first.t > 5 * 60000) rate = (percent - first.p) / ((now - first.t) / 60000)
    const elapsedMin = Math.max(length - minutesLeft, MIN_ELAPSED * length)
    const speed = percent / elapsedMin * 60
    const projected = long ? percent / Math.max(elapsed, MIN_ELAPSED) : percent + Math.max(0, rate) * minutesLeft
    // What you may spend per hour from here to land exactly on TARGET.
    const allowedPerHour = Math.max(0, TARGET - percent) / minutesLeft * 60
    return { key, kind: l.kind, scope: l.scope, percent, long, elapsed, minutesLeft, speed, rate: rate * 60, projected: Number.isFinite(projected) ? projected : percent, allowedPerHour, resetsAt: l.resetsAt }
  })
}

/** Observed resets: a drop in a window's percent between consecutive samples. Tells the real window length. */
function observedResets(samples) {
  const out = {}
  for (let i = 1; i < samples.length; i++) {
    for (const l of samples[i].limits) {
      const key = l.kind + (l.scope ? ':' + l.scope : '')
      const prev = samples[i - 1].limits.find(m => m.kind === l.kind && (m.scope || null) === (l.scope || null))
      if (prev && l.percent < prev.percent - 5) (out[key] ||= []).push(samples[i].t)
    }
  }
  return out
}

// ---------------------------------------------------------------- fit
// Δpercent(weekly_all) = Σ_model w_model × units_model, units = Σ_class prior_class × tokens.
// Non-negative least squares by projected gradient — tiny problem, no library.
function nnls(X, y, iters = 20000) {
  const n = X[0]?.length || 0
  if (!n) return null
  let w = new Array(n).fill(0)
  // Lipschitz step from the Gram diagonal
  const diag = new Array(n).fill(0)
  for (const row of X) row.forEach((v, j) => { diag[j] += v * v })
  const step = 1 / (Math.max(...diag) * n || 1)
  for (let it = 0; it < iters; it++) {
    const grad = new Array(n).fill(0)
    X.forEach((row, i) => { const r = row.reduce((s, v, j) => s + v * w[j], 0) - y[i]; row.forEach((v, j) => { grad[j] += 2 * r * v }) })
    let moved = 0
    for (let j = 0; j < n; j++) { const nw = Math.max(0, w[j] - step * grad[j]); moved += Math.abs(nw - w[j]); w[j] = nw }
    if (moved < 1e-12) break
  }
  return w
}
// The weekly percent is an INTEGER, so a 10-minute delta is 0 or 1 and a per-sample regression fits
// quantisation noise (34 samples once "measured" Fable at 0.22× Sonnet). Samples are therefore
// accumulated into bins that each span ≥ FIT_BIN_PCT points before fitting, and a fit is only
// trusted when it has ≥ FIT_MIN_BINS bins and every weight lands within PLAUSIBLE× of the prior.
const FIT_BIN_PCT = 3, FIT_MIN_BINS = 40, PLAUSIBLE = 4
function fit(samples, { cacheReadPrior = CLASS_PRIOR.cache_read } = {}) {
  const models = ['sonnet', 'opus', 'fable', 'haiku', 'other'].filter(m => samples.some(s => s.tokens?.[m]))
  const X = [], y = []
  let bin = null
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i].limits.find(l => l.kind === 'weekly_all'), prev = samples[i - 1].limits.find(l => l.kind === 'weekly_all')
    if (!cur || !prev || cur.percent < prev.percent) { bin = null; continue }   // reset: drop the open bin
    bin ||= { start: prev.percent, row: new Array(models.length).fill(0) }
    models.forEach((m, j) => { const t = samples[i].tokens?.[m]; if (t) bin.row[j] += (t.input * CLASS_PRIOR.input + t.output * CLASS_PRIOR.output + t.cache_write * CLASS_PRIOR.cache_write + t.cache_read * cacheReadPrior) / 1e6 })
    if (cur.percent - bin.start >= FIT_BIN_PCT) { X.push(bin.row); y.push(cur.percent - bin.start); bin = null }
  }
  if (!models.includes('sonnet') || models.length < 2 || X.length < FIT_MIN_BINS) return { models, n: X.length, enough: false }
  const w = nnls(X, y)
  const si = models.indexOf('sonnet')
  if (!(w[si] > 0)) return { models, n: X.length, enough: false, why: 'sonnet weight 0' }
  for (const [j, m] of models.entries()) {
    if (m === 'other' || !(w[j] > 0)) continue
    const rel = w[j] / w[si], prior = PRIOR_WEIGHT[m] || 5
    if (rel > prior * PLAUSIBLE || rel < prior / PLAUSIBLE) return { models, n: X.length, enough: false, why: `${m} ${rel.toFixed(2)}× implausible vs prior ${prior}×` }
  }
  const resid = X.reduce((s, row, i) => s + (row.reduce((a, v, j) => a + v * w[j], 0) - y[i]) ** 2, 0)
  const base = w[models.indexOf('sonnet')] || Math.min(...w.filter(v => v > 0)) || 1
  return { models, n: X.length, enough: true, weights: Object.fromEntries(models.map((m, j) => [m, w[j]])), relative: Object.fromEntries(models.map((m, j) => [m, w[j] / base])), residual: resid, cacheReadPrior }
}

// ---------------------------------------------------------------- advice
const NAMES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable', mythos: 'Mythos', other: 'other models' }
function units(t, cacheReadPrior = CLASS_PRIOR.cache_read) {
  return (t.input * CLASS_PRIOR.input + t.output * CLASS_PRIOR.output + t.cache_write * CLASS_PRIOR.cache_write + t.cache_read * cacheReadPrior) / 1e6
}
/** One sentence: what to change to land at 100% of the worst window, or null when on pace. */
function advise(ws, samples, fitted, now) {
  const worst = ws.filter(w => Number.isFinite(w.projected) && !w.idle).reduce((a, w) => (!a || w.projected > a.projected) ? w : a, null)
  if (!worst || worst.projected <= 100) return null
  const remaining = 100 - worst.percent
  if (remaining <= 0) return `${label(worst)} is used up — wait ${Math.round(worst.minutesLeft / 60)}h for the reset`
  const keep = remaining / (worst.projected - worst.percent)   // fraction of current speed that still fits
  const cut = 1 - keep
  if (!worst.long) return Number.isFinite(worst.minutesLeft)
    ? `this session is burning fast — ease off for the next ${Math.round(worst.minutesLeft / 60 * 10) / 10}h (about ${Math.round(cut * 100)}% less)`
    : `this session is burning fast — ease off (about ${Math.round(cut * 100)}% less)`
  const weight = fitted?.enough ? { ...PRIOR_WEIGHT, ...fitted.relative } : PRIOR_WEIGHT
  // weighted spend share per model across this window
  const share = {}
  let total = 0
  for (const s of samples) {
    if (s.t < now - (WINDOW_MIN[worst.kind] || 10080) * 60000) continue
    for (const [m, t] of Object.entries(s.tokens || {})) { const u = units(t) * (weight[m] ?? 5); share[m] = (share[m] || 0) + u; total += u }
  }
  if (!total) return `spend needs to drop ~${Math.round(cut * 100)}% to fit ${label(worst)} — no per-model data yet`
  for (const m in share) share[m] /= total
  if (worst.kind === 'weekly_scoped') return `use ${worst.scope} about ${Math.round(cut * 100)}% less (it has its own weekly limit)`
  const steps = []
  let need = cut
  for (const heavy of ['fable', 'mythos']) {
    if (need <= 0 || !share[heavy]) continue
    const saving = Math.max(0, share[heavy] * (1 - weight.opus / weight[heavy]))   // moving that work to Opus
    if (saving > 0 && saving >= need) { steps.push(`use ${NAMES[heavy]} about ${Math.round(need / saving * 100)}% less`); need = 0 }
    else if (saving > 0) { steps.push(`stop using ${NAMES[heavy]}`); need -= saving }
  }
  if (need > 0 && share.opus) {
    const saving = Math.max(0, share.opus * (1 - weight.sonnet / weight.opus))   // moving Opus work to Sonnet
    if (saving > 0 && saving >= need) { steps.push(`move about ${Math.round(need / saving * 100)}% of Opus work to Sonnet`); need = 0 }
    else if (saving > 0) { steps.push('move all Opus work to Sonnet'); need -= saving }
  }
  if (need > 0) steps.push(`${steps.length ? 'and still ' : ''}do about ${Math.min(100, Math.round(need * 100))}% less overall`)
  return `to fit ${label(worst)}: ` + steps.join(', ')
}
function label(w) { return w.kind === 'session' ? 'this session' : w.kind === 'weekly_all' ? 'the week' : `the ${w.scope} week` }

// ---------------------------------------------------------------- API-equivalent cost
// First-party API list prices, USD per 1M tokens (input, output); cache write = 1.25× input, cache read = 0.1× input.
const PRICE = { fable: [10, 50], mythos: [10, 50], opus: [5, 25], sonnet: [3, 15], haiku: [1, 5], other: [5, 25] }
function costOf(tokens) {
  let total = 0
  const byModel = {}
  for (const [m, t] of Object.entries(tokens)) {
    const [pin, pout] = PRICE[m] || PRICE.other
    const usd = (t.input * pin + t.cache_write * pin * 1.25 + t.cache_read * pin * 0.1 + t.output * pout) / 1e6
    byModel[m] = Math.round(usd * 100) / 100
    total += usd
  }
  return { total: Math.round(total * 100) / 100, byModel }
}

// ---------------------------------------------------------------- status
function spendSince(samples, ms, now) {
  const out = {}
  for (const s of samples) {
    if (now - s.t > ms) continue
    for (const [m, t] of Object.entries(s.tokens || {})) {
      const row = out[m] ||= { input: 0, output: 0, cache_write: 0, cache_read: 0, requests: 0 }
      for (const k of Object.keys(row)) row[k] += t[k] || 0
    }
  }
  return out
}
function weekMs(ws, now) { const w = ws.find(x => x.kind === 'weekly_all'); return w ? Math.max(0, WINDOW_MIN.weekly_all * 60000 - w.minutesLeft * 60000) : 7 * 24 * 3600000 }
function buildStatus(limits, samples, now) {
  const ws = windows(limits, samples, now)
  const live = ws.filter(w => Number.isFinite(w.projected))
  const worst = live.reduce((a, w) => (!a || w.projected > a.projected) ? w : a, null)
  const pace = worst ? Math.round(worst.projected) : null
  const level = pace == null ? 'unknown' : pace > 100 ? 'red' : pace > TARGET ? 'amber' : 'green'
  const fitted = fit(samples)
  const fitCache1 = fit(samples, { cacheReadPrior: 1 })
  return {
    t: now, pace, level, worst: worst?.key || null, target: TARGET,
    advice: advise(ws, samples, fitted, now),
    windows: ws,
    resets: observedResets(samples),
    spend24h: spendSince(samples, 24 * 3600000, now),
    // What the same tokens would have cost on the API: today, and since the week window opened (as far back as samples go).
    cost: { day: costOf(spendSince(samples, 24 * 3600000, now)), week: costOf(spendSince(samples, weekMs(ws, now), now)), since: samples[0]?.t || now },
    fit: fitted,
    // Same fit with cache reads at full price: whichever residual is lower says how the limit treats cache.
    fitCacheFull: fitCache1.enough ? { residual: fitCache1.residual, relative: fitCache1.relative } : null,
    samples: samples.length,
  }
}

// ---------------------------------------------------------------- commands
async function tick() {
  const now = Date.now()
  const samples = loadSamples()
  const last = samples.at(-1)?.t || now - 10 * 60000
  let limits
  try { limits = await fetchUsage() } catch (e) {
    const status = existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, 'utf8')) : {}
    status.error = `usage unreadable: ${e.message}`; status.t = now
    writeFileSync(STATUS, JSON.stringify(status, null, 2))
    console.error(status.error); process.exit(1)
  }
  const tokens = scanTokens(last, now)
  const sample = { t: now, limits, tokens }
  appendFileSync(SAMPLES, JSON.stringify(sample) + '\n')
  samples.push(sample)
  const status = buildStatus(limits, samples, now)
  writeFileSync(STATUS, JSON.stringify(status, null, 2))
  printStatus(status)
}
function status() {
  const samples = loadSamples()
  const last = samples.at(-1)
  if (!last) { console.log('no samples yet — run `pacer tick`'); return }
  const s = buildStatus(last.limits, samples, last.t)
  writeFileSync(STATUS, JSON.stringify(s, null, 2))
  printStatus(s)
}
function printStatus(s) {
  console.log(`PACE ${s.pace} (${s.level.toUpperCase()}, worst: ${s.worst})  — ${new Date(s.t).toISOString()}`)
  console.log(`  ${s.advice || 'on pace — nothing to change'}`)
  console.log(`  API-equivalent cost: today $${s.cost.day.total} · this week $${s.cost.week.total} (${Object.entries(s.cost.week.byModel).map(([m, v]) => `${m} $${v}`).join(', ')})`)
  for (const w of s.windows) {
    console.log(w.long
      ? `  ${w.key.padEnd(20)} ${String(w.percent).padStart(3)}% at ${Math.round(w.elapsed * 100)}% of window · ${w.speed.toFixed(2)}%/h avg → ${Math.round(w.projected)}% at reset · may spend ${w.allowedPerHour.toFixed(2)}%/h to hit ${s.target} · ${Math.round(w.minutesLeft / 60)}h left`
      : `  ${w.key.padEnd(20)} ${String(w.percent).padStart(3)}% · ${w.rate.toFixed(1)}%/h last ${RATE_WINDOW_MIN}m → ${Math.round(w.projected)}% at reset · ${Math.round(w.minutesLeft / 60)}h left`)
  }
  const sp = Object.entries(s.spend24h)
  if (sp.length) console.log('  last 24h tokens (M): ' + sp.map(([m, t]) => `${m} in ${(t.input / 1e6).toFixed(1)} out ${(t.output / 1e6).toFixed(2)} cw ${(t.cache_write / 1e6).toFixed(1)} cr ${(t.cache_read / 1e6).toFixed(0)} (${t.requests} req)`).join(' · '))
  if (s.fit?.enough) {
    console.log('  fitted weight vs sonnet: ' + Object.entries(s.fit.relative).map(([m, r]) => `${m} ${r.toFixed(1)}×`).join(', ') + `  (${s.fit.n} samples, residual ${s.fit.residual.toFixed(2)})`)
    if (s.fitCacheFull) console.log(`  cache reads: ${s.fitCacheFull.residual < s.fit.residual ? 'fit better at FULL price' : 'fit better DISCOUNTED (0.1×)'} (residual ${s.fitCacheFull.residual.toFixed(2)} vs ${s.fit.residual.toFixed(2)})`)
  } else if (s.fit) console.log(`  fit: ${s.fit.n} usable samples so far, need ~${s.fit.models.length * 3} with a mix of models`)
  for (const [k, ts] of Object.entries(s.resets)) console.log(`  observed resets ${k}: ` + ts.map(t => new Date(t).toISOString().slice(0, 16)).join(', '))
}

const cmd = process.argv[2] || 'status'
if (cmd === 'tick') await tick()
else if (cmd === 'status') status()
else if (cmd === 'fit') { const s = loadSamples(); console.log(JSON.stringify({ prior: fit(s), cacheFull: fit(s, { cacheReadPrior: 1 }) }, null, 2)) }
else { console.log('usage: pacer tick|status|fit'); process.exit(1) }

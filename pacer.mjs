#!/usr/bin/env node
/**
 * Pacer — keeps your subscription pace. Claude Code (Pro / Max / Team: reads its OAuth credential from the keychain) and Codex (~/.codex/auth.json).
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
import { createHash } from 'node:crypto'

const DIR = join(homedir(), '.claude', 'pacer')
const SAMPLES = join(DIR, 'samples.jsonl')
const STATUS = join(DIR, 'status.json')
const ACCOUNTS = join(DIR, 'accounts.json')
const CODEX = join(homedir(), '.codex')
const FORGET_AFTER = 7 * 24 * 3600000   // an account not seen for a week drops off
const PROJECTS = join(homedir(), '.claude', 'projects')
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

const TARGET = 80
const WINDOW_MIN = { session: 5 * 60, weekly_all: 7 * 24 * 60, weekly_scoped: 7 * 24 * 60, daily: 24 * 60, monthly: 30 * 24 * 60 }
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
/** Every Claude Code login on this machine: the default one, plus each CLAUDE_CONFIG_DIR profile (~/.claude-*).
 *  A profile's keychain entry is the default name suffixed with the first 8 hex of sha256(its directory) — how
 *  Claude Code itself names it; a `.credentials.json` inside the directory is its fallback where there is no keychain. */
function profiles() {
  const out = [{ dir: null, service: 'Claude Code-credentials', config: join(homedir(), '.claude.json') }]
  for (const e of readdirSync(homedir(), { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('.claude-')) continue
    const dir = join(homedir(), e.name)
    if (!existsSync(join(dir, '.claude.json'))) continue
    out.push({ dir, service: 'Claude Code-credentials-' + createHash('sha256').update(dir).digest('hex').slice(0, 8), config: join(dir, '.claude.json') })
  }
  return out
}
function credential(profile) {
  let raw
  try { raw = execFileSync('security', ['find-generic-password', '-s', profile.service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch {
    if (!profile.dir) throw new Error('no Claude Code login in the keychain')
    const file = join(profile.dir, '.credentials.json')
    if (!existsSync(file)) return null   // a profile nobody has logged into yet is not an error
    raw = readFileSync(file, 'utf8')
  }
  return JSON.parse(raw).claudeAiOauth || {}
}
/** Who the credential belongs to. Asked of the API with the same token the usage read uses, so the two
 *  can never describe different accounts; ~/.claude.json is the offline fallback. */
async function identity(cred, profile) {
  const tier = /(\d+x)/.exec(cred.rateLimitTier || '')?.[1]
  const sub = cred.subscriptionType ? cred.subscriptionType[0].toUpperCase() + cred.subscriptionType.slice(1) : null
  const plan = [sub, tier].filter(Boolean).join(' ') || null
  try {
    const res = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' } })
    if (res.ok) { const j = await res.json(); if (j.account?.uuid) return { id: j.account.uuid, email: j.account.email, plan } }
  } catch {}
  try { const o = JSON.parse(readFileSync(profile.config, 'utf8')).oauthAccount; if (o?.accountUuid) return { id: o.accountUuid, email: o.emailAddress, plan } } catch {}
  return { id: 'unknown', email: null, plan }
}
async function fetchUsage(cred) {
  const res = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' } })
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
    const length = l.windowMin || WINDOW_MIN[l.kind] || Math.max(minutesLeft, 5 * 60)   // a provider that states its own cycle (a billing month) wins
    const long = length > LONG_WINDOW_MIN
    const elapsed = Math.min(1, Math.max(0, 1 - minutesLeft / length))
    // Short window: rate over the last 45 min projected to the reset.
    const hist = samples.filter(s => now - s.t <= RATE_WINDOW_MIN * 60000).map(s => ({ t: s.t, p: s.limits.find(m => m.kind === l.kind && (m.scope || null) === (l.scope || null))?.percent })).filter(x => x.p != null)
    let rate = 0
    const first = hist.find(x => Number.isFinite(x.p) && x.p <= percent)
    if (first && now - first.t > 5 * 60000) rate = (percent - first.p) / ((now - first.t) / 60000)
    const elapsedMin = Math.max(length - minutesLeft, MIN_ELAPSED * length)
    const speed = percent / elapsedMin * 60
    // A wrapper's allowance opens on first use, so its first reading is always "a few % at ~0% elapsed" — which
    // extrapolates to hundreds. Until a twentieth of that window has passed there is no speed to speak of yet.
    const tooEarly = l.kind === 'quota' && elapsed < 0.05
    const projected = tooEarly ? percent : long ? percent / Math.max(elapsed, MIN_ELAPSED) : percent + Math.max(0, rate) * minutesLeft
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
function label(w) { return w.kind === 'session' ? 'this session' : w.kind === 'weekly_all' ? 'the week' : w.kind === 'monthly' ? 'the month' : w.kind === 'quota' ? `the ${w.scope} allowance` : w.kind === 'daily' ? `today's ${w.scope || ''} quota`.replace('  ', ' ') : `the ${w.scope} week` }

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

// ---------------------------------------------------------------- accounts
// Every subscription seen on this machine keeps its last reading, so the one you are NOT logged into
// still shows where you left it and when it comes back. Its windows are re-derived at read time: a
// reset that has passed since the reading zeroes that window instead of freezing it at the old figure.
function loadAccounts() { try { return JSON.parse(readFileSync(ACCOUNTS, 'utf8')) } catch { return {} } }
// Keep in step with `rolled()` in Pacer.swift, which applies the same rule between two ticks.
function rolled(limits, now) { return limits.map(l => Number.isFinite(l.resetsAt) && l.resetsAt <= now ? { ...l, percent: 0, resetsAt: null } : l) }
function rememberAccount(accounts, acct, now) {
  const fresh = !accounts[acct.id]
  accounts[acct.id] = { ...accounts[acct.id], ...acct, asOf: now }
  // A reading recovered from before accounts were tracked is the same subscription if its week ends at the same moment.
  const week = l => l?.find(x => x.kind === 'weekly_all')?.resetsAt
  if (fresh && acct.provider === 'claude' && accounts.legacy && Math.abs(week(accounts.legacy.limits) - week(acct.limits)) < 120000) delete accounts.legacy
  for (const [id, a] of Object.entries(accounts)) if (now - a.asOf > FORGET_AFTER) delete accounts[id]
}
/** Codex's limits, asked live with the login in ~/.codex/auth.json (the endpoint its own /status reads).
 *  Its session transcripts carry the same figures, so they give the recent history for a rate — and the
 *  whole reading when the live ask fails (expired token, offline) or `live` is off. */
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
async function codexLive(auth, now) {
  const res = await fetch(CODEX_USAGE_URL, { headers: { Authorization: `Bearer ${auth.tokens.access_token}`, 'ChatGPT-Account-Id': auth.tokens.account_id || '', 'User-Agent': 'claude-pacer', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`codex usage ${res.status}`)
  const j = await res.json()
  const limits = []
  for (const w of [j.rate_limit?.primary_window, j.rate_limit?.secondary_window]) if (w?.used_percent != null) limits.push({ kind: w.limit_window_seconds / 60 > LONG_WINDOW_MIN ? 'weekly_all' : 'session', scope: null, percent: w.used_percent, resetsAt: w.reset_at ? w.reset_at * 1000 : null })
  if (!limits.length) throw new Error('codex usage: no windows')
  return { t: now, limits, email: j.email, plan: j.plan_type }
}
async function codexReading(now, live = false) {
  let auth
  try { auth = JSON.parse(readFileSync(join(CODEX, 'auth.json'), 'utf8')) } catch { return null }
  let claims = {}
  try { claims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString()) } catch {}
  const info = claims['https://api.openai.com/auth'] || {}
  const id = 'codex:' + (auth.tokens?.account_id || info.chatgpt_account_id || 'unknown')
  const plan = info.chatgpt_plan_type ? info.chatgpt_plan_type[0].toUpperCase() + info.chatgpt_plan_type.slice(1) : null
  const readings = []
  for (const f of jsonlFiles(join(CODEX, 'sessions'))) {
    let st
    try { st = statSync(f) } catch { continue }
    if (now - st.mtimeMs > FORGET_AFTER) continue
    let text
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.includes('"rate_limits"')) continue
      let d
      try { d = JSON.parse(line) } catch { continue }
      const rl = d.payload?.rate_limits || d.payload?.info?.rate_limits || d.rate_limits
      const t = Date.parse(d.timestamp)
      if (!rl?.primary || !Number.isFinite(t)) continue
      const limits = []
      for (const w of [rl.primary, rl.secondary]) if (w?.used_percent != null) limits.push({ kind: w.window_minutes > LONG_WINDOW_MIN ? 'weekly_all' : 'session', scope: null, percent: w.used_percent, resetsAt: w.resets_at ? w.resets_at * 1000 : w.resets_in_seconds != null ? t + w.resets_in_seconds * 1000 : null })
      readings.push({ t, limits })
    }
  }
  readings.sort((a, b) => a.t - b.t)
  let email = claims.email || null, planName = plan
  if (live && auth.tokens?.access_token) {
    try { const r = await codexLive(auth, now); readings.push({ t: r.t, limits: r.limits }); email = r.email || email; if (r.plan) planName = r.plan[0].toUpperCase() + r.plan.slice(1) } catch (e) { console.error(e.message) }
  }
  if (!readings.length) return null
  return { acct: { id, provider: 'codex', email, plan: planName, limits: readings.at(-1).limits }, asOf: readings.at(-1).t, readings }
}
/** For a subscription you are not on: is it worth switching back, and if not, when. */
function standby(ws) {
  const full = ws.filter(w => w.percent >= 90 && w.minutesLeft)
  if (!full.length) {
    const worst = ws.reduce((a, w) => !a || w.percent > a.percent ? w : a, null)   // not every provider has a week
    return 'ready to switch back — ' + (!worst?.percent ? 'everything has reset' : `${label(worst).replace(/^this |^the /, '')} at ${worst.percent}%`)
  }
  const wait = full.reduce((a, w) => w.minutesLeft > a.minutesLeft ? w : a)
  const m = Math.round(wait.minutesLeft), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60)
  return `${full.map(w => label(w).replace(/^this |^the /, '')).join(' and ')} nearly used — back in ${d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m}m`}`
}
// ---------------------------------------------------------------- other providers
// A provider is one function: (now) → { acct: { id, provider, email, plan, limits[] }, asOf, readings[] } or null.
// `limits` is the same shape the Claude read produces — kind, scope, percent, resetsAt (+ windowMin when the
// provider states its own cycle) — and everything downstream (accounts, resets, tabs, rings) is shared.
// A provider with no login on this machine returns null and costs nothing; one that throws is skipped.
const cap = x => x ? x[0].toUpperCase() + x.slice(1) : null

/** Cursor: the IDE's own login (state.vscdb) against the endpoint its dashboard reads. One window, the billing month. */
async function cursorReading(now) {
  const db = join(homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
  if (!existsSync(db)) return null
  const get = k => { try { return execFileSync('sqlite3', [`file:${db}?mode=ro`, `select value from ItemTable where key='cursorAuth/${k}'`], { encoding: 'utf8' }).trim() } catch { return '' } }
  const token = get('accessToken')
  if (!token) return null
  const uid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub.split('|').pop()
  const res = await fetch('https://cursor.com/api/usage-summary', { headers: { Cookie: `WorkosCursorSessionToken=${uid}%3A%3A${token}`, 'User-Agent': 'pacer', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`cursor usage ${res.status}`)
  const j = await res.json()
  const plan = j.individualUsage?.plan
  // A free seat has no included usage: there is no limit to pace against, so it gets no tab.
  if (!plan?.enabled || !(plan.limit > 0) || j.isUnlimited) return null
  const start = Date.parse(j.billingCycleStart), end = Date.parse(j.billingCycleEnd)
  const limits = [{ kind: 'monthly', scope: null, percent: Math.round(plan.totalPercentUsed ?? plan.used / plan.limit * 100), resetsAt: end, windowMin: (end - start) / 60000 || undefined }]
  return { acct: { id: 'cursor:' + uid, provider: 'cursor', email: get('cachedEmail') || null, plan: cap(j.membershipType), limits }, asOf: now, readings: [] }
}

/** Gemini CLI (Code Assist login). UNTESTED against a live account — written from the CLI's own `/stats` call.
 *  Uses the CLI's stored access token as-is: it never refreshes one, so an expired token means "no reading"
 *  and the account simply shows its last one until the CLI runs again. Quotas are per model, per day. */
async function geminiReading(now) {
  let creds
  try { creds = JSON.parse(readFileSync(join(homedir(), '.gemini', 'oauth_creds.json'), 'utf8')) } catch { return null }
  if (!creds.access_token || (creds.expiry_date && creds.expiry_date < now + 60000)) return null
  const call = async (method, body) => {
    const res = await fetch(`https://cloudcode-pa.googleapis.com/v1internal:${method}`, { method: 'POST', headers: { Authorization: `Bearer ${creds.access_token}`, 'Content-Type': 'application/json', 'User-Agent': 'pacer' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
    if (res.status === 403) return {}   // a personal account: Google moved those to Antigravity, this login has no quota to read
    if (!res.ok) throw new Error(`gemini ${method} ${res.status}`)
    return res.json()
  }
  const load = await call('loadCodeAssist', { metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } })
  const project = load.cloudaicompanionProject?.id || load.cloudaicompanionProject
  const quota = await call('retrieveUserQuota', project ? { project } : {})
  const limits = (quota.buckets || []).filter(b => b.remainingFraction != null && (!b.tokenType || b.tokenType === 'REQUESTS'))
    .map(b => ({ kind: 'daily', scope: String(b.modelId || 'all').replace(/^gemini-/, ''), percent: Math.round((1 - b.remainingFraction) * 100), resetsAt: b.resetTime ? Date.parse(b.resetTime) : null }))
    .sort((a, b) => b.percent - a.percent).slice(0, 3)
  if (!limits.length) return null
  let email = null
  try { email = JSON.parse(Buffer.from(creds.id_token.split('.')[1], 'base64url').toString()).email } catch {}
  return { acct: { id: 'gemini:' + (email || project || 'default'), provider: 'gemini', email, plan: load.currentTier?.name || null, limits }, asOf: now, readings: [] }
}

/** GitHub Copilot, through the `gh` login. UNTESTED against a paid seat (this machine's account has none, which
 *  is the null branch below). Premium requests are the binding quota; it resets monthly. */
async function copilotReading(now) {
  let token
  try { token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
  if (!token) return null
  const res = await fetch('https://api.github.com/copilot_internal/user', { headers: { Authorization: `token ${token}`, 'Editor-Version': 'vscode/1.95.0', 'User-Agent': 'pacer' }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`copilot ${res.status}`)
  const j = await res.json()
  const q = j.quota_snapshots?.premium_interactions
  if (!q || q.unlimited || q.percent_remaining == null) return null
  const limits = [{ kind: 'monthly', scope: null, percent: Math.round(100 - q.percent_remaining), resetsAt: j.quota_reset_date ? Date.parse(j.quota_reset_date) : null }]
  return { acct: { id: 'copilot:' + j.login, provider: 'copilot', email: j.login, plan: cap(j.copilot_plan), limits }, asOf: now, readings: [] }
}
/** Antigravity (Google's agent app — where personal Gemini accounts now live). The quota is only held by the
 *  app's own local language server, so this reads it while the app is running and otherwise returns null,
 *  which leaves the account on its last reading. Every model has its own weekly allowance; models are folded
 *  into families (the worst of each), since fourteen rows of "Flash (Low)" say nothing a family row doesn't. */
async function antigravityReading(now) {
  let ps
  try { ps = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }) } catch { return null }
  const line = ps.split('\n').find(l => l.includes('Antigravity.app') && l.includes('language_server') && l.includes('--csrf_token'))
  if (!line) return null
  const pid = line.trim().split(/\s+/)[0], csrf = /--csrf_token[= ](\S+)/.exec(line)?.[1]
  let ports = []
  try { ports = [...new Set(execFileSync('lsof', ['-nP', '-a', '-p', pid, '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).split('\n').slice(1).map(l => /:(\d+) \(LISTEN\)/.exec(l)?.[1]).filter(Boolean))] } catch {}
  let status
  for (const port of ports) {   // it listens on an https port and a plain one; only the plain one answers a bare fetch
    try {
      const res = await fetch(`http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': csrf }, body: JSON.stringify({ metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' } }), signal: AbortSignal.timeout(4000) })
      if (res.ok) { status = (await res.json()).userStatus; break }
    } catch {}
  }
  if (!status) return null
  // Antigravity is a wrapper: one Google plan reselling several vendors' models, each with its own allowance.
  // So it is not one tab — it is one tab per VENDOR (whose model you are spending), marked "via Antigravity".
  const vendorOf = label => /gemini/i.test(label) ? 'gemini' : /claude/i.test(label) ? 'claude' : /gpt|openai/i.test(label) ? 'openai' : 'other'
  const family = label => /gemini.*pro/i.test(label) ? 'Gemini Pro' : /gemini/i.test(label) ? 'Gemini Flash' : /claude.*opus/i.test(label) ? 'Claude Opus' : /claude/i.test(label) ? 'Claude Sonnet' : label.replace(/\s*\(.*\)$/, '')
  const byVendor = {}
  for (const m of status.cascadeModelConfigData?.clientModelConfigs || []) {
    const q = m.quotaInfo
    if (q?.remainingFraction == null && !q?.resetTime) continue
    const percent = Math.round((1 - (q.remainingFraction ?? 0)) * 100), f = family(m.label || 'model'), rows = byVendor[vendorOf(m.label || '')] ||= {}
    const resetsAt = q.resetTime ? Date.parse(q.resetTime) : null
    // The app reports one reset per model and no window length; a reset days away is a weekly allowance, a near one a short window.
    if (!rows[f] || percent > rows[f].percent) rows[f] = { kind: 'quota', scope: f, percent, resetsAt, windowMin: resetsAt && resetsAt - now < 24 * 3600000 ? WINDOW_MIN.session : WINDOW_MIN.weekly_all }
  }
  const TITLES = { gemini: 'Gemini', claude: 'Claude', openai: 'GPT-OSS', other: 'Other models' }
  const plan = status.planStatus?.planInfo?.planName || null
  return Object.entries(byVendor).map(([vendor, rows]) => ({
    acct: { id: `antigravity:${status.email || 'default'}:${vendor}`, provider: 'antigravity', vendor, title: TITLES[vendor], via: 'Antigravity', email: status.email || null, plan, limits: Object.values(rows).sort((a, b) => b.percent - a.percent || a.scope.localeCompare(b.scope)).slice(0, 3) },
    asOf: now, readings: [],
  }))
}
const PROVIDERS = [cursorReading, geminiReading, antigravityReading, copilotReading]

const VENDOR = { codex: 'openai' }
const ORDER = ['claude', 'codex', 'cursor', 'gemini', 'antigravity', 'copilot']
function accountsView(accounts, currentId, samples, now, live, firstId = currentId) {
  return Object.values(accounts).map(a => {
    const current = a.id === currentId || a.id in live   // one live login per provider
    const hist = a.id === currentId ? samples : current ? live[a.id] : []
    // Not logged in = nothing is being spent: it lands at reset exactly where it stands now.
    const ws = windows(rolled(a.limits || [], now), hist, now).map(w => current ? w : { ...w, speed: 0, rate: 0, projected: w.percent })
    const advice = a.id === currentId ? advise(ws, hist, null, now) : current ? (advise(ws, hist, null, now) || '').replace(' — no per-model data yet', '') || null : standby(ws)
    return { id: a.id, provider: a.provider, vendor: a.vendor || VENDOR[a.provider] || a.provider, title: a.title || null, via: a.via || null, email: a.email, plan: a.plan, current, asOf: a.asOf, windows: ws, advice }
  // The Claude login used last leads, so it is the tab the menu bar opens on; your own subscriptions by provider, then what a wrapper resells.
  }).sort((a, b) => ((b.id === firstId) - (a.id === firstId)) || (!!a.via - !!b.via) || (ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider)) || (b.current - a.current) || b.asOf - a.asOf)
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
function buildStatus(limits, all, now, acctId) {
  // Another subscription's samples are not this one's history: its percent is a different counter.
  const samples = all.filter(s => !s.acct || !acctId || s.acct === acctId)
  // Rolled like every account's windows are: a passed reset the server has not turned over yet reads as idle here
  // too, so the top level cannot say 95% while the same login's tab says 0%.
  const ws = windows(rolled(limits, now), samples, now)
  const live = ws.filter(w => Number.isFinite(w.projected))
  const worst = live.reduce((a, w) => (!a || w.projected > a.projected) ? w : a, null)
  const pace = worst ? Math.round(worst.projected) : null
  const level = pace == null ? 'unknown' : pace > 100 ? 'red' : pace > TARGET ? 'amber' : 'green'
  const fitted = fit(samples)
  const fitCache1 = fit(samples, { cacheReadPrior: 1 })
  return {
    t: now, acct: acctId || null, pace, level, worst: worst?.key || null, target: TARGET,
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
  // Every profile that answers is a live login. Pacer never refreshes a token (that is Claude Code's, and rotating
  // it from here could log a session out), so a profile that has not run for a while just keeps its last reading.
  const logins = []
  let lastError = 'no Claude Code login found'
  for (const profile of profiles()) {
    try {
      const cred = credential(profile)
      if (!cred) continue
      const limits = await fetchUsage(cred)
      logins.push({ profile, limits, acct: await identity(cred, profile), used: statSync(profile.config).mtimeMs })
    } catch (e) { lastError = e.message; console.error(`${profile.service}: ${e.message}`) }   // one dead profile must leave a trace
  }
  // Top-level status is a contract other tools read as "the default Claude login" (they run on it), so it is
  // pinned to the default profile; only when that one is unreadable does it fall to the login used last.
  // The same account reached through two profiles is one account.
  const seen = new Set()   // on a duplicate the default profile's entry is the one kept, then the fresher
  const usedLast = {}
  for (const l of logins) usedLast[l.acct.id] = Math.max(usedLast[l.acct.id] || 0, l.used)   // an account is as recent as its freshest profile
  for (const l of logins) l.used = usedLast[l.acct.id]
  const unique = logins.sort((a, b) => (!!a.profile.dir - !!b.profile.dir) || b.used - a.used).filter(l => !seen.has(l.acct.id) && seen.add(l.acct.id)).sort((a, b) => a.used - b.used)
  const recent = unique.at(-1)
  const head = unique.find(l => !l.profile.dir) || recent
  const accounts = loadAccounts()
  // One sample per live login, the pinned one last (it is what `status` rebuilds from). Transcripts are shared
  // between profiles, so tokens cannot be split by account: they ride on the pinned sample only.
  if (head) {
    const tokens = scanTokens(last, now)
    for (const l of [...unique.filter(x => x !== head), head]) {
      const sample = { t: now, acct: l.acct.id, limits: l.limits, tokens: l === head ? tokens : {} }
      appendFileSync(SAMPLES, JSON.stringify(sample) + '\n')
      samples.push(sample)
      rememberAccount(accounts, { ...l.acct, provider: 'claude', limits: l.limits }, now)
    }
  }
  const live = {}
  for (const l of unique) if (l !== head) live[l.acct.id] = samples.filter(x => x.acct === l.acct.id)
  for (const read of [n => codexReading(n, true), ...PROVIDERS]) {
    let r
    try { r = await read(now) } catch (e) { console.error(e.message); continue }
    for (const x of [].concat(r || [])) { rememberAccount(accounts, x.acct, now); accounts[x.acct.id].asOf = x.asOf; live[x.acct.id] = x.readings }
  }
  writeFileSync(ACCOUNTS, JSON.stringify(accounts, null, 2))
  if (!head) {
    // No Claude login answered (tokens expire while Claude Code is not running). The other providers were still
    // read; the Claude figures keep their own time `t`, so nothing downstream mistakes them for fresh.
    const status = existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, 'utf8')) : {}
    status.error = `usage unreadable: ${lastError}`; status.errorAt = now
    status.accounts = accountsView(accounts, null, [], now, live, status.accounts?.[0]?.id); status.accountsAt = now
    // With no Claude read there is no telling which Claude login is in use, so none of them is told to "switch back".
    for (const a of status.accounts) if (a.provider === 'claude') a.advice = 'last reading — this login could not be read just now'
    writeFileSync(STATUS, JSON.stringify(status, null, 2))
    console.error(status.error); process.exit(1)
  }
  const status = buildStatus(head.limits, samples, now, head.acct.id)
  status.accounts = accountsView(accounts, head.acct.id, samples.filter(s => !s.acct || s.acct === head.acct.id), now, live, recent.acct.id)
  status.accountsAt = now   // accounts are read even when the Claude figures above could not be, so they carry their own time
  writeFileSync(STATUS, JSON.stringify(status, null, 2))
  printStatus(status)
}
async function status() {
  const samples = loadSamples()
  const last = samples.at(-1)
  if (!last) { console.log('no samples yet — run `pacer tick`'); return }
  const s = buildStatus(last.limits, samples, last.t, last.acct)
  // No network here: Codex is read from its transcripts, every other provider from its remembered reading.
  const codex = await codexReading(last.t), accounts = loadAccounts(), live = codex ? { [codex.acct.id]: codex.readings } : {}
  // 30 min = the staleness line; Pacer.swift draws "last checked" past the same `staleAfterMs`.
  for (const a of Object.values(accounts)) if (a.provider !== 'codex' && a.id !== last.acct && last.t - a.asOf < 30 * 60000) live[a.id] = samples.filter(x => x.acct === a.id)
  s.accounts = accountsView(accounts, last.acct, samples.filter(x => !x.acct || x.acct === last.acct), last.t, live)
  writeFileSync(STATUS, JSON.stringify(s, null, 2))
  printStatus(s)
}
function printStatus(s) {
  console.log(`PACE ${s.pace} (${s.level.toUpperCase()}, worst: ${s.worst})  — ${new Date(s.t).toISOString()}`)
  console.log(`  ${s.advice || 'on pace — nothing to change'}`)
  console.log(`  API-equivalent cost: today $${s.cost.day.total} · this week $${s.cost.week.total} (${Object.entries(s.cost.week.byModel).map(([m, v]) => `${m} $${v}`).join(', ')})`)
  for (const w of s.windows) {
    if (w.idle) { console.log(`  ${w.key.padEnd(20)} ${String(w.percent).padStart(3)}% · idle`); continue }   // no reset yet: nothing to project
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
else if (cmd === 'status') await status()
else if (cmd === 'fit') { const s = loadSamples(); console.log(JSON.stringify({ prior: fit(s), cacheFull: fit(s, { cacheReadPrior: 1 }) }, null, 2)) }
else { console.log('usage: pacer tick|status|fit'); process.exit(1) }

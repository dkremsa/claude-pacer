#!/usr/bin/env node
// `node test.mjs` — runs `pacer status` (the no-network path) on fixtures in a scratch HOME.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const pacer = join(dirname(fileURLToPath(import.meta.url)), 'pacer.mjs')
function statusOf(limits) {
  const home = mkdtempSync(join(tmpdir(), 'pacer-test-'))
  const dir = join(home, '.claude', 'pacer')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'samples.jsonl'), JSON.stringify({ t: Date.now(), acct: 'a', limits, tokens: {} }) + '\n')
  const run = spawnSync(process.execPath, [pacer, 'status'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  return { run, status: JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) }
}

// A weekly window whose reset has passed but which the server has not turned over yet: it reads as idle at 0%,
// and printing it must not crash (an idle window has no allowedPerHour to format).
{
  const now = Date.now()
  const { run, status } = statusOf([
    { kind: 'session', scope: null, percent: 40, resetsAt: now + 3600000 },
    { kind: 'weekly_all', scope: null, percent: 95, resetsAt: now - 60000 },
  ])
  assert.equal(run.status, 0, 'pacer status exited non-zero:\n' + run.stderr)
  const week = status.windows.find(w => w.key === 'weekly_all')
  assert.equal(week.percent, 0)
  assert.equal(week.idle, true)
  assert.match(run.stdout, /weekly_all\s+0% · idle/)
  assert.ok(status.pace < 95, 'a passed reset must not set the pace')
}
// ── the retry policy ────────────────────────────────────────────────────────────────────────────────────
// Against a real local server, not a stubbed fetch: the thing worth testing is WHICH failures are retried,
// and a stub would only prove the stub. The waits are shortened in place — the policy under test is the
// classification, not the length of the backoff, and the real delays would make this a 20-second test.
{
  const { getWithRetry, RETRY_MS, ATTEMPT_MS, READ_BUDGET_MS, startReadBudget } = await import('./pacer.mjs')
  // Pinned before the waits are blanked below. Every attempt's timeout is clamped to what is left of this,
  // so it caps the WHOLE read phase however many providers there are — and it has to stay inside the 45 s
  // the card's click-to-poll waits for status.json to move. Without this, raising either number would pass
  // every other test in this file.
  assert.ok(RETRY_MS.reduce((a, b) => a + b, 0) <= READ_BUDGET_MS, 'the backoffs must fit one run budget')
  assert.ok(ATTEMPT_MS <= READ_BUDGET_MS, 'one attempt must not exceed the whole read budget')
  // The budget covers only reads that go through getWithRetry. The Antigravity probe runs AFTER it and
  // spends up to 4s per listening port, so the headroom under the 45s wait has to be stated with it in.
  assert.ok(READ_BUDGET_MS + 2 * 4000 <= 45000, `the read budget plus the antigravity probe must fit the 45s click-to-poll wait (is ${READ_BUDGET_MS + 8000}ms)`)
  RETRY_MS.length = 0
  RETRY_MS.push(5, 5)

  const serve = async (handler) => {
    const { createServer } = await import('node:http')
    const srv = createServer(handler)
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() }
  }

  // A blip is retried and the good answer is the one returned — the case that used to leave the figure
  // stale for a whole 10-minute tick.
  {
    let hits = 0
    const s = await serve((_, res) => { hits++; if (hits <= 2) { res.writeHead(429); res.end() } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') } })
    const res = await getWithRetry(s.url, {}, 'test')
    assert.equal(hits, 3, 'a 429 must be retried until it answers')
    assert.deepEqual(await res.json(), { ok: true })
    s.close()
  }

  // An auth failure is NOT retried: Pacer never refreshes a token, so the next 401 is the same 401.
  {
    let hits = 0
    const s = await serve((_, res) => { hits++; res.writeHead(401); res.end() })
    // Caught rather than awaited bare: treating 401 as retryable makes this THROW, and an unhandled
    // rejection would fail the run with a stack trace instead of the sentence naming what went wrong.
    let res = null, threw = null
    try { res = await getWithRetry(s.url, {}, 'test') } catch (e) { threw = e }
    assert.equal(hits, 1, `a 401 must not be retried (attempts: ${hits})`)
    assert.equal(threw, null, 'a non-retryable status is returned, not thrown: ' + (threw && threw.message))
    assert.equal(res.status, 401, 'the caller owns its own non-OK handling')
    s.close()
  }

  // A sustained outage gives up rather than hanging the tick, and says which read failed.
  {
    let hits = 0
    const s = await serve((_, res) => { hits++; res.writeHead(503); res.end() })
    await assert.rejects(() => getWithRetry(s.url, {}, 'cursor usage'), /cursor usage 503/)
    assert.equal(hits, 3, 'it must stop after the budget, not retry for ever')
    s.close()
  }
}

// ── no provider may quietly get no retry ────────────────────────────────────────────────────────────────
// The recurrence risk is not these five call sites, it is the SIXTH provider someone adds later with a bare
// fetch. Every remote read goes through getWithRetry; the two exceptions are local or have a file fallback,
// and each says so at the call site.
{
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pacer.mjs'), 'utf8')
  const bare = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\bfetch\(/.test(line))   // not just `await fetch(` — Promise.all and a wrapped line are the same mistake
    .filter(({ line }) => !/\.\.\.opts/.test(line))                                    // inside getWithRetry itself
    .filter(({ line }) => !/127\.0\.0\.1/.test(line))                                    // local language server
    .filter(({ line }) => !/PROFILE_URL/.test(line))                                      // display name, has a file fallback
  assert.deepEqual(bare.map(b => b.n), [], 'remote read(s) bypassing getWithRetry on line(s): ' + bare.map(b => b.n).join(', '))
}

// A spent budget stops the reads dead instead of letting each one start a fresh timeout — this is what caps
// the tick as a whole, and it is the thing that cannot be seen by testing one call in isolation.
{
  const { getWithRetry, startReadBudget, READ_BUDGET_MS } = await import('./pacer.mjs')
  const { createServer } = await import('node:http')
  let hits = 0
  const srv = createServer((_, res) => { hits++ })   // accepts, never answers
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}/`
  startReadBudget(Date.now() - READ_BUDGET_MS - 1000)   // a tick whose budget ran out a second ago
  const t0 = Date.now()
  await assert.rejects(() => getWithRetry(url, {}, 'late'), /read budget spent/)
  assert.ok(Date.now() - t0 < 500, 'a spent budget must fail fast, not open another 15s timeout')
  assert.equal(hits, 0, 'and it must not even reach the server')

  // ...and an attempt cannot OUTLIVE the budget either. This is the half that actually caps the tick — the
  // guard above only catches a budget already spent before the call, so without this the clamp could be
  // removed and every test here would still pass while eight hung reads went back to 47s, past the 45s wait.
  startReadBudget(Date.now() - READ_BUDGET_MS + 1500)   // a tick with 1.5s of its budget left
  const t1 = Date.now()
  await assert.rejects(() => getWithRetry(url, {}, 'tail'))
  assert.ok(Date.now() - t1 < 3000, `an attempt must be clamped to the rest of the budget (took ${Date.now() - t1}ms)`)
  srv.close()
}

// ── the reset-cycle id (Swift) ───────────────────────────────────────────────────────────────────────────
// The dup-notification bug lived in Swift, which has no test harness here — so the real `cycleId` is lifted
// out of Pacer.swift by name and compiled on its own. It checks the SOURCE, not a copy of the rule: edit the
// function and this follows; delete it and this fails to find it.
{
  const swiftSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Pacer.swift'), 'utf8')
  const fn = /^func cycleId\(.*$/m.exec(swiftSrc)
  assert.ok(fn, 'cycleId is gone from Pacer.swift — the cycle rule must stay extractable to stay checkable')

  const driver = `import Foundation
${fn[0]}
let readEvery = 600.0, window = 7 * 24 * 3600.0
var t = 1_700_000_000_000.0                 // ms
var left = window                           // seconds remaining in this cycle
let first = cycleId(t, left / 3600)
var worst = 0
while left > readEvery {                    // walk one whole cycle at the real 10-minute tick
  t += readEvery * 1000; left -= readEvery
  worst = max(worst, abs(cycleId(t, left / 3600) - first))
}
guard worst <= 600 else { print("DRIFT \\(worst)"); exit(1) }
// and a real turnover must move it by the whole window, far beyond that tolerance
let after = cycleId(t + readEvery * 1000, window / 3600)
guard after - first >= Int(window) - 600 else { print("NO JUMP"); exit(1) }
print("OK \\(worst)")`

  const dir = mkdtempSync(join(tmpdir(), 'pacer-swift-'))
  writeFileSync(join(dir, 'main.swift'), driver)
  const built = spawnSync('swiftc', ['-O', '-o', join(dir, 'c'), join(dir, 'main.swift')], { encoding: 'utf8' })
  assert.equal(built.status, 0, 'swiftc failed (Xcode CLT is a documented requirement):\n' + built.stderr)
  const ran = spawnSync(join(dir, 'c'), { encoding: 'utf8' })
  assert.equal(ran.status, 0, 'the cycle id is not stable within a cycle: ' + ran.stdout.trim())
  assert.match(ran.stdout, /^OK 0/, 'expected zero drift across a full cycle, got: ' + ran.stdout.trim())
}

console.log('ok')

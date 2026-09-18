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
console.log('ok')

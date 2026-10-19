import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../../src/engine/paths'
import { pruneSessions, SESSION_MAX_AGE_MS, sessionMaint } from '../../src/workflow/session-store'
import { withSandbox } from '../helpers/sandbox'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

function age(path: string, ms: number): void {
  const t = (NOW - ms) / 1000
  utimesSync(path, t, t)
}

function session(h: 'claude' | 'codex' | 'opencode' | 'omp', sid: string, ms: number): string {
  const dir = paths.sessionDir(h, sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), '{}\n')
  age(join(dir, 'state.json'), ms)
  age(dir, ms)
  return dir
}

function heartbeat(h: 'claude' | 'codex' | 'opencode' | 'omp', sid: string, body: Record<string, unknown>, ms?: number): string {
  const file = paths.heartbeatFile(h, sid)
  mkdirSync(paths.runDir(h), { recursive: true })
  writeFileSync(file, JSON.stringify(body) + '\n')
  if (ms !== undefined) age(file, ms)
  return file
}

describe('H16 session.maint', () => {
  test('pruneSessions removes idle session dirs and heartbeats; keeps recent, kept, linked and odd entries', () => withSandbox(({ root }) => {
    const old = session('omp', 'old-1', 20 * DAY)
    const recent = session('omp', 'recent-1', 2 * DAY)
    const kept = session('omp', 'kept-1', 30 * DAY)
    const alive = session('omp', 'alive-1', 30 * DAY)
    const aliveBeat = heartbeat('omp', 'alive-1', { at: NOW }, 1_000)
    const oldBeat = heartbeat('omp', 'old-1', { at: NOW - 20 * DAY }, 20 * DAY)
    const orphanBeat = heartbeat('omp', 'orphan-1', { at: 1 }, 40 * DAY)
    const other = session('codex', 'old-2', 20 * DAY)
    mkdirSync(join(paths.sessionsDir('omp'), 'not a session'), { recursive: true })
    const target = join(root, 'elsewhere')
    mkdirSync(target)
    symlinkSync(target, join(paths.sessionsDir('omp'), 'linked-1'))
    const removed = pruneSessions('omp', { keep: ['kept-1'], nowMs: NOW })
    expect(removed.sort()).toEqual([old, oldBeat, orphanBeat].sort())
    for (const p of [recent, kept, alive, aliveBeat, other, target, join(paths.sessionsDir('omp'), 'not a session')]) expect({ p, exists: existsSync(p) }).toEqual({ p, exists: true })
    expect(pruneSessions('omp', { nowMs: NOW })).toEqual([kept])
    expect(pruneSessions('omp', { nowMs: NOW, maxAgeMs: DAY })).toEqual([recent])
    expect(pruneSessions('claude', { nowMs: NOW })).toEqual([])
  }))

  test('sessionMaint also drops finalized spool files of its harness older than 14 days; active ones only when no session record owns them', () => withSandbox(() => {
    expect(SESSION_MAX_AGE_MS).toBe(14 * DAY)
    const spool = join(paths.memoryStateDir(), 'spool')
    const done = join(spool, 'done')
    const records = join(paths.memoryStateDir(), 'sessions')
    mkdirSync(done, { recursive: true })
    mkdirSync(records, { recursive: true })
    for (const sid of ['active', 'wt-a1b2']) writeFileSync(join(records, `codex-${sid}.json`), '{"v":1}\n')
    const files: Record<string, number> = {
      [join(done, 'codex-a.jsonl')]: 15 * DAY,
      [join(done, 'codex-b-turn1.jsonl')]: 3 * DAY,
      [join(done, 'claude-c.jsonl')]: 30 * DAY,
      [join(spool, 'codex-active.jsonl')]: 30 * DAY,
      [join(spool, 'codex-wt-a1b2-turn9.jsonl')]: 30 * DAY,
      [join(spool, 'codex-child-7.jsonl')]: 15 * DAY,
      [join(spool, 'codex-child-8-end.jsonl')]: 20 * DAY,
      [join(spool, 'codex-young-9.jsonl')]: 3 * DAY,
      [join(spool, 'codex-live-1.jsonl')]: 30 * DAY,
      [join(spool, 'claude-orphan.jsonl')]: 30 * DAY,
    }
    for (const [f, ms] of Object.entries(files)) { writeFileSync(f, '{}\n'); age(f, ms) }
    const dir = session('codex', 'idle-1', 15 * DAY)
    const live = session('codex', 'live-1', 15 * DAY)
    const r = sessionMaint('codex', NOW, { keep: ['live-1'] })
    expect(r.removed.sort()).toEqual([dir, join(done, 'codex-a.jsonl'), join(spool, 'codex-child-7.jsonl'), join(spool, 'codex-child-8-end.jsonl')].sort())
    expect(existsSync(live)).toBe(true)
    for (const f of [join(done, 'codex-b-turn1.jsonl'), join(done, 'claude-c.jsonl'), join(spool, 'codex-active.jsonl'), join(spool, 'codex-wt-a1b2-turn9.jsonl'), join(spool, 'codex-young-9.jsonl'), join(spool, 'codex-live-1.jsonl'), join(spool, 'claude-orphan.jsonl')]) {
      expect({ f, exists: existsSync(f) }).toEqual({ f, exists: true })
    }
    expect(sessionMaint('codex', NOW, { keep: ['live-1'] }).removed).toEqual([])
    expect(sessionMaint('opencode', NOW).removed).toEqual([])
  }))

  test('an active spool file that is a symlink or not a file is never touched', () => withSandbox(({ root }) => {
    const spool = join(paths.memoryStateDir(), 'spool')
    mkdirSync(spool, { recursive: true })
    const target = join(root, 'elsewhere.jsonl')
    writeFileSync(target, '{}\n')
    age(target, 30 * DAY)
    symlinkSync(target, join(spool, 'opencode-linked.jsonl'))
    mkdirSync(join(spool, 'opencode-dir.jsonl'))
    age(join(spool, 'opencode-dir.jsonl'), 30 * DAY)
    expect(sessionMaint('opencode', NOW).removed).toEqual([])
    expect(existsSync(target)).toBe(true)
    expect(existsSync(join(spool, 'opencode-dir.jsonl'))).toBe(true)
  }))
})

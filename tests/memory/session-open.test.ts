import { describe, expect, test } from 'bun:test'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sessionRecordFile, spoolDir } from '../../src/memory/layout'
import { anySessionOpen, openSessions, readSessionRecord, STALE_ACTIVE_MS, writeSessionRecord } from '../../src/memory/session-open'
import { promptSeen } from '../../src/memory/session-record'
import { withEnv, withSandbox } from '../helpers/sandbox'

const CLAUDE = '0199a213-81c0-7800-8aa1-bbab2a035a70'
const CODEX = '0199a213-81c0-7800-8aa1-bbab2a035a71'
const OPENCODE = 'ses_7f3a9c2e1b'
const HOUR = 3600_000

function backdate(file: string, ms: number): void {
  const t = new Date(Date.now() - ms)
  utimesSync(file, t, t)
}

describe('open sessions', () => {
  test('an active record with recent activity is open; a quiet one older than two hours, an ended one and a stranger are not', () => withSandbox(() => {
    const now = Date.now()
    expect(openSessions(now)).toEqual([])
    expect(anySessionOpen(now)).toBe(false)

    writeSessionRecord({ v: 1, harness: 'claude', sid: CLAUDE, cwd: '/w', startedMs: now - 5 * HOUR, status: 'active' })
    writeSessionRecord({ v: 1, harness: 'codex', sid: CODEX, cwd: '/w', startedMs: now - 3 * HOUR, status: 'active' })
    backdate(sessionRecordFile('codex', CODEX), 3 * HOUR)
    writeSessionRecord({ v: 1, harness: 'omp', sid: '0199a213-81c0-7800-8aa1-bbab2a035a72', cwd: '/w', startedMs: now - HOUR, status: 'ended', finalizedMs: now - 60_000 })
    writeFileSync(join(sessionRecordFile('claude', CLAUDE), '..', 'notes.json'), '{"v":1,"status":"active"}')

    expect(openSessions(now)).toEqual([{ h: 'claude', sid: CLAUDE }])
    expect(anySessionOpen(now)).toBe(true)
    expect(openSessions(now + STALE_ACTIVE_MS + 1000)).toEqual([])
    expect(openSessions(now + STALE_ACTIVE_MS - 1000, 1)).toEqual([{ h: 'claude', sid: CLAUDE }])
  }))

  test('a spool entry is activity: a long turn with no new prompt keeps the session open', () => withSandbox(() => {
    const now = Date.now()
    writeSessionRecord({ v: 1, harness: 'opencode', sid: OPENCODE, cwd: '/w', startedMs: now - 4 * HOUR, status: 'active' })
    backdate(sessionRecordFile('opencode', OPENCODE), 3 * HOUR)
    expect(openSessions(now)).toEqual([])
    mkdirSync(spoolDir(), { recursive: true })
    const segment = join(spoolDir(), `opencode-${OPENCODE}-2.jsonl`)
    writeFileSync(segment, JSON.stringify({ ts: now - 60_000, ev: 'tool', excerpt: 'bun test' }) + '\n')
    expect(openSessions(now)).toEqual([{ h: 'opencode', sid: OPENCODE }])
    backdate(segment, 3 * HOUR)
    expect(openSessions(now)).toEqual([])
  }))

  test('a prompt after the finalization makes the record active again and the session open', () => withSandbox(() => withEnv({ BURACLE_NO_CAPTURE: undefined, BURACLE_NO_AUTOSTART: '1' }, () => {
    const now = Date.now()
    writeSessionRecord({ v: 1, harness: 'opencode', sid: OPENCODE, cwd: '/w', startedMs: now - HOUR, status: 'ended', finalizedMs: now - 20 * 60_000, memoryId: 'session-opencode-9c2e1b' })
    backdate(sessionRecordFile('opencode', OPENCODE), 20 * 60_000)
    expect(openSessions(now)).toEqual([])
    promptSeen('opencode', OPENCODE, { nowMs: now })
    const rec = readSessionRecord('opencode', OPENCODE)
    expect(rec).toMatchObject({ status: 'active', finalizedMs: now - 20 * 60_000, memoryId: 'session-opencode-9c2e1b' })
    expect(openSessions(now)).toEqual([{ h: 'opencode', sid: OPENCODE }])
    promptSeen('claude', CLAUDE, { nowMs: now })
    expect(readSessionRecord('claude', CLAUDE)).toBeUndefined()
  })))
})

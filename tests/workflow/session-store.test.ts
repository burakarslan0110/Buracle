import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { withEnv, withSandbox } from '../helpers/sandbox'
import {
  freshState, loadState, readTelemetry, resolveSession, saveState, statePath,
  updateState, withFileLock, writeTelemetry,
} from '../../src/workflow/session-store'

describe('session state', () => {
  test('missing state is fresh; save/load round trip', async () => {
    await withSandbox(() => {
      expect(loadState('claude', 'abc-123')).toEqual(freshState())
      const s = { ...freshState(), plan: { path: '/r/docs/plans/x.md', slug: 'x', status: 'IN_PROGRESS' as const, type: 'Feature' as const, phase: 'implement' as const, registeredAt: 1 } }
      saveState('claude', 'abc-123', s)
      expect(loadState('claude', 'abc-123')).toEqual(s)
    })
  })

  test('unparsable or wrong-shape state falls back to fresh without throwing', async () => {
    await withSandbox(() => {
      const p = statePath('codex', 't1')
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, '{not json')
      expect(loadState('codex', 't1')).toEqual(freshState())
      writeFileSync(p, JSON.stringify({ v: 2 }))
      expect(loadState('codex', 't1')).toEqual(freshState())
    })
  })

  test('updateState serializes read-modify-write and clears the lock', async () => {
    await withSandbox(() => {
      for (let i = 0; i < 5; i++) {
        updateState('omp', 's', st => ({ ...st, guard: { ...st.guard, blocksInChain: st.guard.blocksInChain + 1 } }))
      }
      expect(loadState('omp', 's').guard.blocksInChain).toBe(5)
    })
  })

  test('updateState breaks an orphaned state.json lock (its process is gone) at once, and an old one by age', async () => {
    await withSandbox(() => {
      const lock = `${statePath('omp', 'orphan')}.lock`
      mkdirSync(dirname(lock), { recursive: true })
      writeFileSync(lock, JSON.stringify({ pid: Bun.spawnSync(['true']).pid, at: new Date().toISOString() }))
      const start = Date.now()
      const s = updateState('omp', 'orphan', st => ({ ...st, guard: { ...st.guard, blocksForPlan: 1 } }), { timeoutMs: 1_000 })
      expect(s.guard.blocksForPlan).toBe(1)
      expect(Date.now() - start).toBeLessThan(500)
      expect(existsSync(lock)).toBe(false)
      writeFileSync(lock, '')
      const old = (Date.now() - 60_000) / 1000
      utimesSync(lock, old, old)
      expect(updateState('omp', 'orphan', st => ({ ...st, guard: { ...st.guard, blocksForPlan: 2 } }), { timeoutMs: 1_000 }).guard.blocksForPlan).toBe(2)
      expect(existsSync(lock)).toBe(false)
    })
  })

  test('updateState waits for a live holder of the lock, then times out as before (nothing written)', async () => {
    await withSandbox(() => {
      saveState('omp', 'busy', freshState())
      const lock = `${statePath('omp', 'busy')}.lock`
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      const start = Date.now()
      expect(() => updateState('omp', 'busy', st => ({ ...st, guard: { ...st.guard, blocksForPlan: 9 } }), { timeoutMs: 120 })).toThrow(/lock busy: .*state\.json\.lock/)
      expect(Date.now() - start).toBeGreaterThanOrEqual(120)
      expect(loadState('omp', 'busy').guard.blocksForPlan).toBe(0)
      expect(existsSync(lock)).toBe(true)
      writeFileSync(lock, '')
      expect(() => updateState('omp', 'busy', st => st, { timeoutMs: 50 })).toThrow(/lock busy/)
    })
  })

  test('invalid session ids are rejected by path helpers', async () => {
    await withSandbox(() => {
      expect(() => statePath('claude', '../etc')).toThrow()
    })
  })
})

describe('withFileLock (shared by the alias map and the usage ledger)', () => {
  test('runs under <file>.lock and removes it; a live lock times out; an old or orphaned lock is broken', async () => {
    await withSandbox(({ root }) => {
      const file = join(root, 'data.json')
      const lock = `${file}.lock`
      expect(withFileLock(file, () => existsSync(lock))).toBe(true)
      expect(existsSync(lock)).toBe(false)
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 'x' }))
      expect(() => withFileLock(file, () => 1, 50)).toThrow(/lock busy/)
      const old = (Date.now() - 60_000) / 1000
      utimesSync(lock, old, old)
      expect(withFileLock(file, () => 2, 50)).toBe(2)
      writeFileSync(lock, JSON.stringify({ pid: Bun.spawnSync(['true']).pid, at: 'x' }))
      expect(withFileLock(file, () => 3, 50)).toBe(3)
      expect(existsSync(lock)).toBe(false)
    })
  })
})

describe('telemetry and heartbeat', () => {
  test('telemetry written by one of the memory\'s runner children is tagged runner', async () => {
    await withSandbox(async () => {
      await withEnv({ BURACLE_MEMORY_RUNNER: '1' }, () => { writeTelemetry('codex', 'r', { at: 1, modelId: 'gpt-6-luna' }) })
      expect(readTelemetry('codex', 'r')?.runner).toBe(true)
      writeTelemetry('codex', 'u', { at: 1, modelId: 'gpt-6-luna' })
      expect(readTelemetry('codex', 'u')?.runner).toBeUndefined()
    })
  })

  test('telemetry merges successive partial writes', async () => {
    await withSandbox(() => {
      writeTelemetry('claude', 'x', { at: 1, model: 'claude-opus-5-5' })
      writeTelemetry('claude', 'x', { at: 2, ctx: { pct: 37 } })
      const t = readTelemetry('claude', 'x')
      expect(t?.model).toBe('claude-opus-5-5')
      expect(t?.ctx?.pct).toBe(37)
      expect(t?.at).toBe(2)
    })
  })
})

describe('resolveSession', () => {
  const noProbe = { ancestor: (): never => { throw new Error('the process tree was consulted') } }

  test('flag wins, harness from flag or env', () => {
    expect(resolveSession({ session: 'abc', harness: 'codex' }, {}, noProbe)).toEqual({ harness: 'codex', sessionId: 'abc', source: '--session' })
    expect(resolveSession({ session: 'abc' }, { BURACLE_HARNESS: 'omp' }, noProbe)).toEqual({ harness: 'omp', sessionId: 'abc', source: '--session' })
  })

  test('env chain order and inference', () => {
    expect(resolveSession({}, { CLAUDE_CODE_SESSION_ID: 'c1' }, noProbe)).toEqual({ harness: 'claude', sessionId: 'c1', source: 'CLAUDE_CODE_SESSION_ID' })
    expect(resolveSession({}, { CODEX_THREAD_ID: 't9' }, noProbe)).toEqual({ harness: 'codex', sessionId: 't9', source: 'CODEX_THREAD_ID' })
    expect(resolveSession({}, { BURACLE_SESSION_ID: 'b1', BURACLE_HARNESS: 'opencode' }, noProbe)).toEqual({ harness: 'opencode', sessionId: 'b1', source: 'BURACLE_SESSION_ID' })
    expect(resolveSession({}, { BURACLE_SESSION_ID: 'b1', CLAUDE_CODE_SESSION_ID: 'c1' }, noProbe)).toEqual({ harness: 'claude', sessionId: 'b1', source: 'BURACLE_SESSION_ID' })
    expect(resolveSession({}, { BURACLE_SESSION_ID: 's', BURACLE_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: 's' }, noProbe)).toEqual({ harness: 'claude', sessionId: 's', source: 'BURACLE_SESSION_ID' })
  })

  test('no usable session', () => {
    expect(resolveSession({}, {}, noProbe)).toBeUndefined()
    expect(resolveSession({ session: '../x', harness: 'claude' }, {}, noProbe)).toBeUndefined()
    expect(resolveSession({}, { BURACLE_SESSION_ID: 'b1' }, noProbe)).toBeUndefined()
    expect(resolveSession({ harness: 'codex' }, { CLAUDE_CODE_SESSION_ID: 'c1' }, noProbe)).toBeUndefined()
  })
})

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../../src/core/events'
import { write } from '../../src/memory/api'
import { readJobs } from '../../src/memory/jobs'
import { kick, orphanSpools, staleSessions } from '../../src/memory/kick'
import { locksDir, sessionRecordFile, spoolDir } from '../../src/memory/layout'
import { promptSeen, spawnKick, writeSessionRecord } from '../../src/memory/session-record'
import { withEnv } from '../helpers/sandbox'
import { agentCtx, withBrain } from './helpers'

const CURRENT = '0199a213-81c0-7800-8aa1-bbab2a035a70'
const OMP_OPEN = '01a12c25-df20-72ee-ad02-726491804db3'
const ORPHAN = '7c0d6a52-1111-4222-8333-944455556666'
const QUIET = '0199a213-81c0-7800-8aa1-bbab2a035a71'
const HOUR = 3600_000

function backdate(file: string, ms: number): void {
  const t = new Date(Date.now() - ms)
  utimesSync(file, t, t)
}

function stubs() {
  const spawned: string[] = []
  const heals: Array<Record<string, unknown>> = []
  return {
    spawned, heals,
    deps: {
      spawnFinalizer: (h: Harness, sid: string) => { spawned.push(`${h}-${sid}`); return 4242 },
      startHeal: (o: Record<string, unknown>) => { heals.push(o); return false },
    },
  }
}

describe('kick', () => {
  test('sweeps what is due, hands stale and orphan sessions to finalizers once, removes dead locks, journals each step', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'gotcha', title: 'The flaky test needs a running server', summary: 'start it first' })
      await write(agentCtx(repo), { type: 'knowledge', layer: 'person', title: 'Bun runs TypeScript directly', review: 'ok' })
      writeSessionRecord({ v: 1, harness: 'omp', sid: OMP_OPEN, cwd: repo, startedMs: Date.now() - 3 * HOUR, status: 'active' })
      backdate(sessionRecordFile('omp', OMP_OPEN), 3 * HOUR)
      mkdirSync(spoolDir(), { recursive: true })
      const orphan = join(spoolDir(), `codex-${ORPHAN}-classic.jsonl`)
      writeFileSync(orphan, JSON.stringify({ ts: Date.now() - 3 * HOUR, ev: 'stop', excerpt: 'done' }) + '\n')
      backdate(orphan, 3 * HOUR)
      mkdirSync(locksDir(), { recursive: true })
      const dead = join(locksDir(), 'finalize-claude-17aa3952-a848-4123-b30a-8677ee104618.lock')
      writeFileSync(dead, JSON.stringify({ pid: 2_000_000_000, at: new Date(Date.now() - 2 * 86_400_000).toISOString(), token: 't' }))
      backdate(dead, 2 * 86_400_000)

      writeSessionRecord({ v: 1, harness: 'codex', sid: QUIET, cwd: repo, startedMs: Date.now() - 3 * HOUR, status: 'active' })
      backdate(sessionRecordFile('codex', QUIET), 3 * HOUR)
      expect(staleSessions('claude', CURRENT, Date.now()).map(s => `${s.h}-${s.sid}`).sort()).toEqual([`codex-${QUIET}`, `omp-${OMP_OPEN}`])
      await withEnv({ BURACLE_NO_AUTOSTART: '1' }, () => { promptSeen('codex', QUIET) })
      expect(staleSessions('claude', CURRENT, Date.now()).map(s => `${s.h}-${s.sid}`)).toEqual([`omp-${OMP_OPEN}`])
      expect(orphanSpools(Date.now())).toEqual([{ h: 'codex', sid: ORPHAN }])

      const s = stubs()
      const r = await kick({ cwd: repo, harness: 'claude', sid: CURRENT, deps: s.deps })
      expect(r.slug).toBe('demo')
      expect(r.store).toBe('ok')
      expect(r.swept.sort()).toEqual(['demo', 'person'])
      expect(s.spawned.sort()).toEqual([`codex-${ORPHAN}`, `omp-${OMP_OPEN}`])
      expect(r.staleFinalized).toEqual([`omp-${OMP_OPEN}`])
      expect(r.orphansFinalized).toEqual([`codex-${ORPHAN}`])
      expect(r.locksRemoved).toBe(1)
      expect(s.heals).toHaveLength(1)
      expect(s.heals[0]).toMatchObject({ slug: 'demo', harness: 'claude', sid: CURRENT })
      expect(s.heals[0]?.['storeProblem']).toBeUndefined()

      const jobs = readJobs()
      expect(jobs.filter(e => e.job === 'kick')).toHaveLength(1)
      expect(jobs.filter(e => e.job === 'sweep' && e.outcome === 'ran').map(e => e.layer).sort()).toEqual(['person', 'project'])
      expect(jobs.find(e => e.job === 'stale-finalize')?.detail).toContain(`omp-${OMP_OPEN}`)
      expect(jobs.find(e => e.job === 'orphan-spool')?.detail).toContain(`codex-${ORPHAN}`)
      expect(jobs.find(e => e.job === 'locks')?.detail).toBe('removed 1 lock or reader file(s) whose owner is gone')

      const again = stubs()
      const r2 = await kick({ cwd: repo, harness: 'claude', sid: CURRENT, deps: again.deps })
      expect(r2.swept).toEqual([])
      expect(again.spawned).toEqual([])
    })
  })

  test('a finalizer that could not be started is handed again at the next kick: the mark is written after the spawn', async () => {
    await withBrain(async ({ repo }) => {
      writeSessionRecord({ v: 1, harness: 'omp', sid: OMP_OPEN, cwd: repo, startedMs: Date.now() - 3 * HOUR, status: 'active' })
      backdate(sessionRecordFile('omp', OMP_OPEN), 3 * HOUR)
      const r1 = await kick({ cwd: repo, harness: 'claude', sid: CURRENT, deps: { spawnFinalizer: () => undefined, startHeal: () => false } })
      expect(r1.staleFinalized).toEqual([])
      expect(existsSync(join(locksDir(), `finalize-spawn-omp-${OMP_OPEN}.json`))).toBe(false)
      const s = stubs()
      const r2 = await kick({ cwd: repo, harness: 'claude', sid: CURRENT, deps: s.deps })
      expect(r2.staleFinalized).toEqual([`omp-${OMP_OPEN}`])
      expect(s.spawned).toEqual([`omp-${OMP_OPEN}`])
      expect(existsSync(join(locksDir(), `finalize-spawn-omp-${OMP_OPEN}.json`))).toBe(true)
    })
  })

  test('a missing store starts the repair with the problem named, and sweeps nothing', async () => {
    await withBrain(async ({ repo }) => {
      await withEnv({ BURACLE_CORTEXDB_BIN: join(repo, 'no-such-cortexdb') }, async () => {
        const s = stubs()
        const r = await kick({ cwd: repo, harness: 'codex', sid: CURRENT, deps: s.deps })
        expect(r.store).toBe('cortexdb_missing')
        expect(r.swept).toEqual([])
        expect(s.heals[0]).toMatchObject({ storeProblem: 'cortexdb_missing' })
        expect(readJobs().find(e => e.job === 'kick')).toMatchObject({ outcome: 'failed', reason: 'cortexdb_missing' })
      })
    })
  })

  test('a session start kicks once: a second start of the same session within 2 minutes does not kick again', async () => {
    await withBrain(async ({ repo }) => {
      await withEnv({ BURACLE_NO_AUTOSTART: undefined }, () => {
        const spawned: string[][] = []
        const spawn = (args: string[]) => { spawned.push(args); return 4242 }
        const now = Date.now()
        expect(spawnKick('opencode', 'ses_abc123', repo, { nowMs: now, spawn })).toBe(true)
        expect(spawnKick('opencode', 'ses_abc123', repo, { nowMs: now + 1000, spawn })).toBe(false)
        expect(spawnKick('opencode', 'ses_other1', repo, { nowMs: now + 1000, spawn })).toBe(true)
        expect(spawnKick('opencode', 'ses_abc123', repo, { nowMs: now + 3 * 60_000, spawn })).toBe(true)
        expect(spawned.map(a => a[5])).toEqual(['ses_abc123', 'ses_other1', 'ses_abc123'])
      })
      expect(spawnKick('codex', CURRENT, repo, { spawn: () => 1 })).toBe(false)
    })
  })
})

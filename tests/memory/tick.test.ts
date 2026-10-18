import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { write } from '../../src/memory/api'
import { enqueueDistill } from '../../src/memory/distill'
import { finalize } from '../../src/memory/finalize'
import { readJobs } from '../../src/memory/jobs'
import { distillQueueDir, locksDir, sessionRecordFile } from '../../src/memory/layout'
import { tryLock } from '../../src/memory/lock'
import { compactSeen, promptSeen, recentProjectSlugs, sessionStart, writeSessionRecord } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { tick, tickLockFile } from '../../src/memory/tick'
import { armTickTimer, markTickAgain, maybeStartTick, readTickTimer, takeTickAgain, TICK_DEBOUNCE_MS, TICK_TIMER_MAX_MS, tickAgainFile, tickDue, tickMarkFile, tickTimerFile, timerDelayMs } from '../../src/memory/tick-start'
import { writeTelemetry } from '../../src/workflow/session-store'
import { withEnv } from '../helpers/sandbox'
import { agentCtx, withBrain } from './helpers'

const SID = '0199a213-81c0-7800-8aa1-bbab2a035a80'
const OLD = '0199a213-81c0-7800-8aa1-bbab2a035a81'
const HOUR = 3600_000

describe('waking the tick', () => {
  test('every wake starts a tick, at most once a minute per machine, with its trigger; never under BURACLE_NO_AUTOSTART or with capture off', async () => {
    await withBrain(async () => {
      const spawned: string[][] = []
      const spawn = (args: string[]) => { spawned.push(args); return 4242 }
      const now = Date.now()
      expect(maybeStartTick({ harness: 'claude', sid: SID, nowMs: now, spawn })).toBe(false)
      await withEnv({ BURACLE_NO_AUTOSTART: undefined }, () => {
        expect(tickDue(now)).toBe(true)
        expect(maybeStartTick({ harness: 'claude', sid: SID, trigger: 'prompt', nowMs: now, spawn })).toBe(true)
        expect(spawned).toEqual([['mem', 'tick', '--quiet', '--trigger', 'prompt', '--harness', 'claude', '--session', SID]])
        expect(existsSync(tickMarkFile())).toBe(true)
        expect(maybeStartTick({ harness: 'codex', sid: OLD, trigger: 'session-end', nowMs: now + 10_000, spawn })).toBe(false)
        expect(tickDue(now + TICK_DEBOUNCE_MS - 1)).toBe(false)
        const t = new Date(now - TICK_DEBOUNCE_MS - 1000)
        utimesSync(tickMarkFile(), t, t)
        expect(maybeStartTick({ harness: 'codex', sid: OLD, trigger: 'compact', nowMs: now, spawn })).toBe(true)
        expect(spawned[1]).toEqual(['mem', 'tick', '--quiet', '--trigger', 'compact', '--harness', 'codex', '--session', OLD])
        mkdirSync(locksDir(), { recursive: true })
        const release = tryLock(tickLockFile(), 60_000)
        expect(release).toBeDefined()
        try {
          utimesSync(tickMarkFile(), t, t)
          expect(maybeStartTick({ harness: 'omp', sid: SID, trigger: 'prompt', nowMs: now, spawn })).toBe(false)
          expect(existsSync(tickAgainFile())).toBe(true)
          expect(spawned).toHaveLength(2)
        } finally { release?.() }
        expect(takeTickAgain()).toBe(true)
        expect(takeTickAgain()).toBe(false)
        markTickAgain(now)
        expect(maybeStartTick({ harness: 'claude', sid: SID, trigger: 'prompt', nowMs: now + 5_000, spawn })).toBe(true)
        expect(spawned).toHaveLength(3)
        expect(existsSync(tickAgainFile())).toBe(false)
        expect(maybeStartTick({ harness: 'claude', sid: SID, trigger: 'prompt', nowMs: now + 6_000, spawn })).toBe(false)
      })
      await withEnv({ BURACLE_NO_AUTOSTART: undefined, BURACLE_NO_CAPTURE: '1' }, () => {
        const t = new Date(now - TICK_DEBOUNCE_MS - 1000)
        utimesSync(tickMarkFile(), t, t)
        expect(maybeStartTick({ harness: 'claude', sid: SID, nowMs: now, spawn })).toBe(false)
      })
    })
  })

  test('every adapter reports a prompt or a compaction through promptSeen and compactSeen; the spool itself stays light and wakes nothing', async () => {
    await withBrain(async () => {
      appendSpool('claude', SID, [{ ts: Date.now(), ev: 'prompt' }])
      expect(existsSync(tickMarkFile())).toBe(false)
      expect(promptSeen('claude', SID)).toBe(false)
      expect(compactSeen('claude', SID)).toBe(false)
      expect(promptSeen('claude', 'not-a-session')).toBe(false)
      expect(compactSeen('claude', 'not-a-session')).toBe(false)
      expect(existsSync(tickMarkFile())).toBe(false)
    })
  })
})

describe('the window-reset timer', () => {
  test('one timer per machine: armed with the first reset, kept when a later due comes, replaced by an earlier one; never under BURACLE_NO_AUTOSTART; the sleep is capped at 6 hours', async () => {
    await withBrain(async () => {
      const spawned: string[][] = []
      const spawn = (args: string[]) => { spawned.push(args); return 4242 }
      const now = Date.now()
      const due = now + 45 * 60_000
      expect(armTickTimer({ dueMs: due, nowMs: now, spawn })).toBe(false)
      await withEnv({ BURACLE_NO_AUTOSTART: undefined }, () => {
        expect(armTickTimer({ dueMs: due, nowMs: now, spawn })).toBe(true)
        expect(spawned).toEqual([['mem', 'tick', '--quiet', '--trigger', 'window-reset', '--at', new Date(due).toISOString()]])
        expect(readTickTimer()).toMatchObject({ v: 1, due: new Date(due).toISOString() })
        expect(armTickTimer({ dueMs: due + 3600_000, nowMs: now + 1000, spawn })).toBe(false)
        expect(armTickTimer({ dueMs: due - 600_000, nowMs: now + 2000, spawn })).toBe(true)
        expect(readTickTimer()?.due).toBe(new Date(due - 600_000).toISOString())
        expect(spawned).toHaveLength(2)
        writeFileSync(tickTimerFile(), '')
        expect(armTickTimer({ dueMs: due, nowMs: now + 3000, spawn: () => undefined })).toBe(false)
        expect(existsSync(tickTimerFile())).toBe(false)
      })
      expect(timerDelayMs(now, now - 1000)).toBe(0)
      expect(timerDelayMs(now, now + 1000)).toBe(1000)
      expect(timerDelayMs(now, now + 9 * 3600_000)).toBe(TICK_TIMER_MAX_MS)
    })
  })

  test('the sleeper runs the tick when its time came and takes its timer file away; one whose file another timer took steps aside', async () => {
    await withBrain(async ({ repo }) => {
      const past = new Date(Date.now() - 1000).toISOString()
      const r = await tick({ cwd: repo, trigger: 'window-reset', at: past })
      expect(r.skipped).toBeUndefined()
      expect(existsSync(tickTimerFile())).toBe(false)
      expect(readJobs().find(e => e.job === 'tick')).toMatchObject({ trigger: 'window-reset', outcome: 'ran' })
      const future = new Date(Date.now() + 20 * 60_000).toISOString()
      const taken = await tick({ cwd: repo, trigger: 'window-reset', at: future, sleep: async () => { writeFileSync(tickTimerFile(), JSON.stringify({ v: 1, due: future, armedAt: future, pid: 999_999 }) + '\n') } })
      expect(taken.skipped).toBe('replaced')
      expect(readJobs().filter(e => e.job === 'tick')).toHaveLength(1)
    })
  })

  test('a tick whose work waited for a usage window arms the timer a minute after the first reset, and says so in the journal', async () => {
    await withBrain(async ({ repo }) => {
      const now = Date.now()
      const resetsAt = new Date(now + 30 * 60_000).toISOString()
      await sessionStart('claude', SID, repo)
      appendSpool('claude', SID, [{ ts: now, ev: 'prompt' }, { ts: now + 1, ev: 'stop', excerpt: 'The session did work.' }])
      await finalize('claude', SID)
      enqueueDistill('claude', SID)
      writeTelemetry('claude', SID, { at: now, modelId: 'claude-opus-5-5', windows: [{ label: '5h', pct: 90, resetsAt }] })
      const armed: number[] = []
      await withEnv({ BURACLE_NO_DISTILL: undefined }, async () => {
        const r = await tick({ harness: 'claude', sid: SID, cwd: repo, nowMs: now, trigger: 'prompt', armTimer: (due) => { armed.push(due); return true } })
        expect(r.skipped).toBeUndefined()
        expect(r.rateLimited).toBe(true)
        expect(armed).toEqual([Date.parse(resetsAt) + 60_000])
        expect(r.timerAt).toBe(new Date(Date.parse(resetsAt) + 60_000).toISOString())
      })
      const line = readJobs().find(e => e.job === 'tick' && e.reason === 'rate-limit')
      expect(line?.detail).toContain(`a timer wakes the tick at ${new Date(Date.parse(resetsAt) + 60_000).toISOString()}`)
    })
  })
})

describe('the tick', () => {
  test('serves the waking session\'s project and the projects active in the last day, sweeps when due, journals once; a second tick is busy', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'gotcha', title: 'The flaky test needs a running server', summary: 'start it first' })
      await write(agentCtx(repo), { type: 'knowledge', layer: 'person', title: 'Bun runs TypeScript directly', review: 'ok' })
      writeSessionRecord({ v: 1, harness: 'claude', sid: SID, cwd: repo, slug: 'demo', startedMs: Date.now() - HOUR, status: 'active' })
      writeSessionRecord({ v: 1, harness: 'omp', sid: OLD, cwd: '/gone', slug: 'other', startedMs: Date.now() - 3 * 86_400_000, status: 'ended', finalizedMs: Date.now() - 3 * 86_400_000 })
      expect(recentProjectSlugs(Date.now() - 86_400_000)).toEqual(['demo'])
      markTickAgain(Date.now())
      const r = await tick({ harness: 'claude', sid: SID, cwd: repo, trigger: 'prompt' })
      expect(r.skipped).toBeUndefined()
      expect(r.projects).toEqual(['demo'])
      expect(r.swept.sort()).toEqual(['demo', 'person'])
      expect(r.distilled).toBe(0)
      expect(r.rounds).toBe(1)
      expect(existsSync(tickAgainFile())).toBe(false)
      const jobs = readJobs()
      const line = jobs.find(e => e.job === 'tick')
      expect(line).toMatchObject({ job: 'tick', trigger: 'prompt', outcome: 'ran', harness: 'claude', sid: SID, project: 'demo' })
      expect(line?.detail).toContain('1 project(s) (demo)')
      expect(line?.detail).toContain('swept demo, person')
      expect(jobs.filter(e => e.job === 'sweep' && e.outcome === 'ran' && e.trigger === 'tick').map(e => e.layer).sort()).toEqual(['person', 'project'])
      expect(jobs.some(e => e.job === 'reflect' && e.trigger === 'tick')).toBe(true)
      mkdirSync(locksDir(), { recursive: true })
      const release = tryLock(tickLockFile(), 60_000)
      expect(release).toBeDefined()
      try {
        expect((await tick({ cwd: repo })).skipped).toBe('busy')
      } finally { release?.() }
      expect(readJobs().filter(e => e.job === 'tick')).toHaveLength(1)
      expect(existsSync(sessionRecordFile('claude', SID))).toBe(true)
      writeFileSync(join(locksDir(), 'tick.mark'), '')
    })
  })

  test('leaves a project memory.exclude keeps out alone, even when its sessions were recorded before the exclusion', async () => {
    await withBrain(async ({ repo, buracleHome }) => {
      await write(agentCtx(repo), { type: 'gotcha', title: 'The client build needs a VPN', summary: 'connect first' })
      writeSessionRecord({ v: 1, harness: 'claude', sid: SID, cwd: repo, slug: 'demo', startedMs: Date.now() - HOUR, status: 'ended', finalizedMs: Date.now() - HOUR })
      enqueueDistill('claude', SID)
      mkdirSync(buracleHome, { recursive: true })
      writeFileSync(join(buracleHome, 'config.yaml'), 'memory:\n  exclude:\n    - me/demo\n')
      expect(recentProjectSlugs(Date.now() - 86_400_000)).toEqual(['demo'])
      const r = await tick({ harness: 'claude', sid: SID, trigger: 'prompt' })
      expect(r.skipped).toBeUndefined()
      expect(r.projects).toEqual([])
      expect(r.reflected).not.toContain('demo')
      expect(r.swept).not.toContain('demo')
      const jobs = readJobs()
      expect(jobs.filter(e => (e.job === 'reflect' || e.job === 'sweep') && e.layer === 'project')).toEqual([])
      expect(jobs.find(e => e.job === 'distill')).toMatchObject({ outcome: 'skipped', reason: 'excluded', sid: SID, detail: 'project demo is excluded by memory.exclude (me/demo)' })
      expect(existsSync(join(distillQueueDir(), `claude-${SID}`))).toBe(false)
    })
  })
})

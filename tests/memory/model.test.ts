import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { distillQueueState, enqueueDistill } from '../../src/memory/distill'
import { runnerBackoffFile } from '../../src/memory/layout'
import { chooseHarnesses, choiceHoldsRunner, choiceRunner, choiceSkip, choiceUntil, choiceWhy, latestModel, rateLimitBlock } from '../../src/memory/model'
import { markRunnerFailed, RUNNER_FAILED_BACKOFF_MS, RUNNER_REFUSED_BACKOFF_MS, runnerUnavailable, type ModelRunner } from '../../src/memory/runner'
import { MEMORY_RUNNER_DIR_PREFIX } from '../../src/memory/spawn'
import { writeUsageEntries } from '../../src/usage/cache'
import { monthKeyOf } from '../../src/usage/month'
import { writeTelemetry } from '../../src/workflow/session-store'
import { withEnv, withSandbox } from '../helpers/sandbox'

const SID = '0199a213-81c0-7800-8aa1-bbab2a035b10'
const SID2 = '0199a213-81c0-7800-8aa1-bbab2a035b11'
const SID3 = '0199a213-81c0-7800-8aa1-bbab2a035b12'
const onPath = () => '/usr/bin/x'

describe('the choice', () => {
  test('the preferred harness first with its model, then the harnesses used this week with the most room first; held ones with their reason', async () => {
    await withSandbox(async () => {
      const now = Date.now()
      writeTelemetry('codex', SID, { at: now - 60_000, modelId: 'gpt-6-luna', windows: [{ label: '5h', pct: 40 }, { label: '7d', pct: 60 }] })
      writeTelemetry('claude', SID2, { at: now - 120_000, modelId: 'claude-opus-5-5', windows: [{ label: '5h', pct: 10 }, { label: '7d', pct: 20 }] })
      writeTelemetry('omp', SID3, { at: now - 9 * 86_400_000, modelId: 'openai-codex/gpt-6-luna' })
      const free = chooseHarnesses({ nowMs: now, which: onPath })
      expect(free.picks).toEqual([{ harness: 'claude', model: 'claude-opus-5-5', used: 20 }, { harness: 'codex', model: 'gpt-6-luna', used: 60 }])
      expect(free.held).toEqual([])
      const own = chooseHarnesses({ prefer: 'codex', model: 'gpt-6-sol', nowMs: now, which: onPath })
      expect(own.picks.map(p => `${p.harness}:${p.model ?? 'default'}`)).toEqual(['codex:gpt-6-sol', 'claude:claude-opus-5-5'])
      expect(chooseHarnesses({ prefer: 'opencode', nowMs: now, which: onPath }).picks[0]).toEqual({ harness: 'opencode' })
      expect(latestModel('codex')).toBe('gpt-6-luna')
      expect(latestModel('opencode')).toBeUndefined()
      const weekReset = new Date(now + 4 * 3_600_000).toISOString()
      writeTelemetry('codex', SID, { at: now, modelId: 'gpt-6-luna', windows: [{ label: '7d', pct: 90, resetsAt: weekReset }] })
      const held = chooseHarnesses({ prefer: 'codex', nowMs: now, which: onPath })
      expect(held.picks.map(p => p.harness)).toEqual(['claude'])
      expect(held.held).toEqual([{ harness: 'codex', why: 'codex: 7-day window at 90% (limit 85%)', kind: 'window', window: '7d', pct: 90, until: weekReset }])
      expect(choiceUntil(held)).toBe(weekReset)
      writeTelemetry('claude', SID2, { at: now, modelId: 'claude-opus-5-5', windows: [{ label: '5h', pct: 80 }] })
      const all = chooseHarnesses({ prefer: 'codex', nowMs: now, which: onPath })
      expect(all.picks).toEqual([])
      expect(choiceSkip(all)).toBe('rate-limit')
      expect(choiceHoldsRunner(all)).toBe(true)
      expect(choiceWhy(all)).toBe('codex: 7-day window at 90% (limit 85%); claude: 5-hour window at 80% (limit 75%)')
    })
  })

  test('the memory\'s own runner children make no harness a candidate and set no model: telemetry tagged runner, or written from a runner folder, is left out; its windows still count', async () => {
    await withSandbox(async () => {
      const now = Date.now()
      writeTelemetry('opencode', SID, { at: now - 60_000, modelId: 'opencode/big-pickle', cwd: `/tmp/${MEMORY_RUNNER_DIR_PREFIX}abc123` })
      writeTelemetry('codex', SID2, { at: now - 86_400_000, modelId: 'gpt-6-sol', cwd: '/srv/app' })
      const fiveReset = new Date(now + 4 * 3_600_000).toISOString()
      await withEnv({ BURACLE_MEMORY_RUNNER: '1' }, () => { writeTelemetry('codex', SID3, { at: now - 60_000, modelId: 'gpt-6-luna', windows: [{ label: '5h', pct: 90, resetsAt: fiveReset }] }) })
      expect(latestModel('opencode')).toBeUndefined()
      expect(latestModel('codex')).toBe('gpt-6-sol')
      const c = chooseHarnesses({ nowMs: now, which: onPath })
      expect(c.picks).toEqual([])
      expect(c.held).toEqual([{ harness: 'codex', why: 'codex: 5-hour window at 90% (limit 75%)', kind: 'window', window: '5h', pct: 90, until: fiveReset }])
      expect(chooseHarnesses({ prefer: 'opencode', nowMs: now, which: onPath }).picks).toEqual([{ harness: 'opencode' }])
    })
  })

  test('every window counts: a day, a month or a year at the 7-day share holds a harness like the week; a window of unknown length holds nothing', async () => {
    await withSandbox(async () => {
      const now = Date.now()
      const dayReset = new Date(now + 6 * 3_600_000).toISOString()
      writeTelemetry('codex', SID, { at: now - 60_000, modelId: 'gpt-6-luna', windows: [{ label: '5h', pct: 10 }, { label: '1d', pct: 86, resetsAt: dayReset }] })
      writeTelemetry('omp', SID2, { at: now - 60_000, modelId: 'openai-codex/gpt-6-luna', windows: [{ label: '30d', pct: 90, windowMinutes: 43_200 }] })
      writeTelemetry('claude', SID3, { at: now - 60_000, modelId: 'claude-opus-5-5', windows: [{ label: 'credits', pct: 100 }, { label: '7d', pct: 20 }] })
      const c = chooseHarnesses({ nowMs: now, which: onPath })
      expect(c.picks).toEqual([{ harness: 'claude', model: 'claude-opus-5-5', used: 100 }])
      expect(c.held).toEqual([
        { harness: 'codex', why: 'codex: 1-day window at 86% (limit 85%)', kind: 'window', window: '1d', pct: 86, until: dayReset },
        { harness: 'omp', why: 'omp: 30-day window at 90% (limit 85%)', kind: 'window', window: '30d', pct: 90 },
      ])
      expect(rateLimitBlock([{ label: 'five', pct: 76, windowMinutes: 300 }])).toBe('five window at 76% (limit 75%)')
      expect(rateLimitBlock([{ label: '1d', pct: 84 }])).toBeUndefined()
    })
  })

  test('the usage cache is a source of windows too: omp, which reports its windows there only, is held by them; the newer report wins', async () => {
    await withSandbox(async () => {
      const now = Date.now()
      const entry = (h: 'omp' | 'codex', atMs: number, windows: Array<{ label: string, pct: number }>) => ({ harness: h, computed_at: new Date(atMs).toISOString(), windows, month: { start: '', tokens: 0, byModel: {} }, month_key: monthKeyOf(now) })
      writeTelemetry('omp', SID, { at: now - 60_000, modelId: 'openai-codex/gpt-6-luna' })
      writeTelemetry('codex', SID2, { at: now - 60_000, modelId: 'gpt-6-luna', windows: [{ label: '5h', pct: 20 }] })
      writeUsageEntries([entry('omp', now - 30_000, [{ label: '5h', pct: 90 }]), entry('codex', now - 120_000, [{ label: '5h', pct: 99 }])], now)
      const c = chooseHarnesses({ nowMs: now, which: onPath })
      expect(c.picks).toEqual([{ harness: 'codex', model: 'gpt-6-luna', used: 20 }])
      expect(c.held).toEqual([{ harness: 'omp', why: 'omp: 5-hour window at 90% (limit 75%)', kind: 'window', window: '5h', pct: 90 }])
      writeUsageEntries([{ ...entry('omp', now - 10_000, [{ label: '5h', pct: 90 }]), month_key: '2000-01' }], now)
      expect(chooseHarnesses({ nowMs: now, which: onPath }).held).toEqual([])
    })
  })

  test('a CLI that is not on PATH holds its harness (runner-unavailable); without a candidate at all the skip is no-harness', async () => {
    await withSandbox(async () => {
      const now = Date.now()
      expect(chooseHarnesses({ nowMs: now })).toEqual({ picks: [], held: [] })
      expect(choiceSkip({ picks: [], held: [] })).toBe('no-harness')
      expect(choiceWhy({ picks: [], held: [] })).toContain('no harness ran a session')
      const c = chooseHarnesses({ prefer: 'codex', nowMs: now, which: () => null })
      expect(c.picks).toEqual([])
      expect(c.held).toEqual([{ harness: 'codex', why: 'codex: codex is not on PATH', kind: 'cli' }])
      expect(choiceSkip(c)).toBe('runner-unavailable')
      expect(choiceHoldsRunner(c)).toBe(false)
      expect(runnerUnavailable('codex', now + 3600_000, { which: onPath })).toContain('not on PATH')
      expect(chooseHarnesses({ prefer: 'codex', nowMs: now, checkCli: false }).picks).toEqual([{ harness: 'codex' }])
    })
  })
})

describe('the runner over a choice', () => {
  const answer = (text: string): ModelRunner => async () => ({ ok: true, text })
  const failing = (error: string, unavailable = false): ModelRunner => async () => ({ ok: false, text: '', error, ...(unavailable ? { unavailable: true } : {}) })

  test('the first harness that answers wins, with its own model; a failed CLI moves the call on and waits a while', async () => {
    await withSandbox(async () => {
      const now = Date.now()
      const calls: string[] = []
      const runners: Record<string, ModelRunner> = {
        codex: async (_p, o) => { calls.push(`codex:${o.model ?? '-'}`); return { ok: false, text: '', error: 'codex: not logged in' } },
        claude: async (_p, o) => { calls.push(`claude:${o.model ?? '-'}`); return { ok: true, text: 'OK' } },
      }
      const choice = { picks: [{ harness: 'codex' as const, model: 'gpt-6-luna' }, { harness: 'claude' as const, model: 'claude-opus-5-5' }], held: [] }
      const moved: string[] = []
      const run = choiceRunner(choice, { harnessRunner: h => runners[h] as ModelRunner, nowMs: () => now, onNext: (from, error, to) => moved.push(`${from.harness}->${to?.harness ?? 'none'}: ${error}`) })
      expect(await run('p', { model: 'ignored', maxOutputTokens: 10, timeoutMs: 1000 })).toEqual({ ok: true, text: 'OK' })
      expect(calls).toEqual(['codex:gpt-6-luna', 'claude:claude-opus-5-5'])
      expect(run.current).toEqual({ harness: 'claude', model: 'claude-opus-5-5' })
      expect(moved).toEqual(['codex->claude: codex: not logged in'])
      expect(runnerUnavailable('codex', now + 60_000, { which: onPath })).toBe('codex: not logged in')
      expect(runnerUnavailable('codex', now + RUNNER_FAILED_BACKOFF_MS + 1, { which: onPath })).toBeUndefined()
      const refused = choiceRunner({ picks: [{ harness: 'omp', model: 'x' }], held: [] }, { harnessRunner: () => failing('omp: unknown model x'), nowMs: () => now })
      expect((await refused('p', { maxOutputTokens: 10, timeoutMs: 1000 })).ok).toBe(false)
      expect(runnerUnavailable('omp', now + RUNNER_FAILED_BACKOFF_MS + 1, { which: onPath })).toBe('omp: unknown model x')
      expect(runnerUnavailable('omp', now + RUNNER_FAILED_BACKOFF_MS + 1, { which: onPath, model: 'x' })).toBe('omp: unknown model x')
      expect(runnerUnavailable('omp', now + RUNNER_FAILED_BACKOFF_MS + 1, { which: onPath, model: 'y' })).toBeUndefined()
      expect(runnerUnavailable('omp', now + RUNNER_REFUSED_BACKOFF_MS + 1, { which: onPath, model: 'x' })).toBeUndefined()
      writeTelemetry('omp', SID3, { at: now, modelId: 'x' })
      expect(chooseHarnesses({ nowMs: now + 3600_000, which: onPath }).held).toEqual([{ harness: 'omp', why: 'omp: omp: unknown model x', kind: 'cli' }])
      writeTelemetry('omp', SID3, { at: now + 1, modelId: 'y' })
      expect(chooseHarnesses({ nowMs: now + 3600_000, which: onPath }).picks).toEqual([{ harness: 'omp', model: 'y' }])
    })
  })

  test('the back-off file is written under a lock: a stale lock left by a dead process never blocks a mark, and marks for two harnesses both survive', async () => {
    await withSandbox(async () => {
      const now = Date.now()
      const lock = `${runnerBackoffFile()}.lock`
      mkdirSync(join(lock, '..'), { recursive: true })
      writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000, at: new Date(now - 60_000).toISOString(), token: 't' }))
      const old = new Date(now - 60_000)
      utimesSync(lock, old, old)
      markRunnerFailed('codex', now, 'codex: not logged in')
      markRunnerFailed('omp', now, 'omp: unknown model x', true, 'x')
      expect(runnerUnavailable('codex', now + 60_000, { which: onPath })).toBe('codex: not logged in')
      expect(runnerUnavailable('omp', now + 60_000, { which: onPath, model: 'x' })).toBe('omp: unknown model x')
      expect(existsSync(lock)).toBe(false)
    })
  })

  test('every pick failing joins the errors; only missing CLIs make the answer unavailable; no pick answers at once', async () => {
    await withSandbox(async () => {
      const both = choiceRunner({ picks: [{ harness: 'codex' }, { harness: 'claude' }], held: [] }, { harnessRunner: h => failing(`${h}: down`), nowMs: Date.now })
      expect(await both('p', { maxOutputTokens: 10, timeoutMs: 1000 })).toEqual({ ok: false, text: '', error: 'codex: down; claude: down' })
      const missing = choiceRunner({ picks: [{ harness: 'codex' }], held: [] }, { harnessRunner: () => failing('codex: codex is not on PATH', true), nowMs: Date.now })
      expect(await missing('p', { maxOutputTokens: 10, timeoutMs: 1000 })).toMatchObject({ ok: false, unavailable: true })
      const none = choiceRunner({ picks: [], held: [] }, { harnessRunner: () => answer('never') })
      expect(await none('p', { maxOutputTokens: 10, timeoutMs: 1000 })).toEqual({ ok: false, text: '', error: 'no harness can run the memory\'s model now' })
    })
  })
})

describe('the distill queue and the choice', () => {
  test('the queue names the harness that runs next, or that all its entries wait for a harness with room', async () => {
    await withSandbox(async ({ root }) => {
      const now = Date.now()
      enqueueDistill('codex', SID)
      enqueueDistill('claude', SID2)
      expect(distillQueueState({ nowMs: now })).toMatchObject({ pending: 2, byHarness: { codex: 1, claude: 1 }, held: 0, why: expect.stringContaining('no harness ran a session') })
      writeTelemetry('claude', SID2, { at: now, modelId: 'claude-opus-5-5', windows: [{ label: '5h', pct: 5 }] })
      expect(distillQueueState({ nowMs: now, choice: chooseHarnesses({ nowMs: now, which: onPath }) })).toMatchObject({ pending: 2, held: 0, next: { harness: 'claude', model: 'claude-opus-5-5' } })
      const empty = join(root, 'empty-bin')
      mkdirSync(empty, { recursive: true })
      await withEnv({ PATH: empty }, () => {
        expect(distillQueueState({ nowMs: now })).toMatchObject({ held: 0, why: 'claude: claude is not on PATH' })
      })
      const windowed = chooseHarnesses({ nowMs: now, which: onPath })
      windowed.picks = []
      windowed.held = [{ harness: 'claude', why: 'claude: 7-day window at 90% (limit 85%)', kind: 'window', window: '7d', pct: 90, until: '2026-10-17T16:00:00.000Z' }]
      expect(distillQueueState({ nowMs: now, choice: windowed })).toMatchObject({ pending: 2, held: 2, until: '2026-10-17T16:00:00.000Z', why: 'claude: 7-day window at 90% (limit 85%)' })
    })
  })
})

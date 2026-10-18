import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OMP_USAGE_TTL_MS, collectOmp, parseOmpLine, windowsFromOmpUsage } from '../../src/usage/omp'
import { loadPricing } from '../../src/usage/pricing'
import type { Runner } from '../../src/usage/types'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { FIXTURES, NOW, installFixture } from './helpers'

const USAGE_JSON = readFileSync(join(FIXTURES, 'omp', 'usage.json'), 'utf8')
const ompOnPath = (n: string) => (n === 'omp' ? '/usr/local/bin/omp' : undefined)

function recorder(stdout = USAGE_JSON, code = 0): { run: Runner, calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: async argv => { calls.push(argv); return { code, stdout, stderr: '', timedOut: false } } }
}

describe('parseOmpLine', () => {
  test('assistant messages and model_usage entries carry usage; others do not', () => {
    const lines = readFileSync(join(FIXTURES, 'omp', 'agent', 'sessions', '-Users-me-proj', '2026-10-05T10-00-00-000Z_019c625b-b900-7000-8000-000000000001.jsonl'), 'utf8').trim().split('\n')
    const events = lines.flatMap(l => parseOmpLine(l, {}) ?? [])
    expect(events.map(e => [e.model, e.priceModel, e.tokens, e.costUsd])).toEqual([
      ['anthropic/claude-sonnet-5-5', 'claude-sonnet-5-5', 1120, 0.0005],
      ['openai/gpt-6.1-sol', 'gpt-6.1-sol', 60, undefined],
      ['anthropic/claude-sonnet-5-5', 'claude-sonnet-5-5', 9900, 0.027],
    ])
  })
})

describe('windowsFromOmpUsage', () => {
  test('labels by duration or id, busiest account per label, expired windows dropped', () => {
    expect(windowsFromOmpUsage(JSON.parse(USAGE_JSON), NOW)).toEqual([
      { pct: 50, label: '5h', windowMinutes: 300, resetsAt: '2026-10-08T11:00:00.000Z' },
      { pct: 60, label: '7d', windowMinutes: 10080, resetsAt: '2026-10-12T09:00:00.000Z' },
      { pct: 62, label: '30d', windowMinutes: 43200 },
    ])
    expect(windowsFromOmpUsage({ reports: 'nope' }, NOW)).toEqual([])
    expect(windowsFromOmpUsage(null, NOW)).toEqual([])
    expect(windowsFromOmpUsage({ reports: [{ limits: [{ window: { id: 'daily' }, amount: { remainingFraction: 0.25, unit: 'percent' } }] }] }, NOW)).toEqual([{ pct: 75, label: '1d' }])
  })
})

describe('collectOmp', () => {
  test('sessions: OMP cost when recorded, list price otherwise; forked copies count once', () => withSandbox(async ({ home }) => {
    installFixture('omp/agent', join(home, '.omp', 'agent'))
    const e = await collectOmp({ nowMs: NOW, pricing: loadPricing(), offline: true })
    expect(e.month.byModel).toEqual({
      'anthropic/claude-sonnet-5-5': { tokens: 1120, usd: 0.0005 },
      'openai-codex/gpt-6.1-sol': { tokens: 5300, usd: 0.0092 },
      'openai/gpt-6.1-sol': { tokens: 60, usd: 0.0002 },
    })
    expect(e.month.tokens).toBe(6480)
    expect(e.month.usd).toBe(0.0099)
    expect(e.windows).toEqual([])
    expect(e.month_pct).toBeUndefined()
  }))

  test('quota windows from `omp usage --json`, reused for five minutes; monthly → month_pct', () => withSandbox(async ({ home }) => {
    installFixture('omp/agent', join(home, '.omp', 'agent'))
    const r = recorder()
    const e = await collectOmp({ nowMs: NOW, pricing: {}, which: ompOnPath, run: r.run })
    expect(r.calls).toEqual([['/usr/local/bin/omp', 'usage', '--json']])
    expect(e.windows.map(w => [w.label, w.pct])).toEqual([['5h', 50], ['7d', 60]])
    expect(e.month_pct).toBe(62)
    await collectOmp({ nowMs: NOW + OMP_USAGE_TTL_MS - 1, pricing: {}, which: ompOnPath, run: r.run })
    expect(r.calls.length).toBe(1)
    const later = await collectOmp({ nowMs: NOW + OMP_USAGE_TTL_MS + 1, pricing: {}, which: ompOnPath, run: r.run })
    expect(r.calls.length).toBe(2)
    expect(later.month_pct).toBe(62)
  }))

  test('omp missing, failing or printing junk never breaks the collector', () => withSandbox(async () => {
    const none = await collectOmp({ nowMs: NOW, pricing: {}, which: () => undefined })
    expect(none).toMatchObject({ harness: 'omp', windows: [], month: { tokens: 0 } })
    const failing = recorder('', 1)
    expect((await collectOmp({ nowMs: NOW, pricing: {}, which: ompOnPath, run: failing.run })).notes).toEqual(['omp usage --json exited 1'])
    await collectOmp({ nowMs: NOW + 1000, pricing: {}, which: ompOnPath, run: failing.run })
    expect(failing.calls.length).toBe(1)
    const junk = recorder('{not json')
    expect((await collectOmp({ nowMs: NOW + 2 * OMP_USAGE_TTL_MS, pricing: {}, which: ompOnPath, run: junk.run })).notes).toEqual(['omp usage --json printed invalid JSON'])
    const good = recorder()
    await collectOmp({ nowMs: NOW + 4 * OMP_USAGE_TTL_MS, pricing: {}, which: ompOnPath, run: good.run })
    const after = await collectOmp({ nowMs: NOW + 6 * OMP_USAGE_TTL_MS, pricing: {}, which: ompOnPath, run: recorder('', 2).run })
    expect(after.month_pct).toBe(62)
  }))

  test('PI_CODING_AGENT_DIR relocates the session files', () => withSandbox(async ({ root }) => {
    installFixture('omp/agent', join(root, 'pi-agent'))
    await withEnv({ PI_CODING_AGENT_DIR: join(root, 'pi-agent') }, async () => {
      const e = await collectOmp({ nowMs: NOW, pricing: {}, offline: true })
      expect(e.month.tokens).toBe(6480)
    })
  }))
})

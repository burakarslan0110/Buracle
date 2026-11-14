import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OMP_USAGE_TTL_MS, collectOmp, windowsFromOmpUsage } from '../../src/usage/omp'
import type { Runner } from '../../src/usage/types'
import { withSandbox } from '../helpers/sandbox'
import { FIXTURES, NOW } from './helpers'

const USAGE_JSON = readFileSync(join(FIXTURES, 'omp', 'usage.json'), 'utf8')
const ompOnPath = (n: string) => (n === 'omp' ? '/usr/local/bin/omp' : undefined)

function recorder(stdout = USAGE_JSON, code = 0): { run: Runner, calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: async argv => { calls.push(argv); return { code, stdout, stderr: '', timedOut: false } } }
}

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
  test('quota windows from `omp usage --json`, reused for five minutes; the 30-day window is left out', () => withSandbox(async () => {
    const r = recorder()
    const e = await collectOmp({ nowMs: NOW, which: ompOnPath, run: r.run })
    expect(r.calls).toEqual([['/usr/local/bin/omp', 'usage', '--json']])
    expect(e.windows.map(w => [w.label, w.pct])).toEqual([['5h', 50], ['7d', 60]])
    await collectOmp({ nowMs: NOW + OMP_USAGE_TTL_MS - 1, which: ompOnPath, run: r.run })
    expect(r.calls.length).toBe(1)
    const later = await collectOmp({ nowMs: NOW + OMP_USAGE_TTL_MS + 1, which: ompOnPath, run: r.run })
    expect(r.calls.length).toBe(2)
    expect(later.windows.map(w => [w.label, w.pct])).toEqual([['5h', 50], ['7d', 60]])
  }))

  test('omp missing, failing or printing junk never breaks the collector', () => withSandbox(async () => {
    const none = await collectOmp({ nowMs: NOW, which: () => undefined })
    expect(none).toMatchObject({ harness: 'omp', windows: [] })
    const failing = recorder('', 1)
    expect((await collectOmp({ nowMs: NOW, which: ompOnPath, run: failing.run })).notes).toEqual(['omp usage --json exited 1'])
    await collectOmp({ nowMs: NOW + 1000, which: ompOnPath, run: failing.run })
    expect(failing.calls.length).toBe(1)
    const junk = recorder('{not json')
    expect((await collectOmp({ nowMs: NOW + 2 * OMP_USAGE_TTL_MS, which: ompOnPath, run: junk.run })).notes).toEqual(['omp usage --json printed invalid JSON'])
    const good = recorder()
    await collectOmp({ nowMs: NOW + 4 * OMP_USAGE_TTL_MS, which: ompOnPath, run: good.run })
    const after = await collectOmp({ nowMs: NOW + 6 * OMP_USAGE_TTL_MS, which: ompOnPath, run: recorder('', 2).run })
    expect(after.windows.map(w => [w.label, w.pct])).toEqual([['5h', 50], ['7d', 60]])
  }))
})

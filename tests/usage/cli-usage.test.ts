import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { main } from '../../src/cli/router'
import { formatUsageReport, parseUsageArgs, runUsage } from '../../src/cli/commands/usage'
import { readUsageCache } from '../../src/usage/cache'
import type { UsageCacheEntry } from '../../src/usage/types'
import { withSandbox } from '../helpers/sandbox'
import { NOW, installFixture } from './helpers'

function io() {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: false, text: async () => '' },
    out: () => out,
    err: () => err,
  }
}

function installAll(home: string): void {
  installFixture('claude/projects', join(home, '.claude', 'projects'))
  installFixture('codex', join(home, '.codex'))
  installFixture('omp/agent', join(home, '.omp', 'agent'))
}

describe('parseUsageArgs', () => {
  test('verbs, harness lists and months', () => {
    expect(parseUsageArgs([])).toEqual({ refresh: false, breakdown: false, offline: false, json: false, background: false })
    expect(parseUsageArgs(['refresh', '--harness', 'claude,codex', '--harness=omp', '--json'])).toMatchObject({ refresh: true, harnesses: ['claude', 'codex', 'omp'], json: true })
    expect(parseUsageArgs(['--month'])).toMatchObject({ breakdown: true })
    expect(parseUsageArgs(['--month', '2026-09'])).toMatchObject({ breakdown: true, month: '2026-09' })
    expect(parseUsageArgs(['--month=2026-09'])).toMatchObject({ month: '2026-09' })
    expect(parseUsageArgs(['--harness', 'cursor'])).toEqual({ error: "unknown harness 'cursor' (expected claude, codex, opencode, omp)" })
    expect(parseUsageArgs(['--month=26-9'])).toEqual({ error: '--month expects YYYY-MM' })
    expect(parseUsageArgs(['frobnicate'])).toEqual({ error: 'unknown argument frobnicate' })
  })
})

describe('buracle usage', () => {
  test('--json collects stale harnesses, writes the cache and prints snapshots', () => withSandbox(async ({ home }) => {
    installAll(home)
    const o = io()
    const code = await runUsage({ refresh: false, breakdown: false, offline: true, json: true, background: false }, o, { nowMs: NOW })
    expect(o.err()).toBe('')
    expect(code).toBe(0)
    const j = JSON.parse(o.out()) as { v: number, month: string, harnesses: Record<string, UsageCacheEntry> }
    expect(j.v).toBe(1)
    expect(j.month).toBe('2026-10')
    expect(Object.keys(j.harnesses)).toEqual(['claude', 'codex', 'opencode', 'omp'])
    expect(j.harnesses['claude']?.month.tokens).toBe(44635)
    expect(j.harnesses['codex']?.month.tokens).toBe(45200)
    expect(j.harnesses['codex']?.windows.map(w => w.label)).toEqual(['5h', '7d'])
    expect(j.harnesses['omp']?.month.tokens).toBe(6480)
    expect(j.harnesses['opencode']?.notes?.[0]).toStartWith('no OpenCode database')
    expect(readUsageCache()?.harnesses.codex?.month.tokens).toBe(45200)
  }))

  test('fresh cache entries are shown without collecting; refresh always collects', () => withSandbox(async ({ home }) => {
    installAll(home)
    let calls = 0
    const counting: Parameters<typeof runUsage>[2] = { nowMs: NOW, refresh: async (opts) => { calls++; const { refreshUsage } = await import('../../src/usage/index'); return refreshUsage(opts) } }
    await runUsage({ refresh: false, harnesses: ['claude'], breakdown: false, offline: true, json: true, background: false }, io(), counting)
    await runUsage({ refresh: false, harnesses: ['claude'], breakdown: false, offline: true, json: true, background: false }, io(), counting)
    expect(calls).toBe(1)
    await runUsage({ refresh: true, harnesses: ['claude'], breakdown: false, offline: true, json: true, background: false }, io(), counting)
    expect(calls).toBe(2)
    await runUsage({ refresh: true, harnesses: ['claude'], breakdown: false, offline: true, json: false, background: true }, io(), counting)
    expect(calls).toBe(2)
  }))

  test('--month YYYY-MM reports another month without touching the cache', () => withSandbox(async ({ home }) => {
    installAll(home)
    const o = io()
    expect(await runUsage({ refresh: false, harnesses: ['claude', 'codex'], month: '2026-09', breakdown: true, offline: true, json: true, background: false }, o, { nowMs: NOW })).toBe(0)
    const j = JSON.parse(o.out()) as { month: string, harnesses: Record<string, UsageCacheEntry> }
    expect(j.month).toBe('2026-09')
    expect(j.harnesses['claude']?.month.tokens).toBe(2000)
    expect(j.harnesses['codex']?.month.tokens).toBe(7700)
    expect(readUsageCache()).toBeUndefined()
  }))

  test('human report with the per-model breakdown', () => withSandbox(async ({ home }) => {
    installAll(home)
    const o = io()
    expect(await runUsage({ refresh: true, harnesses: ['claude', 'codex'], breakdown: true, offline: true, json: false, background: false }, o, { nowMs: NOW })).toBe(0)
    const text = o.out()
    expect(text).toStartWith('Usage · 2026-10 · month to date (≈ list-price estimate)\n')
    expect(text).toContain('claude    ≈$0.03')
    expect(text).toMatch(/^ {2}claude-opus-5-5 +42k tok +≈\$0\.02$/m)
    expect(text).toMatch(/^codex +≈\$0\.06 +45k tok +5h 22% ↺/m)
  }))

  test('the router reaches the command; bad arguments exit 1', () => withSandbox(async () => {
    const bad = io()
    expect(await main(['usage', '--harness', 'nope'], bad)).toBe(1)
    expect(bad.err()).toContain("unknown harness 'nope'")
    const help = io()
    expect(await main(['usage', '--help'], help)).toBe(0)
    expect(help.out()).toStartWith('Usage: buracle usage')
  }))

  test('a failing collector yields exit 2 with the others still reported', () => withSandbox(async () => {
    const o = io()
    const code = await runUsage({ refresh: true, harnesses: ['claude', 'codex'], breakdown: false, offline: true, json: true, background: false }, o, {
      nowMs: NOW,
      refresh: async () => ({ entries: [{ harness: 'claude', computed_at: new Date(NOW).toISOString(), windows: [], month: { start: '', tokens: 1, byModel: {} }, month_key: '2026-10' }], errors: [{ harness: 'codex', error: 'boom' }], written: true }),
    })
    expect(code).toBe(2)
    expect(JSON.parse(o.out()).errors).toEqual([{ harness: 'codex', error: 'boom' }])
  }))

  test("a cached entry of another month is never reported as this month's, even when its refresh fails", () => withSandbox(async () => {
    const { writeUsageEntries } = await import('../../src/usage/cache')
    const old: UsageCacheEntry = { harness: 'codex', computed_at: new Date(NOW - 9 * 86_400_000).toISOString(), windows: [], month: { start: '', tokens: 999, byModel: {} }, month_key: '2026-09' }
    writeUsageEntries([old], NOW - 9 * 86_400_000)
    const o = io()
    const code = await runUsage({ refresh: false, harnesses: ['codex'], breakdown: false, offline: true, json: true, background: false }, o, {
      nowMs: NOW,
      refresh: async () => ({ entries: [], errors: [{ harness: 'codex', error: 'boom' }], written: false }),
    })
    expect(code).toBe(1)
    const j = JSON.parse(o.out()) as { month: string, harnesses: Record<string, unknown> }
    expect(j.month).toBe('2026-10')
    expect(j.harnesses).toEqual({})
  }))

  test('formatUsageReport shows notes and windows', () => {
    const e: UsageCacheEntry = { harness: 'omp', computed_at: '', windows: [{ label: '5h', pct: 50 }], month: { start: '', tokens: 1500, byModel: { 'x/y': { tokens: 1500 } } }, month_key: '2026-10', month_pct: 62, notes: ['hello'] }
    expect(formatUsageReport([e], '2026-10', true, NOW)).toBe('Usage · 2026-10 · month to date (≈ list-price estimate)\nomp       –          1.5k tok    5h 50% · mo 62%\n  x/y                                1.5k tok    unpriced\n  note: hello\n')
  })
})

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

describe('parseUsageArgs', () => {
  test('verbs and harness lists', () => {
    expect(parseUsageArgs([])).toEqual({ refresh: false, offline: false, json: false, background: false })
    expect(parseUsageArgs(['refresh', '--harness', 'claude,codex', '--harness=omp', '--json'])).toMatchObject({ refresh: true, harnesses: ['claude', 'codex', 'omp'], json: true })
    expect(parseUsageArgs(['--harness', 'cursor'])).toEqual({ error: "unknown harness 'cursor' (expected claude, codex, opencode, omp, qwen, pi, agy)" })
    expect(parseUsageArgs(['--month'])).toEqual({ error: 'unknown option --month' })
    expect(parseUsageArgs(['frobnicate'])).toEqual({ error: 'unknown argument frobnicate' })
  })
})

describe('buracle usage', () => {
  test('--json collects stale harnesses, writes the cache and prints snapshots', () => withSandbox(async ({ home }) => {
    installFixture('codex', join(home, '.codex'))
    const o = io()
    const code = await runUsage({ refresh: false, offline: true, json: true, background: false }, o, { nowMs: NOW })
    expect(o.err()).toBe('')
    expect(code).toBe(0)
    const j = JSON.parse(o.out()) as { v: number, harnesses: Record<string, UsageCacheEntry> }
    expect(j.v).toBe(1)
    expect(Object.keys(j.harnesses)).toEqual(['claude', 'codex', 'opencode', 'omp', 'qwen', 'pi', 'agy'])
    expect(j.harnesses['codex']?.windows.map(w => w.label)).toEqual(['5h', '7d'])
    expect(readUsageCache()?.harnesses.codex?.windows.map(w => w.pct)).toEqual([22, 41])
  }))

  test('fresh cache entries are shown without collecting; refresh always collects', () => withSandbox(async () => {
    let calls = 0
    const counting: Parameters<typeof runUsage>[2] = { nowMs: NOW, refresh: async (opts) => { calls++; const { refreshUsage } = await import('../../src/usage/index'); return refreshUsage(opts) } }
    await runUsage({ refresh: false, harnesses: ['claude'], offline: true, json: true, background: false }, io(), counting)
    await runUsage({ refresh: false, harnesses: ['claude'], offline: true, json: true, background: false }, io(), counting)
    expect(calls).toBe(1)
    await runUsage({ refresh: true, harnesses: ['claude'], offline: true, json: true, background: false }, io(), counting)
    expect(calls).toBe(2)
    await runUsage({ refresh: true, harnesses: ['claude'], offline: true, json: false, background: true }, io(), counting)
    expect(calls).toBe(2)
  }))

  test('human report: one line per harness with its windows', () => withSandbox(async ({ home }) => {
    installFixture('codex', join(home, '.codex'))
    const o = io()
    expect(await runUsage({ refresh: true, harnesses: ['claude', 'codex'], offline: true, json: false, background: false }, o, { nowMs: NOW })).toBe(0)
    const text = o.out()
    expect(text).toStartWith('Usage\n')
    expect(text).toMatch(/^claude +–$/m)
    expect(text).toMatch(/^codex +5h 22% ↺.+ · 7d 41% ↺/m)
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
    const code = await runUsage({ refresh: true, harnesses: ['claude', 'codex'], offline: true, json: true, background: false }, o, {
      nowMs: NOW,
      refresh: async () => ({ entries: [{ harness: 'claude', computed_at: new Date(NOW).toISOString(), windows: [] }], errors: [{ harness: 'codex', error: 'boom' }], written: true })
    })
    expect(code).toBe(2)
    expect(JSON.parse(o.out()).errors).toEqual([{ harness: 'codex', error: 'boom' }])
  }))

  test('formatUsageReport shows notes and windows', () => {
    const e: UsageCacheEntry = { harness: 'omp', computed_at: '', windows: [{ label: '5h', pct: 50 }], notes: ['hello'] }
    expect(formatUsageReport([e], NOW)).toBe('Usage\nomp       5h 50%\n  note: hello\n')
  })
})

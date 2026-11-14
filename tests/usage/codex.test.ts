import { describe, expect, test } from 'bun:test'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_BASELINE_TOKENS, codexContextUsedPct, codexRollouts, collectCodex, parseCodexLine } from '../../src/usage/codex'
import type { Runner } from '../../src/usage/types'
import { withSandbox } from '../helpers/sandbox'
import { FIXTURES, NOW, installFixture } from './helpers'

const noZstd = (_: string) => undefined

describe('codexContextUsedPct (Codex footer formula, 12k baseline)', () => {
  test('matches protocol.rs percent_of_context_window_remaining', () => {
    expect(codexContextUsedPct(12_000, 272_000)).toBe(0)
    expect(codexContextUsedPct(5_000, 272_000)).toBe(0)
    expect(codexContextUsedPct(21_000, 272_000)).toBe(3)
    expect(codexContextUsedPct(142_000, 272_000)).toBe(50)
    expect(codexContextUsedPct(272_000, 272_000)).toBe(100)
    expect(codexContextUsedPct(400_000, 272_000)).toBe(100)
    expect(codexContextUsedPct(1, CODEX_BASELINE_TOKENS)).toBe(100)
  })
})

describe('parseCodexLine', () => {
  test('context and rate limits of the codex bucket', () => {
    const lines = readFileSync(join(FIXTURES, 'codex', 'sessions', '2026', '10', '05', 'rollout-2026-10-05T10-00-00-0199b1a2-0000-7000-8000-000000000001.jsonl'), 'utf8').trim().split('\n')
    const carry = {}
    for (const l of lines) parseCodexLine(l, carry)
    expect(carry).toMatchObject({
      model: 'gpt-6.1-sol',
      effort: 'high',
      cwd: '/Users/me/proj',
      thread: '0199b1a2-0000-7000-8000-000000000001',
      rate: { primary: { used: 22, minutes: 300, resetsAt: 1791457200 }, secondary: { used: 41, minutes: 10080, resetsAt: 1791795600 }, plan: 'plus' },
      ctx: { tokens: 21000, window: 272000 },
    })
  })

  test('legacy resets_in_seconds becomes an absolute reset time', () => {
    const carry: Parameters<typeof parseCodexLine>[1] = {}
    parseCodexLine(JSON.stringify({ timestamp: '2026-10-03T09:00:20.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 3600 } } } }), carry)
    expect(carry.rate?.primary).toEqual({ used: 5, minutes: 300, resetsAt: Date.parse('2026-10-03T10:00:20.000Z') / 1000 })
  })
})

describe('collectCodex', () => {
  test('rate windows: newest snapshot of the codex bucket, labelled by window length', () => withSandbox(async ({ home }) => {
    installFixture('codex', join(home, '.codex'))
    const e = await collectCodex({ nowMs: NOW, which: noZstd })
    expect(e.windows).toEqual([
      { pct: 22, label: '5h', windowMinutes: 300, resetsAt: '2026-10-08T11:00:00.000Z' },
      { pct: 41, label: '7d', windowMinutes: 10080, resetsAt: '2026-10-12T09:00:00.000Z' },
    ])
    expect(e.latest).toEqual({
      at: Date.parse('2026-10-05T10:01:30.100Z'),
      sessionId: '0199b1a2-0000-7000-8000-000000000001',
      cwd: '/Users/me/proj',
      model: 'gpt-6.1-sol',
      effort: 'high',
      ctx: { pct: 3, tokens: 21000, window: 272000 },
    })
    const later = await collectCodex({ nowMs: Date.parse('2026-10-10T09:00:00.000Z'), which: noZstd })
    expect(later.windows.map(w => w.label)).toEqual(['7d'])
  }))

  test('compressed rollouts: skipped with a note without zstd, decompressed with it', () => withSandbox(async ({ home }) => {
    installFixture('codex', join(home, '.codex'))
    const dir = join(home, '.codex', 'sessions', '2026', '10', '05')
    const plain = join(dir, 'rollout-2026-10-07T10-00-00-0199b1a2-0000-7000-8000-000000000009.jsonl')
    const record = JSON.stringify({ timestamp: '2026-10-07T10:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 77, window_minutes: 300, resets_at: 1791457200 } } } }) + '\n'
    writeFileSync(plain + '.zst', 'not really zstd')
    const without = await collectCodex({ nowMs: NOW, which: noZstd })
    expect(without.notes).toEqual(['1 compressed rollout(s) skipped: zstd is not installed'])
    expect(without.windows.map(w => [w.label, w.pct])).toEqual([['5h', 22], ['7d', 41]])

    const calls: string[][] = []
    const run: Runner = async argv => { calls.push(argv); return { code: 0, stdout: record, stderr: '', timedOut: false } }
    const withZstd = await collectCodex({ nowMs: NOW, which: n => (n === 'zstd' ? '/usr/bin/zstd' : undefined), run })
    expect(calls).toEqual([['/usr/bin/zstd', '-dcq', plain + '.zst']])
    expect(withZstd.windows.map(w => [w.label, w.pct])).toEqual([['5h', 77]])
    expect(withZstd.notes).toBeUndefined()
  }))

  test('a rollout compressed after it was read is not read again', () => withSandbox(async ({ home }) => {
    installFixture('codex', join(home, '.codex'))
    const which = (n: string) => (n === 'zstd' ? '/usr/bin/zstd' : undefined)
    let calls = 0
    const run: Runner = async () => { calls++; return { code: 0, stdout: '', stderr: '', timedOut: false } }
    await collectCodex({ nowMs: NOW, which, run })
    const f = join(home, '.codex', 'sessions', '2026', '10', '03', 'rollout-2026-10-03T09-00-00-0199b1a2-0000-7000-8000-000000000002.jsonl')
    renameSync(f, f + '.zst')
    const e = await collectCodex({ nowMs: NOW, which, run })
    expect(calls).toBe(0)
    expect(e.windows.map(w => [w.label, w.pct])).toEqual([['5h', 22], ['7d', 41]])
  }))

  test('rollout discovery covers sessions/ and archived_sessions/', () => withSandbox(async ({ home }) => {
    installFixture('codex', join(home, '.codex'))
    const files = codexRollouts(join(home, '.codex'))
    expect(files.length).toBe(5)
    expect(files.some(f => f.path.includes('archived_sessions'))).toBe(true)
    expect(codexRollouts(join(home, 'nowhere'))).toEqual([])
  }))

  test('missing CODEX_HOME is an entry without windows', () => withSandbox(async () => {
    const e = await collectCodex({ nowMs: NOW, which: noZstd })
    expect(e).toMatchObject({ harness: 'codex', windows: [] })
    expect(e.latest).toBeUndefined()
  }))
})

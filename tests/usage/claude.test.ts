import { describe, expect, test } from 'bun:test'
import { appendFileSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { collectClaude, parseClaudeLine } from '../../src/usage/claude'
import { loadPricing } from '../../src/usage/pricing'
import { cursorFile } from '../../src/usage/scan'
import { telemetryPath, writeTelemetry } from '../../src/workflow/session-store'
import { withSandbox } from '../helpers/sandbox'
import { NOW, installFixture } from './helpers'

const PROJECT = '1b0c7e52-5d9a-4c39-9a51-6f0f4f7e2a10'

describe('parseClaudeLine', () => {
  test('only assistant lines with usage; later blocks of one message add only their growth', () => {
    const carry = { recent: [] as Array<{ k: string, c: { input: number, output: number, cacheRead: number, cacheWrite: number } }> }
    const lines = readFileSync(join(import.meta.dir, '..', 'fixtures', 'usage', 'claude', 'projects', '-Users-me-proj', `${PROJECT}.jsonl`), 'utf8').trim().split('\n')
    const events = lines.flatMap(l => parseClaudeLine(l, carry) ?? [])
    expect(events.map(e => [e.model, e.input, e.output, e.cacheRead, e.cacheWrite])).toEqual([
      ['claude-opus-5-5', 10, 5, 20000, 1000],
      ['claude-opus-5-5', 0, 115, 0, 0],
      ['claude-opus-5-5', 5, 300, 21000, 0],
      ['claude-haiku-5-5', 100, 50, 0, 0],
      ['claude-opus-5-5', 1000, 1000, 0, 0],
    ])
    expect(new Set(events.map(e => e.key)).size).toBe(5)
    expect(parseClaudeLine('{"type":"user","message":{"usage":{}}}', carry)).toBeUndefined()
  })
})

describe('collectClaude', () => {
  test('month to date by model: dedupes resumed copies, includes subagents, prices from the table', () => withSandbox(async ({ home }) => {
    installFixture('claude/projects', join(home, '.claude', 'projects'))
    const e = await collectClaude({ nowMs: NOW, pricing: loadPricing() })
    expect(e.harness).toBe('claude')
    expect(e.month_key).toBe('2026-10')
    expect(e.month.start.startsWith('2026-10-01T00:00:00.000')).toBe(true)
    expect(e.month.byModel['claude-opus-5-5']?.tokens).toBe(21130 + 21305)
    expect(e.month.byModel['claude-opus-5-5']?.usd).toBeCloseTo(0.02166, 9)
    expect(e.month.byModel['claude-haiku-5-5']).toEqual({ tokens: 450, usd: 0.000105 })
    expect(e.month.byModel['claude-sonnet-5-5']).toEqual({ tokens: 1750, usd: 0.0057 })
    expect(e.month.tokens).toBe(44635)
    expect(e.month.usd).toBeCloseTo(0.027465, 9)
    expect(e.windows).toEqual([])

    const sep = await collectClaude({ nowMs: NOW, pricing: loadPricing(), month: '2026-09' })
    expect(sep.month.tokens).toBe(2000)
    expect(sep.month.byModel['claude-opus-5-5']?.usd).toBeCloseTo(0.024, 9)
  }))

  test('incremental: a second run reads only what was appended', () => withSandbox(async ({ home }) => {
    installFixture('claude/projects', join(home, '.claude', 'projects'))
    const pricing = loadPricing()
    await collectClaude({ nowMs: NOW, pricing })
    const before = readFileSync(cursorFile('claude'), 'utf8')
    const again = await collectClaude({ nowMs: NOW, pricing })
    expect(readFileSync(cursorFile('claude'), 'utf8')).toBe(before)
    expect(again.month.tokens).toBe(44635)
    appendFileSync(join(home, '.claude', 'projects', '-Users-me-proj', `${PROJECT}.jsonl`),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-07T10:00:00.000Z', requestId: 'req_new', message: { id: 'msg_new', model: 'claude-fable-5-1', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n')
    const after = await collectClaude({ nowMs: NOW, pricing })
    expect(after.month.byModel['claude-fable-5-1']).toEqual({ tokens: 1100, usd: 0.015 })
    expect(after.month.tokens).toBe(44635 + 1100)
  }))

  test('rate windows come from the newest Claude telemetry, minus windows that already reset', () => withSandbox(async () => {
    writeTelemetry('claude', 'old-session', { at: NOW - 3_600_000, windows: [{ label: '5h', pct: 10, resetsAt: new Date(NOW + 60_000).toISOString() }] })
    const old = telemetryPath('claude', 'old-session')
    utimesSync(old, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
    writeTelemetry('claude', 'new-session', {
      at: NOW - 60_000,
      model: 'Opus 5.5',
      cwd: '/Users/me/proj',
      windows: [
        { label: '5h', pct: 42, windowMinutes: 300, resetsAt: new Date(NOW + 80 * 60_000).toISOString() },
        { label: '7d', pct: 18, windowMinutes: 10080, resetsAt: new Date(NOW - 1000).toISOString() },
      ],
    })
    const e = await collectClaude({ nowMs: NOW, pricing: {} })
    expect(e.windows.map(w => [w.label, w.pct])).toEqual([['5h', 42]])
    expect(e.latest).toMatchObject({ sessionId: 'new-session', model: 'Opus 5.5', cwd: '/Users/me/proj' })
    expect(e.month.tokens).toBe(0)
  }))
})

import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compactionSummary, contextUsedPct, fallbackWindowLabel, parseRolloutTelemetry, readCompactionSummary, readRolloutTelemetry } from '../../../src/adapters/codex/rollout'
import { codexContextUsedPct } from '../../../src/usage/codex'
import { windowLabel } from '../../../src/core/status/model'
import { withSandbox } from '../../helpers/sandbox'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const RESET_5H = Math.floor(NOW / 1000) + 3600
const RESET_7D = Math.floor(NOW / 1000) + 5 * 86400

const tokenCount = (info: unknown, limits: unknown, ts = '2026-10-08T10:00:00.000Z') =>
  JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info, rate_limits: limits } })

const turnContext = (model: string, effort: string, ts = '2026-10-08T09:59:00.000Z') =>
  JSON.stringify({ timestamp: ts, type: 'turn_context', payload: { cwd: '/work/app', model, effort, approval_policy: 'on-request' } })

const info = (total: number, window: number) => ({
  total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total * 3 },
  last_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
  model_context_window: window,
})

const limits = {
  limit_id: 'codex', limit_name: null,
  primary: { used_percent: 18, window_minutes: 300, resets_at: RESET_5H },
  secondary: { used_percent: 41.5, window_minutes: 10080, resets_at: RESET_7D },
  credits: null, plan_type: 'plus', rate_limit_reached_type: null,
}

describe('rollout → telemetry', () => {
  test('context used % is the usage collector\'s formula (12k baseline, used = 100 − remaining)', () => {
    for (const [tokens, window] of [[12_000, 272_000], [5_000, 272_000], [142_000, 272_000], [272_000, 272_000], [500, 10_000]] as const) {
      expect(contextUsedPct(tokens, window)).toBe(codexContextUsedPct(tokens, window))
    }
    expect(contextUsedPct(142_000, 272_000)).toBe(50)
  })

  test('fallback window labels match core windowLabel on the standard bands', () => {
    for (const m of [300, 1440, 10080, 43200]) expect(fallbackWindowLabel(m)).toBe(windowLabel(m))
    expect(fallbackWindowLabel(90)).toBe('90m')
  })

  test('latest turn_context gives model and effort; latest info the context; latest codex-bucket limits the windows', () => {
    const lines = [
      JSON.stringify({ timestamp: '2026-10-08T09:00:00.000Z', type: 'session_meta', payload: { id: 'x', cwd: '/work/app' } }),
      turnContext('gpt-6.1-sol', 'medium', '2026-10-08T09:01:00.000Z'),
      tokenCount(info(50_000, 272_000), limits, '2026-10-08T09:02:00.000Z'),
      turnContext('gpt-6.1-sol', 'high', '2026-10-08T09:03:00.000Z'),
      tokenCount(null, { ...limits, limit_id: 'other-bucket', primary: { used_percent: 99, window_minutes: 300 } }, '2026-10-08T09:04:00.000Z'),
      tokenCount(info(142_000, 272_000), null, '2026-10-08T09:05:00.000Z'),
      'not json {"token_count"',
    ]
    const t = parseRolloutTelemetry(lines.join('\n'), { nowMs: NOW, label: windowLabel })
    expect(t.model).toBe('gpt-6.1-sol')
    expect(t.effort).toBe('high')
    expect(t.ctx).toEqual({ pct: 50, tokens: 142_000, window: 272_000 })
    expect(t.at).toBe(Date.parse('2026-10-08T09:05:00.000Z'))
    expect(t.windows).toEqual([
      { pct: 18, label: '5h', windowMinutes: 300, resetsAt: new Date(RESET_5H * 1000).toISOString() },
      { pct: 41.5, label: '7d', windowMinutes: 10080, resetsAt: new Date(RESET_7D * 1000).toISOString() },
    ])
  })

  test('windows whose reset time has passed are dropped', () => {
    const past = { ...limits, primary: { used_percent: 90, window_minutes: 300, resets_at: Math.floor(NOW / 1000) - 60 } }
    const t = parseRolloutTelemetry(tokenCount(info(20_000, 272_000), past), { nowMs: NOW })
    expect(t.windows.map(w => w.label)).toEqual(['7d'])
  })

  test('unknown shapes, torn lines and empty text yield nothing instead of throwing', () => {
    expect(parseRolloutTelemetry('{"type":"event_msg","payload":{"type":"token_count","info":{"model_context_window":"x"}}}', { nowMs: NOW })).toEqual({ windows: [] })
    expect(parseRolloutTelemetry('', { nowMs: NOW })).toEqual({ windows: [] })
    expect(parseRolloutTelemetry('{"timestamp":"2026-10-08T09:00:00Z","type":"event_msg","payload":{"type":"token_cou', { nowMs: NOW })).toEqual({ windows: [] })
  })

  test('reads only the tail of a large rollout file', () => withSandbox(({ root }) => {
    const path = join(root, 'rollout.jsonl')
    const filler = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1000) } })
    writeFileSync(path, [tokenCount(info(20_000, 272_000), limits), ...Array.from({ length: 800 }, () => filler), turnContext('gpt-6.1-sol', 'low'), tokenCount(info(272_000, 272_000), limits)].join('\n') + '\n')
    const t = readRolloutTelemetry(path, { nowMs: NOW })
    expect(t?.ctx?.pct).toBe(100)
    expect(t?.effort).toBe('low')
    expect(readRolloutTelemetry(join(root, 'missing.jsonl'), { nowMs: NOW })).toBeUndefined()
  }))
})

describe('compaction summary (PostCompact H14)', () => {
  const compacted = (message: string, ts = '2026-10-08T11:00:00.000Z') => JSON.stringify({
    timestamp: ts, type: 'compacted', payload: { message, replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(50) }] }] },
  })

  test('the latest compacted item\'s message wins', () => {
    const text = [compacted('first summary'), tokenCount(info(1, 272_000), null), compacted('Task 3 of 6 is done.\nNext: tests.')].join('\n')
    expect(compactionSummary(text)).toBe('Task 3 of 6 is done.\nNext: tests.')
  })

  test('a torn compacted line still yields the summary (message is serialized first)', () => {
    const line = compacted('summary "quoted" text')
    expect(compactionSummary(line.slice(0, line.indexOf('replacement_history') + 30))).toBe('summary "quoted" text')
  })

  test('no compacted item, empty messages and look-alike text inside strings give undefined', () => {
    expect(compactionSummary(tokenCount(info(1, 272_000), null))).toBeUndefined()
    expect(compactionSummary(compacted('   '))).toBeUndefined()
    expect(compactionSummary(JSON.stringify({ type: 'response_item', payload: { text: '"type":"compacted","payload":{"message":"fake"}' } }))).toBeUndefined()
  })

  test('reads the rollout file', () => withSandbox(({ root }) => {
    const path = join(root, 'rollout.jsonl')
    writeFileSync(path, [turnContext('m', 'low'), compacted('The plan p.md is in phase implement.')].join('\n') + '\n')
    expect(readCompactionSummary(path)).toBe('The plan p.md is in phase implement.')
    expect(readCompactionSummary(join(root, 'none.jsonl'))).toBeUndefined()
  }))
})

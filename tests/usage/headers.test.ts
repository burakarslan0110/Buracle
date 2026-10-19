import { describe, expect, test } from 'bun:test'
import { windowsFromCodexEvent, windowsFromFrame, windowsFromHeaders } from '../../src/usage/headers'
import { latestWindows } from '../../src/usage/telemetry'
import { writeTelemetry } from '../../src/workflow/session-store'
import { withSandbox } from '../helpers/sandbox'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const S = NOW / 1000
const get = (h: Record<string, string>) => (name: string) => h[name] ?? null

describe('5-hour and weekly windows from provider responses (OpenCode)', () => {
  test('Anthropic unified headers: utilization is a fraction, reset is in epoch seconds', () => {
    expect(windowsFromHeaders(get({
      'anthropic-ratelimit-unified-5h-utilization': '0.42', 'anthropic-ratelimit-unified-5h-reset': String(S + 3600),
      'anthropic-ratelimit-unified-7d-utilization': '1.02', 'anthropic-ratelimit-unified-7d-reset': String(S + 86_400),
    }), NOW)).toEqual([
      { pct: 42, label: '5h', windowMinutes: 300, resetsAt: new Date(NOW + 3_600_000).toISOString() },
      { pct: 102, label: '7d', windowMinutes: 10080, resetsAt: new Date(NOW + 86_400_000).toISOString() },
    ])
  })

  test('Codex backend headers: used-percent is a percentage; the window size names the window; reset-after-seconds counts from now', () => {
    expect(windowsFromHeaders(get({
      'x-codex-primary-used-percent': '35.5', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': String(S + 600),
      'x-codex-secondary-used-percent': '80', 'x-codex-secondary-window-minutes': '10080', 'x-codex-secondary-reset-after-seconds': '7200',
    }), NOW)).toEqual([
      { pct: 35.5, label: '5h', windowMinutes: 300, resetsAt: new Date(NOW + 600_000).toISOString() },
      { pct: 80, label: '7d', windowMinutes: 10080, resetsAt: new Date(NOW + 7_200_000).toISOString() },
    ])
  })

  test('an API-key response, a missing window size and junk values give no window', () => {
    expect(windowsFromHeaders(get({ 'x-ratelimit-remaining-requests': '99', 'anthropic-ratelimit-requests-remaining': '10' }), NOW)).toEqual([])
    expect(windowsFromHeaders(get({ 'x-codex-primary-used-percent': '12' }), NOW)).toEqual([])
    expect(windowsFromHeaders(get({ 'anthropic-ratelimit-unified-5h-utilization': 'n/a' }), NOW)).toEqual([])
    expect(windowsFromHeaders(() => { throw new Error('headers gone') }, NOW)).toEqual([])
  })

  test('the Codex websocket event codex.rate_limits, as text or bytes; any other frame is ignored', () => {
    const event = { type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, reset_at: S + 60 }, secondary: { used_percent: 40, window_minutes: 10080 } } }
    const want = [{ pct: 12.5, label: '5h', windowMinutes: 300, resetsAt: new Date(NOW + 60_000).toISOString() }, { pct: 40, label: '7d', windowMinutes: 10080 }]
    expect(windowsFromCodexEvent(event)).toEqual(want)
    expect(windowsFromFrame(JSON.stringify(event))).toEqual(want)
    expect(windowsFromFrame(new TextEncoder().encode(JSON.stringify(event)))).toEqual(want)
    expect(windowsFromFrame('{"type":"response.output_text.delta"}')).toEqual([])
    expect(windowsFromFrame('codex.rate_limits {not json')).toEqual([])
  })
})

describe('latestWindows: the newest live windows of a harness\'s sessions', () => {
  test('a window past its reset or telemetry older than 6 hours is not shown; a session without windows does not hide another\'s', () => withSandbox(async () => {
    const live = { pct: 30, label: '5h', windowMinutes: 300, resetsAt: new Date(NOW + 3_600_000).toISOString() }
    writeTelemetry('opencode', 'ses_old1', { at: NOW - 7 * 3_600_000, windows: [live], windowsAt: NOW - 7 * 3_600_000 })
    expect(latestWindows('opencode', NOW)).toEqual([])
    writeTelemetry('opencode', 'ses_win1', { at: NOW, windows: [live, { ...live, label: '7d', resetsAt: new Date(NOW - 1).toISOString() }], windowsAt: NOW - 60_000 })
    writeTelemetry('opencode', 'ses_none1', { at: NOW, model: 'local/qwen' })
    expect(latestWindows('opencode', NOW)).toEqual([live])
    expect(latestWindows('codex', NOW)).toEqual([])
  }))
})

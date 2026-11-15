import { describe, expect, test } from 'bun:test'
import { utimesSync } from 'node:fs'
import { collectClaude } from '../../src/usage/claude'
import { telemetryPath, writeTelemetry } from '../../src/workflow/session-store'
import { withSandbox } from '../helpers/sandbox'
import { NOW } from './helpers'

describe('collectClaude', () => {
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
    const e = await collectClaude({ nowMs: NOW })
    expect(e.windows.map(w => [w.label, w.pct])).toEqual([['5h', 42]])
    expect(e.latest).toMatchObject({ sessionId: 'new-session', model: 'Opus 5.5', cwd: '/Users/me/proj' })
  }))
})

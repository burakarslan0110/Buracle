import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearRuntimeDriftCache, hookHealthForStatus, runtimeBehindForStatus, runtimeDriftCacheFile, scanHookFailures } from '../../src/engine/hook-health'
import { rows } from '../../src/core/status/render'
import type { BarModel, StatusLayout } from '../../src/core/status/model'
import { withSandbox } from '../helpers/sandbox'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const line = (ts: string, msg: string, data: Record<string, unknown>, level = 'error') => JSON.stringify({ ts, level, pid: 1, msg, data })

describe('hook health', () => {
  test('counts hook failures of the last 24 h in the log and its rotated .1, and the fail-closed denials among them', () => withSandbox(({ buracleHome }) => {
    const dir = join(buracleHome, 'logs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'buracle.log.1'), [
      line('2026-10-10T12:00:00Z', 'hook handler failed', { harness: 'claude', event: 'PreToolUse', result: 'fail-open' }),
      line('2026-10-11T22:40:35Z', 'hook command failed before dispatch', { argv: ['hook', 'claude', 'PreToolUse'], error: { message: 'BuildMessage: Unexpected <<' }, result: 'fail-closed' }),
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'buracle.log'), [
      line('2026-10-12T08:00:00Z', 'hook: configuration problems (the defaults are used for these values)', { errors: ['x'] }, 'warn'),
      line('2026-10-12T09:00:00Z', 'hook handler failed', { harness: 'codex', event: 'Stop', error: { message: 'kaboom' }, result: 'fail-open' }),
      line('2026-10-12T10:00:00Z', 'hook runtime failed', { harness: 'codex', event: 'PreToolUse', why: 'missing', result: 'fail-closed' }),
      'not json',
      '',
    ].join('\n'))
    const s = scanHookFailures(NOW)
    expect(s).toMatchObject({ failures: 3, failClosed: 2 })
    expect(s.last).toMatchObject({ ts: '2026-10-12T10:00:00Z', harness: 'codex', event: 'PreToolUse', error: 'missing' })
    const old = scanHookFailures(NOW, 72 * 3_600_000)
    expect(old.failures).toBe(4)
    expect(hookHealthForStatus(NOW)).toMatchObject({ failures: 3, failClosed: 2 })
    writeFileSync(join(dir, 'buracle.log'), '')
    expect(hookHealthForStatus(NOW + 1000)).toMatchObject({ failures: 3 })
    expect(hookHealthForStatus(NOW + 120_000)).toMatchObject({ failures: 1 })
  }))

  test('the runtime drift cache holds only while the shim stays the same; a cache without the shim stamp is stale; install can drop it', () => withSandbox(async ({ buracleHome }) => {
    mkdirSync(join(buracleHome, 'cache'), { recursive: true })
    writeFileSync(runtimeDriftCacheFile(), JSON.stringify({ at: NOW, behind: true, shim: '' }) + '\n')
    expect(await runtimeBehindForStatus(NOW + 1000)).toBe(true)
    mkdirSync(join(buracleHome, 'bin'), { recursive: true })
    writeFileSync(join(buracleHome, 'bin', 'buracle'), '#!/bin/sh\n# buracle-shim: checkout\n')
    expect(await runtimeBehindForStatus(NOW + 2000)).toBe(false)
    writeFileSync(runtimeDriftCacheFile(), JSON.stringify({ at: NOW, behind: true }) + '\n')
    expect(await runtimeBehindForStatus(NOW + 3000)).toBe(false)
    clearRuntimeDriftCache()
    expect(existsSync(runtimeDriftCacheFile())).toBe(false)
  }))

  test('the `hooks` status segment shows failures (red) and a runtime behind the checkout (yellow), nothing while all is well', () => {
    const layout: StatusLayout = { rows: [['hooks', 'model']], thresholds: { ctxWarn: 70, ctxCrit: 90 }, emoji: true }
    const bar = (hooks?: BarModel['hooks']): BarModel => (hooks === undefined ? { harness: 'claude', model: 'm', windows: [] } : { harness: 'claude', model: 'm', windows: [], hooks })
    expect(rows(bar({ failures: 0, failClosed: 0 }), layout, 200, NOW)[0]?.map(s => s.id)).toEqual(['model'])
    expect(rows(bar(), layout, 200, NOW)[0]?.map(s => s.id)).toEqual(['model'])
    const failing = rows(bar({ failures: 3, failClosed: 1 }), layout, 200, NOW)[0]?.[0]
    expect(failing).toMatchObject({ id: 'hooks', text: 'hooks ✗3 (1 denied)', color: 'red' })
    const behind = rows(bar({ failures: 0, failClosed: 0, runtimeBehind: true }), layout, 200, NOW)[0]?.[0]
    expect(behind).toMatchObject({ id: 'hooks', text: 'runtime behind: buracle install', color: 'yellow' })
  })
})

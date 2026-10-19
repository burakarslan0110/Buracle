import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { defaultConfig, validateConfig } from '../../../src/core/config'
import * as core from '../../../src/core/index'
import type { ContextBand } from '../../../src/core/status/context'
import { CONTEXT_DEFAULTS, contextBand, contextThresholds, contextWarning, contextWatch } from '../../../src/core/status/context'
import * as paths from '../../../src/engine/paths'
import { sessionView } from '../../../src/usage/bar'
import { readTelemetry, writeTelemetry } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'

const CFG = { warnPct: 85, criticalPct: 95 }

describe('thresholds (config `context`)', () => {
  test('the shipped defaults are 85 / 95, in core and in canonical/buracle.yaml', () => {
    expect(CONTEXT_DEFAULTS).toEqual(CFG)
    expect(defaultConfig().context).toEqual(CFG)
    const canonical = parseYaml(readFileSync(join(paths.canonicalDir(), 'buracle.yaml'), 'utf8')) as { context?: unknown }
    expect(canonical.context).toEqual(CFG)
  })

  test('the config rejects warnPct >= criticalPct; the watch falls back to the defaults for unusable values', () => {
    const bad = validateConfig({ ...defaultConfig(), context: { warnPct: 95, criticalPct: 85 } })
    expect(bad.ok).toBe(false)
    expect(contextThresholds({ warnPct: 70, criticalPct: 90 })).toEqual({ warnPct: 70, criticalPct: 90 })
    for (const cfg of [undefined, {}, { warnPct: 95, criticalPct: 85 }, { warnPct: 90, criticalPct: 90 }, { warnPct: Number.NaN, criticalPct: 95 }, { warnPct: 0, criticalPct: 95 }, { warnPct: 85, criticalPct: 101 }]) {
      expect(contextThresholds(cfg)).toEqual(CFG)
    }
  })
})

describe('contextBand', () => {
  test('bands at the thresholds (inclusive), overage counts as critical, no measurement is undefined', () => {
    const cases: Array<[number | undefined, ContextBand | undefined]> = [
      [0, 'ok'], [84.9, 'ok'], [85, 'warn'], [94.99, 'warn'], [95, 'critical'], [100, 'critical'], [130, 'critical'],
      [undefined, undefined], [Number.NaN, undefined], [Number.POSITIVE_INFINITY, undefined],
    ]
    for (const [pct, band] of cases) expect({ pct, band: contextBand(pct, CFG) }).toEqual({ pct, band })
    expect(contextBand(72, { warnPct: 70, criticalPct: 90 })).toBe('warn')
  })
})

describe('contextWatch: one warning per band, re-armed below warnPct', () => {
  test('a session that fills up, hovers, compacts and fills up again', () => {
    let warned: ContextBand | undefined
    const shown: Array<[number | undefined, string | undefined]> = []
    for (const pct of [12, 50, 86, 90, 84, 88, 96, 93, 99, 20, undefined, 87, 95.5]) {
      const r = contextWatch(warned, pct, CFG)
      shown.push([pct, r.warn === undefined ? undefined : r.band])
      warned = r.warned
    }
    expect(shown).toEqual([
      [12, undefined], [50, undefined],
      [86, 'warn'],
      [90, undefined],
      [84, undefined], [88, 'warn'],
      [96, 'critical'],
      [93, undefined], [99, undefined],
      [20, undefined],
      [undefined, undefined],
      [87, 'warn'], [95.5, 'critical'],
    ])
    expect(warned).toBe('critical')
  })

  test('jumping straight to critical warns once with the critical text; no measurement keeps the state', () => {
    const r = contextWatch(undefined, 97, CFG)
    expect(r).toEqual({ band: 'critical', warn: contextWarning('critical', CFG), warned: 'critical' })
    expect(contextWatch('critical', 86, CFG)).toEqual({ band: 'warn', warned: 'critical' })
    expect(contextWatch('critical', undefined, CFG)).toEqual({ warned: 'critical' })
    expect(contextWatch('warn', Number.NaN, CFG)).toEqual({ warned: 'warn' })
    expect(contextWatch('ok', 10, CFG)).toEqual({ band: 'ok', warned: 'ok' })
    expect(contextWatch('bogus' as ContextBand, 88, CFG).warn).toBe(contextWarning('warn', CFG))
  })

  test('warning texts: one line, fixed per band and threshold (prompt-cache safe), naming the threshold', () => {
    const warn = contextWarning('warn', CFG) as string
    const crit = contextWarning('critical', CFG) as string
    expect(contextWarning('ok', CFG)).toBeUndefined()
    for (const t of [warn, crit]) {
      expect(t.startsWith('Buracle: the context window is above ')).toBe(true)
      expect(t).not.toContain('\n')
    }
    expect(warn).toContain('85%')
    expect(crit).toContain('95%')
    expect(contextWatch(undefined, 86, CFG).warn).toBe(contextWatch(undefined, 93, CFG).warn)
    expect(contextWarning('warn', { warnPct: 70, criticalPct: 90 })).toContain('70%')
  })

  test('is exported from the core surface the adapters import', () => {
    const c = core as unknown as Record<string, unknown>
    for (const f of ['contextBand', 'contextWatch', 'contextWarning', 'contextThresholds']) expect(typeof c[f]).toBe('function')
  })
})

describe('telemetry (the other half of H05)', () => {
  test('a measurement written to session telemetry is what the status lines read back', () => withSandbox(({ root }) => {
    const now = Date.parse('2026-10-08T09:00:00.000Z')
    writeTelemetry('codex', 'thread-h05', { at: now - 30_000, model: 'gpt-6.1-sol', cwd: root, ctx: { pct: 88, tokens: 239_000, window: 272_000 } })
    expect(readTelemetry('codex', 'thread-h05')).toMatchObject({ v: 1, harness: 'codex', sessionId: 'thread-h05', ctx: { pct: 88, tokens: 239_000, window: 272_000 } })
    writeTelemetry('codex', 'thread-h05', { at: now - 10_000, ctx: { pct: 91 } })
    expect(readTelemetry('codex', 'thread-h05')).toMatchObject({ model: 'gpt-6.1-sol', cwd: root, ctx: { pct: 91 } })
    const view = sessionView('codex', { sessionId: 'thread-h05', nowMs: now })
    expect(view.ctx?.pct).toBe(91)
    expect(contextBand(view.ctx?.pct, defaultConfig().context)).toBe('warn')
  }))

  test('canonical/hooks.yaml binds H05 as a non-blocking, fail-open hook with this file as its contract test', () => {
    const doc = parseYaml(readFileSync(join(paths.canonicalDir(), 'hooks.yaml'), 'utf8')) as { hooks: Array<Record<string, unknown>> }
    const h05 = doc.hooks.find(h => h['id'] === 'H05') as Record<string, unknown>
    expect(h05).toMatchObject({ name: 'context.watch', blocking: 'none', failure: 'open', contract_test: 'tests/core/status/context-watch.test.ts' })
    const b = h05['bindings'] as Record<string, Record<string, unknown>>
    expect(b['claude']?.['event']).toBe('classic.UserPromptSubmit')
    expect(b['claude']?.['also']).toEqual([{ event: 'classic.PreToolUse', matcher: 'Bash|Monitor|Edit|Write|MultiEdit|NotebookEdit|WebSearch|WebFetch|Grep|Glob|AskUserQuestion|Skill|mcp__.*', timeoutMs: 10000 }, { event: 'session.measure' }])
    expect(b['opencode']?.['event']).toBe('session.usage.updated')
    expect(b['codex']?.['event']).toBe('UserPromptSubmit')
    expect(b['omp']).toEqual({ event: 'turn_end' })
  })
})

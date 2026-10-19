import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runtimeConfigCache } from '../../../src/adapters/opencode/runtime/env'
import { defaultConfig } from '../../../src/core/config'
import * as paths from '../../../src/engine/paths'
import { withSandbox } from '../../helpers/sandbox'

function writeSnapshot(value: unknown, mtimeOffsetMs: number, at: Date = new Date(Date.now() + mtimeOffsetMs)): void {
  const file = paths.runtimeConfigFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
  utimesSync(file, at, at)
}

describe('opencode runtime-config reader', () => {
  test('an invalid value keeps its default; the valid values of the snapshot still apply', () => withSandbox(async () => {
    const d = defaultConfig()
    writeSnapshot({ v: 1, config: { ...d, routing: { ...d.routing, strictness: 'nudge' }, context: { warnPct: 'x', criticalPct: 95 } }, resolved: { repoRoot: '/r' } }, 0)
    const snap = runtimeConfigCache(d).get()
    expect(snap.config.routing.strictness).toBe('nudge')
    expect(snap.config.context.warnPct).toBe(d.context.warnPct)
    expect(snap.resolved?.repoRoot).toBe('/r')
    expect(readFileSync(paths.logFile(), 'utf8')).toContain('opencode: runtime-config.json has invalid values')
  }))

  test('a snapshot of another version is not read as this one: the defaults apply, its paths are ignored, the reason is logged', () => withSandbox(async () => {
    const d = defaultConfig()
    writeSnapshot({ v: 2, config: { ...d, routing: { ...d.routing, strictness: 'off' } }, resolved: { repoRoot: '/r' } }, 0)
    const cache = runtimeConfigCache(d)
    const snap = cache.get()
    expect(snap.config).toEqual(d)
    expect(snap.resolved).toBeUndefined()
    expect(readFileSync(paths.logFile(), 'utf8')).toContain('runtime-config.json has version 2, this Buracle reads version 1')
    writeSnapshot({ v: 1, config: { ...d, routing: { ...d.routing, strictness: 'off' } } }, 5_000)
    expect(cache.get().config.routing.strictness).toBe('off')
  }))

  test('a rewrite inside one clock tick (same mtime, as Windows gives two quick writes) is still read', () => withSandbox(async () => {
    const d = defaultConfig()
    const tick = new Date(Date.now() - 60_000)
    writeSnapshot({ v: 1, config: { ...d, routing: { ...d.routing, strictness: 'off' } } }, 0, tick)
    const cache = runtimeConfigCache(d)
    expect(cache.get().config.routing.strictness).toBe('off')
    writeSnapshot({ v: 1, config: { ...d, routing: { ...d.routing, strictness: 'nudge' } } }, 0, tick)
    expect(cache.get().config.routing.strictness).toBe('nudge')
  }))
})

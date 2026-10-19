import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCK_STALE_MS, USAGE_TTL_MS, acquireUsageLock, currentUsageEntry, defaultRefreshArgv, isStale, lockFile, readUsageCache, spawnUsageRefresh, writeUsageEntries } from '../../src/usage/cache'
import type { UsageCacheEntry } from '../../src/usage/types'
import { lockTestHooks } from '../../src/engine/lockfile'
import { repoRoot, usageFile } from '../../src/engine/paths'
import { withSandbox } from '../helpers/sandbox'
import { NOW } from './helpers'

function entry(h: UsageCacheEntry['harness'], tokens: number, at = NOW): UsageCacheEntry {
  return { harness: h, computed_at: new Date(at).toISOString(), windows: [], month: { start: '2026-10-01T00:00:00.000+03:00', tokens, byModel: {} }, month_key: '2026-10' }
}

describe('usage cache', () => {
  test('entries merge per harness in canonical order', () => withSandbox(() => {
    writeUsageEntries([entry('omp', 3), entry('claude', 1)], NOW)
    writeUsageEntries([entry('codex', 2), entry('claude', 10)], NOW + 1)
    const c = readUsageCache()
    expect(Object.keys(c?.harnesses ?? {})).toEqual(['claude', 'codex', 'omp'])
    expect(c?.harnesses.claude?.month.tokens).toBe(10)
    expect(c?.updated_at).toBe(new Date(NOW + 1).toISOString())
  }))

  test('missing, broken or foreign files read as no cache; bad entries are dropped', () => withSandbox(() => {
    expect(readUsageCache()).toBeUndefined()
    writeUsageEntries([entry('claude', 1)], NOW)
    writeFileSync(usageFile(), '{oops')
    expect(readUsageCache()).toBeUndefined()
    writeFileSync(usageFile(), JSON.stringify({ v: 1, updated_at: 'x', harnesses: { claude: { harness: 'claude' }, codex: entry('codex', 5), evil: entry('claude', 1) } }))
    expect(Object.keys(readUsageCache()?.harnesses ?? {})).toEqual(['codex'])
  }))

  test('staleness: missing, another month, older than the TTL, or from the future', () => {
    expect(isStale(undefined, NOW)).toBe(true)
    expect(isStale(entry('claude', 1), NOW)).toBe(false)
    expect(isStale(entry('claude', 1, NOW - USAGE_TTL_MS - 1), NOW)).toBe(true)
    expect(isStale(entry('claude', 1, NOW - 1000), NOW, 500)).toBe(true)
    expect(isStale({ ...entry('claude', 1), month_key: '2026-09' }, NOW)).toBe(true)
    expect(isStale(entry('claude', 1, NOW + 3_600_000), NOW)).toBe(true)
  })
})

describe('refresh lock', () => {
  test('exclusive, released, and broken when abandoned', () => withSandbox(() => {
    const release = acquireUsageLock(NOW)
    expect(release).toBeDefined()
    expect(acquireUsageLock(NOW)).toBeUndefined()
    release?.()
    expect(existsSync(lockFile())).toBe(false)
    const again = acquireUsageLock(NOW)
    expect(again).toBeDefined()
    const old = (Date.now() - LOCK_STALE_MS - 5000) / 1000
    utimesSync(lockFile(), old, old)
    const stolen = acquireUsageLock(NOW)
    expect(stolen).toBeDefined()
    stolen?.()
  }))

  test('O11: a waiter never removes the fresh lock another waiter took after breaking the same stale one', () => withSandbox(() => {
    const release = acquireUsageLock(NOW)
    const old = (Date.now() - LOCK_STALE_MS - 5000) / 1000
    utimesSync(lockFile(), old, old)
    const fresh = `999999 ${NOW} other-waiter\n`
    lockTestHooks.beforeBreak = path => { unlinkSync(path); writeFileSync(path, fresh) }
    try {
      expect(acquireUsageLock(NOW)).toBeUndefined()
    } finally {
      delete lockTestHooks.beforeBreak
    }
    expect(readFileSync(lockFile(), 'utf8')).toBe(fresh)
    release?.()
    expect(readFileSync(lockFile(), 'utf8')).toBe(fresh)
  }))
})

describe('currentUsageEntry (readers ignore another month)', () => {
  test('returns the entry only while its month_key is the current local month', () => withSandbox(() => {
    writeUsageEntries([entry('claude', 1), { ...entry('omp', 2), month_key: '2026-09' }], NOW)
    const c = readUsageCache()
    expect(currentUsageEntry(c, 'claude', NOW)?.month.tokens).toBe(1)
    expect(currentUsageEntry(c, 'omp', NOW)).toBeUndefined()
    expect(isStale(c?.harnesses.omp, NOW)).toBe(true)
    expect(currentUsageEntry(c, 'codex', NOW)).toBeUndefined()
    expect(currentUsageEntry(undefined, 'claude', NOW)).toBeUndefined()
    expect(currentUsageEntry(c, 'claude', Date.parse('2026-11-15T12:00:00Z'))).toBeUndefined()
  }))
})

describe('spawnUsageRefresh', () => {
  test('the default command runs this checkout with bun from PATH (never a harness binary)', () => {
    const argv = defaultRefreshArgv('omp')
    expect(argv.slice(1)).toEqual([join(repoRoot(), 'src', 'cli', 'main.ts'), 'usage', 'refresh', '--harness', 'omp', '--background'])
    expect(argv[0]).toMatch(/bun(\.exe)?$/i)
  })

  test('starts a detached process at most once a minute per harness, never while a refresh runs', () => withSandbox(async ({ root }) => {
    const marker = join(root, 'ran')
    const argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]
    expect(spawnUsageRefresh('claude', { argv })).toBe(true)
    expect(spawnUsageRefresh('claude', { argv })).toBe(false)
    for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(20)
    expect(readFileSync(marker, 'utf8')).toBe('x')
    const release = acquireUsageLock(NOW)
    expect(spawnUsageRefresh('codex', { argv })).toBe(false)
    release?.()
    expect(spawnUsageRefresh('codex', { argv: ['/nonexistent/binary'] })).toBe(true)
  }))
})

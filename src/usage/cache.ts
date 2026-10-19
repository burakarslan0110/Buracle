import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, statSync, utimesSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Harness } from '../core/events'
import { HARNESSES } from '../core/events'
import { bunExecutable } from '../engine/config'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { breakStaleLock, lockSnapshot, lockToken, releaseLockFile } from '../engine/lockfile'
import { log } from '../engine/log'
import { repoRoot, shimPath, stateDir, usageFile } from '../engine/paths'
import { shimLaunch } from '../engine/shim'
import { monthKeyOf } from './month'
import type { UsageCache, UsageCacheEntry } from './types'

export const USAGE_TTL_MS = 5 * 60_000
export const LOCK_STALE_MS = 2 * 60_000
export const SPAWN_INTERVAL_MS = 60_000

function isEntry(x: unknown): x is UsageCacheEntry {
  if (x === null || typeof x !== 'object') return false
  const e = x as Record<string, unknown>
  const m = e['month'] as Record<string, unknown> | undefined
  return typeof e['harness'] === 'string' && typeof e['computed_at'] === 'string' && Array.isArray(e['windows'])
    && m !== undefined && m !== null && typeof m === 'object' && typeof m['tokens'] === 'number' && typeof e['month_key'] === 'string'
}

export function readUsageCache(path = usageFile()): UsageCache | undefined {
  const r = readJsonSafeSync<UsageCache>(path)
  if (!r.ok || r.value === null || typeof r.value !== 'object' || r.value.v !== 1) return undefined
  const harnesses: UsageCache['harnesses'] = {}
  const src = r.value.harnesses && typeof r.value.harnesses === 'object' ? r.value.harnesses : {}
  for (const h of HARNESSES) {
    const e = (src as Record<string, unknown>)[h]
    if (isEntry(e)) harnesses[h] = e
  }
  return { v: 1, updated_at: typeof r.value.updated_at === 'string' ? r.value.updated_at : '', harnesses }
}

export function writeUsageEntries(entries: UsageCacheEntry[], nowMs: number, path = usageFile()): UsageCache {
  const prev = readUsageCache(path)
  const harnesses: UsageCache['harnesses'] = { ...(prev?.harnesses ?? {}) }
  for (const e of entries) harnesses[e.harness] = e
  const ordered: UsageCache['harnesses'] = {}
  for (const h of HARNESSES) { const e = harnesses[h]; if (e !== undefined) ordered[h] = e }
  const cache: UsageCache = { v: 1, updated_at: new Date(nowMs).toISOString(), harnesses: ordered }
  atomicWriteSync(path, JSON.stringify(cache, null, 2) + '\n')
  return cache
}

export function currentUsageEntry(cache: UsageCache | undefined, h: Harness, nowMs: number): UsageCacheEntry | undefined {
  const e = cache?.harnesses[h]
  return e !== undefined && e.month_key === monthKeyOf(nowMs) ? e : undefined
}

export function isStale(entry: UsageCacheEntry | undefined, nowMs: number, ttlMs = USAGE_TTL_MS): boolean {
  if (entry === undefined) return true
  if (entry.month_key !== monthKeyOf(nowMs)) return true
  const at = Date.parse(entry.computed_at)
  return !Number.isFinite(at) || nowMs - at > ttlMs || at - nowMs > 60_000
}

export function lockFile(): string {
  return join(stateDir(), 'usage.lock')
}

export function acquireUsageLock(nowMs: number, opts: { waitMs?: number } = {}): (() => void) | undefined {
  const path = lockFile()
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + (opts.waitMs ?? 0)
  for (;;) {
    const text = `${process.pid} ${nowMs} ${lockToken()}\n`
    try {
      const fd = openSync(path, 'wx', 0o600)
      try { writeSync(fd, text) } finally { closeSync(fd) }
      let released = false
      return () => {
        if (released) return
        released = true
        releaseLockFile(path, text)
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
    }
    const seen = lockSnapshot(path)
    if (seen === undefined) continue
    if (Date.now() - seen.mtimeMs > LOCK_STALE_MS && breakStaleLock(path, seen) !== 'busy') continue
    if (Date.now() >= deadline) return undefined
    Bun.sleepSync(50)
  }
}

function spawnMarker(h: Harness): string {
  return join(stateDir(), `usage.spawn.${h}`)
}

export function defaultRefreshArgv(h: Harness): string[] {
  const tail = ['usage', 'refresh', '--harness', h, '--background']
  const main = join(repoRoot(), 'src', 'cli', 'main.ts')
  return existsSync(main) ? [bunExecutable(), main, ...tail] : [...(shimLaunch() ?? [shimPath()]), ...tail]
}

export function spawnUsageRefresh(h: Harness, opts: { argv?: string[] } = {}): boolean {
  try {
    const now = Date.now()
    try {
      if (now - statSync(lockFile()).mtimeMs <= LOCK_STALE_MS) return false
    } catch {  }
    const marker = spawnMarker(h)
    try {
      if (now - statSync(marker).mtimeMs < SPAWN_INTERVAL_MS) return false
    } catch {  }
    mkdirSync(dirname(marker), { recursive: true })
    try { closeSync(openSync(marker, 'a')) } catch {  }
    try { utimesSync(marker, now / 1000, now / 1000) } catch {  }
    const argv = opts.argv ?? defaultRefreshArgv(h)
    const [cmd, ...args] = argv as [string, ...string[]]
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: process.env })
    child.on('error', e => log('warn', 'usage refresh spawn failed', { h, error: e }))
    child.unref()
    return true
  } catch (e) {
    log('warn', 'usage refresh spawn failed', { h, error: e })
    return false
  }
}

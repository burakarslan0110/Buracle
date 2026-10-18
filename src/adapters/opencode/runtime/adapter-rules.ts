import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { AUTO_PAUSE_REASON } from '../../../core/plan/state'

const CACHE_TTL_MS = 30_000
const CACHE_MAX = 64

interface Entry { at: number; top: string | null; name: string | undefined }
const cache = new Map<string, Entry>()

export function gitToplevel(dir: string): string | undefined {
  let d = resolve(dir)
  for (let i = 0; i < 128; i++) {
    if (existsSync(join(d, '.git'))) return d
    const up = dirname(d)
    if (up === d) return undefined
    d = up
  }
  return undefined
}

function packageName(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown } | null
    return pkg !== null && typeof pkg === 'object' && typeof pkg.name === 'string' ? pkg.name : undefined
  } catch {
    return undefined
  }
}

function real(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

function lookup(cwd: string, nowMs: number): Entry {
  const hit = cache.get(cwd)
  if (hit !== undefined && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_TTL_MS) return hit
  const top = gitToplevel(cwd) ?? null
  const entry: Entry = { at: nowMs, top, name: top !== null ? packageName(top) : undefined }
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(cwd, entry)
  return entry
}

export function buracleRepoFor(cwd: string, configured: ReadonlyArray<string | undefined>, nowMs: number = Date.now()): string | undefined {
  try {
    if (typeof cwd !== 'string' || cwd === '') return undefined
    const { top, name } = lookup(cwd, nowMs)
    if (top === null) return undefined
    if (name === 'buracle') return top
    const want = real(top)
    for (const c of configured) {
      if (typeof c === 'string' && c.trim() !== '' && real(c.trim()) === want) return top
    }
    return undefined
  } catch {
    return undefined
  }
}

export function clearRepoCache(): void {
  cache.clear()
}

export { AUTO_PAUSE_REASON }

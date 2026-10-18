import { readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import { RUNTIME_SNAPSHOT_VERSION, runtimeSnapshotConfig } from '../../../core/config'
import type { McpHealth } from '../../../core/policy/routing'
import { mcpHealthOf } from '../../../core/policy/routing'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'

export const POINTER_FILE = 'runtime.json'

export interface ResolvedEnv { home: string; buracleHome: string; source: 'env' | 'pointer' | 'default' }

function absEnv(name: string): string | undefined {
  const v = process.env[name]
  return v !== undefined && v.trim() !== '' && isAbsolute(v) ? v : undefined
}

export function readPointer(pluginDir: string | undefined): { buracleHome: string } | undefined {
  if (pluginDir === undefined) return undefined
  try {
    const raw = JSON.parse(readFileSync(join(pluginDir, POINTER_FILE), 'utf8')) as unknown
    if (raw !== null && typeof raw === 'object') {
      const bh = (raw as { buracleHome?: unknown }).buracleHome
      if (typeof bh === 'string' && isAbsolute(bh)) return { buracleHome: bh }
    }
  } catch {  }
  return undefined
}

export function resolveEnv(pluginDir: string | undefined): ResolvedEnv {
  const home = absEnv('HOME') ?? os.homedir()
  const fromEnv = absEnv('BURACLE_HOME')
  if (fromEnv !== undefined) return { home, buracleHome: fromEnv, source: 'env' }
  const pointer = readPointer(pluginDir)
  if (pointer !== undefined) return { home, buracleHome: pointer.buracleHome, source: 'pointer' }
  return { home, buracleHome: join(home, '.buracle'), source: 'default' }
}

export function applyEnv(resolved: ResolvedEnv): string[] {
  const changed: string[] = []
  if (resolved.source === 'pointer' && process.env['BURACLE_HOME'] !== resolved.buracleHome) {
    process.env['BURACLE_HOME'] = resolved.buracleHome
    changed.push('BURACLE_HOME')
  }
  return changed
}

function mtimeOf(path: string): number | undefined {
  try { return statSync(path).mtimeMs } catch { return undefined }
}

export class MtimeCache<T> {
  private key: string | undefined
  private value: T
  constructor(private readonly file: () => string, private readonly parse: (raw: unknown) => T, private readonly fallback: () => T) {
    this.value = fallback()
  }
  get(): T {
    let path: string
    try { path = this.file() } catch { return this.fallback() }
    const m = mtimeOf(path)
    const key = m === undefined ? `${path}#none` : `${path}#${m}`
    if (key === this.key) return this.value
    this.key = key
    if (m === undefined) { this.value = this.fallback(); return this.value }
    try {
      this.value = this.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
    } catch {
      this.value = this.fallback()
    }
    return this.value
  }
}

export interface RuntimeSnapshot { config: BuracleConfig; resolved?: { buracleHome?: string; brain?: string; shim?: string; repoRoot?: string } }

export function runtimeConfigCache(defaults: BuracleConfig): MtimeCache<RuntimeSnapshot> {
  return new MtimeCache<RuntimeSnapshot>(
    () => paths.runtimeConfigFile(),
    raw => {
      const merged = runtimeSnapshotConfig(raw, defaults)
      if (merged.warnings.length > 0) log('warn', 'opencode: runtime-config.json needs attention', { warnings: merged.warnings })
      if (merged.errors.length > 0) log('warn', 'opencode: runtime-config.json has invalid values; defaults used for them', { errors: merged.errors })
      const out: RuntimeSnapshot = { config: merged.config }
      const snap = raw as { v?: unknown, resolved?: unknown } | null
      if (snap?.v === RUNTIME_SNAPSHOT_VERSION && snap.resolved !== null && typeof snap.resolved === 'object' && !Array.isArray(snap.resolved)) out.resolved = snap.resolved as RuntimeSnapshot['resolved'] & object
      return out
    },
    () => ({ config: defaults }),
  )
}

export function parseHealth(raw: unknown, nowMs: number = Date.now()): McpHealth {
  return mcpHealthOf(raw, nowMs)
}

export function healthCache(now: () => number = Date.now): { get(): McpHealth } {
  const raw = new MtimeCache<unknown>(() => paths.healthFile(), r => r, () => undefined)
  return { get: () => parseHealth(raw.get(), now()) }
}

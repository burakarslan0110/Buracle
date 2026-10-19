import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import { RUNTIME_SNAPSHOT_VERSION, runtimeSnapshotConfig } from '../../../core/config'
import type { McpHealth } from '../../../core/policy/routing'
import { mcpHealthOf } from '../../../core/policy/routing'
import * as paths from '../../../engine/paths'
import { log } from '../../../engine/log'

export interface LiveConfig {
  config: BuracleConfig
  vault: string
  shim: string
  repoRoot?: string
  resolved?: Record<string, unknown>
  source: 'runtime-config' | 'defaults'
}

interface FileCache<T> { path: string; mtimeMs: number; size: number; value: T }

let configCache: FileCache<LiveConfig> | undefined
let healthCache: FileCache<unknown> | undefined
const warned = new Set<string>()

function warnOnce(key: string, msg: string, data?: unknown): void {
  if (warned.has(key)) return
  warned.add(key)
  log('warn', msg, data)
}

function stat(path: string): { mtimeMs: number, size: number } | undefined {
  try {
    const st = statSync(path)
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : undefined
  } catch {
    return undefined
  }
}

export function ompConfigPath(agentDir: string): string {
  const yml = join(agentDir, 'config.yml')
  const yaml = join(agentDir, 'config.yaml')
  return !existsSync(yml) && existsSync(yaml) ? yaml : yml
}

function fromDefaults(defaults: BuracleConfig): LiveConfig {
  return { config: defaults, vault: paths.oldVaultRoot(), shim: paths.shimPath(), source: 'defaults' }
}

export function parseRuntimeConfig(text: string, defaults: BuracleConfig): LiveConfig {
  const raw = JSON.parse(text) as unknown
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('runtime-config.json: expected an object')
  const snap = raw as { v?: unknown, config?: unknown, resolved?: unknown }
  const merged = runtimeSnapshotConfig(raw, defaults)
  if (merged.warnings.length > 0) warnOnce(`rc-warnings:${merged.warnings.join('|')}`, 'omp: runtime-config.json needs attention', { warnings: merged.warnings })
  if (snap.v !== RUNTIME_SNAPSHOT_VERSION) return fromDefaults(merged.config)
  if (merged.errors.length > 0) warnOnce(`rc-errors:${merged.errors.join('|')}`, 'omp: runtime-config.json has invalid values; defaults used for them', { errors: merged.errors })
  const resolved = (snap.resolved !== null && typeof snap.resolved === 'object' ? snap.resolved : {}) as Record<string, unknown>
  const repo = typeof resolved['repoRoot'] === 'string' && resolved['repoRoot'] !== '' ? resolved['repoRoot'] : merged.config.repo
  const live: LiveConfig = { config: merged.config, vault: paths.oldVaultRoot(), shim: paths.shimPath(), source: 'runtime-config' }
  if (repo !== undefined) live.repoRoot = repo
  if (Object.keys(resolved).length > 0) live.resolved = resolved
  return live
}

export function liveConfig(defaults: BuracleConfig): LiveConfig {
  const file = paths.runtimeConfigFile()
  const st = stat(file)
  if (st === undefined) return fromDefaults(defaults)
  const c = configCache
  if (c !== undefined && c.path === file && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.value
  let value: LiveConfig
  try {
    value = parseRuntimeConfig(readFileSync(file, 'utf8'), defaults)
  } catch (e) {
    warnOnce(`rc-parse:${file}:${st.mtimeMs}`, 'omp: runtime-config.json unreadable; using canonical defaults', { error: e instanceof Error ? e.message : String(e) })
    value = fromDefaults(defaults)
  }
  configCache = { path: file, mtimeMs: st.mtimeMs, size: st.size, value }
  return value
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function withStatus(v: unknown): unknown {
  if (!isRecord(v) || v['status'] !== undefined) return v
  const s = v['health'] ?? v['state']
  return s !== undefined ? { ...v, status: s } : v
}

export function parseHealth(raw: unknown, nowMs: number = Date.now()): McpHealth {
  if (!isRecord(raw)) return {}
  const inner = raw['mcp'] ?? raw['servers']
  const table = isRecord(inner) ? inner : raw
  return mcpHealthOf({ mcp: Object.fromEntries(Object.entries(table).map(([id, v]) => [id, withStatus(v)])) }, nowMs)
}

export function mcpHealth(nowMs: number = Date.now()): McpHealth {
  const file = paths.healthFile()
  const st = stat(file)
  if (st === undefined) return {}
  const c = healthCache
  if (c !== undefined && c.path === file && c.mtimeMs === st.mtimeMs && c.size === st.size) return parseHealth(c.value, nowMs)
  let value: unknown
  try { value = JSON.parse(readFileSync(file, 'utf8')) as unknown } catch (e) {
    warnOnce(`health:${file}:${st.mtimeMs}`, 'omp: health.json unreadable; MCP health unknown', { error: e instanceof Error ? e.message : String(e) })
  }
  healthCache = { path: file, mtimeMs: st.mtimeMs, size: st.size, value }
  return parseHealth(value, nowMs)
}

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { BuracleConfig, ConfigRename } from '../core/config'
import { CONFIG_RENAMES, defaultConfig, mergeConfig, mergeConfigLenient, migrateConfig } from '../core/config'
import { atomicWrite, atomicWriteSync } from './fsx'
import * as paths from './paths'

export interface LoadedConfig {
  config: BuracleConfig
  errors: string[]
  warnings: string[]
  files: { canonical: string; user: string; userExists: boolean }
}

export const UNKNOWN_KEY_HINT = '(ignored; misspelled, renamed or removed? `buracle config get` prints the valid keys)'

type YamlRead = { kind: 'missing' } | { kind: 'ok', value: unknown } | { kind: 'error', error: string }

function readYaml(path: string): YamlRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'error', error: `${path}: ${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    return { kind: 'ok', value: parseYaml(text) as unknown }
  } catch (e) {
    return { kind: 'error', error: `${path}: invalid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }
  }
}

function mergeLayer(base: BuracleConfig, override: unknown, file: string, errors: string[], warnings: string[], renames: readonly ConfigRename[]): BuracleConfig {
  const migrated = migrateConfig(override, renames)
  for (const n of migrated.notes) warnings.push(`${file}: ${n}`)
  try {
    return mergeConfig(base, migrated.value)
  } catch {
    const merged = mergeConfigLenient(base, migrated.value, [])
    for (const e of merged.errors) errors.push(`${file}: ${e.endsWith(': unknown key') ? `${e} ${UNKNOWN_KEY_HINT}` : e}`)
    return merged.config
  }
}

export interface LoadConfigOptions {
  repoRoot?: string
  userConfigPath?: string
  renames?: readonly ConfigRename[]
}

export function loadConfigSync(opts: LoadConfigOptions = {}): LoadedConfig {
  const canonicalPath = join(opts.repoRoot ?? paths.repoRoot(), 'canonical', 'buracle.yaml')
  const userPath = opts.userConfigPath ?? paths.userConfigFile()
  const errors: string[] = []
  const warnings: string[] = []

  let base = defaultConfig()
  const canon = readYaml(canonicalPath)
  if (canon.kind === 'missing') errors.push(`${canonicalPath}: not found; using built-in defaults`)
  else if (canon.kind === 'error') errors.push(canon.error)
  else base = mergeLayer(base, canon.value, canonicalPath, errors, warnings, [])

  let config = base
  const user = readYaml(userPath)
  if (user.kind === 'error') errors.push(user.error)
  else if (user.kind === 'ok') config = mergeLayer(base, user.value, userPath, errors, warnings, opts.renames ?? CONFIG_RENAMES)
  return { config, errors, warnings, files: { canonical: canonicalPath, user: userPath, userExists: user.kind !== 'missing' } }
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
  return loadConfigSync(opts)
}

export interface ResolvedPaths {
  buracleHome: string
  brain: string
  shim: string
  repoRoot: string
  claudeDir: string
  codexHome: string
  opencodeConfigDir: string
  ompAgentDir: string
  bun: string
}

export interface RuntimeConfigSnapshot {
  v: 1
  config: BuracleConfig
  resolved: ResolvedPaths
}

export function bunExecutable(): string {
  return Bun.which('bun') ?? process.execPath
}

export function runtimeConfigSnapshot(config: BuracleConfig): RuntimeConfigSnapshot {
  return {
    v: 1,
    config,
    resolved: {
      buracleHome: paths.buracleHome(),
      brain: paths.brainDir(),
      shim: paths.shimPath(),
      repoRoot: config.repo ?? paths.repoRoot(),
      claudeDir: paths.claudeDir(),
      codexHome: paths.codexHome(),
      opencodeConfigDir: paths.opencodeConfigDir(),
      ompAgentDir: paths.ompAgentDir(),
      bun: bunExecutable(),
    },
  }
}

export async function writeRuntimeConfig(config: BuracleConfig, path: string = paths.runtimeConfigFile()): Promise<string> {
  await atomicWrite(path, JSON.stringify(runtimeConfigSnapshot(config), null, 2) + '\n')
  return path
}

export function refreshRuntimeConfigIfStale(): boolean {
  try {
    const user = paths.userConfigFile()
    const snap = paths.runtimeConfigFile()
    let userMtime: number
    let snapMtime: number
    try { userMtime = statSync(user).mtimeMs } catch { return false }
    try { snapMtime = statSync(snap).mtimeMs } catch { return false }
    if (snapMtime >= userMtime) return false
    const loaded = loadConfigSync()
    if (loaded.errors.some(e => e.startsWith(user))) return false
    const fresh = runtimeConfigSnapshot(loaded.config)
    let next: RuntimeConfigSnapshot = fresh
    try {
      const old = JSON.parse(readFileSync(snap, 'utf8')) as Partial<RuntimeConfigSnapshot> | null
      if (old !== null && typeof old === 'object' && old.v === 1 && old.resolved !== undefined && typeof old.resolved === 'object') {
        const resolved: ResolvedPaths = { ...fresh.resolved }
        const kept = old.resolved as unknown as Record<string, unknown>
        for (const k of Object.keys(resolved) as Array<keyof ResolvedPaths>) {
          const v = kept[k]
          if (k !== 'brain' && typeof v === 'string' && v !== '') resolved[k] = v
        }
        if (old.config?.repo !== loaded.config.repo) resolved.repoRoot = fresh.resolved.repoRoot
        next = { v: 1, config: loaded.config, resolved }
      }
    } catch {  }
    atomicWriteSync(snap, JSON.stringify(next, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

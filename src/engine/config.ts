import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { BuracleConfig, ConfigRename } from '../core/config'
import { CONFIG_RENAMES, defaultConfig, mergeConfig, mergeConfigLenient, migrateConfig } from '../core/config'
import { atomicWrite, atomicWriteSync } from './fsx'
import * as paths from './paths'
import { parseYaml } from './yaml'

export interface LoadedConfig {
  config: BuracleConfig
  errors: string[]
  warnings: string[]
  files: { canonical: string; user: string; userExists: boolean }
  /** Names the inputs this configuration was merged from; set only for a clean load of the default files (see `snapshotConfig`). */
  stamp?: string
}

export const UNKNOWN_KEY_HINT = '(ignored; misspelled, renamed or removed? `buracle config get` prints the valid keys)'

type TextRead = { kind: 'missing' } | { kind: 'ok', text: string } | { kind: 'error', error: string }
type YamlRead = { kind: 'missing' } | { kind: 'ok', value: unknown } | { kind: 'error', error: string }

function readText(path: string): TextRead {
  try {
    return { kind: 'ok', text: readFileSync(path, 'utf8') }
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'error', error: `${path}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function parseText(path: string, read: TextRead): YamlRead {
  if (read.kind !== 'ok') return read
  try {
    return { kind: 'ok', value: parseYaml(read.text) }
  } catch (e) {
    return { kind: 'error', error: `${path}: invalid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }
  }
}

let codeKey: string | undefined

/** Identifies the merged configuration: both files' text plus this build's defaults and key renames. */
function inputsStamp(canonical: string, user: string | undefined): string {
  codeKey ??= JSON.stringify([defaultConfig(), CONFIG_RENAMES])
  return new Bun.CryptoHasher('sha256').update(JSON.stringify([canonical, user ?? null, codeKey])).digest('hex')
}

/**
 * The merged configuration `buracle` recorded in runtime-config.json for exactly these inputs, so a hook
 * event neither imports `yaml` nor parses the two files. Undefined when the snapshot is missing, unreadable,
 * written for other inputs (a stale snapshot: an edited file, another build's defaults) or no longer valid.
 */
function snapshotConfig(stamp: string): BuracleConfig | undefined {
  try {
    const snap = JSON.parse(readFileSync(paths.runtimeConfigFile(), 'utf8')) as Partial<RuntimeConfigSnapshot> | null
    if (snap === null || typeof snap !== 'object' || snap.v !== 1 || snap.stamp !== stamp) return undefined
    return mergeConfig(defaultConfig(), snap.config)
  } catch {
    return undefined
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
  const canonText = readText(canonicalPath)
  const userText = readText(userPath)
  const files = { canonical: canonicalPath, user: userPath, userExists: userText.kind !== 'missing' }

  const stampable = opts.userConfigPath === undefined && opts.renames === undefined && canonText.kind === 'ok' && userText.kind !== 'error'
  const stamp = stampable ? inputsStamp(canonText.text, userText.kind === 'ok' ? userText.text : undefined) : undefined
  if (stamp !== undefined) {
    const cached = snapshotConfig(stamp)
    if (cached !== undefined) return { config: cached, errors, warnings, files, stamp }
  }

  let base = defaultConfig()
  const canon = parseText(canonicalPath, canonText)
  if (canon.kind === 'missing') errors.push(`${canonicalPath}: not found; using built-in defaults`)
  else if (canon.kind === 'error') errors.push(canon.error)
  else base = mergeLayer(base, canon.value, canonicalPath, errors, warnings, [])

  let config = base
  const user = parseText(userPath, userText)
  if (user.kind === 'error') errors.push(user.error)
  else if (user.kind === 'ok') config = mergeLayer(base, user.value, userPath, errors, warnings, opts.renames ?? CONFIG_RENAMES)
  const loaded: LoadedConfig = { config, errors, warnings, files }
  if (stamp !== undefined && errors.length === 0 && warnings.length === 0) loaded.stamp = stamp
  return loaded
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
  /** `LoadedConfig.stamp` of the load this snapshot was written from; absent when that load had problems. */
  stamp?: string
}

export function bunExecutable(): string {
  return Bun.which('bun') ?? process.execPath
}

export function runtimeConfigSnapshot(config: BuracleConfig, stamp?: string): RuntimeConfigSnapshot {
  const snap: RuntimeConfigSnapshot = {
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
  if (stamp !== undefined) snap.stamp = stamp
  return snap
}

/** Passing the `LoadedConfig` (not just its config) records the stamp that lets hooks reuse the snapshot. */
export async function writeRuntimeConfig(source: BuracleConfig | LoadedConfig, path: string = paths.runtimeConfigFile()): Promise<string> {
  const snap = 'files' in source ? runtimeConfigSnapshot(source.config, source.stamp) : runtimeConfigSnapshot(source)
  await atomicWrite(path, JSON.stringify(snap, null, 2) + '\n')
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
    const fresh = runtimeConfigSnapshot(loaded.config, loaded.stamp)
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
        if (loaded.stamp !== undefined) next.stamp = loaded.stamp
      }
    } catch {  }
    atomicWriteSync(snap, JSON.stringify(next, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

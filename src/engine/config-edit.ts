import { join } from 'node:path'
import type { BuracleConfig } from '../core/config'
import { defaultConfig, mergeConfigLenient } from '../core/config'
import { loadConfigSync, writeRuntimeConfig } from './config'
import { atomicWriteSync, readTextSync } from './fsx'
import { parseKeyPath, yamlParse, yamlSet, type KeyPath } from './merge'
import * as paths from './paths'
import { opsDeps } from './update/deps'
import { errText, tilde } from './update/output'
import { setYamlValue } from './update/yaml-edit'

export function canonicalBase(repoRoot: string): BuracleConfig {
  const t = readTextSync(join(repoRoot, 'canonical', 'buracle.yaml'))
  if (!t.ok) return defaultConfig()
  try { return mergeConfigLenient(defaultConfig(), yamlParse(t.value)).config } catch { return defaultConfig() }
}

function newProblems(repoRoot: string, before: string, after: string): string[] {
  const base = canonicalBase(repoRoot)
  const parse = (t: string): unknown => (t.trim() === '' ? {} : yamlParse(t))
  const errs = (t: string): string[] => mergeConfigLenient(base, parse(t)).errors
  let old: string[] = []
  try { old = errs(before) } catch { old = [] }
  const now = errs(after)
  return now.filter(e => !old.includes(e))
}

export async function setConfigValue(key: string, value: unknown): Promise<{ ok: true, changed: boolean } | { ok: false, error: string }> {
  const repoRoot = opsDeps.repoRoot()
  let path: KeyPath
  try { path = parseKeyPath(key) } catch (e) { return { ok: false, error: errText(e) } }
  const file = paths.userConfigFile()
  const cur = readTextSync(file)
  if (!cur.ok && cur.code !== 'missing') return { ok: false, error: cur.error }
  const before = cur.ok ? cur.value : ''
  let after: string
  try {
    if (before.trim() !== '') yamlParse(before)
    after = value === undefined ? yamlSet(before, path, undefined) : setYamlValue(before, path, value)
  } catch (e) {
    return { ok: false, error: `${tilde(file)} cannot be edited: ${errText(e)}` }
  }
  if (after === before) return { ok: true, changed: false }
  const problems = newProblems(repoRoot, before, after)
  if (problems.length > 0) return { ok: false, error: `invalid value: ${problems.join('; ')}` }
  atomicWriteSync(file, after)
  try { await writeRuntimeConfig(loadConfigSync({ repoRoot }).config) } catch {  }
  return { ok: true, changed: true }
}

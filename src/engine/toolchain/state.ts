import { atomicWriteSync, readJsonSafeSync } from '../fsx'
import * as paths from '../paths'

export type PackageRegistry = 'npm' | 'pypi'

export interface InstalledPackage {
  registry: PackageRegistry
  name: string
  version: string
  dir: string
  bins: Record<string, string>
  extras?: string[]
  python?: string
  links?: string[]
  previous?: { version: string }
  rolled_back?: string
  installed_at: string
}

export interface InstalledSystemTool {
  via: 'brew' | 'winget' | 'scoop' | 'go' | 'dotnet' | 'npm' | 'uv' | 'github'
  version?: string
  path?: string
  installed_at: string
}

export interface ToolchainState {
  v: 1
  updated_at: string
  packages: Record<string, InstalledPackage>
  system: Record<string, InstalledSystemTool>
}

export function packageKey(registry: PackageRegistry, name: string): string {
  return `${registry}:${name}`
}

export function emptyToolchainState(): ToolchainState {
  return { v: 1, updated_at: '', packages: {}, system: {} }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function validPackage(x: unknown): x is InstalledPackage {
  if (!isRecord(x)) return false
  return (x['registry'] === 'npm' || x['registry'] === 'pypi') && typeof x['name'] === 'string' && typeof x['version'] === 'string'
    && typeof x['dir'] === 'string' && isRecord(x['bins']) && Object.values(x['bins']).every(v => typeof v === 'string')
}

export function readToolchainState(): ToolchainState {
  const r = readJsonSafeSync<unknown>(paths.toolchainStateFile())
  if (!r.ok || !isRecord(r.value)) return emptyToolchainState()
  const out = emptyToolchainState()
  if (typeof r.value['updated_at'] === 'string') out.updated_at = r.value['updated_at']
  if (isRecord(r.value['packages'])) {
    for (const [k, p] of Object.entries(r.value['packages'])) if (validPackage(p)) out.packages[k] = p
  }
  if (isRecord(r.value['system'])) {
    for (const [k, s] of Object.entries(r.value['system'])) {
      if (isRecord(s) && typeof s['via'] === 'string' && typeof s['installed_at'] === 'string') out.system[k] = s as unknown as InstalledSystemTool
    }
  }
  return out
}

export function writeToolchainState(s: ToolchainState, nowIso: string): void {
  const sorted = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k] as T]))
  const out: ToolchainState = { v: 1, updated_at: nowIso, packages: sorted(s.packages), system: sorted(s.system) }
  atomicWriteSync(paths.toolchainStateFile(), JSON.stringify(out, null, 2) + '\n')
}

export function updateToolchainState(change: (s: ToolchainState) => void, nowIso: string): ToolchainState {
  const s = readToolchainState()
  change(s)
  writeToolchainState(s, nowIso)
  return s
}

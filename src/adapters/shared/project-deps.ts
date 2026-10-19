import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseManifestDeps } from '../../core/policy/code-facts'

const ROOT_MANIFESTS = ['package.json', 'pyproject.toml', 'Pipfile', 'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile'] as const
const REQUIREMENTS = /^(?:requirements|constraints)[\w.-]*\.(?:txt|in)$/i
export const WORKSPACE_MEMBERS_MAX = 32
export const PROJECT_DEPS_MAX = 400
const CACHE_MAX = 16
const READ_MAX_BYTES = 1024 * 1024

interface CacheEntry { sig: string, deps: string[] }
const cache = new Map<string, CacheEntry>()

function stamp(path: string): string | undefined {
  try {
    const st = statSync(path)
    return st.isFile() ? `${st.size}:${Math.trunc(st.mtimeMs)}` : undefined
  } catch {
    return undefined
  }
}

function readSmall(path: string): string | undefined {
  try {
    if (statSync(path).size > READ_MAX_BYTES) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function workspacePatterns(root: string, pkgText: string | undefined): string[] {
  const out: string[] = []
  if (pkgText !== undefined) {
    try {
      const j: unknown = JSON.parse(pkgText)
      const ws = isObj(j) ? j['workspaces'] : undefined
      const list = Array.isArray(ws) ? ws : isObj(ws) && Array.isArray(ws['packages']) ? ws['packages'] : []
      for (const p of list) if (typeof p === 'string') out.push(p)
    } catch {  }
  }
  const pnpm = readSmall(join(root, 'pnpm-workspace.yaml'))
  if (pnpm !== undefined) {
    let inPackages = false
    for (const raw of pnpm.split('\n')) {
      const line = raw.replace(/\s+#.*$/, '')
      if (/^packages\s*:/.test(line)) { inPackages = true; continue }
      if (inPackages) {
        const item = /^\s+-\s+['"]?([^'"]+?)['"]?\s*$/.exec(line)
        if (item?.[1] !== undefined) out.push(item[1])
        else if (/^\S/.test(line)) inPackages = false
      }
    }
  }
  return out
}

function memberDirs(root: string, patterns: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const raw of patterns) {
    const p = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '')
    if (p === '' || p.startsWith('!') || p.startsWith('/') || p.split('/').includes('..')) continue
    if (p.endsWith('/*') && !/[*?[{]/.test(p.slice(0, -2))) {
      const base = join(root, p.slice(0, -2))
      let names: string[] = []
      try { names = readdirSync(base).sort() } catch { continue }
      for (const n of names) if (!n.startsWith('.') && n !== 'node_modules') dirs.add(join(base, n))
    } else if (!/[*?[{]/.test(p)) {
      dirs.add(join(root, p))
    }
  }
  return [...dirs].sort()
}

export function projectDeps(root: string): string[] {
  if (typeof root !== 'string' || root.trim() === '') return []
  const dir = resolve(root)
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const files = [
    ...ROOT_MANIFESTS.filter(n => names.includes(n)),
    ...names.filter(n => REQUIREMENTS.test(n)).sort(),
  ]
  const pkgText = files.includes('package.json') ? readSmall(join(dir, 'package.json')) : undefined
  const members = pkgText !== undefined || names.includes('pnpm-workspace.yaml')
    ? memberDirs(dir, workspacePatterns(dir, pkgText)).map(m => join(m, 'package.json')).filter(p => stamp(p) !== undefined).slice(0, WORKSPACE_MEMBERS_MAX)
    : []
  const paths = [...files.map(n => join(dir, n)), ...members]
  const sig = [...paths.map(p => `${p}=${stamp(p) ?? ''}`), names.includes('pnpm-workspace.yaml') ? `pnpm=${stamp(join(dir, 'pnpm-workspace.yaml')) ?? ''}` : ''].join('\n')
  const hit = cache.get(dir)
  if (hit !== undefined && hit.sig === sig) return [...hit.deps]
  const deps = new Set<string>()
  for (const p of paths) {
    const text = p === join(dir, 'package.json') ? pkgText : readSmall(p)
    if (text === undefined) continue
    for (const d of parseManifestDeps(p, text)) deps.add(d)
  }
  const out = [...deps].sort().slice(0, PROJECT_DEPS_MAX)
  cache.delete(dir)
  cache.set(dir, { sig, deps: out })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return [...out]
}

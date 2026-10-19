import { isRootPath, isWindowsPath } from '../events'
import { indexExclusion, pathKey } from '../workspace'

export interface MemProjectRecord {
  slug: string
  scope: 'project' | 'adhoc'
  ownerRepo?: string
  remote?: string
  commonDir?: string
  roots: string[]
  parents?: string[]
  merged?: string[]
  checkedMs?: number
  updated?: string
}

export interface MemProjectsCache { v: 1; projects: Record<string, MemProjectRecord> }

export function memEmptyProjects(): MemProjectsCache {
  return { v: 1, projects: {} }
}

export function memIsProjectsCache(x: unknown): x is MemProjectsCache {
  if (x === null || typeof x !== 'object') return false
  const c = x as Record<string, unknown>
  return c['v'] === 1 && c['projects'] !== null && typeof c['projects'] === 'object' && !Array.isArray(c['projects'])
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

// Windows paths compare in one slash form and in any case, as the file system does; POSIX paths as written.
function key(p: string): string {
  return isWindowsPath(p) ? pathKey(p, true) : trimSlash(p)
}

function same(a: string, b: string): boolean {
  return key(a) === key(b)
}

function inside(dir: string, root: string): boolean {
  const d = key(dir)
  const r = key(root)
  return d === r || d.startsWith(r.endsWith('/') ? r : r + '/')
}

export function memLookupProject(cache: MemProjectsCache | undefined, cwd: string): MemProjectRecord | undefined {
  if (!cache) return undefined
  let best: MemProjectRecord | undefined
  let bestLen = -1
  for (const rec of Object.values(cache.projects)) {
    if (rec === null || typeof rec !== 'object' || !Array.isArray(rec.roots)) continue
    for (const root of rec.roots) {
      if (typeof root !== 'string' || root === '') continue
      const hit = rec.scope === 'adhoc' ? same(cwd, root) : inside(cwd, root)
      if (hit && root.length > bestLen) { best = rec; bestLen = root.length }
    }
    for (const parent of Array.isArray(rec.parents) ? rec.parents : []) {
      if (typeof parent !== 'string' || parent === '') continue
      if (same(cwd, parent) && parent.length > bestLen) { best = rec; bestLen = parent.length }
    }
  }
  return best
}

export interface MemHygieneEnv {
  home: string
  vault?: string
  buracleHome?: string
  claudeDir?: string
  tempRoots: readonly string[]
}

export function memNonProjectReason(dir: string, env: MemHygieneEnv): string | undefined {
  const d = trimSlash(dir)
  if (d === '' || isRootPath(d)) return 'the filesystem root'
  if (same(d, env.home)) return 'your home folder'
  if (env.vault !== undefined && env.vault !== '' && inside(d, env.vault)) return 'inside the memory vault'
  if (env.buracleHome !== undefined && env.buracleHome !== '' && inside(d, env.buracleHome)) return "inside Buracle's state folder"
  if (env.claudeDir !== undefined && env.claudeDir !== '' && inside(d, `${trimSlash(env.claudeDir)}/jobs`)) return 'a Claude Code job folder'
  if (d.split(isWindowsPath(d) ? /[\\/]/ : '/').some(seg => seg.toLowerCase() === 'scratchpad')) return 'a scratchpad folder'
  const temp = env.tempRoots.filter(r => r !== '' && !isRootPath(r))
  const homeIsTemp = temp.some(r => inside(trimSlash(env.home), r))
  if (!homeIsTemp && temp.some(r => inside(d, r))) return 'a temporary folder'
  return undefined
}

export interface MemExcludeTarget { dirs: readonly string[], ownerRepo?: string }
export interface MemExcludeEnv { home: string, caseInsensitive: boolean }

const OWNER_REPO = /^[\w*?-][\w.*?-]*\/[\w.*?-]+$/

function ownerRepoMatches(pattern: string, ownerRepo: string): boolean {
  if (!OWNER_REPO.test(pattern)) return false
  const body = pattern.replace(/[.+^$()|[\]\\{}]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp('^' + body + '$', 'i').test(ownerRepo)
}

export function memExclusion(target: MemExcludeTarget, patterns: readonly string[], env: MemExcludeEnv): string | undefined {
  for (const raw of patterns) {
    const pattern = raw.trim()
    if (pattern === '') continue
    if (target.ownerRepo !== undefined && ownerRepoMatches(pattern, target.ownerRepo)) return `excluded by memory.exclude (${pattern})`
    const ctx = { home: env.home, buracleHome: '', vault: '', exclude: [pattern], caseInsensitive: env.caseInsensitive }
    if (target.dirs.some(d => d !== '' && indexExclusion(d, ctx)?.startsWith('excluded by') === true)) return `excluded by memory.exclude (${pattern})`
  }
  return undefined
}

export function memExcludeConfigProblem(errors: readonly string[], userFile: string): string | undefined {
  for (const e of errors) {
    if (!e.startsWith(`${userFile}: `)) continue
    const rest = e.slice(userFile.length + 2)
    const key = /^([a-z][\w-]*)(?:[.[]|: )/.exec(rest)
    if (key === null || key[1] === 'memory') return rest
  }
  return undefined
}

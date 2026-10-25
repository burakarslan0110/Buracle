import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { memIsSlug } from '../core/memory/note'
import {
  memEmptyProjects, memExcludeConfigProblem, memExclusion, memIsProjectsCache, memLookupProject, type MemProjectRecord, type MemProjectsCache,
} from '../core/memory/project'
import { slugify } from '../core/memory/text'
import { loadConfigSync } from '../engine/config'
import { atomicWriteSync, comparablePath, readJsonSafeSync, sha256 } from '../engine/fsx'
import { projectIdentity, remoteUrl, revParse, toplevel } from '../engine/git'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { nonProjectReason } from '../workflow/non-project'
import { canonicalDir, caseInsensitivePaths, excludedRoot } from '../workflow/workspace'
import { projectsFile } from './layout'
import { tryLock } from './lock'

export { nonProjectReason, tempRoots } from '../workflow/non-project'

export function oldVaultDir(): string {
  return join(paths.home(), 'Documents', 'Buracle')
}

export interface ProjectRecord extends MemProjectRecord {}
export interface ProjectsCache extends MemProjectsCache { projects: Record<string, ProjectRecord> }

export function tzOffset(ms = Date.now()): number {
  return -new Date(ms).getTimezoneOffset()
}

export function isoNow(ms = Date.now()): string {
  return new Date(ms).toISOString()
}

export function readProjectsCache(): ProjectsCache {
  const r = readJsonSafeSync<unknown>(projectsFile())
  if (r.ok && memIsProjectsCache(r.value)) return r.value
  if (!r.ok && r.code !== 'missing') log('warn', 'memory: projects cache unreadable; starting empty', { error: r.error })
  return memEmptyProjects()
}

function writeProjectsCache(cache: ProjectsCache): void {
  atomicWriteSync(projectsFile(), JSON.stringify(cache, null, 2) + '\n')
}

function updateProjectsCache(fn: (c: ProjectsCache) => void): ProjectsCache {
  const lock = `${projectsFile()}.lock`
  const deadline = Date.now() + 1000
  let release = tryLock(lock, 10_000)
  while (!release && Date.now() < deadline) { Bun.sleepSync(10); release = tryLock(lock, 10_000) }
  try {
    const cache = readProjectsCache()
    fn(cache)
    writeProjectsCache(cache)
    return cache
  } finally {
    release?.()
  }
}

export function repoDisplay(remote: string): string {
  let s = remote.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const scp = /^[^/@:]+@([^/:]+):(.+)$/.exec(s)
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return `${scp[1]}/${scp[2]}`
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(s)
  if (url) return `${url[1]}${url[2] ?? ''}`
  s = s.replace(/^file:\/\//, '')
  return s
}

export function isNonProjectDir(dir: string): boolean {
  return nonProjectReason(dir) !== undefined
}

function sameIdentity(rec: ProjectRecord, id: { commonDir?: string, ownerRepo?: string, root: string }): boolean {
  if (rec.commonDir !== undefined && id.commonDir !== undefined && rec.commonDir === id.commonDir) return true
  if (rec.ownerRepo !== undefined && id.ownerRepo !== undefined && rec.ownerRepo.toLowerCase() === id.ownerRepo.toLowerCase()) return true
  return rec.roots.includes(id.root)
}

const NOT_CHILDREN = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'tmp', 'temp'])
const MAX_CONTAINER_DIRS = 64
const CHILD_RECHECK_MS = 10 * 60_000

function indexExcludePatterns(): readonly string[] {
  try { return loadConfigSync().config.index.exclude } catch { return [] }
}

export function childRepos(dir: string): string[] {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !NOT_CHILDREN.has(e.name))
  if (dirs.length > MAX_CONTAINER_DIRS) return []
  const repos = dirs.map(e => join(dir, e.name)).filter(p => existsSync(join(p, '.git')))
  if (repos.length === 0) return []
  const exclude = indexExcludePatterns()
  return repos.filter(p => exclude.length === 0 || !excludedRoot(p, oldVaultDir(), exclude)).sort()
}

async function mapToChild(abs: string, child: string): Promise<ProjectRecord | undefined> {
  const rec = await resolveProject(child)
  if (!rec || rec.scope !== 'project') return undefined
  let mapped: ProjectRecord | undefined
  updateProjectsCache(cache => {
    const r = cache.projects[rec.slug]
    if (!r) return
    r.parents = [...new Set([...(r.parents ?? []), abs])].sort()
    for (const other of Object.values(cache.projects)) {
      if (other.scope !== 'adhoc' || !other.roots.includes(abs)) continue
      other.roots = other.roots.filter(x => x !== abs)
      if (other.slug !== r.slug) r.merged = [...new Set([...(r.merged ?? []), other.slug])].sort()
    }
    mapped = r
  })
  return mapped
}

export function forgetProject(slug: string): boolean {
  if (!memIsSlug(slug)) return false
  let had = false
  updateProjectsCache(cache => {
    had = cache.projects[slug] !== undefined
    delete cache.projects[slug]
    for (const r of Object.values(cache.projects)) {
      if (r.merged === undefined) continue
      r.merged = r.merged.filter(m => m !== slug)
      if (r.merged.length === 0) delete r.merged
    }
  })
  return had
}

export interface MemoryExcludeConfig { patterns: readonly string[], problem?: string }

let warnedExclude: string | undefined

function lastGoodExclude(): string[] {
  const r = readJsonSafeSync<unknown>(paths.runtimeConfigFile())
  const config = r.ok && r.value !== null && typeof r.value === 'object' ? (r.value as { config?: { memory?: { exclude?: unknown } } }).config : undefined
  const list = config?.memory?.exclude
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : []
}

export function memoryExcludeConfig(): MemoryExcludeConfig {
  let patterns: readonly string[] = []
  let problem: string | undefined
  try {
    const loaded = loadConfigSync()
    patterns = loaded.config.memory.exclude
    problem = memExcludeConfigProblem(loaded.errors, paths.userConfigFile())
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e)
  }
  if (problem === undefined) return { patterns }
  const kept = [...new Set([...patterns, ...lastGoodExclude()])]
  if (warnedExclude !== problem) {
    warnedExclude = problem
    log('warn', 'memory: memory.exclude may be unreadable; the last good list is used as well', { problem, patterns: kept.length })
  }
  return { patterns: kept, problem }
}

export function memoryExcludePatterns(): readonly string[] {
  return memoryExcludeConfig().patterns
}

export function memoryExcludeProblemText(problem: string): string {
  return `memory.exclude may be unreadable (${paths.userConfigFile()}: ${problem}); the projects of the last good list stay out until the file reads cleanly`
}

function existingDir(cwd: string): string {
  let abs = resolve(cwd)
  while (!existsSync(abs) && dirname(abs) !== abs) abs = dirname(abs)
  return comparablePath(abs)
}

function excludeEnv(): { home: string, caseInsensitive: boolean } {
  return { home: canonicalDir(paths.home()), caseInsensitive: caseInsensitivePaths() }
}

async function exclusionOf(abs: string, patterns: readonly string[], nested = false): Promise<string | undefined> {
  if (patterns.length === 0) return undefined
  const env = excludeEnv()
  const hit = memLookupProject(readProjectsCache(), abs)
  const known = memExclusion({ dirs: [...new Set([abs, canonicalDir(abs), ...(hit?.roots ?? [])])], ...(hit?.ownerRepo !== undefined ? { ownerRepo: hit.ownerRepo } : {}) }, patterns, env)
  if (known !== undefined) return known
  if (hit === undefined) {
    const id = await projectIdentity(abs)
    const top = id.commonDir !== undefined ? (await toplevel(abs)) ?? id.root : abs
    const main = id.commonDir !== undefined && basename(id.commonDir) === '.git' ? [dirname(id.commonDir)] : []
    const own = memExclusion({ dirs: [id.root, top, ...main], ...(id.ownerRepo !== undefined ? { ownerRepo: id.ownerRepo } : {}) }, patterns, env)
    if (own !== undefined || id.commonDir !== undefined) return own
  } else if (hit.scope !== 'adhoc') return undefined
  return nested ? undefined : onlyChildExclusion(abs, patterns)
}

async function onlyChildExclusion(abs: string, patterns: readonly string[]): Promise<string | undefined> {
  const children = childRepos(abs)
  if (children.length !== 1) return undefined
  const child = children[0] as string
  const why = await exclusionOf(child, patterns, true)
  return why === undefined ? undefined : `${why} for ${basename(child)}, the one repository in this folder`
}

export async function projectExclusion(cwd: string, patterns: readonly string[] = memoryExcludePatterns()): Promise<string | undefined> {
  if (patterns.length === 0) return undefined
  const abs = existingDir(cwd)
  if (isNonProjectDir(abs)) return undefined
  return exclusionOf(abs, patterns)
}

export async function slugExclusion(slug: string, patterns: readonly string[] = memoryExcludePatterns()): Promise<string | undefined> {
  if (patterns.length === 0 || !memIsSlug(slug)) return undefined
  const rec = readProjectsCache().projects[slug]
  if (rec === undefined) return undefined
  const main = rec.commonDir !== undefined && basename(rec.commonDir) === '.git' ? [dirname(rec.commonDir)] : []
  const direct = memExclusion({ dirs: [...rec.roots, ...main], ...(rec.ownerRepo !== undefined ? { ownerRepo: rec.ownerRepo } : {}) }, patterns, excludeEnv())
  if (direct !== undefined || rec.scope !== 'adhoc') return direct
  for (const root of rec.roots) {
    const why = existsSync(root) ? await onlyChildExclusion(root, patterns) : undefined
    if (why !== undefined) return why
  }
  return undefined
}

export async function resolveProject(cwd: string): Promise<ProjectRecord | undefined> {
  const abs = existingDir(cwd)
  if (isNonProjectDir(abs)) return undefined
  if ((await exclusionOf(abs, memoryExcludePatterns())) !== undefined) return undefined
  const now = Date.now()
  const hit = memLookupProject(readProjectsCache(), abs)
  if (hit && !(hit.scope === 'adhoc' && hit.roots.includes(abs) && now - (hit.checkedMs ?? 0) > CHILD_RECHECK_MS)) return hit
  if (hit) {
    const children = childRepos(abs)
    if (children.length === 1) {
      const mapped = await mapToChild(abs, children[0] as string)
      if (mapped) return mapped
    }
    updateProjectsCache(cache => { const r = cache.projects[hit.slug]; if (r) r.checkedMs = now })
    if (children.length > 1) await registerChildren(children)
    return hit
  }
  const id = await projectIdentity(abs)
  if (id.commonDir === undefined) {
    const children = childRepos(abs)
    if (children.length === 1) {
      const mapped = await mapToChild(abs, children[0] as string)
      if (mapped) return mapped
    }
    if (children.length > 1) await registerChildren(children)
  }
  const top = id.commonDir !== undefined ? (await toplevel(abs)) ?? id.root : abs
  const roots = [...new Set([id.root, top])]
  const scope: 'project' | 'adhoc' = id.commonDir !== undefined ? 'project' : 'adhoc'
  const remote = id.remote !== undefined ? repoDisplay(id.remote) : undefined
  let chosen: ProjectRecord | undefined
  updateProjectsCache(cache => {
    const existing = Object.values(cache.projects).find(r => sameIdentity(r, { ...(id.commonDir !== undefined ? { commonDir: id.commonDir } : {}), ...(id.ownerRepo !== undefined ? { ownerRepo: id.ownerRepo } : {}), root: id.root }))
    if (existing) {
      for (const r of roots) if (!existing.roots.includes(r)) existing.roots.push(r)
      existing.updated = isoNow()
      if (scope === 'adhoc') existing.checkedMs = now
      chosen = existing
      return
    }
    const taken = (slug: string): boolean => cache.projects[slug] !== undefined
    let slug = id.slug
    if (taken(slug) && id.ownerRepo !== undefined) slug = slugify(id.ownerRepo.replace('/', '-'))
    if (taken(slug)) slug = `${slug.slice(0, 52)}-${sha256(id.commonDir ?? abs).slice(0, 6)}`
    const rec: ProjectRecord = { slug, scope, roots, updated: isoNow() }
    if (id.ownerRepo !== undefined) rec.ownerRepo = id.ownerRepo
    if (remote !== undefined) rec.remote = remote
    if (id.commonDir !== undefined) rec.commonDir = id.commonDir
    if (scope === 'adhoc') rec.checkedMs = now
    cache.projects[slug] = rec
    chosen = rec
  })
  return chosen
}

async function registerChildren(children: readonly string[]): Promise<void> {
  const cache = readProjectsCache()
  for (const c of children.slice(0, 8)) {
    if (memLookupProject(cache, c) !== undefined) continue
    try { await resolveProject(c) } catch (e) { log('warn', 'memory: cannot register a child project', { dir: c, error: e }) }
  }
}

export async function projectSlugFor(cwd: string): Promise<string | undefined> {
  return (await resolveProject(cwd))?.slug
}

export function projectRoot(slug: string): string | undefined {
  if (!memIsSlug(slug)) return undefined
  const rec = readProjectsCache().projects[slug]
  return rec?.roots.find(r => existsSync(r))
}

export async function gitProvenance(cwd: string): Promise<{ repo?: string, branch?: string, commit?: string }> {
  const out: { repo?: string, branch?: string, commit?: string } = {}
  const [branch, commit, remote] = await Promise.all([
    revParse(cwd, '--abbrev-ref', 'HEAD'),
    revParse(cwd, '--short', 'HEAD'),
    remoteUrl(cwd),
  ])
  if (branch !== undefined && branch !== '' && branch !== 'HEAD') out.branch = branch
  if (commit !== undefined && /^[0-9a-f]{4,40}$/.test(commit)) out.commit = commit
  if (remote !== undefined) out.repo = repoDisplay(remote)
  return out
}

export function displayName(dir: string): string {
  return basename(resolve(dir))
}

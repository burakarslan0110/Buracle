import { isWindowsPath, normalizePath, type Harness } from './events'
import { protectGlobToRegExp } from './policy/write-guard'

export function pathKey(p: string, caseInsensitive: boolean): string {
  const out = normalizePath(isWindowsPath(p) ? p : p.replace(/\\/g, '/'))
  return caseInsensitive ? out.toLowerCase() : out
}

function isRootKey(k: string): boolean {
  return k === '/' || /^[A-Za-z]:\/?$/.test(k) || /^\\\\[^\\/]+(?:\\[^\\/]+)?$/.test(k)
}

function withinKey(child: string, parent: string): boolean {
  if (parent === '/') return child.startsWith('/')
  const p = parent.endsWith('/') ? parent.slice(0, -1) : parent
  return child === p || child.startsWith(`${p}/`)
}

export function isPathWithin(child: string, parent: string, caseInsensitive: boolean): boolean {
  return withinKey(pathKey(child, caseInsensitive), pathKey(parent, caseInsensitive))
}

export interface IndexExclusionContext {
  home: string
  buracleHome: string
  vault: string
  exclude: readonly string[]
  caseInsensitive: boolean
}

const GLOB_CHARS = /[*?[{]/

function excludeMatches(pattern: string, dirKey: string, ctx: IndexExclusionContext): boolean {
  let p = pattern.replace(/\\/g, '/')
  if (p === '~' || p.startsWith('~/')) p = ctx.home.replace(/\\/g, '/').replace(/\/+$/, '') + p.slice(1)
  const absolute = p.startsWith('/') || /^[A-Za-z]:\//.test(p)
  if (absolute && !GLOB_CHARS.test(p)) return withinKey(dirKey, pathKey(p, ctx.caseInsensitive))
  const body = p.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
  const glob = absolute ? body : `**/${body.replace(/^(?:\.\/)+/, '')}`
  const self = protectGlobToRegExp(glob)
  const inside = protectGlobToRegExp(`${glob}/**`)
  return self?.test(dirKey) === true || inside?.test(dirKey) === true
}

export function indexExclusion(dir: string, ctx: IndexExclusionContext): string | undefined {
  const ci = ctx.caseInsensitive
  const d = pathKey(dir, ci)
  if (isRootKey(d)) return 'the filesystem root'
  if (ctx.home.trim() !== '') {
    const h = pathKey(ctx.home, ci)
    if (!isRootKey(h)) {
      if (d === h) return 'your home folder'
      if (withinKey(h, d)) return 'a parent of your home folder'
    }
  }
  if (ctx.vault.trim() !== '' && withinKey(d, pathKey(ctx.vault, ci))) return 'inside the memory vault'
  if (ctx.buracleHome.trim() !== '' && withinKey(d, pathKey(ctx.buracleHome, ci))) return "inside Buracle's state folder"
  for (const raw of ctx.exclude) {
    const pattern = raw.trim()
    if (pattern !== '' && excludeMatches(pattern, d, ctx)) return `excluded by index.exclude (${pattern})`
  }
  return undefined
}

export type IndexState =
  | { state: 'ready', at?: number, error?: string }
  | { state: 'building', since?: number }
  | { state: 'failed', at: number, error: string, retryAt: number }
  | { state: 'none' }
  | { state: 'off' }

export interface ProjectIndex { codegraph: IndexState; semble: IndexState }

export interface IndexToolFacts {
  enabled: boolean
  record?: { at: number, ok: boolean, error?: string, failures?: number }
  building?: { since?: number }
  present?: boolean
}

const CORRUPT_INDEX = /database disk image is malformed|file is not a database|database is corrupt|is not a sqlite database|sqlite_corrupt|sqlite_notadb/i

export function isCorruptIndexError(text: string): boolean {
  return typeof text === 'string' && CORRUPT_INDEX.test(text)
}

export const INDEX_RETRY_MIN: readonly number[] = [5, 15, 60, 240, 1440]

export function indexRetryDelayMs(failures: number, minIntervalMin: number): number {
  const n = Number.isFinite(failures) ? Math.max(1, Math.floor(failures)) : 1
  const step = INDEX_RETRY_MIN[Math.min(n, INDEX_RETRY_MIN.length) - 1] ?? 1440
  return Math.max(step, Math.max(0, minIntervalMin)) * 60_000
}

export function indexToolDue(record: IndexToolFacts['record'], enabled: boolean, minIntervalMin: number, nowMs: number): boolean {
  if (!enabled) return false
  if (record === undefined || nowMs < record.at) return true
  const wait = record.ok ? Math.max(0, minIntervalMin) * 60_000 : indexRetryDelayMs(record.failures ?? 1, minIntervalMin)
  return nowMs - record.at >= wait
}

export function indexState(f: IndexToolFacts, minIntervalMin: number): IndexState {
  if (!f.enabled) return { state: 'off' }
  const r = f.record
  const usable = r?.ok === true || f.present === true
  if (f.building !== undefined && !usable) return f.building.since !== undefined ? { state: 'building', since: f.building.since } : { state: 'building' }
  if (r !== undefined && r.ok) return { state: 'ready', at: r.at }
  if (r !== undefined) {
    const error = r.error !== undefined && r.error.trim() !== '' ? r.error : 'failed'
    if (f.present === true) return { state: 'ready', error }
    return { state: 'failed', at: r.at, error, retryAt: r.at + indexRetryDelayMs(r.failures ?? 1, minIntervalMin) }
  }
  return f.present === true ? { state: 'ready' } : { state: 'none' }
}

const HEALTH_ORDER = ['failed', 'none', 'building', 'ready'] as const

export function indexHealth(pi: ProjectIndex): 'failed' | 'none' | 'building' | 'ready' | 'off' {
  const live = [pi.codegraph, pi.semble].filter(s => s.state !== 'off').map(s => s.state)
  if (live.length === 0) return 'off'
  return HEALTH_ORDER.find(s => live.includes(s)) ?? 'ready'
}

function ago(ms: number): string {
  if (ms < 60_000) return '<1m'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

export function describeIndexState(s: IndexState, nowMs: number): string {
  switch (s.state) {
    case 'ready': {
      const when = s.at !== undefined ? ` (refreshed ${ago(Math.max(0, nowMs - s.at))} ago)` : ''
      return s.error !== undefined ? `ready${when}, but the last refresh failed: ${s.error}` : `ready${when}`
    }
    case 'building': return s.since !== undefined ? `building (for ${ago(Math.max(0, nowMs - s.since))})` : 'building'
    case 'failed': return `failed: ${s.error} (${s.retryAt > nowMs ? `next try in ${ago(s.retryAt - nowMs)}` : 'retried at the next session start'})`
    case 'none': return 'not built yet'
    case 'off': return 'off'
  }
}

export interface WorkspaceInfo {
  cwd: string
  root?: string
  children: string[]
  excluded?: string
  index: ProjectIndex
  childIndex?: Record<string, ProjectIndex>
}

function code(s: string): string {
  return '`' + s.replace(/`/g, "'") + '`'
}

function stateWord(s: IndexState): string {
  switch (s.state) {
    case 'ready': return s.error !== undefined ? 'ready (its last refresh failed)' : 'ready'
    case 'building': return 'building now'
    case 'failed': return `failed to build (${s.error.length > 120 ? `${s.error.slice(0, 117)}...` : s.error})`
    case 'none': return 'not built yet'
    case 'off': return 'off'
  }
}

function baseName(p: string): string {
  const k = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return k.slice(k.lastIndexOf('/') + 1) || k
}

const PASS = `as codegraph ${code('projectPath')} and semble ${code('repo')}`
const OWNS = `Indexing is Buracle's job, not the user's decision: if codegraph says a project is not indexed, run ${code('buracle index ensure --cwd <project>')} (or wait for the background run) and call it again; never stop using codegraph for the session.`

function rootGuidance(root: string, cg: IndexState): string | undefined {
  switch (cg.state) {
    case 'off': return undefined
    case 'ready': return OWNS
    case 'building': return `Until codegraph is ready, use semble and rg and call codegraph again later; indexing is Buracle's job, not the user's decision, so never stop using codegraph for the session.`
    case 'none':
    case 'failed': return `Run ${code(`buracle index ensure --cwd ${root}`)} to build codegraph's index (Buracle's job, not the user's decision); until it is ready, use semble and rg, then call codegraph again. Never stop using codegraph for the session.`
  }
}

export function workspaceContext(info: WorkspaceInfo, harness: Harness): string {
  void harness
  const codegraphOn = info.index.codegraph.state !== 'off'
  const lines: string[] = []
  if (info.root !== undefined) {
    const { codegraph, semble } = info.index
    lines.push(`Project root: ${info.root}. Pass it ${PASS} (not a subfolder, a parent folder or your home folder).`)
    lines.push(`Code indexes: codegraph ${stateWord(codegraph)}, semble ${stateWord(semble)} (Buracle builds and refreshes them in the background).`)
    const g = rootGuidance(info.root, codegraph)
    if (g !== undefined) lines.push(g)
    return lines.join('\n')
  }
  if (info.children.length > 0) {
    const names = info.children.map(baseName)
    const n = names.length
    const sep = info.cwd.includes('\\') && !info.cwd.includes('/') ? '\\' : '/'
    lines.push(`${info.cwd} is not a project; it holds ${n === 1 ? 'one project' : `${n} projects`}: ${names.join(', ')}. Pass ${n === 1 ? 'it' : 'the one you work in'} (${info.cwd.replace(/[\\/]+$/, '')}${sep}<name>) ${PASS}, never this folder or your home folder.`)
    const states = info.children.flatMap(c => {
      const pi = info.childIndex?.[c]
      return pi === undefined ? [] : [`${baseName(c)}: codegraph ${stateWord(pi.codegraph)}, semble ${stateWord(pi.semble)}`]
    })
    if (states.length > 0) lines.push(`Code indexes (Buracle builds and refreshes them in the background): ${states.join('; ')}.`)
    if (codegraphOn || info.childIndex === undefined) lines.push(OWNS)
    return lines.join('\n')
  }
  if (info.excluded !== undefined) {
    const byConfig = info.excluded.startsWith('excluded by index.exclude')
    lines.push(`${info.cwd} is ${info.excluded}: Buracle does not index it. Pass the project folder you work in ${PASS}, never this folder${byConfig ? ' or anything inside it' : ''}.`)
  } else {
    lines.push(`${info.cwd} is not a project (no git repository or project manifest), so Buracle indexes nothing here. Pass the project folder you work in ${PASS}, never a parent folder or your home folder.`)
  }
  if (codegraphOn) lines.push(OWNS)
  return lines.join('\n')
}

export function workspaceNotice(prev: WorkspaceInfo | undefined, next: WorkspaceInfo): string | undefined {
  if (prev === undefined) return undefined
  const ready: string[] = []
  const failed: Array<{ root: string, error: string }> = []
  const compare = (root: string, a: IndexState | undefined, b: IndexState | undefined) => {
    if (a === undefined || b === undefined) return
    if (b.state === 'ready' && (a.state === 'building' || a.state === 'none' || a.state === 'failed')) ready.push(root)
    else if (b.state === 'failed' && a.state === 'building') failed.push({ root, error: b.error })
  }
  if (next.root !== undefined && prev.root === next.root) compare(next.root, prev.index.codegraph, next.index.codegraph)
  for (const c of next.children) compare(c, prev.childIndex?.[c]?.codegraph, next.childIndex?.[c]?.codegraph)
  const out: string[] = []
  if (ready.length === 1) out.push(`The codegraph index of ${ready[0]} is ready now: call codegraph with ${code('projectPath')} ${ready[0]}.`)
  else if (ready.length > 1) out.push(`The codegraph indexes of ${ready.join(', ')} are ready now: call codegraph with the project as ${code('projectPath')}.`)
  for (const f of failed) out.push(`Building the codegraph index of ${f.root} failed (${f.error}); use semble and rg, or run ${code(`buracle index ensure --cwd ${f.root}`)} to retry.`)
  return out.length > 0 ? out.join('\n') : undefined
}

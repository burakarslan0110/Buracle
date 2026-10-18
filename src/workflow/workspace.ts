import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, type Dirent } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { BuracleConfig } from '../core/config'
import {
  indexExclusion, indexState, indexToolDue, isPathWithin, pathKey,
  type IndexExclusionContext, type ProjectIndex, type WorkspaceInfo,
} from '../core/workspace'
import { readJsonSafeSync, sha256 } from '../engine/fsx'
import { revParse } from '../engine/git'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { osName, spawnArgv } from '../engine/platform'

const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile', 'go.mod', 'go.work', 'Cargo.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.sbt', 'composer.json', 'Gemfile',
  'deno.json', 'deno.jsonc', 'CMakeLists.txt', 'Makefile', 'mix.exs', 'pubspec.yaml', 'Package.swift', 'stack.yaml',
  'tsconfig.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel',
]
const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'go.work', 'settings.gradle', 'settings.gradle.kts', 'lerna.json', 'nx.json', 'turbo.json', 'WORKSPACE', 'WORKSPACE.bazel', 'MODULE.bazel']
const MARKER_SUFFIXES = ['.sln', '.csproj', '.fsproj', '.xcodeproj', '.xcworkspace']
const CHILD_SCAN_MAX = 256

export const INDEX_ENV: Readonly<Record<string, string>> = {
  CODEGRAPH_TELEMETRY: '0',
  CODEGRAPH_NO_UPDATE_CHECK: '1',
  HF_HUB_DISABLE_TELEMETRY: '1',
}

export const INDEX_LOCK_STALE_MS = 2 * 60 * 60_000

export function caseInsensitivePaths(): boolean {
  return osName() !== 'linux'
}

export function canonicalDir(dir: string): string {
  const abs = resolve(dir)
  try { return realpathSync.native(abs) } catch { return abs }
}

export function exclusionContext(vault: string, exclude: readonly string[]): IndexExclusionContext {
  return {
    home: canonicalDir(paths.home()),
    buracleHome: canonicalDir(paths.buracleHome()),
    vault: canonicalDir(vault),
    exclude,
    caseInsensitive: caseInsensitivePaths(),
  }
}

export function excludedReason(dir: string, vault: string, exclude: readonly string[] = []): string | undefined {
  return indexExclusion(canonicalDir(dir), exclusionContext(vault, exclude))
}

export function excludedRoot(dir: string, vault: string, exclude: readonly string[] = []): boolean {
  return excludedReason(dir, vault, exclude) !== undefined
}

function markerEntries(dir: string): { files: ReadonlySet<string>, names: readonly string[] } | undefined {
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return undefined }
  const files = new Set<string>()
  for (const e of entries) {
    if (e.isFile()) files.add(e.name)
    else if (e.isSymbolicLink()) {
      try { if (statSync(join(dir, e.name)).isFile()) files.add(e.name) } catch {  }
    }
  }
  return { files, names: entries.map(e => e.name) }
}

function hasMarker(dir: string): boolean {
  const e = markerEntries(dir)
  if (e === undefined) return false
  return PROJECT_MARKERS.some(m => e.files.has(m)) || e.names.some(n => MARKER_SUFFIXES.some(s => n.endsWith(s)))
}

function hasWorkspaceMarker(dir: string): boolean {
  const e = markerEntries(dir)
  return e !== undefined && WORKSPACE_MARKERS.some(m => e.files.has(m))
}

function markerRoot(dir: string, ctx: IndexExclusionContext): string | undefined {
  const ci = ctx.caseInsensitive
  let found: string | undefined
  let cur = dir
  for (let depth = 0; depth < 64; depth++) {
    const k = pathKey(cur, ci)
    if (k === '/' || /^[A-Za-z]:\/?$/.test(k) || isPathWithin(ctx.home, cur, ci)) break
    if (found === undefined) {
      if (hasMarker(cur)) found = cur
    } else if (hasWorkspaceMarker(cur)) {
      found = cur
    }
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return found
}

function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, '.git')) || hasMarker(dir)
}

function activity(dir: string, mtimeMs: number): number {
  let t = mtimeMs
  for (const f of ['.git', join('.git', 'index'), join('.git', 'HEAD')]) {
    try { t = Math.max(t, statSync(join(dir, f)).mtimeMs) } catch {  }
  }
  return t
}

function childProjects(dir: string, ctx: IndexExclusionContext, max: number): string[] {
  let names: string[]
  try { names = readdirSync(dir).sort() } catch { return [] }
  if (names.length > CHILD_SCAN_MAX) return []
  const found = new Map<string, number>()
  for (const name of names) {
    if (name.startsWith('.') || name === 'node_modules') continue
    const p = join(dir, name)
    let mtimeMs: number
    try {
      const st = statSync(p)
      if (!st.isDirectory()) continue
      mtimeMs = st.mtimeMs
    } catch { continue }
    const real = canonicalDir(p)
    if (indexExclusion(real, ctx) !== undefined) continue
    if (!isProjectDir(p)) return []
    if (!found.has(real)) found.set(real, activity(p, mtimeMs))
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.max(0, max))
    .map(([p]) => p)
    .sort()
}

async function gitTopLevel(dir: string): Promise<string | undefined> {
  const top = await revParse(dir, '--show-toplevel').catch(() => undefined)
  return top !== undefined && top.trim() !== '' ? canonicalDir(top.trim()) : undefined
}

export interface WorkspaceTarget { cwd: string; root?: string; children: string[]; excluded?: string }

export interface WorkspaceOptions { vault: string; exclude: readonly string[]; children: boolean; maxChildren: number }

export function workspaceOptions(cfg: BuracleConfig): WorkspaceOptions {
  return { vault: paths.oldVaultRoot(), exclude: cfg.index.exclude, children: cfg.index.children, maxChildren: cfg.index.maxChildren }
}

export async function resolveWorkspace(cwd: string, o: WorkspaceOptions): Promise<WorkspaceTarget> {
  const dir = canonicalDir(cwd)
  const ctx = exclusionContext(o.vault, o.exclude)
  const here = indexExclusion(dir, ctx)
  if (here !== undefined) return { cwd: dir, children: [], excluded: here }
  let root = await gitTopLevel(dir)
  if (root !== undefined) {
    const broad = indexExclusion(root, { ...ctx, exclude: [] })
    if (broad === 'your home folder' || broad === 'a parent of your home folder' || broad === 'the filesystem root') root = undefined
  }
  root ??= markerRoot(dir, ctx)
  if (root !== undefined) {
    const why = indexExclusion(root, ctx)
    return why !== undefined ? { cwd: dir, children: [], excluded: why } : { cwd: dir, root, children: [] }
  }
  if (!o.children || o.maxChildren <= 0) return { cwd: dir, children: [] }
  return { cwd: dir, children: childProjects(dir, ctx, o.maxChildren) }
}

export async function projectRootFor(cwd: string, vault: string, exclude: readonly string[] = []): Promise<string | undefined> {
  return (await resolveWorkspace(cwd, { vault, exclude, children: false, maxChildren: 0 })).root
}

export interface IndexToolRecord {
  at: number
  ok: boolean
  ms?: number
  error?: string
  mode?: 'init' | 'sync' | 'warm' | 'rebuild'
  failures?: number
  note?: string
}
export interface IndexRecord { v: 1; root: string; codegraph?: IndexToolRecord; semble?: IndexToolRecord }

export function indexTag(root: string): string {
  return sha256(canonicalDir(root)).slice(0, 16)
}

export function indexRecordFile(root: string): string {
  return join(paths.indexStateDir(), `${indexTag(root)}.json`)
}

export const CORRUPT_KEEP_MS = 14 * 86_400_000

export function corruptDir(): string {
  return join(paths.indexStateDir(), 'corrupt')
}

export function pruneCorruptCopies(nowMs: number, keepTag?: string): string[] {
  const dir = corruptDir()
  let names: string[]
  try { names = readdirSync(dir).sort() } catch { return [] }
  const copies = names.flatMap(n => {
    const m = /^([0-9a-f]{16})-(\d+)$/.exec(n)
    return m !== null ? [{ n, tag: m[1] as string, at: Number(m[2]) }] : []
  })
  const own = copies.filter(c => c.tag === keepTag)
  const newest = own.length > 0 ? own.reduce((a, b) => (b.at > a.at ? b : a)).n : undefined
  const removed: string[] = []
  for (const { n, tag, at } of copies) {
    if (n === newest) continue
    if (tag !== keepTag && nowMs - at < CORRUPT_KEEP_MS) continue
    try {
      rmSync(join(dir, n), { recursive: true, force: true })
      removed.push(join(dir, n))
    } catch { continue }
  }
  return removed
}

export function indexLockFile(root: string): string {
  return `${indexRecordFile(root)}.lock`
}

export function readIndexRecord(root: string): IndexRecord | undefined {
  const r = readJsonSafeSync<IndexRecord>(indexRecordFile(root))
  return r.ok && r.value?.v === 1 ? r.value : undefined
}

export function pruneIndexStates(nowMs: number): string[] {
  const dir = paths.indexStateDir()
  const removed: string[] = []
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return removed }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const file = join(dir, n)
    const r = readJsonSafeSync<{ root?: unknown }>(file)
    const root = r.ok && r.value !== null && typeof r.value === 'object' ? r.value.root : undefined
    if (typeof root !== 'string' || !isAbsolute(root) || existsSync(root)) continue
    if (indexLockHolder(root, nowMs) !== undefined) continue
    try {
      unlinkSync(file)
      removed.push(file)
    } catch { continue }
    try { unlinkSync(`${file}.lock`) } catch {  }
  }
  removed.push(...pruneCorruptCopies(nowMs))
  return removed
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

export function indexLockHolder(root: string, nowMs: number): { pid: number, at: number } | undefined {
  let held: unknown
  try { held = JSON.parse(readFileSync(indexLockFile(root), 'utf8')) } catch { return undefined }
  if (held === null || typeof held !== 'object') return undefined
  const { pid, at } = held as { pid?: unknown, at?: unknown }
  if (typeof pid !== 'number' || typeof at !== 'number' || nowMs - at > INDEX_LOCK_STALE_MS) return undefined
  return pidAlive(pid) ? { pid, at } : undefined
}

let wslCache: boolean | undefined
function isWsl(env: Readonly<Record<string, string | undefined>>): boolean {
  if (osName() !== 'linux') return false
  if ((env['WSL_DISTRO_NAME'] ?? '') !== '' || (env['WSL_INTEROP'] ?? '') !== '') return true
  if (wslCache === undefined) {
    try {
      const v = readFileSync('/proc/version', 'utf8').toLowerCase()
      wslCache = v.includes('microsoft') || v.includes('wsl')
    } catch { wslCache = false }
  }
  return wslCache
}

export function codegraphDataDir(root: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = (env['CODEGRAPH_DIR'] ?? '').trim()
  if (raw !== '' && raw !== '.' && !raw.includes('..') && !/[\\/]/.test(raw) && !isAbsolute(raw)) return raw
  if (isWsl(env) && /^\/mnt\/[a-z](?:\/|$)/i.test(root)) {
    try { if (statSync(join(root, '.codegraph-wsl')).isDirectory()) return '.codegraph-wsl' } catch {  }
    return existsSync(join(root, '.codegraph', 'codegraph.db')) ? '.codegraph' : '.codegraph-wsl'
  }
  return '.codegraph'
}

export function codegraphIndexPresent(root: string): boolean {
  return existsSync(join(root, codegraphDataDir(root), 'codegraph.db'))
}

export function indexDue(root: string, cfg: BuracleConfig['index'], nowMs: number): boolean {
  const rec = readIndexRecord(root)
  return indexToolDue(rec?.codegraph, cfg.codegraph, cfg.minIntervalMin, nowMs) || indexToolDue(rec?.semble, cfg.semble, cfg.minIntervalMin, nowMs)
}

export function projectIndex(root: string, cfg: BuracleConfig['index'], nowMs: number, building = false): ProjectIndex {
  const rec = readIndexRecord(root)
  const lock = building ? { pid: process.pid, at: nowMs } : indexLockHolder(root, nowMs)
  const run = lock !== undefined ? { since: lock.at } : undefined
  const tool = (enabled: boolean, record: IndexToolRecord | undefined, present: boolean | undefined) =>
    indexState({ enabled, ...(record !== undefined ? { record } : {}), ...(run !== undefined ? { building: run } : {}), ...(present !== undefined ? { present } : {}) }, cfg.minIntervalMin)
  return {
    codegraph: tool(cfg.codegraph, rec?.codegraph, cfg.codegraph ? codegraphIndexPresent(root) : undefined),
    semble: tool(cfg.semble, rec?.semble, undefined),
  }
}

export function indexSummary(root: string, cfg: BuracleConfig['index'], nowMs: number): ProjectIndex {
  return projectIndex(canonicalDir(root), cfg, nowMs)
}

function idleIndex(cfg: BuracleConfig['index']): ProjectIndex {
  return { codegraph: cfg.codegraph ? { state: 'none' } : { state: 'off' }, semble: cfg.semble ? { state: 'none' } : { state: 'off' } }
}

export function infoFor(target: WorkspaceTarget, cfg: BuracleConfig, nowMs: number, building: readonly string[] = []): WorkspaceInfo {
  const info: WorkspaceInfo = {
    cwd: target.cwd,
    children: [...target.children],
    index: target.root !== undefined ? projectIndex(target.root, cfg.index, nowMs, building.includes(target.root)) : idleIndex(cfg.index),
  }
  if (target.root !== undefined) info.root = target.root
  if (target.excluded !== undefined) info.excluded = target.excluded
  if (target.children.length > 0) {
    const childIndex: Record<string, ProjectIndex> = {}
    for (const c of target.children) childIndex[c] = projectIndex(c, cfg.index, nowMs, building.includes(c))
    info.childIndex = childIndex
  }
  return info
}

export async function workspaceInfo(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<WorkspaceInfo> {
  return infoFor(await resolveWorkspace(cwd, workspaceOptions(cfg)), cfg, nowMs)
}

export function refreshWorkspaceInfo(info: WorkspaceInfo, cfg: BuracleConfig, nowMs: number): WorkspaceInfo {
  const target: WorkspaceTarget = { cwd: info.cwd, children: info.children }
  if (info.root !== undefined) target.root = info.root
  if (info.excluded !== undefined) target.excluded = info.excluded
  return infoFor(target, cfg, nowMs)
}

export type IndexSpawner = (argv: string[], cwd: string) => void

const spawnDetached: IndexSpawner = (argv, cwd) => {
  const child = Bun.spawn(spawnArgv(argv), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, cwd, env: { ...process.env } })
  child.unref()
}

export function startIndexRun(target: WorkspaceTarget, cfg: BuracleConfig, nowMs: number, argv: string[] | undefined, spawn: IndexSpawner = spawnDetached): string[] {
  if (argv === undefined || (!cfg.index.codegraph && !cfg.index.semble)) return []
  const roots = target.root !== undefined ? [target.root] : target.children
  const due = roots.filter(r => indexDue(r, cfg.index, nowMs) && indexLockHolder(r, nowMs) === undefined)
  if (due.length === 0) return []
  pruneIndexStates(nowMs)
  const at = target.root ?? target.cwd
  try {
    spawn([...argv, 'index', 'ensure', '--cwd', at, '--if-due', '--quiet'], at)
  } catch (e) {
    log('warn', 'index: could not start the background run', { at, error: e })
    return []
  }
  return due
}

export async function spawnIndexIfDue(cwd: string, cfg: BuracleConfig, nowMs: number, argv: string[] | undefined, spawn?: IndexSpawner): Promise<string | undefined> {
  try {
    if (!cfg.index.auto || process.env['BURACLE_NO_AUTOSTART'] === '1' || argv === undefined) return undefined
    if (!cfg.index.codegraph && !cfg.index.semble) return undefined
    const target = await resolveWorkspace(cwd, workspaceOptions(cfg))
    return startIndexRun(target, cfg, nowMs, argv, spawn).length > 0 ? target.root ?? target.cwd : undefined
  } catch (e) {
    log('warn', 'index: could not start the background run', { error: e })
    return undefined
  }
}

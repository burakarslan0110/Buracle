import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { BuracleConfig } from '../core/config'
import { describeIndexState, indexHealth, indexToolDue, isCorruptIndexError, type IndexState, type ProjectIndex } from '../core/workspace'
import { loadConfigSync } from '../engine/config'
import { atomicWriteSync } from '../engine/fsx'
import { revParse } from '../engine/git'
import { breakStaleLock, lockSnapshot, lockToken, releaseLockFile } from '../engine/lockfile'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { findExecutable, spawnArgv } from '../engine/platform'
import { run, type RunResult } from '../engine/proc'
import { binArgv } from '../engine/toolchain/packages'
import { packageKey, readToolchainState } from '../engine/toolchain/state'
import { buracleArgv } from '../usage/bar-info'
import { git, updateExclude } from './gitx'
import {
  codegraphDataDir, codegraphIndexPresent, corruptDir, INDEX_ENV, INDEX_LOCK_STALE_MS, indexLockFile, indexLockHolder,
  indexRecordFile, indexTag, pidAlive, projectRootFor, pruneCorruptCopies, readIndexRecord, spawnIndexIfDue, startIndexRun, workspaceInfo,
  type IndexRecord, type IndexSpawner, type IndexToolRecord, type WorkspaceTarget,
} from './workspace'

function takeLock(root: string, nowMs: number): (() => void) | undefined {
  const file = indexLockFile(root)
  mkdirSync(paths.indexStateDir(), { recursive: true })
  for (let i = 0; i < 3; i++) {
    const text = JSON.stringify({ pid: process.pid, at: nowMs, token: lockToken() })
    try {
      const fd = openSync(file, 'wx', 0o600)
      try { writeSync(fd, text) } finally { closeSync(fd) }
      let released = false
      return () => {
        if (released) return
        released = true
        releaseLockFile(file, text)
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') return undefined
    }
    const seen = lockSnapshot(file)
    if (seen === undefined) continue
    let stale: boolean
    try {
      const held = JSON.parse(seen.text) as { pid?: number, at?: number }
      const alive = typeof held.pid === 'number' && pidAlive(held.pid)
      stale = !alive || typeof held.at !== 'number' || nowMs - held.at > INDEX_LOCK_STALE_MS
    } catch { stale = nowMs - seen.mtimeMs > INDEX_LOCK_STALE_MS }
    if (!stale || breakStaleLock(file, seen) !== 'broken') return undefined
  }
  return undefined
}

export function toolArgv(registry: 'npm' | 'pypi', name: string, bin: string): string[] | undefined {
  const pkg = readToolchainState().packages[packageKey(registry, name)]
  const entry = pkg?.bins[bin]
  if (entry !== undefined) {
    const a = binArgv(entry)
    if (a !== undefined) return a
  }
  const p = findExecutable(bin)
  return p !== undefined ? [p] : undefined
}

export interface CodegraphWriter { pid: number; mode: string }

export function codegraphLiveWriter(root: string): CodegraphWriter | undefined {
  let j: unknown
  try { j = JSON.parse(readFileSync(join(root, codegraphDataDir(root), 'writer.pid'), 'utf8')) } catch { return undefined }
  if (j === null || typeof j !== 'object') return undefined
  const { pid, mode } = j as { pid?: unknown, mode?: unknown }
  if (typeof pid !== 'number' || pid <= 0 || pid === process.pid || !pidAlive(pid)) return undefined
  return { pid, mode: typeof mode === 'string' ? mode : 'unknown' }
}

type Runner = (argv: string[], opts: { cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal }) => Promise<RunResult>

export interface EnsureOptions {
  codegraph: boolean
  semble: boolean
  force?: boolean
  timeoutMs?: number
  runner?: Runner
  liveWriter?: (root: string) => CodegraphWriter | undefined
  signal?: AbortSignal
}
export interface EnsureResult { root: string; skipped?: string; codegraph?: IndexToolRecord; semble?: IndexToolRecord }

function errLine(r: RunResult): string {
  return `${r.stderr || r.stdout}`.trim().split('\n').slice(-2).join(' / ').slice(0, 300) || `exit ${r.code}${r.timedOut ? ' (timed out)' : ''}`
}

function lastJson(text: string): Record<string, unknown> | undefined {
  const lines = text.trim().split('\n').reverse()
  for (const l of lines) {
    if (!l.trim().startsWith('{')) continue
    try {
      const v = JSON.parse(l) as unknown
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
    } catch {  }
  }
  return undefined
}

interface ToolRun {
  exec: (args: string[], timeoutMs?: number) => Promise<RunResult>
  nowMs: () => number
  prev?: IndexToolRecord
  live: (root: string) => CodegraphWriter | undefined
}

const STATUS_TIMEOUT_MS = 2 * 60_000

function okRecord(t0: number, o: ToolRun, mode: IndexToolRecord['mode'], note?: string): IndexToolRecord {
  const at = o.nowMs()
  return { at, ok: true, ms: at - t0, ...(mode !== undefined ? { mode } : {}), ...(note !== undefined ? { note } : {}) }
}

function failRecord(t0: number, o: ToolRun, mode: IndexToolRecord['mode'], error: string): IndexToolRecord {
  const at = o.nowMs()
  const failures = (o.prev !== undefined && !o.prev.ok ? o.prev.failures ?? 1 : 0) + 1
  return { at, ok: false, ms: at - t0, ...(mode !== undefined ? { mode } : {}), error, failures }
}

async function codegraphHealth(root: string, o: ToolRun): Promise<{ note?: string, error?: string, corrupt?: boolean }> {
  const st = await o.exec(['status', '--json', root], STATUS_TIMEOUT_MS)
  if (st.code !== 0 && isCorruptIndexError(`${st.stderr}\n${st.stdout}`)) return { corrupt: true, error: `the codegraph index is corrupt: ${errLine(st)}` }
  const j = st.code === 0 ? lastJson(st.stdout) : undefined
  const idx = j !== undefined && j['index'] !== null && typeof j['index'] === 'object' ? j['index'] as Record<string, unknown> : undefined
  if (idx === undefined) return {}
  const notes: string[] = []
  const pending = typeof idx['pendingRefs'] === 'number' ? idx['pendingRefs'] : 0
  if (pending > 0 && o.live(root) === undefined) {
    const r = await o.exec(['sync', '-q', root])
    notes.push(r.code === 0 ? `resolved ${pending} pending references` : `${pending} references still pending (${errLine(r)})`)
  }
  const truncated = idx['state'] === 'indexing'
  const stale = idx['reindexRecommended'] === true
  if ((truncated || stale) && o.live(root) === undefined) {
    const r = await o.exec(['index', '-q', root])
    const why = truncated ? 'an interrupted run left it truncated' : 'codegraph recommends a rebuild'
    if (r.code !== 0) return { error: `rebuild (${why}) failed: ${errLine(r)}` }
    notes.push(`rebuilt: ${why}`)
  }
  return notes.length > 0 ? { note: notes.join('; ') } : {}
}

const SQLITE_MAGIC = 'SQLite format 3\u0000'

function foreignDb(file: string): boolean {
  let fd: number
  try { fd = openSync(file, 'r') } catch { return false }
  try {
    const head = Buffer.alloc(SQLITE_MAGIC.length)
    const n = readSync(fd, head, 0, head.length, 0)
    return n > 0 && head.subarray(0, n).toString('latin1') !== SQLITE_MAGIC.slice(0, n)
  } catch { return false } finally { closeSync(fd) }
}

async function brokenIndex(root: string, failed: RunResult, o: ToolRun): Promise<string | undefined> {
  if (failed.timedOut || failed.aborted === true) return undefined
  if (isCorruptIndexError(`${failed.stderr}\n${failed.stdout}`)) return 'corrupt'
  if (foreignDb(join(root, codegraphDataDir(root), 'codegraph.db'))) return 'not a SQLite database'
  const st = await o.exec(['status', '--json', root], STATUS_TIMEOUT_MS)
  if (isCorruptIndexError(`${st.stderr}\n${st.stdout}`)) return 'corrupt'
  return st.code === 0 && lastJson(st.stdout)?.['initialized'] === false ? 'missing its schema' : undefined
}

function moveAside(root: string, nowMs: number): { path: string } | { error: string } {
  const from = join(root, codegraphDataDir(root))
  const tag = indexTag(root)
  const to = join(corruptDir(), `${tag}-${nowMs}`)
  try {
    mkdirSync(corruptDir(), { recursive: true })
    try {
      renameSync(from, to)
    } catch (e) {
      if ((e as { code?: string }).code !== 'EXDEV') throw e
      cpSync(from, to, { recursive: true })
      rmSync(from, { recursive: true, force: true })
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  pruneCorruptCopies(nowMs, tag)
  return { path: to }
}

async function recoverIndex(root: string, why: string, force: boolean, t0: number, o: ToolRun): Promise<IndexToolRecord> {
  const writer = force ? undefined : o.live(root)
  if (writer !== undefined) {
    return failRecord(t0, o, 'rebuild', `the codegraph index is ${why}, but a codegraph server (pid ${writer.pid}) holds it: close the sessions using it, or run \`buracle index rebuild --force\``)
  }
  const moved = moveAside(root, o.nowMs())
  if ('error' in moved) return failRecord(t0, o, 'rebuild', `the codegraph index is ${why} and could not be moved aside: ${moved.error}`)
  const r = await o.exec(['init', '-y', root])
  if (r.code !== 0) return failRecord(t0, o, 'rebuild', `the codegraph index was ${why}; a new one failed to build: ${errLine(r)}`)
  await excludeLocally(root, `/${codegraphDataDir(root)}/`)
  const h = await codegraphHealth(root, o)
  if (h.error !== undefined) return failRecord(t0, o, 'rebuild', h.error)
  const note = `recovered an index that was ${why} (the old one is in ${moved.path})`
  return okRecord(t0, o, 'rebuild', h.note !== undefined ? `${note}; ${h.note}` : note)
}

async function ensureCodegraph(root: string, force: boolean, o: ToolRun): Promise<IndexToolRecord> {
  const t0 = o.nowMs()
  const dataDir = codegraphDataDir(root)
  const db = join(root, dataDir, 'codegraph.db')
  const present = existsSync(db)
  if (force && present) {
    const r = await o.exec(['index', '-q', root])
    if (r.code === 0) return okRecord(t0, o, 'rebuild')
    const why = await brokenIndex(root, r, o)
    return why !== undefined ? recoverIndex(root, why, true, t0, o) : failRecord(t0, o, 'rebuild', errLine(r))
  }
  if (!present) {
    const r = await o.exec(['init', '-y', root])
    if (r.code !== 0) return failRecord(t0, o, 'init', errLine(r))
    await excludeLocally(root, `/${dataDir}/`)
    const h = await codegraphHealth(root, o)
    return h.error !== undefined ? failRecord(t0, o, 'init', h.error) : okRecord(t0, o, 'init', h.note)
  }
  const writer = o.live(root)
  if (writer !== undefined) {
    if (foreignDb(db)) return recoverIndex(root, 'not a SQLite database', false, t0, o)
    const st = await o.exec(['status', '--json', root], STATUS_TIMEOUT_MS)
    if (st.code !== 0 && isCorruptIndexError(`${st.stderr}\n${st.stdout}`)) return recoverIndex(root, 'corrupt', false, t0, o)
    return okRecord(t0, o, 'sync', `skipped: a live codegraph server (pid ${writer.pid}) keeps the index fresh`)
  }
  const r = await o.exec(['sync', '-q', root])
  if (r.code !== 0) {
    const late = o.live(root)
    if (late !== undefined) return okRecord(t0, o, 'sync', `skipped: a codegraph server (pid ${late.pid}) took the index over`)
    const why = await brokenIndex(root, r, o)
    return why !== undefined ? recoverIndex(root, why, false, t0, o) : failRecord(t0, o, 'sync', errLine(r))
  }
  await excludeLocally(root, `/${dataDir}/`)
  const h = await codegraphHealth(root, o)
  if (h.corrupt === true) return recoverIndex(root, 'corrupt', false, t0, o)
  return h.error !== undefined ? failRecord(t0, o, 'sync', h.error) : okRecord(t0, o, 'sync', h.note)
}

async function warmSemble(root: string, o: ToolRun): Promise<IndexToolRecord> {
  const t0 = o.nowMs()
  const base = ['search', 'buracle warm-up', root, '-k', '1', '--max-snippet-lines', '0']
  const codeRun = await o.exec(base)
  if (codeRun.code !== 0) return failRecord(t0, o, 'warm', errLine(codeRun))
  const allRun = await o.exec([...base, '--content', 'all'])
  if (allRun.code !== 0) return failRecord(t0, o, 'warm', `all content: ${errLine(allRun)}`)
  return okRecord(t0, o, 'warm')
}

export async function ensureIndexes(root: string, opts: EnsureOptions, nowMs: () => number = Date.now): Promise<EnsureResult> {
  const release = takeLock(root, nowMs())
  if (release === undefined) return { root, skipped: 'another Buracle process is indexing this project' }
  const exec: Runner = opts.runner ?? ((argv, o) => run(spawnArgv(argv), { ...o, processGroup: true }))
  const env = { ...INDEX_ENV }
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000
  const live = opts.liveWriter ?? codegraphLiveWriter
  const out: EnsureResult = { root }
  try {
    const prev = readIndexRecord(root)
    const signal = opts.signal
    const stopped = () => signal?.aborted === true
    const toolRun = (argv0: string[] | undefined, prevRec: IndexToolRecord | undefined): ToolRun => ({
      exec: async (args, ms) => stopped()
        ? { code: 130, stdout: '', stderr: 'interrupted', timedOut: false, aborted: true }
        : exec([...(argv0 ?? []), ...args], { cwd: root, env, timeoutMs: ms ?? timeoutMs, ...(signal !== undefined ? { signal } : {}) }),
      nowMs,
      live,
      ...(prevRec !== undefined ? { prev: prevRec } : {}),
    })
    if (opts.codegraph) {
      const cg = toolArgv('npm', '@colbymchenry/codegraph', 'codegraph')
      const o = toolRun(cg, prev?.codegraph)
      out.codegraph = cg === undefined ? failRecord(nowMs(), o, undefined, 'codegraph is not installed (buracle install)') : await ensureCodegraph(root, opts.force === true, o)
      if (stopped()) delete out.codegraph
    }
    if (opts.semble && !stopped()) {
      const sb = toolArgv('pypi', 'semble', 'semble')
      const o = toolRun(sb, prev?.semble)
      out.semble = sb === undefined ? failRecord(nowMs(), o, undefined, 'semble is not installed (buracle install)') : await warmSemble(root, o)
      if (stopped()) delete out.semble
    }
    if (stopped()) out.skipped = 'interrupted'
    const rec: IndexRecord = { v: 1, root }
    const cg = out.codegraph ?? prev?.codegraph
    const sb = out.semble ?? prev?.semble
    if (cg !== undefined) rec.codegraph = cg
    if (sb !== undefined) rec.semble = sb
    try { atomicWriteSync(indexRecordFile(root), JSON.stringify(rec, null, 2) + '\n') } catch (e) { log('warn', 'index: cannot write the record', { error: e }) }
    return out
  } finally {
    release()
  }
}

export async function ensureWorkspace(target: WorkspaceTarget, cfg: BuracleConfig, o: { ifDue?: boolean, force?: boolean, runner?: Runner, liveWriter?: (root: string) => CodegraphWriter | undefined, nowMs?: () => number, signal?: AbortSignal } = {}): Promise<EnsureResult[]> {
  const now = o.nowMs ?? Date.now
  const roots = target.root !== undefined ? [target.root] : target.children
  const out: EnsureResult[] = []
  for (const root of roots) {
    if (o.signal?.aborted === true) { out.push({ root, skipped: 'interrupted' }); continue }
    let codegraph = cfg.index.codegraph
    let semble = cfg.index.semble
    if (o.ifDue === true) {
      const rec = readIndexRecord(root)
      const t = now()
      codegraph &&= indexToolDue(rec?.codegraph, true, cfg.index.minIntervalMin, t)
      semble &&= indexToolDue(rec?.semble, true, cfg.index.minIntervalMin, t)
      if (!codegraph && !semble) { out.push({ root, skipped: 'not due' }); continue }
    }
    out.push(await ensureIndexes(root, {
      codegraph,
      semble,
      ...(o.force === true ? { force: true } : {}),
      ...(o.runner !== undefined ? { runner: o.runner } : {}),
      ...(o.liveWriter !== undefined ? { liveWriter: o.liveWriter } : {}),
      ...(o.signal !== undefined ? { signal: o.signal } : {}),
    }, now))
  }
  return out
}

export async function excludeLocally(root: string, pattern: string): Promise<boolean> {
  try {
    const common = await revParse(root, '--path-format=absolute', '--git-common-dir')
    if (common === undefined || common.trim() === '') return false
    const file = join(common.trim(), 'info', 'exclude')
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch {  }
    if (text.split(/\r?\n/).some(l => l.trim() === pattern)) return true
    mkdirSync(join(common.trim(), 'info'), { recursive: true })
    const add = `${text !== '' && !text.endsWith('\n') ? '\n' : ''}# Buracle: code index (codegraph)\n${pattern}\n`
    atomicWriteSync(file, text + add)
    return true
  } catch (e) {
    log('warn', 'index: could not add the local git exclude', { root, error: e })
    return false
  }
}

export interface StartGate {
  root?: string
  outcome: 'off' | 'no-project' | 'present' | 'idle' | 'ready' | 'failed' | 'timeout'
  waitedMs: number
}

export interface StartGateOptions {
  cfg?: BuracleConfig
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollMs?: number
  startGraceMs?: number
  argv?: string[] | undefined
  spawn?: IndexSpawner
}

export async function codegraphStartGate(cwd: string, o: StartGateOptions = {}): Promise<StartGate> {
  const now = o.nowMs ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(res => setTimeout(res, ms)))
  const t0 = now()
  try {
    const cfg = o.cfg ?? loadConfigSync().config
    if (!cfg.index.codegraph) return { outcome: 'off', waitedMs: 0 }
    const root = await projectRootFor(cwd, paths.oldVaultRoot(), cfg.index.exclude)
    if (root === undefined) return { outcome: 'no-project', waitedMs: 0 }
    if (codegraphIndexPresent(root)) return { root, outcome: 'present', waitedMs: 0 }
    let started = false
    if (cfg.index.auto && process.env['BURACLE_NO_AUTOSTART'] !== '1' && indexLockHolder(root, t0) === undefined) {
      const argv = 'argv' in o ? o.argv : buracleArgv()
      started = startIndexRun({ cwd: root, root, children: [] }, cfg, t0, argv, o.spawn).length > 0
    }
    if (!started && indexLockHolder(root, t0) === undefined) return { root, outcome: 'idle', waitedMs: 0 }
    const timeoutMs = o.timeoutMs ?? 4_000
    const pollMs = o.pollMs ?? 250
    const graceMs = o.startGraceMs ?? 3_000
    let sawLock = false
    for (;;) {
      const t = now()
      if (codegraphIndexPresent(root)) return { root, outcome: 'ready', waitedMs: t - t0 }
      const held = indexLockHolder(root, t) !== undefined
      if (held) sawLock = true
      if (!held && (sawLock || !started || t - t0 >= graceMs)) return { root, outcome: codegraphIndexPresent(root) ? 'ready' : 'failed', waitedMs: t - t0 }
      if (t - t0 >= timeoutMs) return { root, outcome: 'timeout', waitedMs: t - t0 }
      await sleep(pollMs)
    }
  } catch (e) {
    log('warn', 'index: the codegraph start gate failed', { cwd, error: e })
    return { outcome: 'idle', waitedMs: now() - t0 }
  }
}

export interface IndexCheck { level: 'ok' | 'info' | 'warn'; check: string; detail: string }

function levelOf(s: IndexState): IndexCheck['level'] {
  if (s.state === 'ready') return s.error !== undefined ? 'warn' : 'ok'
  if (s.state === 'building' || s.state === 'off') return 'info'
  return 'warn'
}

export async function indexChecks(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<IndexCheck[]> {
  const out: IndexCheck[] = []
  if (!cfg.index.auto) out.push({ level: 'info', check: 'index.auto', detail: 'off: no code index is built automatically (`buracle index ensure` builds them by hand)' })
  const info = await workspaceInfo(cwd, cfg, nowMs)
  const tools = (pi: ProjectIndex): Array<[string, IndexState]> => [['codegraph', pi.codegraph], ['semble', pi.semble]]
  if (info.root !== undefined) {
    const cg = readIndexRecord(info.root)?.codegraph
    const recovered = cg?.ok === true && cg.note !== undefined && cg.note.startsWith('recovered ') ? ` (${cg.note})` : ''
    for (const [tool, s] of tools(info.index)) out.push({ level: levelOf(s), check: `index.${tool}`, detail: `${info.root}: ${describeIndexState(s, nowMs)}${tool === 'codegraph' ? recovered : ''}` })
    return out
  }
  if (info.children.length > 0) {
    for (const c of info.children) {
      const pi = info.childIndex?.[c]
      if (pi === undefined) continue
      const health = indexHealth(pi)
      const level: IndexCheck['level'] = health === 'ready' ? (levelOf(pi.codegraph) === 'warn' || levelOf(pi.semble) === 'warn' ? 'warn' : 'ok') : health === 'building' || health === 'off' ? 'info' : 'warn'
      out.push({ level, check: `index.${basename(c)}`, detail: `${c}: codegraph ${describeIndexState(pi.codegraph, nowMs)}; semble ${describeIndexState(pi.semble, nowMs)}` })
    }
    return out
  }
  out.push({ level: 'info', check: 'index', detail: info.excluded !== undefined ? `${info.cwd} is ${info.excluded}: nothing is indexed here` : `${info.cwd} is not a project: nothing is indexed here` })
  return out
}

const SEMBLE_BLOCK_START = '# >>> buracle (managed by the buracle CLI; edit outside this block)'
const SEMBLE_BLOCK_END = '# <<< buracle'

export function updateSembleIgnore(root: string, entries: readonly string[]): { path: string, added: string[] } {
  const path = join(root, '.sembleignore')
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch {  }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  const norm = (l: string) => l.trim().replace(/^\//, '').replace(/\/$/, '')
  const present = new Set(lines.filter(l => !l.trim().startsWith('#')).map(norm))
  const added = entries.filter(e => !present.has(norm(e)))
  if (added.length === 0) return { path, added }
  const start = lines.indexOf(SEMBLE_BLOCK_START)
  const end = start >= 0 ? lines.indexOf(SEMBLE_BLOCK_END, start + 1) : -1
  let out: string[]
  if (start >= 0 && end > start) out = [...lines.slice(0, end), ...added, ...lines.slice(end)]
  else out = [...lines, ...(lines.length > 0 && lines[lines.length - 1] !== '' ? [''] : []), SEMBLE_BLOCK_START, ...added, SEMBLE_BLOCK_END]
  atomicWriteSync(path, out.join('\n') + '\n')
  return { path, added }
}

export interface SembleIgnoreResult { status: 'updated' | 'unchanged' | 'tracked' | 'outside' | 'error'; path?: string; entry?: string; error?: string }

export async function keepWorktreesOutOfSemble(mainRoot: string, commonDir: string, worktreeDir: string): Promise<SembleIgnoreResult> {
  const rel = relative(mainRoot, worktreeDir)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { status: 'outside' }
  const entry = `/${rel.split(sep).join('/')}/`
  const path = join(mainRoot, '.sembleignore')
  try {
    const tracked = (await git(mainRoot, ['ls-files', '--error-unmatch', '--', '.sembleignore'], { readOnly: true })).ok
    if (tracked) {
      let text = ''
      try { text = readFileSync(path, 'utf8') } catch {  }
      const has = text.split('\n').some(l => l.trim().replace(/^\//, '').replace(/\/$/, '') === entry.slice(1, -1))
      return { status: has ? 'unchanged' : 'tracked', path, entry }
    }
    const r = updateSembleIgnore(mainRoot, [entry])
    updateExclude(commonDir, ['/.sembleignore'])
    return { status: r.added.length > 0 ? 'updated' : 'unchanged', path, entry }
  } catch (e) {
    return { status: 'error', path, entry, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function indexNewWorktree(path: string, facts: { mainRoot: string, commonDir: string }, nowMs: number, o: { cfg?: BuracleConfig, argv?: string[] | undefined, spawn?: IndexSpawner } = {}): Promise<string[]> {
  const warnings: string[] = []
  const s = await keepWorktreesOutOfSemble(facts.mainRoot, facts.commonDir, dirname(path))
  if (s.status === 'tracked') warnings.push(`${s.path} is tracked by git: add the line ${s.entry} to it so semble does not index the worktree again with the main checkout`)
  if (s.status === 'error') warnings.push(`could not update ${s.path}: ${s.error}`)
  try {
    const cfg = o.cfg ?? loadConfigSync().config
    await spawnIndexIfDue(path, cfg, nowMs, 'argv' in o ? o.argv : buracleArgv(), o.spawn)
  } catch (e) {
    log('warn', 'index: could not start the worktree index run', { path, error: e })
  }
  return warnings
}

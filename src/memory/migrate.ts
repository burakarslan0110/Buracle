import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isLive, similarMemories, type MemItem, type MemLayer } from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { memClip, memOneLine, slugify } from '../core/memory/text'
import { readJsonSafeSync, renameRetrySync, sha256 } from '../engine/fsx'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { updateToolchainState, readToolchainState } from '../engine/toolchain/state'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { entriesOfLegacyRows, importEntries, stampsOfRows, type Entry, type RowStamp } from './bucket-io'
import { CortexError, closeCortex } from './cortex'
import { brainBackupsDir, brainDbFile, brainDir, legacyBrainDir, legacyStateDir, memStateDir, migrationFile, migrationLockFile, preMigrateDir } from './layout'
import { withBrainStopped } from './backup'
import { acquireLock } from './lock'
import {
  legacyPending, pendingLegacy, readMarker, writeMarker,
  type LegacyFile, type MigrationFileState, type MigrationMarker,
} from './migration-state'
import { snapshotFile, rowsOfCopy } from './snapshot'
import { bypassMigrationGate, bucketCounts, brainExists, forgetListCache, listAll, personRef, projectRef, rawRows, recordEvent, refKey, storedId, type BrainRef } from './store'

const FAIL_ENV = 'BURACLE_MIGRATE_FAIL_AFTER'
const WAIT_ENV = 'BURACLE_MIGRATE_WAIT_MS'
const DEFAULT_WAIT_MS = 5_000
const LOCK_STALE_MS = 60_000

/** State that only Buracle 0.5's background jobs wrote. It moves to state/memory/legacy-0.5/; nothing reads it any more. */
const OBSOLETE_STATE = ['upkeep', 'distinct', 'sweep.json', 'heal.json', 'reflect', 'verify', 'jobs.jsonl', 'profile', 'distill', 'scan']

export class MigrationError extends Error {
  readonly step: 'backup' | 'read' | 'import' | 'verify' | 'injected'
  constructor(step: MigrationError['step'], message: string, opts?: { cause?: unknown }) {
    super(message, opts)
    this.name = 'MigrationError'
    this.step = step
  }
}

export interface MigrateHooks {
  /** A test seam: runs after a backup copy was taken, before it is verified. */
  afterBackupCopy?: (copy: string, source: LegacyFile) => void
}

export interface MigrateOptions {
  /** How long to wait for another process that is migrating. */
  waitMs?: number
  nowMs?: number
  hooks?: MigrateHooks
  /** Told, for a file with many memories, how far the copy is (every {@link PROGRESS_EVERY} memories); the CLI prints it on stderr. */
  onProgress?: (line: string) => void
}

/** A file of at most this many memories migrates without a progress line. */
export const PROGRESS_EVERY = 250

export interface MigratedFile { path: string, bucket: string, rows: number, memories: number, written: number, skipped: number }

export interface MigrateReport {
  /** False when there was nothing to migrate (or another process finished it while this one waited). */
  ran: boolean
  backup?: string
  files: MigratedFile[]
  profile?: { claims: number, written: number }
  moved: string[]
  leftover: string[]
  cleaned: string[]
}

function waitMs(opts: MigrateOptions): number {
  if (opts.waitMs !== undefined) return opts.waitMs
  const v = Number(process.env[WAIT_ENV])
  return Number.isFinite(v) && v >= 0 && process.env[WAIT_ENV] !== undefined && process.env[WAIT_ENV] !== '' ? v : DEFAULT_WAIT_MS
}

function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
}

function bucketOfFile(f: LegacyFile): string {
  return f.kind === 'person' ? 'person' : f.kind === 'project' ? `project:${f.slug ?? ''}` : 'absorbed'
}

function refOfFile(f: LegacyFile): BrainRef | undefined {
  return f.kind === 'person' ? personRef() : f.kind === 'project' ? projectRef(f.slug as string) : undefined
}

const ORDER = { person: 0, project: 1, absorbed: 2 } as const

function inOrder(files: readonly LegacyFile[]): LegacyFile[] {
  return [...files].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.localeCompare(b.path))
}

export function claimsFile(): string { return join(paths.memoryStateDir(), 'profile', 'claims.json') }
export function droppedFile(): string { return join(paths.memoryStateDir(), 'profile', 'dropped.json') }

export interface MigrationInfo {
  state: 'none' | 'pending' | 'running' | 'complete' | 'failed'
  marker?: MigrationMarker
  /** Buracle 0.5 files still in the brain folder. */
  legacy: string[]
  /** True when the moved-aside copies are still in brain/legacy-0.5. */
  keptLegacy: boolean
  /** The folder of the verified copies taken before the migration, when it is still there. */
  backup?: string
}

export function migrationInfo(): MigrationInfo {
  const marker = readMarker()
  const legacy = pendingLegacy().map(f => f.path)
  const backup = marker?.backup !== undefined && existsSync(join(brainBackupsDir(), marker.backup)) ? marker.backup : undefined
  const keptLegacy = existsSync(legacyBrainDir())
  const state: MigrationInfo['state'] = legacy.length > 0
    ? (marker?.status === 'running' || marker?.status === 'failed' ? marker.status : 'pending')
    : marker === undefined ? 'none' : marker.status
  return { state, ...(marker !== undefined ? { marker } : {}), legacy, keptLegacy, ...(backup !== undefined ? { backup } : {}) }
}

function failLimit(): number | undefined {
  const raw = process.env[FAIL_ENV]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : undefined
}

/**
 * Runs the migration when Buracle 0.5 files wait for it: every memory call asks. Another process that is migrating is
 * waited for a few seconds; after that the call fails with a `migrating` error instead of reading half-migrated data.
 */
export async function ensureMigrated(opts: MigrateOptions = {}): Promise<void> {
  if (!legacyPending()) return
  if (cortexdbBinary() === undefined) throw new CortexError('not_installed', 'CortexDB is not installed; run `buracle install`')
  try {
    await runMigration(opts)
  } catch (e) {
    if (e instanceof CortexError) throw e
    throw new CortexError('migration_failed', `the memory could not be migrated to the new brain file: ${e instanceof Error ? e.message : String(e)}; run \`buracle mem migrate\` to see the state, \`buracle mem migrate --rollback\` to go back`, { cause: e })
  }
}

let inflight: Promise<MigrateReport> | undefined

/** Takes the migration lock and migrates. Throws a `migrating` CortexError when another process holds the lock past the wait. */
export function runMigration(opts: MigrateOptions = {}): Promise<MigrateReport> {
  // Calls of this process that arrive while its own migration runs wait for that one run.
  if (inflight !== undefined) return inflight
  const p = migrateLocked(opts).finally(() => { if (inflight === p) inflight = undefined })
  inflight = p
  return p
}

async function migrateLocked(opts: MigrateOptions): Promise<MigrateReport> {
  mkdirSync(dirname(migrationLockFile()), { recursive: true })
  const release = await acquireLock(migrationLockFile(), { timeoutMs: waitMs(opts), staleMs: LOCK_STALE_MS, heartbeat: true })
  if (!release) throw new CortexError('migrating', 'the memory is being migrated to the new brain file by another Buracle process; try again in a moment (buracle mem migrate --status shows where it is)')
  const opened: string[] = []
  try {
    return await bypassMigrationGate(() => runLocked(opts, opened))
  } finally {
    for (const f of opened) await closeCortex(f).catch(() => undefined)
    release()
  }
}

function claimsPending(): boolean {
  return existsSync(claimsFile())
}

async function runLocked(opts: MigrateOptions, opened: string[]): Promise<MigrateReport> {
  const nowMs = opts.nowMs ?? Date.now()
  const files = inOrder(pendingLegacy())
  const report: MigrateReport = { ran: false, files: [], moved: [], leftover: [], cleaned: [] }
  const prior = readMarker()
  const resuming = prior !== undefined && (prior.status === 'running' || prior.status === 'failed')
  if (files.length === 0 && !(claimsPending() && prior?.profile?.done !== true)) return report
  report.ran = true
  if (cortexdbBinary() === undefined) throw new CortexError('not_installed', 'CortexDB is not installed; run `buracle install`')

  // What the legacy files hold, read from consistent copies: the files themselves stay as they are until the end.
  const rowsOf = new Map<string, unknown[]>()
  for (const f of files) {
    try { rowsOf.set(f.path, await rowsOfCopy(f.abs)) } catch (e) {
      if (f.kind === 'absorbed') { log('warn', 'memory: an absorbed brain could not be read; it is kept as it is', { file: f.path, error: e }); continue }
      throw new MigrationError('read', `${f.path} cannot be read (${e instanceof Error ? e.message : String(e)}); nothing was changed`, { cause: e })
    }
  }

  // (b) Back every legacy file up first and check each copy; a bad copy aborts before anything changed.
  let backup = resuming && prior?.backup !== undefined && existsSync(join(brainBackupsDir(), prior.backup)) ? prior.backup : undefined
  if (backup === undefined && files.length > 0) backup = await backupLegacy(files, rowsOf, nowMs, opts.hooks)

  // (c) The marker says where the run is, so a run that stops can be resumed.
  const marker: MigrationMarker = {
    v: 1, from: '0.5', startedAt: resuming && prior !== undefined ? prior.startedAt : new Date(nowMs).toISOString(), status: 'running',
    ...(backup !== undefined ? { backup } : {}),
    files: files.map((f): MigrationFileState => {
      const was = prior?.files.find(x => x.path === f.path)
      return { path: f.path, bucket: bucketOfFile(f), count: rowsOf.get(f.path)?.length ?? was?.count ?? 0, done: resuming && was?.done === true, ...(was?.written !== undefined ? { written: was.written } : {}) }
    }),
    ...(resuming && prior?.profile !== undefined ? { profile: prior.profile } : {}),
  }
  writeMarker(marker)
  try {
    await bringIn(files, rowsOf, marker, report, nowMs, opts.onProgress)
    await verify(files, rowsOf)
    // (e) The data is safe in brain.db; what remains is putting the old files aside. Nothing is deleted. The marker says
    // `complete` only after that, so a run killed half-way through the move finds the rest still to move.
    const moved = moveAside(files, opened)
    report.moved = moved.moved
    report.leftover = moved.leftover
    report.cleaned = tidyState(nowMs)
    if (moved.leftover.length > 0) marker.leftover = moved.leftover
    marker.status = 'complete'
    marker.finishedAt = new Date().toISOString()
    writeMarker(marker)
  } catch (e) {
    marker.status = 'failed'
    marker.error = e instanceof Error ? e.message : String(e)
    try { writeMarker(marker) } catch (err) { log('warn', 'memory: the migration marker was not updated', { error: err }) }
    throw e
  }
  if (backup !== undefined) report.backup = backup
  recordEvent({ op: 'import', layer: 'person', n: report.files.reduce((n, f) => n + f.written, 0), by: 'buracle-migrate' })
  return report
}

async function backupLegacy(files: readonly LegacyFile[], rowsOf: ReadonlyMap<string, unknown[]>, nowMs: number, hooks: MigrateHooks | undefined): Promise<string> {
  mkdirSync(brainBackupsDir(), { recursive: true, mode: 0o700 })
  // A run that was killed while it copied leaves a partial folder; this run holds the lock, so it is nobody's.
  for (const n of readdirSync(brainBackupsDir())) if (/^pre-migrate-.+\.partial$/.test(n)) rmSync(join(brainBackupsDir(), n), { recursive: true, force: true })
  let stamp = utcStamp(nowMs)
  for (let n = 2; existsSync(preMigrateDir(stamp)) || existsSync(`${preMigrateDir(stamp)}.partial`); n++) stamp = `${utcStamp(nowMs)}-${n}`
  const final = preMigrateDir(stamp)
  const partial = `${final}.partial`
  mkdirSync(partial, { recursive: true, mode: 0o700 })
  try {
    for (const f of files) {
      const copy = join(partial, ...f.path.split('/'))
      try { snapshotFile(f.abs, copy) } catch (e) { throw new MigrationError('backup', `${f.path} could not be copied (${e instanceof Error ? e.message : String(e)})`, { cause: e }) }
      hooks?.afterBackupCopy?.(copy, f)
      const want = rowsOf.get(f.path)
      if (want === undefined) continue
      let got: number
      try { got = (await rowsOfCopy(copy)).length } catch (e) { throw new MigrationError('backup', `the backup copy of ${f.path} does not open (${e instanceof Error ? e.message : String(e)})`, { cause: e }) }
      if (got !== want.length) throw new MigrationError('backup', `the backup copy of ${f.path} holds ${got} rows, the file holds ${want.length}`)
    }
  } catch (e) {
    rmSync(partial, { recursive: true, force: true })
    throw e instanceof MigrationError ? new MigrationError(e.step, `${e.message}; nothing was changed`, { cause: e }) : e
  }
  renameSync(partial, final)
  return `pre-migrate-${stamp}`
}

async function existingStamps(): Promise<ReturnType<typeof stampsOfRows>> {
  return brainExists() ? stampsOfRows(await rawRows(brainDbFile())) : new Map()
}

async function bringIn(files: readonly LegacyFile[], rowsOf: ReadonlyMap<string, unknown[]>, marker: MigrationMarker, report: MigrateReport, nowMs: number, onProgress?: (line: string) => void): Promise<void> {
  const existing = await existingStamps()
  const limit = failLimit()
  let writes = 0
  const beforeWrite = (): void => {
    if (limit !== undefined && writes >= limit) throw new MigrationError('injected', `${FAIL_ENV}=${limit}: stopped after ${writes} writes`)
    writes++
  }
  for (const f of files) {
    const state = marker.files.find(x => x.path === f.path) as MigrationFileState
    const rows = rowsOf.get(f.path) ?? []
    const ref = refOfFile(f)
    if (ref === undefined) {
      report.files.push({ path: f.path, bucket: state.bucket, rows: rows.length, memories: 0, written: 0, skipped: 0 })
      state.done = true
      continue
    }
    const { entries } = entriesOfLegacyRows(rows, ref.layer)
    // A file an earlier run finished is read again: what brain.db holds already is skipped by its stamp, anything else is written.
    const progress = onProgress !== undefined && entries.length > PROGRESS_EVERY
      ? { every: PROGRESS_EVERY, report: (done: number) => onProgress(`${f.path} -> ${state.bucket}: ${done} of ${entries.length} memories`) }
      : undefined
    const r = await importEntries(ref, entries, { nowMs, existing, beforeWrite, ...(progress !== undefined ? { progress } : {}) })
    state.done = true
    state.written = (state.written ?? 0) + r.written
    writeMarker(marker)
    report.files.push({ path: f.path, bucket: state.bucket, rows: rows.length, memories: entries.length, written: r.written, skipped: r.skipped })
  }
  if (marker.profile?.done !== true && claimsPending()) {
    const p = await convertClaims(nowMs, existing, beforeWrite)
    marker.profile = { claims: p.claims, written: p.written, done: true }
    writeMarker(marker)
    report.profile = { claims: p.claims, written: p.written }
  }
}

async function verify(files: readonly LegacyFile[], rowsOf: ReadonlyMap<string, unknown[]>): Promise<void> {
  forgetListCache()
  for (const f of files) {
    const ref = refOfFile(f)
    if (ref === undefined) continue
    const want = entriesOfLegacyRows(rowsOf.get(f.path) ?? [], ref.layer).entries.length
    const got = (await listAll(ref)).length
    if (got < want) throw new MigrationError('verify', `${f.path}: ${want} memories were read, brain.db holds ${got} in ${refKey(ref)}`)
  }
}

interface ClaimLike {
  key: string
  text: string
  category?: string
  kind?: string
  explicit?: boolean
  contested?: boolean
  polarity?: number
  quote?: string
  firstSeen?: number
  lastSeen?: number
  projects?: string[]
  local?: boolean
}

const NOT_PREFERENCES = ['note:', 'feedback.', 'usage.', 'env.', 'style.', 'group:']

function readList<T>(file: string, field: string): T[] {
  const r = readJsonSafeSync<Record<string, unknown>>(file)
  const v = r.ok && r.value !== null && typeof r.value === 'object' ? r.value[field] : undefined
  return Array.isArray(v) ? v as T[] : []
}

function readDropped(): Record<string, { at?: number }> {
  const r = readJsonSafeSync<{ dropped?: unknown }>(droppedFile())
  const d = r.ok && r.value !== null && typeof r.value === 'object' ? r.value.dropped : undefined
  return d !== null && typeof d === 'object' ? d as Record<string, { at?: number }> : {}
}

/**
 * Buracle 0.5 kept what the user said about how to work as "profile claims". The ones the user stated himself and did not
 * drop become `preference` memories with origin explicit (the same shape the session-end capture files), unless a
 * preference with the same signal or nearly the same words is already there. A claim from a preference memory (`note:`),
 * an observed habit (usage, environment, style) or a guess never becomes one.
 */
export async function convertClaims(nowMs: number, existing: Map<string, RowStamp>, beforeWrite?: () => void): Promise<{ claims: number, written: number }> {
  const all = readList<ClaimLike>(claimsFile(), 'claims')
  const dropped = readDropped()
  const at = new Date(nowMs).toISOString()
  const have = new Map<string, MemItem[]>()
  const livePrefs = async (ref: BrainRef): Promise<MemItem[]> => {
    const k = refKey(ref)
    let list = have.get(k)
    if (list === undefined) { list = (await listAll(ref)).filter(i => isLive(i, nowMs) && i.kind === 'preference'); have.set(k, list) }
    return list
  }
  let written = 0
  for (const c of all) {
    if (c === null || typeof c !== 'object' || typeof c.key !== 'string' || typeof c.text !== 'string') continue
    if (c.explicit !== true || c.kind !== 'statement' || c.contested === true || c.text.trim() === '' || c.text === c.key) continue
    if (NOT_PREFERENCES.some(p => c.key.startsWith(p))) continue
    const gone = dropped[c.key]
    if (gone !== undefined && typeof gone.at === 'number' && gone.at >= (c.lastSeen ?? 0)) continue
    const slug = c.local === true && Array.isArray(c.projects) && c.projects.length === 1 && memIsSlug(c.projects[0]) ? c.projects[0] : undefined
    const ref = slug !== undefined ? projectRef(slug) : personRef()
    const layer: MemLayer = ref.layer
    const title = memClip(memOneLine(c.text), 200)
    const token = `signal:${c.key}${c.polarity === -1 ? '|not' : ''}`
    const prefs = await livePrefs(ref)
    if (prefs.some(i => i.sources.includes(token))) continue
    if (similarMemories({ title, summary: '', kind: 'preference' }, prefs, nowMs, 0.85).length > 0) continue
    const quote = typeof c.quote === 'string' && c.quote.trim() !== '' ? memClip(memOneLine(c.quote), 300) : ''
    const stamp = (ms: number | undefined): string => (typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : at)
    const item: MemItem = {
      id: `preference-${slugify(title).slice(0, 48).replace(/-+$/, '') || 'claim'}-${sha256(c.key).slice(0, 6)}`, kind: 'preference', layer, title, summary: quote,
      body: quote !== '' ? `The user said: "${quote}"` : '', tags: ['explicit', ...(typeof c.category === 'string' && c.category !== '' ? [c.category] : [])],
      sources: [token, 'migrated:profile-claims'], about: [], status: 'active', review: 'ok', importance: 4, created: stamp(c.firstSeen), updated: stamp(c.lastSeen),
      author: 'buracle', version: 1, origin: 'explicit', confidence: 1, harness: 'buracle', verifiedAt: at, verifiedBy: 'buracle',
      history: [{ at, by: 'buracle', what: 'migrated from the profile claims of Buracle 0.5' }],
    }
    const entry: Entry = { item, keep: {} }
    const r = await importEntries(ref, [entry], { nowMs, existing, ...(beforeWrite !== undefined ? { beforeWrite } : {}) })
    if (r.written > 0) { written++; prefs.push(item) }
  }
  return { claims: all.length, written }
}

function moveOne(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
  let dest = to
  for (let n = 2; existsSync(dest); n++) dest = `${to}.${n}`
  renameRetrySync(from, dest, { budgetMs: 5_000 })
}

function moveAside(files: readonly LegacyFile[], opened: string[]): { moved: string[], leftover: string[] } {
  const moved: string[] = []
  const leftover: string[] = []
  for (const f of files) {
    try {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        if (existsSync(f.abs + suffix)) moveOne(f.abs + suffix, join(legacyBrainDir(), ...f.path.split('/')) + suffix)
      }
      moved.push(f.path)
    } catch (e) {
      leftover.push(f.path)
      opened.push(f.abs)
      log('warn', 'memory: a Buracle 0.5 file could not be moved aside; it stays where it is and is not migrated again', { file: f.path, error: e })
    }
  }
  for (const dir of [join(brainDir(), 'projects'), join(brainDir(), 'absorbed')]) { try { rmdirSync(dir) } catch {  } }
  return { moved, leftover }
}

/** Moves the state only 0.5's background jobs wrote aside and removes the embedding model nothing uses any more. */
function tidyState(nowMs: number): string[] {
  const done: string[] = []
  for (const name of OBSOLETE_STATE) {
    const from = join(memStateDir(), name)
    if (!existsSync(from)) continue
    try { moveOne(from, join(legacyStateDir(), name)); done.push(`state/memory/${name}`) } catch (e) { log('warn', 'memory: an obsolete state entry was not moved aside', { name, error: e }) }
  }
  const embed = join(paths.toolchainDir(), 'embed')
  if (existsSync(embed)) {
    try { rmSync(embed, { recursive: true, force: true }); done.push('toolchain/embed') } catch (e) { log('warn', 'memory: the embedding model folder was not removed', { error: e }) }
  }
  try {
    if (readToolchainState().system['embed-model'] !== undefined) {
      updateToolchainState(s => { delete s.system['embed-model'] }, new Date(nowMs).toISOString())
      done.push('toolchain record embed-model')
    }
  } catch (e) { log('warn', 'memory: the embed-model record was not removed', { error: e }) }
  return done
}

// ---- the `buracle mem migrate` commands -------------------------------------------------------------------------------

export interface DryRunReport {
  files: Array<{ path: string, bucket: string, rows: number, memories: number, wouldWrite: number }>
  claims: number
  obsolete: string[]
}

/** What a migration would do, from consistent copies: nothing is written, moved or backed up. */
export async function dryRun(): Promise<DryRunReport> {
  const files = inOrder(pendingLegacy())
  const have = brainExists() ? stampsOfRows(await bypassMigrationGate(() => rawRows(brainDbFile()))) : new Map()
  const out: DryRunReport = { files: [], claims: 0, obsolete: OBSOLETE_STATE.filter(n => existsSync(join(memStateDir(), n))).map(n => `state/memory/${n}`) }
  for (const f of files) {
    const rows = await rowsOfCopy(f.abs).catch(() => [] as unknown[])
    const ref = refOfFile(f)
    const entries = ref !== undefined ? entriesOfLegacyRows(rows, ref.layer).entries : []
    const wouldWrite = ref !== undefined ? entries.filter(e => !have.has(storedId(ref, e.item.id))).length : 0
    out.files.push({ path: f.path, bucket: bucketOfFile(f), rows: rows.length, memories: entries.length, wouldWrite })
  }
  out.claims = readList<ClaimLike>(claimsFile(), 'claims').length
  return out
}

export interface RollbackReport { restored: string[], keptBrain?: string, removedBrain: boolean, stateRestored: string[] }

function walk(dir: string, base = ''): string[] {
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return [] }
  const out: string[] = []
  for (const n of names) {
    const rel = base === '' ? n : `${base}/${n}`
    let isDir = false
    try { isDir = statSync(join(dir, n)).isDirectory() } catch { continue }
    if (isDir) out.push(...walk(join(dir, n), rel))
    else out.push(rel)
  }
  return out.sort()
}

/**
 * Puts the Buracle 0.5 files back where they were and removes the migration marker. The migrated brain.db is kept as
 * brain.db.rolled-back unless `force` deletes it. Buracle migrates again the next time it reads the memory.
 */
export async function rollback(opts: { force?: boolean, waitMs?: number } = {}): Promise<RollbackReport> {
  mkdirSync(dirname(migrationLockFile()), { recursive: true })
  const release = await acquireLock(migrationLockFile(), { timeoutMs: opts.waitMs ?? 30_000, staleMs: LOCK_STALE_MS, heartbeat: true })
  if (!release) throw new CortexError('migrating', 'another Buracle process is migrating the memory; try again in a moment')
  try {
    const marker = readMarker()
    if (marker === undefined && !existsSync(legacyBrainDir())) throw new MigrationError('read', 'there is no migration to roll back')
    const kept = walk(legacyBrainDir())
    const sources = new Map<string, string>()
    for (const rel of kept) sources.set(rel, join(legacyBrainDir(), ...rel.split('/')))
    // A purged legacy folder is not the end: the verified copies taken before the migration hold the same files.
    if (marker?.backup !== undefined) {
      for (const rel of walk(join(brainBackupsDir(), marker.backup))) {
        if (rel !== 'backup.json' && !sources.has(rel)) sources.set(rel, join(brainBackupsDir(), marker.backup, ...rel.split('/')))
      }
    }
    if (sources.size === 0) throw new MigrationError('read', 'there are no Buracle 0.5 files to put back (brain/legacy-0.5 and the pre-migrate backup are gone)')
    await closeCortex(brainDbFile()).catch(() => undefined)
    // Readers other processes hold open on brain.db would keep the file in place on Windows: stop them while it moves.
    return await withBrainStopped(10_000, () => putBack(sources, opts.force === true)).then(r => r.value)
  } finally {
    release()
  }
}

function putBack(sources: Map<string, string>, force: boolean): RollbackReport {
  const out: RollbackReport = { restored: [], removedBrain: false, stateRestored: [] }
  for (const [rel, from] of [...sources].sort((a, b) => a[0].localeCompare(b[0]))) {
    const to = join(brainDir(), ...rel.split('/'))
    if (existsSync(to)) continue
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 })
    if (from.startsWith(legacyBrainDir())) renameRetrySync(from, to, { budgetMs: 5_000 })
    else copyFileSync(from, to)
    if (!rel.endsWith('-wal') && !rel.endsWith('-shm') && !rel.endsWith('-journal')) out.restored.push(rel)
  }
  for (const rel of walk(legacyStateDir())) {
    const to = join(memStateDir(), ...rel.split('/'))
    if (existsSync(to)) continue
    mkdirSync(dirname(to), { recursive: true })
    renameRetrySync(join(legacyStateDir(), ...rel.split('/')), to, { budgetMs: 5_000 })
    out.stateRestored.push(rel)
  }
  pruneEmpty(legacyBrainDir())
  pruneEmpty(legacyStateDir())
  if (existsSync(brainDbFile())) {
    if (force) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(brainDbFile() + suffix, { force: true })
      out.removedBrain = true
    } else {
      let dest = `${brainDbFile()}.rolled-back`
      for (let n = 2; existsSync(dest); n++) dest = `${brainDbFile()}.rolled-back.${n}`
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(brainDbFile() + suffix)) renameSync(brainDbFile() + suffix, dest + suffix)
      out.keptBrain = dest
    }
  }
  forgetListCache()
  rmSync(migrationFile(), { force: true })
  return out
}

function pruneEmpty(dir: string): void {
  const sweep = (d: string): void => {
    let names: string[] = []
    try { names = readdirSync(d) } catch { return }
    for (const n of names) { const p = join(d, n); try { if (statSync(p).isDirectory()) sweep(p) } catch {  } }
    try { rmdirSync(d) } catch {  }
  }
  sweep(dir)
}

export interface PurgeReport { removed: string[] }

/** Deletes what a finished migration kept: the moved-aside 0.5 files and state, and the verified pre-migration copies. */
export async function purgeLegacy(opts: { waitMs?: number } = {}): Promise<PurgeReport> {
  const marker = readMarker()
  if (marker?.status !== 'complete' || legacyPending()) throw new MigrationError('verify', 'the migration is not complete, so its backups are all there is: nothing was deleted')
  mkdirSync(dirname(migrationLockFile()), { recursive: true })
  const release = await acquireLock(migrationLockFile(), { timeoutMs: opts.waitMs ?? 30_000, staleMs: LOCK_STALE_MS, heartbeat: true })
  if (!release) throw new CortexError('migrating', 'another Buracle process is migrating the memory; try again in a moment')
  try {
    const removed: string[] = []
    for (const dir of [legacyBrainDir(), legacyStateDir(), ...(marker.backup !== undefined ? [join(brainBackupsDir(), marker.backup)] : [])]) {
      if (!existsSync(dir)) continue
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
    return { removed }
  } finally {
    release()
  }
}

export interface MigrationStatusReport extends MigrationInfo {
  brain: { exists: boolean, person: number, projects: Record<string, number> }
}

export async function migrationStatus(): Promise<MigrationStatusReport> {
  const info = migrationInfo()
  const brain: MigrationStatusReport['brain'] = { exists: brainExists(), person: 0, projects: {} }
  if (brain.exists && cortexdbBinary() !== undefined) {
    try {
      const counts = await bypassMigrationGate(bucketCounts)
      brain.person = counts.person
      brain.projects = Object.fromEntries([...counts.projects].sort((a, b) => a[0].localeCompare(b[0])))
    } catch (e) { log('debug', 'memory: the brain could not be counted for the migration status', { error: e }) }
  }
  return { ...info, brain }
}

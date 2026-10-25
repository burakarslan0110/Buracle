import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MemLayer } from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { entriesOfBucketRows, entriesOfLegacyRows, importEntries, type Entry } from './bucket-io'
import { closeCortex, pidAlive, readerEntries, RESTORE_HOLD_STALE_MS } from './cortex'
import { BACKUP_ID_RE, brainBackupDir, brainBackupsDir, brainDbFile, brainHoldFile, locksDir } from './layout'
import { acquireLock, tryLock } from './lock'
import { legacyPending } from './migration-state'
import { refreshStatus } from './status'
import { snapshotFile, rowsOfCopy } from './snapshot'
import {
  bucketCounts, bypassMigrationGate, brainExists, deleteItem, forgetListCache, personRef, projectRef, rawRows, recordEvent, refKey, rowOwner, storedId, withBrainLock,
  type BrainRef,
} from './store'

export type BackupTrigger = 'manual' | 'daily' | 'pre-restore' | 'pre-upgrade' | 'pre-remove'

export interface BackupFile { name: string, bytes: number, method: 'sqlite' | 'copy', wal?: string }

/** A backup is one copy of brain.db; `buckets` records how many memories each bucket held when it was taken. */
export interface BackupManifest {
  v: 2
  id: string
  at: string
  trigger: BackupTrigger
  file: BackupFile
  buckets: { person: number, projects: Record<string, number> }
}

export interface LegacyBackupBrain { layer: MemLayer, project?: string, file: string, bytes: number, method: 'sqlite' | 'copy', wal?: string }

/** A backup taken by Buracle 0.5: one copy per layer. It is still listed, and restores bucket by bucket. */
export interface LegacyBackupManifest {
  v: 1
  id: string
  at: string
  trigger: BackupTrigger
  brains: LegacyBackupBrain[]
  skipped?: Array<{ brain: string, why: string }>
}

export type BackupInfo = BackupManifest | LegacyBackupManifest

export interface BackupResult { manifest?: BackupManifest, dir?: string, pruned: string[] }

export type BrainChoice = { all: true } | { project: string } | { person: true }

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

const PARTIAL_STALE_MS = 3600_000
const STOP_PASSES = 3

function bucketName(b: { layer: MemLayer, project?: string, slug?: string }): string {
  return b.layer === 'person' ? 'the person brain' : `the project ${b.project ?? b.slug ?? '?'}`
}

/** The buckets a backup holds: `person` and project slugs. */
export function backupBuckets(m: BackupInfo): string[] {
  if (m.v === 1) return m.brains.map(b => (b.layer === 'person' ? 'person' : b.project ?? '?'))
  return [...(m.buckets.person > 0 ? ['person'] : []), ...Object.keys(m.buckets.projects).sort()]
}

export function backupBytes(m: BackupInfo): number {
  return m.v === 1 ? m.brains.reduce((n, b) => n + b.bytes, 0) : m.file.bytes
}

/** True when the backup holds a copy of that bucket (`all` is always true). */
export function backupHolds(m: BackupInfo, choice: BrainChoice): boolean {
  if ('all' in choice) return true
  if (m.v === 1) return m.brains.some(b => ('person' in choice ? b.layer === 'person' : b.layer === 'project' && b.project === choice.project))
  return 'person' in choice ? m.buckets.person > 0 : (m.buckets.projects[choice.project] ?? 0) > 0
}

function stampOf(ms: number): string {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

function newBackupDir(nowMs: number): { id: string, partial: string } {
  mkdirSync(brainBackupsDir(), { recursive: true, mode: 0o700 })
  const base = stampOf(nowMs)
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    if (existsSync(join(brainBackupsDir(), id))) continue
    const partial = join(brainBackupsDir(), `${id}.partial`)
    try {
      mkdirSync(partial, { mode: 0o700 })
      return { id, partial }
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
    }
  }
  throw new BackupError('too many backups in one second')
}

function finishBackup(id: string, partial: string, manifest: BackupInfo): string {
  atomicWriteSync(join(partial, 'backup.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  const dir = brainBackupDir(id)
  renameSync(partial, dir)
  return dir
}

async function withBackupsLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(join(locksDir(), 'backups.lock'), { timeoutMs: 30_000, staleMs: 60_000, heartbeat: true })
  if (!release) throw new BackupError('another backup or restore is running; try again in a moment')
  try { return await fn() } finally { release() }
}

async function currentBuckets(): Promise<BackupManifest['buckets']> {
  try {
    const c = await bypassMigrationGate(() => bucketCounts())
    return { person: c.person, projects: Object.fromEntries([...c.projects].sort((a, b) => a[0].localeCompare(b[0]))) }
  } catch (e) {
    log('debug', 'memory: the buckets of a backup were not counted', { error: e })
    return { person: 0, projects: {} }
  }
}

function takeSnapshot(partial: string): BackupFile {
  const r = snapshotFile(brainDbFile(), join(partial, 'brain.db'))
  return { name: 'brain.db', bytes: r.bytes, method: r.method, ...(r.wal !== undefined ? { wal: 'brain.db-wal' } : {}) }
}

/** Copies brain.db (a SQLite snapshot that takes in the WAL) into backups/<id>/ and keeps the newest `keep` copies. */
export async function backupBrains(choice: BrainChoice, opts: { trigger?: BackupTrigger, nowMs?: number, keep?: number } = {}): Promise<BackupResult> {
  const now = opts.nowMs ?? Date.now()
  // Buracle 0.5 files waiting for their migration are the brain: fold them in (verified copies first) rather than report an empty one.
  if (!brainExists() && legacyPending()) await (await import('./migrate')).ensureMigrated().catch(() => undefined)
  if (!brainExists()) {
    if (legacyPending()) throw new BackupError('the Buracle 0.5 brain files are not migrated yet, so there is no brain.db to back up; run `buracle mem migrate` (it copies them and checks the copies first)')
    if (!('all' in choice)) throw new BackupError(`${'person' in choice ? 'the person brain' : `the project ${choice.project}`} has no brain file yet; nothing to back up`)
    return { pruned: [] }
  }
  return withBackupsLock(async () => {
    const { id, partial } = newBackupDir(now)
    let file: BackupFile
    try {
      file = takeSnapshot(partial)
    } catch (e) {
      rmSync(partial, { recursive: true, force: true })
      throw new BackupError(`nothing was backed up: ${e instanceof Error ? e.message : String(e)}`)
    }
    const manifest: BackupManifest = { v: 2, id, at: new Date(now).toISOString(), trigger: opts.trigger ?? 'manual', file, buckets: await currentBuckets() }
    const dir = finishBackup(id, partial, manifest)
    const pruned = opts.keep !== undefined ? pruneNow(opts.keep, [id], now) : []
    return { manifest, dir, pruned }
  })
}

const DAILY_MS = 24 * 3600_000
const DAILY_KEEP = 10

/**
 * One copy of the whole brain per 24 hours, taken by the session-end finalizer after its work: the safety net the
 * removed tick used to provide, with no timer and no process of its own. Skipped when any backup is newer than a day.
 */
export async function maybeDailyBackup(nowMs: number = Date.now()): Promise<BackupManifest | undefined> {
  const newest = listBackups()[0]
  if (newest !== undefined && nowMs - Date.parse(newest.at) < DAILY_MS) return undefined
  return (await backupBrains({ all: true }, { trigger: 'daily', nowMs, keep: DAILY_KEEP })).manifest
}

const TRIGGERS: readonly string[] = ['manual', 'daily', 'pre-restore', 'pre-upgrade', 'pre-remove']

function isManifest(v: unknown): v is BackupInfo {
  if (v === null || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  if (typeof m['id'] !== 'string' || typeof m['at'] !== 'string' || typeof m['trigger'] !== 'string' || !TRIGGERS.includes(m['trigger'])) return false
  if (m['v'] === 1) return Array.isArray(m['brains'])
  const f = m['file']
  const b = m['buckets']
  return m['v'] === 2 && f !== null && typeof f === 'object' && typeof (f as BackupFile).name === 'string' && b !== null && typeof b === 'object'
}

export function listBackups(): BackupInfo[] {
  let names: string[] = []
  try { names = readdirSync(brainBackupsDir()) } catch { return [] }
  const out: BackupInfo[] = []
  for (const n of names) {
    if (!BACKUP_ID_RE.test(n)) continue
    const r = readJsonSafeSync<unknown>(join(brainBackupsDir(), n, 'backup.json'))
    if (r.ok && isManifest(r.value) && r.value.id === n) out.push(r.value)
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
}

function pruneNow(keep: number, protect: readonly string[], nowMs: number): string[] {
  const removed: string[] = []
  let kept = 0
  for (const m of listBackups()) {
    if (protect.includes(m.id) || kept < Math.max(1, keep)) { kept++; continue }
    try { rmSync(brainBackupDir(m.id), { recursive: true, force: true }); removed.push(m.id) } catch (e) { log('warn', 'memory: an old backup was not removed', { id: m.id, error: e }) }
  }
  let names: string[] = []
  try { names = readdirSync(brainBackupsDir()) } catch { names = [] }
  for (const n of names) {
    if (!n.endsWith('.partial') || !BACKUP_ID_RE.test(n.slice(0, -'.partial'.length))) continue
    const p = join(brainBackupsDir(), n)
    try { if (nowMs - statSync(p).mtimeMs > PARTIAL_STALE_MS) rmSync(p, { recursive: true, force: true }) } catch {  }
  }
  return removed
}

function zombie(pid: number): boolean {
  if (process.platform === 'win32') return false
  try {
    const r = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env } })
    return r.stdout.toString().trim().startsWith('Z')
  } catch {
    return false
  }
}

interface ProcIdentity { ppid?: number, name: string }

function processIdentity(pid: number): ProcIdentity | 'gone' | undefined {
  try {
    if (process.platform === 'win32') {
      const r = Bun.spawnSync(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env } })
      if (r.exitCode !== 0) return undefined
      const row = r.stdout.toString().split(/\r?\n/).map(l => /^"([^"]*)","(\d+)"/.exec(l.trim())).find(m => m !== null && Number(m[2]) === pid)
      if (row) return { name: row[1] as string }
      return pidAlive(pid) ? undefined : 'gone'
    }
    const r = Bun.spawnSync(['ps', '-o', 'ppid=', '-o', 'comm=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env } })
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(r.stdout.toString().split('\n')[0] ?? '')
    if (m) return { ppid: Number(m[1]), name: m[2] as string }
    return pidAlive(pid) ? undefined : 'gone'
  } catch {
    return undefined
  }
}

function readerNames(): string[] {
  const bin = cortexdbBinary()
  return [...new Set(['cortexdb-mcp', ...(bin !== undefined ? [basename(bin.path)] : [])].map(n => n.replace(/\.exe$/i, '').toLowerCase()))]
}

function isReader(id: ProcIdentity, owner: number, names: readonly string[]): boolean {
  const name = basename(id.name.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase()
  if (name === '' || !names.some(n => n === name || (name.length >= 15 && n.startsWith(name)))) return false
  return id.ppid === undefined ? process.platform === 'win32' : id.ppid === owner
}

function readersToStop(db: string, seen: ReadonlySet<number>): Array<{ child: number, file: string }> {
  const names = readerNames()
  const kids: Array<{ child: number, file: string }> = []
  for (const { file, entry } of readerEntries(db)) {
    if (seen.has(entry.child)) continue
    const drop = () => { try { unlinkSync(file) } catch {  } }
    if (entry.pid === process.pid || !pidAlive(entry.pid) || !pidAlive(entry.child)) { drop(); continue }
    const id = processIdentity(entry.child)
    if (id === undefined) throw new BackupError(`cannot tell whether process ${entry.child} is a CortexDB reader of this brain; close the sessions that use the memory and restore again`)
    if (id === 'gone' || !isReader(id, entry.pid, names)) {
      if (id !== 'gone') log('info', 'memory: a reader entry names a process that is not its CortexDB reader; dropped it', { pid: entry.pid, child: entry.child, name: id.name })
      drop()
      continue
    }
    kids.push({ child: entry.child, file })
  }
  return kids
}

async function waitStopped(kids: readonly number[], waitMs: number): Promise<void> {
  const running = () => kids.filter(k => pidAlive(k))
  const deadline = Date.now() + waitMs
  while (running().length > 0 && Date.now() < deadline) await Bun.sleep(50)
  for (const k of running()) { try { process.kill(k, 'SIGKILL') } catch {  } }
  const late = Date.now() + 2000
  while (running().some(k => !zombie(k)) && Date.now() < late) await Bun.sleep(100)
  const left = running().filter(k => !zombie(k))
  if (left.length > 0) throw new BackupError(`its CortexDB reader(s) ${left.join(', ')} did not stop`)
}

async function stopBrainReaders(db: string, waitMs: number): Promise<number> {
  await closeCortex(db)
  const stopped = new Set<number>()
  for (let pass = 0; pass < STOP_PASSES; pass++) {
    const found = readersToStop(db, stopped)
    if (found.length === 0) break
    for (const k of found) { try { process.kill(k.child, 'SIGTERM') } catch {  } stopped.add(k.child) }
    await waitStopped(found.map(k => k.child), waitMs)
    for (const k of found) { try { unlinkSync(k.file) } catch {  } }
  }
  return stopped.size
}

/**
 * Runs `fn` while no CortexDB reader has the brain file open: it takes the restore hold (new readers refuse to start),
 * stops the readers other processes registered, and lets go of the hold afterwards. Returns how many readers it stopped.
 */
export async function withBrainStopped<T>(waitMs: number, fn: () => T | Promise<T>): Promise<{ value: T, stopped: number }> {
  const hold = tryLock(brainHoldFile(brainDbFile()), RESTORE_HOLD_STALE_MS, { heartbeat: true })
  if (!hold) throw new BackupError('another restore holds the brain')
  try {
    const stopped = await stopBrainReaders(brainDbFile(), waitMs)
    return { value: await fn(), stopped }
  } finally {
    hold()
  }
}

function swapIn(src: string, wal: string | undefined): void {
  const db = brainDbFile()
  mkdirSync(dirname(db), { recursive: true, mode: 0o700 })
  const tmp = `${db}.restore-${process.pid}`
  copyFileSync(src, tmp)
  chmodSync(tmp, 0o600)
  for (const ext of ['-wal', '-shm', '-journal']) { try { unlinkSync(`${db}${ext}`) } catch {  } }
  renameSync(tmp, db)
  if (wal !== undefined) {
    copyFileSync(wal, `${db}-wal`)
    chmodSync(`${db}-wal`, 0o600)
  }
  forgetListCache()
}

export interface RestoreResult {
  id: string
  /** What came back: the whole brain file (`all`), or one bucket with the memories it holds now. */
  restored: Array<{ layer: MemLayer, project?: string, memories?: number, all?: true }>
  safety?: string
  stopped: number
}

function wantedName(choice: BrainChoice): string {
  return 'all' in choice ? 'any brain' : 'person' in choice ? 'the person brain' : `the project ${choice.project}`
}

/** The memories of a bucket, from the copy of a backup: brain.db copies carry bucket ids, Buracle 0.5 copies one layer per file. */
async function bucketFromBackup(m: BackupInfo, ref: BrainRef): Promise<{ entries: Entry[] }> {
  const dir = brainBackupDir(m.id)
  if (m.v === 2) return entriesOfBucketRows(await rowsOfCopy(join(dir, m.file.name)), ref)
  const b = m.brains.find(x => (ref.layer === 'person' ? x.layer === 'person' : x.layer === 'project' && x.project === ref.slug))
  return b === undefined ? { entries: [] } : entriesOfLegacyRows(await rowsOfCopy(join(dir, b.file)), ref.layer)
}

async function restoreBucket(m: BackupInfo, ref: BrainRef, nowMs: number): Promise<number> {
  const { entries } = await bucketFromBackup(m, ref)
  if (entries.length === 0) throw new BackupError(`backup ${m.id} holds no copy of ${bucketName(ref)}`)
  return withBrainLock(ref, async () => {
    // The backup's memories go in first; only then do the rows it does not hold go, so a stop in between loses nothing.
    await importEntries(ref, entries, { nowMs })
    const keep = new Set(entries.map(e => storedId(ref, e.item.id)))
    if (brainExists()) {
      for (const raw of await rawRows(brainDbFile())) {
        const owner = rowOwner(raw)
        if (owner === undefined || refKey(owner.ref) !== refKey(ref) || keep.has((raw as { id: string }).id)) continue
        await deleteItem(ref, owner.id)
      }
    }
    forgetListCache()
    return entries.length
  })
}

export async function restoreBackup(id: string, choice: BrainChoice, opts: { nowMs?: number, waitMs?: number } = {}): Promise<RestoreResult> {
  if (!BACKUP_ID_RE.test(id)) throw new BackupError(`not a backup id: ${JSON.stringify(id)} (buracle mem backup --list shows them)`)
  const manifest = listBackups().find(m => m.id === id)
  if (manifest === undefined) throw new BackupError(`there is no backup ${id} (buracle mem backup --list shows them)`)
  if ('project' in choice && !memIsSlug(choice.project)) throw new BackupError(`not a project slug: ${JSON.stringify(choice.project)}`)
  // A brain.db copy restores whole; a Buracle 0.5 backup (one copy per layer) and a single bucket restore bucket by bucket.
  const buckets: BrainRef[] = manifest.v === 1 && 'all' in choice
    ? manifest.brains.map(b => (b.layer === 'person' ? personRef() : projectRef(b.project as string)))
    : 'project' in choice ? [projectRef(choice.project)] : 'person' in choice ? [personRef()] : []
  if (manifest.v === 1 && !('all' in choice) && !backupHolds(manifest, choice)) throw new BackupError(`backup ${id} holds no copy of ${wantedName(choice)}`)
  if (manifest.v === 1) for (const b of manifest.brains) if (b.layer === 'project' && !memIsSlug(b.project)) throw new BackupError(`backup ${id} names a project that is not a slug: ${JSON.stringify(b.project)}`)
  const now = opts.nowMs ?? Date.now()
  const { result, failure } = await withBackupsLock(async () => {
    const { id: safetyId, partial } = newBackupDir(now)
    let safety: BackupFile | undefined
    const restored: RestoreResult['restored'] = []
    let stopped = 0
    let failure: { at?: BrainRef, index: number, error: unknown } | undefined
    let before: BackupManifest['buckets'] = { person: 0, projects: {} }
    try {
      if (brainExists()) { before = await currentBuckets(); safety = takeSnapshot(partial) }
      if (manifest.v === 2 && 'all' in choice) {
        try {
          stopped += (await withBrainStopped(opts.waitMs ?? 10_000, () => swapIn(join(brainBackupDir(id), manifest.file.name), manifest.file.wal !== undefined ? join(brainBackupDir(id), manifest.file.wal) : undefined))).stopped
          restored.push({ layer: 'person', all: true })
          recordEvent({ op: 'import', layer: 'person', n: 1, by: 'buracle-restore' })
        } catch (e) {
          failure = { index: -1, error: e }
        }
      } else {
        for (const [index, ref] of buckets.entries()) {
          try {
            const memories = await restoreBucket(manifest, ref, now)
            restored.push({ layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), memories })
            recordEvent({ op: 'import', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), n: memories, by: 'buracle-restore' })
          } catch (e) {
            failure = { at: ref, index, error: e }
            break
          }
        }
      }
    } finally {
      if (safety !== undefined) finishBackup(safetyId, partial, { v: 2, id: safetyId, at: new Date(now).toISOString(), trigger: 'pre-restore', file: safety, buckets: before })
      else rmSync(partial, { recursive: true, force: true })
    }
    return { result: { id, restored, ...(safety !== undefined ? { safety: safetyId } : {}), stopped } satisfies RestoreResult, failure }
  })
  for (const r of result.restored) {
    try {
      await refreshStatus({ ...(r.project !== undefined ? { slug: r.project } : {}), nowMs: now })
    } catch (e) { log('warn', 'memory: the status was not refreshed after a restore', { error: e }) }
  }
  if (failure !== undefined) throw new BackupError(restoreFailure(result, failure.at, buckets.slice(failure.index + 1), failure.error))
  return result
}

function restoreFailure(done: RestoreResult, failed: BrainRef | undefined, left: readonly BrainRef[], error: unknown): string {
  const names = (list: ReadonlyArray<{ layer: MemLayer, project?: string, slug?: string, all?: true }>) => list.map(x => ('all' in x && x.all === true ? 'the brain file' : bucketName(x))).join(', ')
  return [
    done.restored.length > 0 ? `restored ${names(done.restored)}` : undefined,
    `${failed !== undefined ? bucketName(failed) : 'the brain file'} was not restored: ${error instanceof Error ? error.message : String(error)}`,
    left.length > 0 ? `not tried: ${names(left)}` : undefined,
    done.restored.length === 0 ? 'nothing was restored' : undefined,
    done.safety !== undefined ? `the brain file as it was before this restore is in backup ${done.safety} (buracle mem restore ${done.safety} --all puts it back)` : undefined,
  ].filter((s): s is string => s !== undefined).join('; ')
}

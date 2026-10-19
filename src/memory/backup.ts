import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MemLayer } from '../core/memory/brain'
import { BACKUP_BUDGET } from '../core/memory/budgets'
import { memIsSlug } from '../core/memory/note'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { closeCortex, pidAlive, readerEntries, RESTORE_HOLD_STALE_MS } from './cortex'
import { BACKUP_ID_RE, brainBackupDir, brainBackupsDir, brainHoldFile, brainProjectsDir, locksDir, personDbFile } from './layout'
import { acquireLock, tryLock } from './lock'
import { readProjectsCache } from './project'
import { refreshStatus } from './status'
import { brainExists, forgetListCache, personRef, projectRef, recordEvent, withBrainLock, type BrainRef } from './store'
import { refreshUpkeepFor } from './sweep'

export type BackupTrigger = 'manual' | 'daily' | 'pre-restore' | 'pre-upgrade'

export interface BackupBrain { layer: MemLayer, project?: string, file: string, bytes: number, method: 'sqlite' | 'copy', wal?: string }

export interface BackupManifest {
  v: 1
  id: string
  at: string
  trigger: BackupTrigger
  brains: BackupBrain[]
  skipped?: Array<{ brain: string, why: string }>
}

export interface BackupResult { manifest?: BackupManifest, dir?: string, pruned: string[] }

export type BrainChoice = { all: true } | { project: string } | { person: true }

export type BackupChoice = BrainChoice | { refs: readonly BrainRef[] }

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

const SQLITE_MAGIC = 'SQLite format 3\0'
const PARTIAL_STALE_MS = 3600_000
const STOP_PASSES = 3

function brainKey(b: { layer: MemLayer, project?: string, slug?: string }): string {
  return b.layer === 'person' ? 'person' : `project:${b.project ?? b.slug ?? ''}`
}

function brainName(ref: { layer: MemLayer, slug?: string, project?: string }): string {
  return ref.layer === 'person' ? 'the person brain' : `the project ${ref.slug ?? ref.project ?? '?'}`
}

export function brainRefs(choice: BackupChoice): BrainRef[] {
  if ('refs' in choice) return [...choice.refs]
  if ('person' in choice) return [personRef()]
  if ('project' in choice) {
    if (!memIsSlug(choice.project)) throw new BackupError(`not a project slug: ${JSON.stringify(choice.project)}`)
    return [projectRef(choice.project)]
  }
  const out: BrainRef[] = []
  if (existsSync(personDbFile())) out.push(personRef())
  let names: string[] = []
  try { names = readdirSync(brainProjectsDir()).sort() } catch { names = [] }
  for (const n of names) {
    const slug = n.endsWith('.db') ? n.slice(0, -3) : ''
    if (memIsSlug(slug)) out.push(projectRef(slug))
  }
  return out
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

function isSqlite(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(16)
    return readSync(fd, buf, 0, 16, 0) === 16 && buf.toString('latin1') === SQLITE_MAGIC
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function sqliteSnapshot(src: string, dest: string): boolean {
  for (const opts of [{ readonly: true }, { readwrite: true, create: false }]) {
    let db: Database | undefined
    try {
      db = new Database(src, opts)
      db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
      return true
    } catch (e) {
      log('debug', 'memory: a consistent SQLite copy failed', { db: src, readonly: 'readonly' in opts, error: e })
      try { unlinkSync(dest) } catch {  }
    } finally {
      try { db?.close() } catch {  }
    }
  }
  return false
}

function snapshotBrain(ref: BrainRef, dir: string): BackupBrain {
  const file = ref.layer === 'person' ? 'person.db' : `projects/${ref.slug ?? ''}.db`
  const dest = join(dir, file)
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  let method: BackupBrain['method'] = 'copy'
  let wal: string | undefined
  if (isSqlite(ref.db) && sqliteSnapshot(ref.db, dest)) method = 'sqlite'
  else {
    copyFileSync(ref.db, dest)
    if (existsSync(`${ref.db}-wal`)) {
      copyFileSync(`${ref.db}-wal`, `${dest}-wal`)
      chmodSync(`${dest}-wal`, 0o600)
      wal = `${file}-wal`
    }
  }
  chmodSync(dest, 0o600)
  const bytes = statSync(dest).size + (wal !== undefined ? statSync(`${dest}-wal`).size : 0)
  return { layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), file, bytes, method, ...(wal !== undefined ? { wal } : {}) }
}

function finishBackup(id: string, partial: string, manifest: BackupManifest): string {
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

export async function backupBrains(choice: BackupChoice, opts: { trigger?: BackupTrigger, nowMs?: number, keep?: number } = {}): Promise<BackupResult> {
  const now = opts.nowMs ?? Date.now()
  const refs = brainRefs(choice).filter(r => brainExists(r))
  if (refs.length === 0) {
    if ('project' in choice || 'person' in choice) throw new BackupError(`${brainName(brainRefs(choice)[0] ?? { layer: 'person' })} has no brain file yet; nothing to back up`)
    return { pruned: [] }
  }
  return withBackupsLock(async () => {
    const { id, partial } = newBackupDir(now)
    const brains: BackupBrain[] = []
    const skipped: Array<{ brain: string, why: string }> = []
    for (const ref of refs) {
      try { brains.push(await withBrainLock(ref, async () => snapshotBrain(ref, partial))) } catch (e) { skipped.push({ brain: brainName(ref), why: (e as Error).message }) }
    }
    if (brains.length === 0) {
      rmSync(partial, { recursive: true, force: true })
      throw new BackupError(`nothing was backed up: ${skipped.map(s => `${s.brain}: ${s.why}`).join('; ')}`)
    }
    const manifest: BackupManifest = { v: 1, id, at: new Date(now).toISOString(), trigger: opts.trigger ?? 'manual', brains, ...(skipped.length > 0 ? { skipped } : {}) }
    const dir = finishBackup(id, partial, manifest)
    const pruned = opts.keep !== undefined ? pruneNow(opts.keep, [id], now) : []
    return { manifest, dir, pruned }
  })
}

function isManifest(v: unknown): v is BackupManifest {
  if (v === null || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return m['v'] === 1 && typeof m['id'] === 'string' && typeof m['at'] === 'string' && Array.isArray(m['brains'])
    && (m['trigger'] === 'manual' || m['trigger'] === 'daily' || m['trigger'] === 'pre-restore' || m['trigger'] === 'pre-upgrade')
}

export function listBackups(): BackupManifest[] {
  let names: string[] = []
  try { names = readdirSync(brainBackupsDir()) } catch { return [] }
  const out: BackupManifest[] = []
  for (const n of names) {
    if (!BACKUP_ID_RE.test(n)) continue
    const r = readJsonSafeSync<unknown>(join(brainBackupsDir(), n, 'backup.json'))
    if (r.ok && isManifest(r.value) && r.value.id === n) out.push(r.value)
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
}

function pruneNow(keep: number, protect: readonly string[], nowMs: number): string[] {
  const copies = new Map<string, number>()
  const removed: string[] = []
  const projects = readProjectsCache().projects
  const gone = (b: BackupBrain) => b.layer === 'project' && memIsSlug(b.project) && projects[b.project] === undefined && !brainExists(projectRef(b.project))
  let newer = 0
  for (const m of listBackups()) {
    const held = [...new Set(m.brains.map(brainKey))]
    const goneHeld = new Set(m.brains.filter(gone).map(brainKey))
    if (protect.includes(m.id) || held.length === 0 || held.some(k => (goneHeld.has(k) ? newer : (copies.get(k) ?? 0)) < Math.max(1, keep))) {
      for (const k of held) copies.set(k, (copies.get(k) ?? 0) + 1)
      newer++
      continue
    }
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

function dueForDailyBackup(nowMs: number): BrainRef[] {
  const newest = new Map<string, number>()
  for (const m of listBackups()) {
    if (m.trigger === 'pre-restore') continue
    for (const b of m.brains) if (!newest.has(brainKey(b))) newest.set(brainKey(b), Date.parse(m.at))
  }
  return brainRefs({ all: true }).filter(r => {
    if (!brainExists(r)) return false
    const at = newest.get(brainKey(r))
    return at === undefined || !Number.isFinite(at) || nowMs - at >= BACKUP_BUDGET.everyMs
  })
}

export async function maybeDailyBackup(nowMs: number): Promise<BackupResult | undefined> {
  const due = dueForDailyBackup(nowMs)
  if (due.length === 0) return undefined
  return backupBrains({ refs: due }, { trigger: 'daily', nowMs, keep: BACKUP_BUDGET.keep })
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

function swapIn(ref: BrainRef, src: string, wal: string | undefined): void {
  mkdirSync(dirname(ref.db), { recursive: true, mode: 0o700 })
  const tmp = `${ref.db}.restore-${process.pid}`
  copyFileSync(src, tmp)
  chmodSync(tmp, 0o600)
  for (const ext of ['-wal', '-shm', '-journal']) { try { unlinkSync(`${ref.db}${ext}`) } catch {  } }
  renameSync(tmp, ref.db)
  if (wal !== undefined) {
    copyFileSync(wal, `${ref.db}-wal`)
    chmodSync(`${ref.db}-wal`, 0o600)
  }
  forgetListCache(ref.db)
}

export interface RestoreResult {
  id: string
  restored: Array<{ layer: MemLayer, project?: string, bytes: number }>
  safety?: string
  stopped: number
}

export async function restoreBackup(id: string, choice: BrainChoice, opts: { nowMs?: number, waitMs?: number } = {}): Promise<RestoreResult> {
  if (!BACKUP_ID_RE.test(id)) throw new BackupError(`not a backup id: ${JSON.stringify(id)} (buracle mem backup --list shows them)`)
  const manifest = listBackups().find(m => m.id === id)
  if (manifest === undefined) throw new BackupError(`there is no backup ${id} (buracle mem backup --list shows them)`)
  const picked = manifest.brains.filter(b => 'all' in choice || ('person' in choice ? b.layer === 'person' : b.layer === 'project' && b.project === choice.project))
  if (picked.length === 0) throw new BackupError(`backup ${id} holds no copy of ${'person' in choice ? 'the person brain' : 'project' in choice ? `the project ${choice.project}` : 'any brain'}`)
  for (const b of picked) if (b.layer === 'project' && !memIsSlug(b.project)) throw new BackupError(`backup ${id} names a project that is not a slug: ${JSON.stringify(b.project)}`)
  const now = opts.nowMs ?? Date.now()
  const { result, failure } = await withBackupsLock(async () => {
    const { id: safetyId, partial } = newBackupDir(now)
    const safety: BackupBrain[] = []
    const restored: RestoreResult['restored'] = []
    let stopped = 0
    let failure: { at: number, error: unknown } | undefined
    try {
      for (const [n, b] of picked.entries()) {
        const ref = b.layer === 'person' ? personRef() : projectRef(b.project as string)
        try {
          await withBrainLock(ref, async () => {
            const hold = tryLock(brainHoldFile(ref.db), RESTORE_HOLD_STALE_MS, { heartbeat: true })
            if (!hold) throw new BackupError(`another restore holds ${brainName(ref)}`)
            try {
              stopped += await stopBrainReaders(ref.db, opts.waitMs ?? 10_000)
              if (brainExists(ref)) safety.push(snapshotBrain(ref, partial))
              swapIn(ref, join(brainBackupDir(id), b.file), b.wal !== undefined ? join(brainBackupDir(id), b.wal) : undefined)
            } finally {
              hold()
            }
          })
        } catch (e) {
          failure = { at: n, error: e }
          break
        }
        restored.push({ layer: b.layer, ...(b.project !== undefined ? { project: b.project } : {}), bytes: b.bytes })
        recordEvent({ op: 'import', layer: b.layer, ...(b.project !== undefined ? { project: b.project } : {}), n: 1, by: 'buracle-restore' })
      }
    } finally {
      if (safety.length > 0) finishBackup(safetyId, partial, { v: 1, id: safetyId, at: new Date(now).toISOString(), trigger: 'pre-restore', brains: safety })
      else rmSync(partial, { recursive: true, force: true })
    }
    return { result: { id, restored, ...(safety.length > 0 ? { safety: safetyId } : {}), stopped }, failure }
  })
  for (const r of result.restored) {
    const ref = r.layer === 'person' ? personRef() : projectRef(r.project as string)
    try {
      await refreshUpkeepFor(ref, { nowMs: now })
      await refreshStatus({ ...(r.project !== undefined ? { slug: r.project } : {}), nowMs: now })
    } catch (e) { log('warn', 'memory: the status was not refreshed after a restore', { error: e }) }
  }
  if (failure !== undefined) throw new BackupError(restoreFailure(result, picked[failure.at] as BackupBrain, picked.slice(failure.at + 1), failure.error))
  return result
}

function restoreFailure(done: RestoreResult, failed: BackupBrain, left: readonly BackupBrain[], error: unknown): string {
  const names = (list: ReadonlyArray<{ layer: MemLayer, project?: string }>) => list.map(brainName).join(', ')
  return [
    done.restored.length > 0 ? `restored ${names(done.restored)}` : undefined,
    `${brainName(failed)} was not restored: ${error instanceof Error ? error.message : String(error)}`,
    left.length > 0 ? `not tried: ${names(left)}` : undefined,
    done.restored.length === 0 ? 'nothing was restored' : undefined,
    done.safety !== undefined ? `the brain files as they were before this restore are in backup ${done.safety} (buracle mem restore ${done.safety} --all puts them back)` : undefined,
  ].filter((s): s is string => s !== undefined).join('; ')
}

import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { log } from '../engine/log'
import { closeCortex } from './cortex'
import { brainDir } from './layout'
import { rawRows } from './store'

const SQLITE_MAGIC = 'SQLite format 3\0'

export function isSqlite(file: string): boolean {
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

/** A consistent copy of a SQLite file (VACUUM INTO) that also takes in what its WAL holds. */
export function sqliteSnapshot(src: string, dest: string): boolean {
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

export interface SnapshotResult { method: 'sqlite' | 'copy', bytes: number, wal?: string }

/** Copies a brain file to `dest`: a SQLite snapshot when it is one, else the file and its WAL byte for byte. */
export function snapshotFile(src: string, dest: string): SnapshotResult {
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 })
  let method: SnapshotResult['method'] = 'copy'
  let wal: string | undefined
  if (isSqlite(src) && sqliteSnapshot(src, dest)) method = 'sqlite'
  else {
    copyFileSync(src, dest)
    if (existsSync(`${src}-wal`)) {
      copyFileSync(`${src}-wal`, `${dest}-wal`)
      chmodSync(`${dest}-wal`, 0o600)
      wal = `${dest}-wal`
    }
  }
  chmodSync(dest, 0o600)
  const bytes = statSync(dest).size + (wal !== undefined ? statSync(wal).size : 0)
  return { method, bytes, ...(wal !== undefined ? { wal } : {}) }
}

let scratchSeq = 0

/**
 * Every raw row of a brain file, read from a scratch copy so the file itself is never opened by CortexDB (opening a
 * file can create its WAL or upgrade its schema, which a backup must not undergo). Throws when the copy does not open.
 */
export async function rowsOfCopy(file: string): Promise<unknown[]> {
  const dir = join(brainDir(), `.scratch-${process.pid}-${Date.now()}-${scratchSeq++}`)
  const copy = join(dir, 'copy.db')
  try {
    snapshotFile(file, copy)
    return await rawRows(copy)
  } finally {
    await closeCortex(copy).catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

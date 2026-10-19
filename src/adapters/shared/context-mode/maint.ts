import { lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESSES } from '../../../core/events'
import { cmHome, cmProbeRoot, cmSentinelDir, cmSessionsDir } from '../../../engine/context-mode'
import { breakStaleLock, lockSnapshot } from '../../../engine/lockfile'
import { log } from '../../../engine/log'
import { cmTmpDir } from './client'

const DAY_MS = 24 * 3600_000
const CONTENT_MAX_AGE_DAYS = 14

export interface CmPruneOptions {
  statsMaxAgeMs?: number
  tmpMaxAgeMs?: number
}

const DB_FILE = /^([0-9a-f]{16}(?:__[A-Za-z0-9._-]+)?\.db)(?:-wal|-shm)?$/
const EVENTS_FILE = /^[0-9a-f]{16}(?:__[A-Za-z0-9._-]+)?-events\.md$/
const STATS_FILE = /^stats-[A-Za-z0-9._-]+\.json(?:\.tmp)?$/
const CORRUPT_FILE = /\.db(?:-wal|-shm)?\.corrupt-\d+$/

function entries(dir: string): string[] {
  if (!isDir(dir)) return []
  try { return readdirSync(dir) } catch { return [] }
}

function fileMtime(p: string): number | undefined {
  try {
    const s = lstatSync(p)
    return s.isFile() ? s.mtimeMs : undefined
  } catch {
    return undefined
  }
}

function dirMtime(p: string): number | undefined {
  try {
    const s = lstatSync(p)
    return s.isDirectory() ? s.mtimeMs : undefined
  } catch {
    return undefined
  }
}

function isDir(p: string): boolean {
  return dirMtime(p) !== undefined
}

function dbFamilies(dir: string, names: readonly string[]): Map<string, number> {
  const newest = new Map<string, number>()
  for (const n of names) {
    const db = DB_FILE.exec(n)
    const m = fileMtime(join(dir, n))
    if (db === null || m === undefined) continue
    const base = db[1] as string
    newest.set(base, Math.max(newest.get(base) ?? 0, m))
  }
  return newest
}

export function cmPrune(nowMs: number, maxAgeDays = 7, opts: CmPruneOptions = {}): { removed: string[] } {
  const removed: string[] = []
  const cutoff = nowMs - maxAgeDays * DAY_MS
  const rm = (p: string): void => {
    try { unlinkSync(p); removed.push(p) } catch {  }
  }
  const rmdirIfIdle = (p: string, mtimeBefore: number | undefined): void => {
    if (mtimeBefore === undefined || mtimeBefore >= cutoff || entries(p).length > 0) return
    try { rmdirSync(p); removed.push(p) } catch {  }
  }
  const sweepFolder = (dir: string, maxAgeMs: number, name: RegExp): void => {
    for (const n of entries(dir)) {
      const p = join(dir, n)
      const m = fileMtime(p)
      if (m !== undefined && name.test(n) && nowMs - m > maxAgeMs) rm(p)
    }
  }
  const sweepSessions = (dir: string): void => {
    const names = entries(dir)
    const newest = dbFamilies(dir, names)
    for (const n of names) {
      const p = join(dir, n)
      const m = fileMtime(p)
      if (m === undefined) continue
      const db = DB_FILE.exec(n)
      if (db !== null) { if ((newest.get(db[1] as string) ?? m) < cutoff) rm(p); continue }
      if ((EVENTS_FILE.test(n) || CORRUPT_FILE.test(n)) && m < cutoff) { rm(p); continue }
      if (STATS_FILE.test(n) && nowMs - m > (opts.statsMaxAgeMs ?? DAY_MS)) rm(p)
    }
  }
  const sweepContent = (dir: string): void => {
    const names = entries(dir)
    const newest = dbFamilies(dir, names)
    const contentCutoff = nowMs - CONTENT_MAX_AGE_DAYS * DAY_MS
    for (const n of names) {
      const db = DB_FILE.exec(n)
      if (db !== null && fileMtime(join(dir, n)) !== undefined && (newest.get(db[1] as string) ?? nowMs) < contentCutoff) rm(join(dir, n))
    }
  }
  const servedLately = (sessions: string): boolean =>
    entries(sessions).some(n => STATS_FILE.test(n) && nowMs - (fileMtime(join(sessions, n)) ?? -Infinity) <= DAY_MS)
  const sweepRoot = (root: string): void => {
    const sessions = cmSessionsDir(root)
    const content = join(root, 'content')
    const before = { root: dirMtime(root), sessions: dirMtime(sessions), content: dirMtime(content) }
    const served = servedLately(sessions)
    sweepSessions(sessions)
    rmdirIfIdle(sessions, before.sessions)
    const lock = join(root, 'writer.lock')
    const m = fileMtime(lock)
    if (m !== undefined && nowMs - m > DAY_MS) {
      const seen = lockSnapshot(lock)
      if (seen !== undefined && nowMs - seen.mtimeMs > DAY_MS && breakStaleLock(lock, seen) === 'broken') removed.push(lock)
    }
    if (!served) sweepContent(content)
    rmdirIfIdle(content, before.content)
    rmdirIfIdle(root, before.root)
  }
  try {
    const home = cmHome()
    if (!isDir(home)) return { removed }
    sweepFolder(cmTmpDir(), opts.tmpMaxAgeMs ?? 10 * 60_000, /^in-[\w-]+\.json$/)
    sweepFolder(cmSentinelDir(), maxAgeDays * DAY_MS, /^[\w.-]+$/)
    for (const h of HARNESSES) {
      const dir = join(home, h)
      const before = dirMtime(dir)
      for (const n of entries(dir)) {
        const root = join(dir, n)
        if (isDir(root)) sweepRoot(root)
      }
      rmdirIfIdle(dir, before)
    }
    if (isDir(cmProbeRoot())) sweepRoot(cmProbeRoot())
  } catch (e) {
    log('debug', 'context-mode: storage housekeeping failed', { error: e })
  }
  return { removed }
}

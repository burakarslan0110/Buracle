import { closeSync, mkdirSync, openSync, readFileSync, utimesSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { breakStaleLock, lockSnapshot, lockToken, releaseLockFile } from '../engine/lockfile'

export interface LockOptions {
  timeoutMs?: number
  staleMs?: number
  heartbeat?: boolean
}

function ownerAlive(text: string): boolean {
  try {
    const info = JSON.parse(text) as { pid?: unknown }
    if (typeof info.pid !== 'number') return true
    try { process.kill(info.pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
  } catch {
    return true
  }
}

function touchOwn(path: string, text: string): void {
  try {
    if (readFileSync(path, 'utf8') !== text) return
    const now = new Date()
    utimesSync(path, now, now)
  } catch {  }
}

export function tryLock(path: string, staleMs = 60_000, opts: { heartbeat?: boolean } = {}): (() => void) | undefined {
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      const text = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: lockToken() })
      try { writeSync(fd, text) } finally { closeSync(fd) }
      let released = false
      const timer = opts.heartbeat === true ? setInterval(() => touchOwn(path, text), Math.max(250, Math.floor(staleMs / 3))) : undefined
      timer?.unref?.()
      return () => {
        if (released) return
        released = true
        if (timer !== undefined) clearInterval(timer)
        releaseLockFile(path, text)
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
      const seen = lockSnapshot(path)
      if (seen === undefined) continue
      if (Math.max(0, Date.now() - seen.mtimeMs) > staleMs || !ownerAlive(seen.text)) {
        if (breakStaleLock(path, seen) === 'broken') continue
      }
      return undefined
    }
  }
  return undefined
}

export async function acquireLock(path: string, opts: LockOptions = {}): Promise<(() => void) | undefined> {
  const timeout = opts.timeoutMs ?? 2000
  const stale = opts.staleMs ?? 60_000
  const start = Date.now()
  for (;;) {
    const release = tryLock(path, stale, opts.heartbeat === true ? { heartbeat: true } : {})
    if (release) return release
    if (Date.now() - start >= timeout) return undefined
    await Bun.sleep(15)
  }
}

export function lockHeld(path: string, staleMs: number, nowMs: number = Date.now()): boolean {
  const seen = lockSnapshot(path)
  return seen !== undefined && nowMs - seen.mtimeMs <= staleMs && ownerAlive(seen.text)
}

export function removeDeadLock(path: string, minAgeMs: number, nowMs: number = Date.now()): boolean {
  const seen = lockSnapshot(path)
  if (seen === undefined || nowMs - seen.mtimeMs < minAgeMs || ownerAlive(seen.text)) return false
  return breakStaleLock(path, seen) === 'broken'
}

import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'

export interface LockSnapshot { dev: number; ino: number; mtimeMs: number; text: string }

export const lockTestHooks: { beforeBreak?: (path: string) => void } = {}

export const BREAKER_STALE_MS = 5_000

export function lockToken(): string {
  return `${process.pid}-${randomBytes(6).toString('hex')}`
}

export function lockSnapshot(path: string): LockSnapshot | undefined {
  try {
    const st = statSync(path)
    return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, text: readFileSync(path, 'utf8') }
  } catch {
    return undefined
  }
}

function sameLock(a: LockSnapshot, b: LockSnapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.text === b.text
}

export function breakStaleLock(path: string, seen: LockSnapshot): 'broken' | 'changed' | 'busy' {
  try { lockTestHooks.beforeBreak?.(path) } catch {  }
  const breaker = `${path}.break`
  let fd: number
  try {
    fd = openSync(breaker, 'wx', 0o600)
  } catch (e) {
    if ((e as { code?: string }).code === 'EEXIST') {
      try { if (Date.now() - statSync(breaker).mtimeMs > BREAKER_STALE_MS) unlinkSync(breaker) } catch {  }
    }
    return 'busy'
  }
  try {
    closeSync(fd)
    const now = lockSnapshot(path)
    if (now === undefined) return 'broken'
    if (!sameLock(now, seen)) return 'changed'
    unlinkSync(path)
    return 'broken'
  } catch {
    return 'changed'
  } finally {
    try { unlinkSync(breaker) } catch {  }
  }
}

export function releaseLockFile(path: string, text: string): void {
  let cur: string
  try { cur = readFileSync(path, 'utf8') } catch { return }
  if (cur !== text) return
  try { unlinkSync(path) } catch {  }
}

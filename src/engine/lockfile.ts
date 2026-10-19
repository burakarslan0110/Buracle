import { randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, statSync, unlinkSync } from 'node:fs'

export interface LockSnapshot { dev: number; ino: number; mtimeMs: number; text: string }

export interface ProcessSeen { startedAt: number | undefined; command: string }

export const lockTestHooks: { beforeBreak?: (path: string) => void, lookUpProcess?: (pid: number) => ProcessSeen | undefined } = {}

export const BREAKER_STALE_MS = 5_000

const PROCESS_LOOKUP_MS = 5_000

function parseEtime(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim())
  if (!m) return undefined
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3]) * 60) + Number(m[4])
}

function runForText(argv: string[]): string | undefined {
  try {
    const r = Bun.spawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: PROCESS_LOOKUP_MS, env: { ...process.env } })
    return r.exitCode === 0 ? r.stdout.toString() : undefined
  } catch {
    return undefined
  }
}

// When a live process started (epoch ms) and what it runs; undefined when no lookup answers (no ps, no
// PowerShell, a timeout). Windows has no ps: PowerShell's Get-Process gives the start time and the image name.
export function lookUpProcess(pid: number, opts: { os?: NodeJS.Platform, run?: (argv: string[]) => string | undefined, nowMs?: number } = {}): ProcessSeen | undefined {
  if (opts.os === undefined && lockTestHooks.lookUpProcess !== undefined) return lockTestHooks.lookUpProcess(pid)
  const run = opts.run ?? runForText
  if ((opts.os ?? process.platform) === 'win32') {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction Stop; '{0} {1}' -f ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds(), $p.ProcessName`
    const m = /^(\d+) (.+)$/.exec((run(['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]) ?? '').trim())
    return m ? { startedAt: Number(m[1]), command: m[2] as string } : undefined
  }
  const line = (run(['ps', '-o', 'etime=,command=', '-p', String(pid)]) ?? '').trim()
  if (line === '') return undefined
  const space = line.search(/\s/)
  const elapsed = parseEtime(space < 0 ? line : line.slice(0, space))
  return { startedAt: elapsed === undefined ? undefined : (opts.nowMs ?? Date.now()) - elapsed * 1000, command: space < 0 ? '' : line.slice(space + 1) }
}

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

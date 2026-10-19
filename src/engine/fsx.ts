import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeSync, chmodSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isWindows } from './platform'

export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: 'missing' | 'parse' | 'io' }

// The one spelling of a path that Buracle compares: links resolved and, on Windows, 8.3 short names such as
// C:\Users\RUNNER~1 expanded to the long ones (only the .native variant does that). Throws like realpathSync.
export function realPath(p: string): string {
  return realpathSync.native(p)
}

// A path from another source (git prints C:/Users/runneradmin/x on Windows, a harness may pass the cwd as
// C:\Users\RUNNER~1\x) in the form Buracle compares: resolved and, on Windows, the real path when it exists.
export function comparablePath(p: string, base?: string): string {
  const abs = base !== undefined ? resolve(base, p) : resolve(p)
  if (!isWindows()) return abs
  try { return realPath(abs) } catch { return abs }
}

// Windows refuses to rename a folder while another process (an antivirus scan, the search indexer) still reads a
// file in it, as it does right after npm wrote one; npm's own file layer retries for the same reason. Windows
// retries for up to budgetMs; elsewhere the first error stands.
export function renameRetrySync(from: string, to: string, opts: { budgetMs?: number, platform?: NodeJS.Platform, rename?: (a: string, b: string) => void } = {}): void {
  const rename = opts.rename ?? renameSync
  const start = Date.now()
  for (let delay = 50; ; delay = Math.min(delay * 2, 1000)) {
    try { rename(from, to); return } catch (e) {
      const code = (e as { code?: string }).code
      if ((opts.platform ?? process.platform) !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || Date.now() - start >= (opts.budgetMs ?? 30_000)) throw e
      Bun.sleepSync(delay)
    }
  }
}

// Windows lets a user create a symbolic link only with administrator rights or Developer Mode, and a junction
// always, so a link to a directory is a junction there: one with an absolute target at once, one with a relative
// target (it stays relative in a repository) when the symbolic link is refused.
export function linkDirSync(target: string, link: string): void {
  const abs = resolve(dirname(link), target)
  let dir = false
  try { dir = statSync(abs).isDirectory() } catch {  }
  if (process.platform !== 'win32' || !dir) { symlinkSync(target, link); return }
  if (!isAbsolute(target)) {
    try { symlinkSync(target, link); return } catch (e) { if ((e as { code?: string }).code !== 'EPERM') throw e }
  }
  symlinkSync(abs, link, 'junction')
}

// A link's target without the \\?\ prefix Windows gives the target of a junction.
export function readLinkSync(link: string): string {
  return readlinkSync(link).replace(/^\\(?:\\\?|\?\?)\\/, '')
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function errCode(e: unknown): string | undefined {
  return e !== null && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string' ? (e as { code: string }).code : undefined
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export async function exists(path: string): Promise<boolean> {
  return pathExistsSync(path)
}

export function pathExistsSync(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

export async function ensureDir(path: string): Promise<void> {
  mkdirSync(path, { recursive: true })
}

export function ensureDirSync(path: string): void {
  mkdirSync(path, { recursive: true })
}

export async function readText(path: string): Promise<ReadResult<string>> {
  return readTextSync(path)
}

export function readTextSync(path: string): ReadResult<string> {
  try {
    return { ok: true, value: readFileSync(path, 'utf8') }
  } catch (e) {
    const code = errCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: `${path}: not found`, code: 'missing' }
    return { ok: false, error: `${path}: ${message(e)}`, code: 'io' }
  }
}

export async function readJsonSafe<T = unknown>(path: string): Promise<ReadResult<T>> {
  return readJsonSafeSync<T>(path)
}

export function readJsonSafeSync<T = unknown>(path: string): ReadResult<T> {
  const r = readTextSync(path)
  if (!r.ok) return r
  try {
    return { ok: true, value: JSON.parse(r.value) as T }
  } catch (e) {
    return { ok: false, error: `${path}: invalid JSON: ${message(e)}`, code: 'parse' }
  }
}

export function resolveWriteTarget(path: string): string {
  let cur = path
  for (let i = 0; i < 32; i++) {
    let st
    try { st = lstatSync(cur) } catch { return cur }
    if (!st.isSymbolicLink()) return cur
    const target = readlinkSync(cur)
    cur = isAbsolute(target) ? target : resolve(dirname(cur), target)
  }
  throw new Error(`${path}: too many levels of symbolic links`)
}

export function fileMode(path: string): number | undefined {
  try {
    const st = statSync(path)
    return st.isFile() ? st.mode & 0o7777 : undefined
  } catch {
    return undefined
  }
}

export async function atomicWrite(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): Promise<void> {
  atomicWriteSync(path, data, opts)
}

export function atomicWriteSync(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
  const target = resolveWriteTarget(path)
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const mode = opts.mode ?? fileMode(target) ?? 0o644
  const tmp = join(dir, `.${basename(target)}.buracle-${process.pid}-${randomBytes(4).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode)
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    chmodSync(tmp, mode)
    renameSync(tmp, target)
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd) } catch {  } }
    try { unlinkSync(tmp) } catch {  }
    throw e
  }
  try {
    const dfd = openSync(dir, 'r')
    try { fsyncSync(dfd) } finally { closeSync(dfd) }
  } catch {  }
}

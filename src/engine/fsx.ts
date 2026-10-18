import { createHash, randomBytes } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export type ReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: 'missing' | 'parse' | 'io' }

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

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { buracleHome } from '../engine/paths'

export interface FileCursor<C> {
  size: number
  mtimeMs: number
  offset: number
  tail: string
  order: number
  carry: C
  compressed?: boolean
}

export interface CursorStore<C> { v: 2; collector: string; files: Record<string, FileCursor<C>>; meta: Record<string, unknown> }

export interface ScanFile {
  path: string
  id?: string
  order: number
  compressed?: boolean
}

export interface ScanSpec<C> {
  files: ScanFile[]
  parse(line: string, carry: C): void
  initCarry(): C
  readCompressed?(path: string): Promise<Uint8Array | undefined>
}

export interface ScanStats { files: number; read: number; bytes: number; reset: number }

const TAIL_BYTES = 64

export function cursorFile(collector: string): string {
  return join(buracleHome(), 'cache', 'usage', `${collector}.json`)
}

export function emptyStore<C>(collector: string): CursorStore<C> {
  return { v: 2, collector, files: {}, meta: {} }
}

export function loadStore<C>(collector: string, path = cursorFile(collector)): CursorStore<C> {
  const r = readJsonSafeSync<CursorStore<C>>(path)
  if (!r.ok || r.value === null || typeof r.value !== 'object' || r.value.v !== 2 || r.value.collector !== collector || typeof r.value.files !== 'object' || r.value.files === null) {
    return emptyStore(collector)
  }
  return { v: 2, collector, files: r.value.files, meta: r.value.meta && typeof r.value.meta === 'object' ? r.value.meta : {} }
}

export function saveStore<C>(store: CursorStore<C>, path = cursorFile(store.collector)): void {
  atomicWriteSync(path, JSON.stringify(store) + '\n')
}

export function shortHash(data: string | Uint8Array): string {
  return Bun.hash(data).toString(36)
}

function readRange(path: string, start: number, end: number): Uint8Array | undefined {
  if (end <= start) return new Uint8Array(0)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = new Uint8Array(end - start)
    let off = 0
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off)
      if (n <= 0) break
      off += n
    }
    return off === buf.length ? buf : buf.subarray(0, off)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch {  } }
  }
}

function freshCursor<C>(f: ScanFile, carry: C): FileCursor<C> {
  return { size: 0, mtimeMs: 0, offset: 0, tail: '', order: f.order, carry }
}

/** Reads what each file gained since the last scan, line by line, into the file's carry. */
export async function scanFiles<C>(store: CursorStore<C>, spec: ScanSpec<C>): Promise<ScanStats> {
  const stats: ScanStats = { files: spec.files.length, read: 0, bytes: 0, reset: 0 }
  const decoder = new TextDecoder()

  const ingest = (cur: FileCursor<C>, text: string): void => {
    for (const line of text.split('\n')) {
      if (line.length < 2) continue
      try { spec.parse(line, cur.carry) } catch {  }
    }
  }

  const files = [...spec.files].sort((a, b) => a.order - b.order || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const f of files) {
    let st: { size: number, mtimeMs: number }
    try {
      const s = statSync(f.path)
      if (!s.isFile()) continue
      st = { size: s.size, mtimeMs: Math.floor(s.mtimeMs) }
    } catch {
      continue
    }
    const id = f.id ?? f.path
    let cur = store.files[id]
    if (cur && cur.size === st.size && cur.mtimeMs === st.mtimeMs) continue

    if (f.compressed) {
      if (cur && !cur.compressed && cur.offset > 0) {
        cur.compressed = true
        cur.size = st.size
        cur.mtimeMs = st.mtimeMs
        continue
      }
      const bytes = spec.readCompressed ? await spec.readCompressed(f.path) : undefined
      if (bytes === undefined) continue
      if (cur) stats.reset++
      cur = freshCursor(f, spec.initCarry())
      const end = bytes.lastIndexOf(10) + 1
      ingest(cur, decoder.decode(bytes.subarray(0, end)))
      cur.offset = end
      cur.tail = shortHash(bytes.subarray(Math.max(0, end - TAIL_BYTES), end))
      cur.size = st.size
      cur.mtimeMs = st.mtimeMs
      cur.compressed = true
      store.files[id] = cur
      stats.read++
      stats.bytes += bytes.length
      continue
    }

    let from = 0
    if (cur && cur.offset > 0 && st.size >= cur.offset) {
      const tail = readRange(f.path, Math.max(0, cur.offset - TAIL_BYTES), cur.offset)
      if (tail !== undefined && shortHash(tail) === cur.tail) from = cur.offset
    }
    if (!cur || from === 0) {
      if (cur && cur.offset > 0) stats.reset++
      cur = freshCursor(f, spec.initCarry())
    }
    const bytes = readRange(f.path, from, st.size)
    if (bytes === undefined) continue
    const end = bytes.lastIndexOf(10) + 1
    if (end > 0) {
      ingest(cur, decoder.decode(bytes.subarray(0, end)))
      const newOffset = from + end
      const tailBytes = end >= TAIL_BYTES ? bytes.subarray(end - TAIL_BYTES, end) : readRange(f.path, Math.max(0, newOffset - TAIL_BYTES), newOffset)
      cur.offset = newOffset
      cur.tail = tailBytes === undefined ? '' : shortHash(tailBytes)
    }
    cur.size = st.size
    cur.mtimeMs = st.mtimeMs
    cur.order = f.order
    store.files[id] = cur
    stats.read++
    stats.bytes += bytes.length
  }

  const present = new Set(files.map(f => f.id ?? f.path))
  for (const id of Object.keys(store.files)) if (!present.has(id)) delete store.files[id]
  return stats
}

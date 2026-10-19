import { type Dirent, readdirSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LspSpec } from '../../core/catalog'

function uriPath(uri: string): string | undefined {
  try { return fileURLToPath(uri) } catch { return undefined }
}

export interface FileStamp { mtimeMs: number; size: number }
export type FileChangeType = 1 | 2 | 3
export interface FileChange { path: string; type: FileChangeType }

export const SCAN_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '__pycache__', 'target', 'bin', 'obj', 'build', 'dist', 'out', 'venv'])
export const SCAN_MAX_ENTRIES = 100_000

export function scanMatcher(spec: Pick<LspSpec, 'extensions' | 'root_markers'>): (name: string) => boolean {
  const exts = new Set(Object.keys(spec.extensions).map(e => e.toLowerCase()))
  const names = new Set<string>()
  const suffixes: string[] = []
  for (const m of spec.root_markers ?? []) {
    if (m.startsWith('*.')) suffixes.push(m.slice(1).toLowerCase())
    else if (!m.includes('/') && !m.includes('*')) names.add(m)
  }
  return name => exts.has(extname(name).toLowerCase()) || names.has(name) || suffixes.some(s => name.toLowerCase().endsWith(s))
}

function sameStamp(a: FileStamp, b: FileStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

function stampOf(path: string): FileStamp | undefined {
  try {
    const st = statSync(path)
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : undefined
  } catch {
    return undefined
  }
}

export class WorkspaceScan {
  partial = false
  private files: Map<string, FileStamp>

  constructor(readonly root: string, private readonly wanted: (name: string) => boolean, private readonly maxEntries = SCAN_MAX_ENTRIES) {
    this.files = this.walk()
  }

  get size(): number { return this.files.size }

  private walk(): Map<string, FileStamp> {
    const out = new Map<string, FileStamp>()
    const stack = [this.root]
    let seen = 0
    this.partial = false
    while (stack.length > 0) {
      const dir = stack.pop() as string
      let entries: Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (++seen > this.maxEntries) { this.partial = true; return out }
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && !SCAN_SKIP_DIRS.has(e.name)) stack.push(p)
          continue
        }
        if (!(e.isFile() || e.isSymbolicLink()) || !this.wanted(e.name)) continue
        const st = stampOf(p)
        if (st !== undefined) out.set(p, st)
      }
    }
    return out
  }

  changes(): FileChange[] {
    const next = this.walk()
    const out: FileChange[] = []
    for (const [p, st] of next) {
      const was = this.files.get(p)
      if (was === undefined) out.push({ path: p, type: 1 })
      else if (!sameStamp(was, st)) out.push({ path: p, type: 2 })
    }
    for (const [p, was] of this.files) {
      if (next.has(p)) continue
      const st = stampOf(p)
      if (st === undefined) { out.push({ path: p, type: 3 }); continue }
      next.set(p, st)
      if (!sameStamp(was, st)) out.push({ path: p, type: 2 })
    }
    this.files = next
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }
}

export interface FileWatcher { glob: InstanceType<typeof Bun.Glob>; base?: string; kind: number }

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function watchersOf(registerOptions: unknown): FileWatcher[] {
  const opts = isObj(registerOptions) ? registerOptions : {}
  const out: FileWatcher[] = []
  for (const w of Array.isArray(opts['watchers']) ? opts['watchers'] : []) {
    if (!isObj(w)) continue
    const kind = typeof w['kind'] === 'number' ? w['kind'] : 7
    const g = w['globPattern']
    try {
      if (typeof g === 'string') out.push({ glob: new Bun.Glob(g), kind })
      else if (isObj(g) && typeof g['pattern'] === 'string') {
        const b = g['baseUri']
        const uri = typeof b === 'string' ? b : isObj(b) && typeof b['uri'] === 'string' ? b['uri'] : undefined
        const base = uri !== undefined ? uriPath(uri) : undefined
        if (base !== undefined) out.push({ glob: new Bun.Glob(g['pattern']), base, kind })
      }
    } catch {  }
  }
  return out
}

const KIND_BIT: Record<FileChangeType, number> = { 1: 1, 2: 2, 3: 4 }

export function watcherWants(w: FileWatcher, change: FileChange): boolean {
  if ((w.kind & KIND_BIT[change.type]) === 0) return false
  if (w.base !== undefined) {
    const rel = relative(w.base, change.path)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && w.glob.match(rel.replace(/\\/g, '/'))
  }
  return w.glob.match(change.path.replace(/\\/g, '/'))
}

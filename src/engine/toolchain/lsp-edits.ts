import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { comparablePath } from '../fsx'
import { log } from '../log'
import * as paths from '../paths'
import { isWindows } from '../platform'

export type EditReportState = 'report' | 'clean' | 'pending' | 'starting' | 'none' | 'error'
export interface EditReport { state: EditReportState; text?: string }
export interface LspBridgeEntry { pid: number; ppid: number; cwd: string; port: number; token: string; startedAt: number }

export const EDIT_WAIT_MS = 4000
export const EDIT_MAX_FILES = 3
const STATES: readonly string[] = ['report', 'clean', 'pending', 'starting', 'none', 'error']

export function lspBridgeDir(): string {
  return join(paths.runDir(), 'lsp')
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export async function serveEditRequests(handler: (file: string, waitMs: number) => Promise<EditReport>, opts: { cwd: string, dir?: string, now?: () => number }): Promise<{ entry: LspBridgeEntry, close(): void } | undefined> {
  const dir = opts.dir ?? lspBridgeDir()
  const token = randomBytes(24).toString('hex')
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 60,
      async fetch(req) {
        if (req.method !== 'POST' || new URL(req.url).pathname !== '/edit' || req.headers.get('authorization') !== `Bearer ${token}`) return new Response('not found', { status: 404 })
        let body: unknown
        try { body = await req.json() } catch { body = undefined }
        const b = isObj(body) ? body : {}
        const file = typeof b['file'] === 'string' ? b['file'] : ''
        const raw = b['wait_ms']
        const wait = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(250, Math.min(30_000, raw)) : EDIT_WAIT_MS
        if (file === '' || !isAbsolute(file)) return Response.json({ state: 'none' })
        return Response.json(await handler(file, wait))
      },
    })
  } catch (e) {
    log('warn', 'lsp mcp: cannot listen for edit reports', { error: e })
    return undefined
  }
  const port = server.port
  if (port === undefined) { void server.stop(true); return undefined }
  const entry: LspBridgeEntry = { pid: process.pid, ppid: process.ppid, cwd: resolve(opts.cwd), port, token, startedAt: (opts.now ?? Date.now)() }
  const file = join(dir, `${process.pid}.json`)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(entry), { mode: 0o600 })
  } catch (e) {
    log('warn', 'lsp mcp: cannot register for edit reports', { error: e, file })
    void server.stop(true)
    return undefined
  }
  return {
    entry,
    close: () => {
      try { rmSync(file, { force: true }) } catch {  }
      void server.stop(true)
    },
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function validEntry(x: unknown): x is LspBridgeEntry {
  return isObj(x) && typeof x['pid'] === 'number' && typeof x['ppid'] === 'number' && typeof x['cwd'] === 'string' && typeof x['port'] === 'number' && typeof x['token'] === 'string' && typeof x['startedAt'] === 'number'
}

export function liveBridges(dir: string = lspBridgeDir()): LspBridgeEntry[] {
  let names: string[]
  try { names = readdirSync(dir).filter(n => /^\d+\.json$/.test(n)).sort() } catch { return [] }
  const out: LspBridgeEntry[] = []
  for (const n of names) {
    let e: unknown
    try { e = JSON.parse(readFileSync(join(dir, n), 'utf8')) } catch { continue }
    if (!validEntry(e)) continue
    if (!alive(e.pid)) {
      try { rmSync(join(dir, n), { force: true }) } catch {  }
      continue
    }
    out.push(e)
  }
  return out
}

// A bridge's folder and the hook's cwd may be spelled differently on Windows (case, 8.3 names, '/'): both are keyed alike.
function pathKey(p: string): string {
  const abs = comparablePath(p)
  return isWindows() ? abs.toLowerCase() : abs
}

function inside(file: string, dir: string): boolean {
  const rel = relative(dir, file)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function pickBridge(bridges: readonly LspBridgeEntry[], file: string, opts: { cwd: string, parents: readonly number[] }): LspBridgeEntry | undefined {
  const cwd = pathKey(opts.cwd)
  const fileKey = pathKey(file)
  const score = (b: LspBridgeEntry) => (opts.parents.includes(b.ppid) ? 2 : 0) + (pathKey(b.cwd) === cwd ? 1 : 0)
  return bridges.filter(b => pathKey(b.cwd) === cwd || inside(fileKey, pathKey(b.cwd))).sort((a, b) => score(b) - score(a) || b.startedAt - a.startedAt)[0]
}

export async function askBridge(entry: LspBridgeEntry, file: string, waitMs: number, timeoutMs: number): Promise<EditReport | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${entry.port}/edit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${entry.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ file, wait_ms: waitMs }),
      signal: AbortSignal.timeout(Math.max(250, timeoutMs)),
    })
    if (!res.ok) return undefined
    const r = await res.json() as unknown
    if (!isObj(r) || typeof r['state'] !== 'string' || !STATES.includes(r['state'])) return undefined
    return { state: r['state'] as EditReportState, ...(typeof r['text'] === 'string' ? { text: r['text'] } : {}) }
  } catch {
    return undefined
  }
}

export interface EditDiagnosticsOptions { cwd: string; deadlineMs: number; now?: () => number; parents?: readonly number[]; dir?: string; waitMs?: number; maxFiles?: number }

export async function editDiagnostics(files: readonly string[], opts: EditDiagnosticsOptions): Promise<string[]> {
  const now = opts.now ?? Date.now
  const bridges = liveBridges(opts.dir)
  if (bridges.length === 0) return []
  const parents = opts.parents ?? [process.pid, process.ppid]
  const out: string[] = []
  for (const file of [...new Set(files.map(f => resolve(opts.cwd, f)))].slice(0, opts.maxFiles ?? EDIT_MAX_FILES)) {
    const left = opts.deadlineMs - now()
    if (left < 1500) break
    const bridge = pickBridge(bridges, file, { cwd: opts.cwd, parents })
    if (bridge === undefined) continue
    const wait = Math.min(opts.waitMs ?? EDIT_WAIT_MS, left - 1000)
    const r = await askBridge(bridge, file, wait, Math.min(left, wait + 3000))
    if (r?.state === 'report' && r.text !== undefined && r.text !== '') out.push(r.text)
  }
  return out
}

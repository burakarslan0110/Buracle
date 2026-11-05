import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { atomicWriteSync } from '../engine/fsx'
import { lockSnapshot } from '../engine/lockfile'
import { cortexdbBinary, cortexdbLaunch } from '../engine/toolchain/cortexdb'
import { log } from '../engine/log'
import { brainHoldFile, cortexChildFile, cortexChildrenDir } from './layout'

export const RESTORE_HOLD_STALE_MS = 10 * 60_000

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

export function restoreHolder(db: string, nowMs: number = Date.now()): number | undefined {
  const seen = lockSnapshot(brainHoldFile(db))
  if (seen === undefined) return undefined
  let pid: number | undefined
  try { const v = JSON.parse(seen.text) as { pid?: unknown }; if (typeof v.pid === 'number') pid = v.pid } catch { pid = undefined }
  if (pid === undefined || nowMs - seen.mtimeMs > RESTORE_HOLD_STALE_MS || !pidAlive(pid)) return undefined
  return pid
}

export interface CortexChildEntry { v: 1, pid: number, child: number, db: string, at: string }

const ownEntries = new Set<string>()
let exitHook = false

function dropOwnEntries(): void {
  for (const file of ownEntries) { try { unlinkSync(file) } catch {  } }
  ownEntries.clear()
}

function registerChild(db: string, child: number): void {
  try {
    const file = cortexChildFile(db, process.pid)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const entry: CortexChildEntry = { v: 1, pid: process.pid, child, db, at: new Date().toISOString() }
    atomicWriteSync(file, JSON.stringify(entry), { mode: 0o600 })
    ownEntries.add(file)
    if (!exitHook) { exitHook = true; process.on('exit', dropOwnEntries) }
  } catch (e) {
    log('debug', 'cortexdb: child not registered', { db, error: e })
  }
}

function unregisterChild(db: string, child: number | undefined): void {
  try {
    const file = cortexChildFile(db, process.pid)
    const cur = JSON.parse(readFileSync(file, 'utf8')) as { child?: unknown }
    if (cur.child === child) { unlinkSync(file); ownEntries.delete(file) }
  } catch {  }
}

export function readerEntries(db?: string): Array<{ file: string, entry: CortexChildEntry }> {
  const prefix = db !== undefined ? basename(cortexChildFile(db, 0)).replace(/-0\.json$/, '-') : ''
  let names: string[] = []
  try { names = readdirSync(cortexChildrenDir()) } catch { return [] }
  const out: Array<{ file: string, entry: CortexChildEntry }> = []
  for (const n of names) {
    if (n.startsWith('.') || !n.startsWith(prefix) || !n.endsWith('.json')) continue
    const file = join(cortexChildrenDir(), n)
    try {
      const e = JSON.parse(readFileSync(file, 'utf8')) as CortexChildEntry
      if (e.v === 1 && (db === undefined || e.db === db) && Number.isInteger(e.pid) && Number.isInteger(e.child)) out.push({ file, entry: e })
    } catch {  }
  }
  return out
}

export function pruneDeadReaders(): number {
  let names: string[] = []
  try { names = readdirSync(cortexChildrenDir()) } catch { return 0 }
  let n = 0
  for (const name of names) {
    const owner = /-(\d+)\.json$/.exec(name) ?? /\.buracle-(\d+)-[0-9a-f]+\.tmp$/.exec(name)
    const pid = owner !== null ? Number(owner[1]) : Number.NaN
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pidAlive(pid)) continue
    try { unlinkSync(join(cortexChildrenDir(), name)); n++ } catch {  }
  }
  return n
}

export type CortexErrorCode = 'not_installed' | 'start_failed' | 'exited' | 'timeout' | 'protocol' | 'tool_error' | 'not_found' | 'busy' | 'migrating' | 'migration_failed'

export class CortexError extends Error {
  readonly code: CortexErrorCode
  constructor(code: CortexErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts)
    this.name = 'CortexError'
    this.code = code
  }
}

export interface CortexOptions {
  timeoutMs?: number
  env?: Record<string, string | undefined>
}

interface Pending { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }

// CortexDB falls back to OPENAI_BASE_URL/OPENAI_API_KEY for an embeddings endpoint; the child never gets either, so it
// stays in its lexical mode whatever the user's shell exports.
const NEVER_PASSED = /^(?:CORTEXDB_|OPENAI_)/

export function cortexEnv(dbPath: string, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || NEVER_PASSED.test(k)) continue
    env[k] = v
  }
  env['CORTEXDB_PATH'] = dbPath
  return env
}

export class CortexClient {
  readonly dbPath: string
  private readonly timeoutMs: number
  private readonly envBase: Record<string, string | undefined>
  private proc: ReturnType<typeof Bun.spawn> | undefined
  private ready: Promise<void> | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private buf = ''
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false
  lastUsedMs = 0

  constructor(dbPath: string, opts: CortexOptions = {}) {
    this.dbPath = dbPath
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.envBase = opts.env ?? process.env
  }

  call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.closed) throw new CortexError('exited', 'the CortexDB client is closed')
      const holder = restoreHolder(this.dbPath)
      if (holder !== undefined && holder !== process.pid) {
        this.kill()
        throw new CortexError('busy', 'the memory is being restored from a backup; try again in a moment')
      }
      await this.start()
      this.lastUsedMs = Date.now()
      const res = await this.request('tools/call', { name, arguments: args })
      return parseToolResult(name, res) as T
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => undefined)
    return p
  }

  private start(): Promise<void> {
    if (this.ready !== undefined && this.proc !== undefined && this.proc.exitCode === null) return this.ready
    const bin = cortexdbBinary(this.envBase)
    if (bin === undefined) return Promise.reject(new CortexError('not_installed', 'CortexDB is not installed; run `buracle install`'))
    try { mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 }) } catch {  }
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(cortexdbLaunch(bin), { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: cortexEnv(this.dbPath, this.envBase) })
    } catch (e) {
      return Promise.reject(new CortexError('start_failed', `cannot start ${bin.path}: ${(e as Error).message}`, { cause: e }))
    }
    this.proc = proc
    this.buf = ''
    registerChild(this.dbPath, proc.pid)
    void this.pump(proc)
    void this.drainStderr(proc)
    void proc.exited.then(code => {
      unregisterChild(this.dbPath, proc.pid)
      if (this.proc !== proc) return
      this.proc = undefined
      this.ready = undefined
      this.failAll(new CortexError('exited', `cortexdb-mcp exited with code ${code}`))
    })
    const holder = restoreHolder(this.dbPath)
    if (holder !== undefined && holder !== process.pid) {
      this.kill()
      return Promise.reject(new CortexError('busy', 'the memory is being restored from a backup; try again in a moment'))
    }
    this.ready = (async () => {
      await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'buracle', version: '1' } })
      this.notify('notifications/initialized')
    })()
    this.ready.catch(() => { this.ready = undefined })
    return this.ready
  }

  private async pump(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const out = proc.stdout
    if (!(out instanceof ReadableStream)) return
    const reader = out.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        this.buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).trim()
          this.buf = this.buf.slice(nl + 1)
          if (line !== '') this.onLine(line)
        }
      }
    } catch {  }
  }

  private async drainStderr(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const err = proc.stderr
    if (!(err instanceof ReadableStream)) return
    try {
      const text = await new Response(err).text()
      if (text.trim() !== '') log('debug', 'cortexdb: stderr', { db: this.dbPath, text: text.slice(0, 2000) })
    } catch {  }
  }

  private onLine(line: string): void {
    let msg: unknown
    try { msg = JSON.parse(line) } catch { log('warn', 'cortexdb: a line that is not JSON', { line: line.slice(0, 200) }); return }
    if (msg === null || typeof msg !== 'object') return
    const m = msg as { id?: unknown, result?: unknown, error?: { message?: unknown } }
    if (typeof m.id !== 'number') return
    const p = this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.error !== undefined) p.reject(new CortexError('protocol', `cortexdb: ${String(m.error?.message ?? 'error')}`))
    else p.resolve(m.result)
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const proc = this.proc
    if (proc === undefined) return Promise.reject(new CortexError('exited', 'cortexdb-mcp is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CortexError('timeout', `cortexdb ${method} did not answer within ${this.timeoutMs} ms`))
        this.kill()
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        const sink = proc.stdin as unknown as { write(s: string): void, flush?: () => void }
        sink.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
        sink.flush?.()
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new CortexError('exited', `cannot write to cortexdb-mcp: ${(e as Error).message}`, { cause: e }))
      }
    })
  }

  private notify(method: string): void {
    try {
      const sink = this.proc?.stdin as unknown as { write(s: string): void, flush?: () => void } | undefined
      sink?.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
      sink?.flush?.()
    } catch {  }
  }

  private failAll(e: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(e)
      this.pending.delete(id)
    }
  }

  private kill(): void {
    const proc = this.proc
    this.proc = undefined
    this.ready = undefined
    try { proc?.kill() } catch {  }
  }

  async close(): Promise<void> {
    this.closed = true
    const proc = this.proc
    this.proc = undefined
    this.ready = undefined
    this.failAll(new CortexError('exited', 'the CortexDB client is closed'))
    if (proc === undefined) return
    try { (proc.stdin as unknown as { end(): void }).end() } catch {  }
    const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(1500).then(() => false)])
    if (!exited) { try { proc.kill() } catch {  } }
  }

  idle(): void {
    if (this.pending.size > 0) return
    this.kill()
  }
}

export function parseToolResult(name: string, res: unknown): unknown {
  if (res === null || typeof res !== 'object') throw new CortexError('protocol', `cortexdb ${name}: empty result`)
  const r = res as { isError?: unknown, structuredContent?: unknown, content?: Array<{ type?: unknown, text?: unknown }> }
  const text = Array.isArray(r.content) ? r.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n') : ''
  if (r.isError === true) {
    if (/not found/i.test(text)) throw new CortexError('not_found', `cortexdb ${name}: ${text.slice(0, 300)}`)
    throw new CortexError('tool_error', `cortexdb ${name}: ${text.slice(0, 300) || 'error'}`)
  }
  if (r.structuredContent !== undefined && r.structuredContent !== null) return r.structuredContent
  try { return JSON.parse(text) } catch { return { text } }
}

const clients = new Map<string, CortexClient>()

export function cortexFor(dbPath: string, opts: CortexOptions = {}): CortexClient {
  let c = clients.get(dbPath)
  if (c === undefined) {
    c = new CortexClient(dbPath, opts)
    clients.set(dbPath, c)
  }
  return c
}

export async function closeAllCortex(): Promise<void> {
  const all = [...clients.values()]
  clients.clear()
  await Promise.all(all.map(c => c.close()))
}

export async function closeCortex(dbPath: string): Promise<void> {
  const c = clients.get(dbPath)
  if (c === undefined) return
  clients.delete(dbPath)
  await c.close()
}

export function idleCortex(idleMs: number, nowMs = Date.now()): void {
  for (const c of clients.values()) if (nowMs - c.lastUsedMs > idleMs) c.idle()
}

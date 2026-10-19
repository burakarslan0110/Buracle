import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { realPath } from '../fsx'
import { spawnArgv, windowsVerbatim } from '../platform'
import { type FileChange, type FileWatcher, watcherWants, watchersOf } from './lsp-watch'

export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspDiagnostic { range: LspRange; severity?: number; code?: string | number | { value?: unknown }; source?: string; message: string }

export class LspError extends Error {
  constructor(message: string, readonly code?: number) { super(message) }
}

export function fileUri(path: string): string {
  return pathToFileURL(resolve(path)).href
}

export function uriPath(uri: string): string | undefined {
  try { return fileURLToPath(uri) } catch { return undefined }
}

export function pathKey(path: string): string {
  let p = resolve(path)
  try { p = realPath(p) } catch {  }
  return process.platform === 'win32' ? p.toLowerCase() : p
}

export function encodeMessage(msg: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(msg))
  const head = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`)
  const out = new Uint8Array(head.length + body.length)
  out.set(head, 0)
  out.set(body, head.length)
  return out
}

function headerEnd(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i
  }
  return -1
}

export class MessageReader {
  private buf = new Uint8Array(0)
  private readonly dec = new TextDecoder()

  push(chunk: Uint8Array): unknown[] {
    const next = new Uint8Array(this.buf.length + chunk.length)
    next.set(this.buf, 0)
    next.set(chunk, this.buf.length)
    this.buf = next
    const out: unknown[] = []
    for (;;) {
      const end = headerEnd(this.buf)
      if (end < 0) break
      const head = this.dec.decode(this.buf.subarray(0, end))
      const len = Number(/Content-Length:\s*(\d+)/i.exec(head)?.[1] ?? NaN)
      if (!Number.isFinite(len)) { this.buf = this.buf.slice(end + 4); continue }
      if (this.buf.length < end + 4 + len) break
      const body = this.dec.decode(this.buf.subarray(end + 4, end + 4 + len))
      this.buf = this.buf.slice(end + 4 + len)
      try { out.push(JSON.parse(body)) } catch {  }
    }
    return out
  }
}

const SYMBOL_KINDS = Array.from({ length: 26 }, (_, i) => i + 1)

export const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  window: { workDoneProgress: true, showDocument: { support: false } },
  workspace: {
    configuration: true,
    workspaceFolders: true,
    applyEdit: false,
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    symbol: { dynamicRegistration: false, symbolKind: { valueSet: SYMBOL_KINDS } },
    diagnostics: { refreshSupport: true },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: true, willSave: false, willSaveWaitUntil: false },
    publishDiagnostics: { relatedInformation: false, versionSupport: true },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    definition: { dynamicRegistration: false, linkSupport: true },
    declaration: { dynamicRegistration: false, linkSupport: true },
    typeDefinition: { dynamicRegistration: false, linkSupport: true },
    implementation: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: SYMBOL_KINDS } },
  },
} as const

export interface LspClientOptions {
  argv: readonly string[]
  rootDir: string
  env?: Record<string, string | undefined>
  clientVersion?: string
  initializationOptions?: unknown
  initTimeoutMs?: number
  now?: () => number
}

export interface DiagnosticsReport { items: LspDiagnostic[]; seq: number; version?: number }

export interface LspDocument { uri: string; path: string; key: string; languageId: string; version: number; text: string; mtimeMs: number; size: number; syncedSeq: number; gen: number; prior?: DiagnosticsReport }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

const FILE_MAX_BYTES = 4 * 1024 * 1024

export class LspClient {
  readonly rootDir: string
  readonly rootUri: string
  readonly startedAt: number
  state: 'starting' | 'ready' | 'failed' | 'exited' = 'starting'
  error: string | undefined
  capabilities: Record<string, unknown> = {}
  serverName: string | undefined
  lastUsed: number
  private readonly now: () => number
  private readonly proc: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>
  private readonly pending = new Map<number, Pending>()
  private readonly docs = new Map<string, LspDocument>()
  private readonly diags = new Map<string, DiagnosticsReport>()
  private readonly waiters = new Set<() => void>()
  private readonly progress = new Map<string, string>()
  private readonly watchers = new Map<string, FileWatcher[]>()
  private readonly init: Promise<void>
  private nextId = 1
  private seq = 0
  private gen = 0
  private stderrTail = ''
  private notices: string[] = []

  private constructor(opts: LspClientOptions) {
    this.now = opts.now ?? Date.now
    this.rootDir = opts.rootDir
    this.rootUri = fileUri(opts.rootDir)
    this.startedAt = this.now()
    this.lastUsed = this.startedAt
    const spawned = spawnArgv(opts.argv)
    this.proc = Bun.spawn(spawned, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: opts.rootDir, env: { ...process.env, ...(opts.env ?? {}) }, windowsVerbatimArguments: windowsVerbatim(spawned) })
    void this.readStdout()
    void this.readStderr()
    void this.proc.exited.then(code => this.onExit(code))
    this.init = this.initialize(opts)
    this.init.catch(() => undefined)
    const limit = opts.initTimeoutMs ?? 0
    if (limit > 0) {
      const timer = setTimeout(() => {
        if (this.state !== 'starting') return
        this.state = 'failed'
        this.error = `no answer to initialize within ${Math.round(limit / 1000)} s${this.stderr() !== '' ? ` (stderr: ${this.stderr()})` : ''}`
        try { this.proc.kill('SIGKILL') } catch {  }
      }, limit)
      void this.init.then(() => clearTimeout(timer), () => clearTimeout(timer))
    }
  }

  static start(opts: LspClientOptions): LspClient {
    return new LspClient(opts)
  }

  get pid(): number { return this.proc.pid }

  stderr(): string {
    return this.stderrTail.trim().split('\n').slice(-3).join(' / ').slice(0, 400)
  }

  messages(): string[] {
    return [...this.notices]
  }

  busy(): string[] {
    return [...new Set(this.progress.values())].filter(t => t !== '').sort()
  }

  async ready(timeoutMs: number): Promise<boolean> {
    if (this.state === 'ready') return true
    if (this.state === 'failed' || this.state === 'exited') throw new LspError(this.error ?? 'the language server is not running')
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>(r => { timer = setTimeout(() => r('late'), Math.max(0, timeoutMs)) })
    try {
      const r = await Promise.race([this.init.then(() => 'ok' as const), late])
      return r === 'ok'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async initialize(opts: LspClientOptions): Promise<void> {
    try {
      const result = await this.request('initialize', {
        processId: process.pid,
        clientInfo: { name: 'buracle-lsp', version: opts.clientVersion ?? '0' },
        locale: 'en',
        rootPath: this.rootDir,
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: basename(this.rootDir) || this.rootDir }],
        capabilities: CLIENT_CAPABILITIES,
        ...(opts.initializationOptions !== undefined ? { initializationOptions: opts.initializationOptions } : {}),
        trace: 'off',
      }, 0)
      const r = isObj(result) ? result : {}
      this.capabilities = isObj(r['capabilities']) ? r['capabilities'] : {}
      const info = isObj(r['serverInfo']) ? r['serverInfo'] : {}
      if (typeof info['name'] === 'string') this.serverName = info['name']
      this.notify('initialized', {})
      this.notify('workspace/didChangeConfiguration', { settings: {} })
      if (this.state === 'starting') this.state = 'ready'
    } catch (e) {
      if (this.state === 'starting') {
        this.state = 'failed'
        const tail = this.stderr()
        this.error = `initialize failed: ${e instanceof Error ? e.message : String(e)}${tail !== '' ? ` (stderr: ${tail})` : ''}`
      }
      throw e
    }
  }

  private write(msg: unknown): void {
    if (this.state === 'exited') return
    try {
      this.proc.stdin.write(encodeMessage(msg))
      const flushed = this.proc.stdin.flush()
      if (flushed instanceof Promise) flushed.catch(() => undefined)
    } catch {  }
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.state === 'exited' || this.state === 'failed') return Promise.reject(new LspError(this.error ?? 'the language server is not running'))
    const id = this.nextId++
    return new Promise<unknown>((resolveP, reject) => {
      const p: Pending = { resolve: resolveP, reject }
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id)
          this.notify('$/cancelRequest', { id })
          reject(new LspError(`${method} got no answer within ${Math.round(timeoutMs / 1000)} s`))
        }, timeoutMs)
      }
      this.pending.set(id, p)
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private async readStdout(): Promise<void> {
    const reader = new MessageReader()
    try {
      for await (const chunk of this.proc.stdout) for (const msg of reader.push(chunk)) this.onMessage(msg)
    } catch {  }
  }

  private async readStderr(): Promise<void> {
    const dec = new TextDecoder()
    try {
      for await (const chunk of this.proc.stderr) this.stderrTail = (this.stderrTail + dec.decode(chunk, { stream: true })).slice(-4000)
    } catch {  }
  }

  private onExit(code: number | null): void {
    const was = this.state
    this.state = 'exited'
    if (this.error === undefined) {
      const tail = this.stderr()
      this.error = `${was === 'starting' ? 'exited before it answered initialize' : 'exited'} (code ${code ?? '?'})${tail !== '' ? `: ${tail}` : ''}`
    }
    for (const p of this.pending.values()) {
      if (p.timer !== undefined) clearTimeout(p.timer)
      p.reject(new LspError(this.error))
    }
    this.pending.clear()
    this.wake()
  }

  private wake(): void {
    for (const w of [...this.waiters]) w()
  }

  private reply(id: unknown, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  private onMessage(msg: unknown): void {
    if (!isObj(msg)) return
    const method = msg['method']
    const id = msg['id']
    if (typeof method !== 'string') {
      if (typeof id !== 'number') return
      const p = this.pending.get(id)
      if (p === undefined) return
      this.pending.delete(id)
      if (p.timer !== undefined) clearTimeout(p.timer)
      const err = msg['error']
      if (isObj(err)) p.reject(new LspError(typeof err['message'] === 'string' ? err['message'] : 'error', typeof err['code'] === 'number' ? err['code'] : undefined))
      else p.resolve(msg['result'])
      return
    }
    const params = isObj(msg['params']) ? msg['params'] : {}
    if (id !== undefined && id !== null) { this.onServerRequest(id, method, params); return }
    if (method === 'textDocument/publishDiagnostics') {
      const path = typeof params['uri'] === 'string' ? uriPath(params['uri']) : undefined
      if (path === undefined) return
      const items = Array.isArray(params['diagnostics']) ? params['diagnostics'].filter(isObj) as unknown as LspDiagnostic[] : []
      const report: DiagnosticsReport = { items, seq: ++this.seq }
      if (typeof params['version'] === 'number') report.version = params['version']
      this.diags.set(pathKey(path), report)
      this.wake()
    } else if (method === 'window/showMessage') {
      const type = params['type']
      const text = typeof params['message'] === 'string' ? params['message'].trim() : ''
      if ((type === 1 || type === 2) && text !== '' && !this.notices.includes(text)) this.notices = [...this.notices, text].slice(-3)
    } else if (method === '$/progress') {
      const token = String(params['token'] ?? '')
      const value = isObj(params['value']) ? params['value'] : {}
      if (value['kind'] === 'begin') this.progress.set(token, typeof value['title'] === 'string' ? value['title'] : '')
      else if (value['kind'] === 'end') { this.progress.delete(token); this.wake() }
    }
  }

  private onServerRequest(id: unknown, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'workspace/configuration':
        this.reply(id, (Array.isArray(params['items']) ? params['items'] : []).map(() => null))
        return
      case 'workspace/workspaceFolders':
        this.reply(id, [{ uri: this.rootUri, name: basename(this.rootDir) || this.rootDir }])
        return
      case 'workspace/applyEdit':
        this.reply(id, { applied: false, failureReason: 'the Buracle bridge is read-only' })
        return
      case 'window/showDocument':
        this.reply(id, { success: false })
        return
      case 'client/registerCapability':
        for (const r of Array.isArray(params['registrations']) ? params['registrations'] : []) {
          if (isObj(r) && r['method'] === 'workspace/didChangeWatchedFiles' && typeof r['id'] === 'string') this.watchers.set(r['id'], watchersOf(r['registerOptions']))
        }
        this.reply(id, null)
        return
      case 'client/unregisterCapability':
        for (const r of [params['unregisterations'], params['unregistrations']].flatMap(x => (Array.isArray(x) ? x : []))) {
          if (isObj(r) && typeof r['id'] === 'string') this.watchers.delete(r['id'])
        }
        this.reply(id, null)
        return
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
      case 'workspace/diagnostic/refresh':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/inlineValue/refresh':
      case 'workspace/codeLens/refresh':
        this.reply(id, null)
        return
      default:
        this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  }

  private saveWanted(): { includeText: boolean } | undefined {
    const sync = this.capabilities['textDocumentSync']
    if (!isObj(sync)) return undefined
    const save = sync['save']
    if (save === true) return { includeText: false }
    if (isObj(save)) return { includeText: save['includeText'] === true }
    return undefined
  }

  private syncKind(): number {
    const sync = this.capabilities['textDocumentSync']
    if (typeof sync === 'number') return sync
    if (isObj(sync) && typeof sync['change'] === 'number') return sync['change']
    return 1
  }

  private sendText(doc: LspDocument): void {
    if (this.syncKind() === 0) {
      this.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
      this.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId: doc.languageId, version: doc.version, text: doc.text } })
    } else {
      this.notify('textDocument/didChange', { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text: doc.text }] })
    }
    const save = this.saveWanted()
    if (save !== undefined) this.notify('textDocument/didSave', { textDocument: { uri: doc.uri }, ...(save.includeText ? { text: doc.text } : {}) })
  }

  sync(path: string, languageId: string): { doc: LspDocument, changed: boolean } {
    const key = pathKey(path)
    const st = statSync(path)
    if (!st.isFile()) throw new LspError(`${path} is not a file`)
    if (st.size > FILE_MAX_BYTES) throw new LspError(`${path} is larger than ${FILE_MAX_BYTES / 1024 / 1024} MB`)
    const open = this.docs.get(key)
    if (open !== undefined && open.mtimeMs === st.mtimeMs && open.size === st.size) return { doc: open, changed: false }
    const text = readFileSync(path, 'utf8')
    const before = this.seq
    if (open === undefined) {
      const doc: LspDocument = { uri: fileUri(path), path, key, languageId, version: 1, text, mtimeMs: st.mtimeMs, size: st.size, syncedSeq: before, gen: this.gen }
      this.docs.set(key, doc)
      this.notify('textDocument/didOpen', { textDocument: { uri: doc.uri, languageId, version: 1, text } })
      return { doc, changed: true }
    }
    open.mtimeMs = st.mtimeMs
    open.size = st.size
    if (open.text === text) return { doc: open, changed: false }
    open.text = text
    open.version += 1
    open.syncedSeq = before
    open.gen = ++this.gen
    delete open.prior
    this.diags.delete(key)
    this.sendText(open)
    return { doc: open, changed: true }
  }

  refreshOpen(except: ReadonlySet<string> = new Set()): void {
    for (const doc of [...this.docs.values()]) {
      if (except.has(doc.key)) continue
      let gone = false
      try { gone = !statSync(doc.path).isFile() } catch { gone = true }
      if (gone) {
        this.docs.delete(doc.key)
        this.diags.delete(doc.key)
        this.gen += 1
        this.notify('textDocument/didClose', { textDocument: { uri: doc.uri } })
        continue
      }
      try { this.sync(doc.path, doc.languageId) } catch {  }
    }
  }

  filesChanged(changes: readonly FileChange[]): FileChange[] {
    if (changes.length === 0) return []
    this.gen += 1
    const watchers = [...this.watchers.values()].flat()
    const send = changes.filter(c => !this.docs.has(pathKey(c.path)) && (this.watchers.size === 0 || watchers.some(w => watcherWants(w, c))))
    if (send.length > 0) this.notify('workspace/didChangeWatchedFiles', { changes: send.map(c => ({ uri: fileUri(c.path), type: c.type })) })
    return send
  }

  freshen(doc: LspDocument): boolean {
    if (doc.gen >= this.gen) return false
    doc.gen = this.gen
    if (this.supportsPull()) return false
    const valid = this.pushed(doc)
    if (valid !== undefined) doc.prior = valid
    doc.version += 1
    doc.syncedSeq = this.seq
    this.sendText(doc)
    return true
  }

  text(path: string): string | undefined {
    return this.docs.get(pathKey(path))?.text
  }

  supportsPull(): boolean {
    return this.capabilities['diagnosticProvider'] !== undefined && this.capabilities['diagnosticProvider'] !== null && this.capabilities['diagnosticProvider'] !== false
  }

  async pullDiagnostics(doc: LspDocument, deadline: number): Promise<LspDiagnostic[]> {
    const provider = this.capabilities['diagnosticProvider']
    const identifier = isObj(provider) && typeof provider['identifier'] === 'string' ? provider['identifier'] : undefined
    for (;;) {
      const left = deadline - this.now()
      if (left <= 0) throw new LspError('no diagnostics report in time')
      try {
        const r = await this.request('textDocument/diagnostic', { textDocument: { uri: doc.uri }, ...(identifier !== undefined ? { identifier } : {}) }, left)
        const report = isObj(r) ? r : {}
        const items = Array.isArray(report['items']) ? report['items'].filter(isObj) as unknown as LspDiagnostic[] : []
        if (report['kind'] === 'unchanged') return this.diags.get(doc.key)?.items ?? []
        this.diags.set(doc.key, { items, seq: ++this.seq, version: doc.version })
        return items
      } catch (e) {
        if (e instanceof LspError && e.code === -32802) { await Bun.sleep(Math.min(500, Math.max(0, deadline - this.now()))); continue }
        throw e
      }
    }
  }

  pushed(doc: LspDocument): DiagnosticsReport | undefined {
    const r = this.diags.get(doc.key)
    if (r === undefined || r.seq <= doc.syncedSeq) return undefined
    if (r.version !== undefined && r.version < doc.version) return undefined
    return r
  }

  async waitPushed(doc: LspDocument, deadline: number, settleMs: number): Promise<DiagnosticsReport | undefined> {
    let first = this.pushed(doc)
    while (first === undefined && this.now() < deadline && this.state === 'ready') {
      await this.until(deadline)
      first = this.pushed(doc)
    }
    if (first === undefined) return undefined
    let last = first
    const settleEnd = Math.min(deadline, this.now() + settleMs * 6)
    while (this.state === 'ready' && this.now() < settleEnd) {
      const quietUntil = Math.min(settleEnd, this.now() + settleMs)
      let next = this.pushed(doc)
      while ((next === undefined || next.seq === last.seq) && this.state === 'ready' && this.now() < quietUntil) {
        await this.until(quietUntil)
        next = this.pushed(doc)
      }
      if (next === undefined || next.seq === last.seq) break
      last = next
    }
    return last
  }

  private until(deadline: number): Promise<void> {
    return new Promise<void>(res => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); res() }
      const timer = setTimeout(done, Math.max(0, deadline - this.now()))
      this.waiters.add(done)
    })
  }

  async shutdown(graceMs = 1500): Promise<void> {
    if (this.state === 'exited') return
    if (this.state === 'ready') {
      try { await this.request('shutdown', null, graceMs) } catch {  }
      this.notify('exit', null)
    }
    try { this.proc.stdin.end() } catch {  }
    const quit = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(graceMs).then(() => false)])
    if (!quit) { try { this.proc.kill('SIGKILL') } catch {  } }
  }
}

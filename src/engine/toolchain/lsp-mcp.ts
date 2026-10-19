import { readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { log } from '../log'
import { augmentedPath } from '../platform'
import { type LspLaunch, type LspServer, lspLaunch, lspRoot, lspServerFor, lspServers, readToolsCatalog } from './lsp'
import { LspClient, type LspDiagnostic, type LspDocument, LspError, pathKey, uriPath } from './lsp-client'
import { type EditReport, serveEditRequests } from './lsp-edits'
import { scanMatcher, WorkspaceScan } from './lsp-watch'
import {
  countLabel, diagnosticLines, displayPath, hoverText, type LineReader, locationLine, locationsOf, outlineLines, splitLines,
  symbolColumn, toCharacter, workspaceSymbolLines,
} from './lsp-format'
import { readToolchainState } from './state'

export const LSP_MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const

export const LSP_MCP_INSTRUCTIONS = 'Buracle language servers (pyright, typescript-language-server, gopls, rust-analyzer, csharp-ls, jdtls) answer for the files on this machine: diagnostics after you edit a file (type errors the linters miss), hover for a symbol\'s type and docs, definition and references by file, line and symbol name, and a file\'s outline or a project-wide symbol search. Lines and columns count from 1. The first call for a language starts its server; when a tool says the server is still starting, call it again in a few seconds. codegraph stays first for callers and impact across the repository.'

export const LSP_TOOL_NAMES = ['diagnostics', 'hover', 'definition', 'references', 'symbols'] as const

const FILE = { type: 'string', description: 'A source file: an absolute path, or one relative to the folder the harness started in' }
const LINE = { type: 'integer', minimum: 1, description: 'Line number, counting from 1' }
const SYMBOL = { type: 'string', description: 'The name on that line to ask about (its first whole-word occurrence); give this or column' }
const COLUMN = { type: 'integer', minimum: 1, description: 'Column, counting from 1 in characters; give this or symbol' }
const READ_ONLY = { readOnlyHint: true, openWorldHint: false }

export function lspToolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      name: 'diagnostics',
      title: 'File diagnostics',
      description: 'Errors and warnings the language server reports for one or more files (type errors, unresolved names, syntax errors), read from disk as they are now. Run it after an edit, before you call the change done.',
      inputSchema: {
        type: 'object',
        properties: {
          file: FILE,
          files: { type: 'array', items: { type: 'string' }, maxItems: 19, description: 'More files to check in the same call' },
          wait_ms: { type: 'integer', minimum: 1000, maximum: 30000, default: 15000, description: 'How long to wait for the server\'s report' },
        },
        required: ['file'],
      },
      annotations: READ_ONLY,
    },
    {
      name: 'hover',
      title: 'Type and docs at a position',
      description: 'What the language server shows on hover: the type or signature and the docs of the symbol at a position.',
      inputSchema: { type: 'object', properties: { file: FILE, line: LINE, symbol: SYMBOL, column: COLUMN }, required: ['file', 'line'] },
      annotations: READ_ONLY,
    },
    {
      name: 'definition',
      title: 'Go to definition',
      description: 'Where the symbol at a position is defined (or declared, its type defined, or implemented), as file:line:column with the line\'s text.',
      inputSchema: {
        type: 'object',
        properties: {
          file: FILE, line: LINE, symbol: SYMBOL, column: COLUMN,
          kind: { type: 'string', enum: ['definition', 'declaration', 'type_definition', 'implementation'], default: 'definition' },
        },
        required: ['file', 'line'],
      },
      annotations: READ_ONLY,
    },
    {
      name: 'references',
      title: 'Find references',
      description: 'Every place the language server knows that uses the symbol at a position, as file:line:column with the line\'s text.',
      inputSchema: {
        type: 'object',
        properties: {
          file: FILE, line: LINE, symbol: SYMBOL, column: COLUMN,
          include_declaration: { type: 'boolean', default: true },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
        required: ['file', 'line'],
      },
      annotations: READ_ONLY,
    },
    {
      name: 'symbols',
      title: 'Outline or symbol search',
      description: 'Without query: the outline of a file (classes, functions, methods with their lines). With query: a search by name across the project the file belongs to.',
      inputSchema: {
        type: 'object',
        properties: {
          file: FILE,
          query: { type: 'string', description: 'A name or part of one to search for in the whole project' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        },
        required: ['file'],
      },
      annotations: READ_ONLY,
    },
  ]
}

export interface LspBridgeOptions {
  cwd: string
  version?: string
  servers?: readonly LspServer[]
  launch?: (s: LspServer) => LspLaunch | { error: string }
  env?: Record<string, string | undefined>
  idleMs?: number
  maxClients?: number
  budgetMs?: number
  initWaitMs?: number
  scanMaxEntries?: number
  now?: () => number
}

interface Slot { key: string; server: LspServer; root: string; client: LspClient; scan: WorkspaceScan; chain: Promise<unknown>; starts: number[] }

export interface LspBridge {
  handle(message: unknown): Promise<unknown>
  handleLine(line: string): Promise<string | undefined>
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>
  afterEdit(file: string, waitMs: number): Promise<EditReport>
  sweep(): Promise<number>
  close(): Promise<void>
  running(): Array<{ id: string, root: string, pid: number, state: string }>
}

class ToolFailure extends Error {}

type RpcId = string | number | null

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function rpcError(id: RpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function textResult(text: string, isError = false): Record<string, unknown> {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] }
}

function intArg(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = args[key]
  if (v === undefined || v === null) return def
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolFailure(`${key} must be a number`)
  return Math.min(max, Math.max(min, Math.floor(v)))
}

const RESTART_WINDOW_MS = 10 * 60_000
const MAX_STARTS = 4
const SETTLE_MS = 500
const EDIT_READY_WAIT_MS = 1500

export function createLspBridge(opts: LspBridgeOptions): LspBridge {
  const now = opts.now ?? Date.now
  const budget = opts.budgetMs ?? 40_000
  const initWait = opts.initWaitMs ?? 25_000
  const idleMs = opts.idleMs ?? 15 * 60_000
  const maxClients = opts.maxClients ?? 8
  const slots = new Map<string, Slot>()
  let servers: readonly LspServer[] | undefined = opts.servers
  let catalogError: string | undefined
  const launch = opts.launch ?? ((s: LspServer) => lspLaunch(s, readToolchainState()))
  const env = opts.env ?? { [Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH']: augmentedPath() }

  const serverList = (): readonly LspServer[] => {
    if (servers !== undefined) return servers
    try { servers = lspServers(readToolsCatalog()) } catch (e) { catalogError = e instanceof Error ? e.message : String(e); servers = [] }
    return servers
  }

  const show = (p: string) => displayPath(p, opts.cwd)

  const resolveFile = (raw: unknown): string => {
    if (typeof raw !== 'string' || raw.trim() === '') throw new ToolFailure('file is required (a path to a source file)')
    const given = raw.trim()
    const path = given.startsWith('file://') ? uriPath(given) : isAbsolute(given) ? given : resolve(opts.cwd, given)
    if (path === undefined) throw new ToolFailure(`${given} is not a file path or file:// URI`)
    let ok = false
    try { ok = statSync(path).isFile() } catch { ok = false }
    if (!ok) throw new ToolFailure(`${show(path)} does not exist or is not a file`)
    return path
  }

  const coverage = (): string => serverList().map(s => `${Object.keys(s.spec.extensions).sort().join(' ')} (${s.id})`).join('; ')

  async function shutdownSlot(slot: Slot, why: string): Promise<void> {
    slots.delete(slot.key)
    log('info', 'lsp mcp: stopping a language server', { id: slot.server.id, root: slot.root, pid: slot.client.pid, why })
    await slot.client.shutdown().catch(() => undefined)
  }

  async function slotFor(path: string): Promise<{ slot: Slot, languageId: string }> {
    const pick = lspServerFor(serverList(), path)
    if (pick === undefined) {
      if (catalogError !== undefined) throw new ToolFailure(`cannot read Buracle's language servers: ${catalogError}`)
      throw new ToolFailure(`no Buracle language server handles ${extname(path) || 'extension-less'} files; covered: ${coverage()}`)
    }
    const root = lspRoot(pick.server, path, { cwd: opts.cwd })
    const key = `${pick.server.id}\u0000${pathKey(root)}`
    let slot = slots.get(key)
    if (slot !== undefined && (slot.client.state === 'exited' || slot.client.state === 'failed')) {
      const recent = slot.starts.filter(t => now() - t < RESTART_WINDOW_MS)
      if (recent.length >= MAX_STARTS) throw new ToolFailure(`the ${pick.server.id} language server for ${show(root)} stopped ${recent.length} times in 10 minutes; last: ${slot.client.error ?? 'unknown error'}`)
      log('warn', 'lsp mcp: restarting a language server that stopped', { id: pick.server.id, root, error: slot.client.error })
      slot = { ...slot, ...startClient(pick.server, root), starts: [...recent, now()] }
      slots.set(key, slot)
    }
    if (slot === undefined) {
      if (slots.size >= maxClients) {
        const oldest = [...slots.values()].sort((a, b) => a.client.lastUsed - b.client.lastUsed)[0]
        if (oldest !== undefined) await shutdownSlot(oldest, 'too many language servers')
        slot = slots.get(key)
      }
      if (slot === undefined) {
        slot = { key, server: pick.server, root, ...startClient(pick.server, root), chain: Promise.resolve(), starts: [now()] }
        slots.set(key, slot)
      }
    }
    slot.client.lastUsed = now()
    return { slot, languageId: pick.languageId }
  }

  function startClient(server: LspServer, root: string): { client: LspClient, scan: WorkspaceScan } {
    const plan = launch(server)
    if ('error' in plan) throw new ToolFailure(plan.error)
    try {
      const scan = new WorkspaceScan(root, scanMatcher(server.spec), opts.scanMaxEntries)
      const client = LspClient.start({
        argv: plan.argv, rootDir: root, env, now,
        initTimeoutMs: Math.max(server.spec.startup_timeout_ms ?? 0, 90_000),
        ...(opts.version !== undefined ? { clientVersion: opts.version } : {}),
      })
      log('info', 'lsp mcp: started a language server', { id: server.id, root, pid: client.pid, argv: plan.argv, files: scan.size, partial: scan.partial })
      return { client, scan }
    } catch (e) {
      throw new ToolFailure(`cannot start the ${server.id} language server (${plan.argv[0] ?? '?'}): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const remaining = (deadline: number): number => Math.max(250, deadline - now())

  function syncWorkspace(slot: Slot, except: ReadonlySet<string>): void {
    slot.client.refreshOpen(except)
    const sent = slot.client.filesChanged(slot.scan.changes())
    if (sent.length > 0) log('debug', 'lsp mcp: files changed on disk', { id: slot.server.id, root: slot.root, files: sent.length })
  }

  function serial<T>(slot: Slot, fn: () => Promise<T>): Promise<T> {
    const p = slot.chain.then(fn, fn)
    slot.chain = p.catch(() => undefined)
    return p
  }

  async function onReady<T>(slot: Slot, deadline: number, fn: () => Promise<T>): Promise<T | string> {
    const up = await slot.client.ready(Math.min(initWait, deadline - now()))
    if (!up) {
      const secs = Math.round((now() - slot.client.startedAt) / 1000)
      return `The ${slot.server.id} language server is still starting for ${show(slot.root)} (${secs} s so far; large projects take longer on the first start). Call this tool again in a few seconds.`
    }
    return serial(slot, fn)
  }

  const lineCache = (slot: Slot): LineReader => {
    const cache = new Map<string, string[] | undefined>()
    return (p: string) => {
      if (cache.has(p)) return cache.get(p)
      let lines: string[] | undefined
      const open = slot.client.text(p)
      if (open !== undefined) lines = splitLines(open)
      else {
        try { lines = statSync(p).size <= 2 * 1024 * 1024 ? splitLines(readFileSync(p, 'utf8')) : undefined } catch { lines = undefined }
      }
      cache.set(p, lines)
      return lines
    }
  }

  function position(doc: LspDocument, args: Record<string, unknown>): { line: number, character: number, label: string } {
    const lines = splitLines(doc.text)
    const line = args['line']
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) throw new ToolFailure('line is required: a line number counting from 1')
    const text = lines[line - 1]
    if (text === undefined) throw new ToolFailure(`line ${line} is past the end of ${show(doc.path)} (${lines.length} lines)`)
    const symbol = typeof args['symbol'] === 'string' && args['symbol'].trim() !== '' ? args['symbol'].trim() : undefined
    let column: number | undefined
    if (symbol !== undefined) {
      column = symbolColumn(text, symbol)
      if (column === undefined) throw new ToolFailure(`'${symbol}' is not on line ${line} of ${show(doc.path)}: ${text.trim().slice(0, 160)}`)
    } else if (typeof args['column'] === 'number' && Number.isInteger(args['column']) && args['column'] >= 1) {
      column = args['column']
    } else {
      throw new ToolFailure('give symbol (the name on that line) or column (counting from 1)')
    }
    const label = `${show(doc.path)}:${line}:${column}${symbol !== undefined ? ` (\`${symbol}\`)` : ''}`
    return { line: line - 1, character: toCharacter(text, column), label }
  }

  function needs(slot: Slot, capability: string, what: string): void {
    const v = slot.client.capabilities[capability]
    if (v === undefined || v === null || v === false) throw new ToolFailure(`the ${slot.server.id} language server does not offer ${what}`)
  }

  async function diagnostics(args: Record<string, unknown>): Promise<string> {
    const extra = Array.isArray(args['files']) ? args['files'] : []
    const raw = [args['file'], ...extra].slice(0, 20)
    const byPath = new Map<string, string>()
    const order: string[] = []
    for (const r of raw) {
      try {
        const path = resolveFile(r)
        if (!order.includes(path)) order.push(path)
      } catch (e) {
        if (raw.length === 1 || !(e instanceof ToolFailure)) throw e
        const label = typeof r === 'string' ? r.trim() : String(r)
        if (!order.includes(label)) order.push(label)
        byPath.set(label, e.message)
      }
    }
    const files = order.filter(p => !byPath.has(p))
    const waitMs = intArg(args, 'wait_ms', 15_000, 1000, 30_000)
    const deadline = now() + Math.min(budget, waitMs + initWait)
    const groups = new Map<Slot, Array<{ path: string, languageId: string }>>()
    for (const path of files) {
      try {
        const { slot, languageId } = await slotFor(path)
        const list = groups.get(slot) ?? []
        list.push({ path, languageId })
        groups.set(slot, list)
      } catch (e) {
        if (order.length === 1 || !(e instanceof ToolFailure)) throw e
        byPath.set(path, `${show(path)}: ${e.message}`)
      }
    }
    await Promise.all([...groups.entries()].map(async ([slot, list]) => {
      const out = await onReady(slot, deadline, async () => {
        for (const r of await reportsFor(slot, list, waitMs, deadline)) byPath.set(r.path, r.text)
        return ''
      })
      if (typeof out === 'string' && out !== '') for (const f of list) byPath.set(f.path, `${show(f.path)}: ${out}`)
    }))
    return order.map(path => byPath.get(path) ?? `${show(path)}: no report`).join('\n\n')
  }

  async function reportsFor(slot: Slot, list: ReadonlyArray<{ path: string, languageId: string }>, waitMs: number, deadline: number): Promise<Array<{ path: string, items?: LspDiagnostic[], text: string }>> {
    syncWorkspace(slot, new Set(list.map(f => pathKey(f.path))))
    const docs = list.map(f => slot.client.sync(f.path, f.languageId).doc)
    for (const doc of docs) slot.client.freshen(doc)
    const waitEnd = Math.min(deadline, now() + waitMs)
    const out: Array<{ path: string, items?: LspDiagnostic[], text: string }> = []
    for (const doc of docs) {
      let items: LspDiagnostic[] | undefined
      let older = false
      if (slot.client.supportsPull()) {
        try { items = await slot.client.pullDiagnostics(doc, waitEnd) } catch (e) { items = undefined; if (!(e instanceof LspError)) throw e }
      }
      if (items === undefined) items = (await slot.client.waitPushed(doc, waitEnd, SETTLE_MS))?.items
      if (items === undefined && doc.prior !== undefined && slot.client.state === 'ready') { items = doc.prior.items; older = true }
      const head = `${show(doc.path)} (${slot.server.id})`
      if (items === undefined && slot.client.state !== 'ready') throw new LspError(`the ${slot.server.id} language server stopped: ${slot.client.error ?? 'unknown error'}`)
      if (items === undefined) {
        const busy = slot.client.busy()
        out.push({ path: doc.path, text: `${head}: no report yet${busy.length > 0 ? ` (the server is busy: ${busy.join(', ')})` : ''}; call again in a few seconds` })
      } else {
        const said = slot.client.messages().map(m => `  the server says: ${m.split('\n')[0]?.slice(0, 300) ?? ''}`)
        const note = older ? ' (no new report after other files changed, so this one may be older than those edits)' : ''
        out.push({ path: doc.path, items, text: [`${head}: ${countLabel(items)}${note}`, ...diagnosticLines(items, splitLines(doc.text), 50), ...said].join('\n') })
      }
    }
    return out
  }

  async function afterEdit(file: string, waitMs: number): Promise<EditReport> {
    try {
      let path: string
      try { path = resolveFile(file) } catch { return { state: 'none' } }
      if (lspServerFor(serverList(), path) === undefined) return { state: 'none' }
      const started = now()
      const wait = Math.max(250, Math.min(waitMs, budget))
      const { slot, languageId } = await slotFor(path)
      if (!(await slot.client.ready(Math.min(EDIT_READY_WAIT_MS, wait)))) return { state: 'starting' }
      const left = Math.max(250, wait - (now() - started))
      const [r] = await serial(slot, () => reportsFor(slot, [{ path, languageId }], left, now() + left))
      if (r?.items === undefined) return { state: 'pending' }
      return r.items.length > 0 ? { state: 'report', text: r.text } : { state: 'clean' }
    } catch (e) {
      return { state: 'error', text: e instanceof Error ? e.message : String(e) }
    }
  }

  const DEFINITION_METHODS: Record<string, { method: string, capability: string, what: string }> = {
    definition: { method: 'textDocument/definition', capability: 'definitionProvider', what: 'definitions' },
    declaration: { method: 'textDocument/declaration', capability: 'declarationProvider', what: 'declarations' },
    type_definition: { method: 'textDocument/typeDefinition', capability: 'typeDefinitionProvider', what: 'type definitions' },
    implementation: { method: 'textDocument/implementation', capability: 'implementationProvider', what: 'implementations' },
  }

  async function atPosition(args: Record<string, unknown>, run: (slot: Slot, doc: LspDocument, pos: { line: number, character: number, label: string }, deadline: number) => Promise<string>): Promise<string> {
    const path = resolveFile(args['file'])
    const deadline = now() + budget
    const { slot, languageId } = await slotFor(path)
    const out = await onReady(slot, deadline, async () => {
      syncWorkspace(slot, new Set([pathKey(path)]))
      const { doc } = slot.client.sync(path, languageId)
      return run(slot, doc, position(doc, args), deadline)
    })
    return out
  }

  async function hover(args: Record<string, unknown>): Promise<string> {
    return atPosition(args, async (slot, doc, pos, deadline) => {
      needs(slot, 'hoverProvider', 'hover')
      const r = await slot.client.request('textDocument/hover', { textDocument: { uri: doc.uri }, position: { line: pos.line, character: pos.character } }, remaining(deadline))
      const text = hoverText(r)
      return text === '' ? `No hover information at ${pos.label}.` : `${pos.label}\n${text.length > 6000 ? `${text.slice(0, 6000)}\n...` : text}`
    })
  }

  async function definition(args: Record<string, unknown>): Promise<string> {
    const kind = typeof args['kind'] === 'string' ? args['kind'] : 'definition'
    const m = DEFINITION_METHODS[kind]
    if (m === undefined) throw new ToolFailure(`kind must be one of ${Object.keys(DEFINITION_METHODS).join(', ')}`)
    return atPosition(args, async (slot, doc, pos, deadline) => {
      needs(slot, m.capability, m.what)
      const r = await slot.client.request(m.method, { textDocument: { uri: doc.uri }, position: { line: pos.line, character: pos.character } }, remaining(deadline))
      const locs = locationsOf(r)
      if (locs.length === 0) return `No ${kind.replace('_', ' ')} found for ${pos.label}.`
      const lines = lineCache(slot)
      return [`${locs.length} location${locs.length === 1 ? '' : 's'} (${kind.replace('_', ' ')}) for ${pos.label}:`, ...locs.slice(0, 50).map(l => locationLine(l, opts.cwd, lines))].join('\n')
    })
  }

  async function references(args: Record<string, unknown>): Promise<string> {
    const limit = intArg(args, 'limit', 100, 1, 500)
    const include = args['include_declaration'] !== false
    return atPosition(args, async (slot, doc, pos, deadline) => {
      needs(slot, 'referencesProvider', 'references')
      const r = await slot.client.request('textDocument/references', { textDocument: { uri: doc.uri }, position: { line: pos.line, character: pos.character }, context: { includeDeclaration: include } }, remaining(deadline))
      const locs = locationsOf(r).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character))
      if (locs.length === 0) return `No references found for ${pos.label}.`
      const lines = lineCache(slot)
      const head = `${locs.length} reference${locs.length === 1 ? '' : 's'} to ${pos.label}${locs.length > limit ? ` (the first ${limit}; raise limit for more)` : ''}:`
      return [head, ...locs.slice(0, limit).map(l => locationLine(l, opts.cwd, lines))].join('\n')
    })
  }

  async function symbols(args: Record<string, unknown>): Promise<string> {
    const path = resolveFile(args['file'])
    const limit = intArg(args, 'limit', 200, 1, 500)
    const query = typeof args['query'] === 'string' ? args['query'].trim() : ''
    const deadline = now() + budget
    const { slot, languageId } = await slotFor(path)
    return onReady(slot, deadline, async () => {
      syncWorkspace(slot, new Set([pathKey(path)]))
      const { doc } = slot.client.sync(path, languageId)
      if (query !== '') {
        needs(slot, 'workspaceSymbolProvider', 'a project-wide symbol search')
        const r = await slot.client.request('workspace/symbol', { query }, remaining(deadline))
        const { lines, total } = workspaceSymbolLines(r, opts.cwd, limit)
        return total === 0 ? `No symbols matching "${query}" in ${show(slot.root)} (${slot.server.id}).` : [`${total} symbol${total === 1 ? '' : 's'} matching "${query}" in ${show(slot.root)} (${slot.server.id}):`, ...lines].join('\n')
      }
      needs(slot, 'documentSymbolProvider', 'a file outline')
      const r = await slot.client.request('textDocument/documentSymbol', { textDocument: { uri: doc.uri } }, remaining(deadline))
      const { lines, total } = outlineLines(r, limit)
      return total === 0 ? `${show(doc.path)}: no symbols.` : [`${show(doc.path)}: ${total} symbol${total === 1 ? '' : 's'}`, ...lines].join('\n')
    })
  }

  const TOOLS: Record<string, (args: Record<string, unknown>) => Promise<string>> = { diagnostics, hover, definition, references, symbols }

  async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fn = TOOLS[name]
    if (fn === undefined) return textResult(`Unknown tool: ${name}`, true)
    try {
      return textResult(await fn(args))
    } catch (e) {
      if (e instanceof ToolFailure || e instanceof LspError) return textResult(`Error: ${e.message}`, true)
      log('error', 'lsp mcp: tool failed', { tool: name, error: e })
      return textResult(`Error: ${e instanceof Error ? e.message : String(e)}`, true)
    }
  }

  async function one(msg: unknown): Promise<Record<string, unknown> | undefined> {
    if (!isObj(msg)) return rpcError(null, -32600, 'Invalid Request')
    const hasId = 'id' in msg && msg['id'] !== undefined
    const id: RpcId = typeof msg['id'] === 'string' || (typeof msg['id'] === 'number' && Number.isFinite(msg['id'])) ? msg['id'] : null
    const method = msg['method']
    if (msg['jsonrpc'] !== '2.0' || typeof method !== 'string') {
      if (!('method' in msg) && ('result' in msg || 'error' in msg)) return undefined
      return hasId ? rpcError(id, -32600, 'Invalid Request') : undefined
    }
    if (!hasId) return undefined
    if (id === null) return rpcError(null, -32600, 'Invalid Request: id must be a string or a number')
    const params = isObj(msg['params']) ? msg['params'] : {}
    switch (method) {
      case 'initialize': {
        const asked = params['protocolVersion']
        const version = typeof asked === 'string' && (LSP_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : LSP_MCP_PROTOCOL_VERSIONS[0]
        const client = isObj(params['clientInfo']) ? params['clientInfo'] : {}
        log('info', 'lsp mcp: initialize', { client: client['name'], clientVersion: client['version'], version })
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'buracle-lsp', title: 'Buracle language servers', version: opts.version ?? '0.0.0' },
            instructions: LSP_MCP_INSTRUCTIONS,
          },
        }
      }
      case 'ping': return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list': return { jsonrpc: '2.0', id, result: { tools: lspToolDefinitions() } }
      case 'tools/call': {
        const name = params['name']
        if (typeof name !== 'string' || !(LSP_TOOL_NAMES as readonly string[]).includes(name)) return rpcError(id, -32602, `Unknown tool: ${String(name)}`)
        const args = params['arguments'] === undefined ? {} : params['arguments']
        if (!isObj(args)) return rpcError(id, -32602, 'Invalid params: arguments must be an object')
        return { jsonrpc: '2.0', id, result: await callTool(name, args) }
      }
      case 'resources/list': return { jsonrpc: '2.0', id, result: { resources: [] } }
      case 'resources/templates/list': return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } }
      case 'prompts/list': return { jsonrpc: '2.0', id, result: { prompts: [] } }
      default: return rpcError(id, -32601, `Method not found: ${method}`)
    }
  }

  async function handle(message: unknown): Promise<unknown> {
    if (Array.isArray(message)) {
      if (message.length === 0) return rpcError(null, -32600, 'Invalid Request: empty batch')
      const out = (await Promise.all(message.map(m => one(m)))).filter((r): r is Record<string, unknown> => r !== undefined)
      return out.length > 0 ? out : undefined
    }
    return one(message)
  }

  async function handleLine(line: string): Promise<string | undefined> {
    const t = line.trim()
    if (t === '') return undefined
    let msg: unknown
    try { msg = JSON.parse(t) } catch { return JSON.stringify(rpcError(null, -32700, 'Parse error')) }
    try {
      const r = await handle(msg)
      return r === undefined ? undefined : JSON.stringify(r)
    } catch (e) {
      log('error', 'lsp mcp: internal error', { error: e })
      const id = isObj(msg) && (typeof msg['id'] === 'string' || typeof msg['id'] === 'number') ? msg['id'] : null
      return JSON.stringify(rpcError(id, -32603, 'Internal error'))
    }
  }

  async function sweep(): Promise<number> {
    const idle = [...slots.values()].filter(s => now() - s.client.lastUsed >= idleMs || s.client.state === 'exited')
    await Promise.all(idle.map(s => shutdownSlot(s, s.client.state === 'exited' ? 'exited' : 'idle')))
    return idle.length
  }

  async function close(): Promise<void> {
    await Promise.all([...slots.values()].map(s => shutdownSlot(s, 'bridge stopping')))
  }

  const running = () => [...slots.values()].map(s => ({ id: s.server.id, root: s.root, pid: s.client.pid, state: s.client.state }))

  return { handle, handleLine, callTool, afterEdit, sweep, close, running }
}

export async function runLspMcpServer(opts: {
  cwd?: string
  version?: string
  input?: AsyncIterable<Uint8Array | string>
  write?: (line: string) => void
  bridge?: LspBridgeOptions
  edits?: boolean
} = {}): Promise<number> {
  const bridge = createLspBridge(opts.bridge ?? { cwd: opts.cwd ?? process.cwd(), ...(opts.version !== undefined ? { version: opts.version } : {}) })
  const edits = opts.edits === false ? undefined : await serveEditRequests((file, waitMs) => bridge.afterEdit(file, waitMs), { cwd: opts.bridge?.cwd ?? opts.cwd ?? process.cwd() })
  const write = opts.write ?? ((line: string) => { process.stdout.write(line) })
  const input = opts.input ?? (Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>)
  const decoder = new TextDecoder()
  let buf = ''
  const pending = new Set<Promise<void>>()
  const dispatch = (line: string) => {
    const p = bridge.handleLine(line).then(out => { if (out !== undefined) write(out + '\n') }).catch(e => log('error', 'lsp mcp: write failed', { error: e }))
    pending.add(p)
    void p.finally(() => pending.delete(p))
  }
  log('info', 'lsp mcp: server started', { cwd: opts.cwd ?? process.cwd(), pid: process.pid })
  const idle = setInterval(() => { void bridge.sweep().catch(() => undefined) }, 30_000)
  let stopping = false
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    log('info', 'lsp mcp: stopping on a signal', { signal, pid: process.pid })
    edits?.close()
    void bridge.close().catch(() => undefined).finally(() => process.exit(0))
  }
  const signals: NodeJS.Signals[] = opts.input === undefined ? ['SIGTERM', 'SIGHUP', 'SIGINT'] : []
  for (const s of signals) process.on(s, onSignal)
  try {
    for await (const chunk of input) {
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        dispatch(line)
      }
    }
    buf += decoder.decode()
    if (buf.trim() !== '') dispatch(buf)
    await Promise.all([...pending])
  } finally {
    clearInterval(idle)
    for (const s of signals) process.off(s, onSignal)
    edits?.close()
    await bridge.close()
    log('info', 'lsp mcp: server stopped', { pid: process.pid })
  }
  return 0
}

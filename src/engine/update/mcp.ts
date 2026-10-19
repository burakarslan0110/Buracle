import type { McpCatalog, McpServerSpec } from '../../core/catalog'
import { envRef, expandMcpCommand } from '../../core/catalog'
import { CM_SERVER_ID } from '../../core/context-mode'
import type { McpHealth } from '../../core/policy/routing'
import { mcpHealthOf } from '../../core/policy/routing'
import { atomicWriteSync, readJsonSafeSync } from '../fsx'
import * as paths from '../paths'
import { spawnArgv, windowsVerbatim } from '../platform'
import { killTreeWindows } from '../proc'
import { shimArgv } from '../shim'
import type { Fetcher } from './fetch'
import { errText } from './output'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'buracle-doctor', version: '1' }

export interface McpProbe {
  status: 'ok' | 'down'
  tools?: number
  toolNames?: string[]
  version?: string
  serverName?: string
  protocolVersion?: string
  error?: string
  ms: number
}

export interface McpHealthEntry extends McpProbe { transport: 'stdio' | 'http'; checked_at: string }
export interface StoredMcpEntry {
  status: 'ok' | 'down' | 'unknown'
  transport?: 'stdio' | 'http'
  tools?: number
  toolNames?: string[]
  version?: string
  serverName?: string
  protocolVersion?: string
  error?: string
  ms?: number
  checked_at?: string
  until?: string
  source?: string
}
export interface ToolHealthEntry { status: 'ok' | 'missing' | 'error'; version?: string; checked_at: string }
export interface HealthFile { v: 1; checked_at: string; mcp: Record<string, StoredMcpEntry>; tools?: Record<string, ToolHealthEntry> }

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

const MCP_STATUSES: ReadonlySet<string> = new Set(['ok', 'down', 'unknown'])
const TOOL_STATUSES: ReadonlySet<string> = new Set(['ok', 'missing', 'error'])

export function normalizeMcpEntry(x: unknown): StoredMcpEntry | undefined {
  if (typeof x === 'string') return MCP_STATUSES.has(x) ? { status: x as StoredMcpEntry['status'] } : undefined
  if (!isRecord(x) || typeof x['status'] !== 'string' || !MCP_STATUSES.has(x['status'])) return undefined
  return x as unknown as StoredMcpEntry
}

function normalizeToolEntry(x: unknown): ToolHealthEntry | undefined {
  if (!isRecord(x) || typeof x['status'] !== 'string' || !TOOL_STATUSES.has(x['status']) || typeof x['checked_at'] !== 'string') return undefined
  return x as unknown as ToolHealthEntry
}

export function readHealth(): HealthFile | undefined {
  const r = readJsonSafeSync<unknown>(paths.healthFile())
  if (!r.ok || !isRecord(r.value) || !isRecord(r.value['mcp'])) return undefined
  const mcp: Record<string, StoredMcpEntry> = {}
  for (const [id, e] of Object.entries(r.value['mcp'])) {
    const n = normalizeMcpEntry(e)
    if (n) mcp[id] = n
  }
  const out: HealthFile = { v: 1, checked_at: typeof r.value['checked_at'] === 'string' ? r.value['checked_at'] : '', mcp }
  if (isRecord(r.value['tools'])) {
    const tools: Record<string, ToolHealthEntry> = {}
    for (const [name, e] of Object.entries(r.value['tools'])) {
      const n = normalizeToolEntry(e)
      if (n) tools[name] = n
    }
    if (Object.keys(tools).length > 0) out.tools = tools
  }
  return out
}

export function writeHealth(update: { mcp?: Record<string, McpHealthEntry>, tools?: Record<string, ToolHealthEntry> }, nowIso: string): HealthFile {
  const prev = readHealth()
  const next: HealthFile = { v: 1, checked_at: nowIso, mcp: { ...(prev?.mcp ?? {}), ...(update.mcp ?? {}) } }
  const tools = { ...(prev?.tools ?? {}), ...(update.tools ?? {}) }
  if (Object.keys(tools).length > 0) next.tools = tools
  const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]))
  const out = { v: 1, checked_at: next.checked_at, mcp: sorted(next.mcp), ...(next.tools ? { tools: sorted(next.tools) } : {}) }
  atomicWriteSync(paths.healthFile(), JSON.stringify(out, null, 2) + '\n')
  return next
}

export function mcpHealthMap(catalog: McpCatalog, h: HealthFile | undefined = readHealth(), nowMs: number = Date.now()): McpHealth {
  const health = h !== undefined ? mcpHealthOf({ mcp: h.mcp }, nowMs) : {}
  const out: McpHealth = {}
  for (const id of Object.keys(catalog.servers).sort()) out[id] = health[id] ?? 'unknown'
  return out
}

function initializeParams(): Record<string, unknown> {
  return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }
}

function okFromInit(result: unknown, started: number): Omit<McpProbe, 'tools' | 'toolNames'> {
  const r = isRecord(result) ? result : {}
  const info = isRecord(r['serverInfo']) ? r['serverInfo'] : {}
  const p: Omit<McpProbe, 'tools' | 'toolNames'> = { status: 'ok', ms: Date.now() - started }
  if (typeof info['version'] === 'string') p.version = info['version']
  if (typeof info['name'] === 'string') p.serverName = info['name']
  if (typeof r['protocolVersion'] === 'string') p.protocolVersion = r['protocolVersion']
  return p
}

function toolNamesOf(result: unknown): { names: string[], cursor?: string } {
  const r = isRecord(result) ? result : {}
  const tools = Array.isArray(r['tools']) ? r['tools'] : []
  const names = tools.map(t => (isRecord(t) && typeof t['name'] === 'string' ? t['name'] : '?'))
  return typeof r['nextCursor'] === 'string' && r['nextCursor'] !== '' ? { names, cursor: r['nextCursor'] } : { names }
}

export function serverEnv(spec: McpServerSpec): { env: Record<string, string>, missing: string[] } {
  const env: Record<string, string> = {}
  const missing: string[] = []
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    const ref = envRef(v)
    if (ref === undefined) env[k] = v
    else if (process.env[ref] !== undefined) env[k] = process.env[ref] as string
    else missing.push(ref)
  }
  return { env, missing }
}

export async function probeStdio(argv: string[], opts: { env?: Record<string, string>, timeoutMs: number, cwd?: string, drop?: (name: string) => boolean }): Promise<McpProbe> {
  const started = Date.now()
  const down = (error: string): McpProbe => ({ status: 'down', error, ms: Date.now() - started })
  if (argv.length === 0 || argv[0] === '') return down('no command')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && opts.drop?.(k) !== true) env[k] = v
  Object.assign(env, opts.env ?? {})
  let proc: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>
  try {
    // POSIX: its own process group, so the cleanup ends the server's children too. Windows ends the tree with
    // taskkill instead: a detached cmd.exe has no console, so a program it starts would get a new one in place of these pipes.
    proc = Bun.spawn(argv, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env, cwd: opts.cwd ?? paths.home(), detached: process.platform !== 'win32', windowsVerbatimArguments: windowsVerbatim(argv) })
  } catch (e) {
    return down(`cannot start ${argv[0]}: ${errText(e)}`)
  }
  const child = proc
  const decoder = new TextDecoder()
  let stderrTail = ''
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>()
  let exited = false
  const exitPromise = child.exited.then(code => { exited = true; return code })
  void (async () => {
    const d = new TextDecoder()
    try { for await (const chunk of child.stderr) stderrTail = (stderrTail + d.decode(chunk, { stream: true })).slice(-4000) } catch {  }
  })()
  void (async () => {
    let buf = ''
    try {
      for await (const chunk of child.stdout) {
        buf += decoder.decode(chunk, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line.startsWith('{')) continue
          let msg: unknown
          try { msg = JSON.parse(line) } catch { continue }
          if (isRecord(msg) && typeof msg['id'] === 'number') {
            const w = waiters.get(msg['id'])
            if (w) { waiters.delete(msg['id']); w(msg) }
          }
        }
      }
    } catch {  }
  })()
  const send = (obj: Record<string, unknown>): void => {
    try { child.stdin.write(JSON.stringify(obj) + '\n'); void child.stdin.flush() } catch {  }
  }
  const request = (id: number, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise(resolve => {
    waiters.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
  const stopped = (): string => {
    const tail = stderrTail.trim().split('\n').slice(-3).join(' / ')
    return `exited before answering${tail !== '' ? `: ${tail.slice(0, 300)}` : ''}`
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), opts.timeoutMs) })
  const race = <T>(p: Promise<T>): Promise<T | 'timeout' | 'exited'> => Promise.race([p, timeout, exitPromise.then(() => 'exited' as const)])
  try {
    const init = await race(request(1, 'initialize', initializeParams()))
    if (init === 'timeout') return down(`no answer to initialize within ${opts.timeoutMs} ms (a first run may still be downloading the package)`)
    if (init === 'exited') return down(stopped())
    if (isRecord(init['error'])) return down(`initialize failed: ${String(init['error']['message'] ?? 'error')}`)
    const base = okFromInit(init['result'], started)
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const names: string[] = []
    let cursor: string | undefined
    for (let page = 0, id = 2; page < 20; page++, id++) {
      const res = await race(request(id, 'tools/list', cursor !== undefined ? { cursor } : {}))
      if (res === 'timeout') return { ...base, status: 'down', error: `no answer to tools/list within ${opts.timeoutMs} ms`, ms: Date.now() - started }
      if (res === 'exited') return { ...base, status: 'down', error: stopped(), ms: Date.now() - started }
      if (isRecord(res['error'])) return { ...base, status: 'down', error: `tools/list failed: ${String(res['error']['message'] ?? 'error')}`, ms: Date.now() - started }
      const t = toolNamesOf(res['result'])
      names.push(...t.names)
      if (t.cursor === undefined) break
      cursor = t.cursor
    }
    return { ...base, tools: names.length, toolNames: [...names].sort(), ms: Date.now() - started }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    try { child.stdin.end() } catch {  }
    const killGroup = (sig: 'SIGTERM' | 'SIGKILL') => {
      if (exited) return
      if (process.platform === 'win32') { killTreeWindows(child.pid); return }
      try { process.kill(-child.pid, sig) } catch { try { child.kill(sig) } catch {  } }
    }
    killGroup('SIGTERM')
    let grace: ReturnType<typeof setTimeout> | undefined
    const quit = await Promise.race([exitPromise.then(() => true), new Promise<boolean>(r => { grace = setTimeout(() => r(false), 1500) })])
    if (grace !== undefined) clearTimeout(grace)
    if (!quit) killGroup('SIGKILL')
  }
}

function parseRpcBody(res: { json?: unknown, text?: string }, id: number): Record<string, unknown> | undefined {
  const pick = (x: unknown): Record<string, unknown> | undefined => {
    if (Array.isArray(x)) return x.map(pick).find(v => v !== undefined)
    return isRecord(x) && x['id'] === id ? x : undefined
  }
  if (res.json !== undefined) return pick(res.json)
  for (const line of (res.text ?? '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try {
      const got = pick(JSON.parse(line.slice(5).trim()))
      if (got) return got
    } catch {  }
  }
  return undefined
}

export async function probeHttp(url: string, fetcher: Fetcher, timeoutMs: number): Promise<McpProbe> {
  const started = Date.now()
  const down = (error: string): McpProbe => ({ status: 'down', error, ms: Date.now() - started })
  const headers = (session?: string): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    ...(session !== undefined ? { 'mcp-session-id': session } : {}),
  })
  const init = await fetcher(url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initializeParams() }), timeoutMs })
  if (!init.ok) return down(`initialize: ${init.error ?? `HTTP ${init.status}`}`)
  const msg = parseRpcBody(init, 1)
  if (!msg) return down('initialize: no JSON-RPC answer')
  if (isRecord(msg['error'])) return down(`initialize failed: ${String(msg['error']['message'] ?? 'error')}`)
  const base = okFromInit(msg['result'], started)
  const session = init.headers?.['mcp-session-id']
  await fetcher(url, { method: 'POST', headers: headers(session), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), timeoutMs })
  const list = await fetcher(url, { method: 'POST', headers: headers(session), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), timeoutMs })
  if (!list.ok) return { ...base, status: 'down', error: `tools/list: ${list.error ?? `HTTP ${list.status}`}`, ms: Date.now() - started }
  const lm = parseRpcBody(list, 2)
  if (!lm || isRecord(lm['error'])) return { ...base, status: 'down', error: 'tools/list: no valid answer', ms: Date.now() - started }
  const t = toolNamesOf(lm['result'])
  return { ...base, tools: t.names.length, toolNames: [...t.names].sort(), ms: Date.now() - started }
}

export interface ProbeOptions {
  ids?: readonly string[]
  timeoutMs: number
  fetcher: Fetcher
  buracle: string
  http?: boolean
}

// Bun does not start a .cmd reliably on Windows: the Buracle shim runs as what buracle.cmd would run, any
// other .cmd through cmd.exe.
export function mcpLaunchArgv(command: string, args: readonly string[], shim: string): string[] {
  if (command === shim) return shimArgv(args, shim) ?? [command, ...args]
  return spawnArgv([command, ...args])
}

export async function probeServers(catalog: McpCatalog, opts: ProbeOptions, nowIso: () => string): Promise<Record<string, McpHealthEntry>> {
  const ids = Object.keys(catalog.servers).sort().filter(id => opts.ids === undefined || opts.ids.includes(id))
  const entries = await Promise.all(ids.map(async (id): Promise<[string, McpHealthEntry] | undefined> => {
    const spec = catalog.servers[id] as McpServerSpec
    if (spec.transport === 'http') {
      if (opts.http === false || typeof spec.url !== 'string') return undefined
      const p = await probeHttp(spec.url, opts.fetcher, opts.timeoutMs)
      return [id, { ...p, transport: 'http', checked_at: nowIso() }]
    }
    const { command, args } = expandMcpCommand(spec, { buracle: opts.buracle, id })
    const { env, missing } = serverEnv(spec)
    const drop = id === CM_SERVER_ID ? (name: string) => name.startsWith('CONTEXT_MODE_') : undefined
    const p = await probeStdio(mcpLaunchArgv(command, args, opts.buracle), { env, timeoutMs: opts.timeoutMs, ...(drop !== undefined ? { drop } : {}) })
    if (p.status === 'down' && missing.length > 0) p.error = `${p.error ?? 'down'} (unset environment: ${missing.join(', ')})`
    return [id, { ...p, transport: 'stdio', checked_at: nowIso() }]
  }))
  return Object.fromEntries(entries.filter((e): e is [string, McpHealthEntry] => e !== undefined))
}

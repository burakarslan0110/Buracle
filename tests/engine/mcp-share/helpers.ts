import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { updateToolchainState } from '../../../src/engine/toolchain/state'
import { launcherText } from '../../helpers/fake-exe'

export type Msg = Record<string, unknown>

export const MAIN = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'main.ts')
export const STUB = join(import.meta.dir, '..', '..', 'fixtures', 'mcp-share', 'stub-server.ts')
export const VERSION = '9.9.9'

const PACKAGES: Record<string, { key: string, name: string, bin: string }> = {
  'web-search': { key: 'npm:open-websearch', name: 'open-websearch', bin: 'open-websearch' },
  'chrome-devtools': { key: 'npm:chrome-devtools-mcp', name: 'chrome-devtools-mcp', bin: 'chrome-devtools-mcp' },
  'context7': { key: 'npm:@upstash/context7-mcp', name: '@upstash/context7-mcp', bin: 'context7-mcp' },
}

/** Puts the stub server in the toolchain as the package of `id` (web-search or chrome-devtools). */
export function installStub(root: string, id = 'web-search', mode = 0o755): string {
  const p = PACKAGES[id]
  if (p === undefined) throw new Error(`no stub package for ${id}`)
  const entry = join(root, 'tc', p.name, p.bin)
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, launcherText(process.execPath, STUB), { mode })
  chmodSync(entry, mode)
  updateToolchainState(s => {
    s.packages[p.key] = { registry: 'npm', name: p.name, version: VERSION, dir: dirname(entry), bins: { [p.bin]: entry }, installed_at: 'x' }
  }, new Date(0).toISOString())
  return entry
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

export async function until<T>(get: () => T | undefined | false, ms = 8_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined && v !== false) return v
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms`)
    await Bun.sleep(25)
  }
}

export function readJson(file: string): Msg | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as Msg } catch { return undefined }
}

export const call = (id: unknown, name: string, args: Msg = {}, meta?: Msg): Msg => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } })
export const textOf = (m: Msg): string => (((m['result'] as Msg | undefined)?.['content'] as Msg[] | undefined)?.[0]?.['text'] as string | undefined) ?? ''
export const lineCount = (file: string): number => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l !== '').length : 0)

export interface Client {
  send(m: Msg): void
  raw(text: string): void
  wait(pred: (m: Msg) => boolean, ms?: number): Promise<Msg>
  lines: Msg[]
  closed(): boolean
  close(): void
}

function lineReader(push: (m: Msg) => void): (chunk: Buffer | Uint8Array) => void {
  let buf = ''
  const dec = new TextDecoder()
  return chunk => {
    buf += dec.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line !== '') push(JSON.parse(line) as Msg)
    }
  }
}

/** A raw client on a backend socket. */
export async function connect(sock: string): Promise<Client> {
  const s = net.createConnection(sock)
  await new Promise<void>((res, rej) => { s.once('connect', () => res()); s.once('error', rej) })
  const lines: Msg[] = []
  let closed = false
  s.on('data', lineReader(m => lines.push(m)))
  s.on('close', () => { closed = true })
  s.on('error', () => { closed = true })
  return {
    send: m => { s.write(`${JSON.stringify(m)}\n`) },
    raw: t => { s.write(t) },
    wait: (pred, ms = 8_000) => until(() => lines.find(pred), ms),
    lines,
    closed: () => closed,
    close: () => { s.end() },
  }
}

/** A raw client that said hello and finished the MCP handshake. */
export async function session(sock: string, pid: number): Promise<Client> {
  const c = await connect(sock)
  c.send({ jsonrpc: '2.0', method: 'buracle/hello', params: { pid } })
  c.send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } })
  await c.wait(m => m['id'] === 'init')
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return c
}

export interface Driver extends Client {
  proc: ReturnType<typeof Bun.spawn>
  /** Ends stdin, as a harness that closes its session does. */
  end(): Promise<number>
}

/** Plays a harness: runs `buracle mcp run <id>` with pipes and talks MCP on its stdio. */
export function drive(id: string, env: Record<string, string | undefined> = {}): Driver {
  const proc = Bun.spawn([process.execPath, MAIN, 'mcp', 'run', id], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const lines: Msg[] = []
  const read = lineReader(m => lines.push(m))
  let closed = false
  void (async () => {
    try { for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) read(chunk) } catch { /* ended */ }
    closed = true
  })()
  const stdin = proc.stdin as import('bun').FileSink
  return {
    proc,
    send: m => { stdin.write(`${JSON.stringify(m)}\n`); stdin.flush() },
    raw: t => { stdin.write(t); stdin.flush() },
    wait: (pred, ms = 10_000) => until(() => lines.find(pred), ms),
    lines,
    closed: () => closed,
    close: () => { void stdin.end() },
    end: async () => { await stdin.end(); return proc.exited },
  }
}

export const initialize = (id: unknown = 0, protocolVersion = '2025-11-25'): Msg => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'harness' } } })

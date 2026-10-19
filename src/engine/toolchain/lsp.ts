import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { LspSpec, ToolSpec, ToolsCatalog } from '../../core/catalog'
import { validateToolsCatalog } from '../../core/catalog'
import * as paths from '../paths'
import { exeName, findExecutable, spawnArgv, windowsVerbatim } from '../platform'
import { binArgv, toolRequest } from './packages'
import { packageKey, type ToolchainState } from './state'
import { installAdvice, toolchainBinDirs } from './system'

export interface LspServer { id: string; tool: ToolSpec; spec: LspSpec }

export function readToolsCatalog(file: string = join(paths.canonicalDir(), 'tools.yaml')): ToolsCatalog {
  const raw = parseYaml(readFileSync(file, 'utf8')) as unknown
  const problems = validateToolsCatalog(raw)
  if (problems.length > 0) throw new Error(`${file}: ${problems.slice(0, 3).join('; ')}`)
  return raw as ToolsCatalog
}

export function lspServers(tools: ToolsCatalog): LspServer[] {
  return tools.tools.flatMap(t => (t.lsp !== undefined ? [{ id: t.lsp.id, tool: t, spec: t.lsp }] : [])).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function lspBin(s: LspServer): string {
  return s.spec.bin ?? (s.tool.bins ?? [s.tool.name])[0] ?? s.tool.name
}

export function lspServerFor(servers: readonly LspServer[], file: string): { server: LspServer, languageId: string } | undefined {
  const ext = extname(file)
  for (const exact of [true, false]) {
    for (const s of servers) {
      const key = Object.keys(s.spec.extensions).find(k => (exact ? k === ext : k.toLowerCase() === ext.toLowerCase()))
      if (key !== undefined) return { server: s, languageId: s.spec.extensions[key] as string }
    }
  }
  return undefined
}

function hasMarker(dir: string, marker: string): boolean {
  if (!marker.startsWith('*.')) return existsSync(join(dir, marker))
  try { return readdirSync(dir).some(n => n.endsWith(marker.slice(1)) && n.length > marker.length - 1) } catch { return false }
}

export function gitTopLevel(start: string): string | undefined {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return undefined
  }
}

function below(dir: string, base: string): boolean {
  const rel = relative(base, dir)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function lspRoot(s: LspServer, file: string, opts: { cwd?: string, home?: string } = {}): string {
  const start = dirname(resolve(file))
  const home = resolve(opts.home ?? paths.home())
  const inHome = below(start, home)
  const found = gitTopLevel(start)
  const top = found !== undefined && inHome && !below(found, home) ? undefined : found
  const cwd = opts.cwd !== undefined ? resolve(opts.cwd) : undefined
  const stop = top ?? (cwd !== undefined && (cwd === start || below(start, cwd)) && (!inHome || below(cwd, home)) ? cwd : undefined)
  const chain: string[] = []
  for (let d = start; ; d = dirname(d)) {
    chain.push(d)
    if (d === stop || dirname(d) === d || (inHome && dirname(d) === home)) break
  }
  for (const m of s.spec.root_markers ?? []) {
    const hit = chain.find(d => hasMarker(d, m))
    if (hit !== undefined) return hit
  }
  return top ?? start
}

export interface LspLaunch { argv: string[]; source: 'toolchain' | 'path' | 'go' | 'dotnet'; version?: string }

export function lspLaunch(s: LspServer, state: ToolchainState, opts: { node?: string } = {}): LspLaunch | { error: string } {
  const bin = lspBin(s)
  const args = s.spec.args ?? []
  const fromToolchain = (): LspLaunch | undefined => {
    const req = toolRequest(s.tool)
    if (req === undefined) return undefined
    const pkg = state.packages[packageKey(req.registry, req.name)]
    const entry = pkg?.bins[bin]
    if (pkg === undefined || entry === undefined) return undefined
    const run = binArgv(entry, opts.node ?? findExecutable('node'))
    return run !== undefined ? { argv: [...run, ...args], source: 'toolchain', version: pkg.version } : undefined
  }
  const onPath = (): LspLaunch | undefined => {
    const p = findExecutable(bin, { extra: toolchainBinDirs() })
    if (p === undefined) return undefined
    const source = p.startsWith(join(paths.toolchainDir(), 'go')) ? 'go' : p.startsWith(join(paths.toolchainDir(), 'dotnet')) ? 'dotnet' : 'path'
    return { argv: [p, ...args], source }
  }
  const order = s.tool.prefer === 'toolchain' ? [fromToolchain, onPath] : [onPath, fromToolchain]
  for (const f of order) {
    const r = f()
    if (r !== undefined) return r
  }
  return { error: `${s.id}: ${exeName(bin)} is not installed (${installAdvice(s.tool)})` }
}

export function claudeLspJson(servers: readonly LspServer[], launcher: { command: string, args: readonly string[] }): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const s of servers) {
    out[s.id] = {
      command: launcher.command,
      args: [...launcher.args, 'lsp', 'run', s.id],
      extensionToLanguage: Object.fromEntries(Object.keys(s.spec.extensions).sort().map(k => [k, s.spec.extensions[k]])),
      restartOnCrash: true,
      maxRestarts: 3,
      ...(s.spec.startup_timeout_ms !== undefined ? { startupTimeout: s.spec.startup_timeout_ms } : {}),
    }
  }
  return out
}

export interface LspProbe { status: 'ok' | 'down'; serverName?: string; version?: string; ms: number; error?: string }

function frame(obj: unknown): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(obj))
  const head = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`)
  const out = new Uint8Array(head.length + body.length)
  out.set(head, 0)
  out.set(body, head.length)
  return out
}

export async function probeLsp(argv: readonly string[], opts: { rootDir: string, timeoutMs: number }): Promise<LspProbe> {
  const started = Date.now()
  const down = (error: string): LspProbe => ({ status: 'down', error, ms: Date.now() - started })
  let proc: ReturnType<typeof Bun.spawn<'pipe', 'pipe', 'pipe'>>
  try {
    const spawned = spawnArgv(argv)
    proc = Bun.spawn(spawned, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', cwd: opts.rootDir, env: { ...process.env }, windowsVerbatimArguments: windowsVerbatim(spawned) })
  } catch (e) {
    return down(`cannot start ${argv[0] ?? '?'}: ${e instanceof Error ? e.message : String(e)}`)
  }
  const child = proc
  let stderrTail = ''
  void (async () => {
    const d = new TextDecoder()
    try { for await (const c of child.stderr) stderrTail = (stderrTail + d.decode(c, { stream: true })).slice(-2000) } catch {  }
  })()
  const answer = new Promise<Record<string, unknown> | undefined>(resolve => {
    void (async () => {
      let buf = new Uint8Array(0)
      const dec = new TextDecoder()
      try {
        for await (const chunk of child.stdout) {
          const next = new Uint8Array(buf.length + chunk.length)
          next.set(buf, 0)
          next.set(chunk, buf.length)
          buf = next
          for (;;) {
            const text = dec.decode(buf)
            const sep = text.indexOf('\r\n\r\n')
            if (sep < 0) break
            const len = Number(/Content-Length:\s*(\d+)/i.exec(text.slice(0, sep))?.[1] ?? NaN)
            const headBytes = new TextEncoder().encode(text.slice(0, sep + 4)).length
            if (!Number.isFinite(len) || buf.length < headBytes + len) break
            const body = dec.decode(buf.slice(headBytes, headBytes + len))
            buf = buf.slice(headBytes + len)
            try {
              const msg = JSON.parse(body) as Record<string, unknown>
              if (msg['id'] === 1) { resolve(msg); return }
            } catch {  }
          }
        }
      } catch {  }
      resolve(undefined)
    })()
  })
  const rootUri = `file://${opts.rootDir.startsWith('/') ? '' : '/'}${opts.rootDir.replace(/\\/g, '/')}`
  try {
    child.stdin.write(frame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri, capabilities: {}, workspaceFolders: [{ uri: rootUri, name: 'probe' }] } }))
    await child.stdin.flush()
  } catch {  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), opts.timeoutMs) })
  const exited = child.exited.then(() => 'exited' as const)
  const r = await Promise.race([answer, timeout, exited])
  if (timer !== undefined) clearTimeout(timer)
  const finish = async () => {
    try {
      child.stdin.write(frame({ jsonrpc: '2.0', id: 2, method: 'shutdown' }))
      child.stdin.write(frame({ jsonrpc: '2.0', method: 'exit' }))
      await child.stdin.flush()
      child.stdin.end()
    } catch {  }
    const quit = await Promise.race([child.exited.then(() => true), new Promise<boolean>(res => setTimeout(() => res(false), 1500))])
    if (!quit) { try { child.kill('SIGKILL') } catch {  } }
  }
  if (r === 'timeout') { await finish(); return down(`no answer to initialize within ${opts.timeoutMs} ms`) }
  if (r === 'exited' || r === undefined) {
    const tail = stderrTail.trim().split('\n').slice(-2).join(' / ').slice(0, 300)
    return down(`exited before answering${tail !== '' ? `: ${tail}` : ''}`)
  }
  await finish()
  if (r['error'] !== undefined) {
    const e = r['error'] as { message?: unknown }
    return down(`initialize failed: ${typeof e.message === 'string' ? e.message : 'error'}`)
  }
  const result = (r['result'] ?? {}) as { serverInfo?: { name?: unknown, version?: unknown }, capabilities?: unknown }
  if (result.capabilities === undefined) return down('initialize answered without capabilities')
  const out: LspProbe = { status: 'ok', ms: Date.now() - started }
  if (typeof result.serverInfo?.name === 'string') out.serverName = result.serverInfo.name
  if (typeof result.serverInfo?.version === 'string') out.version = shortVersion(result.serverInfo.version)
  return out
}

export function shortVersion(v: string): string {
  const t = v.trim()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { Version?: unknown }
      if (typeof j.Version === 'string') return j.Version
    } catch {  }
  }
  return t.length > 40 ? `${t.slice(0, 39)}…` : t
}

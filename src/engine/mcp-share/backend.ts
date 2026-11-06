/**
 * `buracle mcp backend <id>`: the one shared copy of an MCP server on this machine. It runs the upstream
 * server once in its normal stdio mode and serves every forwarder that connects to its Unix socket, through
 * the multiplexer of ./mux.ts. It stops `lingerMs()` after its last client left, on SIGTERM, and when its
 * Buracle home disappears. Its socket lives in a private directory (./common.ts, ensurePrivateDir).
 */
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import net from 'node:net'
import { dirname } from 'node:path'
import type { McpServerSpec } from '../../core/catalog'
import { atomicWriteSync } from '../fsx'
import { breakStaleLock, lockSnapshot, lockToken, releaseLockFile } from '../lockfile'
import { log } from '../log'
import * as paths from '../paths'
import { writeMcpCache } from './cache'
import { backendFiles, backendKey, ensurePrivateDir, installedVersion, lingerMs, pidAlive } from './common'
import { LineSplitter } from './lines'
import { createMux, type MuxOut } from './mux'

export interface BackendOptions {
  stderr: { write(s: string): void }
  /** Marks the server down in health.json for the routing (src/cli/commands/mcp.ts, recordLaunchFailure). */
  recordFailure?: (error: string, nowMs: number) => Promise<void> | void
  /** Called when the toolchain lacks the package and the package runner starts it: fills the toolchain in the background. */
  onFallback?: () => Promise<void> | void
  version?: string
  /**
   * The package version the forwarder that starts this backend computed (`latest` for none): the backend
   * listens on the key the forwarder polls, even when the toolchain changed between the two reads.
   */
  packageVersion?: string
  /**
   * The variable that holds the API key the forwarder resolved (`--api-key-env`): the backend reads the key
   * from its own environment for the socket key, and its server inherits the variable.
   */
  apiKeyEnv?: string
}

function identity(path: string): string | undefined {
  try {
    const st = statSync(path)
    return `${st.dev}:${st.ino}`
  } catch {
    return undefined
  }
}

/** At most this many upstream starts in RESTART_WINDOW_MS, as the lsp bridge does. */
const MAX_STARTS = 4
const RESTART_WINDOW_MS = 10 * 60_000
/** An upstream that exits non-zero this soon after its start, unasked, failed to start. */
const STARTUP_WINDOW_MS = 60_000
const LOG_MAX_BYTES = 1024 * 1024
const LOG_KEEP_BYTES = 256 * 1024
const HOME_POLL_MS = 1_000
const KILL_GRACE_MS = 2_000

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/** An exclusive lock file that stays valid while its owner lives (a backend can run for hours). */
function takeLock(path: string): (() => void) | undefined {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      const text = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: lockToken() })
      try { writeSync(fd, text) } finally { closeSync(fd) }
      return () => releaseLockFile(path, text)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const seen = lockSnapshot(path)
      if (seen === undefined) continue
      let owner: unknown
      try { owner = (JSON.parse(seen.text) as { pid?: unknown }).pid } catch { owner = undefined }
      if (typeof owner === 'number' && pidAlive(owner)) return undefined
      if (breakStaleLock(path, seen) === 'broken') continue
      return undefined
    }
  }
  return undefined
}

function fileSize(file: string): number {
  try { return statSync(file).size } catch { return 0 }
}

function trimLog(file: string, max = LOG_MAX_BYTES): void {
  try {
    if (statSync(file).size <= max) return
    const text = readFileSync(file)
    writeFileSync(file, text.subarray(text.length - LOG_KEEP_BYTES))
  } catch {  }
}

export async function runMcpBackend(id: string, opts: BackendOptions): Promise<number> {
  const { launchPlan, readMcpCatalog } = await import('../toolchain/launch')
  const { readToolchainState } = await import('../toolchain/state')
  const { withSystemTools } = await import('../toolchain/packages')
  let spec: McpServerSpec | undefined
  try {
    spec = readMcpCatalog().servers[id]
  } catch (e) {
    opts.stderr.write(`buracle mcp backend: ${errText(e)}\n`)
    return 1
  }
  if (spec === undefined || spec.backend !== 'shared') {
    opts.stderr.write(`buracle mcp backend: '${id}' has no shared backend (backend: shared in canonical/mcp.yaml)\n`)
    return 1
  }
  const serverSpec: McpServerSpec = spec
  const version = opts.packageVersion === undefined ? installedVersion(serverSpec) : opts.packageVersion === 'latest' ? undefined : opts.packageVersion
  const key = backendKey(id, version, opts.apiKeyEnv !== undefined ? process.env[opts.apiKeyEnv] : undefined)
  const files = backendFiles(key)
  const problem = ensurePrivateDir(files.dir)
  if (problem !== undefined) {
    opts.stderr.write(`buracle mcp backend: ${problem}\n`)
    return 1
  }
  const release = takeLock(files.lock)
  if (release === undefined) return 0

  const logFile = paths.mcpLogFile(id)
  const mux = createMux({ server: id, ...(opts.version !== undefined ? { clientVersion: opts.version } : {}) })
  const conns = new Map<string, net.Socket>()
  const startedAt = Date.now()
  let nextClient = 0
  let child: ReturnType<typeof Bun.spawn> | undefined
  let childStarted = 0
  let killedByUs = false
  let starts: number[] = []
  let idleSince: number | undefined = Date.now()
  let linger: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  let done!: (code: number) => void
  const finished = new Promise<number>(res => { done = res })

  const writeState = (): void => {
    if (stopping) return
    const clients = mux.clients().flatMap(c => { const p = mux.clientPid(c); return p !== undefined ? [p] : [] })
    const doc: Record<string, unknown> = { v: 1, id, key, pid: process.pid, startedAt, log: logFile, clients }
    if (child !== undefined && child.exitCode === null && child.signalCode === null) doc['upstreamPid'] = child.pid
    if (idleSince !== undefined) doc['idleSince'] = idleSince
    try { atomicWriteSync(files.state, `${JSON.stringify(doc)}\n`) } catch (e) { log('warn', 'mcp backend: the state file was not written', { id, error: e }) }
  }

  const fail = async (error: string): Promise<void> => {
    try { await opts.recordFailure?.(error, Date.now()) } catch {  }
  }

  const writeUpstream = (msg: Record<string, unknown>): void => {
    const c = child
    if (c === undefined || c.stdin === undefined || typeof c.stdin === 'number') return
    try {
      c.stdin.write(`${JSON.stringify(msg)}\n`)
      c.stdin.flush()
    } catch (e) {
      log('warn', 'mcp backend: cannot write to the server', { id, error: e })
    }
  }

  const dispatch = (outs: MuxOut[]): void => {
    for (const o of outs) {
      if (o.to === 'upstream') writeUpstream(o.msg)
      else if (o.to === 'client') {
        const s = conns.get(o.client)
        if (s !== undefined && !s.destroyed) s.write(`${JSON.stringify(o.msg)}\n`)
      } else if (o.to === 'cache') writeMcpCache({ v: 1, id, version: version ?? 'latest', initialize: o.initialize, tools: o.tools })
      else startUpstream()
    }
  }

  const upstreamGone = (reason: string, failure: boolean): void => {
    child = undefined
    writeState()
    if (failure) void fail(reason)
    dispatch(mux.upstreamExited(reason))
  }

  function startUpstream(): void {
    if (stopping) return
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      // The mux asks for a start only while it holds no session with this process (its initialize failed): replace it.
      const stale = child
      child = undefined
      try { stale.kill('SIGTERM') } catch {  }
      setTimeout(() => { if (stale.exitCode === null && stale.signalCode === null) { try { stale.kill('SIGKILL') } catch {  } } }, 2_000).unref?.()
    }
    const now = Date.now()
    starts = starts.filter(t => now - t < RESTART_WINDOW_MS)
    if (starts.length >= MAX_STARTS) {
      upstreamGone(`it was started ${MAX_STARTS} times in ${RESTART_WINDOW_MS / 60_000} minutes; see ${logFile}`, true)
      return
    }
    starts.push(now)
    const plan = launchPlan(id, serverSpec, readToolchainState())
    if ('error' in plan) {
      upstreamGone(plan.error, true)
      return
    }
    if (plan.source === 'fallback' && process.env['BURACLE_NO_TOOLCHAIN'] !== '1') void Promise.resolve(opts.onFallback?.()).catch(() => undefined)
    const env: Record<string, string | undefined> = { ...process.env, ...plan.env }
    const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
    env[pathKey] = withSystemTools(env[pathKey])
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      trimLog(logFile)
      appendFileSync(logFile, `--- ${new Date(now).toISOString()} ${plan.argv.join(' ')}\n`)
    } catch {  }
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn([...plan.argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env, cwd: paths.buracleHome() })
    } catch (e) {
      upstreamGone(`cannot start ${plan.argv[0] ?? id}: ${errText(e)}`, true)
      return
    }
    child = proc
    childStarted = now
    killedByUs = false
    log('info', 'mcp backend: the server started', { id, pid: proc.pid, source: plan.source })
    writeState()
    const split = new LineSplitter()
    void (async () => {
      try {
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          for (const line of split.push(chunk)) {
            let msg: unknown
            try { msg = JSON.parse(line) } catch { continue }
            if (child === proc) dispatch(mux.fromUpstream(msg))
          }
        }
      } catch {  }
    })()
    void (async () => {
      try {
        // A backend can run for days: trim before an append would take the log past LOG_MAX_BYTES.
        let size = fileSize(logFile)
        for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
          if (size + chunk.length > LOG_MAX_BYTES) { trimLog(logFile, LOG_MAX_BYTES - chunk.length); size = fileSize(logFile) }
          try { appendFileSync(logFile, chunk); size += chunk.length } catch {  }
        }
      } catch {  }
    })()
    void proc.exited.then(code => {
      if (child !== proc) return
      const early = !killedByUs && proc.signalCode === null && code !== 0 && Date.now() - childStarted < STARTUP_WINDOW_MS
      const reason = proc.signalCode !== null ? `the server ended by ${proc.signalCode}` : `the server exited with code ${code}`
      upstreamGone(`${reason} ${Math.round((Date.now() - childStarted) / 100) / 10} s after it started`, early)
    })
    dispatch(mux.startUpstream())
  }

  const stopUpstream = async (): Promise<void> => {
    const c = child
    if (c === undefined || c.exitCode !== null || c.signalCode !== null) return
    killedByUs = true
    try { c.kill('SIGTERM') } catch {  }
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {  } }, KILL_GRACE_MS)
    await c.exited
    clearTimeout(t)
  }

  const server = net.createServer(sock => {
    if (stopping) { sock.destroy(); return }
    const cid = `c${++nextClient}`
    let first = true
    const split = new LineSplitter()
    conns.set(cid, sock)
    mux.attach(cid)
    if (linger !== undefined) { clearTimeout(linger); linger = undefined }
    idleSince = undefined
    writeState()
    sock.on('data', (chunk: Buffer) => {
      for (const line of split.push(chunk)) {
        let msg: unknown
        try { msg = JSON.parse(line) } catch { msg = undefined }
        if (first) {
          first = false
          // Only JSON-RPC talks to a backend: an HTTP request or any other text closes the connection unanswered.
          if (!isObj(msg) || msg['jsonrpc'] !== '2.0') { sock.destroy(); return }
        }
        if (msg === undefined || sock.destroyed) continue
        dispatch(mux.fromClient(cid, msg))
        if (isObj(msg) && msg['method'] === 'buracle/hello') writeState()
      }
    })
    sock.on('error', () => {  })
    sock.on('close', () => {
      conns.delete(cid)
      mux.detach(cid)
      if (conns.size === 0) armLinger()
      else writeState()
    })
  })

  function armLinger(): void {
    if (stopping) return
    idleSince = Date.now()
    writeState()
    if (linger !== undefined) clearTimeout(linger)
    linger = setTimeout(() => { if (conns.size === 0) void shutdown('no client for the linger time') }, lingerMs())
  }

  // The home and the socket must stay the ones this backend started with: a removed home that something
  // recreated (npm writes its cache there) or a removed socket that no forwarder can reach means stop.
  const home = paths.buracleHome()
  const homeId = identity(home)
  let socketId: string | undefined
  const homeWatch = setInterval(() => {
    if (identity(home) !== homeId || !existsSync(home)) void shutdown('its Buracle home is gone')
    else if (socketId !== undefined && identity(files.socket) !== socketId) void shutdown('its socket is gone')
  }, HOME_POLL_MS)

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return
    stopping = true
    log('info', 'mcp backend: stopping', { id, reason })
    clearInterval(homeWatch)
    if (linger !== undefined) clearTimeout(linger)
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as NodeJS.Signals[]) process.off(s, onSignal)
    server.close()
    for (const s of conns.values()) s.destroy()
    await stopUpstream()
    for (const f of [files.socket, files.state]) { try { rmSync(f, { force: true }) } catch {  } }
    release?.()
    done(0)
  }

  function onSignal(): void { void shutdown('a signal') }
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as NodeJS.Signals[]) process.on(s, onSignal)

  // The lock is ours, so a socket file left here belongs to a backend that died.
  try { rmSync(files.socket, { force: true }) } catch {  }
  const listening = await new Promise<string | undefined>(resolve => {
    server.once('error', e => resolve(errText(e)))
    server.listen(files.socket, () => resolve(undefined))
  })
  if (listening !== undefined) {
    opts.stderr.write(`buracle mcp backend: cannot listen on ${files.socket}: ${listening}\n`)
    stopping = true
    clearInterval(homeWatch)
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as NodeJS.Signals[]) process.off(s, onSignal)
    release()
    return 1
  }
  try { chmodSync(files.socket, 0o600) } catch {  }
  socketId = identity(files.socket)
  log('info', 'mcp backend: listening', { id, key, socket: files.socket, pid: process.pid })
  armLinger()
  startUpstream()
  return finished
}

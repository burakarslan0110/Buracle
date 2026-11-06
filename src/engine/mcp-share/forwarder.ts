/**
 * The per-session side of a shared or lazy MCP server: `buracle mcp run <id>` stays this thin forwarder
 * for the whole harness session. It answers the lifecycle itself (`server/discover`, `ping`, and
 * `initialize` and `tools/list` from the per-version cache), so an idle session starts no server. The first
 * other request opens a link: to the shared backend's Unix socket (./backend.ts), or to the session's own
 * server as a child (a lazy server). After `idleMs()` without a call it lets go of the link, and its next
 * call opens one again. Keep the imports light: this process lives as long as its session.
 */
import { join } from 'node:path'
import type { McpServerSpec } from '../../core/catalog'
import { watchParent } from '../parent-watch'
import * as paths from '../paths'
import { freshMcpCache, type McpCache, writeMcpCache } from './cache'
import { backendFiles, backendKey, idleMs, installedVersion, ownedByMe } from './common'
import { LineSplitter } from './lines'
import { LEGACY_PROTOCOL_VERSIONS } from './mux'

type Msg = Record<string, unknown>
type Id = string | number

export interface Link {
  send(m: Msg): void
  /** A lazy child's link resolves when the child is gone (SIGKILL after LAZY_KILL_GRACE_MS). */
  close(): void | Promise<void>
}
export interface LinkHandlers {
  message(m: Msg): void
  closed(): void
}
/** Opens a link to the server, or gives up (undefined). */
export type Connector = (h: LinkHandlers) => Promise<Link | undefined>

/** How long a forwarder waits for a backend it started to listen. */
export const BACKEND_START_WAIT_MS = 20_000
const REPLAY_ID = '__buracle_replay__'

function isObj(x: unknown): x is Msg {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function isId(x: unknown): x is Id {
  return typeof x === 'string' || typeof x === 'number'
}

const result = (id: Id, value: unknown): Msg => ({ jsonrpc: '2.0', id, result: value })
const rpcError = (id: Id, code: number, message: string): Msg => ({ jsonrpc: '2.0', id, error: { code, message } })

export interface ForwarderOptions {
  id: string
  spec: McpServerSpec
  connect: Connector
  /** The cache key: the installed package version, or `latest`. Read at each cache lookup, since the toolchain can change during a session. */
  version: () => string
  write?: (line: string) => void
  input?: AsyncIterable<Uint8Array | string>
  env?: Readonly<Record<string, string | undefined>>
  /** Called when the link answered the client's `tools/list` (a lazy forwarder writes the cache from it). */
  onToolsList?: (initialize: Msg | undefined, tools: unknown[], viaLink: boolean) => void
  /** Close a link that only answered `initialize` and `tools/list` (a lazy server started to fill the cache). */
  releaseAfterLifecycle?: boolean
}

const LIFECYCLE = new Set(['initialize', 'tools/list'])

export interface Forwarder {
  /** Closes the link now (a lazy forwarder that started its child only to fill the cache). */
  release(): void
}

export async function runForwarder(opts: ForwarderOptions, hooks: { started?: (f: Forwarder) => void } = {}): Promise<number> {
  const env = opts.env ?? process.env
  const write = opts.write ?? ((line: string) => { process.stdout.write(line) })
  const out = (m: Msg): void => write(`${JSON.stringify(m)}\n`)
  const noCache = env['BURACLE_MCP_NO_CACHE'] === '1'
  const loadCache = (): McpCache | undefined => (noCache ? undefined : freshMcpCache(opts.id, opts.version()))
  let cache = loadCache()
  let clientInit: { id: Id, params: Msg } | undefined
  let initAnswered = false
  let initResult: Msg | undefined
  let link: Link | undefined
  let linkReady = false
  let connecting = false
  const queue: Msg[] = []
  const pending = new Map<Id, string>()
  let lastUse = Date.now()
  let replayWaiter: ((ok: boolean, why?: string) => void) | undefined
  /** Whether the open link got a request other than initialize and tools/list. */
  let realCall = false

  const failPending = (message: string): void => {
    for (const id of pending.keys()) out(rpcError(id, -32603, message))
    pending.clear()
  }

  const handlers: LinkHandlers = {
    message(m) {
      const id = m['id']
      const method = m['method']
      if (id === REPLAY_ID && method === undefined) {
        const err = m['error']
        replayWaiter?.(isObj(m['result']), isObj(err) && typeof err['message'] === 'string' ? err['message'] : undefined)
        replayWaiter = undefined
        return
      }
      if (method === undefined && isId(id)) {
        const asked = pending.get(id)
        if (asked === undefined) return
        pending.delete(id)
        lastUse = Date.now()
        if (clientInit !== undefined && id === clientInit.id && !initAnswered) {
          initAnswered = true
          if (isObj(m['result'])) initResult = m['result']
          out(m)
          link?.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        } else {
          if (asked === 'tools/list' && isObj(m['result']) && Array.isArray(m['result']['tools']) && m['result']['nextCursor'] === undefined) {
            opts.onToolsList?.(initResult ?? cache?.initialize, m['result']['tools'], true)
          }
          out(m)
          if (opts.releaseAfterLifecycle === true && asked === 'tools/list' && !realCall && pending.size === 0 && queue.length === 0) release()
        }
        return
      }
      out(m)
    },
    closed() {
      link = undefined
      linkReady = false
      if (replayWaiter !== undefined) { replayWaiter(false); replayWaiter = undefined }
      failPending(`the ${opts.id} MCP server stopped; the next call starts it again`)
      cache = loadCache()
    },
  }

  const failQueue = (message: string): void => {
    for (const m of queue.splice(0)) {
      const id = m['id']
      if (isId(id)) { pending.delete(id); out(rpcError(id, -32603, message)) }
    }
  }

  const ensureLink = async (): Promise<void> => {
    if (link !== undefined || connecting) return
    connecting = true
    try {
      const l = await opts.connect(handlers)
      if (l === undefined) { failQueue(`cannot reach the ${opts.id} MCP server`); return }
      link = l
      linkReady = false
      realCall = queue.some(m => !LIFECYCLE.has(String(m['method'])))
      // A client whose initialize was answered without this link: open the link's session for it.
      if (clientInit !== undefined && initAnswered) {
        const params = clientInit.params
        const answer = await new Promise<{ ok: boolean, why?: string }>(res => {
          const t = setTimeout(() => { replayWaiter = undefined; res({ ok: false }) }, BACKEND_START_WAIT_MS)
          replayWaiter = (ok, why) => { clearTimeout(t); res({ ok, ...(why !== undefined ? { why } : {}) }) }
          l.send({ jsonrpc: '2.0', id: REPLAY_ID, method: 'initialize', params })
        })
        if (!answer.ok || link !== l) {
          if (link === l) release()
          // The backend's own reason (a launch error, the restart budget) already names the server.
          failQueue(answer.why ?? `the ${opts.id} MCP server did not start`)
          return
        }
        l.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      }
      linkReady = true
      for (const m of queue.splice(0)) l.send(m)
    } finally {
      connecting = false
    }
  }

  const forward = (m: Msg): void => {
    pending.set(m['id'] as Id, String(m['method']))
    lastUse = Date.now()
    if (!LIFECYCLE.has(String(m['method']))) realCall = true
    if (link !== undefined && linkReady) link.send(m)
    else {
      queue.push(m)
      void ensureLink()
    }
  }

  const closing = new Set<Promise<void>>()
  function release(): void {
    const l = link
    if (l === undefined) return
    link = undefined
    linkReady = false
    const gone = l.close()
    if (gone !== undefined) { closing.add(gone); void gone.finally(() => closing.delete(gone)) }
    cache = loadCache()
  }
  hooks.started?.({ release })
  let ending: Promise<void> | undefined
  /** The end of the session: closes the link and waits until a lazy server is gone, because its SIGKILL timer dies with this process. */
  const finish = (): Promise<void> => (ending ??= (async () => {
    release()
    if (closing.size > 0) await Promise.race([Promise.allSettled([...closing]), Bun.sleep(LAZY_KILL_GRACE_MS + 1_000)])
  })())

  const handleClient = (m: Msg): void => {
    const method = m['method']
    const id = m['id']
    if (typeof method !== 'string') {
      // An answer to a request of the server (a lazy child's roots/list).
      if (isId(id) && link !== undefined) link.send(m)
      return
    }
    if (!isId(id)) {
      if (method === 'notifications/initialized') return
      if (link !== undefined) link.send(m)
      return
    }
    if (method === 'server/discover') { out(rpcError(id, -32601, 'Method not found: server/discover')); return }
    if (method === 'ping') { out(result(id, {})); return }
    if (method === 'initialize') {
      const params = isObj(m['params']) ? m['params'] : {}
      clientInit = { id, params }
      if (cache !== undefined) {
        initAnswered = true
        const asked = params['protocolVersion']
        const v = typeof asked === 'string' && LEGACY_PROTOCOL_VERSIONS.includes(asked) ? asked : cache.initialize['protocolVersion']
        out(result(id, { ...cache.initialize, protocolVersion: v }))
        return
      }
      forward(m)
      return
    }
    // A client that remembered the newer protocol era sends requests without initialize: make it probe again.
    if (clientInit === undefined) { out(rpcError(id, -32600, 'Send initialize first')); return }
    if (method === 'tools/list' && cache !== undefined && link === undefined) {
      out(result(id, { tools: cache.tools }))
      opts.onToolsList?.(cache.initialize, cache.tools, false)
      return
    }
    forward(m)
  }

  const idle = idleMs(env)
  const idleTimer = setInterval(() => {
    if (link !== undefined && linkReady && pending.size === 0 && queue.length === 0 && Date.now() - lastUse >= idle) release()
  }, Math.max(50, Math.min(Math.floor(idle / 4), 30_000)))

  const ownInput = opts.input === undefined
  const stop = (): void => { void finish().then(() => process.exit(0)) }
  const parent = ownInput ? watchParent({ onGone: stop }) : undefined
  // A harness stops its server with a signal (Claude Code: SIGINT, then SIGTERM, then SIGKILL): pass the stop on to a lazy server first.
  const signals: NodeJS.Signals[] = ownInput ? ['SIGINT', 'SIGTERM', 'SIGHUP'] : []
  for (const s of signals) process.on(s, stop)
  const input = opts.input ?? (Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>)
  const split = new LineSplitter()
  const take = (line: string): void => {
    let m: unknown
    try { m = JSON.parse(line) } catch { return }
    if (isObj(m)) handleClient(m)
  }
  try {
    for await (const chunk of input) for (const line of split.push(chunk)) take(line)
    for (const line of split.end()) take(line)
  } finally {
    clearInterval(idleTimer)
    parent?.stop()
    // The handlers stay while finish() waits: a harness that ends stdin and then signals still gets its lazy server stopped.
    await finish()
    for (const s of signals) process.off(s, stop)
  }
  return 0
}

/** Opens a connection to a backend socket; resolves undefined when nothing listens there. */
export async function connectSocket(path: string, h: LinkHandlers): Promise<Link | undefined> {
  const split = new LineSplitter()
  let backlog: Buffer[] = []
  let closed = false
  let sock: { write(b: Uint8Array): number, end(): void } | undefined
  const flush = (): void => {
    if (sock === undefined) return
    while (backlog.length > 0) {
      const b = backlog[0] as Buffer
      const n = sock.write(b)
      if (n < b.length) { backlog[0] = b.subarray(Math.max(0, n)); return }
      backlog.shift()
    }
  }
  try {
    sock = await Bun.connect({
      unix: path,
      socket: {
        data(_s, chunk) {
          for (const line of split.push(chunk)) {
            let m: unknown
            try { m = JSON.parse(line) } catch { continue }
            if (isObj(m)) h.message(m)
          }
        },
        drain() { flush() },
        close() {
          if (closed) return
          closed = true
          backlog = []
          h.closed()
        },
        error() {  },
      },
    })
  } catch {
    return undefined
  }
  return {
    send(m) {
      if (closed) return
      backlog.push(Buffer.from(`${JSON.stringify(m)}\n`))
      if (backlog.length === 1) flush()
    },
    close() {
      if (closed) return
      closed = true
      backlog = []
      try { sock?.end() } catch {  }
    },
  }
}

function startBackend(id: string, packageVersion: string, env: Readonly<Record<string, string | undefined>>): ReturnType<typeof Bun.spawn> | undefined {
  const main = join(import.meta.dir, '..', '..', 'cli', 'main.ts')
  try {
    // Its own process group: a harness that kills the group of its server must not stop the shared backend.
    const child = Bun.spawn([process.execPath, main, 'mcp', 'backend', id, `--package-version=${packageVersion}`], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, cwd: paths.home(), env: { ...env } })
    child.unref()
    return child
  } catch {
    return undefined
  }
}

/** How long a backend that stepped aside may leave the socket silent before the forwarder starts another one; doubled after each try. */
export const BACKEND_RETRY_MS = 500

/** Connects to the shared backend of `id`, starting it when nothing listens yet. */
export function sharedConnector(id: string, spec: McpServerSpec, env: Readonly<Record<string, string | undefined>>): Connector {
  return async h => {
    // Read at each connect, and handed to the backend it starts: both sides use one key even after a toolchain update.
    const installed = installedVersion(spec)
    const files = backendFiles(backendKey(id, installed))
    const deadline = Date.now() + BACKEND_START_WAIT_MS
    let backend: ReturnType<typeof Bun.spawn> | undefined
    let silentSince: number | undefined
    let retryMs = BACKEND_RETRY_MS
    for (;;) {
      if (ownedByMe(files.socket)) {
        const l = await connectSocket(files.socket, h)
        if (l !== undefined) {
          l.send({ jsonrpc: '2.0', method: 'buracle/hello', params: { pid: process.pid } })
          return l
        }
      }
      if (backend === undefined) backend = startBackend(id, installed ?? 'latest', env)
      else if (backend.exitCode !== null || backend.signalCode !== null) {
        // A signal or any exit but 0: the backend refused to start.
        if (backend.signalCode !== null || backend.exitCode !== 0) return undefined
        // Exit 0: another backend holds the lock. It listens soon, or it is on its way out (a call at the end of the
        // linger time, or right after `buracle mcp stop`): then a later backend takes the lock over. Each try waits twice as long.
        silentSince ??= Date.now()
        if (Date.now() - silentSince >= retryMs) { backend = startBackend(id, installed ?? 'latest', env); silentSince = undefined; retryMs *= 2 }
      }
      if (Date.now() > deadline) return undefined
      await Bun.sleep(40)
    }
  }
}

/** A lazy server ignoring SIGTERM gets SIGKILL this long after it. */
export const LAZY_KILL_GRACE_MS = 5_000

/**
 * Starts the session's own copy of a lazy server as a child. It stays in the forwarder's process group, so a
 * harness that kills the group of its server stops it too; the stop sends SIGTERM (chrome-devtools-mcp
 * closes its Chrome then) and SIGKILL after LAZY_KILL_GRACE_MS.
 */
export function lazyConnector(id: string, spec: McpServerSpec, env: Readonly<Record<string, string | undefined>>): Connector {
  return async h => {
    // Loaded on the first real call only: the launcher reads the toolchain and the YAML catalog.
    const { launchPlan } = await import('../toolchain/launch')
    const { readToolchainState } = await import('../toolchain/state')
    const { withSystemTools } = await import('../toolchain/packages')
    const plan = launchPlan(id, spec, readToolchainState())
    if ('error' in plan) {
      process.stderr.write(`buracle mcp run: ${plan.error}\n`)
      return undefined
    }
    const childEnv: Record<string, string | undefined> = { ...env, ...plan.env }
    const pathKey = Object.keys(childEnv).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
    childEnv[pathKey] = withSystemTools(childEnv[pathKey])
    let child: ReturnType<typeof Bun.spawn>
    try {
      child = Bun.spawn([...plan.argv], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', env: childEnv })
    } catch (e) {
      process.stderr.write(`buracle mcp run: cannot start ${plan.argv[0] ?? id}: ${e instanceof Error ? e.message : String(e)}\n`)
      return undefined
    }
    let ended = false
    const split = new LineSplitter()
    void (async () => {
      try {
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          for (const line of split.push(chunk)) {
            let m: unknown
            try { m = JSON.parse(line) } catch { continue }
            if (isObj(m) && !ended) h.message(m)
          }
        }
      } catch {  }
    })()
    void child.exited.then(() => {
      if (ended) return
      ended = true
      h.closed()
    })
    const stdin = child.stdin as import('bun').FileSink
    return {
      send(m) {
        if (ended) return
        try { stdin.write(`${JSON.stringify(m)}\n`); stdin.flush() } catch {  }
      },
      close() {
        if (ended) return
        ended = true
        try { child.kill('SIGTERM') } catch {  }
        const t = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL') } catch {  } } }, LAZY_KILL_GRACE_MS)
        return child.exited.then(() => { clearTimeout(t) })
      },
    }
  }
}

export async function runLazyForwarder(id: string, spec: McpServerSpec, opts: { write?: (line: string) => void } = {}): Promise<number> {
  const version = (): string => installedVersion(spec) ?? 'latest'
  return runForwarder({
    id,
    spec,
    version,
    connect: lazyConnector(id, spec, process.env),
    releaseAfterLifecycle: true,
    onToolsList: (initialize, tools, viaLink) => {
      if (viaLink && initialize !== undefined) writeMcpCache({ v: 1, id, version: version(), initialize, tools })
    },
    ...(opts.write !== undefined ? { write: opts.write } : {}),
  })
}

export async function runSharedForwarder(id: string, spec: McpServerSpec, opts: { write?: (line: string) => void } = {}): Promise<number> {
  return runForwarder({ id, spec, version: () => installedVersion(spec) ?? 'latest', connect: sharedConnector(id, spec, process.env), ...(opts.write !== undefined ? { write: opts.write } : {}) })
}

/**
 * Routes MCP JSON-RPC messages between many clients (one per harness session) and one upstream server
 * session. It does no IO: every call returns the messages to send. The mux opens the upstream with its own
 * legacy `initialize` (no client capabilities, so the upstream never asks a client anything) and answers
 * each client's `initialize` from that one result. Request ids and progress tokens are rewritten so that
 * two clients never see each other's answers or progress.
 */

type Msg = Record<string, unknown>
type Id = string | number

/** The protocol version of the mux's own handshake with the upstream. */
export const UPSTREAM_PROTOCOL_VERSION = '2025-11-25'
/** Legacy versions a client may ask for: the answer echoes one of these, any other gets the upstream's version. */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']

export type MuxOut =
  | { to: 'upstream', msg: Msg }
  | { to: 'client', client: string, msg: Msg }
  | { to: 'cache', initialize: Msg, tools: unknown[] }
  | { to: 'start' }

export interface Mux {
  attach(client: string): void
  /** Forgets the client: its pending requests stay with the upstream, but their answers are dropped. */
  detach(client: string): void
  clients(): string[]
  clientPid(client: string): number | undefined
  /** Client requests the upstream has not answered yet, including the ones waiting for a start. */
  pendingCount(): number
  /** Begins a new upstream session: returns the mux's own `initialize`. */
  startUpstream(): MuxOut[]
  fromClient(client: string, msg: unknown): MuxOut[]
  fromUpstream(msg: unknown): MuxOut[]
  /** The upstream process ended (or could not start): every waiting and pending request gets an error. */
  upstreamExited(reason: string): MuxOut[]
}

type State = 'down' | 'starting' | 'ready'
interface Pending { client: string, id: Id, token?: string }
type Internal = 'init' | 'tools'

function isObj(x: unknown): x is Msg {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function isId(x: unknown): x is Id {
  return typeof x === 'string' || typeof x === 'number'
}

function result(id: Id, value: unknown): Msg {
  return { jsonrpc: '2.0', id, result: value }
}

function rpcError(id: Id, code: number, message: string): Msg {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

const LIST_CHANGED = new Set(['notifications/tools/list_changed', 'notifications/resources/list_changed', 'notifications/prompts/list_changed'])

export function createMux(opts: { server: string, clientVersion?: string }): Mux {
  const server = opts.server
  let state: State = 'down'
  let init: Msg | undefined
  let nextUp = 1
  let nextToken = 1
  const attached = new Map<string, { pid?: number }>()
  const pending = new Map<number, Pending>()
  const internal = new Map<number, Internal>()
  const tokens = new Map<string, { client: string, token: unknown }>()
  const waitingInit: Array<{ client: string, id: Id, version: unknown }> = []
  const queued: Array<{ client: string, msg: Msg }> = []

  const initAnswer = (id: Id, version: unknown, base: Msg): Msg => {
    const v = typeof version === 'string' && LEGACY_PROTOCOL_VERSIONS.includes(version) ? version : base['protocolVersion']
    return result(id, { ...base, protocolVersion: v })
  }

  const internalRequest = (kind: Internal, method: string, params: Msg): MuxOut => {
    const id = nextUp++
    internal.set(id, kind)
    return { to: 'upstream', msg: { jsonrpc: '2.0', id, method, params } }
  }

  const forward = (client: string, msg: Msg): MuxOut[] => {
    const id = msg['id'] as Id
    const up = nextUp++
    const entry: Pending = { client, id }
    let params = msg['params']
    if (isObj(params) && isObj(params['_meta']) && params['_meta']['progressToken'] !== undefined) {
      const token = `p${nextToken++}`
      tokens.set(token, { client, token: params['_meta']['progressToken'] })
      entry.token = token
      params = { ...params, _meta: { ...params['_meta'], progressToken: token } }
    }
    pending.set(up, entry)
    const out: Msg = { ...msg, id: up }
    if (params !== undefined) out['params'] = params
    return [{ to: 'upstream', msg: out }]
  }

  const settle = (up: number): Pending | undefined => {
    const p = pending.get(up)
    if (p === undefined) return undefined
    pending.delete(up)
    if (p.token !== undefined) tokens.delete(p.token)
    return p
  }

  const failAll = (message: string): MuxOut[] => {
    const out: MuxOut[] = []
    for (const [up] of [...pending]) {
      const p = settle(up)
      if (p !== undefined && attached.has(p.client)) out.push({ to: 'client', client: p.client, msg: rpcError(p.id, -32603, message) })
    }
    for (const w of waitingInit.splice(0)) if (attached.has(w.client)) out.push({ to: 'client', client: w.client, msg: rpcError(w.id, -32603, message) })
    for (const q of queued.splice(0)) if (attached.has(q.client)) out.push({ to: 'client', client: q.client, msg: rpcError(q.msg['id'] as Id, -32603, message) })
    return out
  }

  return {
    attach(client) { if (!attached.has(client)) attached.set(client, {}) },
    detach(client) {
      attached.delete(client)
      for (let i = waitingInit.length - 1; i >= 0; i--) if (waitingInit[i]?.client === client) waitingInit.splice(i, 1)
      for (let i = queued.length - 1; i >= 0; i--) if (queued[i]?.client === client) queued.splice(i, 1)
    },
    clients: () => [...attached.keys()],
    clientPid: client => attached.get(client)?.pid,
    pendingCount: () => [...pending.values()].filter(p => attached.has(p.client)).length + queued.length,

    startUpstream() {
      state = 'starting'
      init = undefined
      pending.clear()
      internal.clear()
      tokens.clear()
      return [internalRequest('init', 'initialize', { protocolVersion: UPSTREAM_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'buracle', version: opts.clientVersion ?? '0' } })]
    },

    fromClient(client, raw) {
      if (!isObj(raw) || !attached.has(client)) return []
      const method = raw['method']
      const id = raw['id']
      if (typeof method !== 'string') return []
      if (!isId(id)) {
        if (method === 'buracle/hello') {
          const params = raw['params']
          const pid = isObj(params) && typeof params['pid'] === 'number' ? params['pid'] : undefined
          if (pid !== undefined) attached.set(client, { pid })
          return []
        }
        if (method === 'notifications/cancelled') {
          const params = raw['params']
          if (!isObj(params)) return []
          const target = params['requestId']
          for (const [up, p] of pending) {
            if (p.client === client && p.id === target) return [{ to: 'upstream', msg: { ...raw, params: { ...params, requestId: up } } }]
          }
          return []
        }
        return []
      }
      if (method === 'initialize') {
        const params = raw['params']
        const version = isObj(params) ? params['protocolVersion'] : undefined
        if (init !== undefined) return [{ to: 'client', client, msg: initAnswer(id, version, init) }]
        waitingInit.push({ client, id, version })
        if (state === 'down') {
          state = 'starting'
          return [{ to: 'start' }]
        }
        return []
      }
      if (method === 'ping') return [{ to: 'client', client, msg: result(id, {}) }]
      if (method === 'server/discover') return [{ to: 'client', client, msg: rpcError(id, -32601, 'Method not found: server/discover') }]
      if (state !== 'ready') {
        queued.push({ client, msg: raw })
        if (state === 'down') {
          state = 'starting'
          return [{ to: 'start' }]
        }
        return []
      }
      return forward(client, raw)
    },

    fromUpstream(raw) {
      if (!isObj(raw)) return []
      const method = raw['method']
      const id = raw['id']
      if (typeof method === 'string' && isId(id)) {
        if (method === 'ping') return [{ to: 'upstream', msg: result(id, {}) }]
        return [{ to: 'upstream', msg: rpcError(id, -32601, `Method not found: ${method}`) }]
      }
      if (typeof method === 'string') {
        if (method === 'notifications/progress') {
          const params = raw['params']
          if (!isObj(params)) return []
          const t = typeof params['progressToken'] === 'string' ? tokens.get(params['progressToken']) : undefined
          if (t === undefined || !attached.has(t.client)) return []
          return [{ to: 'client', client: t.client, msg: { ...raw, params: { ...params, progressToken: t.token } } }]
        }
        if (LIST_CHANGED.has(method)) {
          const out: MuxOut[] = [...attached.keys()].map(client => ({ to: 'client' as const, client, msg: raw }))
          if (method === 'notifications/tools/list_changed' && init !== undefined) out.push(internalRequest('tools', 'tools/list', {}))
          return out
        }
        return []
      }
      if (typeof id !== 'number') return []
      const kind = internal.get(id)
      if (kind !== undefined) {
        internal.delete(id)
        const res = raw['result']
        if (kind === 'init') {
          if (!isObj(res)) {
            state = 'down'
            const err = raw['error']
            return failAll(`${server} MCP server did not start: ${isObj(err) && typeof err['message'] === 'string' ? err['message'] : 'initialize failed'}`)
          }
          init = res
          state = 'ready'
          const out: MuxOut[] = [{ to: 'upstream', msg: { jsonrpc: '2.0', method: 'notifications/initialized' } }, internalRequest('tools', 'tools/list', {})]
          for (const w of waitingInit.splice(0)) if (attached.has(w.client)) out.push({ to: 'client', client: w.client, msg: initAnswer(w.id, w.version, res) })
          for (const q of queued.splice(0)) if (attached.has(q.client)) out.push(...forward(q.client, q.msg))
          return out
        }
        if (isObj(res) && Array.isArray(res['tools']) && res['nextCursor'] === undefined && init !== undefined) return [{ to: 'cache', initialize: init, tools: res['tools'] }]
        return []
      }
      const p = settle(id)
      if (p === undefined || !attached.has(p.client)) return []
      return [{ to: 'client', client: p.client, msg: { ...raw, id: p.id } }]
    },

    upstreamExited(reason) {
      state = 'down'
      init = undefined
      internal.clear()
      return failAll(`${server} MCP server stopped: ${reason}`)
    },
  }
}

import { describe, expect, test } from 'bun:test'
import { LineSplitter } from '../../../src/engine/mcp-share/lines'
import { createMux, LEGACY_PROTOCOL_VERSIONS, UPSTREAM_PROTOCOL_VERSION, type Mux, type MuxOut } from '../../../src/engine/mcp-share/mux'

type Msg = Record<string, unknown>

const INIT = { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'stub', version: '1.0.0' }, instructions: 'use me' }
const TOOLS = [{ name: 'ping', inputSchema: { type: 'object' } }]

const toUp = (out: MuxOut[]): Msg[] => out.flatMap(o => (o.to === 'upstream' ? [o.msg] : []))
const toClient = (out: MuxOut[], c: string): Msg[] => out.flatMap(o => (o.to === 'client' && o.client === c ? [o.msg] : []))

/** A mux whose upstream has finished its own handshake: returns the mux and the upstream id of its tools/list. */
function ready(server = 'stub'): Mux {
  const mux = createMux({ server })
  const [init] = toUp(mux.startUpstream())
  const after = mux.fromUpstream({ jsonrpc: '2.0', id: init?.['id'], result: INIT })
  const list = toUp(after).find(m => m['method'] === 'tools/list')
  mux.fromUpstream({ jsonrpc: '2.0', id: list?.['id'], result: { tools: TOOLS } })
  return mux
}

describe('upstream handshake', () => {
  test('the mux opens the upstream with its own initialize, then initialized and tools/list, and reports the cache', () => {
    const mux = createMux({ server: 'stub' })
    const [init] = toUp(mux.startUpstream())
    expect(init).toMatchObject({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: UPSTREAM_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'buracle' } } })
    expect(UPSTREAM_PROTOCOL_VERSION).toBe('2025-11-25')
    const after = mux.fromUpstream({ jsonrpc: '2.0', id: init?.['id'], result: INIT })
    expect(toUp(after).map(m => m['method'])).toEqual(['notifications/initialized', 'tools/list'])
    const list = toUp(after)[1]
    const done = mux.fromUpstream({ jsonrpc: '2.0', id: list?.['id'], result: { tools: TOOLS } })
    expect(done).toContainEqual({ to: 'cache', initialize: INIT, tools: TOOLS })
  })

  test('no cache when tools/list is paged (nextCursor)', () => {
    const mux = createMux({ server: 'stub' })
    const [init] = toUp(mux.startUpstream())
    const list = toUp(mux.fromUpstream({ jsonrpc: '2.0', id: init?.['id'], result: INIT }))[1]
    const done = mux.fromUpstream({ jsonrpc: '2.0', id: list?.['id'], result: { tools: TOOLS, nextCursor: 'p2' } })
    expect(done.some(o => o.to === 'cache')).toBe(false)
  })
})

describe('client lifecycle answered by the mux', () => {
  test('initialize gets the cached upstream result and sends nothing upstream', () => {
    const mux = ready()
    mux.attach('a')
    const out = mux.fromClient('a', { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { roots: {} }, clientInfo: { name: 'claude-code' } } })
    expect(toUp(out)).toEqual([])
    expect(toClient(out, 'a')).toEqual([{ jsonrpc: '2.0', id: 0, result: { ...INIT, protocolVersion: '2025-11-25' } }])
  })

  test('the answer echoes every listed legacy version, and gives the cached version for any other', () => {
    expect([...LEGACY_PROTOCOL_VERSIONS]).toEqual(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'])
    const mux = ready()
    mux.attach('a')
    for (const v of LEGACY_PROTOCOL_VERSIONS) {
      const [r] = toClient(mux.fromClient('a', { jsonrpc: '2.0', id: v, method: 'initialize', params: { protocolVersion: v } }), 'a')
      expect((r?.['result'] as Msg)['protocolVersion']).toBe(v)
    }
    for (const v of ['2026-07-28', 'draft', undefined]) {
      const [r] = toClient(mux.fromClient('a', { jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: v } }), 'a')
      expect((r?.['result'] as Msg)['protocolVersion']).toBe('2025-11-25')
    }
  })

  test('an initialize before the upstream answered waits, and is answered when the upstream result arrives', () => {
    const mux = createMux({ server: 'stub' })
    const [init] = toUp(mux.startUpstream())
    mux.attach('a')
    expect(mux.fromClient('a', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).toEqual([])
    const out = mux.fromUpstream({ jsonrpc: '2.0', id: init?.['id'], result: INIT })
    expect(toClient(out, 'a')).toEqual([{ jsonrpc: '2.0', id: 1, result: { ...INIT, protocolVersion: '2025-06-18' } }])
  })

  test('initialized is dropped; buracle/hello records the pid and is not forwarded; ping and server/discover are answered here', () => {
    const mux = ready()
    mux.attach('a')
    expect(mux.fromClient('a', { jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual([])
    expect(mux.fromClient('a', { jsonrpc: '2.0', method: 'buracle/hello', params: { pid: 4242 } })).toEqual([])
    expect(mux.clientPid('a')).toBe(4242)
    expect(mux.fromClient('a', { jsonrpc: '2.0', id: 'p', method: 'ping' })).toEqual([{ to: 'client', client: 'a', msg: { jsonrpc: '2.0', id: 'p', result: {} } }])
    const [d] = toClient(mux.fromClient('a', { jsonrpc: '2.0', id: 'd', method: 'server/discover' }), 'a')
    expect(d).toMatchObject({ jsonrpc: '2.0', id: 'd', error: { code: -32601 } })
  })
})

describe('request routing', () => {
  test('two clients that both use request id 1 each get their own answer with id 1', () => {
    const mux = ready()
    mux.attach('a')
    mux.attach('b')
    const [upA] = toUp(mux.fromClient('a', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: { who: 'a' } } }))
    const [upB] = toUp(mux.fromClient('b', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: { who: 'b' } } }))
    expect(upA?.['id']).not.toEqual(upB?.['id'])
    expect((upA?.['params'] as Msg)['arguments']).toEqual({ who: 'a' })
    const outB = mux.fromUpstream({ jsonrpc: '2.0', id: upB?.['id'], result: { content: [{ type: 'text', text: 'b' }] } })
    const outA = mux.fromUpstream({ jsonrpc: '2.0', id: upA?.['id'], result: { content: [{ type: 'text', text: 'a' }] } })
    expect(outB).toEqual([{ to: 'client', client: 'b', msg: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'b' }] } } }])
    expect(outA).toEqual([{ to: 'client', client: 'a', msg: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'a' }] } } }])
    expect(mux.pendingCount()).toBe(0)
  })

  test('two clients that send the same progress token each get only their own progress', () => {
    const mux = ready()
    mux.attach('a')
    mux.attach('b')
    const [upA] = toUp(mux.fromClient('a', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'sleep', _meta: { progressToken: 7 } } }))
    const [upB] = toUp(mux.fromClient('b', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'sleep', _meta: { progressToken: 7 } } }))
    const tA = ((upA?.['params'] as Msg)['_meta'] as Msg)['progressToken']
    const tB = ((upB?.['params'] as Msg)['_meta'] as Msg)['progressToken']
    expect(tA).not.toEqual(tB)
    const pb = mux.fromUpstream({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: tB, progress: 1, total: 2 } })
    expect(pb).toEqual([{ to: 'client', client: 'b', msg: { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 7, progress: 1, total: 2 } } }])
    const pa = mux.fromUpstream({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: tA, progress: 2, total: 2 } })
    expect(pa.map(o => (o.to === 'client' ? o.client : o.to))).toEqual(['a'])
  })

  test('a cancel reaches the upstream with the rewritten request id; a cancel of an unknown id is dropped', () => {
    const mux = ready()
    mux.attach('a')
    const [up] = toUp(mux.fromClient('a', { jsonrpc: '2.0', id: 'r1', method: 'tools/call', params: { name: 'sleep' } }))
    const out = mux.fromClient('a', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'r1', reason: 'user' } })
    expect(toUp(out)).toEqual([{ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: up?.['id'], reason: 'user' } }])
    expect(mux.fromClient('a', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'nope' } })).toEqual([])
  })
})

describe('upstream messages', () => {
  test('tools/list_changed goes to every client and refreshes the cache; logging messages are dropped', () => {
    const mux = ready()
    mux.attach('a')
    mux.attach('b')
    const out = mux.fromUpstream({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    expect(out.filter(o => o.to === 'client').map(o => (o.to === 'client' ? o.client : '')).sort()).toEqual(['a', 'b'])
    const refresh = toUp(out).find(m => m['method'] === 'tools/list')
    expect(refresh).toBeDefined()
    const next = [{ name: 'pong', inputSchema: { type: 'object' } }]
    expect(mux.fromUpstream({ jsonrpc: '2.0', id: refresh?.['id'], result: { tools: next } })).toContainEqual({ to: 'cache', initialize: INIT, tools: next })
    expect(mux.fromUpstream({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'x' } })).toEqual([])
  })

  test('an upstream ping gets {}; any other upstream request gets -32601', () => {
    const mux = ready()
    expect(mux.fromUpstream({ jsonrpc: '2.0', id: 'u1', method: 'ping' })).toEqual([{ to: 'upstream', msg: { jsonrpc: '2.0', id: 'u1', result: {} } }])
    for (const method of ['roots/list', 'sampling/createMessage', 'elicitation/create']) {
      const [r] = toUp(mux.fromUpstream({ jsonrpc: '2.0', id: method, method }))
      expect(r).toMatchObject({ jsonrpc: '2.0', id: method, error: { code: -32601 } })
    }
  })

  test('when the upstream exits, each pending request gets -32603 that names the server', () => {
    const mux = ready('web-fetch')
    mux.attach('a')
    mux.attach('b')
    mux.fromClient('a', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fetch' } })
    mux.fromClient('b', { jsonrpc: '2.0', id: 'x', method: 'tools/call', params: { name: 'fetch' } })
    const out = mux.upstreamExited('exit code 1')
    expect(toClient(out, 'a')).toEqual([{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: expect.stringContaining('web-fetch') } }])
    expect(toClient(out, 'b')[0]).toMatchObject({ id: 'x', error: { code: -32603 } })
    expect(mux.pendingCount()).toBe(0)
  })

  test('a detached client\'s late answer is dropped', () => {
    const mux = ready()
    mux.attach('a')
    const [up] = toUp(mux.fromClient('a', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }))
    mux.detach('a')
    expect(mux.fromUpstream({ jsonrpc: '2.0', id: up?.['id'], result: {} })).toEqual([])
    expect(mux.clients()).toEqual([])
  })
})

describe('a stopped upstream', () => {
  test('a request while the upstream is down asks for a start, waits, and goes out once the upstream is ready', () => {
    const mux = ready()
    mux.attach('a')
    mux.upstreamExited('crash')
    const out = mux.fromClient('a', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ping' } })
    expect(out).toEqual([{ to: 'start' }])
    const [init] = toUp(mux.startUpstream())
    const after = mux.fromUpstream({ jsonrpc: '2.0', id: init?.['id'], result: INIT })
    const call = toUp(after).find(m => m['method'] === 'tools/call')
    expect(call).toMatchObject({ method: 'tools/call', params: { name: 'ping' } })
    expect(toClient(mux.fromUpstream({ jsonrpc: '2.0', id: call?.['id'], result: { ok: 1 } }), 'a')).toEqual([{ jsonrpc: '2.0', id: 5, result: { ok: 1 } }])
  })

  test('requests that wait for a start that fails get the error', () => {
    const mux = createMux({ server: 'semble' })
    mux.attach('a')
    expect(mux.fromClient('a', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).toEqual([{ to: 'start' }])
    expect(mux.fromClient('a', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })).toEqual([])
    const out = mux.upstreamExited('cannot start uvx')
    expect(toClient(out, 'a').map(m => m['id'])).toEqual([1, 2])
    expect(toClient(out, 'a')[0]).toMatchObject({ error: { code: -32603, message: expect.stringContaining('cannot start uvx') } })
  })
})

describe('LineSplitter', () => {
  test('joins lines across chunk borders, keeps a multibyte character split by a border, and skips empty lines', () => {
    const s = new LineSplitter()
    const bytes = new TextEncoder().encode('{"a":"ığüşöç 🙂"}\n\n  \n{"b":1}\n{"c"')
    const out: string[] = []
    for (let i = 0; i < bytes.length; i += 3) out.push(...s.push(bytes.slice(i, i + 3)))
    expect(out).toEqual(['{"a":"ığüşöç 🙂"}', '{"b":1}'])
    expect(s.push(':2}\n')).toEqual(['{"c":2}'])
    expect(s.push('{"tail":true}')).toEqual([])
    expect(s.end()).toEqual(['{"tail":true}'])
  })
})

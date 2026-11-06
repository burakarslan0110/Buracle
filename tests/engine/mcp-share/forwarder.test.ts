import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { backendFiles, backendKey } from '../../../src/engine/mcp-share/common'
import { backendStates } from '../../../src/engine/mcp-share/procs'
import { probeServers } from '../../../src/engine/update/mcp'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { updateToolchainState } from '../../../src/engine/toolchain/state'
import { withSandbox } from '../../helpers/sandbox'
import { alive, call, drive, type Driver, initialize, installStub, lineCount, MAIN, type Msg, readJson, textOf, until, VERSION } from './helpers'

const FILES = () => backendFiles(backendKey('web-search', VERSION))

/** A cache whose tool list differs from the stub's live one, so a test can tell where an answer came from. */
function writeCache(tools: Msg[] = [{ name: 'cached-only', inputSchema: { type: 'object' } }], version = VERSION): void {
  mkdirSync(paths.mcpCacheDir(), { recursive: true })
  writeFileSync(paths.mcpCacheFile('web-search'), JSON.stringify({ v: 1, id: 'web-search', version, initialize: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'cached', version: '0' } }, tools }))
}

function runtimeConfig(config: Msg): void {
  mkdirSync(paths.stateDir(), { recursive: true })
  writeFileSync(paths.runtimeConfigFile(), JSON.stringify({ v: 1, config }))
}

async function withForwarders(fn: (ctx: { root: string, starts: string, drivers: Driver[], env: Record<string, string> }) => Promise<void>): Promise<void> {
  await withSandbox(async ({ root }) => {
    const drivers: Driver[] = []
    const starts = join(root, 'starts.txt')
    try {
      installStub(root)
      await fn({ root, starts, drivers, env: { STUB_STARTS: starts } })
    } finally {
      for (const d of drivers) { try { d.proc.kill('SIGKILL') } catch { /* gone */ } }
      const st = readJson(FILES().state)
      for (const pid of [st?.['pid'], st?.['upstreamPid']]) if (typeof pid === 'number') { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      rmSync(paths.mcpFallbackRunDir(), { recursive: true, force: true })
    }
  })
}

describe('buracle mcp run: the API key of a shared server', () => {
  async function withKeyed(fn: (ctx: { drivers: Driver[] }) => Promise<void>): Promise<void> {
    await withSandbox(async ({ root }) => {
      const drivers: Driver[] = []
      try {
        installStub(root, 'context7')
        await fn({ drivers })
      } finally {
        for (const d of drivers) { try { d.proc.kill('SIGKILL') } catch { /* gone */ } }
        for (const s of backendStates()) for (const pid of [s.pid, s.upstreamPid]) if (pid !== undefined) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
        rmSync(paths.mcpFallbackRunDir(), { recursive: true, force: true })
      }
    })
  }
  /** The CONTEXT7_API_KEY the session's server runs with; one retry covers a call sent while its backend was stopping. */
  async function keyOf(d: Driver, id: number): Promise<string> {
    for (const n of [id, id + 1000]) {
      d.send(call(n, 'env', { name: 'CONTEXT7_API_KEY' }))
      const m = await d.wait(x => x['id'] === n, 25_000)
      if (m['error'] === undefined) return textOf(m)
    }
    throw new Error('the call failed twice')
  }
  const live = () => backendStates().filter(s => s.id === 'context7' && alive(s.pid))
  const mcpKey = (...args: string[]) => Bun.spawnSync([process.execPath, MAIN, 'mcp', 'key', 'context7', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })

  test('a session whose environment has the key gets a server that runs with it, also while a backend without the key serves other sessions', () => withKeyed(async ({ drivers }) => {
    const a = drive('context7')
    drivers.push(a)
    a.send(initialize(0))
    expect(await keyOf(a, 1)).toBe('<unset>')
    const b = drive('context7', { CONTEXT7_API_KEY: 'key-of-session-b' })
    const c = drive('context7', { CONTEXT7_API_KEY: 'key-of-session-b' })
    drivers.push(b, c)
    for (const d of [b, c]) d.send(initialize(0))
    expect(await keyOf(b, 1)).toBe('key-of-session-b')
    expect(await keyOf(c, 1)).toBe('key-of-session-b')
    expect(await keyOf(a, 2)).toBe('<unset>')
    // One backend per key: b and c share theirs, and no file name, state file or command line holds the key.
    expect(live()).toHaveLength(2)
    const args = (pid: number) => Bun.spawnSync(['ps', '-o', 'args=', '-p', String(pid)], { stdout: 'pipe', env: { ...process.env } }).stdout.toString()
    for (const s of live()) {
      expect(s.file).not.toContain('key-of-session-b')
      expect(readFileSync(s.file, 'utf8')).not.toContain('key-of-session-b')
      expect(args(s.pid)).not.toContain('key-of-session-b')
    }
    expect(live().map(s => args(s.pid).includes('--api-key-env=CONTEXT7_API_KEY')).sort()).toEqual([false, true])
  }), 60_000)

  test('`buracle mcp key` stores the key: a running session gets it on its next call, the variable wins over it, and --clear takes it away', () => withKeyed(async ({ drivers }) => {
    const a = drive('context7')
    drivers.push(a)
    a.send(initialize(0))
    expect(await keyOf(a, 1)).toBe('<unset>')
    const set = mcpKey('stored-key-0123456789')
    expect(set.exitCode).toBe(0)
    expect(set.stdout.toString()).not.toContain('stored-key-0123456789')
    expect(await keyOf(a, 2)).toBe('stored-key-0123456789')
    const b = drive('context7', { CONTEXT7_API_KEY: 'key-from-the-environment' })
    drivers.push(b)
    b.send(initialize(0))
    expect(await keyOf(b, 1)).toBe('key-from-the-environment')
    expect(mcpKey('--clear').exitCode).toBe(0)
    expect(await keyOf(a, 3)).toBe('<unset>')
    expect(await keyOf(b, 2)).toBe('key-from-the-environment')
  }), 90_000)
})

describe('buracle mcp run: the forwarder of a shared server', () => {
  test('initialize and tools/list come from the cache, so an idle session starts no backend; discover, ping and an early request are answered here', () => withForwarders(async ({ drivers, env }) => {
    writeCache()
    const d = drive('web-search', env)
    drivers.push(d)
    d.send({ jsonrpc: '2.0', id: 'd', method: 'server/discover' })
    expect((await d.wait(m => m['id'] === 'd'))['error']).toMatchObject({ code: -32601 })
    d.send({ jsonrpc: '2.0', id: 'early', method: 'tools/list' })
    expect((await d.wait(m => m['id'] === 'early'))['error']).toMatchObject({ code: -32600 })
    d.send(initialize(0, '2025-06-18'))
    const init = await d.wait(m => m['id'] === 0)
    expect(init['result']).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'cached' } })
    d.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    d.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(((await d.wait(m => m['id'] === 1))['result'] as Msg)['tools']).toEqual([{ name: 'cached-only', inputSchema: { type: 'object' } }])
    d.send({ jsonrpc: '2.0', id: 'p', method: 'ping' })
    expect((await d.wait(m => m['id'] === 'p'))['result']).toEqual({})
    await Bun.sleep(800)
    expect(existsSync(FILES().state)).toBe(false)
    expect(existsSync(FILES().socket)).toBe(false)
  }), 30_000)

  test('without a valid cache the first start goes through the backend, which then writes the cache', () => withForwarders(async ({ drivers, env }) => {
    writeCache(undefined, '0.0.1')
    const d = drive('web-search', env)
    drivers.push(d)
    d.send(initialize(0))
    expect(((await d.wait(m => m['id'] === 0))['result'] as Msg)['serverInfo']).toEqual({ name: 'stub', version: '1.0.0' })
    d.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    d.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect((((await d.wait(m => m['id'] === 1))['result'] as Msg)['tools'] as Msg[]).map(t => t['name'])).toContain('ping')
    await until(() => readJson(paths.mcpCacheFile('web-search'))?.['version'] === VERSION)
  }), 30_000)

  test('two sessions that start in the same second share one backend and one upstream, each gets its own answers, and a 6 s call gets no time limit of its own', () => withForwarders(async ({ drivers, env, starts }) => {
    writeCache()
    const a = drive('web-search', env)
    const b = drive('web-search', env)
    drivers.push(a, b)
    for (const d of [a, b]) d.send(initialize(0))
    await Promise.all([a.wait(m => m['id'] === 0), b.wait(m => m['id'] === 0)])
    a.send(call(1, 'echo', { text: 'for a' }))
    b.send(call(1, 'echo', { text: 'for b' }))
    expect(textOf(await a.wait(m => m['id'] === 1, 25_000))).toBe('for a')
    expect(textOf(await b.wait(m => m['id'] === 1, 25_000))).toBe('for b')
    expect(lineCount(starts)).toBe(1)
    const state = readJson(FILES().state)
    expect([...(state?.['clients'] as number[])].sort()).toEqual([a.proc.pid, b.proc.pid].sort())
    a.send(call(2, 'sleep', { ms: 6_000, label: 'slow' }))
    expect(textOf(await a.wait(m => m['id'] === 2, 15_000))).toBe('slow')
  }), 60_000)

  test('a session within the linger time reuses the backend; after the last session the backend is gone within the linger time', () => withForwarders(async ({ drivers, env, starts }) => {
    writeCache()
    const e = { ...env, BURACLE_MCP_LINGER_MS: '2000' }
    const a = drive('web-search', e)
    drivers.push(a)
    a.send(initialize(0))
    a.send(call(1, 'ping'))
    expect(textOf(await a.wait(m => m['id'] === 1, 25_000))).toBe('pong')
    const backend = readJson(FILES().state)?.['pid'] as number
    expect(await a.end()).toBe(0)
    await Bun.sleep(700)
    const b = drive('web-search', e)
    drivers.push(b)
    b.send(initialize(0))
    b.send(call(1, 'ping'))
    expect(textOf(await b.wait(m => m['id'] === 1))).toBe('pong')
    expect(readJson(FILES().state)?.['pid']).toBe(backend)
    expect(lineCount(starts)).toBe(1)
    expect(await b.end()).toBe(0)
    const t0 = Date.now()
    await until(() => !alive(backend), 10_000)
    expect(Date.now() - t0).toBeLessThan(2_000 + 2_000)
    expect(existsSync(FILES().socket)).toBe(false)
  }), 60_000)

  test('after the idle time the forwarder lets go of the backend, and its next call connects again', () => withForwarders(async ({ drivers, env, starts }) => {
    writeCache()
    const d = drive('web-search', { ...env, BURACLE_MCP_IDLE_MS: '800', BURACLE_MCP_LINGER_MS: '500' })
    drivers.push(d)
    d.send(initialize(0))
    d.send(call(1, 'ping'))
    expect(textOf(await d.wait(m => m['id'] === 1, 25_000))).toBe('pong')
    const backend = readJson(FILES().state)?.['pid'] as number
    await until(() => !alive(backend), 10_000)
    expect(alive(d.proc.pid)).toBe(true)
    d.send(call(2, 'ping'))
    expect(textOf(await d.wait(m => m['id'] === 2, 25_000))).toBe('pong')
    expect(lineCount(starts)).toBe(2)
  }), 60_000)

  test('a broken backend connection fails the pending call, and the next call connects again', () => withForwarders(async ({ drivers, env }) => {
    writeCache()
    const d = drive('web-search', env)
    drivers.push(d)
    d.send(initialize(0))
    d.send(call(1, 'ping'))
    await d.wait(m => m['id'] === 1, 25_000)
    d.send(call(2, 'sleep', { ms: 5_000 }))
    await Bun.sleep(300)
    const st = readJson(FILES().state)
    process.kill(st?.['pid'] as number, 'SIGKILL')
    expect((await d.wait(m => m['id'] === 2))['error']).toMatchObject({ code: -32603 })
    d.send(call(3, 'ping'))
    expect(textOf(await d.wait(m => m['id'] === 3, 25_000))).toBe('pong')
  }), 60_000)

  test('a toolchain update between the start of a session and its first call: the call reaches a backend on the new version', () => withForwarders(async ({ drivers, env }) => {
    writeCache()
    const d = drive('web-search', env)
    drivers.push(d)
    d.send(initialize(0))
    expect(((await d.wait(m => m['id'] === 0))['result'] as Msg)['serverInfo']).toEqual({ name: 'cached', version: '0' })
    updateToolchainState(s => {
      const p = s.packages['npm:open-websearch']
      if (p !== undefined) p.version = '9.9.10'
    }, new Date(0).toISOString())
    const next = backendFiles(backendKey('web-search', '9.9.10'))
    try {
      d.send(call(1, 'ping'))
      expect(textOf(await d.wait(m => m['id'] === 1, 25_000))).toBe('pong')
      expect(readJson(next.state)?.['key']).toBe(backendKey('web-search', '9.9.10'))
    } finally {
      const st = readJson(next.state)
      for (const pid of [st?.['pid'], st?.['upstreamPid']]) if (typeof pid === 'number') { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }), 60_000)

  test('a call while the lock is still held by a backend on its way out: the forwarder starts another backend once the lock is free', () => withForwarders(async ({ drivers, env }) => {
    writeCache()
    const files = FILES()
    mkdirSync(files.dir, { recursive: true, mode: 0o700 })
    const leaving = Bun.spawn(['sleep', '2'], { env: { ...process.env } })
    writeFileSync(files.lock, JSON.stringify({ pid: leaving.pid, at: new Date().toISOString(), token: 'x' }), { mode: 0o600 })
    const d = drive('web-search', env)
    drivers.push(d)
    d.send(initialize(0))
    const t0 = Date.now()
    d.send(call(1, 'ping'))
    expect(textOf(await d.wait(m => m['id'] === 1, 25_000))).toBe('pong')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500)
    expect(Date.now() - t0).toBeLessThan(10_000)
  }), 60_000)

  test('a session answered from the cache whose server then fails to start gets the server\'s own reason', () => withForwarders(async ({ drivers, env }) => {
    writeCache()
    const d = drive('web-search', { ...env, STUB_INIT_ERROR: 'no browser here' })
    drivers.push(d)
    d.send(initialize(0))
    await d.wait(m => m['id'] === 0)
    d.send(call(1, 'ping'))
    const answer = await d.wait(m => m['id'] === 1, 25_000)
    expect(JSON.stringify(answer['error'])).toContain('no browser here')
  }), 60_000)

  test('the backend specs come from a small cut of hook-data.json, made once per build, so a forwarder never parses the whole snapshot', () => withForwarders(async ({ drivers, env, starts }) => {
    writeCache()
    const a = drive('web-search', env)
    drivers.push(a)
    a.send(initialize(0))
    await a.wait(m => m['id'] === 0)
    const cut = join(paths.mcpCacheDir(), '_backends.json')
    const doc = await until(() => readJson(cut))
    const kept = doc['servers'] as Record<string, Msg>
    expect(Object.keys(kept)).toContain('web-search')
    expect(Object.keys(kept)).not.toContain('codegraph')
    expect(Object.values(kept).every(spec => spec['backend'] === 'shared' || spec['backend'] === 'lazy')).toBe(true)
    // A cut of the same hook-data.json is trusted: one without web-search sends it the normal way, as its own process.
    writeFileSync(cut, JSON.stringify({ ...doc, servers: {} }))
    const b = drive('web-search', env)
    drivers.push(b)
    b.send(initialize(0))
    await b.wait(m => m['id'] === 0, 25_000)
    expect(readFileSync(starts, 'utf8')).toContain(`start ${b.proc.pid}`)
    // A cut with a broken entry is ignored, as is a cut of another hook-data.json; both are made again.
    writeFileSync(cut, JSON.stringify({ ...doc, servers: { 'web-search': null } }))
    const broken = drive('web-search', env)
    drivers.push(broken)
    broken.send(initialize(0))
    expect(((await broken.wait(m => m['id'] === 0))['result'] as Msg)['serverInfo']).toEqual({ name: 'cached', version: '0' })
    writeFileSync(cut, JSON.stringify({ ...doc, src: { ...(doc['src'] as Msg), size: 1 }, servers: {} }))
    const c = drive('web-search', env)
    drivers.push(c)
    c.send(initialize(0))
    expect(((await c.wait(m => m['id'] === 0))['result'] as Msg)['serverInfo']).toEqual({ name: 'cached', version: '0' })
    expect(readFileSync(starts, 'utf8')).not.toContain(`start ${c.proc.pid}`)
    expect(Object.keys(readJson(cut)?.['servers'] as Msg)).toContain('web-search')
  }), 60_000)

  test('BURACLE_MCP_NO_CACHE=1 answers nothing from the cache; a health probe therefore sees the live tool list', () => withForwarders(async ({ root, drivers, env }) => {
    writeCache()
    const d = drive('web-search', { ...env, BURACLE_MCP_NO_CACHE: '1' })
    drivers.push(d)
    d.send(initialize(0))
    expect(((await d.wait(m => m['id'] === 0, 25_000))['result'] as Msg)['serverInfo']).toEqual({ name: 'stub', version: '1.0.0' })
    d.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect((((await d.wait(m => m['id'] === 1))['result'] as Msg)['tools'] as Msg[]).map(t => t['name'])).toContain('ping')
    const shim = join(root, 'bin', 'buracle')
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${MAIN}' "$@"\n`, { mode: 0o755 })
    const catalog = { servers: { 'web-search': loadCanonicalSync(paths.canonicalDir()).mcp.servers['web-search']! } }
    const entries = await probeServers(catalog, { timeoutMs: 20_000, buracle: shim, fetcher: async () => ({ ok: false, status: 0 }) }, () => new Date().toISOString())
    expect(entries['web-search']).toMatchObject({ status: 'ok' })
    expect(entries['web-search']?.toolNames).toContain('ping')
    expect(entries['web-search']?.toolNames).not.toContain('cached-only')
  }), 60_000)

  test('with mcp.shared false the server takes over the process, as before', () => withForwarders(async ({ drivers, env, starts }) => {
    runtimeConfig({ mcp: { shared: false } })
    const d = drive('web-search', env)
    drivers.push(d)
    d.send(initialize(0))
    await d.wait(m => m['id'] === 0, 25_000)
    expect(readFileSync(starts, 'utf8').trim()).toBe(`start ${d.proc.pid}`)
    expect(existsSync(FILES().state)).toBe(false)
  }), 30_000)
})

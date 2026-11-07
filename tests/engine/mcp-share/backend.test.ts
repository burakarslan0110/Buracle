import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { backendFiles, backendKey } from '../../../src/engine/mcp-share/common'
import * as paths from '../../../src/engine/paths'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { alive, call, connect, installStub as installAs, lineCount, MAIN, type Msg, readJson, session, textOf, until, VERSION } from './helpers'

const KEY = backendKey('web-search', VERSION)
const installStub = (root: string, mode = 0o755): string => installAs(root, 'web-search', mode)

function startBackend(env: Record<string, string | undefined> = {}, id = 'web-search', extra: string[] = []) {
  return Bun.spawn([process.execPath, MAIN, 'mcp', 'backend', id, ...extra], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BURACLE_MCP_LINGER_MS: '60000', ...env } })
}

async function withBackendSandbox(fn: (ctx: { root: string, files: ReturnType<typeof backendFiles>, starts: string, kill: (p: { pid: number }) => void }) => Promise<void>): Promise<void> {
  await withSandbox(async ({ root }) => {
    const procs: Array<{ pid: number }> = []
    const files = backendFiles(KEY)
    try {
      await fn({ root, files, starts: join(root, 'starts.txt'), kill: p => { procs.push(p) } })
    } finally {
      const st = readJson(files.state)
      for (const pid of [st?.['pid'], st?.['upstreamPid'], ...procs.map(p => p.pid)]) if (typeof pid === 'number') { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
      rmSync(paths.mcpFallbackRunDir(), { recursive: true, force: true })
    }
  })
}

describe('buracle mcp backend', () => {
  test('refuses a server that has no shared backend', () => withSandbox(async () => {
    const r = Bun.spawnSync([process.execPath, MAIN, 'mcp', 'backend', 'codegraph'], { env: { ...process.env } })
    expect(r.exitCode).toBe(1)
    expect(r.stderr.toString()).toContain('shared')
  }), 30_000)

  test('one upstream serves two clients: private directory and socket, the cache, the state file, and a second backend of the same key steps aside', () => withBackendSandbox(async ({ root, files, starts, kill }) => {
    installStub(root)
    const b = startBackend({ STUB_STARTS: starts })
    kill(b)
    await until(() => existsSync(files.socket))
    expect(statSync(files.dir).mode & 0o777).toBe(0o700)
    expect(statSync(files.socket).mode & 0o777).toBe(0o600)
    const cache = await until(() => readJson(paths.mcpCacheFile('web-search')))
    expect(cache['version']).toBe(VERSION)
    expect((cache['tools'] as Msg[]).map(t => t['name'])).toContain('ping')
    expect((cache['initialize'] as Msg)['serverInfo']).toEqual({ name: 'stub', version: '1.0.0' })
    const state = await until(() => readJson(files.state))
    expect(state).toMatchObject({ pid: b.pid, clients: [], log: paths.mcpLogFile('web-search') })
    expect(typeof state['upstreamPid']).toBe('number')
    expect(typeof state['idleSince']).toBe('number')
    const second = startBackend()
    expect(await second.exited).toBe(0)
    const a = await session(files.socket, 1111)
    const c = await session(files.socket, 2222)
    a.send(call(1, 'echo', { text: 'for a' }))
    c.send(call(1, 'echo', { text: 'for c' }))
    expect(textOf(await a.wait(m => m['id'] === 1))).toBe('for a')
    expect(textOf(await c.wait(m => m['id'] === 1))).toBe('for c')
    const withClients = await until(() => { const s = readJson(files.state); return Array.isArray(s?.['clients']) && (s['clients'] as number[]).length === 2 ? s : undefined })
    expect([...(withClients['clients'] as number[])].sort()).toEqual([1111, 2222])
    expect(withClients['idleSince']).toBeUndefined()
    expect(lineCount(starts)).toBe(1)
    expect(readFileSync(paths.mcpLogFile('web-search'), 'utf8')).toContain('stub server')
    a.close()
    c.close()
  }), 30_000)

  test('it stops after the linger time without a client; a client within the linger time keeps the same upstream', () => withBackendSandbox(async ({ root, files, starts, kill }) => {
    installStub(root)
    const b = startBackend({ STUB_STARTS: starts, BURACLE_MCP_LINGER_MS: '1500' })
    kill(b)
    await until(() => existsSync(files.socket))
    const first = await session(files.socket, 1)
    first.close()
    await Bun.sleep(600)
    const again = await session(files.socket, 2)
    again.send(call(3, 'ping'))
    expect(textOf(await again.wait(m => m['id'] === 3))).toBe('pong')
    const upstream = readJson(files.state)?.['upstreamPid'] as number
    again.close()
    const t0 = Date.now()
    expect(await b.exited).toBe(0)
    expect(Date.now() - t0).toBeLessThan(1_500 + 2_000)
    expect(existsSync(files.socket)).toBe(false)
    expect(existsSync(files.state)).toBe(false)
    await until(() => !alive(upstream))
    expect(lineCount(starts)).toBe(1)
  }), 30_000)

  test('input that is not JSON-RPC, such as an HTTP request, is closed without an answer', () => withBackendSandbox(async ({ root, files, kill }) => {
    installStub(root)
    const b = startBackend()
    kill(b)
    await until(() => existsSync(files.socket))
    const c = await connect(files.socket)
    c.raw('GET / HTTP/1.1\r\nHost: evil.example\r\nOrigin: https://evil.example\r\n\r\n')
    await until(() => c.closed(), 3_000)
    expect(c.lines).toEqual([])
  }), 30_000)

  test('an upstream crash fails the pending calls; the next call starts a new upstream; a long call keeps no time limit of its own', () => withBackendSandbox(async ({ root, files, starts, kill }) => {
    installStub(root)
    const b = startBackend({ STUB_STARTS: starts })
    kill(b)
    await until(() => existsSync(files.socket))
    const a = await session(files.socket, 1)
    const c = await session(files.socket, 2)
    a.send(call(5, 'sleep', { ms: 4_000 }))
    await Bun.sleep(150)
    c.send(call(6, 'crash'))
    const failed = await a.wait(m => m['id'] === 5)
    expect(failed['error']).toMatchObject({ code: -32603, message: expect.stringContaining('web-search') })
    c.send(call(7, 'sleep', { ms: 6_000, label: 'long' }))
    expect(textOf(await c.wait(m => m['id'] === 7, 15_000))).toBe('long')
    expect(lineCount(starts)).toBe(2)
    a.close()
    c.close()
  }), 40_000)

  test('a server that exits at once is marked down at once, and after 4 starts in 10 minutes no new start is tried', () => withBackendSandbox(async ({ root, files, starts, kill }) => {
    installStub(root)
    const b = startBackend({ STUB_STARTS: starts, STUB_EXIT_AT_START: '2' })
    kill(b)
    await until(() => existsSync(files.socket))
    const c = await connect(files.socket)
    c.send({ jsonrpc: '2.0', method: 'buracle/hello', params: { pid: 1 } })
    for (let i = 1; i <= 6; i++) {
      c.send(call(i, 'ping'))
      const r = await c.wait(m => m['id'] === i)
      expect(r['error']).toMatchObject({ code: -32603 })
    }
    expect(lineCount(starts)).toBe(4)
    expect(await until(() => (readJson(paths.healthFile())?.['mcp'] as Msg | undefined)?.['web-search'])).toMatchObject({ status: 'down', source: 'launch' })
    c.close()
  }), 40_000)

  test('a server that cannot be started answers each request with the reason', () => withBackendSandbox(async ({ root, files, kill }) => {
    installStub(root, 0o644)
    const b = startBackend()
    kill(b)
    await until(() => existsSync(files.socket))
    const c = await connect(files.socket)
    c.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const r = await c.wait(m => m['id'] === 1)
    expect(r['error']).toMatchObject({ code: -32603, message: expect.stringContaining('cannot start') })
    // The backend answers first and records the failure in health.json asynchronously, so wait for the record.
    expect(await until(() => (readJson(paths.healthFile())?.['mcp'] as Msg | undefined)?.['web-search'])).toMatchObject({ status: 'down' })
    c.close()
  }), 30_000)

  test('after a SIGKILL of the backend, the next backend removes the stale socket, takes over the lock and serves', () => withBackendSandbox(async ({ root, files, kill }) => {
    installStub(root)
    const first = startBackend()
    kill(first)
    await until(() => existsSync(files.socket))
    const upstream = (await until(() => readJson(files.state)))['upstreamPid'] as number
    first.kill('SIGKILL')
    await first.exited
    expect(existsSync(files.socket)).toBe(true)
    await until(() => !alive(upstream))
    const next = startBackend()
    kill(next)
    await until(() => readJson(files.state)?.['pid'] === next.pid)
    const c = await session(files.socket, 3)
    c.send(call(1, 'ping'))
    expect(textOf(await c.wait(m => m['id'] === 1))).toBe('pong')
    c.close()
  }), 30_000)

  test('SIGTERM stops the backend and its upstream, and when its home disappears it stops by itself', () => withBackendSandbox(async ({ root, files, kill }) => {
    installStub(root)
    const b = startBackend()
    kill(b)
    await until(() => existsSync(files.socket))
    const upstream = (await until(() => readJson(files.state)))['upstreamPid'] as number
    b.kill('SIGTERM')
    expect(await b.exited).toBe(0)
    await until(() => !alive(upstream))
    expect(existsSync(files.socket)).toBe(false)
    const home = join(root, 'gone-home')
    mkdirSync(home, { recursive: true })
    // The stub goes into that home's toolchain too: no package runner, no network.
    const fallback = await withEnv({ BURACLE_HOME: home }, () => { installStub(root); return paths.mcpFallbackRunDir() })
    try {
      const g = startBackend({ BURACLE_HOME: home })
      kill(g)
      await Bun.sleep(1_000)
      rmSync(home, { recursive: true, force: true })
      const t0 = Date.now()
      expect(await g.exited).toBe(0)
      expect(Date.now() - t0).toBeLessThan(8_000)
    } finally {
      rmSync(fallback, { recursive: true, force: true })
    }
    const s = startBackend()
    kill(s)
    await until(() => readJson(files.state)?.['pid'] === s.pid)
    rmSync(files.socket, { force: true })
    const t1 = Date.now()
    expect(await s.exited).toBe(0)
    expect(Date.now() - t1).toBeLessThan(8_000)
  }), 30_000)

  test('a changed tool list reaches every client and rewrites the cache', () => withBackendSandbox(async ({ root, files, kill }) => {
    installStub(root)
    const b = startBackend()
    kill(b)
    await until(() => existsSync(files.socket))
    const a = await session(files.socket, 1)
    const c = await session(files.socket, 2)
    a.send(call(1, 'change'))
    await a.wait(m => m['method'] === 'notifications/tools/list_changed')
    await c.wait(m => m['method'] === 'notifications/tools/list_changed')
    await until(() => ((readJson(paths.mcpCacheFile('web-search'))?.['tools'] as Msg[] | undefined) ?? []).some(t => t['name'] === 'extra'))
    a.close()
    c.close()
  }), 30_000)

  test('a run directory that is a symbolic link, or open to other users, is refused', () => withBackendSandbox(async ({ root, files }) => {
    installStub(root)
    const other = join(root, 'elsewhere')
    mkdirSync(other, { recursive: true, mode: 0o700 })
    rmSync(files.dir, { recursive: true, force: true })
    mkdirSync(dirname(files.dir), { recursive: true })
    symlinkSync(other, files.dir)
    const viaLink = Bun.spawnSync([process.execPath, MAIN, 'mcp', 'backend', 'web-search'], { env: { ...process.env } })
    expect(viaLink.exitCode).toBe(1)
    expect(viaLink.stderr.toString()).toContain('symbolic link')
    rmSync(files.dir, { force: true })
    mkdirSync(files.dir, { mode: 0o755 })
    chmodSync(files.dir, 0o755)
    const open = Bun.spawnSync([process.execPath, MAIN, 'mcp', 'backend', 'web-search'], { env: { ...process.env } })
    expect(open.exitCode).toBe(1)
    expect(open.stderr.toString()).toContain('open to other users')
    expect(statSync(files.dir).mode & 0o777).toBe(0o755)
  }), 30_000)

  test('an upstream that answers initialize with an error and keeps running: the next request starts a new one and gets an error, not silence', () => withBackendSandbox(async ({ root, files, starts, kill }) => {
    installStub(root)
    const b = startBackend({ STUB_STARTS: starts, STUB_INIT_ERROR: 'no browser here' })
    kill(b)
    await until(() => existsSync(files.socket))
    const a = await connect(files.socket)
    a.send({ jsonrpc: '2.0', method: 'buracle/hello', params: { pid: 1111 } })
    a.send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } } })
    expect(JSON.stringify((await a.wait(m => m['id'] === 'init'))['error'])).toContain('no browser here')
    // The boot start fails either before or after the client's initialize arrives, so 1 or 2 starts are
    // already counted here; what matters is that the next request starts exactly one new upstream.
    const before = lineCount(starts)
    expect([1, 2]).toContain(before)
    a.send(call(1, 'ping'))
    expect(JSON.stringify((await a.wait(m => m['id'] === 1, 8_000))['error'])).toContain('no browser here')
    expect(lineCount(starts)).toBe(before + 1)
    a.close()
  }), 30_000)

  test('--package-version names the key the starting forwarder polls, whatever the toolchain says now; `latest` is the key without a version', () => withBackendSandbox(async ({ root, kill }) => {
    installStub(root)
    for (const [flag, version] of [['1.2.3', '1.2.3'], ['latest', undefined]] as const) {
      const files = backendFiles(backendKey('web-search', version))
      const b = startBackend({}, 'web-search', [`--package-version=${flag}`])
      kill(b)
      await until(() => existsSync(files.socket))
      // The state file follows the socket by a moment.
      expect((await until(() => readJson(files.state)))['key']).toBe(backendKey('web-search', version))
      expect(existsSync(backendFiles(KEY).socket)).toBe(false)
      b.kill('SIGTERM')
      await b.exited
    }
  }), 30_000)

  test('the log of a server that writes a lot to stderr stays at 1 MB while the backend runs', () => withBackendSandbox(async ({ root, files, kill }) => {
    installStub(root)
    const b = startBackend()
    kill(b)
    await until(() => existsSync(files.socket))
    const a = await session(files.socket, 1111)
    const log = paths.mcpLogFile('web-search')
    for (let i = 1; i <= 3; i++) {
      a.send(call(i, 'noise', { bytes: 1024 * 1024 }))
      expect(textOf(await a.wait(m => m['id'] === i))).toBe('noisy')
      await Bun.sleep(300)
      expect(statSync(log).size).toBeLessThanOrEqual(1024 * 1024)
    }
    expect(alive(b.pid)).toBe(true)
    expect(readFileSync(log, 'utf8').endsWith('x\n')).toBe(true)
    a.close()
  }), 30_000)
})

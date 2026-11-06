import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../../../src/engine/paths'
import { withSandbox } from '../../helpers/sandbox'
import { alive, call, drive, type Driver, installStub, type Msg, readJson, textOf, until, VERSION } from './helpers'

function writeCache(): void {
  mkdirSync(paths.mcpCacheDir(), { recursive: true })
  writeFileSync(paths.mcpCacheFile('chrome-devtools'), JSON.stringify({ v: 1, id: 'chrome-devtools', version: VERSION, initialize: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'cached', version: '0' } }, tools: [{ name: 'list_pages', inputSchema: { type: 'object' } }] }))
}

const startPids = (file: string): number[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(l => l !== '').map(l => Number(l.split(' ')[1])) : [])

async function withLazy(fn: (ctx: { root: string, starts: string, drivers: Driver[], env: Record<string, string> }) => Promise<void>): Promise<void> {
  await withSandbox(async ({ root }) => {
    const drivers: Driver[] = []
    const starts = join(root, 'starts.txt')
    try {
      installStub(root, 'chrome-devtools')
      await fn({ root, starts, drivers, env: { STUB_STARTS: starts } })
    } finally {
      for (const d of drivers) { try { d.proc.kill('SIGKILL') } catch { /* gone */ } }
      for (const pid of startPids(starts)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
  })
}

const initWithRoots: Msg = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'harness-x', version: '1' } } }

describe('buracle mcp run chrome-devtools: started on its first call', () => {
  test('with a valid cache an idle session starts no server; the first call starts it with the client\'s own initialize, and messages pass both ways', () => withLazy(async ({ root, starts, drivers, env }) => {
    writeCache()
    const initFile = join(root, 'init.txt')
    const rootsFile = join(root, 'roots.txt')
    const d = drive('chrome-devtools', { ...env, STUB_INIT_FILE: initFile, STUB_ROOTS_FILE: rootsFile })
    drivers.push(d)
    d.send(initWithRoots)
    expect((await d.wait(m => m['id'] === 0))['result']).toMatchObject({ serverInfo: { name: 'cached' } })
    d.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    d.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(((await d.wait(m => m['id'] === 1))['result'] as Msg)['tools']).toEqual([{ name: 'list_pages', inputSchema: { type: 'object' } }])
    await Bun.sleep(800)
    expect(startPids(starts)).toEqual([])
    d.send(call(2, 'ping'))
    const ask = await d.wait(m => m['method'] === 'roots/list', 25_000)
    d.send({ jsonrpc: '2.0', id: ask['id'], result: { roots: [{ uri: 'file:///work', name: 'work' }] } })
    expect(textOf(await d.wait(m => m['id'] === 2, 25_000))).toBe('pong')
    expect(startPids(starts)).toHaveLength(1)
    const sent = JSON.parse(readFileSync(initFile, 'utf8').split('\n')[0] ?? '{}') as Msg
    expect(sent).toMatchObject({ capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'harness-x' } })
    await until(() => existsSync(rootsFile) && readFileSync(rootsFile, 'utf8').includes('file:///work'))
  }), 60_000)

  test('without a valid cache the server answers the lifecycle, the cache is written, and the server stops when no other request came', () => withLazy(async ({ starts, drivers, env }) => {
    const d = drive('chrome-devtools', env)
    drivers.push(d)
    d.send(initWithRoots)
    expect(((await d.wait(m => m['id'] === 0, 25_000))['result'] as Msg)['serverInfo']).toEqual({ name: 'stub', version: '1.0.0' })
    d.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    d.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect((((await d.wait(m => m['id'] === 1))['result'] as Msg)['tools'] as Msg[]).map(t => t['name'])).toContain('ping')
    const cache = await until(() => readJson(paths.mcpCacheFile('chrome-devtools')))
    expect(cache).toMatchObject({ version: VERSION, initialize: { serverInfo: { name: 'stub' } } })
    const [pid] = startPids(starts)
    await until(() => !alive(pid as number), 10_000)
    expect(alive(d.proc.pid)).toBe(true)
  }), 60_000)

  test('after the idle time and at the end of the session the server stops; a call in between starts it again', () => withLazy(async ({ starts, drivers, env }) => {
    writeCache()
    const d = drive('chrome-devtools', { ...env, BURACLE_MCP_IDLE_MS: '800' })
    drivers.push(d)
    d.send(initWithRoots)
    await d.wait(m => m['id'] === 0)
    d.send(call(1, 'ping'))
    await d.wait(m => m['method'] === 'roots/list', 25_000).then(ask => d.send({ jsonrpc: '2.0', id: ask['id'], result: { roots: [] } }))
    expect(textOf(await d.wait(m => m['id'] === 1, 25_000))).toBe('pong')
    const [first] = startPids(starts)
    await until(() => !alive(first as number), 10_000)
    expect(alive(d.proc.pid)).toBe(true)
    d.send(call(2, 'ping'))
    expect(textOf(await d.wait(m => m['id'] === 2, 25_000))).toBe('pong')
    const [, second] = startPids(starts)
    expect(alive(second as number)).toBe(true)
    expect(await d.end()).toBe(0)
    await until(() => !alive(second as number), 10_000)
  }), 60_000)

  test('a server that ignores SIGTERM is stopped with SIGKILL after 5 s', () => withLazy(async ({ starts, drivers, env }) => {
    writeCache()
    const d = drive('chrome-devtools', { ...env, BURACLE_MCP_IDLE_MS: '500', STUB_IGNORE_TERM: '1' })
    drivers.push(d)
    d.send(initWithRoots)
    await d.wait(m => m['id'] === 0)
    d.send(call(1, 'echo', { text: 'x' }))
    await d.wait(m => m['method'] === 'roots/list', 25_000).then(ask => d.send({ jsonrpc: '2.0', id: ask['id'], result: { roots: [] } }))
    await d.wait(m => m['id'] === 1, 25_000)
    const [pid] = startPids(starts)
    await Bun.sleep(2_500)
    expect(alive(pid as number)).toBe(true)
    await until(() => !alive(pid as number), 10_000)
  }), 60_000)

  async function startedStubborn(d: Driver): Promise<void> {
    d.send(initWithRoots)
    await d.wait(m => m['id'] === 0)
    d.send(call(1, 'echo', { text: 'x' }))
    await d.wait(m => m['method'] === 'roots/list', 25_000).then(ask => d.send({ jsonrpc: '2.0', id: ask['id'], result: { roots: [] } }))
    await d.wait(m => m['id'] === 1, 25_000)
  }

  test('at the end of the session a server that ignores SIGTERM and the end of its input still stops (SIGKILL after 5 s)', () => withLazy(async ({ starts, drivers, env }) => {
    writeCache()
    const d = drive('chrome-devtools', { ...env, STUB_IGNORE_TERM: '1' })
    drivers.push(d)
    await startedStubborn(d)
    const [pid] = startPids(starts)
    expect(await d.end()).toBe(0)
    await until(() => !alive(pid as number), 10_000)
  }), 60_000)

  test('a harness that ends stdin and then sends SIGTERM while the forwarder waits for such a server still gets it stopped', () => withLazy(async ({ starts, drivers, env }) => {
    writeCache()
    const d = drive('chrome-devtools', { ...env, STUB_IGNORE_TERM: '1' })
    drivers.push(d)
    await startedStubborn(d)
    const [pid] = startPids(starts)
    void d.end()
    await Bun.sleep(500)
    d.proc.kill('SIGTERM')
    await d.proc.exited
    await until(() => !alive(pid as number), 10_000)
  }), 60_000)

  test('a forwarder stopped with SIGTERM (as a harness or the parent watch stops it) takes such a server with it', () => withLazy(async ({ starts, drivers, env }) => {
    writeCache()
    const d = drive('chrome-devtools', { ...env, STUB_IGNORE_TERM: '1' })
    drivers.push(d)
    await startedStubborn(d)
    const [pid] = startPids(starts)
    d.proc.kill('SIGTERM')
    await d.proc.exited
    await until(() => !alive(pid as number), 10_000)
  }), 60_000)
})

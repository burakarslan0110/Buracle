import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as bar from '../../src/usage/bar-info'
import { brainDir } from '../../src/memory/layout'
import { writeSessionRecord } from '../../src/memory/session-record'
import { clearUiRecord, probeUi, readUiRecord, serveUi, stopUi, type UiRecord } from '../../src/memory/ui'
import { readerEntries } from '../../src/memory/cortex'
import { sameUiBuild, uiBuildId } from '../../src/memory/ui-build'
import * as paths from '../../src/engine/paths'
import { withSandbox } from '../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..')
const MAIN = join(REPO, 'src', 'cli', 'main.ts')
const SID = '0199a213-81c0-7800-8aa1-bbab2a035a70'

function session(status: 'active' | 'ended', sid = SID): void {
  writeSessionRecord({ v: 1, harness: 'claude', sid, cwd: '/w', startedMs: Date.now() - 60_000, status, ...(status === 'ended' ? { finalizedMs: Date.now() } : {}) })
}

function captureEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...childEnv(), ...extra }
  delete env['BURACLE_NO_CAPTURE']
  return env
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function freePort(): number {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = s.port as number
  s.stop(true)
  return port
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return env
}

async function cli(args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const p = Bun.spawn(['bun', MAIN, ...args], { cwd: REPO, env: childEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, stdout, stderr }
}

async function oldServer(root: string, port: number, opts: { pid?: number } = {}): Promise<{ proc: ReturnType<typeof Bun.spawn>, pid: number }> {
  const script = join(root, 'old-ui-server.ts')
  write(script, [
    "const [port, recordFile, claimed] = process.argv.slice(2)",
    "const pid = claimed !== undefined && claimed !== '' ? Number(claimed) : process.pid",
    "const server = Bun.serve({ hostname: '127.0.0.1', port: Number(port), fetch: req => new URL(req.url).pathname === '/healthz'",
    "  ? Response.json({ ok: true, app: 'buracle-memory-ui', version: '0.1.0', vault: '/old/vault', pid })",
    "  : new Response('not found', { status: 404 }) })",
    "await Bun.write(recordFile, JSON.stringify({ v: 1, pid: process.pid, port: Number(port), host: '127.0.0.1', url: `http://127.0.0.1:${port}`, startedAt: new Date().toISOString(), version: '0.1.0', vault: '/old/vault' }, null, 2) + '\\n')",
    "process.on('SIGTERM', () => { server.stop(true); process.exit(0) })",
    "console.log('ready')",
  ].join('\n') + '\n')
  const proc = Bun.spawn(['bun', script, String(port), paths.memoryUiStateFile(), opts.pid !== undefined ? String(opts.pid) : ''], { env: childEnv(), stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
  const reader = proc.stdout.getReader()
  const first = await reader.read()
  reader.releaseLock()
  if (!new TextDecoder().decode(first.value ?? new Uint8Array()).includes('ready')) throw new Error('the old server did not start')
  return { proc, pid: proc.pid }
}

function uiConfig(buracleHome: string, port: number): void {
  write(join(buracleHome, 'config.yaml'), `memory:\n  ui:\n    port: ${port}\n`)
}

async function stopRecorded(): Promise<void> {
  const rec = readUiRecord()
  if (rec !== undefined) await stopUi(rec)
}

function startDriver(root: string): string {
  const driver = join(root, 'start-driver.ts')
  write(driver, [
    "const [barInfoModule, startModule, cwd, home, buracleHome] = process.argv.slice(2)",
    "Object.assign(process.env, { HOME: home, BURACLE_HOME: buracleHome })",
    "delete process.env['BURACLE_NO_AUTOSTART']",
    "delete process.env['BURACLE_NO_CAPTURE']",
    "const { loadConfigSync } = await import(process.argv[7] as string)",
    "const bar = await import(barInfoModule)",
    "const start = await import(startModule)",
    "const cfg = loadConfigSync().config",
    "await bar.barInfo('claude', { nowMs: Date.now(), version: '1' })",
    "await start.prepareWorkspace(cwd, cfg, Date.now())",
  ].join('\n') + '\n')
  return driver
}

function fakeCheckout(root: string, version = '1.2.3'): string {
  const repo = join(root, 'checkout')
  write(join(repo, 'package.json'), JSON.stringify({ name: 'buracle', version }) + '\n')
  write(join(repo, 'src/memory/ui.ts'), 'export const server = 1\n')
  write(join(repo, 'src/memory/ui-extra.ts'), 'export const extra = 1\n')
  write(join(repo, 'src/memory/store.ts'), 'export const store = 1\n')
  write(join(repo, 'src/memory/ui/app.js'), 'console.log(1)\n')
  write(join(repo, 'src/memory/ui/nested/app.css'), 'body {}\n')
  write(join(repo, 'src/memory/ui/.DS_Store'), 'x')
  return repo
}

describe('the UI build identity', () => {
  test('the version plus a hash of src/memory/ui*.ts and src/memory/ui/**; nothing else counts', () => withSandbox(async ({ root }) => {
    const repo = fakeCheckout(root)
    const id = uiBuildId(repo)
    expect(id).toMatch(/^1\.2\.3\+[0-9a-f]{12}$/)
    expect(uiBuildId(repo)).toBe(id)
    const changes: Array<[string, string, boolean]> = [
      ['src/memory/ui/app.js', 'console.log(2)\n', true],
      ['src/memory/ui/nested/app.css', 'body { color: red }\n', true],
      ['src/memory/ui-extra.ts', 'export const extra = 2\n', true],
      ['src/memory/ui-new.ts', 'export const fresh = 1\n', true],
      ['src/memory/store.ts', 'export const store = 2\n', false],
      ['src/memory/graph.ts', 'export const graph = 1\n', false],
      ['src/memory/ui/.DS_Store', 'y', false],
    ]
    let last = id
    for (const [rel, text, counts] of changes) {
      write(join(repo, rel), text)
      const next = uiBuildId(repo)
      if (counts) expect(next).not.toBe(last)
      else expect(next).toBe(last)
      last = next
    }
    write(join(repo, 'package.json'), JSON.stringify({ name: 'buracle', version: '1.2.4' }) + '\n')
    expect(uiBuildId(repo)).toBe(`1.2.4+${last?.split('+')[1]}`)
    expect(uiBuildId(join(root, 'no-checkout'))).toBeUndefined()
    expect(uiBuildId()).toMatch(new RegExp(`^${(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }).version.replace(/\./g, '\\.')}\\+[0-9a-f]{12}$`))
  }))

  test('a server of another or of no recorded build has to go; an unknown current build keeps it', () => {
    expect(sameUiBuild('1.0.0+aaa', '1.0.0+aaa')).toBe(true)
    expect(sameUiBuild('1.0.0+aaa', '1.0.0+bbb')).toBe(false)
    expect(sameUiBuild(undefined, '1.0.0+bbb')).toBe(false)
    expect(sameUiBuild(undefined, undefined)).toBe(true)
    expect(sameUiBuild('1.0.0+aaa', undefined)).toBe(true)
  })

  test('a server whose Buracle home vanished under it (a test sandbox torn down) stops itself and recreates nothing', () => withSandbox(async ({ buracleHome }) => {
    mkdirSync(brainDir(), { recursive: true })
    const { server, record } = serveUi({ port: freePort(), version: '9.9.9', idleEveryMs: 40 })
    try {
      expect((await fetch(`${record.url}/healthz`)).status).toBe(200)
      rmSync(buracleHome, { recursive: true, force: true })
      await Bun.sleep(300)
      await expect(fetch(`${record.url}/healthz`)).rejects.toBeDefined()
      expect(existsSync(buracleHome)).toBe(false)
    } finally { server.stop(true) }
  }))

  test('the server records its build and reports it, with its pid, at /healthz', () => withSandbox(async () => {
    const { server, record } = serveUi({ port: freePort(), version: '9.9.9' })
    try {
      expect(record.build).toBe(uiBuildId())
      expect(readUiRecord()?.build).toBe(uiBuildId())
      expect(await probeUi(record.url)).toEqual({ pid: process.pid, version: '9.9.9', build: uiBuildId(), brain: record.brain })
    } finally {
      server.stop(true)
      clearUiRecord()
    }
  }))
})

describe('the server closes by itself', () => {
  test('`mem ui --serve` exits once no request came for BURACLE_UI_IDLE_MS: its record is cleared and no CortexDB reader outlives it', () => withSandbox(async ({ root, buracleHome }) => {
    const port = freePort()
    uiConfig(buracleHome, port)
    const repo = join(root, 'shop')
    mkdirSync(repo, { recursive: true })
    expect((await cli(['mem', 'write', '--type', 'preference', '--layer', 'person', '--title', 'Keep answers short', '--summary', 's', '--json', '--cwd', repo])).code).toBe(0)
    const env = captureEnv({ BURACLE_UI_IDLE_MS: '1500' })
    const proc = Bun.spawn(['bun', MAIN, 'mem', 'ui', '--serve'], { cwd: REPO, env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    try {
      await waitFor('the server', async () => { const r = readUiRecord(); return r !== undefined && r.pid === proc.pid && await probeUi(r.url) !== undefined })
      const rec = readUiRecord() as UiRecord
      // The page reads the brain: a CortexDB reader (a child of the server) starts.
      expect((await fetch(`${rec.url}/api/brain?scope=person`)).status).toBe(200)
      const readers = readerEntries()
      expect(readers).toHaveLength(1)
      expect(readers[0]?.entry.pid).toBe(proc.pid)
      const reader = readers[0]?.entry.child as number
      expect(alive(reader)).toBe(true)
      // A request restarts the quiet time.
      await Bun.sleep(1000)
      expect((await fetch(`${rec.url}/healthz`)).status).toBe(200)
      await Bun.sleep(1000)
      expect(alive(proc.pid)).toBe(true)
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(20_000).then(() => false)])
      expect(exited).toBe(true)
      expect(readUiRecord()).toBeUndefined()
      await waitFor('the reader to end', () => !alive(reader), 10_000)
      expect(readerEntries()).toEqual([])
    } finally {
      try { proc.kill() } catch {  }
      await stopRecorded()
    }
  }), 90_000)

  test('`mem ui --stop` (a SIGTERM) closes the readers too', () => withSandbox(async ({ root, buracleHome }) => {
    const port = freePort()
    uiConfig(buracleHome, port)
    const repo = join(root, 'shop')
    mkdirSync(repo, { recursive: true })
    expect((await cli(['mem', 'write', '--type', 'preference', '--layer', 'person', '--title', 'Keep answers short', '--summary', 's', '--json', '--cwd', repo])).code).toBe(0)
    try {
      expect(JSON.parse((await cli(['mem', 'ui', '--json'])).stdout)).toMatchObject({ started: true })
      const rec = readUiRecord() as UiRecord
      expect((await fetch(`${rec.url}/api/brain?scope=person`)).status).toBe(200)
      const reader = readerEntries()[0]?.entry.child as number
      expect(alive(reader)).toBe(true)
      expect(JSON.parse((await cli(['mem', 'ui', '--stop', '--json'])).stdout)).toEqual({ stopped: true })
      expect(alive(rec.pid)).toBe(false)
      await waitFor('the reader to end', () => !alive(reader), 10_000)
      expect(readUiRecord()).toBeUndefined()
      expect(readerEntries()).toEqual([])
    } finally {
      await stopRecorded()
    }
  }), 90_000)
})

describe('the status line names the web UI only while it runs', () => {
  test('no record, a dead process or a stopped server: no address; a running one: its address', () => withSandbox(async () => {
    const at = Date.now()
    const memoryUrl = async () => (await bar.barInfo('claude', { nowMs: at, version: '1' })).memoryUrl
    expect(await memoryUrl()).toBeUndefined()

    const record = (pid: number): UiRecord => ({ v: 1, pid, port: 41999, host: '127.0.0.1', url: 'http://127.0.0.1:41999', startedAt: new Date().toISOString(), version: '1', brain: '' })
    const dead = Bun.spawn(['bun', '-e', '0'], { env: childEnv(), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    await dead.exited
    write(paths.memoryUiStateFile(), JSON.stringify(record(dead.pid)) + '\n')
    expect(await memoryUrl()).toBeUndefined()

    const served = serveUi({ port: freePort(), version: '9.9.9' })
    try {
      expect(await memoryUrl()).toBe(served.record.url)
    } finally { await served.stop() }
    expect(await memoryUrl()).toBeUndefined()
  }))
})

describe('replacing a server of another build', () => {
  test('`buracle mem ui` stops a running server of an earlier release and starts this build in its place', () => withSandbox(async ({ root, buracleHome }) => {
    const port = freePort()
    uiConfig(buracleHome, port)
    const old = await oldServer(root, port)
    try {
      const r = await cli(['mem', 'ui', '--json'])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout)).toEqual({ url: `http://127.0.0.1:${port}`, started: true, opened: false })
      await old.proc.exited
      const rec = readUiRecord() as UiRecord
      expect(rec.pid).not.toBe(old.pid)
      expect(rec.build).toBe(uiBuildId())
      expect((await probeUi(rec.url))?.build).toBe(uiBuildId())
      expect((await fetch(`${rec.url}/`)).status).toBe(200)
      expect((await fetch(`${rec.url}/api/overview`)).status).toBe(200)

      expect(JSON.parse((await cli(['mem', 'ui', '--json'])).stdout)).toEqual({ url: rec.url, started: false, opened: false })
      const serve = await cli(['mem', 'ui', '--serve', '--json'])
      expect(serve.code).toBe(0)
      expect(JSON.parse(serve.stdout)).toEqual({ url: rec.url, started: false })
      expect(readUiRecord()?.pid).toBe(rec.pid)
    } finally {
      old.proc.kill()
      await stopRecorded()
    }
  }), 90_000)

  test('`mem ui` names the page of the project in its folder when that project has a brain', () => withSandbox(async ({ root, buracleHome }) => {
    const port = freePort()
    uiConfig(buracleHome, port)
    const repo = join(root, 'shop')
    mkdirSync(repo, { recursive: true })
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo, env: childEnv() })
    Bun.spawnSync(['git', 'remote', 'add', 'origin', 'git@github.com:me/shop.git'], { cwd: repo, env: childEnv() })
    try {
      expect(JSON.parse((await cli(['mem', 'ui', '--json', '--cwd', repo])).stdout)).toMatchObject({ url: `http://127.0.0.1:${port}`, started: true })
      expect((await cli(['mem', 'write', '--type', 'decision', '--title', 'Orders live in PostgreSQL', '--json', '--cwd', repo])).code).toBe(0)
      const r = JSON.parse((await cli(['mem', 'ui', '--json', '--cwd', repo])).stdout) as Record<string, unknown>
      expect(r).toEqual({ url: `http://127.0.0.1:${port}`, page: `http://127.0.0.1:${port}/?scope=project%3Ashop`, started: false, opened: false })
      const review = JSON.parse((await cli(['mem', 'ui', '--page', 'review', '--json', '--cwd', repo])).stdout) as Record<string, unknown>
      expect(review).toEqual({ url: `http://127.0.0.1:${port}`, page: `http://127.0.0.1:${port}/review`, started: false, opened: false })
      expect((await fetch(String(review['page']))).status).toBe(200)
      const bad = await cli(['mem', 'ui', '--page', 'graph', '--json', '--cwd', repo])
      expect(bad.code).toBe(1)
    } finally {
      await stopRecorded()
    }
  }), 60_000)

  test('a status line and a session start start no server: the UI starts only through `buracle mem ui`', () => withSandbox(async ({ root, home, buracleHome }) => {
    const port = freePort()
    write(join(buracleHome, 'config.yaml'), `memory:\n  ui:\n    port: ${port}\nindex:\n  auto: false\n`)
    const marker = join(paths.stateDir(), 'memory-ui.spawn')
    const driver = startDriver(root)
    try {
      expect((bar as Record<string, unknown>)['ensureMemoryUi']).toBeUndefined()
      session('active')
      const p = Bun.spawn(['bun', driver, join(REPO, 'src', 'usage', 'bar-info.ts'), join(REPO, 'src', 'adapters', 'shared', 'workspace-start.ts'), root, home, buracleHome, join(REPO, 'src', 'engine', 'config.ts')], { cwd: REPO, env: captureEnv(), stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' })
      expect(await p.exited).toBe(0)
      await Bun.sleep(1500)
      expect(existsSync(marker)).toBe(false)
      expect(readUiRecord()).toBeUndefined()
      expect(await probeUi(`http://127.0.0.1:${port}`)).toBeUndefined()
    } finally {
      await stopRecorded()
    }
  }), 60_000)

  test('a record whose pid /healthz does not confirm is never signalled: --stop leaves the process, a new server starts beside it', () => withSandbox(async ({ root, buracleHome }) => {
    const port = freePort()
    uiConfig(buracleHome, port)
    const bystander = Bun.spawn(['bun', '-e', 'setInterval(() => {}, 1000)'], { env: childEnv(), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    const impostorPort = freePort()
    const impostor = await oldServer(root, impostorPort, { pid: 4_000_000 })
    try {
      const stale: UiRecord = { v: 1, pid: bystander.pid, port: freePort(), host: '127.0.0.1', url: '', startedAt: new Date().toISOString(), version: '0.1.0', brain: '' }
      stale.url = `http://127.0.0.1:${stale.port}`
      expect(await stopUi(stale)).toBe('unconfirmed')
      expect(await stopUi({ ...stale, pid: impostor.pid, port: impostorPort, url: `http://127.0.0.1:${impostorPort}` })).toBe('unconfirmed')
      expect(alive(impostor.pid)).toBe(true)

      write(paths.memoryUiStateFile(), JSON.stringify(stale) + '\n')
      const stop = await cli(['mem', 'ui', '--stop', '--json'])
      expect(stop.code).toBe(0)
      expect(JSON.parse(stop.stdout)).toEqual({ stopped: false })
      expect(alive(bystander.pid)).toBe(true)

      const r = await cli(['mem', 'ui', '--json'])
      expect(JSON.parse(r.stdout)).toEqual({ url: `http://127.0.0.1:${port}`, started: true, opened: false })
      expect(alive(bystander.pid)).toBe(true)
      expect(readUiRecord()?.build).toBe(uiBuildId())
    } finally {
      bystander.kill()
      impostor.proc.kill()
      await stopRecorded()
    }
  }), 90_000)
})

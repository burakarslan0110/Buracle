import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { liveMemoryUi } from '../../src/usage/bar-info'
import { brainDir, sessionRecordFile } from '../../src/memory/layout'
import { readSessionRecord, writeSessionRecord } from '../../src/memory/session-record'
import { clearUiRecord, probeUi, readUiRecord, serveUi, stopUi, type UiRecord, type UiStopReason } from '../../src/memory/ui'
import { sameUiBuild, uiBuildId } from '../../src/memory/ui-build'
import * as paths from '../../src/engine/paths'
import { withEnv, withSandbox } from '../helpers/sandbox'

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

function autostartDriver(root: string): string {
  const driver = join(root, 'autostart-driver.ts')
  write(driver, [
    "const [main, nowMs, home, buracleHome, caller, capture] = process.argv.slice(2)",
    "Object.assign(process.env, { HOME: home, BURACLE_HOME: buracleHome })",
    "delete process.env['BURACLE_NO_AUTOSTART']",
    "if (capture === 'capture') delete process.env['BURACLE_NO_CAPTURE']",
    "const { ensureMemoryUi } = await import(main)",
    "ensureMemoryUi(Number(nowMs), caller === 'session-start' ? { sessionStarting: true } : {})",
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

describe('the server closes with the harnesses', () => {
  const fast = { idleEveryMs: 30, stopAfterMs: 150 }

  test('once the session it saw open ends, it waits stopAfterMs, clears its record and stops', () => withSandbox(() => withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
    session('active')
    const stops: UiStopReason[] = []
    const { server, record } = serveUi({ port: freePort(), version: '9.9.9', ...fast, onStop: why => stops.push(why) })
    try {
      await Bun.sleep(400)
      expect((await fetch(`${record.url}/healthz`)).status).toBe(200)
      expect(stops).toEqual([])
      session('ended')
      await Bun.sleep(80)
      expect((await fetch(`${record.url}/healthz`)).status).toBe(200)
      await waitFor('the server to stop', () => stops.length > 0, 5_000)
      expect(stops).toEqual(['no-sessions'])
      await expect(fetch(`${record.url}/healthz`)).rejects.toBeDefined()
      expect(readUiRecord()).toBeUndefined()
    } finally { server.stop(true); clearUiRecord() }
  })))

  test('a session opened after the start counts too, and a stopped server never writes its record again', () => withSandbox(() => withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
    const stops: UiStopReason[] = []
    const { server, record } = serveUi({ port: freePort(), version: '9.9.9', ...fast, onStop: why => stops.push(why) })
    try {
      await Bun.sleep(400)
      expect((await fetch(`${record.url}/healthz`)).status).toBe(200)
      session('active')
      await Bun.sleep(100)
      session('ended')
      await waitFor('the server to stop', () => stops.length > 0, 5_000)
      expect(stops).toEqual(['no-sessions'])
      expect(readUiRecord()).toBeUndefined()
      await Bun.sleep(100)
      expect(readUiRecord()).toBeUndefined()
    } finally { server.stop(true); clearUiRecord() }
  })))

  test('started for a session (sessionAtStart) it stops even when that session ended before its first look; with capture off it stays', () => withSandbox(async () => {
    await withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
      const stops: UiStopReason[] = []
      const { server, record } = serveUi({ port: freePort(), version: '9.9.9', ...fast, sessionAtStart: true, onStop: why => stops.push(why) })
      try {
        await waitFor('the server to stop', () => stops.length > 0, 5_000)
        expect(stops).toEqual(['no-sessions'])
        await expect(fetch(`${record.url}/healthz`)).rejects.toBeDefined()
      } finally { server.stop(true); clearUiRecord() }
    })
    const stops: UiStopReason[] = []
    const { server, record } = serveUi({ port: freePort(), version: '9.9.9', ...fast, sessionAtStart: true, onStop: why => stops.push(why) })
    try {
      await Bun.sleep(500)
      expect((await fetch(`${record.url}/healthz`)).status).toBe(200)
      expect(stops).toEqual([])
      expect(readUiRecord()?.pid).toBe(process.pid)
    } finally { server.stop(true); clearUiRecord() }
  }))

  test('`mem ui --serve --for-session` exits by itself, with its record cleared, once no harness session has been open for BURACLE_UI_STOP_AFTER_MS', () => withSandbox(async ({ buracleHome }) => {
    const port = freePort()
    uiConfig(buracleHome, port)
    const env = captureEnv({ BURACLE_UI_STOP_AFTER_MS: '600' })
    const serve = (args: string[]) => Bun.spawn(['bun', MAIN, 'mem', 'ui', '--serve', ...args], { cwd: REPO, env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    const started = async (proc: ReturnType<typeof Bun.spawn>): Promise<UiRecord> => {
      await waitFor('the server', async () => { const r = readUiRecord(); return r !== undefined && r.pid === proc.pid && await probeUi(r.url) !== undefined })
      return readUiRecord() as UiRecord
    }
    const exited = (proc: ReturnType<typeof Bun.spawn>) => Promise.race([proc.exited.then(() => true), Bun.sleep(15_000).then(() => false)])
    const a = serve(['--for-session'])
    try {
      const rec = await started(a)
      expect(await exited(a)).toBe(true)
      expect(readUiRecord()).toBeUndefined()
      expect(await probeUi(rec.url)).toBeUndefined()

      session('active')
      const b = serve(['--for-session'])
      const recB = await started(b)
      await Bun.sleep(1500)
      expect(await probeUi(recB.url)).toMatchObject({ pid: b.pid })
      session('ended')
      expect(await exited(b)).toBe(true)
      expect(readUiRecord()).toBeUndefined()

      const c = serve([])
      const recC = await started(c)
      await Bun.sleep(1500)
      expect(await probeUi(recC.url)).toMatchObject({ pid: c.pid })
      session('active')
      await Bun.sleep(300)
      session('ended')
      expect(await exited(c)).toBe(true)
      expect(readUiRecord()).toBeUndefined()
    } finally {
      for (const p of [a]) { try { p.kill() } catch {  } }
      await stopRecorded()
    }
  }), 90_000)
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

  test('a session start (ensureMemoryUi) replaces a server of another build in the live environment; one of this build is left alone', () => withSandbox(async ({ root, home, buracleHome }) => {
    const port = freePort()
    uiConfig(buracleHome, port)
    const old = await oldServer(root, port)
    const marker = join(paths.stateDir(), 'memory-ui.spawn')
    const decoy = join(root, 'decoy')
    const driver = autostartDriver(root)
    const autostart = async (nowMs: number): Promise<void> => {
      const env = { ...childEnv(), HOME: join(decoy, 'home'), BURACLE_HOME: join(decoy, 'home', '.buracle') }
      const p = Bun.spawn(['bun', driver, join(REPO, 'src', 'usage', 'bar-info.ts'), String(nowMs), home, buracleHome, 'status-line'], { cwd: REPO, env, stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' })
      expect(await p.exited).toBe(0)
    }
    try {
      expect(liveMemoryUi()?.pid).toBe(old.pid)
      await autostart(Date.now())
      await waitFor('the new server', () => { const r = readUiRecord(); return r !== undefined && r.pid !== old.pid && r.build === uiBuildId() })
      await old.proc.exited
      const rec = readUiRecord() as UiRecord
      await waitFor('the new server to answer', async () => (await probeUi(rec.url))?.build === uiBuildId())
      expect(rec.url).toBe(`http://127.0.0.1:${port}`)
      expect(existsSync(join(decoy, 'home', '.buracle', 'state', 'memory-ui.json'))).toBe(false)

      writeFileSync(marker, '0')
      await autostart(Date.now() + 120_000)
      expect(readFileSync(marker, 'utf8')).toBe('0')
      expect(readUiRecord()?.pid).toBe(rec.pid)
    } finally {
      old.proc.kill()
      await stopRecorded()
    }
  }), 90_000)

  test('with capture on, a status line starts no server while no harness session is open; a session start always does, for its session', () => withSandbox(async ({ root, home, buracleHome }) => {
    const port = freePort()
    uiConfig(buracleHome, port)
    const marker = join(paths.stateDir(), 'memory-ui.spawn')
    const driver = autostartDriver(root)
    const autostart = async (caller: 'status-line' | 'session-start'): Promise<void> => {
      const p = Bun.spawn(['bun', driver, join(REPO, 'src', 'usage', 'bar-info.ts'), String(Date.now()), home, buracleHome, caller, 'capture'], { cwd: REPO, env: captureEnv(), stdin: 'ignore', stdout: 'ignore', stderr: 'inherit' })
      expect(await p.exited).toBe(0)
    }
    try {
      session('ended')
      await autostart('status-line')
      await Bun.sleep(1500)
      expect(existsSync(marker)).toBe(false)
      expect(readUiRecord()).toBeUndefined()
      session('active')
      await autostart('status-line')
      await waitFor('the server', async () => { const r = readUiRecord(); return r !== undefined && await probeUi(r.url) !== undefined })
      expect(readFileSync(marker, 'utf8')).toMatch(/^\d+$/)
      await stopRecorded()
      expect(readUiRecord()).toBeUndefined()
      rmSync(sessionRecordFile('claude', SID), { force: true })
      rmSync(marker, { force: true })
      await autostart('session-start')
      await waitFor('the server', async () => { const r = readUiRecord(); return r !== undefined && await probeUi(r.url) !== undefined })
      expect(readSessionRecord('claude', SID)).toBeUndefined()
    } finally {
      await stopRecorded()
    }
  }), 90_000)

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

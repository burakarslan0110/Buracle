import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as doctorRun, indexSection } from '../../../src/cli/commands/doctor'
import { run as installRun } from '../../../src/cli/commands/install'
import { CONFIG_RENAMES, defaultConfig, type ConfigRename } from '../../../src/core/config'
import { liveContext } from '../../../src/engine/update/context'
import { indexChecks } from '../../../src/workflow/workspace-index'
import type { McpCatalog } from '../../../src/core/catalog'
import { checkTools, configChecks, doctorExit, parseShim, skillChecks } from '../../../src/engine/update/doctor'
import { emptyToolchainState } from '../../../src/engine/toolchain/state'
import type { ToolSpec } from '../../../src/core/catalog'
import { run as runProcess } from '../../../src/engine/proc'
import * as paths from '../../../src/engine/paths'
import { styledReport } from '../../../src/cli/commands/doctor'
import { makeStyle, stripAnsi } from '../../../src/cli/ui/style'
import { symlinkSync } from 'node:fs'
import { pathLink, shimContent } from '../../../src/engine/update/install-core'
import { windowsLauncher } from '../../../src/engine/toolchain/links'
import { mcpHealthMap, probeHttp, probeServers, probeStdio, readHealth, writeHealth } from '../../../src/engine/update/mcp'
import { installAdvice } from '../../../src/engine/toolchain/system'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { fakeExe, IS_WINDOWS, onlyPath } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, fakeFetch, makeRepo, memoryIO, REAL_REPO as REAL_REPO_DIR, withDeps } from './helpers'

const FAKE_SERVER = `
const mode = process.argv[2] ?? 'ok'
if (mode === 'crash') { console.error('boom: missing API key'); process.exit(3) }
process.stdout.write('starting fake server (not JSON)\\n')
const decoder = new TextDecoder()
let buf = ''
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true })
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    if (mode === 'silent') continue
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '9.9.9' } } })
    else if (msg.method === 'tools/list' && !msg.params?.cursor) send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'beta' }, { name: 'alpha' }], nextCursor: 'p2' } })
    else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'gamma' }] } })
  }
}
`

function serverScript(root: string): string {
  const p = join(root, 'fake-mcp.ts')
  writeFileSync(p, FAKE_SERVER)
  return p
}

describe('MCP handshake', () => {
  test('stdio: initialize + paginated tools/list; ignores stray stdout lines', () => withSandbox(async ({ root }) => {
    const p = await probeStdio([process.execPath, serverScript(root), 'ok'], { timeoutMs: 15_000 })
    expect(p).toMatchObject({ status: 'ok', tools: 3, toolNames: ['alpha', 'beta', 'gamma'], version: '9.9.9', serverName: 'fake' })
  }))

  test('stdio: a crashing server is down with its stderr; a silent one times out; a missing command is down', () => withSandbox(async ({ root }) => {
    const script = serverScript(root)
    const crash = await probeStdio([process.execPath, script, 'crash'], { timeoutMs: 15_000 })
    expect(crash.status).toBe('down')
    expect(crash.error).toContain('boom: missing API key')
    const silent = await probeStdio([process.execPath, script, 'silent'], { timeoutMs: 400 })
    expect(silent).toMatchObject({ status: 'down' })
    expect(silent.error).toContain('no answer to initialize within 400 ms')
    const missing = await probeStdio([join(root, 'no-such-binary')], { timeoutMs: 2000 })
    expect(missing.status).toBe('down')
  }))

  test('http: SSE answers and the session header are handled through the injectable fetcher', async () => {
    const url = 'https://mcp.example.test/mcp'
    const seen: Array<Record<string, string> | undefined> = []
    const f = fakeFetch({
      [url]: (_u: string, o?: { body?: string, headers?: Record<string, string> }) => {
        seen.push(o?.headers)
        const msg = JSON.parse(o?.body ?? '{}') as { id?: number, method: string }
        if (msg.method === 'initialize') return { ok: true, status: 200, headers: { 'mcp-session-id': 's-1' }, text: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'grep', version: '2.0.0' }, protocolVersion: '2025-06-18' } })}\n\n` }
        if (msg.method === 'tools/list') return { ok: true, status: 200, json: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'searchGitHub' }] } } }
        return { ok: true, status: 202 }
      },
    })
    const p = await probeHttp(url, f, 5000)
    expect(p).toMatchObject({ status: 'ok', tools: 1, version: '2.0.0', toolNames: ['searchGitHub'] })
    expect(seen[2]?.['mcp-session-id']).toBe('s-1')
    const down = await probeHttp(url, fakeFetch({ [url]: () => ({ ok: false, status: 503, error: 'HTTP 503' }) }), 5000)
    expect(down).toMatchObject({ status: 'down', error: 'initialize: HTTP 503' })
  })

  test('probeServers expands {buracle} and forwards ${ENV:NAME}; health maps to ok/down/unknown', () => withSandbox(async ({ root }) => {
    const shim = fakeExe(join(root, 'shim'), FAKE_SERVER)
    const catalog: McpCatalog = {
      servers: {
        mem: { description: 'm', transport: 'stdio', command: '{buracle}', args: ['ok'], env: { TOKEN: '${ENV:BURACLE_TEST_TOKEN}' }, harnesses: ['claude'], pin: 'hard', critical: true, routing: [] },
        broken: { description: 'b', transport: 'stdio', command: '{buracle}', args: ['crash'], harnesses: ['claude'], pin: 'hard', critical: false, routing: [] },
        web: { description: 'w', transport: 'http', url: 'https://x.test', harnesses: ['claude'], pin: 'monitor', critical: false, routing: [] },
      },
    }
    const entries = await withEnv({ BURACLE_TEST_TOKEN: 'secret' }, () => probeServers(catalog, { timeoutMs: 15_000, fetcher: fakeFetch({}), buracle: shim, http: false }, () => '2026-10-08T00:00:00.000Z'))
    expect(Object.keys(entries).sort()).toEqual(['broken', 'mem'])
    expect(entries['mem']).toMatchObject({ status: 'ok', transport: 'stdio', tools: 3 })
    expect(entries['broken']).toMatchObject({ status: 'down' })
    expect(entries['broken']?.error).toContain('boom: missing API key')
    expect(mcpHealthMap(catalog, { v: 1, checked_at: '', mcp: entries })).toEqual({ broken: 'down', mem: 'ok', web: 'unknown' })
  }), 60_000)
})

describe('buracle doctor', () => {
  const MCP_YAML = `servers:
  buracle-memory:
    description: Memory
    transport: stdio
    command: "{buracle}"
    args: ["ok"]
    harnesses: [claude, codex]
    pin: hard
    critical: true
    routing: []
`

  test('runs every section, writes health.json, and exits 1 on errors / 2 on warnings', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root, { 'canonical/mcp.yaml': MCP_YAML })
    expect(fakeExe(join(buracleHome, 'bin', 'buracle'), FAKE_SERVER)).toBe(paths.shimPath())
    const bin = join(root, 'bin')
    fakeExe(join(bin, 'bun'), "console.log('1.4.2')")
    fakeExe(join(bin, 'git'), "console.log('git version 2.50.1')")
    fakeExe(join(bin, 'rg'), "console.log('ripgrep 14.1.1')")
    fakeExe(join(bin, 'node'), "console.log('v24.15.0')")
    fakeExe(join(bin, 'uv'), "console.log('uv 0.12.23')")
    fakeExe(join(bin, 'gh'), "console.log('gh version 2.80.0 (2026-01-01)')")
    const jq = loadCanonicalSync(join(repo, 'canonical')).tools.tools.find(t => t.name === 'jq')
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(join(buracleHome, 'state/updates.json'), JSON.stringify({ v: 1, checked_at: '2026-09-01T00:00:00.000Z', kinds: ['mcp'], items: [{ kind: 'mcp', id: 'context7', current: '1', latest: '2', action: 'bump-pin', risk: 'low' }], held: [], errors: [] }))
    const claude = fakeAdapter('claude', { version: '2.1.293', doctor: () => [{ level: 'ok', check: 'plugin', detail: 'buracle@buracle enabled' }, { level: 'warn', check: 'mod', detail: `heartbeat stale in ${home}/.buracle/run` }] })
    const codex = fakeAdapter('codex', { installed: false })
    const cli = fakeCli(() => ({ code: 0, stdout: JSON.stringify({ checks: [{ level: 'ok', check: 'schema', detail: 'valid' }, { level: 'warn', check: 'inbox', detail: '12 notes' }, { level: 'info', check: 'mcp', detail: 'handshake skipped (--no-mcp)' }] }), stderr: '' }))
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude, codex], runCli: cli.runCli, now: () => Date.parse('2026-10-08T00:00:00Z') }, async () => {
      await withEnv({ PATH: onlyPath(bin) }, async () => {
        const io = memoryIO({ json: true })
        const code = await doctorRun(['--json'], io)
        const r = JSON.parse(io.out()) as { code: number, checks: Array<{ section: string, level: string, check: string, detail: string }> }
        expect(code).toBe(1)
        expect(r.code).toBe(1)
        const find = (section: string, check: string) => r.checks.find(c => c.section === section && c.check === check)
        expect(find('tools', 'jq')).toMatchObject({ level: 'error' })
        expect(jq).toBeDefined()
        expect(find('tools', 'jq')?.detail).toContain(`suggestion: ${installAdvice(jq as ToolSpec, IS_WINDOWS ? 'win32' : 'darwin', () => true)}`)
        // tmux exists for macOS and Linux only (canonical/tools.yaml platforms).
        if (IS_WINDOWS) expect(find('tools', 'tmux')).toBeUndefined()
        else expect(find('tools', 'tmux')).toMatchObject({ level: 'warn' })
        expect(find('tools', 'git')).toMatchObject({ level: 'ok', detail: '2.50.1' })
        expect(find('claude', 'installed')).toMatchObject({ level: 'ok' })
        expect(find('claude', 'mod')).toMatchObject({ level: 'warn', detail: 'heartbeat stale in ~/.buracle/run' })
        expect(find('codex', 'installed')).toMatchObject({ level: 'info' })
        expect(find('mcp', 'buracle-memory')).toMatchObject({ level: 'ok' })
        expect(find('memory', 'inbox')).toMatchObject({ level: 'warn' })
        expect(find('updates', 'cache')).toMatchObject({ level: 'warn' })
        expect(find('updates', 'available')?.detail).toContain('mcp:context7')
        expect(find('config', 'runtime-config')).toMatchObject({ level: 'warn' })
        expect(cli.calls).toEqual([['mem', 'doctor', '--json', '--no-mcp']])
        expect(find('memory', 'mcp')).toMatchObject({ level: 'info', detail: 'the buracle-memory handshake runs in the mcp section (`buracle doctor mcp`)' })
        expect(r.checks.some(c => c.section === 'index')).toBe(true)
      })
      const health = readHealth()
      expect(health?.mcp['buracle-memory']).toMatchObject({ status: 'ok', tools: 3, version: '9.9.9' })
      expect(health?.tools?.['jq']).toMatchObject({ status: 'missing' })
      expect(JSON.parse(readFileSync(join(buracleHome, 'state/health.json'), 'utf8')).v).toBe(1)
    })
  }), 60_000)

  test('in a terminal the section being checked is named while it runs; pipes and --json get no progress on stderr', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => Date.parse('2026-10-08T00:00:00Z') }, async () => {
      const live = memoryIO({ liveErr: true })
      await doctorRun(['config'], live)
      expect(stripAnsi(live.err())).toContain('Checking configuration…')
      // The spinner line is cleared once the section is done, so the report is not repeated by progress lines.
      expect(live.out()).toContain('config')
      const piped = memoryIO()
      await doctorRun(['config'], piped)
      expect(piped.err()).toBe('')
      const json = memoryIO({ json: true, liveErr: true })
      await doctorRun(['config', '--json'], json)
      expect(json.err()).toBe('')
    })
  }), 60_000)

  test('`doctor <harness>` checks config and that harness only; an unavailable memory doctor is skipped', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const claude = fakeAdapter('claude')
    const codex = fakeAdapter('codex', { doctor: () => [{ level: 'ok', check: 'hooks', detail: 'trusted' }] })
    const cli = fakeCli(() => ({ code: 1, stdout: '', stderr: 'buracle mem: not implemented yet\n' }))
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude, codex], runCli: cli.runCli }, async () => {
      const io = memoryIO()
      await doctorRun(['codex'], io)
      expect(io.out()).toContain('codex')
      expect(io.out()).not.toMatch(/^\s+claude/m)
      expect(claude.calls).not.toContain('doctor')
      expect(cli.calls).toEqual([])
      const mem = memoryIO({ json: true })
      expect(await doctorRun(['memory', '--json'], mem)).toBe(0)
      expect(JSON.parse(mem.out()).checks).toEqual([{ section: 'memory', level: 'info', check: 'mem doctor', detail: 'not available yet; skipped' }])
      const bad = memoryIO()
      expect(await doctorRun(['nonsense'], bad)).toBe(1)
      const json = memoryIO({ json: true })
      await doctorRun(['codex', '--json'], json)
      expect((JSON.parse(json.out()) as { checks: Array<{ section: string }> }).checks.some(c => c.section === 'index')).toBe(false)
    })
  }))

  test('the index section shows the code indexes of the project in the current folder', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const cfg = defaultConfig()
    const now = Date.parse('2026-10-08T00:00:00Z')
    const rows = await indexSection(repo, cfg, now)
    expect(rows).toEqual((await indexChecks(repo, cfg, now)).map(c => ({ section: 'index', ...c })))
    expect(rows.map(r => [r.level, r.check])).toEqual([['warn', 'index.codegraph'], ['warn', 'index.semble']])
    expect(rows.every(r => r.detail.startsWith(repo))).toBe(true)
    expect(await indexSection(home, cfg, now)).toEqual([{ section: 'index', level: 'info', check: 'index', detail: `${home} is your home folder: nothing is indexed here` }])
  }))

  test('config section after an install: PATH link and runtime snapshot are ok; a shim that runs the checkout is a warning; another checkout is flagged', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    expect(parseShim(shimContent({ bun: "/o'dd/bun", repoRoot: '/r e' }))).toEqual({ bun: "/o'dd/bun", main: '/r e/src/cli/main.ts' })
    expect(parseShim('#!/bin/sh\necho hi\n')).toBeUndefined()
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const io = memoryIO({ json: true })
      await doctorRun(['config', '--json'], io)
      const checks = (JSON.parse(io.out()) as { checks: Array<{ check: string, level: string, detail: string }> }).checks
      const level = (c: string) => checks.find(x => x.check === c)?.level
      expect([level('path-link'), level('runtime-config'), level('config')]).toEqual(['ok', 'ok', 'ok'])
      expect(checks.find(x => x.check === 'shim')).toMatchObject({ level: 'warn' })
      expect(checks.find(x => x.check === 'shim')?.detail).toContain('mode: checkout')
      writeFileSync(join(buracleHome, 'bin', 'buracle'), shimContent({ bun: process.execPath, repoRoot: '/other/checkout' }))
      const again = memoryIO({ json: true })
      await doctorRun(['config', '--json'], again)
      const shim = (JSON.parse(again.out()) as { checks: Array<{ check: string, level: string, detail: string }> }).checks.find(x => x.check === 'shim')
      expect(shim).toMatchObject({ level: 'warn' })
      expect(shim?.detail).toContain('runs another checkout (/other/checkout/src/cli/main.ts)')
    })
  }))

  test('a harness topic turns on the adapters\' liveness probes (BURACLE_DOCTOR_LIVE=1) only while they run; doctor without a topic leaves them off', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const seen: Array<string | undefined> = []
    const claude = fakeAdapter('claude', { doctor: () => { seen.push(process.env['BURACLE_DOCTOR_LIVE']); return [{ level: 'ok', check: 'mod liveness', detail: 'pong' }] } })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude], runCli: fakeCli().runCli }, async () => {
      await withEnv({ BURACLE_DOCTOR_LIVE: undefined }, async () => {
        await doctorRun(['claude', '--json'], memoryIO({ json: true }))
        expect(process.env['BURACLE_DOCTOR_LIVE']).toBeUndefined()
      })
      await withEnv({ BURACLE_DOCTOR_LIVE: '0' }, async () => {
        await doctorRun(['claude', '--json'], memoryIO({ json: true }))
        expect(process.env['BURACLE_DOCTOR_LIVE']).toBe('0')
      })
    })
    expect(seen).toEqual(['1', '1'])
  }))

  test('the removed flags exit 1 and name what to run instead', async () => {
    for (const [argv, want] of [
      [['--no-mcp'], '--no-mcp was removed; run `buracle doctor <topic>` for the sections you want'],
      [['--no-lsp', '--json'], '--no-lsp was removed; run `buracle doctor <topic>` for the sections you want'],
      [['claude', '--live'], '--live was removed; a harness topic runs the liveness probes: `buracle doctor claude`'],
      [['mcp', '--timeout', '500'], '--timeout was removed; every handshake waits up to 30 s'],
    ] as const) {
      const io = memoryIO()
      expect(await doctorRun([...argv], io)).toBe(1)
      expect(io.err()).toBe(`buracle doctor: ${want}\n`)
      expect(io.out()).toBe('')
    }
  })

  test('doctor tools lists the version of every toolchain package and the one kept for a rollback', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    const state = emptyToolchainState()
    state.packages['npm:@acme/srv'] = { registry: 'npm', name: '@acme/srv', version: '1.1.0', dir: join(buracleHome, 'toolchain/npm/x'), bins: {}, previous: { version: '1.0.0' }, installed_at: '2026-10-01T00:00:00.000Z' }
    state.packages['pypi:probe'] = { registry: 'pypi', name: 'probe', version: '0.3.0', dir: join(buracleHome, 'toolchain/pypi/x'), bins: {}, rolled_back: '0.4.0', installed_at: '2026-10-01T00:00:00.000Z' }
    writeFileSync(paths.toolchainStateFile(), JSON.stringify(state))
    await withDeps({ repoRoot: () => repo }, async () => {
      const io = memoryIO({ json: true })
      await doctorRun(['tools', '--json'], io)
      const checks = (JSON.parse(io.out()) as { checks: Array<{ section: string, level: string, check: string, detail: string }> }).checks
      expect(checks.find(c => c.check === 'toolchain.autoInstall')).toBeUndefined()
      expect(checks.filter(c => c.check.includes(':'))).toEqual([
        { section: 'tools', level: 'ok', check: 'npm:@acme/srv', detail: "1.1.0 in Buracle's toolchain; 1.0.0 kept for `buracle rollback toolchain`" },
        { section: 'tools', level: 'ok', check: 'pypi:probe', detail: "0.3.0 in Buracle's toolchain; 0.4.0 was rolled back" },
      ])
    })
    writeFileSync(join(buracleHome, 'config.yaml'), 'toolchain:\n  autoInstall: false\n')
    await withDeps({ repoRoot: () => repo }, async () => {
      const io = memoryIO({ json: true })
      await doctorRun(['tools', '--json'], io)
      const off = (JSON.parse(io.out()) as { checks: Array<{ check: string, level: string, detail: string }> }).checks.find(c => c.check === 'toolchain.autoInstall')
      expect(off).toMatchObject({ level: 'info', detail: expect.stringContaining('buracle config set toolchain.autoInstall true') })
    })
  }), 60_000)

  test('a failed start `buracle mcp run` recorded is down only until its `until` (core mcpHealthOf); readHealth keeps the record', () => withSandbox(async ({ buracleHome }) => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0)
    const until = new Date(now + 60_000).toISOString()
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(join(buracleHome, 'state/health.json'), JSON.stringify({ v: 1, checked_at: 'x', mcp: { 'web-search': { status: 'down', error: 'exited with code 1', source: 'launch', until }, grep: { status: 'down' } } }))
    const h = readHealth()
    expect(h?.mcp['web-search']).toEqual({ status: 'down', error: 'exited with code 1', source: 'launch', until })
    const catalog = { servers: { 'web-search': {} as never, grep: {} as never, web: {} as never } }
    expect(mcpHealthMap(catalog, h, now)).toEqual({ grep: 'down', web: 'unknown', 'web-search': 'down' })
    expect(mcpHealthMap(catalog, h, now + 60_000)).toEqual({ grep: 'down', web: 'unknown', 'web-search': 'unknown' })
  }))

  test('health.json keeps the documented shape: earlier entries are normalized, bare statuses accepted', () => withSandbox(async ({ buracleHome }) => {
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(join(buracleHome, 'state/health.json'), JSON.stringify({ v: 1, checked_at: 'x', mcp: { grep: 'down', semble: { status: 'ok', tools: 2 }, junk: 42, odd: { status: 'maybe' } }, tools: { jq: { status: 'ok', checked_at: 'x' }, bad: 'ok' } }))
    const before = readHealth()
    expect(before?.mcp).toEqual({ grep: { status: 'down' }, semble: { status: 'ok', tools: 2 } })
    expect(mcpHealthMap({ servers: { grep: {} as never, semble: {} as never, web: {} as never } }, before)).toEqual({ grep: 'down', semble: 'ok', web: 'unknown' })
    writeHealth({ mcp: { context7: { status: 'ok', transport: 'stdio', tools: 2, toolNames: ['a', 'b'], ms: 12, checked_at: '2026-10-08T00:00:00.000Z' } } }, '2026-10-08T00:00:00.000Z')
    const raw = JSON.parse(readFileSync(join(buracleHome, 'state/health.json'), 'utf8')) as Record<string, unknown>
    expect(raw).toEqual({
      v: 1,
      checked_at: '2026-10-08T00:00:00.000Z',
      mcp: {
        context7: { status: 'ok', transport: 'stdio', tools: 2, toolNames: ['a', 'b'], ms: 12, checked_at: '2026-10-08T00:00:00.000Z' },
        grep: { status: 'down' },
        semble: { status: 'ok', tools: 2 },
      },
      tools: { jq: { status: 'ok', checked_at: 'x' } },
    })
  }))

  test('a tool missing from PATH that Buracle\'s toolchain provides counts through its toolchain copy', () => withSandbox(async ({ root }) => {
    const bin = fakeExe(join(root, 'tc', 'codegraph'), "console.log('1.6.2')")
    const state = emptyToolchainState()
    state.packages['npm:@colbymchenry/codegraph'] = { registry: 'npm', name: '@colbymchenry/codegraph', version: '1.6.2', dir: join(root, 'tc'), bins: { codegraph: bin }, installed_at: 'x' }
    const tool: ToolSpec = { name: 'codegraph', check: ['codegraph', '--version'], version_regex: '(\\d+\\.\\d+\\.\\d+)', required: true, npm: '@colbymchenry/codegraph' }
    const absent: ToolSpec = { name: 'semble', check: ['semble', '--version'], version_regex: '(\\d+\\.\\d+\\.\\d+)', required: true, pypi: 'semble[mcp]' }
    await withDeps({ run: async (argv, opts) => (argv[0] === 'codegraph' || argv[0] === 'semble' ? { code: 127, stdout: '', stderr: '', timedOut: false } : runProcess(argv, opts ?? {})) }, async () => {
      const [cg, sb] = await checkTools([tool, absent], 5000, state)
      expect(cg).toEqual({ name: 'codegraph', status: 'ok', version: '1.6.2', detail: '1.6.2 (Buracle toolchain)' })
      expect(sb).toMatchObject({ status: 'missing' })
    })
  }))

  test.skipIf(process.platform === 'win32')('F3-4: a tool `go install` or `dotnet tool install` put only into the toolchain counts, as H04 and `buracle lsp run` find it there', () => withSandbox(async () => {
    const golangci: ToolSpec = { name: 'golangci-lint', check: ['golangci-lint', '--version'], version_regex: 'version v?(\\d+\\.\\d+\\.\\d+)', required: false, go: 'github.com/golangci/golangci-lint/v2/cmd/golangci-lint' }
    const csharp: ToolSpec = { name: 'csharp-ls', check: ['csharp-ls', '--version'], version_regex: 'csharp-ls,? (\\d+\\.\\d+\\.\\d+)', required: false, dotnet: 'csharp-ls' }
    const broken: ToolSpec = { name: 'gopls', check: ['gopls', 'version'], version_regex: 'v(\\d+\\.\\d+\\.\\d+)', required: false, go: 'golang.org/x/tools/gopls' }
    const goBin = join(paths.toolchainDir(), 'go', 'bin')
    const dotnetTools = join(paths.toolchainDir(), 'dotnet', 'tools')
    mkdirSync(goBin, { recursive: true })
    mkdirSync(dotnetTools, { recursive: true })
    writeFileSync(join(goBin, 'golangci-lint'), '#!/bin/sh\necho "golangci-lint has version v2.5.0 built with go1.25"\n', { mode: 0o755 })
    writeFileSync(join(dotnetTools, 'csharp-ls'), '#!/bin/sh\necho "csharp-ls, 0.20.0"\n', { mode: 0o755 })
    writeFileSync(join(goBin, 'gopls'), '#!/bin/sh\necho boom >&2\nexit 2\n', { mode: 0o755 })
    const pathOnly = new Set(['golangci-lint', 'csharp-ls', 'gopls'])
    await withDeps({ run: async (argv, opts) => (pathOnly.has(argv[0] ?? '') ? { code: 127, stdout: '', stderr: '', timedOut: false } : runProcess(argv, opts ?? {})) }, async () => {
      const [lint, cs, gopls] = await checkTools([golangci, csharp, broken], 5000, emptyToolchainState())
      expect(lint).toEqual({ name: 'golangci-lint', status: 'ok', version: '2.5.0', detail: '2.5.0 (Buracle toolchain, ~/.buracle/toolchain/go/bin/golangci-lint)' })
      expect(cs).toMatchObject({ status: 'ok', version: '0.20.0' })
      expect(gopls).toMatchObject({ status: 'error', detail: expect.stringContaining('does not run: exit 2; run `buracle install`') })
    })
    rmSync(join(goBin, 'golangci-lint'))
    await withDeps({ run: async () => ({ code: 127, stdout: '', stderr: '', timedOut: false }) }, async () => {
      expect((await checkTools([golangci], 5000, emptyToolchainState()))[0]).toEqual({ name: 'golangci-lint', status: 'missing', detail: 'not found on PATH or in the Buracle toolchain' })
    })
  }))

  test.skipIf(process.platform === 'win32')('the Bun the install script put in ~/.bun/bin counts though a new terminal has it not on PATH yet', () => withSandbox(async ({ home }) => {
    const bun: ToolSpec = { name: 'bun', check: ['bun', '--version'], version_regex: '(\\d+\\.\\d+\\.\\d+)', required: true }
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true })
    writeFileSync(join(home, '.bun', 'bin', 'bun'), '#!/bin/sh\necho 1.4.3\n', { mode: 0o755 })
    await withDeps({ run: async (argv, opts) => (argv[0] === 'bun' ? { code: 127, stdout: '', stderr: '', timedOut: false } : runProcess(argv, opts ?? {})) }, async () => {
      expect((await checkTools([bun], 5000, emptyToolchainState()))[0]).toMatchObject({ name: 'bun', status: 'ok', version: '1.4.3' })
    })
  }))

  test('skills: in the Claude plugin and linked into ~/.agents/skills for the other harnesses', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'repo')
    for (const id of ['plan-build', 'bugfix']) {
      mkdirSync(join(repo, 'harness', 'claude', 'skills', id), { recursive: true })
      writeFileSync(join(repo, 'harness', 'claude', 'skills', id, 'SKILL.md'), '---\nname: x\n---\n')
      mkdirSync(join(repo, 'harness', 'agents-skills', id), { recursive: true })
      writeFileSync(join(repo, 'harness', 'agents-skills', id, 'SKILL.md'), '---\nname: x\n---\n')
    }
    const before = skillChecks(['plan-build', 'bugfix'], repo, { claude: true, shared: true })
    expect(before.map(c => [c.check, c.level])).toEqual([['claude plugin', 'ok'], ['shared (~/.agents/skills)', 'error']])
    mkdirSync(join(paths.agentsDir(), 'skills'), { recursive: true })
    for (const id of ['plan-build', 'bugfix']) symlinkSync(join(repo, 'harness', 'agents-skills', id), join(paths.agentsDir(), 'skills', id))
    expect(skillChecks(['plan-build', 'bugfix'], repo, { claude: true, shared: true }).every(c => c.level === 'ok')).toBe(true)
    expect(skillChecks(['plan-build', 'gone'], repo, { claude: true, shared: false })[0]).toMatchObject({ level: 'error', detail: expect.stringContaining('gone') })
  }))

  test('the shared skills are checked only when Codex, OpenCode or Oh My Pi is installed, as install links them only then', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root, { 'canonical/skills/demo/SKILL.md': '---\nname: demo\ndescription: A demo skill.\n---\nBody.\n' })
    const shared = async (installed: boolean): Promise<{ level: string } | undefined> => {
      const adapters = [fakeAdapter('claude'), fakeAdapter('codex', { installed }), fakeAdapter('opencode', { installed: false }), fakeAdapter('omp', { installed: false })]
      return withDeps({ repoRoot: () => repo, adapters: async () => adapters, runCli: fakeCli().runCli }, async () => {
        const io = memoryIO({ json: true })
        await doctorRun(['codex', '--json'], io)
        const r = JSON.parse(io.out()) as { checks: Array<{ section: string, level: string, check: string }> }
        return r.checks.find(c => c.section === 'skills' && c.check === 'shared (~/.agents/skills)')
      })
    }
    expect(await shared(false)).toBeUndefined()
    expect(await shared(true)).toMatchObject({ level: 'error' })
  }), 60_000)

  test('the terminal report: one block per section, a symbol per check, the summary in English', () => {
    const text = styledReport(makeStyle(0), [
      { section: 'tools', level: 'ok', check: 'bun', detail: '1.4.2' },
      { section: 'mcp', level: 'error', check: 'context7', detail: 'down: no answer' },
      { section: 'mcp', level: 'warn', check: 'grep', detail: 'slow' },
    ], 100)
    expect(text).toContain('Tools')
    expect(text).toContain('MCP servers')
    expect(text).toMatch(/✔ bun +1\.4\.2/)
    expect(text).toMatch(/✖ context7 +down: no answer/)
    expect(text).toContain('1 ok · 1 warning · 1 error')
    const many = styledReport(makeStyle(0), [
      { section: 'memory', level: 'warn', check: 'inbox', detail: 'full' },
      { section: 'memory', level: 'warn', check: 'index', detail: 'stale' },
      { section: 'config', level: 'info', check: 'snapshot', detail: 'n/a' },
    ], 100)
    expect(many).toContain('Memory')
    expect(many).toContain('Configuration')
    expect(many).toContain('0 ok · 2 warnings · 1 note')
  })

  test('a server\'s own output in a detail reaches the terminal without escape sequences', () => {
    const text = styledReport(makeStyle(0), [{ section: 'mcp', level: 'error', check: 'web-search', detail: 'exited: \u001b[2J\u001b[31mboom\u001b[0m' }], 100)
    expect(text).not.toContain('\u001b')
    expect(text).toContain('boom')
  })

  test('exit code helper', () => {
    expect(doctorExit([])).toBe(0)
    expect(doctorExit([{ section: 's', level: 'info', check: 'c', detail: '' }])).toBe(0)
    expect(doctorExit([{ section: 's', level: 'warn', check: 'c', detail: '' }])).toBe(2)
    expect(doctorExit([{ section: 's', level: 'warn', check: 'c', detail: '' }, { section: 's', level: 'error', check: 'c', detail: '' }])).toBe(1)
  })
})

describe('buracle doctor runtime: unsettled transactions, stale locks, generated drift, packages, hook failures', () => {
  test('lists every rollback-failed journal (not only the first), an interrupted one, a stale lock and hook failures', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    const journal = (txn: string, status: string, error?: string) => {
      mkdirSync(join(buracleHome, 'journal'), { recursive: true })
      writeFileSync(join(buracleHome, 'journal', `${txn}.json`), JSON.stringify({ v: 1, txn, status, startedAt: '2026-01-01T00:00:00.000Z', plans: [], files: [], createdDirs: [], execs: [], ledger: [], ...(error !== undefined ? { error } : {}) }))
    }
    journal('20260101T000000000Z-aaaaaa', 'rollback-failed', 'EACCES: settings.json')
    journal('20260102T000000000Z-bbbbbb', 'committed')
    journal('20260103T000000000Z-cccccc', 'rollback-failed')
    journal('20260104T000000000Z-dddddd', 'applying')
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(join(buracleHome, 'state', 'txn.lock'), JSON.stringify({ pid: 4194303, startedAt: Date.now() - 60_000 }) + '\n')
    mkdirSync(join(buracleHome, 'logs'), { recursive: true })
    writeFileSync(join(buracleHome, 'logs', 'buracle.log'), JSON.stringify({ ts: new Date().toISOString(), level: 'error', pid: 1, msg: 'hook handler failed', data: { harness: 'claude', event: 'PreToolUse', result: 'fail-closed', error: { message: 'Unexpected <<' } } }) + '\n')
    await withDeps({ repoRoot: () => repo, adapters: async () => [] }, async () => {
      const io = memoryIO({ json: true })
      expect(await doctorRun(['runtime', '--json'], io)).toBe(1)
      const checks = (JSON.parse(io.out()) as { checks: Array<{ check: string, level: string, detail: string }> }).checks
      const journals = checks.filter(c => c.check === 'journals')
      expect(journals.filter(c => c.level === 'error').map(c => c.detail)).toEqual([
        'transaction 20260103T000000000Z-cccccc could not be rolled back completely; fix the cause, then run `buracle rollback 20260103T000000000Z-cccccc`',
        'transaction 20260101T000000000Z-aaaaaa could not be rolled back completely (EACCES: settings.json); fix the cause, then run `buracle rollback 20260101T000000000Z-aaaaaa`',
      ])
      expect(journals.some(c => c.level === 'warn' && c.detail.includes('20260104T000000000Z-dddddd was interrupted'))).toBe(true)
      expect(checks.find(c => c.check === 'locks')).toMatchObject({ level: 'warn', detail: expect.stringContaining('is stale: its process 4194303 is gone') })
      const hooks = checks.find(c => c.check === 'hooks')
      expect(hooks?.level).toBe('warn')
      expect(hooks?.detail).toContain('1 Buracle hook failure(s) in the last 24 h, 1 of them denied the tool call (fail closed)')
      expect(hooks?.detail).toContain('Unexpected <<')
    })
  }))

  test('generated files that differ from the manifest or from canonical/, and node_modules that does not match package.json', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'repo')
    for (const d of ['canonical', 'harness']) cpSync(join(REAL_REPO_DIR, d), join(repo, d), { recursive: true })
    if (IS_WINDOWS) {
      // Windows keeps the executable bit only in the git index: the copy gets the checkout's.
      await runProcess(['git', 'init', '-q'], { cwd: repo })
      await runProcess(['git', 'add', '-A', 'canonical', 'harness'], { cwd: repo })
      const index = await runProcess(['git', 'ls-files', '--stage', '--', 'canonical', 'harness'], { cwd: REAL_REPO_DIR })
      const executables = index.stdout.split('\n').filter(l => l.startsWith('100755 ')).map(l => l.slice(l.indexOf('\t') + 1))
      if (executables.length > 0) await runProcess(['git', 'update-index', '--chmod=+x', '--', ...executables], { cwd: repo })
    }
    writeFileSync(join(repo, 'package.json'), '{"name":"buracle-test","version":"0.0.0","dependencies":{"yaml":"1.0.0"}}\n')
    symlinkSync(join(REAL_REPO_DIR, 'node_modules'), join(repo, 'node_modules'))
    await withDeps({ repoRoot: () => repo, adapters: async () => [] }, async () => {
      const run = async () => {
        const io = memoryIO({ json: true })
        await doctorRun(['runtime', '--json'], io)
        return (JSON.parse(io.out()) as { checks: Array<{ check: string, level: string, detail: string }> }).checks
      }
      const clean = await run()
      expect(clean.filter(c => c.check === 'generated').map(c => c.level)).toEqual(['ok'])
      expect(clean.find(c => c.check === 'node_modules')).toMatchObject({ level: 'warn', detail: expect.stringContaining('yaml is 2.9.1, package.json pins 1.0.0') })
      writeFileSync(join(repo, 'harness', 'hook-data.json'), '{}\n')
      const edited = await run()
      expect(edited.find(c => c.check === 'generated')).toMatchObject({ level: 'warn', detail: expect.stringContaining('harness/hook-data.json') })
      const rule = join(repo, 'canonical', 'rules', 'always', readdirSync(join(repo, 'canonical', 'rules', 'always')).filter(f => f.endsWith('.md'))[0] as string)
      writeFileSync(rule, `${readFileSync(rule, 'utf8')}\nOne more line.\n`)
      const drifted = await run()
      expect(drifted.some(c => c.check === 'generated' && c.detail.includes('canonical/ changed after the last `buracle build`'))).toBe(true)
    })
  }), 60_000)
})

describe('buracle doctor: the PATH entry on Windows', () => {
  test('is a launcher file that starts the shim, not a symlink', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    await withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
      const link = () => configChecks(liveContext(repo), { error: 'not loaded', problems: [] }, repo).find(c => c.check === 'path-link')
      const launcher = `${pathLink()}.cmd`
      expect(link()).toMatchObject({ level: 'warn', detail: expect.stringContaining('buracle.cmd is missing') })
      mkdirSync(paths.localBinDir(), { recursive: true })
      writeFileSync(launcher, windowsLauncher(join(root, 'other', 'buracle.cmd')))
      expect(link()).toMatchObject({ level: 'warn', detail: expect.stringContaining('does not start') })
      writeFileSync(launcher, windowsLauncher(paths.shimPath()))
      expect(link()).toMatchObject({ level: 'ok', detail: expect.stringContaining('→ shim') })
    })
  }))
})

describe('buracle doctor: renamed config keys', () => {
  test('a value moved from a renamed key gets a warn row; the file is not called valid without comment (O6)', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    mkdirSync(buracleHome, { recursive: true })
    writeFileSync(join(buracleHome, 'config.yaml'), 'statusline:\n  theme: full\n')
    const renames = CONFIG_RENAMES as ConfigRename[]
    renames.push({ from: 'statusline.theme', to: 'statusline.style', since: '9.9.9' })
    try {
      const live = liveContext(repo)
      expect(live.config.statusline.style).toBe('full')
      const rows = configChecks(live, { error: 'not loaded', problems: [] }, repo).filter(c => c.check === 'config')
      expect(rows).toEqual([{ section: 'config', level: 'warn', check: 'config', detail: '~/.buracle/config.yaml: statusline.theme was renamed to statusline.style in 9.9.9; its value was used (rename the key in config.yaml)' }])
    } finally {
      renames.pop()
    }
  }))
})

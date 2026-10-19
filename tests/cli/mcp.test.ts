import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { backgroundInstallArgv, CODEGRAPH_GATE_MS, codegraphGate, expireLaunchFailures, LAUNCH_DOWN_TTL_MS, recordLaunchFailure, run as mcpRun, startMjsRefusal } from '../../src/cli/commands/mcp'
import { defaultConfig } from '../../src/core/config'
import { classifyTool } from '../../src/core/events'
import { harnessMcpToolName, mcpHealthOf, routeTool, type RoutingPolicy } from '../../src/core/policy/routing'
import { loadCanonicalSync } from '../../src/engine/canonical'
import { cmHome, cmProbeRoot, cmSentinelDir, cmSessionsDir, cmStorageRoot } from '../../src/engine/context-mode'
import * as paths from '../../src/engine/paths'
import { fallbackNpmCache } from '../../src/engine/toolchain/launch'
import { emptyToolchainState, updateToolchainState } from '../../src/engine/toolchain/state'
import type { ToolchainItem, ToolchainOptions } from '../../src/engine/toolchain/index'
import { COMMANDS } from '../../src/cli/router'
import { runStubServer, STUB_PROTOCOL_VERSION, stubReply, stubReplyLine } from '../../src/engine/toolchain/stub'
import { indexLockFile } from '../../src/workflow/workspace'
import { fakeExe, IS_WINDOWS, KEEPS_MODES, pathOf } from '../helpers/fake-exe'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { memoryIO, withDeps } from './ops/helpers'
import { g } from '../workflow/fixture'

const MAIN = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts')

async function gitInit(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await g(dir, 'init', '-q')
}

describe('buracle mcp run codegraph: start gate', () => {
  test('a run that keeps building is given 4 s, then the server starts anyway', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      mkdirSync(join(indexLockFile(repo), '..'), { recursive: true })
      writeFileSync(indexLockFile(repo), JSON.stringify({ pid: process.pid, at: 0 }))
      let t = 0
      const r = await codegraphGate(repo, { cfg: defaultConfig(), nowMs: () => t, sleep: async ms => { t += ms }, argv: undefined })
      expect(CODEGRAPH_GATE_MS).toBeLessThan(5_000)
      expect(r).toEqual({ root: repo, outcome: 'timeout', waitedMs: 4_000 })
    })
  })

  test('the server starts once codegraph has built the index, even while the run still warms semble', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      mkdirSync(join(indexLockFile(repo), '..'), { recursive: true })
      writeFileSync(indexLockFile(repo), JSON.stringify({ pid: process.pid, at: 0 }))
      let t = 0
      const sleep = async (ms: number) => {
        t += ms
        if (t === 1_500) {
          mkdirSync(join(repo, '.codegraph'), { recursive: true })
          writeFileSync(join(repo, '.codegraph', 'codegraph.db'), '')
        }
      }
      expect(await codegraphGate(repo, { cfg: defaultConfig(), nowMs: () => t, sleep, argv: undefined })).toEqual({ root: repo, outcome: 'ready', waitedMs: 1_500 })
    })
  })

  test('an index in place starts the server at once', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      mkdirSync(join(repo, '.codegraph'), { recursive: true })
      writeFileSync(join(repo, '.codegraph', 'codegraph.db'), '')
      expect(await codegraphGate(repo, { cfg: defaultConfig(), argv: undefined })).toEqual({ root: repo, outcome: 'present', waitedMs: 0 })
    })
  })
})

// A POSIX script, for the cases about POSIX itself (a file without the executable bit, fcntl flags).
function script(dir: string, name: string, body: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, `#!/bin/sh\n${body}`, { mode })
  return p
}

function installWebSearch(entry: string): void {
  updateToolchainState(s => {
    s.packages['npm:open-websearch'] = { registry: 'npm', name: 'open-websearch', version: '9.9.9', dir: dirname(entry), bins: { 'open-websearch': entry }, installed_at: 'x' }
  }, new Date(0).toISOString())
}

function launch(env: Record<string, string | undefined> = {}) {
  return Bun.spawn([process.execPath, MAIN, 'mcp', 'run', 'web-search'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
}

async function pidIn(file: string): Promise<number> {
  for (let i = 0; i < 500; i++) {
    const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
    if (/^\d+$/.test(text)) return Number(text)
    await Bun.sleep(20)
  }
  throw new Error(`no pid in ${file}`)
}

async function textIn(file: string): Promise<string> {
  for (let i = 0; i < 500; i++) {
    const text = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
    if (text !== '') return text
    await Bun.sleep(20)
  }
  throw new Error(`nothing in ${file}`)
}

const PYTHON = Bun.which('python3')
const q = (v: unknown): string => JSON.stringify(v)

function fdProbe(dir: string, file: string): string {
  const code = 'import fcntl, os, sys\nflags = [bool(fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_NONBLOCK) for fd in (0, 1, 2)]\nopen(sys.argv[1], "w").write(" ".join(map(str, flags)))\nsys.stdin.readline()\n'
  return script(dir, 'open-websearch', `exec "${PYTHON ?? 'python3'}" -I -c '${code}' "${file}"\n`)
}

function healthEntry(id: string): Record<string, unknown> | undefined {
  if (!existsSync(paths.healthFile())) return undefined
  return (JSON.parse(readFileSync(paths.healthFile(), 'utf8')) as { mcp?: Record<string, Record<string, unknown>> }).mcp?.[id]
}

const POLICY: RoutingPolicy = { ...loadCanonicalSync(paths.canonicalDir()).routing, strictness: 'enforce' }
const webSearch = (h: 'claude' | 'opencode' | 'omp') => {
  const tool = { claude: 'WebSearch', opencode: 'websearch', omp: 'web_search' }[h]
  return { harness: h, sessionId: 's', cwd: '/w', tool, input: { query: 'bun 1.4 changelog' }, ...classifyTool(h, tool, { query: 'bun 1.4 changelog' }, '/w') }
}

// execve and POSIX signals: Windows has neither, so there the launcher runs the server as its child (the last case).
describe('buracle mcp run: the launcher becomes the server (PERF-5)', () => {
  test.skipIf(IS_WINDOWS)('a toolchain copy replaces the launcher process: the server has its pid and its exit code is the exit code', async () => {
    await withSandbox(async ({ root }) => {
      const pidFile = join(root, 'server.pid')
      installWebSearch(fakeExe(join(root, 'tc', 'open-websearch'), `fs.writeFileSync(${q(pidFile)}, String(process.pid))\nawait Bun.stdin.text()\nprocess.exit(7)`))
      const proc = launch()
      expect(await pidIn(pidFile)).toBe(proc.pid)
      proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
      await proc.stdin.end()
      expect(await proc.exited).toBe(7)
      expect(healthEntry('web-search')).toBeUndefined()
    })
  })

  test.skipIf(IS_WINDOWS)('the harness\'s signal reaches the server itself: SIGTERM ends the process by that signal', async () => {
    await withSandbox(async ({ root }) => {
      const pidFile = join(root, 'server.pid')
      installWebSearch(fakeExe(join(root, 'tc', 'open-websearch'), `fs.writeFileSync(${q(pidFile)}, String(process.pid))\nsetTimeout(() => {}, 30_000)`))
      const proc = launch()
      expect(await pidIn(pidFile)).toBe(proc.pid)
      proc.kill('SIGTERM')
      await proc.exited
      expect(proc.signalCode).toBe('SIGTERM')
    })
  })

  test.skipIf(PYTHON === null || IS_WINDOWS)('the server gets the stdio the harness gave the launcher: fds 0-2 stay blocking, as a child too', async () => {
    await withSandbox(async ({ root }) => {
      for (const [i, env] of [{}, { BURACLE_PLATFORM: 'win32' }].entries()) {
        const flagsFile = join(root, `flags-${i}.txt`)
        installWebSearch(fdProbe(join(root, `tc-${i}`), flagsFile))
        const proc = launch(env)
        try {
          expect({ env, flags: await textIn(flagsFile) }).toEqual({ env, flags: 'False False False' })
        } finally {
          proc.stdin.write('done\n')
          await proc.stdin.end()
        }
        expect(await proc.exited).toBe(0)
      }
    })
  })

  test('without execve (Windows) the server runs as the launcher\'s child and its exit code is passed on', async () => {
    await withSandbox(async ({ root }) => {
      const pidFile = join(root, 'server.pid')
      installWebSearch(fakeExe(join(root, 'tc', 'open-websearch'), `fs.writeFileSync(${q(pidFile)}, String(process.pid))\nawait Bun.stdin.text()\nprocess.exit(5)`))
      const proc = launch({ BURACLE_PLATFORM: 'win32' })
      expect(await pidIn(pidFile)).not.toBe(proc.pid)
      proc.stdin.write('x\n')
      await proc.stdin.end()
      expect(await proc.exited).toBe(5)
    })
  })
})

describe('buracle mcp run: a failed start makes the built-in fallback reachable (R6-02)', () => {
  test('the package runner fails while starting: web-search is down for 10 minutes, so a built-in web search goes to web-fetch, and to the built-in once web-fetch failed too', async () => {
    await withSandbox(async ({ root }) => {
      const bin = join(root, 'bin')
      fakeExe(join(bin, 'npx'), "console.error('npm error network request failed')\nprocess.exit(1)")
      const before = Date.now()
      const proc = launch({ PATH: pathOf(bin, process.env['PATH'] ?? '') })
      expect(await proc.exited).toBe(1)
      const entry = healthEntry('web-search')
      expect(entry).toMatchObject({ status: 'down', source: 'launch' })
      expect(String(entry?.['error'])).toContain('exited with code 1')
      const until = Date.parse(String(entry?.['until']))
      expect(until - before).toBeGreaterThanOrEqual(LAUNCH_DOWN_TTL_MS)
      expect(until - Date.now()).toBeLessThanOrEqual(LAUNCH_DOWN_TTL_MS)
      const health = () => mcpHealthOf(JSON.parse(readFileSync(paths.healthFile(), 'utf8')) as unknown, Date.now())
      for (const h of ['claude', 'opencode', 'omp'] as const) {
        const d = routeTool(webSearch(h), POLICY, health())
        expect({ h, action: d.action }).toEqual({ h, action: 'deny' })
        expect(d.action === 'deny' ? d.reason : '').toContain(harnessMcpToolName(h, 'web-fetch', 'fetch_url'))
      }
      await recordLaunchFailure('web-fetch', 'the server exited with code 1 0.3 s after it started', Date.now())
      for (const h of ['claude', 'opencode', 'omp'] as const) {
        const d = routeTool(webSearch(h), POLICY, health())
        expect({ h, action: d.action }).toEqual({ h, action: 'allow' })
        expect(d.action === 'allow' ? d.context?.join(' ') : '').toContain('fallback')
      }
      const raw = JSON.parse(readFileSync(paths.healthFile(), 'utf8')) as unknown
      const later = routeTool(webSearch('claude'), POLICY, mcpHealthOf(raw, until + 60_000))
      expect(later.action === 'deny' ? later.reason : '').toContain('mcp__plugin_buracle_web-search__search')
    })
  })

  test('a toolchain copy that cannot be executed is a failed start too', async () => {
    await withSandbox(async ({ root }) => {
      installWebSearch(script(join(root, 'tc'), 'open-websearch', 'exit 0\n', 0o644))
      const proc = launch()
      expect(await proc.exited).toBe(1)
      expect(await new Response(proc.stderr).text()).toContain('cannot start')
      expect(healthEntry('web-search')).toMatchObject({ status: 'down', source: 'launch' })
    })
  })

  test.skipIf(IS_WINDOWS)('a signal the launcher forwards ends the server without a failed start', async () => {
    await withSandbox(async ({ root }) => {
      const bin = join(root, 'bin')
      const pidFile = join(root, 'server.pid')
      fakeExe(join(bin, 'npx'), `fs.writeFileSync(${q(pidFile)}, String(process.pid))\nsetTimeout(() => {}, 30_000)`)
      const proc = launch({ PATH: pathOf(bin, process.env['PATH'] ?? '') })
      expect(await pidIn(pidFile)).not.toBe(proc.pid)
      proc.kill('SIGTERM')
      expect(await proc.exited).toBe(143)
      expect(healthEntry('web-search')).toBeUndefined()
    })
  })

  test('the record keeps the doctor\'s findings, never replaces a doctor\'s down, and turns back into unknown when its time is up', async () => {
    await withSandbox(async () => {
      const now = Date.UTC(2026, 9, 10, 12, 0, 0)
      mkdirSync(paths.stateDir(), { recursive: true })
      writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, checked_at: '2026-10-10T08:00:00.000Z', mcp: { 'web-search': { status: 'ok', transport: 'stdio', tools: 2 }, context7: { status: 'down', error: 'handshake failed' } }, tools: { rg: { status: 'ok', checked_at: 'x' } } }))
      await recordLaunchFailure('web-search', 'the server exited with code 1', now)
      await recordLaunchFailure('context7', 'the server exited with code 1', now)
      const doc = JSON.parse(readFileSync(paths.healthFile(), 'utf8')) as { checked_at: string, mcp: Record<string, Record<string, unknown>>, tools: unknown }
      expect(doc.checked_at).toBe('2026-10-10T08:00:00.000Z')
      expect(doc.tools).toEqual({ rg: { status: 'ok', checked_at: 'x' } })
      expect(doc.mcp['web-search']).toEqual({ status: 'down', transport: 'stdio', tools: 2, error: 'the server exited with code 1', checked_at: new Date(now).toISOString(), until: new Date(now + LAUNCH_DOWN_TTL_MS).toISOString(), source: 'launch' })
      expect(doc.mcp['context7']).toEqual({ status: 'down', error: 'handshake failed' })
      await expireLaunchFailures(now + LAUNCH_DOWN_TTL_MS - 1)
      expect(healthEntry('web-search')?.['status']).toBe('down')
      await expireLaunchFailures(now + LAUNCH_DOWN_TTL_MS)
      expect(healthEntry('web-search')).toEqual({ status: 'unknown', transport: 'stdio', tools: 2, checked_at: new Date(now + LAUNCH_DOWN_TTL_MS).toISOString() })
      expect(healthEntry('context7')).toEqual({ status: 'down', error: 'handshake failed' })
      writeFileSync(paths.healthFile(), '{ broken')
      await recordLaunchFailure('web-search', 'x', now)
      expect(readFileSync(paths.healthFile(), 'utf8')).toBe('{ broken')
    })
  })
})

const CM_PROBE = `import { writeFileSync } from 'node:fs'
const keys = ['CONTEXT_MODE_DIR', 'CONTEXT_MODE_PROJECT_DIR', 'CONTEXT_MODE_MCP_SENTINEL_DIR', 'CONTEXT_MODE_PLATFORM', 'PWD', 'PATH', 'PI_CODING_AGENT_DIR', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CONFIG_DIR']
const env = Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]))
writeFileSync(process.env.CM_TEST_OUT, JSON.stringify({ bun: typeof Bun !== 'undefined', pid: process.pid, argv: process.argv.slice(1), cwd: process.cwd(), env }))
await Bun.stdin.text()
`

const NPX = Bun.which('npx')

const NPX_PROBE_BIN = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const keys = ['npm_config_ignore_scripts', 'npm_config_cache', 'npm_config_update_notifier', 'npm_config_fund', 'npm_config_call', 'npm_config_package', 'npm_config_yes', 'npm_lifecycle_event', 'CONTEXT_MODE_DIR']
writeFileSync(process.env.CM_TEST_OUT, JSON.stringify({ env: Object.fromEntries(keys.map(k => [k, process.env[k] ?? null])), argv: process.argv.slice(2) }))
process.stdin.setEncoding('utf8')
process.stdin.on('data', d => process.stdout.write('echo:' + d))
`

function installContextMode(root: string): string {
  const entry = join(root, 'tc', 'node_modules', 'context-mode', 'cli.bundle.mjs')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, CM_PROBE)
  updateToolchainState(s => {
    s.packages['npm:context-mode'] = { registry: 'npm', name: 'context-mode', version: '1.0.169', dir: join(root, 'tc'), bins: { 'context-mode': entry }, installed_at: 'x' }
  }, new Date(0).toISOString())
  return entry
}

function launchContextMode(cwd: string, env: Record<string, string>) {
  const base: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(base)) if (k.startsWith('CONTEXT_MODE_')) delete base[k]
  return Bun.spawn([process.execPath, MAIN, 'mcp', 'run', 'context-mode'], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...base, ...env } })
}

interface CmProbeReport { bun: boolean, pid: number, argv: string[], cwd: string, env: Record<string, string | null> }

describe('buracle mcp run context-mode', () => {
  test('the toolchain copy runs on Bun in the session folder, with the storage root of its harness and project', async () => {
    await withSandbox(async ({ root }) => {
      const entry = installContextMode(root)
      const project = join(root, 'work', 'app')
      const sub = join(project, 'pkg')
      mkdirSync(sub, { recursive: true })
      const arg0 = join(root, 'codex-home', 'tmp', 'arg0', 'codex-arg0Ab12')
      const cases: Array<{ label: string, cwd: string, env: Record<string, string>, root: string, projectDir: string | null, gone?: string }> = [
        { label: 'codex', cwd: project, env: { CONTEXT_MODE_PLATFORM: 'codex', PATH: pathOf(arg0, process.env['PATH'] ?? '') }, root: cmStorageRoot('codex', project), projectDir: project },
        { label: 'omp', cwd: project, env: { CONTEXT_MODE_PLATFORM: 'omp', PI_CODING_AGENT_DIR: join(root, 'agent') }, root: cmStorageRoot('omp', project), projectDir: project, gone: 'PI_CODING_AGENT_DIR' },
        { label: 'claude', cwd: sub, env: { CONTEXT_MODE_PLATFORM: 'claude-code', CLAUDE_PROJECT_DIR: project }, root: cmStorageRoot('claude', project), projectDir: null },
        { label: 'probe', cwd: project, env: {}, root: cmProbeRoot(), projectDir: project },
      ]
      for (const c of cases) {
        const out = join(root, `report-${c.label}.json`)
        const proc = launchContextMode(c.cwd, { ...c.env, CM_TEST_OUT: out })
        const report = JSON.parse(await textIn(out)) as CmProbeReport
        await proc.stdin.end()
        expect({ label: c.label, code: await proc.exited }).toEqual({ label: c.label, code: 0 })
        expect({ label: c.label, bun: report.bun, argv: report.argv, cwd: report.cwd }).toEqual({ label: c.label, bun: true, argv: [entry], cwd: c.cwd })
        // The launcher becomes the server where execve exists; on Windows the server is its child.
        if (IS_WINDOWS) expect(report.pid).not.toBe(proc.pid)
        else expect(report.pid).toBe(proc.pid)
        expect({ label: c.label, dir: report.env['CONTEXT_MODE_DIR'], project: report.env['CONTEXT_MODE_PROJECT_DIR'], sentinel: report.env['CONTEXT_MODE_MCP_SENTINEL_DIR'] })
          .toEqual({ label: c.label, dir: c.root, project: c.projectDir, sentinel: cmSentinelDir() })
        if (c.projectDir !== null) expect(report.env['PWD']).toBe(c.projectDir)
        if (c.gone !== undefined) expect(report.env[c.gone]).toBeNull()
        expect((report.env['PATH'] ?? '').split(delimiter)).not.toContain(arg0)
      }
      for (const h of ['codex', 'omp', 'claude'] as const) {
        expect(existsSync(cmSessionsDir(cmStorageRoot(h, project)))).toBe(true)
        if (KEEPS_MODES) expect(statSync(cmSessionsDir(cmStorageRoot(h, project))).mode & 0o777).toBe(0o700)
      }
      expect(existsSync(cmProbeRoot())).toBe(false)
    })
  })

  test('inherited storage variables (a user\'s export, or a harness started from a ctx_execute command) never move a harness\'s server away from the root its session bridge and status line read', async () => {
    await withSandbox(async ({ root }) => {
      installContextMode(root)
      const project = join(root, 'work', 'app')
      const sub = join(project, 'pkg')
      mkdirSync(sub, { recursive: true })
      const other = join(root, 'other')
      const inherited = { CONTEXT_MODE_DIR: join(other, 'store'), CONTEXT_MODE_PROJECT_DIR: other, PWD: other }
      const cases: Array<{ platform: string, h: 'claude' | 'codex' | 'opencode' | 'omp', cwd: string, extra: Record<string, string> }> = [
        { platform: 'codex', h: 'codex', cwd: project, extra: {} },
        { platform: 'opencode', h: 'opencode', cwd: project, extra: {} },
        { platform: 'omp', h: 'omp', cwd: project, extra: {} },
        { platform: 'claude-code', h: 'claude', cwd: sub, extra: { CLAUDE_PROJECT_DIR: project } },
      ]
      for (const c of cases) {
        const out = join(root, `report-${c.h}.json`)
        const proc = launchContextMode(c.cwd, { ...inherited, ...c.extra, CONTEXT_MODE_PLATFORM: c.platform, CM_TEST_OUT: out })
        const report = JSON.parse(await textIn(out)) as CmProbeReport
        await proc.stdin.end()
        expect({ h: c.h, code: await proc.exited }).toEqual({ h: c.h, code: 0 })
        expect({ h: c.h, dir: report.env['CONTEXT_MODE_DIR'] }).toEqual({ h: c.h, dir: cmStorageRoot(c.h, project) })
        if (c.h !== 'claude') expect({ h: c.h, project: report.env['CONTEXT_MODE_PROJECT_DIR'], pwd: report.env['PWD'] }).toEqual({ h: c.h, project, pwd: project })
        expect(existsSync(cmSessionsDir(cmStorageRoot(c.h, project)))).toBe(true)
        if (KEEPS_MODES) expect(statSync(cmSessionsDir(cmStorageRoot(c.h, project))).mode & 0o777).toBe(0o700)
      }
      expect(existsSync(other)).toBe(false)
    })
  }, 30_000)

  test("Claude Code's plugin registry names context-mode's own plugin in a folder that is gone: the server gets an empty Claude config folder, so it cannot link itself back there, and the log names the fix", async () => {
    await withSandbox(async ({ root, home }) => {
      installContextMode(root)
      const project = join(root, 'proj')
      mkdirSync(project, { recursive: true })
      const claude = join(home, '.claude')
      const cache = join(claude, 'plugins', 'cache', 'context-mode', 'context-mode')
      const registry = (installPath: string): void => {
        mkdirSync(join(claude, 'plugins'), { recursive: true })
        writeFileSync(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'context-mode@context-mode': [{ scope: 'user', installPath, version: '1.0.160' }] } }))
      }
      const empty = join(cmHome(), 'claude-config-empty')
      const configDir = async (label: string, env: Record<string, string>): Promise<string | null> => {
        const out = join(root, `report-${label}.json`)
        // Claude Code finds its config under USERPROFILE on Windows (os.homedir()), under HOME elsewhere.
        const proc = launchContextMode(project, { USERPROFILE: home, ...env, CM_TEST_OUT: out })
        const report = JSON.parse(await textIn(out)) as CmProbeReport
        await proc.stdin.end()
        expect({ label, code: await proc.exited }).toEqual({ label, code: 0 })
        return report.env['CLAUDE_CONFIG_DIR'] ?? null
      }
      const logged = (): string => existsSync(paths.logFile()) ? readFileSync(paths.logFile(), 'utf8') : ''
      expect(await configDir('none', { CONTEXT_MODE_PLATFORM: 'codex' })).toBeNull()
      mkdirSync(join(cache, '1.0.169'), { recursive: true })
      registry(join(cache, '1.0.169'))
      expect(await configDir('healthy', { CONTEXT_MODE_PLATFORM: 'codex' })).toBeNull()
      const userConfig = join(root, 'my-claude')
      expect(await configDir('healthy-own', { CONTEXT_MODE_PLATFORM: 'claude-code', CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: userConfig })).toBe(userConfig)
      expect(existsSync(empty)).toBe(false)
      expect(logged()).not.toContain('context-mode@context-mode')
      const gone = join(cache, '1.0.160')
      registry(gone)
      for (const platform of ['codex', 'opencode', 'omp', 'claude-code']) {
        expect({ platform, dir: await configDir(`stale-${platform}`, { CONTEXT_MODE_PLATFORM: platform, CLAUDE_PROJECT_DIR: project }) }).toEqual({ platform, dir: empty })
      }
      if (KEEPS_MODES) expect(statSync(empty).mode & 0o777).toBe(0o700)
      expect(readdirSync(empty)).toEqual([])
      expect(existsSync(gone)).toBe(false)
      expect(logged()).toContain('claude plugin uninstall context-mode@context-mode')
      expect(await configDir('stale-own', { CONTEXT_MODE_PLATFORM: 'codex', CLAUDE_CONFIG_DIR: userConfig })).toBe(userConfig)
      mkdirSync(join(userConfig, 'plugins'), { recursive: true })
      writeFileSync(join(userConfig, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'context-mode@context-mode': [{ installPath: join(userConfig, 'plugins', 'cache', 'context-mode', 'context-mode', '1.0.1') }] } }))
      rmSync(join(claude, 'plugins', 'installed_plugins.json'))
      expect(await configDir('stale-own-2', { CONTEXT_MODE_PLATFORM: 'codex', CLAUDE_CONFIG_DIR: userConfig })).toBe(empty)
    })
  }, 30_000)

  test('not in the toolchain yet: the npx fallback installs without lifecycle scripts and gets the same storage environment', async () => {
    await withSandbox(async ({ root }) => {
      const project = join(root, 'proj')
      mkdirSync(project, { recursive: true })
      const bin = join(root, 'bin')
      const argvFile = join(root, 'npx-argv.txt')
      const envFile = join(root, 'npx-env.txt')
      fakeExe(join(bin, 'npx'), `fs.writeFileSync(${q(argvFile)}, argv.join('\\n') + '\\n')\nfs.writeFileSync(${q(envFile)}, Object.entries(process.env).map(([k, v]) => k + '=' + v).join('\\n') + '\\n')`)
      const proc = launchContextMode(project, { CONTEXT_MODE_PLATFORM: 'opencode', PATH: pathOf(bin, process.env['PATH'] ?? '') })
      await proc.stdin.end()
      expect(await proc.exited).toBe(0)
      // npx runs its -c line in a shell: sh on POSIX, cmd.exe on Windows.
      const unset = ['npm_config_ignore_scripts', 'npm_config_cache', 'npm_config_update_notifier', 'npm_config_fund', 'npm_config_call', 'npm_config_package', 'npm_config_yes']
      const line = IS_WINDOWS ? `${unset.map(k => `set "${k}=" && `).join('')}context-mode` : `exec env ${unset.map(k => `-u ${k}`).join(' ')} context-mode`
      expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual(['--yes', '--package=context-mode@latest', '-c', line])
      const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      expect(env['npm_config_ignore_scripts']).toBe('true')
      expect(env['npm_config_cache']).toBe(fallbackNpmCache())
      expect(env['CONTEXT_MODE_DIR']).toBe(cmStorageRoot('opencode', project))
      expect(env['CONTEXT_MODE_PROJECT_DIR']).toBe(project)
    })
  })

  test.skipIf(NPX === null || process.platform === 'win32')('the npx fallback with the real npm: the install runs no lifecycle scripts, and the server gets none of the npm settings meant for that install (its sandbox would hand them to every npm command)', async () => {
    await withSandbox(async ({ root }) => {
      const project = join(root, 'proj')
      mkdirSync(project, { recursive: true })
      const pkg = join(root, 'probe-pkg')
      const marker = join(root, 'install-script-ran')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'context-mode', version: '0.0.1', bin: { 'context-mode': 'bin.js' }, scripts: { postinstall: `node -e "require('fs').writeFileSync(process.argv[1], 'ran')" "${marker}"` } }))
      writeFileSync(join(pkg, 'bin.js'), NPX_PROBE_BIN, { mode: 0o755 })
      const bin = join(root, 'bin')
      const argvFile = join(root, 'npx-argv.txt')
      script(bin, 'npx', `printf '%s\\n' "$@" > "${argvFile}"\nfor a do\n  shift\n  case $a in --package=context-mode@*) a="--package=file:${pkg}" ;; esac\n  set -- "$@" "$a"\ndone\nexec "${NPX}" "$@"\n`)
      const out = join(root, 'report.json')
      const proc = launchContextMode(project, {
        CONTEXT_MODE_PLATFORM: 'codex', CM_TEST_OUT: out, PATH: pathOf(bin, process.env['PATH'] ?? ''),
        npm_config_offline: 'true', npm_config_audit: 'false',
      })
      proc.stdin.write('ping\n')
      const report = JSON.parse(await textIn(out)) as { env: Record<string, string | null>, argv: string[] }
      await proc.stdin.end()
      expect(await proc.exited).toBe(0)
      expect(await new Response(proc.stdout).text()).toBe('echo:ping\n')
      expect(report.env).toEqual({ npm_config_ignore_scripts: null, npm_config_cache: null, npm_config_update_notifier: null, npm_config_fund: null, npm_config_call: null, npm_config_package: null, npm_config_yes: null, npm_lifecycle_event: 'npx', CONTEXT_MODE_DIR: cmStorageRoot('codex', project) })
      expect(report.argv).toEqual([])
      expect(existsSync(marker)).toBe(false)
      expect(readFileSync(argvFile, 'utf8').trim().split('\n').slice(0, 3)).toEqual(['--yes', '--package=context-mode@latest', '-c'])
      const control = Bun.spawnSync([NPX ?? 'npx', '--yes', `--package=file:${pkg}`, '-c', 'true'], {
        cwd: project, stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, npm_config_ignore_scripts: 'false', npm_config_cache: join(root, 'control-cache'), npm_config_offline: 'true', npm_config_audit: 'false', npm_config_update_notifier: 'false' },
      })
      expect(control.exitCode).toBe(0)
      expect(existsSync(marker)).toBe(true)
    })
  }, 60_000)

  test('a package whose bin is start.mjs never runs (it rewrites harness settings): a failed start', async () => {
    await withSandbox(async ({ root }) => {
      const out = join(root, 'report.json')
      const startMjs = join(root, 'tc', 'node_modules', 'context-mode', 'start.mjs')
      mkdirSync(dirname(startMjs), { recursive: true })
      writeFileSync(startMjs, CM_PROBE)
      updateToolchainState(s => {
        s.packages['npm:context-mode'] = { registry: 'npm', name: 'context-mode', version: '9.0.0', dir: join(root, 'tc'), bins: { 'context-mode': startMjs }, installed_at: 'x' }
      }, new Date(0).toISOString())
      const proc = launchContextMode(root, { CONTEXT_MODE_PLATFORM: 'codex', CM_TEST_OUT: out })
      await proc.stdin.end()
      expect(await proc.exited).toBe(1)
      expect(await new Response(proc.stderr).text()).toContain('starts through start.mjs')
      expect(existsSync(out)).toBe(false)
      expect(healthEntry('context-mode')).toMatchObject({ status: 'down', source: 'launch' })
      expect(startMjsRefusal('context-mode', ['/b/bun', '/x/cli.bundle.mjs'])).toBeUndefined()
      expect(startMjsRefusal('other', ['/b/node', '/x/start.mjs'])).toBeUndefined()
    })
  })

  test('contextMode.enabled: false serves a server without tools; nothing of the package is installed or run', async () => {
    await withSandbox(async ({ root, buracleHome }) => {
      mkdirSync(buracleHome, { recursive: true })
      writeFileSync(join(buracleHome, 'config.yaml'), 'contextMode:\n  enabled: false\n')
      const entry = installContextMode(root)
      const ran = join(root, 'report.json')
      const bin = join(root, 'bin')
      const npxRan = join(root, 'npx-ran')
      fakeExe(join(bin, 'npx'), `fs.writeFileSync(${q(npxRan)}, 'ran')`)
      const project = join(root, 'proj')
      mkdirSync(project, { recursive: true })
      const proc = launchContextMode(project, { CONTEXT_MODE_PLATFORM: 'claude-code', CLAUDE_PROJECT_DIR: project, CM_TEST_OUT: ran, PATH: pathOf(bin, process.env['PATH'] ?? '') })
      const messages = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.296' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        { jsonrpc: '2.0', id: 'p-1', method: 'ping' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ctx_execute', arguments: { language: 'shell', code: 'ls' } } },
        { jsonrpc: '2.0', id: 9, result: {} },
      ]
      proc.stdin.write(messages.map(m => JSON.stringify(m)).join('\n') + '\nnot json\n')
      await proc.stdin.end()
      expect(await proc.exited).toBe(0)
      const replies = (await new Response(proc.stdout).text()).trim().split('\n').map(l => JSON.parse(l) as unknown)
      expect(replies).toEqual([
        { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'context-mode', version: 'disabled' } } },
        { jsonrpc: '2.0', id: 2, result: { tools: [] } },
        { jsonrpc: '2.0', id: 'p-1', result: {} },
        { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'Method not found: tools/call' } },
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      ])
      expect(existsSync(ran)).toBe(false)
      expect(existsSync(npxRan)).toBe(false)
      expect(existsSync(cmHome())).toBe(false)
      expect(healthEntry('context-mode')).toBeUndefined()
      expect(existsSync(entry)).toBe(true)
      const io = memoryIO({ json: true })
      expect(await mcpRun(['list', '--json'], io)).toBe(0)
      const row = (JSON.parse(io.out()) as { servers: Array<{ id: string, source: string }> }).servers.find(s => s.id === 'context-mode')
      expect(row?.source).toBe('disabled')
    })
  })
})

describe('the server without tools (stub)', () => {
  test('initialize offers 2025-06-18 when the client names no revision; batches, notifications and responses', () => {
    expect(stubReply({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }, 'context-mode')).toEqual({ jsonrpc: '2.0', id: 0, result: { protocolVersion: STUB_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'context-mode', version: 'disabled' } } })
    expect(STUB_PROTOCOL_VERSION).toBe('2025-06-18')
    expect(stubReply({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 7 } }, 'x')).toMatchObject({ result: { protocolVersion: '2025-06-18' } })
    expect(stubReply([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }, { jsonrpc: '2.0', id: 2, method: 'resources/list' }], 'x')).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'Method not found: resources/list' } },
    ])
    expect(stubReply({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'x')).toBeUndefined()
    expect(stubReply([{ jsonrpc: '2.0', method: 'notifications/initialized' }], 'x')).toBeUndefined()
    expect(stubReply({ jsonrpc: '2.0', id: 4, result: { ok: true } }, 'x')).toBeUndefined()
    expect(stubReply({ jsonrpc: '2.0', id: null, method: 'ping' }, 'x')).toBeUndefined()
    expect(stubReply({ jsonrpc: '2.0', id: 5 }, 'x')).toEqual({ jsonrpc: '2.0', id: 5, error: { code: -32600, message: 'Invalid Request' } })
    expect(stubReplyLine('   ', 'x')).toBeUndefined()
    expect(stubReplyLine('{"jsonrpc":"2.0","id":6,"method":"tools/list"}', 'x')).toBe('{"jsonrpc":"2.0","id":6,"result":{"tools":[]}}')
  })

  test('serves until its input ends, also a last line without a newline', async () => {
    const lines: string[] = []
    async function* input(): AsyncIterable<string> {
      yield '{"jsonrpc":"2.0","id":1,"method":"pi'
      yield 'ng"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
    }
    expect(await runStubServer({ name: 'context-mode', write: l => { lines.push(l) }, input: input() })).toBe(0)
    expect(lines).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}\n', '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n'])
  })
})

describe('buracle mcp install', () => {
  function item(status: ToolchainItem['status'], detail = ''): ToolchainItem {
    return { id: 'mcp:context7', group: 'mcp', label: 'context7', required: true, status, detail }
  }

  test('the background install of `mcp run` starts `buracle mcp install <id>`, a command the router knows', () => {
    const argv = backgroundInstallArgv(MAIN, 'context7')
    expect(argv.slice(1)).toEqual([MAIN, 'mcp', 'install', 'context7'])
    expect(COMMANDS.map(([n]) => n)).toContain(argv[2] ?? '')
  })

  test('installs that one server through the toolchain, quietly', () => withSandbox(() => withEnv({ BURACLE_NO_TOOLCHAIN: undefined }, async () => {
    const calls: ToolchainOptions[] = []
    const io = memoryIO()
    await withDeps({ runToolchain: async (_b, o) => { calls.push(o); return { items: [item('installed')], state: emptyToolchainState(), changed: true } } }, async () => {
      expect(await mcpRun(['install', 'context7'], io)).toBe(0)
    })
    expect(calls.map(c => ({ install: c.install, only: c.only }))).toEqual([{ install: true, only: ['mcp:context7'] }])
    expect(io.out() + io.err()).toBe('')
  })))

  test('a failed install exits 2 with the reason; an unknown id exits 1; BURACLE_NO_TOOLCHAIN=1 installs nothing', () => withSandbox(() => withEnv({ BURACLE_NO_TOOLCHAIN: undefined }, async () => {
    let runs = 0
    await withDeps({ runToolchain: async () => { runs++; return { items: [item('failed', 'npm exited with 1')], state: emptyToolchainState(), changed: false } } }, async () => {
      const failed = memoryIO()
      expect(await mcpRun(['install', 'context7'], failed)).toBe(2)
      expect(failed.err()).toBe('buracle mcp install: context7: npm exited with 1\n')
      const unknown = memoryIO()
      expect(await mcpRun(['install', 'nope'], unknown)).toBe(1)
      expect(unknown.err()).toContain("'nope' is not a package server")
      await withEnv({ BURACLE_NO_TOOLCHAIN: '1' }, async () => {
        expect(await mcpRun(['install', 'context7'], memoryIO())).toBe(0)
      })
    })
    expect(runs).toBe(1)
  })))
})

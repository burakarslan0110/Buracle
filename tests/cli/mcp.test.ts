import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { backgroundInstallArgv, CODEGRAPH_GATE_MS, codegraphGate, expireLaunchFailures, LAUNCH_DOWN_TTL_MS, recordLaunchFailure, run as mcpRun } from '../../src/cli/commands/mcp'
import { defaultConfig } from '../../src/core/config'
import { classifyTool } from '../../src/core/events'
import { harnessMcpToolName, mcpHealthOf, routeTool, type RoutingPolicy } from '../../src/core/policy/routing'
import { loadCanonicalSync } from '../../src/engine/canonical'
import * as paths from '../../src/engine/paths'
import { emptyToolchainState, updateToolchainState } from '../../src/engine/toolchain/state'
import type { ToolchainItem, ToolchainOptions } from '../../src/engine/toolchain/index'
import { COMMANDS } from '../../src/cli/router'
import { indexLockFile } from '../../src/workflow/workspace'
import { fakeExe, IS_WINDOWS, pathOf } from '../helpers/fake-exe'
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

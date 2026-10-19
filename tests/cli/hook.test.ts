import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAdapter, type Adapter, type AdapterContext } from '../../src/adapters/registry'
import { createContext, dispatchHook, loadAdapter, run } from '../../src/cli/commands/hook'
import { HARNESSES } from '../../src/core/events'
import type { CommandIO } from '../../src/cli/router'
import type { Harness } from '../../src/core/events'
import * as paths from '../../src/engine/paths'
import { withSandbox } from '../helpers/sandbox'

function fakeAdapter(hook?: Adapter['hook']): Adapter {
  const a: Adapter = {
    harness: 'codex',
    detect: async () => ({ installed: false }),
    build: async () => [],
    installPlan: async () => ({ id: 'x', harness: 'codex', ops: [] }),
    doctor: async () => [],
  }
  if (hook) a.hook = hook
  return a
}

const ctx = {} as AdapterContext
const deps = (adapter: Adapter, timeoutMs?: number) => ({ loadAdapter: async (_h: Harness) => adapter, loadContext: () => ctx, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })

function logLines(buracleHome: string): Array<Record<string, unknown>> {
  const f = join(buracleHome, 'logs', 'buracle.log')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
}

function io(stdin: string): CommandIO & { out(): string, err(): string } {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: false, text: async () => stdin },
    flags: { json: false, verbose: false },
    out: () => out,
    err: () => err,
  }
}

describe('dispatchHook', () => {
  test('passes event and stdin through and returns the adapter result', () => withSandbox(async () => {
    let seen: unknown[] = []
    const a = fakeAdapter(async (event, stdin, c) => { seen = [event, stdin, c]; return { stdout: '{"decision":"block"}', exitCode: 0 } })
    expect(await dispatchHook('codex', 'Stop', '{"session_id":"s"}', deps(a))).toEqual({ stdout: '{"decision":"block"}', exitCode: 0 })
    expect(seen).toEqual(['Stop', '{"session_id":"s"}', ctx])
  }))

  test('adapters without a hook are a silent no-op', () => withSandbox(async ({ buracleHome }) => {
    expect(await dispatchHook('codex', 'Stop', '', deps(fakeAdapter()))).toEqual({ stdout: '', exitCode: 0 })
    expect(logLines(buracleHome)).toEqual([])
  }))

  test('internal errors fail open and are logged (never to stdout)', () => withSandbox(async ({ buracleHome }) => {
    const a = fakeAdapter(async () => { throw new Error('kaboom') })
    expect(await dispatchHook('codex', 'Stop', '{}', deps(a))).toEqual({ stdout: '', exitCode: 0 })
    const lines = logLines(buracleHome)
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'hook handler failed', data: { harness: 'codex', event: 'Stop', result: 'fail-open', error: { message: 'kaboom' } } })
  }))

  test('internal errors of a guard event (PreToolUse) deny the call and are logged as fail-closed', () => withSandbox(async ({ buracleHome }) => {
    const a = fakeAdapter(async () => { throw new Error('kaboom') })
    const r = await dispatchHook('codex', 'PreToolUse', '{}', deps(a))
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string, permissionDecisionReason: string } }
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('kaboom')
    expect(logLines(buracleHome)[0]).toMatchObject({ level: 'error', msg: 'hook handler failed', data: { harness: 'codex', event: 'PreToolUse', result: 'fail-closed' } })
  }))

  test('an adapter can choose its own failure result', () => withSandbox(async () => {
    const a = fakeAdapter(async () => { throw Object.assign(new Error('guard broke'), { hookResult: { stdout: '{"permissionDecision":"deny"}', exitCode: 2 } }) })
    expect(await dispatchHook('codex', 'PreToolUse', '{}', deps(a))).toEqual({ stdout: '{"permissionDecision":"deny"}', exitCode: 2 })
  }))

  test('invalid results and context failures fail open', () => withSandbox(async () => {
    const bad = fakeAdapter(async () => ({ stdout: 42, exitCode: 'x' }) as unknown as { stdout: string, exitCode: number })
    expect(await dispatchHook('codex', 'Stop', '', deps(bad))).toEqual({ stdout: '', exitCode: 0 })
    const a = fakeAdapter(async () => ({ stdout: 'x', exitCode: 0 }))
    expect(await dispatchHook('codex', 'Stop', '', { loadAdapter: () => a, loadContext: () => { throw new Error('no config') } })).toEqual({ stdout: '', exitCode: 0 })
    expect(await dispatchHook('codex', 'Stop', '', { loadAdapter: async () => { throw new Error('import failed') }, loadContext: () => ctx })).toEqual({ stdout: '', exitCode: 0 })
  }))

  test('the lazy loader returns the registered adapters', async () => {
    for (const h of HARNESSES) expect(await loadAdapter(h)).toBe(getAdapter(h))
  })

  test('stray stdout output from a handler goes to the log; console and stdout are restored', () => withSandbox(async ({ buracleHome }) => {
    const originalLog = console.log
    const originalWrite = process.stdout.write
    const a = fakeAdapter(async () => {
      console.log('noise', { n: 1 })
      process.stdout.write('raw')
      return { stdout: '{"decision":"approve"}', exitCode: 0 }
    })
    expect(await dispatchHook('codex', 'PreToolUse', '{}', deps(a))).toEqual({ stdout: '{"decision":"approve"}', exitCode: 0 })
    await Bun.sleep(0)
    expect(console.log).toBe(originalLog)
    expect(process.stdout.write).toBe(originalWrite)
    const diverted = logLines(buracleHome).filter(l => l['msg'] === 'hook output to stdout was diverted to the log').map(l => (l['data'] as { text: string }).text)
    expect(diverted).toEqual([`noise ${Bun.inspect({ n: 1 })}`, 'raw'])
  }))

  test('a slow handler fails open after the timeout', () => withSandbox(async () => {
    const a = fakeAdapter(() => new Promise(res => setTimeout(() => res({ stdout: 'late', exitCode: 0 }), 2000)))
    const t0 = Date.now()
    expect(await dispatchHook('codex', 'Stop', '', deps(a, 50))).toEqual({ stdout: '', exitCode: 0 })
    expect(Date.now() - t0).toBeLessThan(1000)
  }))
})

describe('buracle hook', () => {
  test('usage errors exit 1', async () => {
    const a = io('')
    expect(await run([], a)).toBe(1)
    expect(a.err()).toContain('Usage: buracle hook <harness> <event>')
    const b = io('')
    expect(await run(['cursor', 'Stop'], b)).toBe(1)
    expect(b.err()).toContain("unknown harness 'cursor'")
    expect(await run(['codex', 'Stop', 'extra'], io(''))).toBe(1)
  })

  test('registered stub adapters have no hook yet: exit 0, empty stdout, no writes', () => withSandbox(async ({ buracleHome }) => {
    for (const h of ['claude', 'codex', 'opencode', 'omp']) {
      const x = io('{"session_id":"abc"}')
      expect(await run([h, 'Stop'], x)).toBe(0)
      expect(x.out()).toBe('')
    }
    expect(existsSync(buracleHome)).toBe(false)
  }))
})

describe('createContext', () => {
  test('loads the live config and the canonical bundle lazily', () => withSandbox(async ({ buracleHome }) => {
    const c = createContext()
    expect(c.repoRoot).toBe(paths.repoRoot())
    expect(c.buracleBin).toBe(join(buracleHome, 'bin', process.platform === 'win32' ? 'buracle.cmd' : 'buracle'))
    expect(c.config.version).toBe(1)
    expect(c.paths.buracleHome()).toBe(buracleHome)
    expect(Object.keys(c.canonical.mcp.servers)).toContain('context7')
    expect(c.canonical).toBe(c.canonical)
  }))

  test('a config.yaml problem is logged at warn level (above the default info threshold)', () => withSandbox(async ({ buracleHome }) => {
    mkdirSync(buracleHome, { recursive: true })
    writeFileSync(join(buracleHome, 'config.yaml'), 'routing: [unclosed\n')
    const c = createContext()
    expect(c.config.version).toBe(1)
    const line = logLines(buracleHome).find(l => String(l['msg']).startsWith('hook: configuration problems'))
    expect(line).toMatchObject({ level: 'warn' })
  }))
})

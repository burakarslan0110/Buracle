import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { devContext } from '../../../src/adapters/omp/dev-build'
import { AGENTS_BLOCK_ID, piAgentsBlock } from '../../../src/adapters/pi/build'
import { piGeneratedData } from '../../../src/adapters/pi/generated'
import { adapter, uninstallPlan } from '../../../src/adapters/pi/index'
import { piAgentsFile } from '../../../src/adapters/pi/install'
import { PI_UTILITY_COMMANDS, registerPiCommands, type PiCommandHost } from '../../../src/adapters/pi/runtime/commands'
import type { PiContext, PiExtensionAPI } from '../../../src/adapters/pi/runtime/types'
import { piArgv } from '../../../src/workflow/companion-hosts'
import { companionHost } from '../../../src/workflow/companion-hosts'
import { harnessProfile } from '../../../src/core/harness/index'
import * as paths from '../../../src/engine/paths'
import { applyPlans, readLedger } from '../../../src/engine/txn'
import { withSandbox } from '../../helpers/sandbox'

const ctx = () => devContext(paths.repoRoot())
const dir = () => paths.piAgentDir()

describe('Pi rules: the AGENTS.md block', () => {
  test('it holds every always rule, the command line and the path rule pointer', () => {
    const c = ctx().canonical
    const block = piAgentsBlock(c, '~/.buracle/rules/paths')
    for (const r of c.rules.filter(r => r.scope === 'always')) expect(block).toContain(r.body.trim().split('\n')[0] as string)
    expect(block).toContain('`/remember <text>`')
    expect(block).toContain('# Path-scoped rules')
    expect(block).toContain('~/.buracle/rules/paths')
    expect(block).not.toContain('{{')
  })

  test('install keeps the user\'s own AGENTS.md text; uninstall removes only the block', () => withSandbox(async () => {
    mkdirSync(dir(), { recursive: true })
    writeFileSync(piAgentsFile(dir()), '# My rules\n\nBe kind.\n')
    const c = ctx()
    await applyPlans([await adapter.installPlan(c)])
    const text = readFileSync(piAgentsFile(dir()), 'utf8')
    expect(text).toContain('# My rules\n\nBe kind.')
    expect(text).toContain('Managed by Buracle Stack')
    expect(Object.keys(await readLedger()).some(k => k.includes(`#md:${AGENTS_BLOCK_ID}`))).toBe(true)
    await applyPlans([await uninstallPlan(c)])
    const after = readFileSync(piAgentsFile(dir()), 'utf8')
    expect(after).toContain('Be kind.')
    expect(after).not.toContain('Managed by Buracle Stack')
  }))

  test('an AGENTS.md that Buracle Stack created is removed with its block', () => withSandbox(async () => {
    const c = ctx()
    await applyPlans([await adapter.installPlan(c)])
    expect(existsSync(piAgentsFile(dir()))).toBe(true)
    await applyPlans([await uninstallPlan(c)])
    expect(existsSync(piAgentsFile(dir()))).toBe(false)
  }))
})

describe('Pi: no review agents, path rules reach the extension', () => {
  test('Pi has no review agent file: only the extension, mcp.json and AGENTS.md are written', () => withSandbox(async () => {
    const plan = await adapter.installPlan(ctx())
    const files = plan.ops.map(o => (o as { path: string }).path)
    expect(files.some(f => /agents?\//.test(f.replace(dir(), '')))).toBe(false)
    expect(files.length).toBe(3)
  }))

  test('the generated data carries the path rule index', () => {
    const data = piGeneratedData(ctx().canonical, '0.0.0')
    expect(data.pathRules?.length).toBeGreaterThan(0)
    expect(data.pathRules?.every(r => typeof r.id === 'string')).toBe(true)
  })
})

function fakeHost(over: Partial<PiCommandHost> = {}): { host: PiCommandHost, calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    host: {
      cli: () => ['buracle'],
      run: async argv => { calls.push(argv); return { code: 0, stdout: JSON.stringify({ id: 'n1', url: 'http://x', started: true }), stderr: '', timedOut: false } },
      report: () => undefined,
      ...over,
    },
  }
}

function commandsOf(host: PiCommandHost): Map<string, (args: string, c: PiContext) => unknown> {
  const map = new Map<string, (args: string, c: PiContext) => unknown>()
  const pi = { on: () => undefined, sendMessage: () => undefined, registerCommand: (n: string, o: { handler: (a: string, c: PiContext) => unknown }) => { map.set(n, o.handler) } } as unknown as PiExtensionAPI
  expect(registerPiCommands(pi, host)).toBe(true)
  return map
}

function notes() {
  const out: Array<{ m: string, t?: string }> = []
  const c = { cwd: '/w', ui: { notify: (m: string, t?: string) => { out.push(t === undefined ? { m } : { m, t }) } } } as unknown as PiContext
  return { out, c }
}

describe('Pi commands', () => {
  test('/remember and /brain are registered; a host without registerCommand gets none', () => {
    const { host } = fakeHost()
    expect([...commandsOf(host).keys()]).toEqual([...PI_UTILITY_COMMANDS])
    expect(registerPiCommands({ on: () => undefined, sendMessage: () => undefined } as unknown as PiExtensionAPI, host)).toBe(false)
  })

  test('/remember runs `buracle mem remember` with the text after `--`, and tells the id', async () => {
    const { host, calls } = fakeHost()
    const { out, c } = notes()
    await commandsOf(host).get('remember')?.('use bun --watch', c)
    expect(calls[0]).toEqual(['buracle', 'mem', 'remember', '--json', '--', 'use bun --watch'])
    expect(out[0]).toEqual({ m: 'Remembered: n1', t: 'info' })
  })

  test('/remember without text and a missing CLI are reported, not run', async () => {
    const { host, calls } = fakeHost({ cli: () => undefined })
    const a = notes()
    await commandsOf(host).get('remember')?.('  ', a.c)
    expect(a.out[0]?.t).toBe('warning')
    await commandsOf(host).get('remember')?.('x', a.c)
    expect(a.out[1]?.t).toBe('error')
    expect(calls).toEqual([])
  })

  test('/brain opens the memory UI; `review` opens the review page; anything else is a usage note', async () => {
    const { host, calls } = fakeHost()
    const { out, c } = notes()
    const brain = commandsOf(host).get('brain')
    await brain?.('', c)
    expect(calls[0]).toEqual(['buracle', 'mem', 'ui', '--open', '--json'])
    expect(out[0]?.m).toBe('Memory UI: http://x (started)')
    await brain?.('nonsense', c)
    expect(out[1]?.t).toBe('warning')
    expect(calls.length).toBe(1)
  })

  test('a failing CLI is an error note, and a handler that throws is reported, never raised', async () => {
    const reported: string[] = []
    const { host } = fakeHost({ run: async () => { throw new Error('boom') }, report: w => { reported.push(w) } })
    const { c } = notes()
    await commandsOf(host).get('remember')?.('x', c)
    expect(reported).toEqual(['/remember'])
    const failed = fakeHost({ run: async () => ({ code: 2, stdout: '', stderr: 'bad', timedOut: false }) })
    const n = notes()
    await commandsOf(failed.host).get('brain')?.('', n.c)
    expect(n.out[0]?.m).toContain('failed (exit 2): bad')
  })
})

describe('Pi second opinion', () => {
  test('the profile no longer waits, and the run is a read-only print-mode run with the prompt on stdin', () => {
    expect(harnessProfile('pi').companionPending).toBeUndefined()
    const run = companionHost('pi').prepare({ prompt: 'REVIEW', repo: '/repo', outDir: '/o', timeoutMs: 1000, agent: ctx().canonical.agents[0] as never })
    expect(run.argv).toEqual(piArgv())
    expect(run.argv.slice(0, 2)).toEqual(['pi', '-p'])
    expect(run.argv[run.argv.indexOf('--tools') + 1]).toBe('read,grep,find,ls')
    for (const flag of ['--no-extensions', '--no-mcp', '--no-session']) expect(run.argv).toContain(flag)
    expect(run.argv).not.toContain('bash')
    expect(run.cwd).toBe('/repo')
    expect(run.stdin).toBe('REVIEW')
  })
})

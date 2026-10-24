import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, type ExtensionDeps } from '../../../src/adapters/omp/runtime/extension'
import type { OmpGenerated } from '../../../src/adapters/omp/runtime/types'
import { defaultConfig } from '../../../src/core/config'
import { flowStart } from '../../../src/core/flow/record'
import { detectIntent, isGuardContinuation } from '../../../src/core/policy/intents'
import { writeFlow } from '../../../src/workflow/flow'
import { withSandbox, type Sandbox } from '../../helpers/sandbox'
import { fakeCtx, fakePi, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4d'

function generated(): OmpGenerated {
  const config = defaultConfig()
  config.checkers.enabled = false
  return testGenerated({ config })
}

function setup(sb: Sandbox, overrides: Partial<ExtensionDeps> = {}, mode: 'tui' | 'print' = 'tui') {
  const cwd = join(sb.root, 'work')
  mkdirSync(cwd, { recursive: true })
  const clock = { now: 1_791_400_000_000 }
  const desktop: string[] = []
  const policy = { ...testDeps().deps.policy!, checkBash: () => ({}), checkWrite: () => ({}), routeTool: () => ({ action: 'allow' as const }), capabilityCard: () => '', checkQuestion: () => ({}), detectIntent, isGuardContinuation }
  const t = testDeps({ policy, now: () => clock.now, notifyDesktop: (title, message) => { desktop.push(`${title}: ${message}`) }, ...overrides })
  const fp = fakePi({ thinking: 'high' })
  createBuracleExtension(generated(), t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID, mode })
  ctx.isIdle = () => true
  return { ...t, fp, ctx, cwd, clock, desktop }
}

const notices = (ctx: ReturnType<typeof fakeCtx>) => ctx.uiCalls.filter(c => c.method === 'notify').map(c => c.args[0] as string)
const stop = (text: string) => ({ type: 'session_stop', turn_id: 1, session_id: SID, stop_hook_active: false, last_assistant_message: { role: 'assistant', content: [{ type: 'text', text }] } })
const bash = (command: string, exitCode: number, id: string) => ({ type: 'tool_result', toolCallId: id, toolName: 'bash', input: { command }, content: [{ type: 'text', text: '' }], isError: exitCode !== 0, details: { exitCode } })

describe('omp turn receipt, loop alarms, the long-turn notification and the resume hint (PARITY-3)', () => {
  test('an unverified edit is a warning notice at the session_stop that ends the turn; a check after it silences it', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb)
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 2\n')
    await fp.emit('input', { type: 'input', text: 'change a', source: 'interactive' }, ctx)
    await fp.emit('tool_result', { type: 'tool_result', toolCallId: 'e1', toolName: 'edit', input: { path: join(cwd, 'a.ts'), old_string: 'export const a = 1', new_string: 'export const a = 2' }, content: [{ type: 'text', text: 'ok' }], isError: false }, ctx)
    expect(await fp.emit('session_stop', stop('It works now.'), ctx)).toBeUndefined()
    expect(notices(ctx)).toContain('Buracle · 1 file (+1 −1) · ⚠ success claimed without evidence: no test or check ran after the change')
    const before = notices(ctx).length
    await fp.emit('input', { type: 'input', text: 'again', source: 'interactive' }, ctx)
    await fp.emit('tool_result', { type: 'tool_result', toolCallId: 'e2', toolName: 'write', input: { path: join(cwd, 'b.ts'), content: 'export const b = 1\n' }, content: [{ type: 'text', text: 'ok' }], isError: false }, ctx)
    await fp.emit('tool_result', bash('bun test', 0, 'b1'), ctx)
    await fp.emit('session_stop', stop('Tests pass.'), ctx)
    expect(notices(ctx).length).toBe(before)
  }))

  test('the third identical failing command is a warning notice; a subagent\'s commands are not counted', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb)
    const sub = fakeCtx({ cwd, sid: SID, kind: 'sub' })
    for (const id of ['s1', 's2', 's3']) await fp.emit('tool_result', bash('bun test', 1, id), sub)
    for (const id of ['f1', 'f2', 'f3']) await fp.emit('tool_result', bash('bun test', 1, id), ctx)
    expect(notices(ctx).filter(n => n.includes('failed 3 times in a row'))).toEqual(['Buracle: the same command failed 3 times in a row: `bun test` (do not run it again as is; read the output and change your hypothesis)'])
    expect(sub.uiCalls.filter(c => c.method === 'notify')).toEqual([])
  }))

  test('a turn longer than workflow.notifyAfterSec sends a desktop notification in the TUI; print mode never does', () => withSandbox(async sb => {
    const { fp, ctx, clock, desktop } = setup(sb)
    await fp.emit('input', { type: 'input', text: 'long work', source: 'interactive' }, ctx)
    clock.now += 125_000
    await fp.emit('session_stop', stop('Summary.'), ctx)
    expect(desktop).toEqual(['Buracle: Turn finished after 2 min'])
    const print = setup(sb, {}, 'print')
    await print.fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'long work', systemPrompt: [] }, print.ctx)
    print.clock.now += 600_000
    await print.fp.emit('session_stop', stop('Summary.'), print.ctx)
    expect(print.desktop).toEqual([])
  }))

  test('a resumed session with an unfinished run gets one notice that suggests continuing it', () => withSandbox(async sb => {
    const { fp, ctx, clock } = setup(sb)
    writeFlow('omp', SID, flowStart(undefined, { workflow: 'plan-build', title: 'Add login', source: 'command' }, clock.now - 60_000).record)
    await fp.emit('session_switch', { type: 'session_switch', reason: 'resume' }, ctx)
    expect(notices(ctx).filter(n => n.startsWith('This session has an unfinished workflow run'))).toEqual(['This session has an unfinished workflow run (plan-build (Add login)). To go on, say: continue the plan-build run: Add login'])
    await fp.emit('session_switch', { type: 'session_switch', reason: 'new' }, ctx)
    expect(notices(ctx).filter(n => n.startsWith('This session has an unfinished workflow run'))).toHaveLength(1)
  }))

  test('workflow.band false turns the resume hint off, as on Claude Code and Codex', () => withSandbox(async sb => {
    const off = defaultConfig()
    off.checkers.enabled = false
    off.workflow.band = false
    const { fp, ctx, clock } = setup(sb, { config: () => ({ config: off, vault: join(sb.root, 'vault'), shim: '/shim', source: 'defaults' }) })
    writeFlow('omp', SID, flowStart(undefined, { workflow: 'plan-build', title: 'Add login', source: 'command' }, clock.now - 60_000).record)
    await fp.emit('session_switch', { type: 'session_switch', reason: 'resume' }, ctx)
    expect(notices(ctx).filter(n => n.startsWith('This session has an unfinished workflow run'))).toEqual([])
  }))
})

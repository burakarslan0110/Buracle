import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, type ExtensionDeps } from '../../../src/adapters/omp/runtime/extension'
import { PROMPT_MESSAGE_TYPE } from '../../../src/adapters/omp/runtime/prompt'
import { CONTEXT_WARNING_TYPE, NOTICE_MESSAGE_TYPE } from '../../../src/adapters/omp/runtime/session-notes'
import type { OmpGenerated } from '../../../src/adapters/omp/runtime/types'
import { compactInstructions, restoreContext } from '../../../src/core/compact'
import { emptyState } from '../../../src/core/plan/state'
import { detectIntent, isGuardContinuation } from '../../../src/core/policy/intents'
import { contextWarning } from '../../../src/core/status/context'
import { saveState } from '../../../src/workflow/session-store'
import { withEnv, withSandbox, type Sandbox } from '../../helpers/sandbox'
import { fakeCtx, fakeMemory, fakePi, testDeps, testGenerated, type FakeCtx } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4c'

function setup(sb: Sandbox, overrides: Partial<ExtensionDeps> = {}, data: OmpGenerated = testGenerated()) {
  const cwd = join(sb.root, 'work')
  mkdirSync(cwd, { recursive: true })
  const policy = { ...testDeps().deps.policy!, checkBash: () => ({}), checkWrite: () => ({}), routeTool: () => ({ action: 'allow' as const }), capabilityCard: () => '', checkQuestion: () => ({}), detectIntent, isGuardContinuation }
  const t = testDeps({ policy, ...overrides })
  const fp = fakePi({ thinking: 'high' })
  createBuracleExtension(data, t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID })
  return { ...t, fp, ctx }
}

async function hidden(fp: ReturnType<typeof fakePi>, ctx: FakeCtx, prompt: string): Promise<string | undefined> {
  const r = await fp.emit('before_agent_start', { type: 'before_agent_start', prompt, systemPrompt: [] }, ctx) as { message?: { customType: string, content: string } } | undefined
  if (r?.message !== undefined) expect(r.message.customType).toBe(PROMPT_MESSAGE_TYPE)
  return r?.message?.content
}

const turnEnd = (stopReason: string, tools = 1) => ({ type: 'turn_end', turnIndex: 1, message: { role: 'assistant', stopReason, content: [] }, toolResults: Array.from({ length: tools }, (_, i) => ({ role: 'toolResult', toolCallId: `t${i}` })) })

describe('omp H05 mid-turn: the warning reaches the model inside the running turn', () => {
  test('a turn that goes on with tool results gets one hidden aside message per band, and the next prompt does not repeat it', () => withSandbox(async sb => {
    let pct = 50
    const { fp, ctx } = setup(sb)
    ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 100, percent: pct })
    await fp.emit('turn_end', turnEnd('toolUse'), ctx)
    expect(fp.sent).toEqual([])
    pct = 90
    await fp.emit('turn_end', turnEnd('toolUse'), ctx)
    const warn = contextWarning('warn', undefined) as string
    expect(fp.sent).toEqual([{ message: { customType: CONTEXT_WARNING_TYPE, content: warn, display: false }, options: { deliverAs: 'aside' } }])
    expect(ctx.uiCalls.filter(c => c.method === 'notify')).toEqual([{ method: 'notify', args: [warn, 'warning'] }])
    await fp.emit('turn_end', turnEnd('toolUse'), ctx)
    expect(fp.sent.length).toBe(1)
    await fp.emit('input', { type: 'input', text: 'keep going on the parser', source: 'interactive' }, ctx)
    expect(await hidden(fp, ctx, 'x') ?? '').not.toContain(warn)
  }))

  test('the last turn of a run (no tool results, or an aborted one) sends nothing: the warning goes with the next prompt', () => withSandbox(async sb => {
    let pct = 50
    const { fp, ctx } = setup(sb)
    ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 100, percent: pct })
    pct = 90
    await fp.emit('turn_end', turnEnd('stop', 0), ctx)
    pct = 97
    await fp.emit('turn_end', turnEnd('aborted'), ctx)
    expect(fp.sent).toEqual([])
    await fp.emit('input', { type: 'input', text: 'keep going on the parser', source: 'interactive' }, ctx)
    expect(await hidden(fp, ctx, 'x')).toContain(contextWarning('critical', undefined) as string)
  }))
})

describe('omp H17 one-time notices', () => {
  test('the first session start sends the model line as a hidden next-turn message and a TUI notice; the next load gets nothing', () => withSandbox(async sb => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    const data = testGenerated({ buracleVersion: '0.5.0', notices: [{ id: 'omp-test', since: '0.5.0', message: 'A notice for omp.' }] })
    const first = setup(sb, {}, data)
    await first.fp.emit('session_start', { type: 'session_start' }, first.ctx)
    expect(first.fp.sent.filter(s => s.message.customType === NOTICE_MESSAGE_TYPE)).toEqual([{ message: { customType: NOTICE_MESSAGE_TYPE, content: expect.stringContaining('- A notice for omp.') as unknown as string, display: false }, options: { deliverAs: 'nextTurn' } }])
    expect(first.ctx.uiCalls).toContainEqual({ method: 'notify', args: ['Buracle 0.5.0: A notice for omp.', 'info'] })
    const second = setup(sb, {}, data)
    await second.fp.emit('session_start', { type: 'session_start' }, second.ctx)
    expect(second.fp.sent.filter(s => s.message.customType === NOTICE_MESSAGE_TYPE)).toEqual([])
  })))

  test('a resumed, switched or branched session claims no notice; a later fresh start still gets it', () => withSandbox(async sb => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    const data = testGenerated({ buracleVersion: '0.5.0', notices: [{ id: 'omp-resume', since: '0.5.0', message: 'A notice for omp.' }] })
    const { fp, ctx } = setup(sb, { isFile: () => true }, data)
    const notices = () => fp.sent.filter(s => s.message.customType === NOTICE_MESSAGE_TYPE)
    await fp.emit('session_switch', { type: 'session_switch', reason: 'resume' }, ctx)
    await fp.emit('session_switch', { type: 'session_switch', reason: 'new' }, ctx)
    await fp.emit('session_branch', { type: 'session_branch' }, ctx)
    ctx.sessionManager.getSessionFile = () => join(sb.root, 'session.jsonl')
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    expect(notices()).toEqual([])
    expect(ctx.uiCalls.filter(c => c.method === 'notify' && String(c.args[0]).includes('A notice for omp.'))).toEqual([])
    const fresh = setup(sb, {}, data)
    await fresh.fp.emit('session_start', { type: 'session_start' }, fresh.ctx)
    expect(fresh.fp.sent.filter(s => s.message.customType === NOTICE_MESSAGE_TYPE).length).toBe(1)
  })))
})

describe('omp H06/H07 without a handoff memory', () => {
  test('the todo tool\'s open items ride in preserveData and come back after compaction', () => withSandbox(async sb => {
    const bridge = { ...fakeMemory().bridge, writeHandoff: async () => undefined }
    const { fp, ctx } = setup(sb, { memory: bridge, compact: { compactInstructions: () => 'x', handoffNote: () => ({ slug: 'h', markdown: '' }), restoreContext } })
    await fp.emit('tool_result', { type: 'tool_result', toolCallId: 't1', toolName: 'todo', input: {}, isError: false, content: [{ type: 'text', text: 'Remaining items (2):\n  - Write the parser [in_progress]\n  - Old item [completed]' }] }, ctx)
    const r = await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx) as { preserveData: { buracle: Record<string, unknown> } }
    expect(r.preserveData.buracle).toEqual({ v: 1, sessionId: SID, todos: ['Write the parser'] })
    await fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 's', preserveData: r.preserveData }, fromExtension: false }, ctx)
    expect(fp.sent.at(-1)?.message.content).toBe('Buracle: the context was compacted.\nOpen todos at compaction time (no handoff memory was written):\n- Write the parser')
  }))

  test('a lead without a plan of its own gets its plan lanes\' running reviewers back after compaction', () => withSandbox(async sb => {
    saveState('omp', SID, { ...emptyState(), laneReviews: [{ lane: 'billing', role: 'changes', startedAt: 1, handle: 'task-7' }] })
    const bridge = { ...fakeMemory().bridge, writeHandoff: async () => undefined }
    const { fp, ctx } = setup(sb, { memory: bridge, compact: { compactInstructions, handoffNote: () => ({ slug: 'h', markdown: '' }), restoreContext } })
    const r = await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx) as { context?: string[] } | undefined
    expect(r?.context?.join('\n')).toContain('changes-review for lane billing (handle task-7)')
    await fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 's' }, fromExtension: false }, ctx)
    expect(fp.sent.at(-1)?.message.content).toContain('not collected yet: changes-review for lane billing (handle task-7).')
  }))
})

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createBuracleExtension, defaultDeps } from '../../../src/adapters/omp/runtime/extension'
import { PROMPT_MESSAGE_TYPE } from '../../../src/adapters/omp/runtime/prompt'
import { BOARD_MESSAGE_TYPE, BOARD_OFFER_NOTICE, BOARD_WAITING_NOTICE } from '../../../src/adapters/omp/runtime/session-notes'
import { stopGuardVerdict } from '../../../src/core/plan/state'
import { detectIntent, isGuardContinuation } from '../../../src/core/policy/intents'
import { readBoard } from '../../../src/workflow/board-store'
import { workAsk, workDone, workJoin, workNote, workPublish } from '../../../src/workflow/board'
import { planRegister } from '../../../src/workflow/plan'
import type { ResolvedSession } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctxAt, g, makeRepo, planDoc, write } from '../../workflow/fixture'
import { fakeCtx, fakePi, testDeps, testGenerated } from './fakes'

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const LEAD: ResolvedSession = { harness: 'omp', sessionId: '01a118a8-8d01-740c-9360-f4f7966lead', source: '--session' }
const WORKER: ResolvedSession = { harness: 'omp', sessionId: '01a118a8-8d01-740c-9360-f4f7966work', source: '--session' }
const OTHER: ResolvedSession = { harness: 'claude', sessionId: 'worker-claude', source: '--session' }

function harness(cwd: string, sid: string, clock: { now: number }, tty: string[] = [], kind?: 'main' | 'sub') {
  const base = testDeps().deps
  const policy = { ...base.policy!, checkBash: () => ({}), checkWrite: () => ({}), routeTool: () => ({ action: 'allow' as const }), capabilityCard: () => '', checkQuestion: () => ({}), detectIntent, isGuardContinuation }
  const plan = { ...base.plan!, stopGuardVerdict }
  const t = testDeps({ policy, plan, now: () => clock.now })
  const board = { ...defaultDeps().board!, tty: (sequence: string) => { tty.push(sequence); return true } }
  const fp = fakePi({ thinking: 'high' })
  createBuracleExtension(testGenerated(), { ...t.deps, board })(fp.pi)
  const ctx = fakeCtx({ cwd, sid, ...(kind !== undefined ? { kind } : {}) })
  const toolCall = async (toolName: string, input: Record<string, unknown>) => fp.emit('tool_call', { type: 'tool_call', toolCallId: `c${clock.now}`, toolName, input }, ctx) as Promise<{ block?: boolean, reason?: string, additionalContext?: string } | undefined>
  const toolResult = async (toolName: string, input: Record<string, unknown>) => fp.emit('tool_result', { type: 'tool_result', toolCallId: `r${clock.now}`, toolName, input, content: 'ok' }, ctx) as Promise<{ additionalContext?: string } | undefined>
  const stop = async () => fp.emit('session_stop', { type: 'session_stop', session_id: sid, last_assistant_message: 'Done for now.' }, ctx) as Promise<{ decision?: string, reason?: string } | undefined>
  const prompt = async (text: string) => {
    await fp.emit('input', { type: 'input', text, source: 'interactive' }, ctx)
    const r = await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: text, systemPrompt: [] }, ctx) as { message?: { customType: string, content: string } } | undefined
    if (r?.message !== undefined) expect(r.message.customType).toBe(PROMPT_MESSAGE_TYPE)
    return r?.message?.content ?? ''
  }
  return { fp, ctx, toolCall, toolResult, stop, prompt, tty }
}

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

async function board(root: string, o: { leaseSec?: number } = {}): Promise<{ repo: string, plan: string, path: string }> {
  const repo = await makeRepo(root)
  const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
  write(plan, planDoc({ n: 2, status: 'IN_PROGRESS', approved: true }))
  const pub = await workPublish({ planPath: plan, ...(o.leaseSec !== undefined ? { leaseSec: o.leaseSec } : {}) }, ctxAt(repo, NOW), LEAD)
  if (pub.code !== 0) throw new Error(pub.errors.join('; '))
  return { repo, plan, path: String(pub.data['path']) }
}

async function finish(repo: string, worker: ResolvedSession, wt: string, at: number): Promise<void> {
  write(join(wt, 'src', 's1.ts'), 'export const s1 = 1\n')
  await g(wt, 'add', '-A')
  await g(wt, 'commit', '-q', '-m', 'task 1')
  const d = await workDone({ verify: 'bun test → pass' }, ctxAt(repo, at), worker)
  if (d.code !== 0) throw new Error(d.errors.join('; '))
}

describe('omp extension and the task board', () => {
  test('1. the join offer goes to the next turn once at session start, with a visible notice; the lead gets none', () => sandbox(async root => {
    const { repo } = await board(root)
    const fresh = harness(repo, '01a118a8-8d01-740c-9360-f4f7966fres', { now: NOW })
    await fresh.fp.emit('session_start', { type: 'session_start' }, fresh.ctx)
    const offers = fresh.fp.sent.filter(s => s.message.customType === BOARD_MESSAGE_TYPE)
    expect(offers).toHaveLength(1)
    expect(offers[0]?.message.content).toContain('`/buracle-join rate-limit`')
    expect(offers[0]?.options).toEqual({ deliverAs: 'nextTurn' })
    expect(fresh.ctx.uiCalls.filter(c => c.method === 'notify').map(c => c.args[0])).toContain(BOARD_OFFER_NOTICE)
    await fresh.fp.emit('session_start', { type: 'session_start' }, fresh.ctx)
    expect(fresh.fp.sent.filter(s => s.message.customType === BOARD_MESSAGE_TYPE)).toHaveLength(1)
    const lead = harness(repo, LEAD.sessionId, { now: NOW })
    await lead.fp.emit('session_start', { type: 'session_start' }, lead.ctx)
    expect(lead.fp.sent.filter(s => s.message.customType === BOARD_MESSAGE_TYPE)).toHaveLength(0)
  }))

  test('2. and 3. a note reaches the worker once: with the next prompt, or with the next tool result while a turn runs', () => sandbox(async root => {
    const { repo } = await board(root)
    const clock = { now: NOW }
    const h = harness(repo, WORKER.sessionId, clock)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    workNote('rebase onto main please', {}, ctxAt(repo, NOW + 1), LEAD)
    clock.now = NOW + 2
    expect(await h.prompt('go on')).toContain('rebase onto main please')
    clock.now = NOW + 3
    expect(await h.prompt('go on')).not.toContain('rebase onto main')
    workNote('and run the tests', {}, ctxAt(repo, NOW + 4), LEAD)
    clock.now = NOW + 5
    expect((await h.toolResult('bash', { command: 'ls' }))?.additionalContext).toContain('and run the tests')
    clock.now = NOW + 6
    expect((await h.toolResult('bash', { command: 'ls' }))?.additionalContext ?? '').not.toContain('and run the tests')
  }))

  test('11. a waiting task resumes at the tool result after the question tool: not at the result of the command that asked, not at a tool call', () => sandbox(async root => {
    const { repo, path } = await board(root)
    const clock = { now: NOW }
    const h = harness(repo, WORKER.sessionId, clock)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    expect((await workAsk('which port?', ctxAt(repo, NOW + 1), WORKER)).code).toBe(0)
    clock.now = NOW + 2
    expect((await h.toolResult('bash', { command: 'buracle work ask "which port?"' }))?.additionalContext ?? '').not.toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    clock.now = NOW + 3
    await h.toolCall('ask', { question: 'which port?' })
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    clock.now = NOW + 4
    expect((await h.toolResult('ask', { question: 'which port?' }))?.additionalContext).toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('claimed')
  }))

  test('4. and 5. a worker cannot write outside its worktree; the lead cannot edit a claimed task\'s file', () => sandbox(async root => {
    const { repo } = await board(root)
    const w = harness(repo, WORKER.sessionId, { now: NOW })
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    const outside = await w.toolCall('write', { path: join(repo, 'src', 'app.ts'), content: 'x' })
    expect(outside?.block).toBe(true)
    // The worker's subagent writes under the same rule.
    const sub = harness(repo, WORKER.sessionId, { now: NOW }, [], 'sub')
    expect((await sub.toolCall('write', { path: join(repo, 'src', 'app.ts'), content: 'x' }))?.block).toBe(true)
    expect((await sub.toolCall('write', { path: join(wt, 'src', 's1.ts'), content: 'x' }))?.block).toBeUndefined()
    expect(outside?.reason).toContain('rate-limit-t1')
    expect((await w.toolCall('write', { path: join(wt, 'src', 's1.ts'), content: 'x' }))?.block).toBeUndefined()
    const l = harness(repo, LEAD.sessionId, { now: NOW })
    const lead = await l.toolCall('edit', { path: join(repo, 'src', 's1.ts'), old_string: 'a', new_string: 'b' })
    expect(lead?.block).toBe(true)
    expect(lead?.reason).toContain('Task 1')
    expect(lead?.reason).toContain('buracle work wait')
    expect((await l.toolCall('edit', { path: join(repo, 'src', 's2.ts'), old_string: 'a', new_string: 'b' }))?.block).toBeUndefined()
  }))

  test('6. a worker session without a plan is held at session_stop while its task is claimed, and released after work done', () => sandbox(async root => {
    const { repo } = await board(root)
    const clock = { now: NOW }
    const h = harness(repo, WORKER.sessionId, clock)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const held = await h.stop()
    expect(held?.decision).toBe('block')
    expect(held?.reason).toContain('buracle work done')
    expect(held?.reason).toContain('Task 1')
    await finish(repo, WORKER, String((j.data['worktree'] as { path: string }).path), NOW + 1)
    clock.now = NOW + 2
    expect(await h.stop()).toBeUndefined()
  }))

  test('7. the lead at session_stop is told to merge while the board holds done tasks, never to implement them', () => sandbox(async root => {
    const { repo, plan } = await board(root)
    const clock = { now: NOW }
    const h = harness(repo, LEAD.sessionId, clock)
    expect((await planRegister(plan, undefined, ctxAt(repo, NOW), LEAD)).code).toBe(0)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), OTHER)
    await finish(repo, OTHER, String((j.data['worktree'] as { path: string }).path), NOW + 1)
    clock.now = NOW + 2
    const held = await h.stop()
    expect(held?.decision).toBe('block')
    expect(held?.reason).toContain('buracle work merge')
    expect(held?.reason).not.toContain('next unticked')
  }))

  test('8. session_shutdown returns the worker\'s task to open and keeps the worktree', () => sandbox(async root => {
    const { repo, path } = await board(root)
    const h = harness(repo, WORKER.sessionId, { now: NOW })
    await h.fp.emit('session_start', { type: 'session_start' }, h.ctx)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    await h.fp.emit('session_shutdown', { type: 'session_shutdown' }, h.ctx)
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'open', lastWorker: { session: WORKER.sessionId } })
    expect(readBoard(path)?.tasks[0]?.worktree).toBeDefined()
  }))

  test('9. after a stale takeover the old worker\'s write is denied as reassigned and its session_stop passes', () => sandbox(async root => {
    const { repo } = await board(root, { leaseSec: 1 })
    const clock = { now: NOW }
    const h = harness(repo, WORKER.sessionId, clock)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2000), OTHER)).data).toMatchObject({ task: { n: 1 } })
    clock.now = NOW + 3000
    const denied = await h.toolCall('write', { path: join(wt, 'src', 's1.ts'), content: 'x' })
    expect(denied?.block).toBe(true)
    expect(denied?.reason).toContain('reassigned')
    clock.now = NOW + 4000
    expect(await h.stop()).toBeUndefined()
  }))

  test('10. without a board nothing changes: no offer, writes pass, session_stop is quiet', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const h = harness(repo, '01a118a8-8d01-740c-9360-f4f7966solo', { now: NOW })
    await h.fp.emit('session_start', { type: 'session_start' }, h.ctx)
    expect(h.fp.sent.filter(s => s.message.customType === BOARD_MESSAGE_TYPE)).toHaveLength(0)
    expect((await h.toolCall('write', { path: join(repo, 'src', 'app.ts'), content: 'x' }))?.block).toBeUndefined()
    expect(await h.stop()).toBeUndefined()
    expect(await h.prompt('hi')).not.toContain('board')
  }))

  test('the OSC sequence work ask left is written through the extension\'s tty once, with a notice', () => sandbox(async root => {
    const { repo } = await board(root)
    const tty: string[] = []
    const h = harness(repo, WORKER.sessionId, { now: NOW }, tty)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const r = await workAsk('which port?', ctxAt(repo, NOW + 1), WORKER)
    await h.toolResult('bash', { command: 'buracle work ask "which port?"' })
    expect(tty).toEqual([String(r.data['terminalSequence'])])
    expect(h.ctx.uiCalls.filter(c => c.method === 'notify').map(c => c.args[0])).toContain(BOARD_WAITING_NOTICE)
    await h.toolResult('bash', { command: 'ls' })
    expect(tty).toHaveLength(1)
  }))
})

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { BOARD_TOAST, emitBoardTerminal } from '../../../src/adapters/opencode/runtime/tui-terminal'
import type { PermissionEvaluation, SessionContextEvent, SessionPromptEvent, ToolExecuteAfter } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import { readBoard, writeTerminalSequence } from '../../../src/workflow/board-store'
import { workAsk, workDone, workJoin, workNote, workPublish } from '../../../src/workflow/board'
import { planRegister } from '../../../src/workflow/plan'
import type { ResolvedSession } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctxAt, g, makeRepo, planDoc, write } from '../../workflow/fixture'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const LEAD: ResolvedSession = { harness: 'opencode', sessionId: 'ses_lead01', source: '--session' }
const WORKER: ResolvedSession = { harness: 'opencode', sessionId: 'ses_work01', source: '--session' }
const OTHER: ResolvedSession = { harness: 'codex', sessionId: 'worker-codex', source: '--session' }

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

async function runtime(dir: string, clock: { now: number }) {
  const f = fakeServerContext(dir)
  const notices: Array<{ title: string, message: string }> = []
  const deps: PluginDeps = {
    baked: testBaked(), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: (title, message) => { notices.push({ title, message }) },
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd), now: () => clock.now,
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  let n = 0
  const session = async (sid: string) => { await rt.handleEvent({ type: 'session.created', data: { sessionID: sid, location: { directory: dir } } }) }
  const context = async (sid: string): Promise<string[]> => {
    const ev: SessionContextEvent = { sessionID: sid, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} }
    await f.trigger('session.context', ev)
    return ev.system.map(p => p.text)
  }
  const prompt = async (sid: string, text: string): Promise<string[]> => {
    const ev: SessionPromptEvent = { sessionID: sid, messageID: `msg_${++n}`, prompt: { text }, delivery: 'steer' }
    await f.trigger('session.prompt', ev)
    return context(sid)
  }
  const call = async (sid: string, tool: string, input: Record<string, unknown>, action: string, resources: string[] = []): Promise<PermissionEvaluation> => {
    const id = `call_b${++n}`
    await f.trigger('tool.execute.before', { tool, sessionID: sid, agent: 'build', messageID: 'msg_1', id, input })
    return f.trigger('permission.evaluate', { sessionID: sid, agent: 'build', action, resources, effect: 'allow', source: { type: 'tool', messageID: 'msg_1', id } } as PermissionEvaluation)
  }
  const edit = (sid: string, file: string) => call(sid, 'edit', { filePath: file, oldString: 'a', newString: 'b' }, 'edit', [file])
  const after = async (sid: string, id: string): Promise<string> => {
    const ev: ToolExecuteAfter = { tool: 'bash', sessionID: sid, agent: 'build', messageID: 'msg_1', id, input: { command: 'ls' }, status: 'completed', result: { output: { output: 'x', exit: 0 } } }
    await f.trigger('tool.execute.before', { tool: 'bash', sessionID: sid, agent: 'build', messageID: 'msg_1', id, input: { command: 'ls' } })
    await f.trigger('tool.execute.after', ev)
    if (ev.status !== 'completed') return ''
    const c = ev.result.content
    return typeof c === 'string' ? c : (c as Array<{ text: string }> | undefined ?? []).map(x => x.text).join('\n')
  }
  const cycle = async (sid: string, text = 'Done for now.'): Promise<void> => {
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: sid } })
    await rt.handleEvent({ type: 'session.text.ended', data: { sessionID: sid, text } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: sid } })
    await rt.idle()
  }
  return { f, rt, notices, session, context, prompt, call, edit, after, cycle }
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

describe('OpenCode plugin and the task board', () => {
  test('1. the join offer enters the context once, for a session that is on no board', () => sandbox(async root => {
    const { repo } = await board(root)
    const clock = { now: NOW }
    const h = await runtime(repo, clock)
    await h.session('ses_fresh01')
    expect((await h.context('ses_fresh01')).some(t => t.includes('/buracle-join rate-limit'))).toBe(true)
    expect((await h.context('ses_fresh01')).some(t => t.includes('/buracle-join'))).toBe(false)
    await h.session(LEAD.sessionId)
    expect((await h.context(LEAD.sessionId)).some(t => t.includes('/buracle-join'))).toBe(false)
  }))

  test('2. and 3. a note reaches the worker once: with the next prompt, or with the next tool call while a turn runs', () => sandbox(async root => {
    const { repo } = await board(root)
    const clock = { now: NOW }
    const h = await runtime(repo, clock)
    await h.session(WORKER.sessionId)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    workNote('rebase onto main please', {}, ctxAt(repo, NOW + 1), LEAD)
    clock.now = NOW + 2
    expect((await h.prompt(WORKER.sessionId, 'go on')).some(t => t.includes('rebase onto main please'))).toBe(true)
    clock.now = NOW + 3
    expect((await h.prompt(WORKER.sessionId, 'go on')).some(t => t.includes('rebase onto main'))).toBe(false)
    workNote('and run the tests', {}, ctxAt(repo, NOW + 4), LEAD)
    clock.now = NOW + 5
    const out = await h.after(WORKER.sessionId, 'call_t1')
    expect(out).toContain('and run the tests')
    clock.now = NOW + 6
    expect(await h.after(WORKER.sessionId, 'call_t2')).not.toContain('and run the tests')
  }))

  test('11. a waiting task resumes at the tool result after the question tool: not at the result of the command that asked, not at a tool call', () => sandbox(async root => {
    const { repo, path } = await board(root)
    const clock = { now: NOW }
    const h = await runtime(repo, clock)
    await h.session(WORKER.sessionId)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    expect((await workAsk('which port?', ctxAt(repo, NOW + 1), WORKER)).code).toBe(0)
    const result = async (id: string, tool: string, input: Record<string, unknown>): Promise<string> => {
      const ev: ToolExecuteAfter = { tool, sessionID: WORKER.sessionId, agent: 'build', messageID: 'msg_1', id, input, status: 'completed', result: { output: { output: 'x', exit: 0 } } }
      await h.f.trigger('tool.execute.before', { tool, sessionID: WORKER.sessionId, agent: 'build', messageID: 'msg_1', id, input })
      await h.f.trigger('tool.execute.after', ev)
      if (ev.status !== 'completed') return ''
      const c = ev.result.content
      return typeof c === 'string' ? c : (c as Array<{ text: string }> | undefined ?? []).map(x => x.text).join('\n')
    }
    clock.now = NOW + 2
    expect(await result('call_a1', 'bash', { command: 'buracle work ask "which port?"' })).not.toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    clock.now = NOW + 3
    await h.f.trigger('tool.execute.before', { tool: 'question', sessionID: WORKER.sessionId, agent: 'build', messageID: 'msg_1', id: 'call_q0', input: { questions: [] } })
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    clock.now = NOW + 4
    expect(await result('call_q1', 'question', { questions: [] })).toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('claimed')
  }))

  test('4. and 5. a worker cannot edit outside its worktree; the lead cannot edit a claimed task\'s file', () => sandbox(async root => {
    const { repo } = await board(root)
    const h = await runtime(repo, { now: NOW })
    await h.session(WORKER.sessionId)
    await h.session(LEAD.sessionId)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    const outside = await h.edit(WORKER.sessionId, join(repo, 'src', 'app.ts'))
    expect(outside.effect).toBe('deny')
    expect(outside.message).toContain('rate-limit-t1')
    expect((await h.edit(WORKER.sessionId, join(wt, 'src', 's1.ts'))).effect).toBe('allow')
    // The worker's subagent session (session.created carries its parentID) edits under the worker's rule.
    await h.rt.handleEvent({ type: 'session.created', data: { sessionID: 'ses_sub01', parentID: WORKER.sessionId, location: { directory: repo } } })
    expect((await h.edit('ses_sub01', join(repo, 'src', 'app.ts'))).effect).toBe('deny')
    expect((await h.edit('ses_sub01', join(wt, 'src', 's1.ts'))).effect).toBe('allow')
    const lead = await h.edit(LEAD.sessionId, join(repo, 'src', 's1.ts'))
    expect(lead.effect).toBe('deny')
    expect(lead.message).toContain('Task 1')
    expect(lead.message).toContain('buracle work wait')
    expect((await h.edit(LEAD.sessionId, join(repo, 'src', 's2.ts'))).effect).toBe('allow')
  }))

  test('6. a worker session without a plan is continued at idle while its task is claimed, and left alone after work done', () => sandbox(async root => {
    const { repo } = await board(root)
    const clock = { now: NOW }
    const h = await runtime(repo, clock)
    await h.session(WORKER.sessionId)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    await h.cycle(WORKER.sessionId)
    expect(h.f.prompts.length).toBe(1)
    expect(h.f.prompts[0]?.text).toContain('buracle work done')
    expect(h.f.prompts[0]?.text).toContain('Task 1')
    await finish(repo, WORKER, wt, NOW + 1)
    clock.now = NOW + 2
    await h.cycle(WORKER.sessionId)
    expect(h.f.prompts.length).toBe(1)
  }))

  test('7. the lead at idle is told to merge while the board holds done tasks, never to implement them', () => sandbox(async root => {
    const { repo, plan } = await board(root)
    const clock = { now: NOW }
    const h = await runtime(repo, clock)
    await h.session(LEAD.sessionId)
    expect((await planRegister(plan, undefined, ctxAt(repo, NOW), LEAD)).code).toBe(0)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), OTHER)
    await finish(repo, OTHER, String((j.data['worktree'] as { path: string }).path), NOW + 1)
    clock.now = NOW + 2
    await h.cycle(LEAD.sessionId)
    expect(h.f.prompts.length).toBe(1)
    expect(h.f.prompts[0]?.text).toContain('buracle work merge')
    expect(h.f.prompts[0]?.text).not.toContain('next unticked')
  }))

  test('8. a deleted session returns the worker\'s task to open and keeps the worktree', () => sandbox(async root => {
    const { repo, path } = await board(root)
    const h = await runtime(repo, { now: NOW })
    await h.session(WORKER.sessionId)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    await h.rt.handleEvent({ type: 'session.deleted', data: { sessionID: WORKER.sessionId } })
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'open', lastWorker: { session: WORKER.sessionId } })
    expect(readBoard(path)?.tasks[0]?.worktree).toBeDefined()
  }))

  test('9. after a stale takeover the old worker\'s edit is denied as reassigned and its idle passes', () => sandbox(async root => {
    const { repo } = await board(root, { leaseSec: 1 })
    const clock = { now: NOW }
    const h = await runtime(repo, clock)
    await h.session(WORKER.sessionId)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2000), OTHER)).data).toMatchObject({ task: { n: 1 } })
    clock.now = NOW + 3000
    const denied = await h.edit(WORKER.sessionId, join(wt, 'src', 's1.ts'))
    expect(denied.effect).toBe('deny')
    expect(denied.message).toContain('reassigned')
    clock.now = NOW + 4000
    await h.cycle(WORKER.sessionId)
    expect(h.f.prompts).toEqual([])
  }))

  test('10. without a board nothing changes: no offer, edits pass, idle is quiet', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const h = await runtime(repo, { now: NOW })
    await h.session('ses_solo01')
    expect((await h.context('ses_solo01')).some(t => t.includes('Buracle task board'))).toBe(false)
    expect((await h.edit('ses_solo01', join(repo, 'src', 'app.ts'))).effect).toBe('allow')
    await h.cycle('ses_solo01')
    expect(h.f.prompts).toEqual([])
    expect((await h.prompt('ses_solo01', 'hi')).some(t => t.includes('Buracle task board') || t.includes('board note'))).toBe(false)
  }))

  test('the TUI emits the sequence work ask left, once, to the terminal with a toast', () => sandbox(async root => {
    const { repo } = await board(root)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const r = await workAsk('which port?', ctxAt(repo, NOW + 1), WORKER)
    const tty = join(root, 'tty.out')
    const toasts: string[] = []
    expect(emitBoardTerminal(WORKER.sessionId, { tty, toast: m => toasts.push(m), env: {} })).toBe(true)
    expect(readFileSync(tty, 'utf8')).toBe(String(r.data['terminalSequence']))
    expect(toasts).toEqual([BOARD_TOAST])
    expect(emitBoardTerminal(WORKER.sessionId, { tty, toast: m => toasts.push(m), env: {} })).toBe(false)
    expect(emitBoardTerminal(undefined, { tty, env: {} })).toBe(false)
    writeTerminalSequence('opencode', WORKER.sessionId, '\x1b]9;x\x07', NOW)
    expect(emitBoardTerminal(WORKER.sessionId, { tty: join(root, 'other.out'), toast: m => toasts.push(m), env: { BURACLE_NO_NOTIFY: '1' } })).toBe(true)
    expect(toasts).toHaveLength(1)
    // Under tmux the sequence goes out inside the DCS passthrough wrapper.
    writeTerminalSequence('opencode', WORKER.sessionId, '\x1b]9;y\x07', NOW)
    const tmuxOut = join(root, 'tmux.out')
    expect(emitBoardTerminal(WORKER.sessionId, { tty: tmuxOut, env: { TMUX: '/tmp/tmux-501/default,1,0' } })).toBe(true)
    expect(readFileSync(tmuxOut, 'utf8')).toBe('\x1bPtmux;\x1b\x1b]9;y\x07\x1b\\')
  }))
})

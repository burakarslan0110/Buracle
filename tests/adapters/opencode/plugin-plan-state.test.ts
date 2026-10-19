import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { COMMAND_ARGS, COMMAND_MARK } from '../../../src/adapters/opencode/runtime/routing'
import type { PermissionEvaluation, SessionContextEvent, SessionPromptEvent, ToolExecuteAfter } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { SessionState } from '../../../src/core/plan/state'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import * as paths from '../../../src/engine/paths'
import { loadState, saveState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const SID = 'ses_w2state1'

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

function planState(over: Partial<NonNullable<SessionState['plan']>> = {}): SessionState {
  return { v: 1, plan: { path: 'docs/plans/2026-10-08-x.md', slug: 'x', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1, ...over }, guard: { blocksForPlan: 0, blocksInChain: 0 } }
}

function evaluation(action: string, resources: string[], sessionID = SID): PermissionEvaluation {
  return { sessionID, action, resources, effect: 'allow' }
}

async function runtime(dir: string, now?: () => number) {
  const f = fakeServerContext(dir)
  const notices: Array<{ title: string, message: string }> = []
  const deps: PluginDeps = {
    baked: testBaked(), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: (title, message) => { notices.push({ title, message }) },
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd),
    ...(now !== undefined ? { now } : {}),
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: dir } } })
  return { f, rt, notices }
}

async function cycle(rt: BuracleRuntime, text = 'Done with task 1.', sid = SID): Promise<void> {
  await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: sid } })
  await rt.handleEvent({ type: 'session.text.ended', data: { sessionID: sid, text } })
  await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: sid } })
  await rt.idle()
}

function toolDone(tool: string, input: Record<string, unknown>, output: unknown, id: string): ToolExecuteAfter {
  return { tool, sessionID: SID, agent: 'build', messageID: 'msg_1', id, input, status: 'completed', result: { output } }
}

describe('w2 plan state on OpenCode: progress, read-only mode and background work (H08)', () => {
  test('a newly ticked task restarts the chain; the continuation restates the objective', () => withSandbox(async ({ root }) => {
    const { planDoc } = await import('../../workflow/fixture')
    const path = join(root, 'docs', 'plans', 'p.md')
    mkdirSync(join(root, 'docs', 'plans'), { recursive: true })
    writeFileSync(path, planDoc({ status: 'IN_PROGRESS', approved: true, n: 8, done: 0 }))
    saveState('opencode', SID, planState({ path }))
    let clock = 2_000_000
    const { f, rt } = await runtime(root, () => clock)
    for (let i = 1; i <= 8; i++) {
      writeFileSync(path, planDoc({ status: 'IN_PROGRESS', approved: true, n: 8, done: i }))
      clock += 120_000
      await cycle(rt)
    }
    expect(f.prompts.length).toBe(8)
    expect(f.prompts.every(p => !p.text.includes('runaway'))).toBe(true)
    expect(f.prompts[0]?.text).toContain('Objective: Clients get 429 instead of overloading the server.')
  }))

  test('the read-only plan agent lets the session stop: no continuation, one notice for the whole run', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const { f, rt, notices } = await runtime(root)
    await f.trigger('tool.execute.before', { tool: 'read', sessionID: SID, agent: 'plan', messageID: 'msg_1', id: 'call_r', input: { filePath: join(root, 'x.md') } })
    await cycle(rt)
    await cycle(rt)
    await f.trigger('session.prompt', { sessionID: SID, prompt: { text: 'refine the plan' } })
    await cycle(rt)
    expect(f.prompts).toEqual([])
    expect(notices.length).toBe(1)
    expect(notices[0]?.message).toContain('read-only plan agent')
    expect(loadState('opencode', SID).guard).toMatchObject({ blocksForPlan: 0, blocksInChain: 0, readOnlyNoticed: true })
  }))

  test('a finite background shell the agent waits for releases the stop; its completion notice ends the wait', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    let clock = 3_000_000
    const { f, rt } = await runtime(root, () => clock)
    await f.trigger('tool.execute.after', toolDone('shell', { command: 'bun test', background: true }, { output: 'Command moved to the background (shell ID: sh_1).', shellID: 'sh_1', truncated: false, status: 'running' }, 'call_s1'))
    await cycle(rt, 'The test suite is running in the background; I will report when it finishes.')
    expect(f.prompts).toEqual([])
    expect(loadState('opencode', SID).guard.blocksForPlan).toBe(0)
    await rt.handleEvent({ type: 'session.synthetic', data: { sessionID: SID, text: '<shell id="j1" state="completed" command="bun test"></shell>', metadata: { source: 'shell', shellID: 'sh_1', jobID: 'j1', state: 'completed' } } })
    clock += 120_000
    await cycle(rt, 'The tests passed. I will report when it finishes.')
    expect(f.prompts.length).toBe(1)
    expect(f.prompts[0]?.text).toStartWith('Buracle stop guard:')
  }))

  test('a background dev server holds nothing: the stop guard still continues the plan', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const { f, rt } = await runtime(root)
    await f.trigger('tool.execute.after', toolDone('shell', { command: 'bun run dev', background: true }, { output: 'moved', shellID: 'sh_2', truncated: false, status: 'running' }, 'call_s2'))
    await cycle(rt, 'The dev server is running in the background; I will check it when it is up.')
    expect(f.prompts.length).toBe(1)
  }))

  test('a background subagent releases the stop until its child session finishes', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    let clock = 4_000_000
    const { f, rt } = await runtime(root, () => clock)
    const child = 'ses_w2child1'
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    await f.trigger('tool.execute.after', toolDone('subagent', { agent: 'general', description: 'audit', prompt: 'x', background: true }, { sessionID: child, status: 'running', output: 'The subagent is working in the background.' }, 'call_a1'))
    await cycle(rt, 'The audit subagent is running in the background; I will continue once it reports.')
    expect(f.prompts).toEqual([])
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: child } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: child } })
    clock += 120_000
    await cycle(rt, 'The audit subagent is running in the background; I will continue once it reports.')
    expect(f.prompts.length).toBe(1)
  }))
})

describe('w2 plan state on OpenCode: the lane guard and the H08 receipt', () => {
  test('a child (subagent) session cannot run the state-changing plan commands; the root session can', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root)
    const child = 'ses_lane1'
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    const lane = evaluation('shell', ['buracle plan resume'], child)
    await f.trigger('permission.evaluate', lane)
    expect(lane.effect).toBe('deny')
    expect(lane.message).toContain('Buracle lane guard')
    const status = evaluation('shell', ['buracle plan status --json'], child)
    await f.trigger('permission.evaluate', status)
    expect(status.effect).toBe('allow')
    const lead = evaluation('shell', ['buracle plan resume'])
    await f.trigger('permission.evaluate', lead)
    expect(lead.effect).toBe('allow')
  }))

  test('a child session cannot change the plan state through context-mode either; the root session can', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root)
    const child = 'ses_lane3'
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    const cm = async (sid: string, id: string, input: Record<string, unknown>): Promise<PermissionEvaluation> => {
      await f.trigger('tool.execute.before', { tool: 'context-mode_ctx_execute', sessionID: sid, agent: 'general', messageID: 'msg_1', id, input })
      const ev: PermissionEvaluation = { sessionID: sid, action: 'context-mode_ctx_execute', resources: ['*'], effect: 'allow', source: { type: 'tool', messageID: 'msg_1', id } }
      await f.trigger('permission.evaluate', ev)
      return ev
    }
    const lane = await cm(child, 'call_l1', { language: 'shell', code: 'buracle plan resume' })
    expect(lane.effect).toBe('deny')
    expect(lane.message).toContain('Buracle lane guard')
    expect((await cm(child, 'call_l2', { language: 'python', code: "import subprocess\nsubprocess.run(['buracle', 'worktree', 'sync', 'x'])" })).message).toContain('`buracle worktree sync`')
    expect((await cm(child, 'call_l3', { language: 'shell', code: 'buracle plan status --json' })).effect).toBe('allow')
    expect((await cm(SID, 'call_l4', { language: 'shell', code: 'buracle plan resume' })).effect).toBe('allow')
  }))

  test('an answered question tool during a decision pause is recorded for the stop guard; a subagent\'s is not', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, { ...planState(), interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'merge decision' } })
    const { f, rt } = await runtime(root, () => 5_000)
    const answered: ToolExecuteAfter = { tool: 'question', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_q', input: { questions: [] }, status: 'completed', result: { output: 'User has answered your questions: "Merge?"="Squash-merge".' } }
    await f.trigger('tool.execute.after', answered)
    expect(loadState('opencode', SID).interaction?.answeredAt).toBe(5_000)
    const child = 'ses_lane2'
    saveState('opencode', child, { ...planState(), interaction: { state: 'paused', kind: 'decision', since: 1 } })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    await f.trigger('tool.execute.after', { ...answered, sessionID: child, id: 'call_q2' })
    expect(loadState('opencode', child).interaction?.answeredAt).toBeUndefined()
  }))

  test('a real question while the plan runs unpaused passes and its answer carries the H09 reminder to pause first (a subagent\'s does not)', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const { f, rt } = await runtime(root)
    const input = { questions: [{ question: 'Use Postgres or SQLite for the cache?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }
    const ask = async (sid: string, id: string): Promise<ToolExecuteAfter> => {
      await f.trigger('tool.execute.before', { tool: 'question', sessionID: sid, agent: 'build', messageID: 'msg_1', id, input })
      const ev = await f.trigger('permission.evaluate', { ...evaluation('question', ['*'], sid), source: { type: 'tool', messageID: 'msg_1', id } })
      expect(ev.effect).toBe('allow')
      const done: ToolExecuteAfter = { ...toolDone('question', input, 'User has answered your questions: "Use Postgres or SQLite for the cache?"="SQLite".', id), sessionID: sid }
      await f.trigger('tool.execute.after', done)
      return done
    }
    const texts = (r: ToolExecuteAfter): string[] => (r.status === 'completed' ? (r.result.content as unknown as Array<{ text: string }> | undefined ?? []).map(c => c.text) : [])
    const main = texts(await ask(SID, 'call_r1'))
    expect(main[0]).toContain('="SQLite"')
    expect(main.filter(t => t.startsWith('Buracle H09: the plan is running, not paused.') && t.includes('buracle plan pause --kind decision'))).toHaveLength(1)
    const child = 'ses_lane3'
    saveState('opencode', child, planState())
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    expect(texts(await ask(child, 'call_r2')).join('\n')).not.toContain('Buracle H09')
  }))
})

describe('read-only plan agent and edits before approval on OpenCode (HOOKS-WORKFLOW-5)', () => {
  const ctxEvent = (agent: string, messages: unknown[] = []): SessionContextEvent => ({ sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent, system: [], messages, options: {}, tools: {} })
  const workflowPrompt = (id: string): SessionPromptEvent => ({ sessionID: SID, messageID: id, prompt: { text: 'add rate limits' }, metadata: { [COMMAND_MARK]: 'plan-build', [COMMAND_ARGS]: 'add rate limits' }, delivery: 'steer' })

  test('a workflow command delivered to the plan agent carries the leave-plan-mode notice; the build agent gets none', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    await f.trigger('session.prompt', workflowPrompt('msg_w1'))
    const planned = await f.trigger('session.context', ctxEvent('plan', [{ id: 'msg_w1' }]))
    expect(planned.system.map(p => p.text).join('\n')).toContain("plan-build was started while the session is in OpenCode's read-only plan agent")
    await f.trigger('session.prompt', workflowPrompt('msg_w2'))
    const built = await f.trigger('session.context', ctxEvent('build', [{ id: 'msg_w2' }]))
    expect(built.system.map(p => p.text).join('\n')).not.toContain('was started while')
  }))

  test('notes the user pinned in the review page on the plan reach the next model request once (H10)', () => withSandbox(async ({ root }) => {
    const plan = join(root, 'docs', 'plans', 'x.md')
    saveState('opencode', SID, planState({ path: plan, status: 'PENDING', phase: 'plan' }))
    mkdirSync(dirname(paths.reviewInboxFile()), { recursive: true })
    writeFileSync(paths.reviewInboxFile(), JSON.stringify({ v: 1, entries: [{ at: 1, root, key: 'r/plans--x.md', open: 1, doc: plan, rel: 'docs/plans/x.md' }] }))
    const { f } = await runtime(root)
    const prompt = (id: string): SessionPromptEvent => ({ sessionID: SID, messageID: id, prompt: { text: 'I left a note on the plan' }, metadata: {}, delivery: 'steer' })
    await f.trigger('session.prompt', prompt('msg_n1'))
    const first = await f.trigger('session.context', ctxEvent('build', [{ id: 'msg_n1' }]))
    expect(first.system.map(p => p.text).join('\n')).toContain('the user left 1 open note in the review page on docs/plans/x.md')
    await f.trigger('session.prompt', prompt('msg_n2'))
    const second = await f.trigger('session.context', ctxEvent('build', [{ id: 'msg_n2' }]))
    expect(second.system.map(p => p.text).join('\n')).not.toContain('review page')
  }))

  test('the first edit of another file while the plan waits for approval gets one note in its result', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState({ path: join(root, 'docs', 'plans', 'x.md'), status: 'PENDING', phase: 'plan' }))
    const { f } = await runtime(root)
    const edit = async (id: string, file: string) => {
      await f.trigger('tool.execute.before', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: { path: file, content: 'x' } })
      await f.trigger('permission.evaluate', { ...evaluation('edit', [file]), source: { type: 'tool', messageID: 'msg_1', id } })
      const done = await f.trigger('tool.execute.after', { ...toolDone('write', { path: file, content: 'x' }, 'ok', id) })
      return JSON.stringify(done.status === 'completed' ? done.result.content ?? '' : '')
    }
    expect(await edit('call_e1', join(root, 'docs', 'plans', 'x.md'))).not.toContain('plan phase')
    expect(await edit('call_e2', join(root, 'src', 'app.ts'))).toContain('is still in its plan phase')
    expect(loadState('opencode', SID).guard.earlyEditNoted).toBe(true)
    expect(await edit('call_e3', join(root, 'src', 'b.ts'))).not.toContain('plan phase')
  }))
})

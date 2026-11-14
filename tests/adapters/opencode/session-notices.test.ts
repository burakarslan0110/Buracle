import { beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { READ_ONLY_NOTICE, runawayNotice } from '../../../src/adapters/opencode/runtime/guard'
import { NoticeReader, type BoardNotice } from '../../../src/adapters/opencode/runtime/notice-board'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { TuiNotices } from '../../../src/adapters/opencode/runtime/tui-notices'
import type { SessionContextEvent } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { SessionState } from '../../../src/core/plan/state'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import { saveState } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

// The notices OpenCode shows the user inside the session: the server plugin posts them to the session's notice
// board and the TUI plugin shows each as a toast. None of them is text for the model.

const SID = 'ses_notice01'
const NOTICE = { id: 'test-session-notice', since: '0.1.0', message: 'A notice for OpenCode.' }
const PLAN = 'docs/plans/2026-10-08-x.md'

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

const noProject = (cwd: string): WorkspaceInfo => ({ cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } })

function planState(guard: Partial<SessionState['guard']> = {}): SessionState {
  return { v: 1, plan: { path: PLAN, slug: 'x', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1 }, guard: { blocksForPlan: 0, blocksInChain: 0, ...guard } }
}

async function runtime(dir: string, now: () => number) {
  const f = fakeServerContext(dir)
  const mem = fakeMemory()
  const deps: PluginDeps = {
    now, baked: testBaked({ version: '0.5.0', notices: [NOTICE] }), memory: mem, settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }),
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd),
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: dir } } })
  await rt.idle()
  return { f, rt, mem }
}

const request = (agent = 'build'): SessionContextEvent => ({ sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent, system: [], messages: [], options: {}, tools: {} })

async function turn(rt: BuracleRuntime): Promise<void> {
  await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
  await rt.handleEvent({ type: 'session.text.ended', data: { sessionID: SID, text: 'Done with a step.' } })
  await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
  await rt.idle()
}

/** What a TUI that shows the session takes from its board, and what its toasts say. */
function shown(now: number): { board: BoardNotice[], toasts: string[] } {
  const board = new NoticeReader().take(SID, now)
  const toasts: string[] = []
  new TuiNotices({ now: () => now, toast: (message, variant) => { toasts.push(`${variant}: ${message}`) }, band: () => ({}) as never, bandOn: () => false, busy: () => false }).poll(SID)
  return { board, toasts }
}

describe('opencode: notices for the user inside the session', () => {
  test('the startup note: a release notice is posted once for the user, besides the line the model gets', () => withSandbox(async ({ root }) => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    const now = 1_800_000_000_000
    const { f } = await runtime(root, () => now)
    const first = request()
    await f.trigger('session.context', first)
    expect(first.system.map(p => p.text).join('\n')).toContain('Buracle notice, shown once on this machine.')
    const { board, toasts } = shown(now)
    expect(board.map(n => [n.variant, n.text])).toEqual([['info', expect.stringContaining('A notice for OpenCode.')]])
    expect(toasts).toEqual([`info: ${board[0]?.text}`])
    await f.trigger('session.context', request())
    expect(new NoticeReader().take(SID, now)).toHaveLength(1)
  })))

  test('the read-only plan agent: when the stop guard lets the session stop, the user is told to switch back', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const now = 1_800_000_000_000
    const { f, rt, mem } = await runtime(root, () => now)
    await f.trigger('tool.execute.before', { tool: 'read', sessionID: SID, agent: 'plan', messageID: 'msg_1', id: 'call_r', input: { filePath: join(root, 'x.md') } })
    await turn(rt)
    await turn(rt)
    expect(f.prompts).toEqual([])
    expect(shown(now).toasts).toEqual([`info: ${READ_ONLY_NOTICE}`])
    expect(mem.appended.flatMap(a => a.entries).filter(e => e.ev === 'note').map(e => e.excerpt)).toEqual([READ_ONLY_NOTICE])
  }))

  test('the stop guard releasing the session at a runaway cap is shown once per chain, as a warning', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState({ blocksForPlan: testBaked().defaults.plan.runaway.perPlan }))
    const start = 1_800_000_000_000
    let clock = start
    const { f, rt } = await runtime(root, () => clock)
    for (let i = 0; i < 3; i++) { await turn(rt); clock += 120_000 }
    expect(f.prompts).toHaveLength(1)
    // The first stop asks the model once (the escalation); the second releases the session and posts the notice.
    const board = new NoticeReader().take(SID, start + 120_000)
    expect(board.map(n => [n.variant, n.text])).toEqual([['warning', runawayNotice('runaway-plan', PLAN)]])
  }))
})

import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { draftOnSwitch, notePlanText, OPENCODE_PLAN_AGENT } from '../../../src/adapters/opencode/runtime/plan-draft'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import type { SessionContextEvent } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import { parsePlan } from '../../../src/core/plan/format'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import { loadState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { NATIVE_PLAN_BODY, prepareNativePlan } from '../../workflow/fixture'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const SID = 'ses_plan01'
const PLAN = '# Add a cache\n\n## Steps\n1. Cache the index\n2. Test it\n3. Ship it\n'

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

async function runtime(dir: string) {
  const f = fakeServerContext(dir)
  const mem = fakeMemory()
  const deps: PluginDeps = {
    baked: testBaked(), memory: mem, settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: () => undefined,
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd),
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  const request = async (agent: string): Promise<string[]> => {
    const ev: SessionContextEvent = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent, system: [], messages: [], options: {}, tools: {} }
    await f.trigger('session.context', ev)
    return ev.system.map(p => p.text)
  }
  const answer = (text: string) => rt.handleEvent({ type: 'session.text.ended', data: { sessionID: SID, text } })
  return { request, answer, mem }
}

function saved(root: string): string[] {
  const dir = join(root, 'docs', 'plans')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

describe('OpenCode H12: the plan agent has no approval step, so leaving it saves a draft', () => {
  test('the plan agent\'s last answer is saved as a SAVED draft (approved: false) at the first request of another agent, and the agent is told', () => withSandbox(async ({ root }) => {
    const { request, answer, mem } = await runtime(root)
    await request('plan')
    await answer('Let me look around first.')
    await request('plan')
    await answer(PLAN)
    const said = await request('build')
    const files = saved(root)
    expect(files.map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, ''))).toEqual(['add-a-cache.md'])
    const text = readFileSync(join(root, 'docs', 'plans', files[0] as string), 'utf8')
    expect(parsePlan(text).header).toMatchObject({ status: 'SAVED', approved: false, type: 'Plan' })
    expect(text).toContain('harness: opencode')
    expect(text).toContain('> 3. Ship it')
    expect(said.join('\n')).toContain(`docs/plans/${files[0]} (H12; OpenCode has no approval step, so it is not marked approved)`)
    expect(mem.appended.flatMap(a => a.entries).some(e => e.ev === 'note')).toBe(true)
    expect((await request('build')).join('\n')).not.toContain('(H12')
    expect(saved(root)).toEqual(files)
  }))

  test('no draft when the plan agent\'s answer is no plan, when the agent stays the plan agent, or when another agent wrote last', () => withSandbox(async ({ root }) => {
    const { request, answer } = await runtime(root)
    await request('plan')
    await answer('Which module should the cache live in?')
    await request('build')
    await request('plan')
    await answer(PLAN)
    await request('plan')
    await request('explore')
    expect(saved(root).length).toBe(1)
    await answer(PLAN)
    await request('build')
    expect(saved(root).length).toBe(1)
  }))

  test('plan.nativePlanMode: leaving the plan agent fills the prepared plan-build plan as a draft (no approval step), and the agent is told to ask for approval', () => withSandbox(async ({ root }) => {
    const path = await prepareNativePlan(root, 'opencode', SID)
    const { request, answer } = await runtime(root)
    await request('plan')
    await answer(`Switch back to the build agent (Tab) and say continue.\n\n${NATIVE_PLAN_BODY}`)
    const said = (await request('build')).join('\n')
    expect(said).toContain("the plan from OpenCode's plan agent was written into the registered plan")
    expect(said).toContain('ask the user to approve it')
    const text = readFileSync(path, 'utf8')
    expect(parsePlan(text).header).toMatchObject({ type: 'Feature', status: 'PENDING', approved: false })
    expect(text).not.toContain('Switch back to the build agent')
    expect(saved(root)).toEqual([basename(path)])
    expect(loadState('opencode', SID).native).toBeUndefined()
  }))

  test('the switch rule on its own', () => {
    const s = {}
    expect(draftOnSwitch(s, OPENCODE_PLAN_AGENT)).toBeUndefined()
    notePlanText(s, PLAN)
    expect(draftOnSwitch(s, OPENCODE_PLAN_AGENT)).toBeUndefined()
    expect(draftOnSwitch(s, '')).toBeUndefined()
    expect(draftOnSwitch(s, 'build')).toBe(PLAN)
    expect(draftOnSwitch(s, 'plan')).toBeUndefined()
    expect(draftOnSwitch(s, 'build')).toBeUndefined()
  })
})

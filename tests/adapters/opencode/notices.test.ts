import { beforeEach, describe, expect, test } from 'bun:test'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import type { SessionContextEvent } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const NOTICE = { id: 'opencode-test', since: '0.0.1', message: 'A notice for OpenCode.' }

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

const noProject = (cwd: string): WorkspaceInfo => ({ cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } })

async function runtime(dir: string, now?: () => number) {
  const f = fakeServerContext(dir)
  const notified: Array<{ title: string, message: string }> = []
  const deps: PluginDeps = {
    ...(now !== undefined ? { now } : {}),
    baked: testBaked({ version: '0.5.0', notices: [NOTICE] }), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: (title, message) => { notified.push({ title, message }) },
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd),
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  return { f, rt, notified }
}

const request = (sessionID: string): SessionContextEvent => ({ sessionID, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} })

describe('opencode: H17 one-time notices in the first model request of a root session', () => {
  test('the model line goes into one request only and the user gets a notification; subagents and later sessions get nothing', () => withSandbox(async ({ root }) => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    const { f, rt, notified } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: 'ses_child', parentID: 'ses_root', location: { directory: root } } })
    const child = request('ses_child')
    await f.trigger('session.context', child)
    expect(child.system.map(p => p.text).join('\n')).not.toContain('Buracle notice')
    await rt.handleEvent({ type: 'session.created', data: { sessionID: 'ses_root', location: { directory: root } } })
    const first = request('ses_root')
    await f.trigger('session.context', first)
    expect(first.system.map(p => p.text)).toContain('Buracle notice, shown once on this machine. Tell the user in one short line at the start of your next reply, do not ask anything about it, and carry on with their request:\n- A notice for OpenCode.')
    expect(notified).toEqual([{ title: 'Buracle', message: 'Buracle 0.0.1: A notice for OpenCode.' }])
    const second = request('ses_root')
    await f.trigger('session.context', second)
    expect(second.system.map(p => p.text).join('\n')).not.toContain('Buracle notice')
    await rt.handleEvent({ type: 'session.created', data: { sessionID: 'ses_other', location: { directory: root } } })
    const other = request('ses_other')
    await f.trigger('session.context', other)
    expect(other.system.map(p => p.text).join('\n')).not.toContain('Buracle notice')
    expect(notified.length).toBe(1)
  })))

  test('a session OpenCode created before this plugin started (a resumed one) claims nothing; a fresh session later still claims the notice once', () => withSandbox(async ({ root }) => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    const T0 = 1_800_000_000_000
    const { f, notified } = await runtime(root, () => T0)
    f.created['ses_old'] = T0 - 86_400_000
    const resumed = request('ses_old')
    await f.trigger('session.context', resumed)
    expect(resumed.system.map(p => p.text).join('\n')).not.toContain('Buracle notice')
    expect(notified).toEqual([])
    f.created['ses_new'] = T0 + 5_000
    const fresh = request('ses_new')
    await f.trigger('session.context', fresh)
    expect(fresh.system.map(p => p.text).join('\n')).toContain('Buracle notice, shown once on this machine.')
    expect(notified).toEqual([{ title: 'Buracle', message: 'Buracle 0.0.1: A notice for OpenCode.' }])
  })))
})

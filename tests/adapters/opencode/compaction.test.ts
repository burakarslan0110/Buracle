import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import type { SessionCompactionEvent, SessionContextEvent } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import * as paths from '../../../src/engine/paths'
import { withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const SID = 'ses_compact01'

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

const noProject = (cwd: string): WorkspaceInfo => ({ cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } })

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
  return { f, rt, mem }
}

const compaction = (): SessionCompactionEvent => ({ sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'compaction', system: [], messages: [], options: {}, tools: {} })

describe('opencode: session start, a prompt and a compaction spawn nothing', () => {
  test('the session record is started and touched through the bridge, the handoff is written, and no finalizer starts until the session ends', () => withSandbox(async ({ root }) => {
    const { f, rt, mem } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await f.trigger('session.prompt', { sessionID: SID, messageID: 'msg_p1', prompt: { text: 'from now on always run the tests before you commit' }, delivery: 'steer' })
    await f.trigger('session.compaction', compaction())
    await rt.handleEvent({ type: 'session.compaction.ended', data: { sessionID: SID, text: 'Summary', reason: 'auto' } })
    await rt.idle()
    expect(mem.started).toEqual([{ sid: SID, cwd: root }])
    expect(mem.prompts).toEqual([SID])
    expect(mem.handoffs).toHaveLength(1)
    expect(mem.finalized).toEqual([])
    await rt.handleEvent({ type: 'session.deleted', data: { sessionID: SID } })
    await rt.idle()
    expect(mem.finalized).toEqual([SID])
  }))
})

describe('opencode: H06/H07 keep the compaction state of this compaction only', () => {
  test('a later compaction whose handoff write fails drops the earlier handoff pointer, so the restore never offers it', () => withSandbox(async ({ root }) => {
    const { f, rt, mem } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    const restored = async () => {
      await rt.handleEvent({ type: 'session.compaction.ended', data: { sessionID: SID, text: 'Summary', reason: 'auto' } })
      const ctxEv: SessionContextEvent = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} }
      await f.trigger('session.context', ctxEv)
      return ctxEv.system.map(p => p.text).join('\n')
    }
    await f.trigger('session.compaction', compaction())
    expect(await restored()).toContain('Handoff memory with the open todos and state at compaction time: handoff-none')
    mem.handoff = async () => undefined
    await f.trigger('session.compaction', compaction())
    expect(await restored()).not.toContain('handoff-none')
    expect(readFileSync(join(paths.sessionDir('opencode', SID), 'opencode.json'), 'utf8')).not.toContain('handoff-none')
  }))
})

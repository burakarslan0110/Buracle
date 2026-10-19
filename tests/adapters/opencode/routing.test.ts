import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BuracleRuntime, createBuraclePlugin, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { routeUserPrompt } from '../../../src/adapters/opencode/runtime/routing'
import { defaultConfig } from '../../../src/core/config'
import { ROUTE_TEXT_MAX_BYTES, utf8Bytes } from '../../../src/core/policy/skill-router'
import type { CommandDefinition, EditableModel, PermissionEvaluation, PromptInput, SessionContextEvent, SessionPromptEvent, ToolExecuteAfter } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { SessionState } from '../../../src/core/plan/state'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import * as paths from '../../../src/engine/paths'
import { readFlow } from '../../../src/workflow/flow'
import { loadLedger } from '../../../src/workflow/ledger'
import { loadState, readTelemetry, saveState } from '../../../src/workflow/session-store'
import { canonicalDir, indexRecordFile } from '../../../src/workflow/workspace'
import { withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeModelEditor, fakeServerContext, type FakeContextOptions, testBaked } from './helpers'

const SID = 'ses_route01'

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function info(cwd: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } }, ...over }
}

interface Opts extends FakeContextOptions {
  workspace?: PluginDeps['workspace']
  now?: () => number
  settleMs?: number
}

async function runtime(dir: string, opts: Opts = {}) {
  const f = fakeServerContext(dir, opts)
  const mem = fakeMemory()
  const notices: Array<{ title: string, message: string }> = []
  const prepared: string[] = []
  const deps: PluginDeps = {
    baked: testBaked(), memory: mem, settleMs: opts.settleMs ?? 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: (title, message) => { notices.push({ title, message }) },
    workspace: opts.workspace ?? (async cwd => { prepared.push(cwd); return info(cwd) }),
    workspaceRead: async cwd => info(cwd),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  await rt.registerTransforms()
  return { f, mem, rt, notices, prepared, deps }
}

function prompt(text: string, over: Partial<SessionPromptEvent> = {}): SessionPromptEvent {
  return { sessionID: SID, messageID: 'msg_p', prompt: { text }, delivery: 'steer', ...over }
}

function ctxEvent(sid = SID): SessionContextEvent {
  return { sessionID: sid, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} }
}

async function contextTexts(f: Awaited<ReturnType<typeof runtime>>['f'], sid = SID): Promise<string[]> {
  const ev = ctxEvent(sid)
  await f.trigger('session.context', ev)
  return ev.system.map(p => p.text)
}

async function requestTexts(f: Awaited<ReturnType<typeof runtime>>['f'], ids: string[], sid = SID): Promise<string> {
  const ev = { ...ctxEvent(sid), messages: ids.map(id => ({ id, role: 'user', content: [{ type: 'text', text: `the text of ${id}` }] })) }
  await f.trigger('session.context', ev)
  return ev.system.map(p => p.text).join('\n')
}

function evaluation(action: string, resources: string[], callId: string, sid = SID): PermissionEvaluation {
  return { sessionID: sid, action, resources, effect: 'allow', source: { type: 'tool', messageID: 'msg_1', id: callId } }
}

function planState(): SessionState {
  return { v: 1, plan: { path: 'docs/plans/x.md', slug: 'x', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1 }, guard: { blocksForPlan: 0, blocksInChain: 0 } }
}

describe('H22 route.prompt: explicit asks are attached, the rest is routing text', () => {
  test('an explicit ask for a skill the host knows is attached to the prompt and announced in the request', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: ['research', 'plan-build'] })
    const ev = await f.trigger('session.prompt', prompt('use the research skill to compare bun and node'))
    expect(ev.prompt.skills).toEqual([{ id: 'research' }])
    const text = (await contextTexts(f)).find(t => t.startsWith('Buracle routing for this prompt:')) ?? ''
    expect(text).toContain('The user asked for the research skill: its skill is attached to this message')
    expect(loadLedger('opencode', SID).prompt?.route.invoked).toEqual(['research'])
  }))

  test('a skill the host does not know is never attached (it would reject the prompt): the model is told to load it', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: ['plan-build'] })
    const ev = await f.trigger('session.prompt', prompt('use the research skill to compare bun and node'))
    expect(ev.prompt.skills).toBeUndefined()
    const text = (await contextTexts(f)).find(t => t.startsWith('Buracle routing for this prompt:')) ?? ''
    expect(text).toContain('load it before any other step and follow it (skill tool, research)')
    expect(loadLedger('opencode', SID).prompt?.route.load).toEqual(['research'])
  }))

  test('an unavailable skill list attaches nothing and never blocks the prompt', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: undefined })
    const ev = await f.trigger('session.prompt', prompt('use the research skill to compare bun and node'))
    expect(ev.prompt.skills).toBeUndefined()
    expect((await contextTexts(f)).some(t => t.includes('skill tool, research'))).toBe(true)
  }))

  test('a workflow asked for again later in the session is attached again (a new run)', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: ['plan-build'] })
    expect((await f.trigger('session.prompt', prompt('use the plan-build workflow to add rate limiting'))).prompt.skills).toEqual([{ id: 'plan-build' }])
    await requestTexts(f, ['msg_p'])
    expect(loadLedger('opencode', SID).skills['plan-build']).toBeDefined()
    const again = await f.trigger('session.prompt', prompt('use the plan-build workflow to add an audit log', { messageID: 'msg_q' }))
    expect(again.prompt.skills).toEqual([{ id: 'plan-build' }])
    expect((await contextTexts(f)).find(t => t.startsWith('Buracle routing for this prompt:'))).toContain('The user asked for the plan-build workflow: its skill is attached to this message')
  }))

  test('the attach line counts toward the route text budget (core ROUTE_TEXT_MAX_BYTES)', () => {
    const baked = testBaked()
    const prompt = 'research this: last time we decided on zod, remember this. Which is the latest version of zod and how do I configure it? Also check the agent instructions and do a before and after comparison.'
    const r = routeUserPrompt({ text: prompt, attached: [], loaded: [], available: baked.mcp.map(m => m.id), deps: ['zod'], known: new Set(baked.skills.map(s => s.id)) }, baked, defaultConfig())
    expect(r.attach).toEqual(['research'])
    const text = r.text ?? ''
    expect(text.split('\n')[1]).toBe('- The user asked for the research skill: its skill is attached to this message; follow it, and treat the rest of the prompt as its input.')
    expect(text).toContain('- Earlier work: search memory first')
    expect(utf8Bytes(text)).toBeLessThanOrEqual(ROUTE_TEXT_MAX_BYTES)
  })

  test('a prompt with no match adds no routing text (the request prefix stays cache-stable)', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: ['research'] })
    await f.trigger('session.prompt', prompt('please add a cache'))
    expect((await contextTexts(f)).some(t => t.startsWith('Buracle routing'))).toBe(false)
  }))

  test('a subagent prompt (the orchestrator\'s words) is not routed and grants no consent', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root, { skills: ['research'] })
    const child = 'ses_child9'
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    const ev = await f.trigger('session.prompt', prompt('push et. use the research skill to compare bun and node', { sessionID: child }))
    expect(ev.prompt.skills).toBeUndefined()
    expect((await contextTexts(f, child)).some(t => t.startsWith('Buracle routing'))).toBe(false)
    const push = await f.trigger('permission.evaluate', evaluation('shell', ['git push origin main'], 'call_p1', child))
    expect(push.effect).toBe('deny')
  }))
})

describe('H22 prompt delivery: a prompt takes effect at the request that carries it (steer at the next step, queue when the run is done)', () => {
  const research = 'use the research skill to compare bun and deno'
  const history = 'what did we decide last time about the runtime?'

  test('a prompt queued while the agent works leaves the running prompt its routing and turn until the request that carries it', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: ['research'] })
    await f.trigger('session.prompt', prompt(history, { messageID: 'msg_1' }))
    expect(await requestTexts(f, ['msg_1'])).toContain('- Earlier work: search memory first')
    expect(loadLedger('opencode', SID)).toMatchObject({ turn: 1, prompt: { route: { memory: { recall: true } } } })
    const queued = await f.trigger('session.prompt', prompt(research, { messageID: 'msg_2', delivery: 'queue' }))
    expect(queued.prompt.skills).toEqual([{ id: 'research' }])
    const running = await requestTexts(f, ['msg_1'])
    expect(running).toContain('- Earlier work: search memory first')
    expect(running).not.toContain('research skill')
    expect(loadLedger('opencode', SID)).toMatchObject({ turn: 1, prompt: { route: { invoked: [], memory: { recall: true } } } })
    const next = await requestTexts(f, ['msg_1', 'msg_2'])
    expect(next).toContain('- The user asked for the research skill: its skill is attached to this message')
    expect(next).not.toContain('Earlier work')
    expect(loadLedger('opencode', SID)).toMatchObject({ turn: 2, prompt: { route: { invoked: ['research'], memory: { recall: false } } } })
  }))

  test('two prompts queued during a run keep their own routing: each takes effect when its request comes', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: ['research'] })
    await f.trigger('session.prompt', prompt('please add a cache', { messageID: 'msg_1' }))
    await requestTexts(f, ['msg_1'])
    await f.trigger('session.prompt', prompt(research, { messageID: 'msg_2', delivery: 'queue' }))
    await f.trigger('session.prompt', prompt(history, { messageID: 'msg_3', delivery: 'queue' }))
    expect(await requestTexts(f, ['msg_1'])).not.toContain('Buracle routing')
    const second = await requestTexts(f, ['msg_1', 'msg_2'])
    expect(second).toContain('research skill')
    expect(second).not.toContain('Earlier work')
    expect(loadLedger('opencode', SID)).toMatchObject({ turn: 2, prompt: { route: { invoked: ['research'] } } })
    const third = await requestTexts(f, ['msg_1', 'msg_2', 'msg_3'])
    expect(third).toContain('- Earlier work: search memory first')
    expect(third).not.toContain('research skill')
    expect(loadLedger('opencode', SID)).toMatchObject({ turn: 3, prompt: { route: { invoked: [], memory: { recall: true } } } })
  }))

  test('steer prompts sent during one step arrive together: one routing text and one ledger turn for both', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: ['research'] })
    await f.trigger('session.prompt', prompt('please add a cache', { messageID: 'msg_1' }))
    await requestTexts(f, ['msg_1'])
    await f.trigger('session.prompt', prompt(research, { messageID: 'msg_2' }))
    await f.trigger('session.prompt', prompt(history, { messageID: 'msg_3' }))
    const both = await requestTexts(f, ['msg_1', 'msg_2', 'msg_3'])
    expect(both.match(/Buracle routing for this prompt:/g)?.length).toBe(1)
    expect(both).toContain('- The user asked for the research skill: its skill is attached to this message')
    expect(both).toContain('- Earlier work: search memory first')
    expect(loadLedger('opencode', SID)).toMatchObject({ turn: 2, prompt: { route: { invoked: ['research'], memory: { recall: true } } } })
  }))

  test('the inbox\'s events: a cancelled prompt never takes effect, a delivered one does (also when a compaction folded its message), a moved one follows its new delivery', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root, { skills: ['research'] })
    await f.trigger('session.prompt', prompt(research, { messageID: 'msg_2', delivery: 'queue' }))
    await rt.handleEvent({ type: 'session.inbox.cancelled', data: { sessionID: SID, inboxID: 'msg_2' } })
    await f.trigger('session.prompt', prompt(history, { messageID: 'msg_3', delivery: 'queue' }))
    await rt.handleEvent({ type: 'session.inbox.delivered', data: { sessionID: SID, inboxID: 'msg_3' } })
    const folded = await requestTexts(f, ['msg_checkpoint'])
    expect(folded).toContain('- Earlier work: search memory first')
    expect(folded).not.toContain('research skill')
    expect(loadLedger('opencode', SID).turn).toBe(1)
    await f.trigger('session.prompt', prompt(research, { messageID: 'msg_4' }))
    await rt.handleEvent({ type: 'session.inbox.delivery.changed', data: { sessionID: SID, inboxID: 'msg_4', delivery: 'queue' } })
    expect((await contextTexts(f)).join('\n')).not.toContain('research skill')
    await rt.handleEvent({ type: 'session.inbox.delivery.changed', data: { sessionID: SID, inboxID: 'msg_4', delivery: 'steer' } })
    expect((await contextTexts(f)).join('\n')).toContain('research skill')
    expect(loadLedger('opencode', SID).turn).toBe(2)
  }))

  test('the turn-end check never holds a run to a prompt it did not carry: a prompt queued as the run ends waits for its own', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root)
    const cycle = async () => {
      await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
      await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
      await rt.idle()
    }
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await f.trigger('session.prompt', prompt('please add a cache', { messageID: 'msg_1' }))
    await requestTexts(f, ['msg_1'])
    await f.trigger('session.prompt', prompt('what did we decide last time about the cache?', { messageID: 'msg_2', delivery: 'queue' }))
    await cycle()
    expect(f.prompts).toEqual([])
    await requestTexts(f, ['msg_1', 'msg_2'])
    await cycle()
    expect(f.prompts.map(p => p.text.split('\n')[0])).toEqual(['Buracle routing check: this prompt asks about earlier work and memory was not searched. Run memory_search (buracle-memory) now, or say in one line why memory cannot help.'])
  }))
})

describe('H25 flow.track and the workflow commands', () => {
  test('every user-invocable skill is a /<id> command; protocol skills are not', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const ids = testBaked().skills.filter(s => s.userInvocable).map(s => s.id).sort()
    expect([...f.commands.keys()].sort()).toEqual(ids)
    expect(f.commands.has('memory')).toBe(false)
    expect(f.commands.has('buracle')).toBe(false)
    expect(f.commands.get('plan-build')?.description).toBeTruthy()
  }))

  test('/plan-build records the start at once, prompts with the skill attached and the user\'s words first; its prompt is routed as invoked', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: ['plan-build'] })
    const spec = f.commands.get('plan-build') as CommandDefinition
    const files = [{ uri: 'file:///x.ts', mention: { start: 0, end: 5, text: '@x.ts' } }]
    await spec.execute({ sessionID: SID, prompt: { text: '@x.ts add rate limiting\nmore detail', files }, delivery: 'steer' })
    expect(readFlow('opencode', SID)?.stack).toEqual([expect.objectContaining({ workflow: 'plan-build', source: 'command', title: '@x.ts add rate limiting' })])
    expect(f.prompts.length).toBe(1)
    const sent = f.prompts[0] as PromptInput
    expect(sent.skills).toEqual([{ id: 'plan-build' }])
    expect(sent.files).toEqual(files)
    expect(sent.text.startsWith('@x.ts add rate limiting\nmore detail\n\n')).toBe(true)
    expect(sent.text).toContain('its skill is attached above')
    await f.trigger('session.prompt', { sessionID: SID, messageID: 'msg_c', prompt: { text: sent.text, skills: sent.skills ?? [] }, delivery: 'steer', ...(sent.metadata !== undefined ? { metadata: sent.metadata } : {}) })
    expect((await contextTexts(f)).some(t => t.includes('The user asked for'))).toBe(false)
    expect(loadLedger('opencode', SID).skills['plan-build']).toBeDefined()
  }))

  test('without the skill in the host, /plan-build asks the model to load it and H23 holds it to that', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: [] })
    const spec = f.commands.get('plan-build') as CommandDefinition
    await spec.execute({ sessionID: SID, prompt: { text: 'add rate limiting' }, delivery: 'queue' })
    const sent = f.prompts[0] as PromptInput
    expect(sent.skills).toBeUndefined()
    expect(sent.delivery).toBe('queue')
    expect(sent.text).toContain('load the `plan-build` skill with the `skill` tool first')
    await f.trigger('session.prompt', { sessionID: SID, messageID: 'msg_c', prompt: { text: sent.text }, delivery: 'steer', ...(sent.metadata !== undefined ? { metadata: sent.metadata } : {}) })
    await requestTexts(f, ['msg_c'])
    expect(loadLedger('opencode', SID).prompt?.route.load).toEqual(['plan-build'])
  }))

  test('an explicit ask in a prompt and a model skill load start the workflow too (source prompt / skill)', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { skills: ['ab-test', 'research'] })
    await f.trigger('session.prompt', prompt('use the ab-test skill on the router'))
    expect(readFlow('opencode', SID)?.stack[0]).toMatchObject({ workflow: 'ab-test', source: 'prompt', title: 'use the ab-test skill on the router' })
    const other = 'ses_route02'
    await f.trigger('tool.execute.before', { tool: 'skill', sessionID: other, agent: 'build', messageID: 'msg_1', id: 'call_sk', input: { id: 'research' } })
    expect(readFlow('opencode', other)?.stack[0]).toMatchObject({ workflow: 'research', source: 'skill' })
    expect(loadLedger('opencode', other).skills['research']?.n).toBe(1)
  }))

  test('a host that activates a skill itself (session.skill.activated) counts as a load', () => withSandbox(async ({ root }) => {
    const { rt } = await runtime(root)
    await rt.handleEvent({ type: 'session.skill.activated', data: { sessionID: SID, id: 'research', name: 'research', text: '...' } })
    expect(loadLedger('opencode', SID).skills['research']?.n).toBe(1)
    expect(readFlow('opencode', SID)?.stack[0]).toMatchObject({ workflow: 'research', source: 'skill' })
  }))

  test('an older host without plugin commands gets none and nothing throws', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { legacy: true })
    expect(f.commands.size).toBe(0)
  }))
})

describe('H26 profile signals and H14 capture', () => {
  test('a user prompt spools its profile signals; a workflow command adds the workflow and skill usage', () => withSandbox(async ({ root }) => {
    const { f, mem } = await runtime(root, { skills: ['plan-build'] })
    await f.trigger('session.prompt', prompt('from now on always run the tests before you commit'))
    const keys = () => mem.appended.flatMap(a => a.entries).filter(e => e.ev === 'signal').map(e => e.signal?.key)
    expect(keys()).toContain('quality.tests=always')
    const spec = f.commands.get('plan-build') as CommandDefinition
    await spec.execute({ sessionID: SID, prompt: { text: 'add rate limiting' }, delivery: 'steer' })
    const sent = f.prompts[0] as PromptInput
    await f.trigger('session.prompt', { sessionID: SID, messageID: 'msg_c', prompt: { text: sent.text, skills: sent.skills ?? [] }, delivery: 'steer', ...(sent.metadata !== undefined ? { metadata: sent.metadata } : {}) })
    expect(keys()).toContain('usage.workflow=plan-build')
    expect(keys()).toContain('usage.skill=plan-build')
  }))

  test('MCP, web and skill calls are spooled by name (metadata only)', () => withSandbox(async ({ root }) => {
    const { f, mem } = await runtime(root)
    const after = (tool: string, id: string, input: Record<string, unknown>): ToolExecuteAfter => ({ tool, sessionID: SID, agent: 'build', messageID: 'msg_1', id, input, status: 'completed', result: { output: 'x', content: [{ type: 'text', text: 'x' }] } })
    for (const [tool, id, input] of [['context7_query-docs', 'c1', { libraryId: '/x/y' }], ['websearch', 'c2', { query: 'bun' }], ['skill', 'c3', { id: 'research' }]] as const) {
      await f.trigger('tool.execute.before', { tool, sessionID: SID, agent: 'build', messageID: 'msg_1', id, input })
      await f.trigger('tool.execute.after', after(tool, id, input))
    }
    const tools = mem.appended.flatMap(a => a.entries).filter(e => e.ev === 'tool').map(e => [e.tool, e.kind])
    expect(tools).toEqual([['context7_query-docs', 'mcp'], ['websearch', 'web_search'], ['skill', 'other']])
  }))
})

describe('H24 usage ledger: reminders and the deny-once gates (reported as H03)', () => {
  test('an edit that adds an import context7 was not asked about is denied once; the retry runs', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const input = { path: 'src/a.ts', oldString: '', newString: "import { z } from 'zod'\n" }
    await f.trigger('tool.execute.before', { tool: 'edit', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_e1', input })
    const denied = await f.trigger('permission.evaluate', evaluation('edit', [join(root, 'src/a.ts')], 'call_e1'))
    expect(denied.effect).toBe('deny')
    expect(denied.message).toStartWith('[Buracle H03 route.tools] Buracle: this edit adds an import of `zod`')
    await f.trigger('tool.execute.before', { tool: 'edit', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_e2', input })
    expect((await f.trigger('permission.evaluate', evaluation('edit', [join(root, 'src/a.ts')], 'call_e2'))).effect).toBe('allow')
  }))

  test('a semble repo or codegraph projectPath at the home folder is denied every time and names the project root', () => withSandbox(async ({ root, home }) => {
    const project = join(root, 'proj')
    const { f, rt } = await runtime(root, { workspace: async cwd => info(cwd, { root: project }) })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.idle()
    for (const id of ['call_s1', 'call_s2']) {
      await f.trigger('tool.execute.before', { tool: 'semble_search', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: { query: 'x', repo: home } })
      const ev = await f.trigger('permission.evaluate', evaluation('semble_search', ['*'], id))
      expect(ev.effect).toBe('deny')
      expect(ev.message).toContain(`Pass the project root ${project} instead`)
    }
  }))

  test('the root check is the one every harness uses: a folder of projects, a parent of home and index.exclude names are denied', () => withSandbox(async ({ root }) => {
    const file = paths.runtimeConfigFile()
    mkdirSync(join(file, '..'), { recursive: true })
    const cfg = structuredClone(testBaked().defaults)
    cfg.index.exclude = ['vendor']
    writeFileSync(file, JSON.stringify({ v: 1, config: cfg }))
    const dev = join(root, 'dev')
    const alpha = join(dev, 'alpha')
    mkdirSync(join(alpha, 'vendor'), { recursive: true })
    const { f, rt } = await runtime(root, { workspace: async cwd => info(cwd, { children: [alpha, join(dev, 'beta')] }) })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: dev } } })
    await rt.idle()
    let n = 0
    const verdict = async (repo: string) => {
      const id = `call_r${++n}`
      await f.trigger('tool.execute.before', { tool: 'semble_search', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: { query: 'x', repo } })
      return f.trigger('permission.evaluate', evaluation('semble_search', ['*'], id))
    }
    expect((await verdict(dev)).message).toContain('a folder of projects, not a project')
    expect((await verdict(root)).message).toContain('a parent of your home folder')
    expect((await verdict(join(alpha, 'vendor'))).message).toContain('excluded by index.exclude (vendor)')
    expect((await verdict(alpha)).effect).toBe('allow')
  }))

  test('R3 follows the codegraph index as it is now: an index built after the session started arms the gate', () => withSandbox(async ({ root }) => {
    const project = join(root, 'proj')
    mkdirSync(join(project, 'src'), { recursive: true })
    const { f, rt } = await runtime(root, { workspace: async cwd => info(cwd, { root: project, index: { codegraph: { state: 'building', since: Date.now() }, semble: { state: 'off' } } }) })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: project } } })
    await rt.idle()
    mkdirSync(join(project, '.codegraph'), { recursive: true })
    writeFileSync(join(project, '.codegraph', 'codegraph.db'), '')
    const input = { path: join(project, 'src', 'api.ts'), oldString: 'export function load(id: string): Item {', newString: 'export function load(id: string, opts: Opts): Item {' }
    await f.trigger('tool.execute.before', { tool: 'edit', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_g1', input })
    const denied = await f.trigger('permission.evaluate', evaluation('edit', [input.path], 'call_g1'))
    expect(denied.effect).toBe('deny')
    expect(denied.message).toContain('codegraph has not been asked about it')
  }))

  test('R4 reads the members of an npm workspace: an import of a member\'s dependency is gated', () => withSandbox(async ({ root }) => {
    const mono = join(root, 'mono')
    mkdirSync(join(mono, 'packages', 'app', 'src'), { recursive: true })
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'], devDependencies: { turbo: '2', typescript: '6' } }))
    writeFileSync(join(mono, 'packages', 'app', 'package.json'), JSON.stringify({ name: 'app', dependencies: { 'lodash-es': '4', zod: '4' } }))
    const { f, rt } = await runtime(root, { workspace: async cwd => info(cwd, { root: mono }) })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: mono } } })
    await rt.idle()
    const input = { path: join(mono, 'packages', 'app', 'src', 'a.ts'), oldString: 'export const a = 1', newString: "import { debounce } from 'lodash-es'\nexport const a = 1" }
    await f.trigger('tool.execute.before', { tool: 'edit', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_m1', input })
    const denied = await f.trigger('permission.evaluate', evaluation('edit', [input.path], 'call_m1'))
    expect(denied.effect).toBe('deny')
    expect(denied.message).toContain('this edit adds an import of `lodash-es`')
  }))

  test('path rules (R5): the first read of a matching file carries the rule; the first edit of an undelivered one is denied once with it', () => withSandbox(async ({ root }) => {
    const rules = paths.pathRulesDir()
    mkdirSync(rules, { recursive: true })
    writeFileSync(join(rules, 'frontend.md'), '---\npaths:\n  - "**/*.tsx"\n---\n# Frontend\n\n- Semantic elements first.\n')
    writeFileSync(join(rules, 'typescript.md'), '---\npaths:\n  - "**/*.ts"\n---\n# TypeScript\n\n- Keep strict on.\n')
    writeFileSync(join(rules, 'go.md'), '# Go\n\n- Format with gofmt.\n')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'App.tsx'), 'export const App = () => null\n')
    const { f } = await runtime(root)
    const readInput = { filePath: join(root, 'src', 'App.tsx') }
    await f.trigger('tool.execute.before', { tool: 'read', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_pr1', input: readInput })
    const after: ToolExecuteAfter = { tool: 'read', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_pr1', input: readInput, status: 'completed', result: { output: 'content', content: [{ type: 'text', text: 'content' }] } }
    await f.trigger('tool.execute.after', after)
    const texts = after.status === 'completed' ? (after.result.content as unknown as Array<{ text: string }>).map(c => c.text).join('\n') : ''
    expect(texts).toContain('src/App.tsx matches the path rules `frontend`, `typescript`; follow them when you change files like this one.')
    expect(texts).toContain('# Frontend\n\n- Semantic elements first.')
    const edit = { filePath: join(root, 'src', 'App.tsx'), oldString: 'null', newString: 'undefined' }
    await f.trigger('tool.execute.before', { tool: 'edit', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_pe1', input: edit })
    expect((await f.trigger('permission.evaluate', evaluation('edit', [edit.filePath], 'call_pe1'))).effect).toBe('allow')
    const go = { filePath: join(root, 'cmd', 'main.go'), content: 'package main\n' }
    await f.trigger('tool.execute.before', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_pw1', input: go })
    const denied = await f.trigger('permission.evaluate', evaluation('edit', [go.filePath], 'call_pw1'))
    expect(denied.effect).toBe('deny')
    expect(denied.message).toStartWith('[Buracle H03 route.tools] Buracle: cmd/main.go matches the path rule `go`, which this session has not read yet.')
    expect(denied.message).toContain('# Go\n\n- Format with gofmt.')
    await f.trigger('tool.execute.before', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_pw2', input: go })
    expect((await f.trigger('permission.evaluate', evaluation('edit', [go.filePath], 'call_pw2'))).effect).toBe('allow')
  }))

  test('a reminder goes into the tool result: a history question whose turn starts without memory', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    await f.trigger('session.prompt', prompt('what did we decide last time about the cache?'))
    await requestTexts(f, ['msg_p'])
    await f.trigger('tool.execute.before', { tool: 'read', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_r', input: { path: 'a.ts' } })
    const after: ToolExecuteAfter = { tool: 'read', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_r', input: { path: 'a.ts' }, status: 'completed', result: { output: 'content', content: [{ type: 'text', text: 'content' }] } }
    await f.trigger('tool.execute.after', after)
    const texts = after.status === 'completed' ? (after.result.content as unknown as Array<{ text: string }>).map(c => c.text) : []
    expect(texts[0]).toBe('content')
    expect(texts.join('\n')).toContain('Buracle: this prompt asks about earlier work; before anything else')
  }))
})

describe('H24 MCP results and the session\'s health (core ledgerMcpResult, sessionMcpHealth, mcpHealthOf)', () => {
  type F = Awaited<ReturnType<typeof runtime>>['f']
  let n = 0
  async function call(f: F, tool: string, input: Record<string, unknown>, ok: boolean, resources = ['*']): Promise<{ ev: PermissionEvaluation, after: ToolExecuteAfter }> {
    const id = `call_h${n++}`
    const base = { tool, sessionID: SID, agent: 'build', messageID: 'msg_1', id, input }
    await f.trigger('tool.execute.before', base)
    const ev = await f.trigger('permission.evaluate', evaluation(tool, resources, id))
    const after: ToolExecuteAfter = ev.effect === 'deny' || !ok
      ? { ...base, status: 'error', error: { message: ev.message ?? 'MCP server "web-search" answered: search index unavailable' } }
      : { ...base, status: 'completed', result: { output: 'results', content: [{ type: 'text', text: 'results' }] } }
    await f.trigger('tool.execute.after', after)
    return { ev, after }
  }
  const webSearch = (f: F) => call(f, 'websearch', { query: 'bun 1.4 release notes' }, true, ['bun 1.4 release notes'])
  const failSearch = (f: F) => call(f, 'web-search_search', { query: 'bun 1.4 release notes' }, false)
  const failFetch = (f: F) => call(f, 'web-fetch_fetch_url', { url: 'https://html.duckduckgo.com/html/?q=bun+1.4' }, false)

  test('two failed web-search calls send the built-in websearch to web-fetch, two failed web-fetch calls let it through with the fallback note; a success resets the count', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    await failSearch(f)
    expect((await webSearch(f)).ev.message).toContain('web-search_search')
    await failSearch(f)
    expect(loadLedger('opencode', SID).mcpErrors).toEqual({ 'web-search': 2 })
    const redirected = (await webSearch(f)).ev
    expect(redirected.effect).toBe('deny')
    expect(redirected.message).toContain('web-fetch_fetch_url')
    await failFetch(f)
    await failFetch(f)
    const { ev, after } = await webSearch(f)
    expect(ev.effect).toBe('allow')
    const text = after.status === 'completed' ? JSON.stringify(after.result.content) : ''
    expect(text).toContain('MCP server is down, so the built-in web search is allowed as a fallback; mention the fallback in your report.')
    await call(f, 'web-search_search', { query: 'bun 1.4 release notes' }, true)
    expect(loadLedger('opencode', SID).mcpErrors).toEqual({ 'web-fetch': 2 })
    expect((await webSearch(f)).ev.message).toContain('web-search_search')
  }))

  test('a call Buracle denied fails at the host too, but it is no failure of the server', () => withSandbox(async ({ root, home }) => {
    const { f } = await runtime(root)
    for (let i = 0; i < 2; i++) {
      const { ev, after } = await call(f, 'semble_search', { query: 'where is auth', repo: home }, true)
      expect(ev.effect).toBe('deny')
      expect(after.status).toBe('error')
    }
    expect(loadLedger('opencode', SID).mcpErrors).toBeUndefined()
  }))

  test('a failed start in health.json holds until its `until` by the plugin\'s clock, without a change of the file', () => withSandbox(async ({ root, buracleHome }) => {
    let t = Date.UTC(2026, 9, 10, 12, 0, 0)
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(join(buracleHome, 'state', 'health.json'), JSON.stringify({ v: 1, mcp: { 'web-search': { status: 'down', source: 'launch', until: new Date(t + 60_000).toISOString() } } }))
    const { f } = await runtime(root, { now: () => t })
    expect((await webSearch(f)).ev.message).toContain('web-fetch_fetch_url')
    t += 60_000
    expect((await webSearch(f)).ev.message).toContain('web-search_search')
  }))
})

describe('H23 route.audit: one re-prompt after the turn', () => {
  const cycle = async (rt: BuracleRuntime) => {
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await rt.idle()
  }

  test('a history question answered without memory gets one routing check; the next stop of the same prompt is free', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await f.trigger('session.prompt', prompt('what did we decide last time about the cache?'))
    await requestTexts(f, ['msg_p'])
    await cycle(rt)
    expect(f.prompts.length).toBe(1)
    expect(f.prompts[0]?.text).toStartWith('Buracle routing check: this prompt asks about earlier work and memory was not searched.')
    expect(f.prompts[0]?.metadata).toMatchObject({ 'buracle.continue': true, hook: 'H23' })
    await f.trigger('session.prompt', prompt(f.prompts[0]?.text ?? '', { metadata: f.prompts[0]?.metadata ?? {} }))
    await cycle(rt)
    expect(f.prompts.length).toBe(1)
  }))

  test('memory searched in the turn: no routing check', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await f.trigger('session.prompt', prompt('what did we decide last time about the cache?'))
    await requestTexts(f, ['msg_p'])
    await f.trigger('tool.execute.before', { tool: 'buracle-memory_memory_search', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_m', input: { query: 'cache decision' } })
    await cycle(rt)
    expect(f.prompts).toEqual([])
  }))

  test('a paused plan holds the session: no routing check while the user asked to stop', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const { f, rt } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await f.trigger('session.prompt', prompt('stop, what did we decide last time?'))
    expect(loadState('opencode', SID).interaction?.state).toBe('paused')
    await requestTexts(f, ['msg_p'])
    await cycle(rt)
    expect(f.prompts).toEqual([])
  }))

  test('a finished plan no longer holds the session: the routing check runs (core routeAuditAllowed)', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, { v: 1, plan: { path: 'docs/plans/x.md', slug: 'x', status: 'VERIFIED', type: 'Feature', phase: 'done', registeredAt: 1 }, guard: { blocksForPlan: 0, blocksInChain: 0 } })
    const { f, rt } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await f.trigger('session.prompt', prompt('what did we decide last time about the cache?'))
    await requestTexts(f, ['msg_p'])
    await cycle(rt)
    expect(f.prompts.map(p => p.text.split('\n')[0])).toEqual(['Buracle routing check: this prompt asks about earlier work and memory was not searched. Run memory_search (buracle-memory) now, or say in one line why memory cannot help.'])
  }))
})

describe('H10 control guidance (English on every harness)', () => {
  test('stop without a plan: the agent is told to stop; with a plan the plan pauses too; continue resumes it', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    await f.trigger('session.prompt', prompt('stop'))
    expect(await contextTexts(f)).toContain('Buracle: the user asked you to stop. Finish only the current atomic step, say where you stopped, and wait for them. Also stop the background commands and subagents this session started (with the harness\'s stop control; if it has none, name the exact command or key and wait). A list of other sessions does not prove that nothing runs.')
    saveState('opencode', SID, planState())
    await f.trigger('session.prompt', prompt('dur'))
    expect(loadState('opencode', SID).interaction?.state).toBe('paused')
    expect((await contextTexts(f)).some(t => t.includes('The active plan is now paused'))).toBe(true)
    await f.trigger('session.prompt', prompt('devam'))
    expect(loadState('opencode', SID).interaction?.state).toBe('running')
    expect((await contextTexts(f)).some(t => t.startsWith('Buracle: the user said to continue.'))).toBe(true)
    const all = (await contextTexts(f)).join('\n')
    expect(/[çğıöşüÇĞİÖŞÜ]/.test(all)).toBe(false)
  }))
})

describe('H21 workspace.prepare: per session, throttled per directory', () => {
  test('a new root session prepares its directory once (a second session there reuses it); the lines are in every request', () => withSandbox(async ({ root }) => {
    const project = join(root, 'proj')
    const calls: string[] = []
    const { f, rt } = await runtime(root, { workspace: async cwd => { calls.push(cwd); return info(cwd, { root: project, index: { codegraph: { state: 'ready' }, semble: { state: 'ready' } } }) } })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: project } } })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: 'ses_route03', location: { directory: project } } })
    await rt.idle()
    expect(calls).toEqual([project])
    const texts = await contextTexts(f)
    expect(texts.some(t => t.startsWith(`Project root: ${project}. Pass it as codegraph \`projectPath\` and semble \`repo\``))).toBe(true)
    expect(await contextTexts(f)).toEqual(texts)
  }))

  test('a codegraph index that became ready since the session started is mentioned on the next prompt', () => withSandbox(async ({ root }) => {
    const project = join(root, 'proj')
    mkdirSync(join(project, '.codegraph'), { recursive: true })
    const { f, rt } = await runtime(root, { workspace: async cwd => info(cwd, { root: canonicalDir(project), index: { codegraph: { state: 'building', since: Date.now() }, semble: { state: 'off' } } }) })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: project } } })
    await rt.idle()
    writeFileSync(join(project, '.codegraph', 'codegraph.db'), '')
    mkdirSync(paths.indexStateDir(), { recursive: true })
    writeFileSync(indexRecordFile(project), JSON.stringify({ v: 1, root: canonicalDir(project), codegraph: { at: Date.now(), ok: true } }))
    await f.trigger('session.prompt', prompt('go on with the parser'))
    expect((await contextTexts(f)).some(t => t.startsWith(`The codegraph index of ${canonicalDir(project)} is ready now`))).toBe(true)
  }))
})

describe('H19 review.gate on the subagent tool result', () => {
  const run = async (f: Awaited<ReturnType<typeof runtime>>['f'], id: string, output: string) => {
    const input = { agent: 'plan-build-review', description: 'review', prompt: 'review the plan' }
    await f.trigger('tool.execute.before', { tool: 'subagent', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input })
    const after: ToolExecuteAfter = {
      tool: 'subagent', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input, status: 'completed',
      result: { output: { sessionID: 'ses_rev1', status: 'completed', output }, content: `<subagent sessionID="ses_rev1" state="completed">\n${output}\n</subagent>` },
    }
    await f.trigger('tool.execute.after', after)
    if (after.status !== 'completed') return ''
    const content = after.result.content
    return typeof content === 'string' ? content : (content as Array<{ text: string }> | undefined ?? []).map(c => c.text).join('\n')
  }

  test('an invalid report asks the orchestrator to continue that reviewer once; a second one only warns; a valid one adds nothing', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const first = await run(f, 'call_v1', 'Looks fine to me.')
    expect(first).toContain('Buracle H19 (review.gate): the plan-build-review report is not valid review JSON')
    expect(first).toContain('sessionID ses_rev1')
    const second = await run(f, 'call_v2', 'Still fine.')
    expect(second).toContain('It failed twice; check its findings yourself')
    const valid = JSON.stringify({ verdict: 'pass', summary: 'docs/plans/x.md: the plan covers the request.', findings: [] })
    expect(await run(f, 'call_v3', valid)).not.toContain('Buracle H19')
  }))

  test('with a plan bound to the lead session, a report about another file goes back to that reviewer', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    saveState('opencode', SID, { v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 }, plan: { path: '/abs/repo/docs/plans/x.md', slug: 'x', status: 'PENDING', type: 'Feature', phase: 'plan', registeredAt: 1 } })
    const other = await run(f, 'call_s1', JSON.stringify({ verdict: 'pass', summary: 'docs/plans/y.md: fine.', findings: [] }))
    expect(other).toContain('must start with the reviewed path (/abs/repo/docs/plans/x.md)')
    expect(await run(f, 'call_s2', JSON.stringify({ verdict: 'pass', summary: 'docs/plans/x.md: fine.', findings: [] }))).not.toContain('Buracle H19')
  }))
})

describe('default effort and H17', () => {
  test('the model transform gives every model with the configured variant that default; telemetry reports it', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root)
    expect(f.modelTransforms.length).toBe(1)
    const models: EditableModel[] = [
      { id: 'claude-opus-5-5', providerID: 'anthropic', settings: { thinking: { type: 'enabled' } }, variants: [{ id: 'high', settings: { effort: 'high' } }, { id: 'xhigh', settings: { effort: 'xhigh', thinking: { type: 'adaptive' } } }] },
      { id: 'gpt-x', providerID: 'openai', variants: [{ id: 'xhigh', settings: { reasoningEffort: 'xhigh' }, body: { include: ['reasoning.encrypted_content'] } }] },
      { id: 'old', providerID: 'anthropic', variants: [{ id: 'high', settings: { effort: 'high' } }] },
    ]
    f.modelTransforms[0]?.(fakeModelEditor(models))
    expect(models[0]?.settings).toEqual({ thinking: { type: 'adaptive' }, effort: 'xhigh' })
    expect(models[1]).toMatchObject({ settings: { reasoningEffort: 'xhigh' }, body: { include: ['reasoning.encrypted_content'] } })
    expect(models[2]?.settings).toBeUndefined()
    await rt.handleEvent({ type: 'session.step.started', data: { sessionID: SID, model: { id: 'claude-opus-5-5', providerID: 'anthropic', variant: 'default' } } })
    await rt.handleEvent({ type: 'session.usage.updated', data: { sessionID: SID, cost: 0.1 } })
    expect(readTelemetry('opencode', SID)?.effort).toBe('xhigh')
  }))

  test('effort.opencode keep leaves the models alone', () => withSandbox(async ({ root }) => {
    const file = paths.runtimeConfigFile()
    mkdirSync(join(file, '..'), { recursive: true })
    const cfg = structuredClone(testBaked().defaults)
    cfg.effort.opencode = 'keep'
    writeFileSync(file, JSON.stringify({ v: 1, config: cfg }))
    const { f } = await runtime(root)
    const models: EditableModel[] = [{ id: 'm', providerID: 'p', variants: [{ id: 'xhigh', settings: { effort: 'xhigh' } }] }]
    f.modelTransforms[0]?.(fakeModelEditor(models))
    expect(models[0]?.settings).toBeUndefined()
  }))

  test('H17: a plugin loaded from another config dir than the installed one warns once per service process', () => withSandbox(async ({ root }) => {
    const file = paths.runtimeConfigFile()
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ v: 1, config: testBaked().defaults, resolved: { opencodeConfigDir: join(root, 'installed', 'opencode') } }))
    const pluginDir = join(root, 'other', 'opencode', 'plugins', 'buracle')
    const notices: string[] = []
    const deps: PluginDeps = { baked: testBaked(), memory: fakeMemory(), settleMs: 0, capture: () => true, maint: () => ({ removed: [] }), pluginDir, notify: (_t, m) => { notices.push(m) }, workspace: async cwd => info(cwd) }
    for (let i = 0; i < 2; i++) {
      const stop = await createBuraclePlugin(deps).setup(fakeServerContext(root).ctx)
      if (typeof stop === 'function') await (stop as () => Promise<void>)()
    }
    expect(notices.length).toBe(1)
    expect(notices[0]).toContain(join(root, 'other', 'opencode'))
    expect(notices[0]).toContain('buracle install opencode')
  }))
})

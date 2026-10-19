import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, defaultDeps, type ExtensionDeps } from '../../../src/adapters/omp/runtime/extension'
import { FLOW_WIDGET_KEY } from '../../../src/adapters/omp/runtime/flow-widget'
import { PROMPT_MESSAGE_TYPE } from '../../../src/adapters/omp/runtime/prompt'
import { planModeOn } from '../../../src/adapters/omp/runtime/stop'
import type { OmpGenerated } from '../../../src/adapters/omp/runtime/types'
import * as coreCheckers from '../../../src/core/checkers'
import { checkWrite } from '../../../src/core/policy/write-guard'
import { CONTROL_GUIDANCE, detectIntent, isGuardContinuation } from '../../../src/core/policy/intents'
import { applyIntent, stopGuardVerdict, type StopWhy } from '../../../src/core/plan/state'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import { contextWarning } from '../../../src/core/status/context'
import { routeTool } from '../../../src/core/policy/routing'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { loadLedger } from '../../../src/workflow/ledger'
import { readFlow } from '../../../src/workflow/flow'
import { reviewNotesNotice } from '../../../src/adapters/shared/review-notes'
import { loadState, saveState } from '../../../src/workflow/session-store'
import { withEnv, withSandbox, type Sandbox } from '../../helpers/sandbox'
import { fakeCtx, fakePi, planState, testDeps, testGenerated, type FakeCtx } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'
const ESC = String.fromCharCode(27)
const plain = (s: string) => s.split(ESC).map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;]*m/, ''))).join('')

function realPolicy(over: Partial<ExtensionDeps['policy']> = {}): ExtensionDeps['policy'] {
  return { ...testDeps().deps.policy!, checkBash: () => ({}), checkWrite: () => ({}), routeTool: () => ({ action: 'allow' }), capabilityCard: () => '', checkQuestion: () => ({}), detectIntent, isGuardContinuation, ...over }
}

function setup(sb: Sandbox, overrides: Partial<ExtensionDeps> = {}, ctxOpts: Partial<Parameters<typeof fakeCtx>[0]> = {}, data: OmpGenerated = testGenerated()) {
  const cwd = join(sb.root, 'work')
  mkdirSync(cwd, { recursive: true })
  const t = testDeps({ policy: realPolicy(), plan: { ...testDeps().deps.plan!, applyIntent }, ...overrides })
  const fp = fakePi({ thinking: 'high' })
  createBuracleExtension(data, t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID, ...ctxOpts })
  return { ...t, fp, ctx, cwd }
}

const input = (text: string) => ({ type: 'input', text, source: 'interactive' })
const agentStart = (prompt: string) => ({ type: 'before_agent_start', prompt, systemPrompt: [] as string[] })
const toolCall = (toolName: string, inputArgs: Record<string, unknown>, id = '1') => ({ type: 'tool_call', toolCallId: id, toolName, input: inputArgs })
const toolResult = (toolName: string, inputArgs: Record<string, unknown>) => ({ type: 'tool_result', toolCallId: '1', toolName, input: inputArgs, content: [], isError: false })
const stop = { type: 'session_stop', turn_id: 1, session_id: SID, stop_hook_active: false }

async function hidden(fp: ReturnType<typeof fakePi>, ctx: FakeCtx, prompt: string): Promise<string | undefined> {
  const r = await fp.emit('before_agent_start', agentStart(prompt), ctx) as { message?: { customType: string, content: string } } | undefined
  if (r?.message !== undefined) expect(r.message.customType).toBe(PROMPT_MESSAGE_TYPE)
  return r?.message?.content
}

const flowWidgets = (ctx: FakeCtx) => ctx.uiCalls.filter(c => c.method === 'setWidget' && c.args[0] === FLOW_WIDGET_KEY)

describe('omp H22 route.prompt and H23 route.audit', () => {
  test('an explicit ask loads the skill (hidden message), the ledger keeps the route, and the stop is held once until it is loaded', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    await fp.emit('input', input('use the plan-build workflow to add rate limiting'), ctx)
    const text = await hidden(fp, ctx, 'use the plan-build workflow to add rate limiting')
    expect(text).toBe('Buracle routing for this prompt:\n- The user asked for the plan-build skill: load it before any other step and follow it (read skill://plan-build); the rest of the prompt is its input.')
    expect(loadLedger('omp', SID).prompt?.route.load).toEqual(['plan-build'])
    const held = await fp.emit('session_stop', stop, ctx) as { decision: string, reason: string }
    expect(held).toEqual({ decision: 'block', reason: 'Buracle routing check: the user asked for plan-build and it was not loaded. Load it now and follow it, or say in one line why it does not apply.' })
    expect(isGuardContinuation(held.reason)).toBe(true)
    expect(await fp.emit('session_stop', { ...stop, stop_hook_active: true }, ctx)).toBeUndefined()
  }))

  test('the stop goes through once the model read skill://<id>; routing.strictness off never audits', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    await fp.emit('input', input('use the plan-build workflow to add rate limiting'), ctx)
    await fp.emit('tool_call', toolCall('read', { path: 'skill://plan-build' }), ctx)
    expect(loadLedger('omp', SID).skills['plan-build']?.n).toBe(1)
    expect(await fp.emit('session_stop', stop, ctx)).toBeUndefined()
    const off = setup(sb, { config: d => ({ config: { ...d, routing: { ...d.routing, strictness: 'off' } }, vault: '/v', shim: '/s', source: 'defaults' }) }, { sid: '01a118a8-8d01-740c-9360-cccccccccccc' })
    await off.fp.emit('input', input('use the plan-build workflow now'), off.ctx)
    expect(await off.fp.emit('session_stop', { ...stop, session_id: '01a118a8-8d01-740c-9360-cccccccccccc' }, off.ctx)).toBeUndefined()
  }))

  test('H23 runs only where the plan does not hold the session (core routeAuditAllowed): never after the user paused it, while it waits for the user, or after a runaway release', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { plan: { ...testDeps().deps.plan!, applyIntent, stopGuardVerdict } })
    saveState('omp', SID, planState())
    await fp.emit('input', input('stop, what did we decide last time?'), ctx)
    expect(loadState('omp', SID).interaction?.state).toBe('paused')
    expect(await fp.emit('session_stop', stop, ctx)).toBeUndefined()
    const after = async (why: StopWhy, n: number): Promise<unknown> => {
      const sid = `01a118a8-8d01-740c-9360-${String(n).padStart(12, '0')}`
      const t = setup(sb, { plan: { ...testDeps().deps.plan!, applyIntent, stopGuardVerdict: s => ({ decision: { action: 'allow' }, next: s, why }) } }, { sid })
      saveState('omp', sid, planState())
      await t.fp.emit('input', input('why did we pick bun over node last time?'), t.ctx)
      await t.fp.emit('before_agent_start', agentStart('why did we pick bun over node last time?'), t.ctx)
      return t.fp.emit('session_stop', { ...stop, session_id: sid, stop_hook_active: true }, t.ctx)
    }
    let n = 0
    for (const why of ['paused', 'awaiting-approval', 'question', 'runaway-plan', 'runaway-chain'] as StopWhy[]) expect({ why, out: await after(why, ++n) }).toEqual({ why, out: undefined })
    for (const why of ['finished', 'disabled'] as StopWhy[]) {
      const out = await after(why, ++n) as { decision?: string, reason?: string } | undefined
      expect({ why, decision: out?.decision }).toEqual({ why, decision: 'block' })
      expect(out?.reason).toStartWith('Buracle routing check: this prompt asks about earlier work and memory was not searched.')
    }
  }))

  test('a pause with a plan gets the English guidance first, then the route; routing.skills off drops the skill line', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    saveState('omp', SID, planState())
    await fp.emit('input', input('dur, use the plan-build workflow afterwards'), ctx)
    const text = await hidden(fp, ctx, 'x') as string
    expect(text.startsWith(CONTROL_GUIDANCE.pausePlan)).toBe(true)
    expect(text).toContain('read skill://plan-build')
    const off = setup(sb, { config: d => ({ config: { ...d, routing: { ...d.routing, skills: 'off' } }, vault: '/v', shim: '/s', source: 'defaults' }) }, { sid: '01a118a8-8d01-740c-9360-dddddddddddd' })
    await off.fp.emit('input', input('use the plan-build workflow to add rate limiting'), off.ctx)
    expect(await hidden(off.fp, off.ctx, 'x')).toBeUndefined()
  }))

  test('a memory runner child (BURACLE_MEMORY_RUNNER=1, print mode) gets no routing message and no system block', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, { mode: 'print' })
    await withEnv({ BURACLE_MEMORY_RUNNER: '1' }, async () => {
      expect(await fp.emit('before_agent_start', agentStart('geçen sefer ne karar vermiştik? reply with JSON only'), ctx)).toBeUndefined()
    })
    expect(loadLedger('omp', SID).turn).toBe(0)
  }))

  test('print mode has no input event: before_agent_start routes the prompt itself, and an expanded workflow command starts its run', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, { mode: 'print' })
    const r = await fp.emit('before_agent_start', agentStart('geçen sefer ne karar vermiştik?'), ctx) as { message: { content: string } }
    expect(r.message.content).toContain('Earlier work: search memory first')
    expect(await fp.emit('before_agent_start', agentStart('geçen sefer ne karar vermiştik?'), ctx)).toEqual(r)
    expect(loadLedger('omp', SID).turn).toBe(1)
    const expanded = "Run Buracle's `bugfix` workflow for the request below; the user asked for it explicitly.\nFirst read `skill://bugfix` ...\n\nRequest: the parser crashes\n"
    await fp.emit('before_agent_start', agentStart(expanded), ctx)
    expect(readFlow('omp', SID)?.stack.at(-1)).toMatchObject({ workflow: 'bugfix', title: 'the parser crashes', source: 'command' })
    expect(await fp.emit('before_agent_start', agentStart('Buracle routing check: the user asked for plan-build and it was not loaded.'), ctx)).toBeUndefined()
  }))
})

describe('omp H22 prompt delivery: input at submission, before_agent_start when omp hands the prompt to the model', () => {
  const research = (): OmpGenerated => testGenerated({ skills: [...testGenerated().skills, { id: 'research', description: 'Research a question with sources', userInvocable: true }] })

  test('two prompts typed while the agent works: their delivery carries the routing of both, and the ledger turn moves only then', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, {}, research())
    ctx.isIdle = () => false
    await fp.emit('input', input('use the research skill to compare bun and deno'), ctx)
    await fp.emit('input', input('and what did we decide last time about the runtime?'), ctx)
    expect(loadLedger('omp', SID).turn).toBe(0)
    const text = await hidden(fp, ctx, 'use the research skill to compare bun and deno') as string
    expect(text).toContain('- The user asked for the research skill: load it before any other step and follow it (read skill://research)')
    expect(text).toContain('- Earlier work: search memory first')
    const l = loadLedger('omp', SID)
    expect(l.turn).toBe(1)
    expect(l.prompt?.route).toMatchObject({ invoked: [], load: ['research'], memory: { recall: true, write: false } })
    expect(await hidden(fp, ctx, 'and what did we decide last time about the runtime?')).toBeUndefined()
    expect(loadLedger('omp', SID).turn).toBe(1)
    const held = await fp.emit('session_stop', stop, ctx) as { decision: string, reason: string }
    expect(held.reason).toStartWith('Buracle routing check: the user asked for research and it was not loaded.')
  }))

  test('two queued asks keep core\'s caps: the first one loads, the second is a skill to evaluate', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, {}, research())
    ctx.isIdle = () => false
    await fp.emit('input', input('use the research skill to compare bun and deno'), ctx)
    await fp.emit('input', input('then use the plan-build skill to plan the migration'), ctx)
    const text = await hidden(fp, ctx, 'use the research skill to compare bun and deno') as string
    expect(text).toContain('- The user asked for the research skill')
    expect(text).toContain('- Skills to evaluate first: plan-build (')
    expect(loadLedger('omp', SID).prompt?.route).toMatchObject({ load: ['research'], candidates: ['plan-build'] })
  }))

  test('Buracle\'s own continuation takes no queued prompt: the prompt waits for its own delivery', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, {}, research())
    ctx.isIdle = () => false
    await fp.emit('input', input('use the research skill to compare bun and deno'), ctx)
    expect(await hidden(fp, ctx, 'Buracle routing check: the user asked for plan-build and it was not loaded.')).toBeUndefined()
    expect(loadLedger('omp', SID).turn).toBe(0)
    expect(await hidden(fp, ctx, 'use the research skill to compare bun and deno')).toContain('read skill://research')
    expect(loadLedger('omp', SID).turn).toBe(1)
  }))

  test('a prompt sent while the agent is idle starts afresh: prompts queued for a run that never delivered them are dropped', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, {}, research())
    ctx.isIdle = () => false
    ctx.hasPendingMessages = () => true
    await fp.emit('input', input('use the research skill to compare bun and deno'), ctx)
    ctx.isIdle = () => true
    ctx.hasPendingMessages = () => false
    await fp.emit('input', input('run the unit tests'), ctx)
    expect(await hidden(fp, ctx, 'run the unit tests')).toBeUndefined()
    expect(loadLedger('omp', SID).prompt?.route.load).toEqual([])
    expect(await fp.emit('session_stop', stop, ctx)).toBeUndefined()
  }))

  test('an idle agent that still holds queued messages (omp keeps them when a drain fails) keeps their routing for the delivery that carries them', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, {}, research())
    ctx.isIdle = () => false
    ctx.hasPendingMessages = () => true
    await fp.emit('input', input('use the research skill to compare bun and deno'), ctx)
    ctx.isIdle = () => true
    await fp.emit('input', input('and what did we decide last time about the runtime?'), ctx)
    const text = await hidden(fp, ctx, 'use the research skill to compare bun and deno') as string
    expect(text).toContain('- The user asked for the research skill: load it before any other step and follow it (read skill://research)')
    expect(text).toContain('- Earlier work: search memory first')
    expect(loadLedger('omp', SID).prompt?.route).toMatchObject({ load: ['research'], memory: { recall: true, write: false } })
  }))

  test('a retry of the same delivery (omp runs before_agent_start again when the system prompt changed meanwhile) gets the same text; the turn moves once', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, {}, research())
    await fp.emit('input', input('use the research skill to compare bun and deno'), ctx)
    const first = await hidden(fp, ctx, 'use the research skill to compare bun and deno')
    expect(first).toContain('read skill://research')
    expect(await hidden(fp, ctx, 'use the research skill to compare bun and deno')).toBe(first)
    expect(loadLedger('omp', SID).turn).toBe(1)
    expect(await hidden(fp, ctx, 'Buracle routing check: the user asked for research and it was not loaded.')).toBeUndefined()
  }))

  test('print mode does not expand /skill:<id>: the literal command is an ask to read the skill (held by the audit), and its run starts when the skill is read', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, { mode: 'print' })
    expect(await hidden(fp, ctx, '/skill:plan-build add rate limiting')).toBe('Buracle routing for this prompt:\n- The user asked for the plan-build skill: load it before any other step and follow it (read skill://plan-build); the rest of the prompt is its input.')
    const l = loadLedger('omp', SID)
    expect(l.skills['plan-build']).toBeUndefined()
    expect(l.prompt?.route).toMatchObject({ invoked: [], load: ['plan-build'] })
    expect(readFlow('omp', SID)?.stack ?? []).toEqual([])
    const held = await fp.emit('session_stop', stop, ctx) as { decision: string, reason: string }
    expect(held).toEqual({ decision: 'block', reason: 'Buracle routing check: the user asked for plan-build and it was not loaded. Load it now and follow it, or say in one line why it does not apply.' })
    await fp.emit('tool_call', toolCall('read', { path: 'skill://plan-build' }), ctx)
    await fp.emit('tool_result', toolResult('read', { path: 'skill://plan-build' }), ctx)
    expect(loadLedger('omp', SID).skills['plan-build']?.n).toBe(1)
    expect(readFlow('omp', SID)?.stack.at(-1)).toMatchObject({ workflow: 'plan-build', source: 'skill' })
  }))
})

describe('omp H24 usage ledger and the deny-once gates (reported as H03)', () => {
  test('a new third-party import is denied once (R4), the retry goes through', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    const write = toolCall('write', { path: 'src/a.ts', content: "import { z } from 'zod'\nexport const s = z.string()\n" })
    const first = await fp.emit('tool_call', write, ctx) as { block?: boolean, reason?: string }
    expect(first.block).toBe(true)
    expect(first.reason).toStartWith('Buracle H03: this edit adds an import of `zod`')
    expect(await fp.emit('tool_call', write, ctx)).toBeUndefined()
  }))

  test('context7 first makes the import fine; under nudge the gate is a line of context', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    await fp.emit('tool_call', toolCall('mcp__context7_resolve_library_id', { libraryName: 'zod' }), ctx)
    expect(loadLedger('omp', SID).mcp['context7']?.n).toBe(1)
    expect(await fp.emit('tool_call', toolCall('write', { path: 'src/a.ts', content: "import { z } from 'zod'\n" }), ctx)).toBeUndefined()
    const nudge = setup(sb, { config: d => ({ config: { ...d, routing: { ...d.routing, strictness: 'nudge' } }, vault: '/v', shim: '/s', source: 'defaults' }) }, { sid: '01a118a8-8d01-740c-9360-eeeeeeeeeeee' })
    const r = await nudge.fp.emit('tool_call', toolCall('write', { path: 'src/b.ts', content: "import y from 'yaml'\n" }), nudge.ctx) as { additionalContext?: string }
    expect(r.additionalContext).toContain('Buracle: this edit imports `yaml`')
  }))

  test('an MCP call through an omp device counts once (the inner mcp__ call); semble with the home folder as repo is denied', () => withSandbox(async sb => {
    const info: WorkspaceInfo = { cwd: join(sb.root, 'work'), root: join(sb.root, 'work'), children: [], index: { codegraph: { state: 'ready' }, semble: { state: 'ready' } } }
    const { fp, ctx } = setup(sb, { prepareWorkspace: async () => info })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await Bun.sleep(5)
    await fp.emit('tool_call', toolCall('write', { path: 'xd://mcp__buracle_memory_memory_search', content: '{"query":"x"}' }), ctx)
    await fp.emit('tool_call', toolCall('mcp__buracle_memory_memory_search', { query: 'x' }), ctx)
    expect(loadLedger('omp', SID).mcp['buracle-memory']).toEqual({ n: 1, turn: 0 })
    const denied = await fp.emit('tool_call', toolCall('mcp__semble_search', { query: 'auth flow', repo: sb.home }), ctx) as { block?: boolean, reason?: string }
    expect(denied.block).toBe(true)
    expect(denied.reason).toContain(`Pass the project root ${info.root} instead.`)
    expect(await fp.emit('tool_call', toolCall('mcp__semble_search', { query: 'auth flow', repo: info.root }), ctx)).toBeUndefined()
  }))
})

describe('omp H24 MCP results: the session failure rule (tool_result isError) and the session\'s health', () => {
  const routing = loadCanonicalSync(paths.canonicalDir()).routing
  const data = testGenerated({
    routing: { ...routing, strictness: 'enforce' },
    mcp: [
      ...testGenerated().mcp,
      { id: 'web-fetch', description: 'Web fetch', transport: 'stdio', critical: true, routing: ['web-fetch'], harnesses: ['omp'] },
    ],
    mcpIds: [...testGenerated().mcpIds, 'web-fetch'],
  })
  const result = (toolName: string, isError: boolean, inputArgs: Record<string, unknown> = { query: 'bun 1.4 release notes' }) => ({ type: 'tool_result', toolCallId: '1', toolName, input: inputArgs, content: [{ type: 'text', text: isError ? 'MCP failure: search index unavailable' : 'results' }], isError })
  const search = async (fp: ReturnType<typeof fakePi>, ctx: FakeCtx) => await fp.emit('tool_call', toolCall('web_search', { query: 'bun 1.4 release notes' }), ctx) as { block?: boolean, reason?: string, additionalContext?: string } | undefined

  test('two failing web-search calls send the built-in web_search to web-fetch, two failing web-fetch calls let it through with the fallback note; a success resets the count', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: realPolicy({ routeTool }) }, {}, data)
    await fp.emit('tool_result', result('mcp__web_search_search', true), ctx)
    expect((await search(fp, ctx))?.reason).toContain('mcp__web_search_search')
    await fp.emit('tool_result', result('mcp__web_search_search', true), ctx)
    expect(loadLedger('omp', SID).mcpErrors).toEqual({ 'web-search': 2 })
    const redirected = await search(fp, ctx)
    expect(redirected?.block).toBe(true)
    expect(redirected?.reason).toContain('mcp__web_fetch_fetch_url')
    for (let i = 0; i < 2; i++) await fp.emit('tool_result', result('mcp__web_fetch_fetch_url', true, { url: 'https://html.duckduckgo.com/html/?q=bun' }), ctx)
    const allowed = await search(fp, ctx)
    expect(allowed?.block).toBeUndefined()
    expect(allowed?.additionalContext).toContain('MCP server is down, so the built-in web search is allowed as a fallback; mention the fallback in your report.')
    await fp.emit('tool_result', result('mcp__web_search_search', false), ctx)
    expect(loadLedger('omp', SID).mcpErrors).toEqual({ 'web-fetch': 2 })
    expect((await search(fp, ctx))?.reason).toContain('mcp__web_search_search')
  }))

  test('the outer device write of an MCP call is not counted (the inner mcp__ call is)', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: realPolicy({ routeTool }) }, {}, data)
    await fp.emit('tool_result', result('write', true, { path: 'xd://mcp__web_search_search', content: '{"query":"x"}' }), ctx)
    expect(loadLedger('omp', SID).mcpErrors).toBeUndefined()
  }))
})

describe('omp H02 on line-anchored edits', () => {
  test('a hashline edit names its files in the payload: the write guard sees them and blocks a secret file', () => withSandbox(async sb => {
    const seen: string[][] = []
    const { fp, ctx, cwd } = setup(sb, { policy: realPolicy({ checkWrite: (p, c) => { seen.push(p); return checkWrite(p, c) } }) })
    writeFileSync(join(cwd, '.env'), 'A=1\n')
    const r = await fp.emit('tool_call', toolCall('edit', { input: '*** Begin Patch\n[.env#1A2B]\nPUT 1.=1:\n+A=2\n*** End Patch' }), ctx) as { block?: boolean, reason?: string }
    expect(seen).toEqual([[join(cwd, '.env')]])
    expect(r.block).toBe(true)
    expect(r.reason).toStartWith('Buracle H02:')
    expect(await fp.emit('tool_call', toolCall('edit', { input: '[src/a.ts#1A2B]\nPUT 1.=1:\n+x\nMV src/b.ts' }), ctx)).toBeUndefined()
    expect(seen.at(-1)).toEqual([join(cwd, 'src/a.ts'), join(cwd, 'src/b.ts')])
  }))
})

describe('omp H02 on `~/` paths', () => {
  test('omp writes `~/...` into the home folder: the write guard sees that path and blocks ~/.ssh', () => withSandbox(async sb => {
    const seen: string[][] = []
    const { fp, ctx } = setup(sb, { policy: realPolicy({ checkWrite: (p, c) => { seen.push(p); return checkWrite(p, c) } }) })
    const r = await fp.emit('tool_call', toolCall('write', { path: '~/.ssh/authorized_keys', content: 'ssh-ed25519 AAAA x\n' }), ctx) as { block?: boolean, reason?: string }
    expect(seen).toEqual([[join(sb.home, '.ssh', 'authorized_keys')]])
    expect(r.block).toBe(true)
    expect(r.reason).toStartWith('Buracle H02:')
    const patch = await fp.emit('tool_call', toolCall('edit', { input: '*** Begin Patch\n*** Update File: notes.md\n*** Move to: ~/.ssh/config\n@@\n-a\n+Host *\n*** End Patch' }), ctx) as { block?: boolean, reason?: string }
    expect(seen.at(-1)).toEqual([join(ctx.cwd, 'notes.md'), join(sb.home, '.ssh', 'config')])
    expect(patch.block).toBe(true)
    expect(patch.reason).toStartWith('Buracle H02:')
  }))
})

describe('omp H03 shell notes and H04 checks through the shared planner', () => {
  test('a shell file write points to edit or write once per session; printing a file points to read', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    const write = await fp.emit('tool_call', toolCall('bash', { command: "sed -i 's/a/b/' src/a.ts" }), ctx) as { additionalContext?: string }
    expect(write.additionalContext).toContain('this shell command writes `src/a.ts` (sed -i in place). Make ordinary source edits with the edit or write tool instead')
    expect(await fp.emit('tool_call', toolCall('bash', { command: 'echo x > src/b.ts' }, '2'), ctx)).toBeUndefined()
    const read = await fp.emit('tool_call', toolCall('bash', { command: 'cat src/a.ts' }, '3'), ctx) as { additionalContext?: string }
    expect(read.additionalContext).toContain('read `src/a.ts` with the read tool instead of printing it in the shell')
  }))

  test('a missing linter is named once per session; a mirrored test folder silences the TDD note', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb, { checkers: coreCheckers, run: async () => ({ code: 127, stdout: '', stderr: 'not found', timedOut: false }) })
    mkdirSync(join(cwd, 'src', 'core'), { recursive: true })
    mkdirSync(join(cwd, 'tests', 'core'), { recursive: true })
    writeFileSync(join(cwd, 'run.sh'), 'echo $1\n')
    writeFileSync(join(cwd, 'src', 'core', 'x.ts'), 'export const x = 1\n')
    writeFileSync(join(cwd, 'tests', 'core', 'x.test.ts'), "import { x } from '../../src/core/x'\n")
    const first = await fp.emit('tool_result', toolResult('write', { path: 'run.sh', content: 'echo $1\n' }), ctx) as { additionalContext?: string }
    expect(first.additionalContext).toBe('shellcheck is not installed, so it did not check this file: run `buracle install`.')
    expect(await fp.emit('tool_result', toolResult('write', { path: 'run.sh', content: 'echo $1\n' }), ctx)).toBeUndefined()
    expect(await fp.emit('tool_result', toolResult('write', { path: 'src/core/x.ts', content: 'export const x = 1\n' }), ctx)).toBeUndefined()
  }))
})

describe('omp H04 on `~/` paths', () => {
  test('a patch that adds a file under ~/ is checked where omp writes it, in the home folder', () => withSandbox(async sb => {
    const zwsp = String.fromCharCode(0x200b)
    const { fp, ctx } = setup(sb, {
      checkers: {
        checkersFor: () => [],
        findingsOf: () => undefined,
        tddHint: () => undefined,
        charsetFindings: (text, file) => (text.includes(zwsp) ? [`zero-width space added to ${file}`] : []),
        lengthNote: () => undefined,
      },
    })
    const file = join(sb.home, 'notes', 'a.ts')
    mkdirSync(join(sb.home, 'notes'), { recursive: true })
    writeFileSync(file, `export const x = "a${zwsp}b"\n`)
    const patch = `*** Begin Patch\n*** Add File: ~/notes/a.ts\n+export const x = "a${zwsp}b"\n*** End Patch`
    const r = await fp.emit('tool_result', { ...toolResult('edit', { input: patch }) }, ctx)
    expect(r).toEqual({ additionalContext: `zero-width space added to ${file}` })
  }))
})

describe('omp H25 workflow tracking and the band above the editor', () => {
  test('a typed workflow command starts its run and the band shows above the editor; it is redrawn only when it changes', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    await fp.emit('input', input('/plan-build add rate limiting'), ctx)
    expect(readFlow('omp', SID)?.stack).toEqual([{ workflow: 'plan-build', title: 'add rate limiting', source: 'command', startedAt: 1_791_400_000_000 }])
    const drawn = flowWidgets(ctx)
    expect(drawn.length).toBe(1)
    const [key, lines, opts] = drawn[0]?.args as [string, string[], unknown]
    expect(key).toBe(FLOW_WIDGET_KEY)
    expect(opts).toEqual({ placement: 'aboveEditor' })
    expect(lines.length).toBe(2)
    expect(lines.length).toBeLessThanOrEqual(10)
    expect(plain(lines[0] as string)).toContain('plan-build')
    expect(plain(lines[0] as string)).toContain('add rate limiting')
    expect(plain(lines[1] as string)).toContain('Plan')
    await fp.emit('turn_end', { type: 'turn_end', turnIndex: 0 }, ctx)
    expect(flowWidgets(ctx).length).toBe(1)
    await fp.emit('tool_result', toolResult('read', { path: 'skill://research' }), ctx)
    expect(readFlow('omp', SID)?.stack.map(e => e.workflow)).toEqual(['plan-build', 'research'])
    expect(flowWidgets(ctx).length).toBe(2)
  }))

  test('/skill:<workflow> starts the run too; workflow.band off draws nothing; no band outside the TUI', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    await fp.emit('input', input('/skill:bugfix the parser crash'), ctx)
    expect(readFlow('omp', SID)?.stack.at(-1)).toMatchObject({ workflow: 'bugfix', title: 'the parser crash' })
    const off = setup(sb, { config: d => ({ config: { ...d, workflow: { ...d.workflow, band: false } }, vault: '/v', shim: '/s', source: 'defaults' }) }, { sid: '01a118a8-8d01-740c-9360-ffffffffffff' })
    await off.fp.emit('input', input('/plan-build x'), off.ctx)
    expect(flowWidgets(off.ctx)).toEqual([])
    const rpc = setup(sb, {}, { mode: 'rpc', sid: '01a118a8-8d01-740c-9360-aaaaaaaaaaab' })
    await rpc.fp.emit('input', input('/plan-build x'), rpc.ctx)
    expect(rpc.ctx.uiCalls).toEqual([])
    expect(readFlow('omp', '01a118a8-8d01-740c-9360-aaaaaaaaaaab')?.stack.at(-1)?.workflow).toBe('plan-build')
  }))
})

describe('omp H26 profile signals, H05 context watch, H17 profile guard', () => {
  test('a prompt spools its profile signals next to the prompt entry; a /skill: workflow adds its usage signal', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb)
    await fp.emit('input', input('From now on always use bun for scripts.'), ctx)
    await fp.emit('input', input('/skill:research compare zod and valibot'), ctx)
    await Bun.sleep(0)
    const evs = memory.spool.map(s => s.entries.map(e => e.ev === 'signal' ? `signal:${e.signal?.key}` : e.ev))
    expect(evs[0]?.[0]).toBe('prompt')
    expect(evs[0]?.some(e => e.startsWith('signal:'))).toBe(true)
    expect(evs[1]).toContain('signal:usage.workflow=research')
  }))

  test('H05: a warning once per band, shown in the TUI and handed to the model with the next prompt', () => withSandbox(async sb => {
    let pct = 50
    const { fp, ctx } = setup(sb)
    ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 100, percent: pct })
    await fp.emit('turn_end', { type: 'turn_end', turnIndex: 0 }, ctx)
    expect(ctx.uiCalls.filter(c => c.method === 'notify')).toEqual([])
    pct = 90
    await fp.emit('turn_end', { type: 'turn_end', turnIndex: 1 }, ctx)
    const warn = contextWarning('warn', undefined) as string
    expect(ctx.uiCalls.filter(c => c.method === 'notify')).toEqual([{ method: 'notify', args: [warn, 'warning'] }])
    await fp.emit('turn_end', { type: 'turn_end', turnIndex: 2 }, ctx)
    expect(ctx.uiCalls.filter(c => c.method === 'notify').length).toBe(1)
    await fp.emit('input', input('keep going on the parser'), ctx)
    expect(await hidden(fp, ctx, 'x')).toContain(warn)
  }))

  test('H17: a profile-guard warning is shown at session start and logged', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { profileGuard: () => 'Buracle was installed for Oh My Pi into /a, but this session reads /b.' })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    expect(ctx.uiCalls).toContainEqual({ method: 'notify', args: ['Buracle was installed for Oh My Pi into /a, but this session reads /b.', 'warning'] })
  }))
})

describe('omp H21 workspace lines', () => {
  test('the first prompt gets the project root and index state; a later prompt learns that codegraph became ready', () => withSandbox(async sb => {
    const root = join(sb.root, 'work')
    const building: WorkspaceInfo = { cwd: root, root, children: [], index: { codegraph: { state: 'building' }, semble: { state: 'ready' } } }
    const ready: WorkspaceInfo = { ...building, index: { codegraph: { state: 'ready' }, semble: { state: 'ready' } } }
    const { fp, ctx } = setup(sb, { prepareWorkspace: async () => building, refreshWorkspace: () => ready })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    const r = await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hi', systemPrompt: ['BASE'] }, ctx) as { systemPrompt: string[] }
    expect(r.systemPrompt[1]).toContain(`Project root: ${root}.`)
    expect(r.systemPrompt[1]).toContain('codegraph building now')
    await fp.emit('input', input('how does the parser work?'), ctx)
    expect(await hidden(fp, ctx, 'x')).toContain(`The codegraph index of ${root} is ready now`)
  }))

  test('a subagent gets the workspace line in its system prompt (read-only info)', () => withSandbox(async sb => {
    const root = join(sb.root, 'work')
    const { fp, ctx } = setup(sb, { workspaceInfo: async () => ({ cwd: root, root, children: [], index: { codegraph: { state: 'ready' }, semble: { state: 'ready' } } }) }, { kind: 'sub' })
    const r = await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'review', systemPrompt: ['SUB'] }, ctx) as { systemPrompt: string[] }
    expect(r.systemPrompt[0]).toBe('SUB')
    expect(r.systemPrompt[1]).toContain(`Project root: ${root}.`)
  }))
})

describe('omp H19 review gate on a review agent\'s yield', () => {
  const report = { verdict: 'pass', summary: 'docs/plans/x.md is ready', findings: [] }

  test('an invalid report goes back to the reviewer once; the next yield goes through; a valid report never blocks', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, { kind: 'sub', name: 'plan-build-review', sid: '01a118a8-8d01-740c-9360-111111111111' })
    const bad = await fp.emit('tool_call', toolCall('yield', { data: { verdict: 'needs_changes', summary: 'docs/plans/x.md', findings: [] } }), ctx) as { block?: boolean, reason?: string }
    expect(bad.block).toBe(true)
    expect(bad.reason).toStartWith('Buracle H19: your report as plan-build-review is not valid review JSON (')
    expect(await fp.emit('tool_call', toolCall('yield', { data: { verdict: 'needs_changes', summary: 'docs/plans/x.md', findings: [] } }), ctx)).toBeUndefined()
    const good = setup(sb, {}, { kind: 'sub', name: 'plan-build-review', sid: '01a118a8-8d01-740c-9360-222222222222' })
    expect(await good.fp.emit('tool_call', toolCall('yield', { data: report }), good.ctx)).toBeUndefined()
  }))

  test('the report is bound to the lead\'s plans: a summary about another file goes back to the reviewer', () => withSandbox(async sb => {
    const deps = testDeps().deps
    const state = { ...deps.state!, subjects: () => ['/abs/repo/docs/plans/x.md'] }
    const off = setup(sb, { state }, { kind: 'sub', name: 'plan-build-review', sid: '01a118a8-8d01-740c-9360-555555555555' })
    const wrong = await off.fp.emit('tool_call', toolCall('yield', { data: { ...report, summary: 'docs/plans/y.md is ready' } }), off.ctx) as { block?: boolean, reason?: string }
    expect(wrong.block).toBe(true)
    expect(wrong.reason).toContain('must start with the reviewed path (/abs/repo/docs/plans/x.md)')
    const right = setup(sb, { state }, { kind: 'sub', name: 'plan-build-review', sid: '01a118a8-8d01-740c-9360-666666666666' })
    expect(await right.fp.emit('tool_call', toolCall('yield', { data: report }), right.ctx)).toBeUndefined()
  }))

  test('other subagents, the main session and a reviewer giving up are never checked', () => withSandbox(async sb => {
    const other = setup(sb, {}, { kind: 'sub', name: 'task', sid: '01a118a8-8d01-740c-9360-333333333333' })
    expect(await other.fp.emit('tool_call', toolCall('yield', { data: { anything: 1 } }), other.ctx)).toBeUndefined()
    const main = setup(sb)
    expect(await main.fp.emit('tool_call', toolCall('yield', { data: { anything: 1 } }), main.ctx)).toBeUndefined()
    const gaveUp = setup(sb, {}, { kind: 'sub', name: 'changes-review', sid: '01a118a8-8d01-740c-9360-444444444444' })
    expect(await gaveUp.fp.emit('tool_call', toolCall('yield', { error: 'no diff to review' }), gaveUp.ctx)).toBeUndefined()
  }))
})

describe('omp utility commands', () => {
  test('/brain starts and opens the memory UI through the CLI; a missing CLI is explained', () => withSandbox(async sb => {
    const reply = { code: 0, stdout: JSON.stringify({ url: 'http://127.0.0.1:41777', started: true, opened: true }), stderr: '', timedOut: false }
    const { fp, ctx, runs } = setup(sb, { run: async argv => { runs.push(argv); return reply } })
    await fp.commands.get('brain')!.handler('', ctx)
    expect(runs).toEqual([['buracle', 'mem', 'ui', '--open', '--json']])
    expect(ctx.uiCalls.at(-1)).toEqual({ method: 'notify', args: ['Memory UI: http://127.0.0.1:41777 (started) · opened in the browser', 'info'] })
    const none = setup(sb, { cli: () => undefined })
    await none.fp.commands.get('brain')!.handler('', none.ctx)
    expect(none.ctx.uiCalls.at(-1)?.args[1]).toBe('error')
    const page = { code: 0, stdout: JSON.stringify({ url: 'http://127.0.0.1:41777', page: 'http://127.0.0.1:41777/review', started: false, opened: true }), stderr: '', timedOut: false }
    const review = setup(sb, { run: async argv => { review.runs.push(argv); return page } })
    await review.fp.commands.get('brain')!.handler('review', review.ctx)
    expect(review.runs).toEqual([['buracle', 'mem', 'ui', '--open', '--page', 'review', '--json']])
    expect(review.ctx.uiCalls.at(-1)).toEqual({ method: 'notify', args: ['Review page: http://127.0.0.1:41777/review · opened in the browser', 'info'] })
    await review.fp.commands.get('brain')!.handler('graph', review.ctx)
    expect(review.ctx.uiCalls.at(-1)).toEqual({ method: 'notify', args: ['Usage: /brain [review]', 'warning'] })
  }))

  test('/remember names the capture it wrote', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { run: async () => ({ code: 0, stdout: JSON.stringify({ id: 'capture-use-bun', layer: 'project', kind: 'capture' }), stderr: '', timedOut: false }) })
    await fp.commands.get('remember')!.handler('use bun', ctx)
    expect(ctx.uiCalls.at(-1)).toEqual({ method: 'notify', args: ['Remembered: capture-use-bun', 'info'] })
  }))

  test('/buracle-status views: status (also /buracle), flow, plan, memory; anything else gets the usage', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    const show = async (name: string, args: string) => { await fp.commands.get(name)!.handler(args, ctx); return String(ctx.uiCalls.at(-1)?.args[0]) }
    expect(await show('buracle-status', '')).toStartWith('Buracle 0.1.0 · Oh My Pi (tested 18.8.3, minimum 18.8.0)')
    expect(await show('buracle', '')).toContain('commands: /plan-build /goal-build · /remember <text> · /brain · /aside <question> · /buracle-status [status|memory|plan|flow] · /buracle-ping')
    expect(await show('buracle-status', 'flow')).toBe('No workflow is running.')
    await fp.emit('input', input('/plan-build add rate limiting'), ctx)
    expect(await show('buracle-status', 'flow')).toStartWith('plan-build · add rate limiting · starting')
    expect(await show('buracle-status', '')).toContain('workflow: plan-build (add rate limiting)')
    const pane = async (args: string) => { await fp.commands.get('buracle-status')!.handler(args, ctx); return ctx.uiCalls.at(-1) }
    expect(await pane('plan')).toMatchObject({ method: 'setWidget', args: ['buracle.pane', expect.arrayContaining(['Buracle plan', 'No plan is bound to this session.']), { placement: 'belowEditor' }] })
    expect(await pane('memory')).toMatchObject({ method: 'setWidget', args: ['buracle.pane', expect.arrayContaining(['Buracle memory', 'web UI: not running (/brain starts and opens it)', '/buracle-status memory again closes this view']), { placement: 'belowEditor' }] })
    expect(await pane('memory')).toEqual({ method: 'setWidget', args: ['buracle.pane', undefined, { placement: 'belowEditor' }] })
    expect(await show('buracle-status', 'bogus')).toBe('Usage: /buracle-status [status|memory|plan|flow]')
    const print = setup(sb, {}, { mode: 'print' })
    await print.fp.commands.get('buracle-status')!.handler('plan', print.ctx)
    expect(print.ctx.uiCalls.at(-1)).toMatchObject({ method: 'notify', args: [expect.stringContaining('No plan is bound to this session.'), 'info'] })
  }))
})

describe('omp extension: spool of MCP and web tools (H14)', () => {
  test('MCP and web calls are spooled with their tool names; the outer device write is not', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb)
    await fp.emit('tool_result', toolResult('write', { path: 'xd://mcp__context7_query_docs', content: '{}' }), ctx)
    await fp.emit('tool_result', toolResult('mcp__context7_query_docs', { libraryId: '/x/y', query: 'q' }), ctx)
    await fp.emit('tool_result', toolResult('web_search', { query: 'x' }), ctx)
    await Bun.sleep(0)
    expect(memory.spool.flatMap(s => s.entries.map(e => `${e.tool}:${e.kind}`))).toEqual(['mcp__context7_query_docs:mcp', 'web_search:web_search'])
  }))
})

describe('omp extension: the flow record is display data', () => {
  test('a broken flow record never breaks a prompt', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    mkdirSync(join(sb.buracleHome, 'sessions', 'omp', SID), { recursive: true })
    writeFileSync(join(sb.buracleHome, 'sessions', 'omp', SID, 'flow.json'), '{ broken')
    await fp.emit('input', input('/plan-build x'), ctx)
    expect(JSON.parse(readFileSync(join(sb.buracleHome, 'sessions', 'omp', SID, 'flow.json'), 'utf8')).stack[0].workflow).toBe('plan-build')
  }))
})

describe('w2 plan state on omp: the lane guard, the H09 reminder and the H08 receipt', () => {
  test('a subagent\'s bash cannot change the plan state; the main agent and read-only commands can', () => withSandbox(async sb => {
    const main = setup(sb)
    expect(await main.fp.emit('tool_call', toolCall('bash', { command: 'buracle plan pause --kind decision' }), main.ctx)).toBeUndefined()
    const sub = setup(sb, {}, { kind: 'sub' })
    const r = await sub.fp.emit('tool_call', toolCall('bash', { command: 'buracle plan resume' }), sub.ctx) as { block?: boolean, reason?: string }
    expect(r.block).toBe(true)
    expect(r.reason).toContain('Buracle lane guard')
    expect(await sub.fp.emit('tool_call', toolCall('bash', { command: 'buracle plan status --json' }, '2'), sub.ctx)).toBeUndefined()
  }))

  test('a subagent cannot change the plan state through context-mode or an eval cell either; the main agent can', () => withSandbox(async sb => {
    type Verdict = { block?: boolean, reason?: string } | undefined
    const sub = setup(sb, { evalGuard: defaultDeps().evalGuard }, { kind: 'sub', name: 'task' })
    const cm = await sub.fp.emit('tool_call', toolCall('mcp__context_mode_ctx_execute', { language: 'shell', code: 'buracle plan resume' }), sub.ctx) as Verdict
    expect(cm?.block).toBe(true)
    expect(cm?.reason).toContain('Buracle lane guard')
    const batch = await sub.fp.emit('tool_call', toolCall('mcp__context_mode_ctx_batch_execute', { commands: ['ls', 'buracle worktree sync x'], queries: ['x'] }, '2'), sub.ctx) as Verdict
    expect(batch?.reason).toContain('`buracle worktree sync`')
    for (const input of [
      { language: 'js', code: "require('child_process').execSync('buracle plan resume')" },
      { language: 'py', code: "import subprocess\nsubprocess.run(['buracle', 'plan', 'pause', '--kind', 'decision'])" },
    ]) {
      const r = await sub.fp.emit('tool_call', toolCall('eval', input, '3'), sub.ctx) as Verdict
      expect({ language: input.language, block: r?.block, lane: r?.reason?.includes('Buracle lane guard') }).toEqual({ language: input.language, block: true, lane: true })
    }
    expect(await sub.fp.emit('tool_call', toolCall('eval', { language: 'js', code: "require('child_process').execSync('buracle plan status --json')" }, '4'), sub.ctx)).toBeUndefined()
    const main = setup(sb, { evalGuard: defaultDeps().evalGuard })
    expect(await main.fp.emit('tool_call', toolCall('eval', { language: 'js', code: "require('child_process').execSync('buracle plan resume')" }, '5'), main.ctx)).toBeUndefined()
    expect((await main.fp.emit('tool_call', toolCall('mcp__context_mode_ctx_execute', { language: 'shell', code: 'buracle plan resume' }, '6'), main.ctx) as Verdict)?.block).toBeUndefined()
  }))

  test('ask: a real question while the plan runs gets the pause reminder; its answer during a decision pause is recorded', () => withSandbox(async sb => {
    const { checkQuestion } = await import('../../../src/core/policy/questions')
    const { fp, ctx } = setup(sb, { policy: realPolicy({ checkQuestion }) })
    saveState('omp', SID, planState())
    const asked = await fp.emit('tool_call', toolCall('ask', { question: 'Redis or the in-memory store?', options: ['Redis', 'In-memory'] }), ctx) as { additionalContext?: string }
    expect(asked.additionalContext).toContain('buracle plan pause --kind decision')
    saveState('omp', SID, { ...planState(), interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'merge decision' } })
    await fp.emit('tool_result', { ...toolResult('ask', { question: 'Merge?' }), content: [{ type: 'text', text: 'User selected: Squash-merge' }] }, ctx)
    expect(typeof loadState('omp', SID).interaction?.answeredAt).toBe('number')
  }))

  test('plan mode (the session\'s last mode_change entry) lets the stop through with one notice; leaving it holds the run again', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { plan: { ...testDeps().deps.plan!, applyIntent, stopGuardVerdict } })
    const branch: unknown[] = [{ type: 'message' }, { type: 'mode_change', mode: 'plan', data: { planFilePath: 'local://PLAN.md' } }, { type: 'message' }]
    ctx.sessionManager = { ...ctx.sessionManager, getBranch: () => branch }
    saveState('omp', SID, planState())
    expect(await fp.emit('session_stop', stop, ctx)).toBeUndefined()
    expect(await fp.emit('session_stop', stop, ctx)).toBeUndefined()
    const notices = ctx.uiCalls.filter(c => c.method === 'notify').map(c => String(c.args[0]))
    expect(notices.filter(n => n.includes('plan mode (read-only)'))).toHaveLength(1)
    branch.push({ type: 'mode_change', mode: 'none' })
    expect((await fp.emit('session_stop', stop, ctx) as { decision?: string } | undefined)?.decision).toBe('block')
    expect(planModeOn({ ...ctx, sessionManager: { getSessionId: () => SID, getBranch: () => { throw new Error('gone') } } })).toBe(false)
    expect(planModeOn({ ...ctx, sessionManager: { getSessionId: () => SID, getBranch: () => [{ type: 'mode_change', mode: 'plan_paused' }] } })).toBe(false)
  }))

  test('notes the user pinned in the review page on the plan reach the next prompt once (H10)', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb, { reviewNotes: (sid, o) => reviewNotesNotice('omp', sid, o) })
    const plan = join(cwd, 'docs', 'plans', 'p.md')
    saveState('omp', SID, { ...planState(), plan: { ...planState().plan!, path: plan, status: 'PENDING', phase: 'plan' } })
    mkdirSync(join(sb.buracleHome, 'state', 'review'), { recursive: true })
    writeFileSync(paths.reviewInboxFile(), JSON.stringify({ v: 1, entries: [{ at: 1, root: cwd, key: 'w/plans--p.md', open: 2, doc: plan, rel: 'docs/plans/p.md' }] }))
    await fp.emit('input', input('see my notes on the plan'), ctx)
    expect(await hidden(fp, ctx, 'see my notes on the plan')).toContain('the user left 2 open notes in the review page on docs/plans/p.md')
    await fp.emit('input', input('and now?'), ctx)
    expect(await hidden(fp, ctx, 'and now?') ?? '').not.toContain('review page')
  }))

  test('a workflow started in plan mode gets the leave-plan-mode notice; an early edit of another file gets one note per plan', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb)
    const branch: unknown[] = [{ type: 'mode_change', mode: 'plan' }]
    ctx.sessionManager = { ...ctx.sessionManager, getBranch: () => branch }
    await fp.emit('input', input('use the plan-build workflow to add rate limiting'), ctx)
    expect(await hidden(fp, ctx, 'use the plan-build workflow to add rate limiting')).toContain("plan-build was started while the session is in Oh My Pi's plan mode")
    branch.push({ type: 'mode_change', mode: 'none' })
    await fp.emit('input', input('use the plan-build workflow to add caching'), ctx)
    expect(await hidden(fp, ctx, 'use the plan-build workflow to add caching')).not.toContain('was started while')
    saveState('omp', SID, { ...planState(), plan: { ...planState().plan!, path: join(cwd, 'docs', 'plans', 'p.md'), status: 'PENDING', phase: 'plan' } })
    const write = (path: string, id: string) => fp.emit('tool_call', toolCall('write', { path, content: 'x' }, id), ctx) as Promise<{ additionalContext?: string } | undefined>
    expect((await write(join(cwd, 'docs', 'plans', 'p.md'), 'w1'))?.additionalContext ?? '').not.toContain('plan phase')
    expect((await write(join(cwd, 'src', 'app.ts'), 'w2'))?.additionalContext).toContain('is still in its plan phase')
    expect(loadState('omp', SID).guard.earlyEditNoted).toBe(true)
    expect((await write(join(cwd, 'src', 'b.ts'), 'w3'))?.additionalContext ?? '').not.toContain('plan phase')
  }))
})

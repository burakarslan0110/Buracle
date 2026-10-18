import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMPACT_RESTORE_TYPE } from '../../../src/adapters/omp/runtime/compaction'
import { CM_RESTORE_MESSAGE_TYPE, CM_RESTORE_TIMEOUT_MS, CM_SNAPSHOT_TIMEOUT_MS, defaultCmDeps } from '../../../src/adapters/omp/runtime/context-mode'
import { createBuracleExtension, defaultDeps, type ExtensionDeps } from '../../../src/adapters/omp/runtime/extension'
import type { OmpGenerated } from '../../../src/adapters/omp/runtime/types'
import type { CmChildRequest } from '../../../src/adapters/shared/context-mode/client'
import type { CmOpOutcome, CmTarget } from '../../../src/adapters/shared/context-mode/session'
import type { BuracleConfig } from '../../../src/core/config'
import { checkBash } from '../../../src/core/policy/bash-guard'
import { isGuardContinuation } from '../../../src/core/policy/intents'
import { checkWrite } from '../../../src/core/policy/write-guard'
import { cmHome, cmProjectDir } from '../../../src/engine/context-mode'
import { loadLedger } from '../../../src/workflow/ledger'
import { saveState } from '../../../src/workflow/session-store'
import { withSandbox, type Sandbox } from '../../helpers/sandbox'
import { fakeCm, fakeCtx, fakePi, planState, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'
const SID2 = '01a118a8-8d01-740c-9360-aaaaaaaaaaaa'
const RESTORE = '<context_mode_restore source="compact">\nLast request (the user\'s words): "Ship the parser fix"\n</context_mode_restore>'

const cmTool = (tool: string) => `mcp__context_mode_${tool}`
const call = (toolName: string, input: unknown, id = '1') => ({ type: 'tool_call', toolCallId: id, toolName, input })
const result = (toolName: string, input: Record<string, unknown>, text = '', isError = false, id = '1') => ({ type: 'tool_result', toolCallId: id, toolName, input, content: text === '' ? [] : [{ type: 'text', text }], isError })
const input = (text: string) => ({ type: 'input', text, source: 'interactive' })
const turnEnd = { type: 'turn_end', turnIndex: 0 }

function cmGenerated(over: Partial<OmpGenerated> = {}): OmpGenerated {
  const base = testGenerated()
  return testGenerated({
    mcp: [...base.mcp, { id: 'context-mode', description: 'Sandbox and indexed search', transport: 'stdio', critical: true, routing: ['context-saving'], harnesses: ['omp'] }],
    mcpIds: [...base.mcpIds, 'context-mode'],
    ...over,
  })
}

function liveWith(sb: Sandbox, change: (c: BuracleConfig) => BuracleConfig): ExtensionDeps['config'] {
  return d => ({ config: change(d), vault: join(sb.home, 'Documents', 'Buracle'), shim: '/s', source: 'runtime-config' })
}

interface SetupOptions {
  cm?: Parameters<typeof fakeCm>[0]
  deps?: Partial<ExtensionDeps>
  ctx?: Partial<Parameters<typeof fakeCtx>[0]>
  data?: OmpGenerated
}

function setup(sb: Sandbox, o: SetupOptions = {}) {
  const cwd = join(sb.root, 'work')
  const server = join(sb.root, 'server')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(server, { recursive: true })
  const cm = fakeCm({ projectDir: server, ...o.cm })
  const policy = { ...testDeps().deps.policy!, checkBash, checkWrite, routeTool: () => ({ action: 'allow' as const }), capabilityCard: () => '', detectIntent: () => null, isGuardContinuation }
  const t = testDeps({ policy, ...o.deps, cm: o.deps?.cm ?? cm.deps })
  const fp = fakePi()
  createBuracleExtension(o.data ?? cmGenerated(), t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID, ...o.ctx })
  return { ...t, fp, ctx, cwd, server, calls: cm.calls }
}

type Res = { block?: boolean, reason?: string, input?: Record<string, unknown>, additionalContext?: string } | undefined

describe('omp extension: context-mode guards (tool_call)', () => {
  test('every call goes through the sandbox guard, also with routing off: catastrophic commands, protected writes, hidden, unknown and unreadable calls', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { deps: { config: liveWith(sb, c => ({ ...c, routing: { ...c.routing, strictness: 'off' } })) } })
    const emit = async (tool: string, args: unknown) => await fp.emit('tool_call', call(cmTool(tool), args), ctx) as Res
    const home = await emit('ctx_execute', { language: 'shell', code: 'rm -rf ~' })
    expect(home?.block).toBe(true)
    expect(home?.reason).toStartWith('Buracle H01: ')
    expect(home?.reason).toContain('home directory')
    const batch = await emit('ctx_batch_execute', { commands: [{ label: 'a', command: 'ls' }, { label: 'b', command: 'git push --force origin main' }], queries: ['x'] })
    expect(batch?.reason).toStartWith('Buracle H01: ')
    const env = await emit('ctx_execute', { language: 'javascript', code: "require('fs').writeFileSync('.env', 'X=1')" })
    expect(env?.reason).toStartWith('Buracle H02: ')
    expect(env?.reason).toContain('environment secrets')
    expect((await emit('ctx_upgrade', {}))?.reason).toContain('`buracle update --yes context-mode`')
    expect((await emit('ctx_doctor', {}))?.reason).toContain('`buracle doctor context-mode`')
    expect((await emit('ctx_shell_session', { code: 'ls' }))?.reason).toContain('this Buracle version does not know')
    const unreadable = await emit('ctx_execute', { language: 'shell', code: 'ls', env: { PATH: '/tmp' } })
    expect(unreadable?.reason).toStartWith('Buracle H01: The guard could not read this ctx_execute call')
    expect((await emit('ctx_execute', { language: 'go', code: 'package main' }))?.reason).toContain('run it as shell, JavaScript or Python')
    const credentials = await emit('ctx_index', { path: join(sb.home, '.ssh', 'id_ed25519') })
    expect(credentials?.reason).toStartWith('Buracle H02: ')
    expect(await emit('ctx_search', { queries: ['parser'] })).toBeUndefined()
    expect(await emit('ctx_stats', {})).toBeUndefined()
  }))

  test('the session folder is pinned as `cwd` into ctx_execute and ctx_batch_execute calls that name none (one result, the whole input)', () => withSandbox(async sb => {
    const hint = 'Build output is long'
    const { fp, ctx, cwd } = setup(sb, { deps: { policy: { ...testDeps().deps.policy!, checkBash, routeTool: () => ({ action: 'allow' as const, context: [hint] }), detectIntent: () => null, isGuardContinuation } } })
    const emit = async (tool: string, args: Record<string, unknown>) => await fp.emit('tool_call', call(cmTool(tool), args), ctx) as Res
    expect(await emit('ctx_execute', { language: 'shell', code: 'npm test 2>&1 | tail -5', timeout: 60_000 }))
      .toEqual({ additionalContext: hint, input: { language: 'shell', code: 'npm test 2>&1 | tail -5', timeout: 60_000, cwd } })
    expect(await emit('ctx_batch_execute', { commands: ['git log -5'], queries: ['last commit'] }))
      .toEqual({ additionalContext: hint, input: { commands: ['git log -5'], queries: ['last commit'], cwd } })
    expect(await emit('ctx_execute', { language: 'shell', code: 'ls', cwd: 'src' })).toEqual({ additionalContext: hint })
    expect(await emit('ctx_execute_file', { path: 'build.log', language: 'shell', code: 'wc -l' })).toEqual({ additionalContext: hint })
  }))

  test('a call without `cwd` is judged in the session folder AND in the server folder; a relative `cwd` resolves against the server folder', () => withSandbox(async sb => {
    const rm = { language: 'python', code: "import shutil; shutil.rmtree('Documents')" }
    const inHome = setup(sb, { ctx: { cwd: sb.home } })
    const pinned = await inHome.fp.emit('tool_call', call(cmTool('ctx_execute'), rm), inHome.ctx) as Res
    expect(pinned?.block).toBe(true)
    expect(pinned?.reason).toContain('memory vault')
    const serverHome = setup(sb, { cm: { projectDir: sb.home } })
    expect((await serverHome.fp.emit('tool_call', call(cmTool('ctx_execute'), rm), serverHome.ctx) as Res)?.reason).toContain('memory vault')
    expect((await serverHome.fp.emit('tool_call', call(cmTool('ctx_execute'), { ...rm, cwd: '.' }), serverHome.ctx) as Res)?.block).toBe(true)
    const project = setup(sb)
    expect(await project.fp.emit('tool_call', call(cmTool('ctx_execute'), rm), project.ctx)).toEqual({ input: { ...rm, cwd: project.cwd } })
    expect(await project.fp.emit('tool_call', call(cmTool('ctx_execute'), { ...rm, cwd: '.' }), project.ctx)).toBeUndefined()
  }))

  test('H20: each command of a batch needs the user\'s say-so; their yes in the next prompt lets the call run; ctx_purge asks like a database drop', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb)
    const args = { commands: ['git status', 'git push origin feature'], queries: ['pushed'] }
    const held = await fp.emit('tool_call', call(cmTool('ctx_batch_execute'), args), ctx) as Res
    expect(held?.block).toBe(true)
    expect(held?.reason).toStartWith('Buracle H20: ')
    expect(held?.reason).toContain('git push origin feature')
    await fp.emit('input', input('yes'), ctx)
    expect(await fp.emit('tool_call', call(cmTool('ctx_batch_execute'), args, '2'), ctx)).toEqual({ input: { ...args, cwd } })
    const purge = await fp.emit('tool_call', call(cmTool('ctx_purge'), { confirm: true }, '3'), ctx) as Res
    expect(purge?.reason).toStartWith('Buracle H20: ')
    expect(purge?.reason).toContain('ctx_purge --scope project')
    expect(await fp.emit('tool_call', call(cmTool('ctx_purge'), { confirm: false }, '4'), ctx)).toBeUndefined()
  }))

  test('a Buracle review agent may search and run read-only shell commands, never code or index changes; other subagents are judged like the main one', () => withSandbox(async sb => {
    const reviewer = setup(sb, { ctx: { kind: 'sub', name: 'changes-review', sid: SID2 } })
    const emit = async (tool: string, args: Record<string, unknown>) => await reviewer.fp.emit('tool_call', call(cmTool(tool), args), reviewer.ctx) as Res
    const code = await emit('ctx_execute', { language: 'python', code: 'print(1)' })
    expect(code?.reason).toStartWith('Buracle H01: changes-review is a read-only reviewer')
    expect((await emit('ctx_index', { content: 'x', source: 'notes' }))?.reason).toContain('read-only reviewer')
    expect(await emit('ctx_search', { queries: ['diff'] })).toBeUndefined()
    expect(await emit('ctx_execute', { language: 'shell', code: 'git log -3' })).toEqual({ input: { language: 'shell', code: 'git log -3', cwd: reviewer.cwd } })
    const helper = setup(sb, { ctx: { kind: 'sub', name: 'explore', sid: SID2 } })
    expect(await helper.fp.emit('tool_call', call(cmTool('ctx_execute'), { language: 'python', code: 'print(1)' }), helper.ctx)).toEqual({ input: { language: 'python', code: 'print(1)', cwd: helper.cwd } })
  }))

  test('fails closed (R9): a context-mode call is blocked when the extension cannot judge it; other tools keep failing open', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    Object.defineProperty(ctx, 'cwd', { get() { throw new Error('cwd is gone') } })
    const blocked = await fp.emit('tool_call', call(cmTool('ctx_execute'), { language: 'shell', code: 'ls' }), ctx) as Res
    expect(blocked).toEqual({ block: true, reason: 'Buracle H01: the guard could not evaluate this context-mode call (cwd is gone), so it was blocked to stay safe. Run `buracle doctor omp`.' })
    expect((await fp.emit('tool_call', call('mcp__context_mode__ctx_batch_execute', {}), ctx) as Res)?.block).toBe(true)
    expect(await fp.emit('tool_call', call('bash', { command: 'ls' }), ctx)).toBeUndefined()
    const noServer = setup(sb, { cm: {}, deps: { cm: { ...fakeCm().deps, projectDir: () => { throw new Error('no project folder') } } } })
    const r = await noServer.fp.emit('tool_call', call(cmTool('ctx_execute'), { language: 'shell', code: 'ls' }), noServer.ctx) as Res
    expect(r?.reason).toStartWith('Buracle H01: the guard could not evaluate this call (no project folder)')
  }))

  test('through an omp device the outer write is judged on its arguments; the inner call gets consent and the pin', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb)
    const device = (tool: string, content: string, id: string) => fp.emit('tool_call', call('write', { path: `xd://${cmTool(tool)}`, content }, id), ctx) as Promise<Res>
    const rm = await device('ctx_execute', JSON.stringify({ language: 'shell', code: 'rm -rf ~' }), '1')
    expect(rm?.reason).toStartWith('Buracle H01: ')
    const push = { commands: ['git push origin feature'], queries: ['x'] }
    expect(await device('ctx_batch_execute', JSON.stringify(push), '2')).toBeUndefined()
    expect(await device('ctx_execute', 'not json', '3')).toBeUndefined()
    expect(await device('ctx_execute', JSON.stringify({ language: 'shell', code: 'ls', i: 'list files' }), '5')).toBeUndefined()
    expect((await device('ctx_execute', JSON.stringify({ language: 'shell', code: 'ls', env: { A: '1' } }), '6'))?.reason).toStartWith('Buracle H01: The guard could not read this ctx_execute call')
    expect((await fp.emit('tool_call', call(cmTool('ctx_batch_execute'), push, '2'), ctx) as Res)?.reason).toStartWith('Buracle H20: ')
    expect(await fp.emit('tool_call', call(cmTool('ctx_execute'), { language: 'shell', code: 'ls' }, '4'), ctx)).toEqual({ input: { language: 'shell', code: 'ls', cwd } })
  }))
})

describe('omp extension: context-mode in routing and the usage ledger', () => {
  test('H24: a failing context-mode execution is the command\'s failure, not the server\'s; other failing context-mode calls count', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    for (let i = 0; i < 3; i++) await fp.emit('tool_result', result(cmTool('ctx_execute'), { language: 'shell', code: 'npm test' }, 'exit code 1', true, `e${i}`), ctx)
    expect(loadLedger('omp', SID).mcpErrors).toBeUndefined()
    await fp.emit('tool_result', result(cmTool('ctx_search'), { queries: ['x'] }, 'store locked', true, 's1'), ctx)
    expect(loadLedger('omp', SID).mcpErrors).toEqual({ 'context-mode': 1 })
  }))

  test('while contextMode.enabled is false the capability card, the routing and the reminders treat context-mode as down', () => withSandbox(async sb => {
    const run = async (enabled: boolean) => {
      const cards: string[][] = []
      const healths: Array<Record<string, unknown>> = []
      const { fp, ctx } = setup(sb, {
        deps: {
          config: liveWith(sb, c => ({ ...c, contextMode: { ...c.contextMode, enabled } })),
          policy: { ...testDeps().deps.policy!, checkBash, routeTool: (_c, _p, health) => { healths.push({ ...health }); return { action: 'allow' as const } }, capabilityCard: i => { cards.push(i.mcp.map(m => m.id)); return 'CARD' }, detectIntent: () => null, isGuardContinuation },
        },
      })
      await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hi', systemPrompt: [] }, ctx)
      await fp.emit('tool_call', call('bash', { command: 'ls' }), ctx)
      return { card: cards[0] ?? [], health: healths[0]?.['context-mode'] }
    }
    expect(await run(false)).toEqual({ card: ['buracle-memory', 'context7', 'web-search'], health: 'down' })
    expect(await run(true)).toEqual({ card: ['buracle-memory', 'context7', 'web-search', 'context-mode'], health: undefined })
  }))
})

describe('omp extension: context-mode session bridge (H27)', () => {
  test('the main session\'s own prompts and tool results are buffered and recorded by one detached child when the turn ends', () => withSandbox(async sb => {
    const { fp, ctx, cwd, server, calls } = setup(sb)
    await fp.emit('input', input('Fix the parser bug'), ctx)
    await fp.emit('tool_result', result('bash', { command: 'bun test' }, '3 pass\n1 fail', true, '1'), ctx)
    await fp.emit('tool_result', result('edit', { input: '[src/a.ts#1A2B]\nPUT 1.=1:\n+x' }, '', false, '2'), ctx)
    for (const text of ['!ls', '/model', 'Stop hook feedback: Buracle stop guard: the plan is not VERIFIED']) await fp.emit('input', input(text), ctx)
    await fp.emit('input', { type: 'input', text: 'from another extension', source: 'extension' }, ctx)
    await fp.emit('tool_result', result(cmTool('ctx_search'), { queries: ['x'] }, 'hits', false, '3'), ctx)
    await fp.emit('tool_result', result('write', { path: 'xd://mcp__web_search_search', content: '{}' }, '', false, '4'), ctx)
    await fp.emit('tool_result', result('eval', { code: '1 + 1' }, '2', false, '5'), ctx)
    expect((await fp.emit('tool_call', call('bash', { command: 'rm -rf ~' }, 'd1'), ctx) as Res)?.block).toBe(true)
    await fp.emit('tool_result', result('bash', { command: 'rm -rf ~' }, 'Buracle H01: blocked', true, 'd1'), ctx)
    expect(calls.spawned).toEqual([])
    await fp.emit('turn_end', turnEnd, ctx)
    expect(calls.spawned).toEqual([{
      op: 'capture', target: { harness: 'omp', sessionId: SID, projectDir: server },
      events: [
        { kind: 'prompt', text: 'Fix the parser bug' },
        { kind: 'tool', tool: 'Bash', input: { command: 'bun test' }, response: '3 pass\n1 fail', status: 'error' },
        { kind: 'tool', tool: 'Edit', input: { file_path: join(cwd, 'src', 'a.ts') }, response: '', status: 'ok' },
      ],
    }])
    await fp.emit('turn_end', turnEnd, ctx)
    expect(calls.spawned.length).toBe(1)
    expect(calls.runs).toEqual([])
  }))

  test('subagents are never recorded; print mode\'s prompt is read at before_agent_start', () => withSandbox(async sb => {
    const sub = setup(sb, { ctx: { kind: 'sub', sid: SID2 } })
    await sub.fp.emit('input', input('a subagent prompt'), sub.ctx)
    await sub.fp.emit('tool_result', result('bash', { command: 'ls' }, 'a.ts'), sub.ctx)
    await sub.fp.emit('turn_end', turnEnd, sub.ctx)
    expect(sub.calls.spawned).toEqual([])
    const print = setup(sb, { ctx: { mode: 'print' } })
    await print.fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'Summarize the build log', systemPrompt: [] }, print.ctx)
    await print.fp.emit('turn_end', turnEnd, print.ctx)
    expect(print.calls.spawned.map(s => s.events)).toEqual([[{ kind: 'prompt', text: 'Summarize the build log' }]])
  }))

  test('a burst of tool results is recorded before the turn ends (CM_FLUSH_AT)', () => withSandbox(async sb => {
    const { fp, ctx, calls } = setup(sb)
    for (let i = 0; i < 100; i++) await fp.emit('tool_result', result('read', { path: `src/f${i}.ts` }, 'x', false, `r${i}`), ctx)
    expect(calls.spawned.map(s => [s.op, s.events?.length])).toEqual([['capture', 100]])
  }))

  test('the switches keep the bridge quiet: contextMode.capture or .enabled off, BURACLE_NO_CAPTURE, no toolchain copy, memory.exclude naming the server folder', () => withSandbox(async sb => {
    const cases: SetupOptions[] = [
      { deps: { config: liveWith(sb, c => ({ ...c, contextMode: { enabled: true, capture: false } })) } },
      { deps: { config: liveWith(sb, c => ({ ...c, contextMode: { enabled: false, capture: true } })) } },
      { cm: { env: { BURACLE_NO_CAPTURE: '1' } } },
      { cm: { installed: false } },
      { deps: { config: liveWith(sb, c => ({ ...c, memory: { ...c.memory, exclude: [join(sb.root, 'server')] } })) } },
      { deps: { config: liveWith(sb, c => ({ ...c, memory: { ...c.memory, exclude: ['server'] } })) } },
    ]
    for (const o of cases) {
      const { fp, ctx, calls } = setup(sb, o)
      ctx.sessionManager.getSessionFile = () => join(sb.root, 'session.jsonl')
      writeFileSync(join(sb.root, 'session.jsonl'), '{}\n')
      await fp.emit('session_start', { type: 'session_start' }, ctx)
      await fp.emit('input', input('Fix it'), ctx)
      await fp.emit('tool_result', result('bash', { command: 'ls' }, 'a.ts'), ctx)
      await fp.emit('turn_end', turnEnd, ctx)
      expect(await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx)).toBeUndefined()
      await fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 's' }, fromExtension: false }, ctx)
      await fp.emit('session_shutdown', { type: 'session_shutdown' }, ctx)
      await Bun.sleep(0)
      expect({ o, spawned: calls.spawned, runs: calls.runs, sent: fp.sent }).toEqual({ o, spawned: [], runs: [], sent: [] })
    }
  }))

  test('a session start runs the startup op once (detached); a switch records what the previous session buffered; shutdown records the rest', () => withSandbox(async sb => {
    const { fp, ctx, server, calls } = setup(sb)
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await fp.emit('input', input('Plan the release'), ctx)
    const next = fakeCtx({ cwd: ctx.cwd, sid: SID2 })
    await fp.emit('session_switch', { type: 'session_switch', reason: 'new' }, next)
    await fp.emit('input', input('Write the changelog'), next)
    await fp.emit('session_shutdown', { type: 'session_shutdown' }, next)
    const target = (sessionId: string): CmTarget => ({ harness: 'omp', sessionId, projectDir: server })
    expect(calls.spawned).toEqual([
      { op: 'startup', target: target(SID) },
      { op: 'capture', target: target(SID), events: [{ kind: 'prompt', text: 'Plan the release' }] },
      { op: 'startup', target: target(SID2) },
      { op: 'capture', target: target(SID2), events: [{ kind: 'prompt', text: 'Write the changelog' }] },
    ])
    expect(calls.runs).toEqual([])
  }))

  test('a resumed session gets its restore text once with the next turn (session_start with a session file on disk, session_switch resume)', () => withSandbox(async sb => {
    const answer = (req: CmChildRequest): CmOpOutcome | undefined => (req.op === 'restore' ? { ok: true, text: `restored ${req.target.sessionId}` } : undefined)
    const { fp, ctx, server, calls } = setup(sb, { cm: { answer } })
    const file = join(sb.root, 'resumed.jsonl')
    writeFileSync(file, '{"type":"session"}\n')
    ctx.sessionManager.getSessionFile = () => file
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await Bun.sleep(0)
    expect(calls.runs).toEqual([{ req: { op: 'restore', target: { harness: 'omp', sessionId: SID, projectDir: server }, source: 'resume' }, timeoutMs: CM_RESTORE_TIMEOUT_MS }])
    expect(fp.sent).toEqual([{ message: { customType: CM_RESTORE_MESSAGE_TYPE, content: `restored ${SID}`, display: false }, options: { deliverAs: 'nextTurn' } }])
    const resumed = fakeCtx({ cwd: ctx.cwd, sid: SID2 })
    await fp.emit('session_switch', { type: 'session_switch', reason: 'resume', previousSessionFile: file }, resumed)
    await Bun.sleep(0)
    expect(fp.sent.map(s => s.message.content)).toEqual([`restored ${SID}`, `restored ${SID2}`])
    const fresh = setup(sb, { cm: { answer } })
    fresh.ctx.sessionManager.getSessionFile = () => join(sb.root, 'not-yet.jsonl')
    await fresh.fp.emit('session_start', { type: 'session_start' }, fresh.ctx)
    await fresh.fp.emit('session_switch', { type: 'session_switch', reason: 'fork' }, fakeCtx({ cwd: fresh.cwd, sid: SID2 }))
    expect(fresh.calls.runs).toEqual([])
  }))

  test('compaction: one snapshot child records what is buffered; its restore text joins H06\'s result and H07\'s message, then the events file is written', () => withSandbox(async sb => {
    const answer = (req: CmChildRequest): CmOpOutcome | undefined => (req.op === 'snapshot' ? { ok: true, rows: 2, snapshot: '<session_resume>x</session_resume>', text: RESTORE } : undefined)
    const { fp, ctx, server, calls } = setup(sb, {
      cm: { answer },
      deps: { compact: {
        compactInstructions: (_b, s) => `Keep plan ${s.plan?.slug} state`,
        handoffNote: i => ({ slug: `handoff-${i.project}-${i.branch}`, markdown: `# Handoff ${i.sessionId}\n` }),
        restoreContext: (s, handoff) => `Resume plan ${s.plan?.slug}; handoff at ${handoff}`,
      } },
    })
    saveState('omp', SID, planState())
    await fp.emit('input', input('Ship the parser fix'), ctx)
    await fp.emit('tool_result', result('bash', { command: 'bun test' }, '12 pass'), ctx)
    const r = await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx) as { context?: string[], preserveData: Record<string, unknown> }
    const target: CmTarget = { harness: 'omp', sessionId: SID, projectDir: server }
    expect(calls.runs).toEqual([{
      req: { op: 'snapshot', target, events: [{ kind: 'prompt', text: 'Ship the parser fix' }, { kind: 'tool', tool: 'Bash', input: { command: 'bun test' }, response: '12 pass', status: 'ok' }] },
      timeoutMs: CM_SNAPSHOT_TIMEOUT_MS,
    }])
    const handoff = 'handoff-handoff-demo-main'
    expect(r).toEqual({ context: ['Keep plan demo state'], preserveData: { buracle: { v: 1, sessionId: SID, plan: 'docs/plans/2026-10-08-demo.md', handoff, contextMode: RESTORE } } })
    await fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 'We built X.', preserveData: r.preserveData }, fromExtension: false }, ctx)
    expect(fp.sent).toEqual([{ message: { customType: COMPACT_RESTORE_TYPE, content: `Resume plan demo; handoff at ${handoff}\n\n${RESTORE}`, display: false }, options: { deliverAs: 'nextTurn' } }])
    expect(calls.spawned).toEqual([{ op: 'restore', target, source: 'compact' }])
    await fp.emit('turn_end', turnEnd, ctx)
    expect(calls.spawned.length).toBe(1)
  }))

  test('compaction without a plan: Buracle returns no session.compacting result; the bridge sends the restore text on its own at session_compact', () => withSandbox(async sb => {
    const { fp, ctx, calls } = setup(sb, { cm: { answer: req => (req.op === 'snapshot' ? { ok: true, text: RESTORE } : undefined) } })
    expect(await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx)).toBeUndefined()
    await fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 's' }, fromExtension: false }, ctx)
    expect(fp.sent).toEqual([{ message: { customType: CM_RESTORE_MESSAGE_TYPE, content: RESTORE, display: false }, options: { deliverAs: 'nextTurn' } }])
    expect({ runs: calls.runs.map(r => r.req.op), spawned: calls.spawned.map(s => s.op) }).toEqual({ runs: ['snapshot'], spawned: ['restore'] })
    const empty = setup(sb, { cm: { answer: () => ({ ok: true, text: '' }) } })
    expect(await empty.fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, empty.ctx)).toBeUndefined()
    await empty.fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 's' }, fromExtension: false }, empty.ctx)
    await Bun.sleep(0)
    expect({ sent: empty.fp.sent, spawned: empty.calls.spawned, runs: empty.calls.runs.length }).toEqual({ sent: [], spawned: [], runs: 1 })
  }))

  test('an extension omp loaded earlier keeps its session.compacting result (omp keeps only the last one); Buracle\'s restore text still goes out', () => withSandbox(async sb => {
    const { fp, ctx, calls } = setup(sb, { cm: { answer: req => (req.op === 'snapshot' ? { ok: true, text: RESTORE } : undefined) } })
    const other = { context: ['Keep the list of open migrations'], preserveData: { other: { migrations: 3 } } }
    fp.handlers.get('session.compacting')?.unshift(async () => other)
    expect(await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx)).toEqual(other)
    expect(calls.runs.map(r => r.req.op)).toEqual(['snapshot'])
    await fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 's', preserveData: other.preserveData }, fromExtension: false }, ctx)
    expect(fp.sent).toEqual([{ message: { customType: CM_RESTORE_MESSAGE_TYPE, content: RESTORE, display: false }, options: { deliverAs: 'nextTurn' } }])
    expect(calls.spawned.map(s => s.op)).toEqual(['restore'])
  }))

  test('no snapshot answer before the compaction: the restore is recorded and rendered after it and sent on its own; a result another extension replaced is sent too', () => withSandbox(async sb => {
    let snapshots = 0
    const late = setup(sb, { cm: { answer: req => (req.op === 'snapshot' && ++snapshots > 1 ? { ok: true, text: 'LATE RESTORE' } : undefined) } })
    await late.fp.emit('input', input('Rename the module'), late.ctx)
    expect(await late.fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, late.ctx)).toBeUndefined()
    await late.fp.emit('input', input('then run the tests'), late.ctx)
    await late.fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 's' }, fromExtension: true }, late.ctx)
    await Bun.sleep(0)
    expect(late.calls.runs.map(r => [r.req.op, r.timeoutMs, r.req.events])).toEqual([
      ['snapshot', CM_SNAPSHOT_TIMEOUT_MS, [{ kind: 'prompt', text: 'Rename the module' }]],
      ['snapshot', CM_RESTORE_TIMEOUT_MS, [{ kind: 'prompt', text: 'then run the tests' }]],
    ])
    expect(late.fp.sent).toEqual([{ message: { customType: CM_RESTORE_MESSAGE_TYPE, content: 'LATE RESTORE', display: false }, options: { deliverAs: 'nextTurn' } }])
    expect(late.calls.spawned.map(s => [s.op, s.source])).toEqual([['restore', 'compact']])
    const replaced = setup(sb, { cm: { answer: req => (req.op === 'snapshot' ? { ok: true, text: RESTORE } : undefined) } })
    await replaced.fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, replaced.ctx)
    await replaced.fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 's', preserveData: { other: { x: 1 } } }, fromExtension: false }, replaced.ctx)
    expect(replaced.fp.sent).toEqual([{ message: { customType: CM_RESTORE_MESSAGE_TYPE, content: RESTORE, display: false }, options: { deliverAs: 'nextTurn' } }])
    expect(replaced.calls.runs.length).toBe(1)
    const carried = setup(sb)
    await carried.fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 's', preserveData: { buracle: { v: 1, sessionId: SID, contextMode: RESTORE } } }, fromExtension: false }, carried.ctx)
    await Bun.sleep(0)
    expect(carried.fp.sent.map(s => [s.message.customType, s.message.content])).toEqual([[COMPACT_RESTORE_TYPE, RESTORE]])
    expect({ runs: carried.calls.runs, spawned: carried.calls.spawned.map(s => s.op) }).toEqual({ runs: [], spawned: ['restore'] })
  }))
})

describe('omp extension: context-mode production dependencies', () => {
  test('the project folder is the real path of the folder the extension loaded in; the toolchain answer is reused for a minute', () => withSandbox(async ({ buracleHome }) => {
    let now = 1_000_000
    const d = defaultCmDeps(() => now)
    expect(d.projectDir()).toBe(cmProjectDir('omp', { cwd: process.cwd() }))
    expect(d.installed()).toBe(false)
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(join(buracleHome, 'state', 'toolchain.json'), JSON.stringify({
      v: 1, updated_at: 'x', system: {},
      packages: { 'npm:context-mode': { registry: 'npm', name: 'context-mode', version: '1.0.169', dir: '/p', bins: { 'context-mode': '/p/node_modules/context-mode/cli.bundle.mjs' }, installed_at: 'x' } },
    }))
    expect(d.installed()).toBe(false)
    now += 61_000
    expect(d.installed()).toBe(true)
  }))

  test('H16: the production prune also expires context-mode storage, whatever the switches say', () => withSandbox(async () => {
    const NOW = Date.now()
    const sessions = join(cmHome(), 'omp', 'work-0123456789ab', 'sessions')
    mkdirSync(sessions, { recursive: true })
    const old = join(sessions, '0123456789abcdef.db')
    const fresh = join(sessions, 'fedcba9876543210.db')
    writeFileSync(old, '')
    writeFileSync(fresh, '')
    const eightDaysAgo = (NOW - 8 * 24 * 3600_000) / 1000
    utimesSync(old, eightDaysAgo, eightDaysAgo)
    const removed = defaultDeps().prune(new Set(), NOW)
    expect(removed).toContain(old)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  }))
})

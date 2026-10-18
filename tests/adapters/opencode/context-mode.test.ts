import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BuracleRuntime, CONTINUE_MARK, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { CM_EXCLUDE_TTL_MS, CM_FLUSH_AT, CM_STATE_FILE, cmGuardVerdict, OpencodeContextMode, summarizerText, type CmDeps, type CmHost, type CmOutcome } from '../../../src/adapters/opencode/runtime/context-mode'
import type { PermissionEvaluation, SessionCompactionEvent, SessionContextEvent, ToolExecuteAfter } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { CmChildRequest } from '../../../src/adapters/shared/context-mode/client'
import type { BuracleConfig } from '../../../src/core/config'
import type { ToolCall } from '../../../src/core/events'
import { capabilityCard } from '../../../src/core/policy/routing'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import * as paths from '../../../src/engine/paths'
import { loadLedger } from '../../../src/workflow/ledger'
import { saveState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const SID = 'ses_cm01'
const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0)

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

function writeRuntimeConfig(patch: (c: BuracleConfig) => BuracleConfig): void {
  const file = paths.runtimeConfigFile()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ v: 1, config: patch(structuredClone(testBaked().defaults)) }))
}

interface Children {
  spawned: CmChildRequest[]
  ran: Array<{ req: CmChildRequest, timeoutMs: number }>
  answers: Partial<Record<CmChildRequest['op'], (req: CmChildRequest) => CmOutcome | undefined | Promise<CmOutcome | undefined>>>
  pruned: number[]
  deps: CmDeps
}

function children(env: Record<string, string | undefined> = {}, now?: () => number): Children {
  const c: Children = {
    spawned: [], ran: [], answers: {}, pruned: [],
    deps: {
      spawn: req => { c.spawned.push(structuredClone(req)); return true },
      run: async (req, opts) => {
        c.ran.push({ req: structuredClone(req), timeoutMs: opts.timeoutMs })
        return c.answers[req.op]?.(req)
      },
      env: () => env,
      prune: nowMs => { c.pruned.push(nowMs); return { removed: [] } },
      ...(now !== undefined ? { now } : {}),
    },
  }
  return c
}

interface Opts { capture?: PluginDeps['capture']; now?: () => number; cmNow?: () => number; dir?: string; env?: Record<string, string | undefined>; excluded?: CmDeps['excluded'] }

async function runtime(root: string, opts: Opts = {}) {
  const dir = opts.dir ?? root
  const f = fakeServerContext(dir)
  const kids = children(opts.env, opts.cmNow)
  const deps: PluginDeps = {
    baked: testBaked(), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: opts.capture ?? (() => true), maint: () => ({ removed: [] }), notify: () => undefined,
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd),
    contextMode: opts.excluded !== undefined ? { ...kids.deps, excluded: opts.excluded } : kids.deps,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  return { f, rt, kids, deps }
}

type F = Awaited<ReturnType<typeof runtime>>['f']

function evaluation(action: string, callId: string | undefined, sid = SID): PermissionEvaluation {
  const e: PermissionEvaluation = { sessionID: sid, action, resources: ['*'], effect: 'allow' }
  return callId !== undefined ? { ...e, source: { type: 'tool', messageID: 'msg_1', id: callId } } : e
}

let n = 0
async function cmCall(f: F, tool: string, input: Record<string, unknown>, opts: { agent?: string, sid?: string } = {}) {
  const id = `call_cm${n++}`
  const base = { tool: `context-mode_${tool}`, sessionID: opts.sid ?? SID, agent: opts.agent ?? 'build', messageID: 'msg_1', id, input }
  await f.trigger('tool.execute.before', base)
  const ev = await f.trigger('permission.evaluate', evaluation(base.tool, id, base.sessionID))
  return { ev, base }
}

async function toolRun(f: F, tool: string, input: Record<string, unknown>, out: { text?: string, error?: string } = {}, sid = SID) {
  const id = `call_t${n++}`
  const base = { tool, sessionID: sid, agent: 'build', messageID: 'msg_1', id, input }
  await f.trigger('tool.execute.before', base)
  const ev = await f.trigger('permission.evaluate', evaluation(tool, id, sid))
  const after: ToolExecuteAfter = ev.effect === 'deny' || out.error !== undefined
    ? { ...base, status: 'error', error: { message: ev.message ?? out.error ?? 'failed' } }
    : { ...base, status: 'completed', result: { output: { exit: 0 }, content: [{ type: 'text', text: out.text ?? '' }] } }
  await f.trigger('tool.execute.after', after)
  return { ev, after }
}

function ctxEvent(sid = SID): SessionContextEvent {
  return { sessionID: sid, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} }
}

async function contextTexts(f: F, sid = SID): Promise<string[]> {
  const ev = ctxEvent(sid)
  await f.trigger('session.context', ev)
  return ev.system.map(p => p.text)
}

function prompt(text: string, metadata?: Record<string, unknown>, sid = SID) {
  return { sessionID: sid, messageID: `msg_${n++}`, prompt: { text }, delivery: 'steer' as const, ...(metadata !== undefined ? { metadata } : {}) }
}

describe('context-mode guards: decided in tool.execute.before on the arguments, applied in permission.evaluate', () => {
  test('H01: shell code and every batch command go through the bash guard; a harmless call passes unchanged (no cwd is pinned)', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const wipe = await cmCall(f, 'ctx_execute', { language: 'shell', code: 'rm -rf ~' })
    expect(wipe.ev.effect).toBe('deny')
    expect(wipe.ev.message).toStartWith('[Buracle H01 guard.bash] ')
    const batch = await cmCall(f, 'ctx_batch_execute', { commands: [{ label: 'list', command: 'ls' }, 'rm -rf /'], queries: ['files'] })
    expect(batch.ev.effect).toBe('deny')
    expect(batch.ev.message).toStartWith('[Buracle H01 guard.bash] ')
    const ls = await cmCall(f, 'ctx_execute', { language: 'shell', code: 'ls -la' })
    expect(ls.ev.effect).toBe('allow')
    expect(ls.ev.message).toBeUndefined()
    expect(ls.base.input).toEqual({ language: 'shell', code: 'ls -la' })
  }))

  test('H01: the folder a call names is judged against the real session folder (a `cwd` at Buracle\'s checkout from an unrelated project)', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    for (const input of [
      { language: 'shell', code: 'echo x > src/cli/main.ts', cwd: paths.repoRoot() },
      { commands: ['echo x > src/cli/main.ts'], queries: ['done'], cwd: paths.repoRoot() },
    ]) {
      const ev = (await cmCall(f, 'language' in input ? 'ctx_execute' : 'ctx_batch_execute', input)).ev
      expect(ev.effect).toBe('deny')
      expect(ev.message).toStartWith('[Buracle H01 guard.bash] ')
      expect(ev.message).toContain("Buracle's own source code")
    }
    expect((await cmCall(f, 'ctx_execute', { language: 'shell', code: 'echo x > notes.txt' })).ev.effect).toBe('allow')
  }))

  test('the allowlist: unreadable code, unknown input fields, the hidden tools and unknown tools are denied; ctx_search passes', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const go = (await cmCall(f, 'ctx_execute', { language: 'go', code: 'package main' })).ev
    expect(go.effect).toBe('deny')
    expect(go.message).toContain('run it as shell, JavaScript or Python')
    const extra = (await cmCall(f, 'ctx_execute', { language: 'shell', code: 'ls', shell: '/bin/zsh' })).ev
    expect(extra.effect).toBe('deny')
    expect(extra.message).toStartWith('[Buracle H01 guard.bash] ')
    const upgrade = (await cmCall(f, 'ctx_upgrade', {})).ev
    expect(upgrade.effect).toBe('deny')
    expect(upgrade.message).toContain('buracle update --yes context-mode')
    const unknown = (await cmCall(f, 'ctx_teleport', { to: 'x' })).ev
    expect(unknown.effect).toBe('deny')
    expect(unknown.message).toContain('buracle doctor context-mode')
    expect((await cmCall(f, 'ctx_search', { queries: ['parser errors'] })).ev.effect).toBe('allow')
  }))

  test('H02: ctx_execute_file and ctx_index may not read credentials into the index; a project folder is fine', () => withSandbox(async ({ root, home }) => {
    const { f } = await runtime(root)
    const key = (await cmCall(f, 'ctx_execute_file', { path: join(home, '.ssh', 'id_ed25519'), language: 'python', code: 'print(len(FILE_CONTENT))' })).ev
    expect(key.effect).toBe('deny')
    expect(key.message).toStartWith('[Buracle H02 guard.write] ')
    const aws = (await cmCall(f, 'ctx_index', { path: join(home, '.aws') })).ev
    expect(aws.effect).toBe('deny')
    expect(aws.message).toStartWith('[Buracle H02 guard.write] ')
    expect((await cmCall(f, 'ctx_index', { path: 'docs' })).ev.effect).toBe('allow')
  }))

  test('a Buracle reviewer may search and run read-only commands; code, writes and index changes are denied', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const touch = (await cmCall(f, 'ctx_execute', { language: 'shell', code: 'touch notes.md' }, { agent: 'changes-review' })).ev
    expect(touch.effect).toBe('deny')
    expect(touch.message).toContain('changes-review is a read-only reviewer')
    expect((await cmCall(f, 'ctx_execute', { language: 'shell', code: 'git status' }, { agent: 'changes-review' })).ev.effect).toBe('allow')
    expect((await cmCall(f, 'ctx_search', { queries: ['auth'] }, { agent: 'plan-build-review' })).ev.effect).toBe('allow')
    expect((await cmCall(f, 'ctx_index', { path: 'docs' }, { agent: 'plan-build-review' })).ev.effect).toBe('deny')
    expect((await cmCall(f, 'ctx_execute', { language: 'javascript', code: 'console.log(1)' }, { agent: 'goal-build-review' })).ev.effect).toBe('deny')
    expect((await cmCall(f, 'ctx_execute', { language: 'shell', code: 'touch notes.md' }, { agent: 'build' })).ev.effect).toBe('allow')
  }))

  test('H20: every command of a batch needs its own grant (one grant lets nothing else through); ctx_purge waits like a database drop', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const both = { commands: ['git push origin main', 'git reset --hard HEAD~1'], queries: ['result'] }
    const held = (await cmCall(f, 'ctx_batch_execute', both)).ev
    expect(held.effect).toBe('deny')
    expect(held.message).toStartWith('[Buracle H20 consent.gate] ')
    await f.trigger('session.prompt', prompt('evet, pushla'))
    const reset = (await cmCall(f, 'ctx_batch_execute', both)).ev
    expect(reset.effect).toBe('deny')
    expect(reset.message).toContain('reset')
    expect((await cmCall(f, 'ctx_batch_execute', { commands: ['git push origin main', 'ls'], queries: ['result'] })).ev.effect).toBe('allow')
    const purge = (await cmCall(f, 'ctx_purge', { confirm: true })).ev
    expect(purge.effect).toBe('deny')
    expect(purge.message).toStartWith('[Buracle H20 consent.gate] ')
    expect((await cmCall(f, 'ctx_purge', { confirm: false })).ev.effect).toBe('allow')
  }))

  test('the guards hold at any routing strictness and while contextMode.enabled is off', () => withSandbox(async ({ root }) => {
    writeRuntimeConfig(c => ({ ...c, routing: { ...c.routing, strictness: 'off' }, contextMode: { ...c.contextMode, enabled: false } }))
    const { f } = await runtime(root)
    expect((await cmCall(f, 'ctx_execute', { language: 'shell', code: 'rm -rf ~' })).ev.effect).toBe('deny')
    expect((await cmCall(f, 'ctx_doctor', {})).ev.message).toContain('buracle doctor context-mode')
  }))

  test('fail closed: a call permission.evaluate sees without its tool.execute.before is denied, except ctx_search and ctx_stats', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    for (const tool of ['ctx_execute', 'ctx_batch_execute', 'ctx_purge', 'ctx_index']) {
      const ev = await f.trigger('permission.evaluate', evaluation(`context-mode_${tool}`, 'call_never_seen'))
      expect({ tool, effect: ev.effect }).toEqual({ tool, effect: 'deny' })
      expect(ev.message).toStartWith('[Buracle H01 guard.bash] ')
    }
    expect((await f.trigger('permission.evaluate', evaluation('context-mode_ctx_execute', undefined))).effect).toBe('deny')
    expect((await f.trigger('permission.evaluate', evaluation('context-mode_ctx_search', 'call_never_seen'))).effect).toBe('allow')
    expect((await f.trigger('permission.evaluate', evaluation('context-mode_ctx_stats', undefined))).effect).toBe('allow')
    const configured = await f.trigger('permission.evaluate', { ...evaluation('context-mode_ctx_upgrade', undefined), effect: 'deny' as const, message: 'configured' })
    expect(configured.message).toBe('configured')
  }))

  test('fail closed when a guard throws; a failing consent store follows H20\'s failure policy', () => {
    const call: ToolCall = { harness: 'opencode', sessionId: SID, cwd: '/tmp/p', tool: 'context-mode_ctx_execute', kind: 'mcp', input: { language: 'shell', code: 'git push' }, paths: [], mcp: { server: 'context-mode', tool: 'ctx_execute' } }
    const sandbox = () => ({ bash: { extraDeny: [], cwd: '/tmp/p', home: '/home/u' }, write: { cwd: '/tmp/p', home: '/home/u', vault: '/home/u/vault', protect: [] } })
    const errors: string[] = []
    const onError = (hook: string) => { errors.push(hook) }
    const thrown = cmGuardVerdict(() => { throw new Error('classification broke') }, { agent: 'build', sandbox, consentFailure: 'open', onError })
    expect(thrown.deny?.hook).toBe('H01')
    expect(thrown.deny?.reason).toContain('classification broke')
    expect(cmGuardVerdict(() => call, { agent: 'build', sandbox: () => { throw new Error('no options') }, consentFailure: 'open', onError }).deny?.hook).toBe('H01')
    const store = () => { throw new Error('disk full') }
    expect(cmGuardVerdict(() => call, { agent: 'build', sandbox, consent: store, consentFailure: 'open', onError })).toEqual({})
    expect(cmGuardVerdict(() => call, { agent: 'build', sandbox, consent: store, consentFailure: 'closed', onError }).deny?.hook).toBe('H20')
    expect(errors).toEqual(['H01', 'H01', 'H20', 'H20'])
    expect(cmGuardVerdict(() => call, { agent: 'build', sandbox, consentFailure: 'open' })).toEqual({})
  })

  test('H24: a call Buracle denied and failing sandbox code are no failures of the server; failed searches count', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    for (let i = 0; i < 2; i++) {
      const denied = await toolRun(f, 'context-mode_ctx_execute', { language: 'shell', code: 'rm -rf ~' })
      expect(denied.ev.effect).toBe('deny')
      await toolRun(f, 'context-mode_ctx_execute', { language: 'shell', code: 'bun test' }, { error: 'exit code 1' })
    }
    expect(loadLedger('opencode', SID).mcpErrors).toBeUndefined()
    await toolRun(f, 'context-mode_ctx_search', { queries: ['x'] }, { error: 'MCP error -32000: Connection closed' })
    await toolRun(f, 'context-mode_ctx_search', { queries: ['x'] }, { error: 'MCP error -32000: Connection closed' })
    expect(loadLedger('opencode', SID).mcpErrors).toEqual({ 'context-mode': 2 })
  }))
})

describe('contextMode.enabled off: context-mode counts as down for the card, the router and the reminders (read live)', () => {
  test('the capability card leaves context-mode out while it is switched off and names it again when it is back on', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const baked = testBaked()
    const card = (mcp: typeof baked.mcp) => capabilityCard({ policy: baked.routing, mcp, skills: baked.skills, plugins: baked.plugins, harness: 'opencode' })
    expect(baked.mcp.some(m => m.id === 'context-mode')).toBe(true)
    expect((await contextTexts(f))[0]).toBe(card(baked.mcp))
    writeRuntimeConfig(c => ({ ...c, contextMode: { ...c.contextMode, enabled: false } }))
    const off = (await contextTexts(f))[0]
    expect(off).toBe(card(baked.mcp.filter(m => m.id !== 'context-mode')))
    expect(off).not.toBe(card(baked.mcp))
    writeRuntimeConfig(c => c)
    expect((await contextTexts(f))[0]).toBe(card(baked.mcp))
  }))
})

describe('H27 context.session: capture', () => {
  const shell = (command: string) => ({ command, description: 'run it' })

  test('a root session\'s start opens its session; the user\'s prompt and the turn\'s tool results reach one capture child at the turn\'s end', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    const target = { harness: 'opencode' as const, sessionId: SID, projectDir: root }
    expect(kids.spawned).toEqual([{ op: 'startup', target }])
    await f.trigger('session.prompt', prompt('fix the parser'))
    await toolRun(f, 'shell', shell('bun test'), { text: '3 pass\n0 fail' })
    await toolRun(f, 'read', { filePath: join(root, 'src', 'parser.ts') }, { text: 'export function parse() {}' })
    await toolRun(f, 'context-mode_ctx_search', { queries: ['parser'] }, { text: 'hits' })
    expect(kids.spawned.length).toBe(1)
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await rt.idle()
    expect(kids.spawned.slice(1)).toEqual([{
      op: 'capture', target, events: [
        { kind: 'prompt', text: 'fix the parser' },
        { kind: 'tool', tool: 'Bash', input: { command: 'bun test' }, response: '3 pass\n0 fail', status: 'ok' },
        { kind: 'tool', tool: 'Read', input: { file_path: join(root, 'src', 'parser.ts') }, response: '', status: 'ok' },
      ],
    }])
    await rt.handleEvent({ type: 'session.idle', data: { sessionID: SID } })
    expect(kids.spawned.length).toBe(2)
  }))

  test('the session store is the location\'s real folder, the one its context-mode server keys by', () => withSandbox(async ({ root }) => {
    const real = join(root, 'real')
    mkdirSync(real, { recursive: true })
    symlinkSync(real, join(root, 'link'))
    const { f, rt, kids } = await runtime(root, { dir: join(root, 'link') })
    await f.trigger('session.prompt', prompt('hello there'))
    await rt.handleEvent({ type: 'session.execution.failed', data: { sessionID: SID } })
    expect(kids.spawned.map(r => r.target.projectDir)).toEqual([realpathSync(real)])
  }))

  test('a workflow command is recorded as the user typed it; a failed call keeps its error', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    await f.trigger('session.prompt', prompt('Run the plan.\n\n(Run this with the Buracle plan-build workflow: load the plan-build skill.)', { 'buracle.command': 'plan-build', 'buracle.args': 'add a health check' }))
    await toolRun(f, 'shell', shell('bun test'), { error: 'exit code 1: 2 fail' })
    await rt.handleEvent({ type: 'session.execution.failed', data: { sessionID: SID } })
    expect(kids.spawned[0]?.events).toEqual([
      { kind: 'prompt', text: '/plan-build add a health check' },
      { kind: 'tool', tool: 'Bash', input: { command: 'bun test' }, response: 'exit code 1: 2 fail', status: 'error' },
    ])
  }))

  test('a shell call that completes with a non-zero exit is recorded as failed, one that exits 0 as ok (OpenCode 2.0.24 result shape)', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    const finish = async (command: string, exit: number, notice: string, text: string) => {
      const id = `call_t${n++}`
      const base = { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: shell(command) }
      await f.trigger('tool.execute.before', base)
      await f.trigger('permission.evaluate', evaluation('shell', id))
      const content = [{ type: 'text' as const, text }, ...(notice !== '' ? [{ type: 'text' as const, text: notice }] : [])]
      const after: ToolExecuteAfter = { ...base, status: 'completed', result: { output: { output: text, exit, truncated: false, status: 'completed' }, content, metadata: { exit } } }
      await f.trigger('tool.execute.after', after)
    }
    await finish('bun test', 1, 'Exited with code 1', '(fail) parses empty input')
    await finish('ls src', 0, '', 'app.ts')
    await rt.handleEvent({ type: 'session.execution.failed', data: { sessionID: SID } })
    expect(kids.spawned[0]?.events).toMatchObject([
      { kind: 'tool', tool: 'Bash', input: { command: 'bun test' }, status: 'error' },
      { kind: 'tool', tool: 'Bash', input: { command: 'ls src' }, status: 'ok' },
    ])
  }))

  test('Buracle\'s continuations, a subagent\'s prompts and calls, and calls Buracle denied are never recorded', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    const child = 'ses_cmchild1'
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    expect(kids.spawned.map(r => [r.op, r.target.sessionId])).toEqual([['startup', SID]])
    await f.trigger('session.prompt', prompt('Buracle stop guard: the plan is not VERIFIED, keep working', { [CONTINUE_MARK]: true }))
    await f.trigger('session.prompt', prompt('Buracle stop guard: keep working'))
    await f.trigger('session.prompt', prompt('list the files', undefined, child))
    await toolRun(f, 'shell', shell('ls'), { text: 'a b' }, child)
    f.parents['ses_cmchild2'] = SID
    await toolRun(f, 'shell', shell('pwd'), { text: '/x' }, 'ses_cmchild2')
    const denied = await toolRun(f, 'shell', shell('rm -rf /'))
    expect(denied.ev.effect).toBe('deny')
    await toolRun(f, 'shell', shell('git status'), { text: 'clean' })
    for (const sid of [SID, child, 'ses_cmchild2']) await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: sid } })
    await rt.idle()
    expect(kids.spawned.slice(1)).toEqual([{ op: 'capture', target: { harness: 'opencode', sessionId: SID, projectDir: root }, events: [{ kind: 'tool', tool: 'Bash', input: { command: 'git status' }, response: 'clean', status: 'ok' }] }])
  }))

  test('a failed or interrupted run, a deleted session and the plugin\'s stop flush what is buffered', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    const sids = ['ses_cmf1', 'ses_cmf2', 'ses_cmf3', 'ses_cmf4']
    for (const sid of sids) await f.trigger('session.prompt', prompt(`work on ${sid}`, undefined, sid))
    await rt.handleEvent({ type: 'session.execution.failed', data: { sessionID: 'ses_cmf1' } })
    await rt.handleEvent({ type: 'session.execution.interrupted', data: { sessionID: 'ses_cmf2' } })
    await rt.handleEvent({ type: 'session.deleted', data: { sessionID: 'ses_cmf3' } })
    expect(kids.spawned.map(r => r.target.sessionId)).toEqual(['ses_cmf1', 'ses_cmf2', 'ses_cmf3'])
    await rt.dispose()
    expect(kids.spawned.map(r => [r.op, r.target.sessionId, r.events?.length])).toEqual(sids.map(sid => ['capture', sid, 1]))
  }))

  test(`a long run is flushed every ${CM_FLUSH_AT} events, before its end`, () => withSandbox(async ({ root }) => {
    const { f, kids } = await runtime(root)
    for (let i = 0; i < CM_FLUSH_AT + 3; i++) await toolRun(f, 'shell', shell(`echo ${i}`), { text: String(i) })
    expect(kids.spawned.map(r => r.events?.length)).toEqual([CM_FLUSH_AT])
  }))

  test('nothing is recorded or restored while contextMode.capture or .enabled is off, capture is off for the session, BURACLE_NO_CAPTURE=1 or memory.exclude names the folder', () => withSandbox(async ({ root }) => {
    const cases: Array<[string, () => Promise<Awaited<ReturnType<typeof runtime>>>]> = [
      ['capture off', async () => { writeRuntimeConfig(c => ({ ...c, contextMode: { ...c.contextMode, capture: false } })); return runtime(root) }],
      ['enabled off', async () => { writeRuntimeConfig(c => ({ ...c, contextMode: { ...c.contextMode, enabled: false } })); return runtime(root) }],
      ['session capture off', async () => { writeRuntimeConfig(c => c); return runtime(root, { capture: () => false }) }],
      ['BURACLE_NO_CAPTURE', async () => { writeRuntimeConfig(c => c); return runtime(root, { env: { BURACLE_NO_CAPTURE: '1' } }) }],
      ['memory.exclude', async () => {
        const app = join(root, 'app')
        mkdirSync(app, { recursive: true })
        writeRuntimeConfig(c => ({ ...c, memory: { ...c.memory, exclude: [app] } }))
        return runtime(root, { dir: app })
      }],
    ]
    for (const [name, make] of cases) {
      const { f, rt, kids } = await make()
      await rt.idle()
      await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
      await f.trigger('session.prompt', prompt('fix the parser'))
      await toolRun(f, 'shell', shell('bun test'), { text: '3 pass' })
      const ev: SessionCompactionEvent = { ...ctxEvent(), agent: 'compaction' }
      await f.trigger('session.compaction', ev)
      await rt.handleEvent({ type: 'session.compaction.ended', data: { sessionID: SID, text: 'Summary', reason: 'auto' } })
      await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
      await rt.idle()
      expect({ name, spawned: kids.spawned, ran: kids.ran }).toEqual({ name, spawned: [], ran: [] })
    }
  }))

  test(`memory.exclude is checked again after ${CM_EXCLUDE_TTL_MS / 1000} s: once the folder is kept out, buffered events are dropped and nothing new is recorded`, () => withSandbox(async ({ root }) => {
    let now = T0
    const app = join(root, 'app')
    mkdirSync(app, { recursive: true })
    writeRuntimeConfig(c => c)
    const { f, rt, kids } = await runtime(root, { dir: app, cmNow: () => now })
    await rt.idle()
    await f.trigger('session.prompt', prompt('first request'))
    await rt.handleEvent({ type: 'session.execution.failed', data: { sessionID: SID } })
    expect(kids.spawned.map(r => r.events?.map(e => e.kind === 'prompt' ? e.text : e.tool))).toEqual([['first request']])
    writeRuntimeConfig(c => ({ ...c, memory: { ...c.memory, exclude: [app] } }))
    now += CM_EXCLUDE_TTL_MS - 1
    await f.trigger('session.prompt', prompt('second request'))
    now += 1
    await f.trigger('session.prompt', prompt('third request'))
    await rt.idle()
    await f.trigger('session.prompt', prompt('fourth request'))
    await rt.handleEvent({ type: 'session.execution.failed', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: 'ses_cmx2', location: { directory: app } } })
    await rt.dispose()
    expect(kids.spawned.length).toBe(1)
  }))
})

describe('H27 context.session: compaction and resume', () => {
  const snapshotXml = '<session_resume events="2" compact_count="1">\n## Files\n- src/parser.ts\n</session_resume>'
  const restoreOf = (tag: string) => `<context_mode_restore source="compact">\nLast request (the user's words): "${tag}"\n</context_mode_restore>`

  async function compact(f: F, rt: BuracleRuntime, sid = SID): Promise<string[]> {
    const ev: SessionCompactionEvent = { ...ctxEvent(sid), agent: 'compaction' }
    await f.trigger('session.compaction', ev)
    await rt.handleEvent({ type: 'session.compaction.ended', data: { sessionID: sid, text: 'Summary', reason: 'auto' } })
    await rt.idle()
    return ev.system.map(p => p.text)
  }

  test('the snapshot op takes the buffered events; its snapshot goes to the summarizer; its restore text joins every request after the compaction, also before compaction.ended arrives', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    kids.answers.snapshot = () => ({ ok: true, rows: 2, snapshot: snapshotXml, text: restoreOf('one') })
    kids.answers.restore = () => ({ ok: true, text: restoreOf('from the restore op') })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await f.trigger('session.prompt', prompt('fix the parser'))
    await toolRun(f, 'shell', { command: 'bun test' }, { text: '1 fail' })
    const ev: SessionCompactionEvent = { ...ctxEvent(), agent: 'compaction' }
    await f.trigger('session.compaction', ev)
    expect(kids.ran).toEqual([{
      req: { op: 'snapshot', target: { harness: 'opencode', sessionId: SID, projectDir: root }, events: [{ kind: 'prompt', text: 'fix the parser' }, { kind: 'tool', tool: 'Bash', input: { command: 'bun test' }, response: '1 fail', status: 'ok' }] },
      timeoutMs: 3000,
    }])
    expect(ev.system.map(p => p.text)).toContain(summarizerText(snapshotXml))
    expect(await contextTexts(f)).toContain(restoreOf('one'))
    await rt.handleEvent({ type: 'session.compaction.ended', data: { sessionID: SID, text: 'Summary', reason: 'auto' } })
    await rt.idle()
    for (let i = 0; i < 2; i++) expect(await contextTexts(f)).toContain(restoreOf('one'))
    expect(kids.ran.map(r => [r.req.op, r.req.source])).toEqual([['snapshot', undefined], ['restore', 'compact']])
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    expect(kids.spawned.map(r => r.op)).toEqual(['startup'])
    const file = join(paths.sessionDir('opencode', SID), CM_STATE_FILE)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, restore: restoreOf('one') })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const again = await runtime(root)
    expect(await contextTexts(again.f)).toContain(restoreOf('one'))
    expect(again.kids.ran).toEqual([])
  }))

  test('the next compaction replaces the text; without a snapshot answer the events go to a capture child and the restore op supplies the text', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    kids.answers.snapshot = () => ({ ok: true, rows: 0, text: restoreOf('one') })
    kids.answers.restore = () => ({ ok: true, text: restoreOf('three') })
    await compact(f, rt)
    expect(await contextTexts(f)).toContain(restoreOf('one'))
    kids.answers.snapshot = () => ({ ok: true, rows: 0, text: restoreOf('two') })
    await compact(f, rt)
    const second = await contextTexts(f)
    expect(second).toContain(restoreOf('two'))
    expect(second).not.toContain(restoreOf('one'))
    kids.answers.snapshot = () => undefined
    await f.trigger('session.prompt', prompt('add a test'))
    await compact(f, rt)
    expect(kids.spawned).toEqual([{ op: 'capture', target: { harness: 'opencode', sessionId: SID, projectDir: root }, events: [{ kind: 'prompt', text: 'add a test' }] }])
    const third = await contextTexts(f)
    expect(third).toContain(restoreOf('three'))
    expect(third).not.toContain(restoreOf('two'))
    kids.answers.snapshot = () => ({ ok: true, rows: 0, text: '' })
    kids.answers.restore = () => ({ ok: true, text: '' })
    await compact(f, rt)
    expect((await contextTexts(f)).join('\n')).not.toContain('context_mode_restore')
    expect(existsSync(join(paths.sessionDir('opencode', SID), CM_STATE_FILE))).toBe(false)
  }))

  test('a compaction that fails (session.compaction.failed) leaves the restore text before it in force and kept, also for a reloaded plugin; it counts as no compaction', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, { v: 1, plan: { path: 'docs/plans/2026-10-10-x.md', slug: 'x', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1 }, guard: { blocksForPlan: 0, blocksInChain: 0 } })
    const { f, rt, kids } = await runtime(root)
    const file = join(paths.sessionDir('opencode', SID), CM_STATE_FILE)
    const failed = async (): Promise<string[]> => {
      const ev: SessionCompactionEvent = { ...ctxEvent(), agent: 'compaction' }
      await f.trigger('session.compaction', ev)
      await rt.handleEvent({ type: 'session.compaction.failed', data: { sessionID: SID, reason: 'manual', error: { type: 'aborted', message: 'Compaction cancelled' } } })
      await rt.idle()
      return ev.system.map(p => p.text)
    }
    kids.answers.snapshot = () => ({ ok: true, rows: 2, snapshot: snapshotXml, text: restoreOf('failed') })
    expect(await failed()).toContain(summarizerText(snapshotXml))
    for (let i = 0; i < 2; i++) {
      const texts = (await contextTexts(f)).join('\n')
      expect(texts).not.toContain('context_mode_restore')
      expect(texts).not.toContain('the context was compacted')
    }
    expect(existsSync(file)).toBe(false)
    kids.answers.snapshot = () => ({ ok: true, rows: 2, text: restoreOf('one') })
    await compact(f, rt)
    kids.answers.snapshot = () => ({ ok: true, rows: 3, snapshot: snapshotXml, text: restoreOf('failed') })
    await failed()
    for (let i = 0; i < 2; i++) {
      const texts = await contextTexts(f)
      expect(texts).toContain(restoreOf('one'))
      expect(texts).not.toContain(restoreOf('failed'))
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, restore: restoreOf('one') })
    const again = await runtime(root)
    const reloaded = await contextTexts(again.f)
    expect(reloaded).toContain(restoreOf('one'))
    expect(reloaded).not.toContain(restoreOf('failed'))
    expect(kids.ran.map(r => r.req.op)).toEqual(['snapshot', 'snapshot', 'restore', 'snapshot'])
  }))

  test('a compaction cancelled while its snapshot child still runs (OpenCode does not wait for the hook) leaves the text before it in force: the late answer is dropped', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    const file = join(paths.sessionDir('opencode', SID), CM_STATE_FILE)
    kids.answers.snapshot = () => ({ ok: true, rows: 2, text: restoreOf('zero') })
    await compact(f, rt)
    let release: ((o: CmOutcome) => void) | undefined
    kids.answers.snapshot = () => new Promise<CmOutcome>(resolve => { release = resolve })
    const hook = f.trigger('session.compaction', { ...ctxEvent(), agent: 'compaction' } as SessionCompactionEvent)
    for (let i = 0; i < 100 && release === undefined; i++) await Bun.sleep(1)
    await rt.handleEvent({ type: 'session.compaction.failed', data: { sessionID: SID, reason: 'manual', error: { type: 'aborted', message: 'Compaction cancelled' } } })
    release?.({ ok: true, rows: 3, text: restoreOf('cancelled') })
    await hook
    await rt.idle()
    for (let i = 0; i < 2; i++) {
      const texts = await contextTexts(f)
      expect(texts).toContain(restoreOf('zero'))
      expect(texts).not.toContain(restoreOf('cancelled'))
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, restore: restoreOf('zero') })
    kids.answers.snapshot = () => ({ ok: true, rows: 4, text: restoreOf('failed') })
    await f.trigger('session.compaction', { ...ctxEvent(), agent: 'compaction' } as SessionCompactionEvent)
    await rt.handleEvent({ type: 'session.compaction.failed', data: { sessionID: SID, reason: 'auto', error: { type: 'compaction.interrupted', message: 'Compaction was interrupted' } } })
    const texts = await contextTexts(f)
    expect(texts).toContain(restoreOf('zero'))
    expect(texts.join('\n')).not.toContain('"failed"')
    expect(texts.join('\n')).not.toContain('"cancelled"')
  }))

  test('the restore text before a compaction stays kept until it ends: a plugin started after the compaction failed (OpenCode restarted) pushes it', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    kids.answers.snapshot = () => ({ ok: true, rows: 2, text: restoreOf('one') })
    await compact(f, rt)
    kids.answers.snapshot = () => ({ ok: true, rows: 3, snapshot: snapshotXml, text: restoreOf('interrupted') })
    await f.trigger('session.compaction', { ...ctxEvent(), agent: 'compaction' } satisfies SessionCompactionEvent)
    expect(await contextTexts(f)).toContain(restoreOf('interrupted'))
    const after = await runtime(root)
    await after.rt.handleEvent({ type: 'session.compaction.failed', data: { sessionID: SID, reason: 'auto', error: { type: 'compaction.interrupted', message: 'Compaction was interrupted' } } })
    await after.rt.idle()
    const texts = await contextTexts(after.f)
    expect(texts).toContain(restoreOf('one'))
    expect(texts).not.toContain(restoreOf('interrupted'))
  }))

  test('a subagent\'s compaction takes no snapshot and gets no restore', () => withSandbox(async ({ root }) => {
    const { f, rt, kids } = await runtime(root)
    kids.answers.snapshot = () => ({ ok: true, snapshot: snapshotXml, text: restoreOf('child') })
    const child = 'ses_cmchild9'
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    const system = await compact(f, rt, child)
    expect(system).not.toContain(summarizerText(snapshotXml))
    expect(kids.ran).toEqual([])
    expect((await contextTexts(f, child)).join('\n')).not.toContain('context_mode_restore')
  }))

  test('a root session OpenCode created before this plugin instance gets the restore op (source resume) once; a new session does not; the text is not kept', () => withSandbox(async ({ root }) => {
    let clock = T0
    const { f, kids } = await runtime(root, { now: () => clock })
    const resumed = `<context_mode_restore source="resume">\nLast request (the user's words): "earlier work"\n</context_mode_restore>`
    kids.answers.restore = () => ({ ok: true, text: resumed })
    f.created[SID] = T0 - DAY
    f.created['ses_cmnew1'] = T0 + 5_000
    clock += 10_000
    await f.trigger('session.prompt', prompt('where were we?'))
    expect(await contextTexts(f)).toContain(resumed)
    expect(await contextTexts(f)).toContain(resumed)
    expect(kids.ran.map(r => [r.req.op, r.req.source, r.req.target.sessionId, r.timeoutMs])).toEqual([['restore', 'resume', SID, 3000]])
    expect(existsSync(join(paths.sessionDir('opencode', SID), CM_STATE_FILE))).toBe(false)
    await f.trigger('session.prompt', prompt('hello', undefined, 'ses_cmnew1'))
    expect((await contextTexts(f, 'ses_cmnew1')).join('\n')).not.toContain('context_mode_restore')
    expect(kids.ran.length).toBe(1)
    f.parents['ses_cmsub1'] = SID
    f.created['ses_cmsub1'] = T0 - DAY
    expect((await contextTexts(f, 'ses_cmsub1')).join('\n')).not.toContain('context_mode_restore')
    expect(kids.ran.length).toBe(1)
  }))

  test('a resumed session with a kept compaction restore gets that text and no resume op', () => withSandbox(async ({ root }) => {
    const kept = restoreOf('kept')
    mkdirSync(paths.sessionDir('opencode', SID), { recursive: true })
    writeFileSync(join(paths.sessionDir('opencode', SID), CM_STATE_FILE), JSON.stringify({ v: 1, restore: kept }))
    const { f, kids } = await runtime(root, { now: () => T0 })
    f.created[SID] = T0 - DAY
    await f.trigger('session.prompt', prompt('continue'))
    expect(await contextTexts(f)).toContain(kept)
    expect(kids.ran).toEqual([])
  }))

  test('a kept restore text is not pushed while the first memory.exclude check is still running, when that check keeps the folder out', () => withSandbox(async ({ root }) => {
    const kept = restoreOf('kept before the exclusion')
    mkdirSync(paths.sessionDir('opencode', SID), { recursive: true })
    writeFileSync(join(paths.sessionDir('opencode', SID), CM_STATE_FILE), JSON.stringify({ v: 1, restore: kept }))
    const releases: Array<() => void> = []
    const slow: NonNullable<CmDeps['excluded']> = () => new Promise(res => { releases.push(() => res('excluded by memory.exclude (app)')) })
    const { f, kids } = await runtime(root, { now: () => T0, excluded: slow })
    f.created[SID] = T0 - DAY
    await f.trigger('session.prompt', prompt('continue'))
    const texts = contextTexts(f)
    await new Promise(res => setTimeout(res, 0))
    for (const release of releases) release()
    expect((await texts).join('\n')).not.toContain('context_mode_restore')
    expect(kids.ran).toEqual([])
    const host: CmHost = { directory: root, cfg: () => testBaked().defaults, log: () => undefined, track: p => p }
    for (const ask of [(cm: OpencodeContextMode) => cm.requestText(SID, true), async (cm: OpencodeContextMode) => { await cm.resume(SID, true); return cm.requestText(SID, true) }]) {
      const cm = new OpencodeContextMode(host, { ...children().deps, excluded: slow })
      const text = ask(cm)
      for (const release of releases.splice(0)) release()
      expect(await text).toBeUndefined()
    }
  }))
})

describe('H16: the plugin\'s maintenance prunes context-mode\'s storage too', () => {
  test('runMaintenance calls the housekeeping, whether capture is on or off', () => withSandbox(async ({ root }) => {
    const { rt, kids } = await runtime(root, { capture: () => false, now: () => T0 })
    rt.runMaintenance()
    expect(kids.pruned).toEqual([T0])
  }))

  test('the default housekeeping is the shared cmPrune: a detached child\'s unread input file goes after 10 minutes', () => withSandbox(async ({ root, buracleHome }) => {
    const tmp = join(buracleHome, 'context-mode', 'tmp')
    mkdirSync(tmp, { recursive: true })
    const old = join(tmp, 'in-1-abcdef.json')
    const fresh = join(tmp, 'in-2-abcdef.json')
    for (const file of [old, fresh]) writeFileSync(file, '{"events":[]}')
    const aged = new Date(Date.now() - 3600_000)
    utimesSync(old, aged, aged)
    const rt = new BuracleRuntime(fakeServerContext(root).ctx, { baked: testBaked(), memory: fakeMemory(), settleMs: 0, maint: () => ({ removed: [] }) })
    rt.runMaintenance()
    expect({ old: existsSync(old), fresh: existsSync(fresh) }).toEqual({ old: false, fresh: true })
  }))
})

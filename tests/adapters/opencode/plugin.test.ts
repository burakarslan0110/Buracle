import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MEMORY_INJECT } from '../../../src/core/memory/budgets'
import { capabilityCard } from '../../../src/core/policy/routing'
import { CONTINUE_MARK, BuracleRuntime, contextNote, createBuraclePlugin, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { AUTO_PAUSE_REASON, clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import type { PermissionEvaluation, SessionContextEvent, ShellCreateBefore, ToolExecuteAfter } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { BuracleConfig } from '../../../src/core/config'
import type { SessionState } from '../../../src/core/plan/state'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import * as paths from '../../../src/engine/paths'
import { readFlow } from '../../../src/workflow/flow'
import { loadState, readTelemetry, saveState } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked, until } from './helpers'

const SID = 'ses_test01'

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

function planState(over: Partial<NonNullable<SessionState['plan']>> = {}): SessionState {
  return {
    v: 1,
    plan: { path: 'docs/plans/2026-10-08-x.md', slug: 'x', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1, ...over },
    guard: { blocksForPlan: 0, blocksInChain: 0 },
  }
}

function evaluation(action: string, resources: string[], callId?: string): PermissionEvaluation {
  const e: PermissionEvaluation = { sessionID: SID, action, resources, effect: 'allow' }
  return callId !== undefined ? { ...e, source: { type: 'tool', messageID: 'msg_1', id: callId } } : e
}

function writeRuntimeConfig(patch: (c: BuracleConfig) => BuracleConfig, resolved: Record<string, unknown> = {}): void {
  const file = paths.runtimeConfigFile()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ v: 1, config: patch(structuredClone(testBaked().defaults)), resolved }))
}

interface RuntimeOpts {
  settleMs?: number
  now?: () => number
  memoryText?: string
  routing?: ReturnType<typeof testBaked>['routing']
  capture?: PluginDeps['capture']
  maint?: PluginDeps['maint']
  workspace?: PluginDeps['workspace']
  idleFinalizeMs?: number
  runChecker?: PluginDeps['runChecker']
}

async function runtime(dir: string, opts: RuntimeOpts = {}) {
  const f = fakeServerContext(dir)
  const mem = fakeMemory(opts.memoryText)
  const baked = testBaked(opts.routing !== undefined ? { routing: opts.routing } : {})
  const notices: Array<{ title: string, message: string }> = []
  const maintCalls: Array<{ nowMs: number, keep: string[] }> = []
  const deps: PluginDeps = {
    baked, memory: mem, settleMs: opts.settleMs ?? 0, runChecker: opts.runChecker ?? (async () => ({ code: 0, stdout: '', stderr: '' })),
    capture: opts.capture ?? (() => true),
    maint: opts.maint ?? ((nowMs, keep) => { maintCalls.push({ nowMs, keep }); return { removed: [] } }),
    notify: (title, message) => { notices.push({ title, message }) },
    workspace: opts.workspace ?? (async cwd => noProject(cwd)),
    workspaceRead: async cwd => noProject(cwd),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.idleFinalizeMs !== undefined ? { idleFinalizeMs: opts.idleFinalizeMs } : {}),
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  return { f, mem, rt, baked, notices, maintCalls }
}

describe('opencode server plugin: setup and lifecycle', () => {
  test('setup registers every hook, consumes events and finalizes root sessions on cleanup', () => withSandbox(async ({ root }) => {
    const f = fakeServerContext(root)
    const mem = fakeMemory()
    const plugin = createBuraclePlugin({ baked: testBaked(), memory: mem, settleMs: 0, capture: () => true, maint: () => ({ removed: [] }), workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd) })
    expect(plugin.id).toBe('buracle')
    const cleanup = await plugin.setup(f.ctx)
    expect([...f.hooks.keys()].sort()).toEqual([
      'permission.evaluate', 'session.compaction', 'session.context', 'session.experimental.ws.receive', 'session.http.response', 'session.prompt', 'shell.create.before', 'tool.execute.after', 'tool.execute.before',
    ])
    expect(f.hooks.get('session.http.response')?.length).toBe(2)
    f.events.push({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    f.events.push({ type: 'session.created', data: { sessionID: 'ses_child1', parentID: SID, location: { directory: root } } })
    await until(() => mem.started.length === 1)
    expect(mem.started).toEqual([{ sid: SID, cwd: root }])
    expect(typeof cleanup).toBe('function')
    await (cleanup as () => Promise<void>)()
    expect(mem.finalized).toEqual([SID])
  }))

  test('a session that predates the plugin is looked up: root sessions get a stub note, subagents do not', () => withSandbox(async ({ root }) => {
    const { f, rt, mem } = await runtime(root)
    f.parents['ses_sub9'] = 'ses_parent9'
    await f.trigger('tool.execute.before', { tool: 'read', sessionID: 'ses_old9', agent: 'build', messageID: 'msg_1', id: 'call_r1', input: { path: 'a.ts' } })
    await f.trigger('tool.execute.before', { tool: 'read', sessionID: 'ses_sub9', agent: 'explore', messageID: 'msg_2', id: 'call_r2', input: { path: 'a.ts' } })
    await rt.idle()
    expect(mem.started).toEqual([{ sid: 'ses_old9', cwd: root }])
  }))

  test('H14: a subagent\'s tool calls go to its root session\'s spool; its prompts, turns and compactions are not the session\'s, and no spool file is kept for it', () => withSandbox(async ({ root }) => {
    const { f, rt, mem } = await runtime(root)
    const child = 'ses_child3'
    const grandchild = 'ses_grand3'
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    await f.trigger('session.prompt', { sessionID: child, messageID: 'msg_c1', prompt: { text: 'list the files' }, delivery: 'steer' })
    const ls = { command: 'ls' }
    await f.trigger('tool.execute.before', { tool: 'shell', sessionID: child, agent: 'general', messageID: 'msg_c2', id: 'call_c1', input: ls })
    await f.trigger('tool.execute.after', { tool: 'shell', sessionID: child, agent: 'general', messageID: 'msg_c2', id: 'call_c1', input: ls, status: 'completed', result: { output: { exit: 0 }, content: [{ type: 'text', text: '' }] } } satisfies ToolExecuteAfter)
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: child } })
    await rt.handleEvent({ type: 'session.text.ended', data: { sessionID: child, text: 'Found 3 files.' } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: child } })
    await rt.handleEvent({ type: 'session.compaction.ended', data: { sessionID: child, text: 'Child summary', reason: 'auto' } })
    f.parents[grandchild] = child
    f.parents[child] = SID
    const write = { path: 'notes.md', content: 'x\n' }
    await f.trigger('tool.execute.before', { tool: 'write', sessionID: grandchild, agent: 'general', messageID: 'msg_g1', id: 'call_g1', input: write })
    await f.trigger('tool.execute.after', { tool: 'write', sessionID: grandchild, agent: 'general', messageID: 'msg_g1', id: 'call_g1', input: write, status: 'completed', result: { output: {}, content: [{ type: 'text', text: 'Wrote notes.md' }] } } satisfies ToolExecuteAfter)
    await rt.handleEvent({ type: 'session.deleted', data: { sessionID: child } })
    await rt.idle()
    await rt.dispose()
    expect(mem.appended.map(a => a.sid).filter(sid => sid !== SID)).toEqual([])
    expect(mem.appended.flatMap(a => a.entries).map(e => [e.ev, e.tool, e.kind])).toEqual([['tool', 'shell', 'bash'], ['tool', 'write', 'write']])
    expect(mem.started.map(s => s.sid)).toEqual([SID])
    expect(mem.finalized).toEqual([SID])
  }))

  test('H14: a root session whose only work this plugin instance saw was a subagent\'s is started and finalized with that work', () => withSandbox(async ({ root }) => {
    const { f, rt, mem } = await runtime(root)
    f.parents['ses_sub8'] = 'ses_root8'
    const ls = { command: 'ls' }
    await f.trigger('tool.execute.before', { tool: 'shell', sessionID: 'ses_sub8', agent: 'general', messageID: 'msg_s1', id: 'call_s8', input: ls })
    await f.trigger('tool.execute.after', { tool: 'shell', sessionID: 'ses_sub8', agent: 'general', messageID: 'msg_s1', id: 'call_s8', input: ls, status: 'completed', result: { output: { exit: 0 }, content: [{ type: 'text', text: '' }] } } satisfies ToolExecuteAfter)
    await rt.idle()
    await rt.dispose()
    expect(mem.appended.map(a => a.sid)).toEqual(['ses_root8'])
    expect(mem.started.map(s => s.sid)).toEqual(['ses_root8'])
    expect(mem.finalized).toEqual(['ses_root8'])
  }))

  test('H25/H26: a skill a subagent loads starts no run and spools nothing, also before this instance knows the subagent\'s parent', () => withSandbox(async ({ root }) => {
    const { f, rt, mem } = await runtime(root)
    f.parents['ses_sub7'] = SID
    await f.trigger('tool.execute.before', { tool: 'skill', sessionID: 'ses_sub7', agent: 'general', messageID: 'msg_k1', id: 'call_k1', input: { name: 'plan-build' } })
    await rt.idle()
    expect(readFlow('opencode', 'ses_sub7')).toBeUndefined()
    expect(mem.appended).toEqual([])
  }))

  test('H14: a root session idle after its last turn is finalized without session.deleted; a new turn restarts the wait', () => withSandbox(async ({ root }) => {
    const { rt, mem } = await runtime(root, { idleFinalizeMs: 60 })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await Bun.sleep(30)
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await Bun.sleep(80)
    expect(mem.finalized).toEqual([])
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await Bun.sleep(120)
    await rt.idle()
    expect(mem.finalized).toEqual([SID])
  }))

  test('H14: a session of the memory\'s own model runner (a buracle-runner-* folder) captures nothing and is never finalized', () => withSandbox(async ({ root }) => {
    const { rt, mem } = await runtime(root, { idleFinalizeMs: 20 })
    const runnerDir = join(root, 'buracle-runner-AbC123')
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: runnerDir } } })
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.text.ended', data: { sessionID: SID, text: '{"summary":"s"}' } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await Bun.sleep(60)
    await rt.idle()
    await rt.handleEvent({ type: 'session.deleted', data: { sessionID: SID } })
    expect(mem.started).toEqual([])
    expect(mem.appended).toEqual([])
    expect(mem.finalized).toEqual([])
  }))

  test('a session of the memory\'s own model runner (a buracle-runner-* folder) gets no system context: no capability card, memory or workspace text', () => withSandbox(async ({ root }) => {
    const { f, rt, mem } = await runtime(root, { memoryText: '# Buracle memory' })
    const runnerDir = join(root, 'buracle-runner-QwE456')
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: runnerDir } } })
    const ev: SessionContextEvent = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'buracle-memory-runner', system: [{ type: 'text', text: 'host prompt' }], messages: [], options: {}, tools: {} }
    await f.trigger('session.context', ev)
    expect(ev.system.map(p => p.text)).toEqual(['host prompt'])
    expect(mem.contexts).toEqual([])
  }))

  test('H14: a plugin instance for a runner folder captures nothing even when session.created carries no location', () => withSandbox(async ({ root }) => {
    const runnerDir = join(root, 'buracle-runner-XyZ789')
    mkdirSync(runnerDir, { recursive: true })
    const { rt, mem } = await runtime(runnerDir, { idleFinalizeMs: 20 })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await Bun.sleep(60)
    await rt.dispose()
    expect(mem.started).toEqual([])
    expect(mem.finalized).toEqual([])
  }))

  test('the memory UI follows root sessions: started, refreshed by prompts and tool calls, ended by session.deleted, never by the idle finalize; capture off too', () => withSandbox(async ({ root }) => {
    const { f, rt, mem } = await runtime(root, { idleFinalizeMs: 20, capture: () => false })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.idle()
    await f.trigger('session.prompt', { sessionID: SID, messageID: 'msg_p1', prompt: { text: 'hello' }, delivery: 'steer' })
    const ls = { command: 'ls' }
    await f.trigger('tool.execute.before', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_t1', id: 'call_t1', input: ls })
    await f.trigger('tool.execute.after', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_t1', id: 'call_t1', input: ls, status: 'completed', result: { output: { exit: 0 }, content: [{ type: 'text', text: '' }] } } satisfies ToolExecuteAfter)
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await Bun.sleep(60)
    await rt.idle()
    expect(mem.uiCalls).toEqual([`started ${SID}`, `seen ${SID}`, `seen ${SID}`])
    await rt.handleEvent({ type: 'session.created', data: { sessionID: 'ses_child5', parentID: SID, location: { directory: root } } })
    await rt.handleEvent({ type: 'session.deleted', data: { sessionID: 'ses_child5' } })
    await rt.handleEvent({ type: 'session.deleted', data: { sessionID: SID } })
    await rt.idle()
    expect(mem.uiCalls).toEqual([`started ${SID}`, `seen ${SID}`, `seen ${SID}`, `ended ${SID}`])
  }))

  test('closing OpenCode (dispose) ends the open root sessions for the memory UI; a runner folder never reaches it', () => withSandbox(async ({ root }) => {
    const { rt, mem } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: 'ses_run1', location: { directory: join(root, 'buracle-runner-Ab1') } } })
    await rt.idle()
    await rt.dispose()
    expect(mem.uiCalls.filter(c => c.startsWith('started'))).toEqual([`started ${SID}`])
    expect(mem.uiCalls).toContain(`ended ${SID}`)
  }))

  test('session.deleted finalizes a root session; invalid ids are ignored', () => withSandbox(async ({ root }) => {
    const { rt, mem } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.handleEvent({ type: 'session.deleted', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.deleted', data: { sessionID: '../evil' } })
    expect(mem.finalized).toEqual([SID])
  }))
})

describe('opencode server plugin: permission.evaluate guards', () => {
  test('H01 denies a destructive shell command with the reason; harmless commands pass', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    await f.trigger('tool.execute.before', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_1', input: { command: 'rm -rf /' } })
    const bad = await f.trigger('permission.evaluate', evaluation('shell', ['rm -rf /'], 'call_1'))
    expect(bad.effect).toBe('deny')
    expect(bad.message).toStartWith('[Buracle H01 guard.bash] ')
    const ok = await f.trigger('permission.evaluate', evaluation('shell', ['ls -la']))
    expect(ok.effect).toBe('allow')
    expect(ok.message).toBeUndefined()
  }))

  test('H20 holds a push for the user\'s say-so; their own words in the next prompt let it through', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const held = await f.trigger('permission.evaluate', evaluation('shell', ['git push origin main']))
    expect(held.effect).toBe('deny')
    expect(held.message).toStartWith('[Buracle H20 consent.gate] ')
    expect((await f.trigger('permission.evaluate', evaluation('shell', ['git status']))).effect).toBe('allow')
    await f.trigger('session.prompt', { sessionID: SID, messageID: 'msg_p', prompt: { text: 'evet, pushla' }, delivery: 'steer' as const })
    expect((await f.trigger('permission.evaluate', evaluation('shell', ['git push origin main']))).effect).toBe('allow')
  }))

  test('H01 sees the whole command line from the correlated call (cd is not a permission resource)', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    await f.trigger('tool.execute.before', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_2', input: { command: 'git push --force origin main' } })
    const ev = await f.trigger('permission.evaluate', evaluation('shell', ['git push --force origin main'], 'call_2'))
    expect(ev.effect).toBe('deny')
    expect(ev.message).toContain('H01')
  }))

  test('H02 denies writing a secret file named by the permission resources; ordinary files pass', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const secret = await f.trigger('permission.evaluate', evaluation('edit', ['.env']))
    expect(secret.effect).toBe('deny')
    expect(secret.message).toStartWith('[Buracle H02 guard.write] ')
    await f.trigger('tool.execute.before', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_3', input: { path: 'src/app.ts', content: 'x' } })
    const plain = await f.trigger('permission.evaluate', evaluation('edit', ['src/app.ts'], 'call_3'))
    expect(plain.effect).toBe('allow')
  }))

  test("SEC-1: a relocated XDG_CONFIG_HOME, and the Buracle checkout from an unrelated session, are refused to edits and the shell", () => withSandbox(async ({ root }) => {
    const xdg = join(root, 'xdg')
    const config = join(xdg, 'opencode', 'opencode.json')
    await withEnv({ XDG_CONFIG_HOME: xdg }, async () => {
      const { f } = await runtime(root)
      const edit = await f.trigger('permission.evaluate', evaluation('edit', [config]))
      expect(edit.effect).toBe('deny')
      expect(edit.message).toContain("OpenCode's own configuration")
      expect((await f.trigger('permission.evaluate', evaluation('shell', [`echo '{}' > '${config}'`]))).message).toContain("OpenCode's own configuration")
    })
    const { f } = await runtime(root)
    const target = join(paths.repoRoot(), 'src', 'cli', 'main.ts')
    expect((await f.trigger('permission.evaluate', evaluation('edit', [target]))).message).toContain("Buracle's own source code")
    expect((await f.trigger('permission.evaluate', evaluation('shell', [`echo x > '${target}'`]))).message).toContain("Buracle's own source code")
    expect((await f.trigger('permission.evaluate', evaluation('shell', [`cat '${target}'`]))).effect).toBe('allow')
  }))

  test('H02 judges `~/...` from the tool input as the home path OpenCode writes; the spool records it there', () => withSandbox(async ({ root, home }) => {
    const { f, mem } = await runtime(root)
    await f.trigger('tool.execute.before', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_t1', input: { path: '~/.ssh/authorized_keys', content: 'ssh-ed25519 AAAA x\n' } })
    const ssh = await f.trigger('permission.evaluate', evaluation('edit', [], 'call_t1'))
    expect(ssh.effect).toBe('deny')
    expect(ssh.message).toStartWith('[Buracle H02 guard.write] ')
    expect(ssh.message).toContain('`~/.ssh/authorized_keys`')
    const input = { path: '~/notes/todo.md', content: '- x\n' }
    await f.trigger('tool.execute.before', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_t2', input })
    expect((await f.trigger('permission.evaluate', evaluation('edit', [join(home, 'notes', 'todo.md')], 'call_t2'))).effect).toBe('allow')
    mkdirSync(join(home, 'notes'), { recursive: true })
    writeFileSync(join(home, 'notes', 'todo.md'), input.content)
    await f.trigger('tool.execute.after', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_t2', input, status: 'completed', result: { output: {}, content: [{ type: 'text', text: 'Wrote the file' }] } } satisfies ToolExecuteAfter)
    const written = mem.appended.flatMap(a => a.entries).find(e => e.ev === 'tool' && e.kind === 'write')
    expect(written?.paths).toEqual([join(home, 'notes', 'todo.md')])
  }))

  test('H03 enforce denies the built-in websearch while web-search is usable; down → allowed', () => withSandbox(async ({ root, buracleHome }) => {
    const routing = { strictness: 'enforce' as const, categories: [{ id: 'web-search', intent: 'search the web', prefer: ['mcp:web-search/search'], fallback: ['builtin:web_search'], deny_builtin: ['web_search'] }] }
    const { f } = await runtime(root, { routing })
    const denied = await f.trigger('permission.evaluate', evaluation('websearch', ['bun 1.4 release notes']))
    expect(denied.effect).toBe('deny')
    expect(denied.message).toContain('web-search_search')
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(join(buracleHome, 'state', 'health.json'), JSON.stringify({ mcp: { 'web-search': 'down' } }))
    const allowed = await f.trigger('permission.evaluate', evaluation('websearch', ['bun 1.4 release notes']))
    expect(allowed.effect).toBe('allow')
  }))

  test('H09 denies a routine "should I continue?" question while an approved plan runs', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const { f } = await runtime(root)
    await f.trigger('tool.execute.before', { tool: 'question', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_q', input: { questions: [{ question: 'Should I continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] } })
    const ev = await f.trigger('permission.evaluate', evaluation('question', ['*'], 'call_q'))
    expect(ev.effect).toBe('deny')
    expect(ev.message).toStartWith('[Buracle H09 plan.question] ')
    await f.trigger('tool.execute.before', { tool: 'question', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_q2', input: { questions: [{ question: 'Use Postgres or SQLite for the cache?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } })
    const real = await f.trigger('permission.evaluate', evaluation('question', ['*'], 'call_q2'))
    expect(real.effect).toBe('allow')
  }))

  test('a configured deny stays final, external_directory is not judged, malformed events never throw', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const already = await f.trigger('permission.evaluate', { ...evaluation('shell', ['ls']), effect: 'deny' as const, message: 'configured' })
    expect(already.message).toBe('configured')
    const ext = await f.trigger('permission.evaluate', evaluation('external_directory', ['/etc/*']))
    expect(ext.effect).toBe('allow')
    const broken = { sessionID: SID, action: 'edit', resources: null, effect: 'allow' } as unknown as PermissionEvaluation
    await expect(f.trigger('permission.evaluate', broken)).resolves.toBeDefined()
  }))
})

describe('opencode server plugin: tool results, context, compaction, prompts, shell', () => {
  test('execute.after spools edit and shell metadata and appends H04 notes and nudges', () => withSandbox(async ({ root }) => {
    const { f, mem } = await runtime(root)
    const file = join(root, 'big.ts')
    writeFileSync(file, Array.from({ length: 1200 }, (_, i) => `export const v${i} = ${i}`).join('\n'))
    await f.trigger('tool.execute.before', { tool: 'edit', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_e', input: { path: 'big.ts', oldString: 'a', newString: 'const x = "a​b"' } })
    const after: ToolExecuteAfter = { tool: 'edit', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_e', input: { path: 'big.ts', oldString: 'a', newString: 'const x = "a​b"' }, status: 'completed', result: { output: { replacements: 1 }, content: [{ type: 'text', text: 'Edited big.ts' }] } }
    await f.trigger('tool.execute.after', after)
    const content = after.status === 'completed' ? after.result.content : undefined
    expect(Array.isArray(content)).toBe(true)
    const texts = (content as unknown as Array<{ text: string }>).map(c => c.text)
    expect(texts[0]).toBe('Edited big.ts')
    expect(texts.join('\n')).toContain('Buracle checks (H04):')
    const edit = mem.appended.flatMap(a => a.entries).find(e => e.ev === 'tool' && e.kind === 'edit')
    expect(edit?.paths).toEqual([file])

    await f.trigger('tool.execute.before', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_s', input: { command: 'grep -r foo .' } })
    await f.trigger('permission.evaluate', evaluation('shell', ['grep -r foo .'], 'call_s'))
    const sh: ToolExecuteAfter = { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_s', input: { command: 'grep -r foo .' }, status: 'completed', result: { output: { exit: 1, output: '', truncated: false }, content: [{ type: 'text', text: '' }] } }
    await f.trigger('tool.execute.after', sh)
    const shText = sh.status === 'completed' ? (sh.result.content as unknown as Array<{ text: string }>).map(c => c.text).join('\n') : ''
    expect(shText).toContain('rg')
    const bash = mem.appended.flatMap(a => a.entries).find(e => e.ev === 'tool' && e.kind === 'bash')
    expect(bash).toMatchObject({ tool: 'shell', cmd: 'grep -r foo .', exit: 1 })
  }))

  test('H03 shell notes ride the tool result: a shell file write points to edit, write or patch, a file print to read', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const shell = async (id: string, command: string): Promise<string> => {
      await f.trigger('tool.execute.before', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: { command } })
      const after: ToolExecuteAfter = { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: { command }, status: 'completed', result: { output: { exit: 0, output: '', truncated: false }, content: [{ type: 'text', text: '' }] } }
      await f.trigger('tool.execute.after', after)
      return after.status === 'completed' ? (after.result.content as unknown as Array<{ text: string }>).map(c => c.text).join('\n') : ''
    }
    expect(await shell('call_w', "sed -i 's/a/b/' src/a.ts")).toContain('this shell command writes `src/a.ts` (sed -i in place). Make ordinary source edits with the edit, write or patch tool instead')
    expect(await shell('call_r', 'cat src/a.ts')).toContain('read `src/a.ts` with the read tool instead of printing it in the shell')
  }))

  test('H04: a missing linter is named once per session; a mirrored test folder silences the TDD note', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root, { runChecker: async () => ({ code: 127, stdout: '', stderr: 'spawn shellcheck ENOENT' }) })
    mkdirSync(join(root, 'src', 'core'), { recursive: true })
    mkdirSync(join(root, 'tests', 'core'), { recursive: true })
    writeFileSync(join(root, 'run.sh'), 'echo $1\n')
    writeFileSync(join(root, 'src', 'core', 'x.ts'), 'export const x = 1\n')
    writeFileSync(join(root, 'tests', 'core', 'x.test.ts'), "import { x } from '../../src/core/x'\n")
    const write = async (id: string, path: string, content: string): Promise<string> => {
      await f.trigger('tool.execute.before', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: { path, content } })
      const after: ToolExecuteAfter = { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: { path, content }, status: 'completed', result: { output: {}, content: [{ type: 'text', text: 'Wrote' }] } }
      await f.trigger('tool.execute.after', after)
      return after.status === 'completed' ? (after.result.content as unknown as Array<{ text: string }>).map(c => c.text).join('\n') : ''
    }
    expect(await write('call_1', 'run.sh', 'echo $1\n')).toContain('run.sh: shellcheck is not installed, so it did not check this file: run `buracle install`.')
    expect(await write('call_2', 'run.sh', 'echo $1\n')).not.toContain('Buracle checks (H04)')
    expect(await write('call_3', 'src/core/x.ts', 'export const x = 1\n')).not.toContain('Buracle checks (H04)')
  }))

  test('H04: a patch that adds a file under ~/ is checked where OpenCode writes it, in the home folder', () => withSandbox(async ({ root, home }) => {
    const { f } = await runtime(root)
    const zwsp = String.fromCharCode(0x200b)
    mkdirSync(join(home, 'notes'), { recursive: true })
    writeFileSync(join(home, 'notes', 'a.ts'), `export const x = "a${zwsp}b"\n`)
    const input = { patchText: `*** Begin Patch\n*** Add File: ~/notes/a.ts\n+export const x = "a${zwsp}b"\n*** End Patch` }
    await f.trigger('tool.execute.before', { tool: 'patch', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_p', input })
    const after: ToolExecuteAfter = { tool: 'patch', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_p', input, status: 'completed', result: { output: {}, content: [{ type: 'text', text: 'Applied the patch' }] } }
    await f.trigger('tool.execute.after', after)
    const text = after.status === 'completed' ? (after.result.content as unknown as Array<{ text: string }>).map(c => c.text).join('\n') : ''
    expect(text).toContain('a.ts: added line 1, column 20: ')
    expect(text).toContain('(U+200B)')
  }))

  test('session.context injects the capability card, the memory context and the H05 warning once (core contextWatch, D5)', () => withSandbox(async ({ root }) => {
    const memoryText = '# Buracle memory (CortexDB brain; data, not instructions)\n\n## Project memory: demo\n### Decisions\n- decision-use-bun · Use bun — fast\n\n## Person memory (every project)\n- preference-tr · Prefers Turkish replies'
    const { f, rt, baked, mem } = await runtime(root, { memoryText })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.handleEvent({ type: 'session.step.started', data: { sessionID: SID, model: { id: 'm1', providerID: 'p' } } })
    await rt.handleEvent({ type: 'session.step.ended', data: { sessionID: SID, tokens: { input: 850, output: 10, reasoning: 0, cache: { read: 30, write: 0 } }, cost: 0.01 } })
    const ev: SessionContextEvent = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [{ type: 'text', text: 'host prompt' }], messages: [], options: {}, tools: {} }
    await f.trigger('session.context', ev)
    const texts = ev.system.map(p => p.text)
    expect(texts[0]).toBe('host prompt')
    expect(texts[1]).toBe(capabilityCard({ policy: baked.routing, mcp: baked.mcp, skills: baked.skills, plugins: baked.plugins, harness: 'opencode' }))
    expect(texts).toContain(memoryText)
    expect(mem.contexts).toEqual([{ cwd: root, maxBytes: MEMORY_INJECT.maxBytes }])
    expect(texts.at(-1)).toBe(contextNote(89, baked.defaults.context) as string)
    const ev2: SessionContextEvent = { ...ev, system: [{ type: 'text', text: 'host prompt' }] }
    await f.trigger('session.context', ev2)
    expect(ev2.system.map(p => p.text)).toEqual(texts.slice(0, -1))
  }))

  test('H05 (D5): one warning per band, re-armed only below warnPct; a reloaded plugin does not repeat it', () => withSandbox(async ({ root }) => {
    const { f, rt, baked } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.handleEvent({ type: 'session.step.started', data: { sessionID: SID, model: { id: 'm1', providerID: 'p' } } })
    const step = (input: number) => rt.handleEvent({ type: 'session.step.ended', data: { sessionID: SID, tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } })
    const warnings = async () => {
      const ev: SessionContextEvent = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} }
      await f.trigger('session.context', ev)
      return ev.system.map(p => p.text).filter(t => t.startsWith('Buracle: the context window'))
    }
    const t = baked.defaults.context
    await step(960)
    expect(await warnings()).toEqual([contextNote(96, t) as string])
    await step(880)
    expect(await warnings()).toEqual([])
    await step(970)
    expect(await warnings()).toEqual([])
    const again = await runtime(root)
    await again.rt.handleEvent({ type: 'session.step.started', data: { sessionID: SID, model: { id: 'm1', providerID: 'p' } } })
    await again.rt.handleEvent({ type: 'session.step.ended', data: { sessionID: SID, tokens: { input: 970, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } })
    const ev: SessionContextEvent = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} }
    await again.f.trigger('session.context', ev)
    expect(ev.system.map(p => p.text).filter(x => x.startsWith('Buracle: the context window'))).toEqual([])
    await step(400)
    expect(await warnings()).toEqual([])
    await step(860)
    expect(await warnings()).toEqual([contextNote(86, t) as string])
  }))

  test('SEC-11: the H02 context carries the symlink resolver (I4); a project link into ~/.ssh resolves to its target', () => withSandbox(async ({ root, home }) => {
    const { rt } = await runtime(root)
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'authorized_keys'), 'k\n')
    mkdirSync(join(root, 'proj'), { recursive: true })
    symlinkSync(join(home, '.ssh'), join(root, 'proj', 'cfg'))
    const ctx = rt.writeContext(join(root, 'proj'), testBaked().defaults) as unknown as { realpath?: (p: string) => string | undefined }
    expect(ctx.realpath?.(join(root, 'proj', 'cfg', 'config'))).toBe(join(home, '.ssh', 'config'))
  }))

  test('compaction saves a handoff and steers the summary; compaction.ended spools it and restores the plan', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const { f, rt, mem } = await runtime(root)
    const ev = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'compaction', system: [] as Array<{ type: 'text', text: string }>, messages: [], options: {}, tools: {} }
    await f.trigger('session.compaction', ev)
    expect(ev.system.length).toBe(1)
    expect(ev.system[0]?.text).toContain('docs/plans/2026-10-08-x.md')
    expect(mem.handoffs.length).toBe(1)
    expect(mem.handoffs[0]).toMatchObject({ sessionId: SID, cwd: root })
    expect(mem.handoffs[0]?.markdown).toContain('docs/plans/2026-10-08-x.md')
    await rt.handleEvent({ type: 'session.compaction.ended', data: { sessionID: SID, text: 'Summary: did things', reason: 'auto' } })
    expect(mem.appended.flatMap(a => a.entries).some(e => e.ev === 'compact' && e.excerpt === 'Summary: did things')).toBe(true)
    const ctxEv: SessionContextEvent = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} }
    await f.trigger('session.context', ctxEv)
    expect(ctxEv.system.some(p => p.text.includes('docs/plans/2026-10-08-x.md'))).toBe(true)
  }))

  test('compaction without a plan saves a handoff too (the same rule on every harness)', () => withSandbox(async ({ root }) => {
    const { f, mem } = await runtime(root)
    const ev = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'compaction', system: [] as Array<{ type: 'text', text: string }>, messages: [], options: {}, tools: {} }
    await f.trigger('session.compaction', ev)
    expect(mem.handoffs.length).toBe(1)
    expect(mem.handoffs[0]).toMatchObject({ sessionId: SID, cwd: root })
    expect(mem.handoffs[0]?.markdown).toContain('None.')
  }))

  test('prompt hook records pause and resume intents and a history hint; guard continuations are skipped', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const { f } = await runtime(root)
    const prompt = (text: string, metadata?: Record<string, unknown>) => ({ sessionID: SID, messageID: 'msg_p', prompt: { text }, delivery: 'steer' as const, ...(metadata ? { metadata } : {}) })
    await f.trigger('session.prompt', prompt('dur'))
    expect(loadState('opencode', SID).interaction?.state).toBe('paused')
    await f.trigger('session.prompt', prompt('Buracle stop guard: keep working', { [CONTINUE_MARK]: true }))
    expect(loadState('opencode', SID).interaction?.state).toBe('paused')
    await f.trigger('session.prompt', prompt('devam'))
    expect(loadState('opencode', SID).interaction?.state).toBe('running')
    await f.trigger('session.prompt', prompt('geçen sefer ne karar vermiştik?'))
    const ev: SessionContextEvent = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} }
    await f.trigger('session.context', ev)
    expect(ev.system.some(p => p.text.includes('memory_search'))).toBe(true)
  }))

  test('shell.create.before exports the session of the correlated call and clears foreign session ids', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    await f.trigger('tool.execute.before', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_sh', input: { command: 'buracle plan status --json' } })
    const ev: ShellCreateBefore = { command: 'buracle plan status --json', cwd: root, timeout: 0, shell: '/bin/zsh', env: { CLAUDE_CODE_SESSION_ID: 'claude-1', CODEX_SESSION_ID: 'codex-root-1', CODEX_THREAD_ID: 'codex-thread-1', PATH: '/bin' } }
    await f.trigger('shell.create.before', ev)
    expect(ev.env['BURACLE_HARNESS']).toBe('opencode')
    expect(ev.env['BURACLE_SESSION_ID']).toBe(SID)
    expect(ev.env['CLAUDE_CODE_SESSION_ID']).toBeUndefined()
    expect(ev.env['CODEX_SESSION_ID']).toBeUndefined()
    expect(ev.env['CODEX_THREAD_ID']).toBeUndefined()
    expect(ev.env['PATH']).toBe('/bin')
    const pty: ShellCreateBefore = { command: 'zsh', cwd: root, timeout: 0, shell: '/bin/zsh', env: { BURACLE_SESSION_ID: 'stale' } }
    await f.trigger('shell.create.before', pty)
    expect(pty.env['BURACLE_SESSION_ID']).toBeUndefined()
  }))

  test('usage and step events write session telemetry (context fill from the model window)', () => withSandbox(async ({ root }) => {
    const { rt } = await runtime(root)
    await rt.handleEvent({ type: 'session.step.started', data: { sessionID: SID, model: { id: 'm1', providerID: 'p', variant: 'high' } } })
    await rt.handleEvent({ type: 'session.step.ended', data: { sessionID: SID, tokens: { input: 400, output: 50, reasoning: 0, cache: { read: 50, write: 0 } }, cost: 0.02 } })
    await rt.handleEvent({ type: 'session.usage.updated', data: { sessionID: SID, cost: 0.25, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } })
    const t = readTelemetry('opencode', SID)
    expect(t).toMatchObject({ harness: 'opencode', sessionId: SID, model: 'p/m1', modelId: 'p/m1', effort: 'high', costUsd: 0.25, ctx: { pct: 50, tokens: 500, window: 1000 } })
  }))

  test('H18: a subagent session writes no telemetry (the status line follows the newest telemetry), whether or not the plugin saw it created', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root)
    const seen = 'ses_subtel1'
    const unseen = 'ses_subtel2'
    await rt.handleEvent({ type: 'session.created', data: { sessionID: seen, parentID: SID, location: { directory: root } } })
    f.parents[unseen] = SID
    for (const sid of [seen, unseen]) {
      await rt.handleEvent({ type: 'session.step.started', data: { sessionID: sid, model: { id: 'm1', providerID: 'p' } } })
      await rt.handleEvent({ type: 'session.step.ended', data: { sessionID: sid, tokens: { input: 400, output: 50, reasoning: 0, cache: { read: 50, write: 0 } } } })
      await rt.handleEvent({ type: 'session.usage.updated', data: { sessionID: sid, cost: 0.25 } })
      expect({ sid, telemetry: readTelemetry('opencode', sid) }).toEqual({ sid, telemetry: undefined })
    }
    await rt.handleEvent({ type: 'session.usage.updated', data: { sessionID: SID, cost: 0.5 } })
    expect(readTelemetry('opencode', SID)).toMatchObject({ sessionId: SID, costUsd: 0.5 })
  }))
})

describe('opencode server plugin: stop guard emulation (H08/H11)', () => {
  const cycle = async (rt: BuracleRuntime, sid = SID) => {
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: sid } })
    await rt.handleEvent({ type: 'session.text.ended', data: { sessionID: sid, text: 'Done with task 1.' } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: sid } })
    await rt.idle()
  }

  test('an unfinished plan is continued with the core reason, once per stop, until the chain cap and its one escalation', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    let clock = 1_000_000
    const { f, rt, mem } = await runtime(root, { now: () => clock })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await cycle(rt)
    expect(f.prompts.length).toBe(1)
    expect(f.prompts[0]?.text).toStartWith('Buracle stop guard:')
    expect(f.prompts[0]?.metadata?.[CONTINUE_MARK]).toBe(true)
    expect(f.prompts[0]?.delivery).toBe('queue')
    expect(mem.appended.flatMap(a => a.entries).some(e => e.ev === 'turn' && e.excerpt === 'Done with task 1.')).toBe(true)
    await rt.handleEvent({ type: 'session.idle', data: { sessionID: SID } })
    await rt.idle()
    expect(f.prompts.length).toBe(1)
    for (let i = 0; i < 8; i++) { clock += 120_000; await cycle(rt) }
    expect(f.prompts.length).toBe(testBaked().defaults.plan.runaway.perChain + 1)
    expect(f.prompts.at(-1)?.text).toContain('runaway: continue, pivot or abandon?')
  }))

  test('no continuation after an interrupt, a new execution, a user prompt, for subagents or without a plan', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const { f, rt } = await runtime(root, { settleMs: 40 })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.interrupted', data: { sessionID: SID, reason: 'user' } })
    await rt.idle()
    expect(f.prompts.length).toBe(0)
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.idle()
    expect(f.prompts.length).toBe(0)
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    await f.trigger('session.prompt', { sessionID: SID, messageID: 'msg_u', prompt: { text: 'şunu da ekle' }, delivery: 'steer' })
    await rt.idle()
    expect(f.prompts.length).toBe(0)
    const child = 'ses_child2'
    saveState('opencode', child, planState())
    await rt.handleEvent({ type: 'session.created', data: { sessionID: child, parentID: SID, location: { directory: root } } })
    await cycle(rt, child)
    expect(f.prompts.length).toBe(0)
    const other = 'ses_noplan'
    await rt.handleEvent({ type: 'session.created', data: { sessionID: other, location: { directory: root } } })
    await cycle(rt, other)
    expect(f.prompts.length).toBe(0)
  }))

  test('two plugin instances seeing the same terminal event continue the session once', () => withSandbox(async ({ root }) => {
    const sid = 'ses_dedupe1'
    saveState('opencode', sid, planState())
    const a = await runtime(root)
    const b = await runtime(root)
    for (const { rt } of [a, b]) {
      await rt.handleEvent({ type: 'session.created', data: { sessionID: sid, location: { directory: root } } })
      await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: sid } })
    }
    const done = { id: 'evt_dedupe_1', type: 'session.execution.succeeded', data: { sessionID: sid } }
    await Promise.all([a.rt.handleEvent(done), b.rt.handleEvent(done)])
    await Promise.all([a.rt.idle(), b.rt.idle()])
    expect(a.f.prompts.length + b.f.prompts.length).toBe(1)
  }))

  test('H11 re-drives the planning phase while the plan file is missing; a paused plan is released', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState({ phase: 'plan', status: 'PENDING', path: join(root, 'docs', 'plans', 'missing.md') }))
    const { f, rt } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await cycle(rt)
    expect(f.prompts.length).toBe(1)
    expect(f.prompts[0]?.text).toStartWith('Buracle plan check:')
    saveState('opencode', SID, { ...planState({ phase: 'plan', status: 'PENDING', path: join(root, 'docs', 'plans', 'missing.md') }), interaction: { state: 'paused', kind: 'decision', since: 1 } })
    await cycle(rt)
    expect(f.prompts.length).toBe(1)
  }))
})

describe('opencode server plugin: stage-B contract rules', () => {
  const cycle = async (rt: BuracleRuntime, sid = SID) => {
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: sid } })
    await rt.handleEvent({ type: 'session.text.ended', data: { sessionID: sid, text: 'Done with a step.' } })
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: sid } })
    await rt.idle()
  }
  const ctxEvent = (): SessionContextEvent => ({ sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} })

  test('H15: the injected card speaks OpenCode v2 (skill tool / @id, Code Mode), stays within 30 lines and drops servers marked down', () => withSandbox(async ({ root }) => {
    const { f, baked } = await runtime(root)
    const first = ctxEvent()
    await f.trigger('session.context', first)
    const card = first.system[0]?.text ?? ''
    expect(card.split('\n').length).toBeLessThanOrEqual(30)
    expect(card).not.toContain('invoke as /<id>')
    expect(card).not.toContain('tool search')
    expect(card).toMatch(/skill tool|@<id>/)
    expect(card).toMatch(/Code Mode|execute tool/)
    mkdirSync(paths.stateDir(), { recursive: true })
    writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, checked_at: '2026-10-08T00:00:00Z', mcp: { semble: { status: 'down', error: 'x' }, grep: { status: 'unknown' } }, tools: { rg: { status: 'ok', checked_at: 'x' } } }))
    const ev = ctxEvent()
    await f.trigger('session.context', ev)
    const healthy = baked.mcp.filter(m => m.id !== 'semble')
    expect(healthy.some(m => m.id === 'grep')).toBe(true)
    expect(ev.system[0]?.text).toBe(capabilityCard({ policy: baked.routing, mcp: healthy, skills: baked.skills, plugins: baked.plugins, harness: 'opencode' }))
  }))

  test('BURACLE_NO_CAPTURE: a session that starts with capture off gets no spool, stub note or finalizer', () => withSandbox(async ({ root }) => {
    const { f, rt, mem } = await runtime(root, { capture: () => false })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await f.trigger('session.prompt', { sessionID: SID, messageID: 'msg_p', prompt: { text: 'hello' }, delivery: 'steer' })
    await f.trigger('tool.execute.before', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_n', input: { command: 'ls' } })
    await f.trigger('tool.execute.after', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_n', input: { command: 'ls' }, status: 'completed', result: { output: { exit: 0 } } })
    await rt.handleEvent({ type: 'session.compaction.ended', data: { sessionID: SID, text: 'Summary' } })
    await rt.handleEvent({ type: 'session.deleted', data: { sessionID: SID } })
    await rt.idle()
    expect({ appended: mem.appended, started: mem.started, finalized: mem.finalized }).toEqual({ appended: [], started: [], finalized: [] })
  }))

  test('BURACLE_NO_CAPTURE: the default probe reads the environment when the session starts', () => withSandbox(async ({ root }) => {
    for (const [value, captured] of [['1', 0], [undefined, 1]] as const) {
      await withEnv({ BURACLE_NO_CAPTURE: value }, async () => {
        const f = fakeServerContext(root)
        const mem = fakeMemory()
        const rt = new BuracleRuntime(f.ctx, { baked: testBaked(), memory: mem, settleMs: 0, maint: () => ({ removed: [] }), workspace: async cwd => noProject(cwd) })
        await rt.register()
        await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
        await rt.idle()
        expect({ value, started: mem.started.length }).toEqual({ value, started: captured })
      })
    }
  }))

  test('H16: setup runs the session maintenance once per interval for the whole service process', () => withSandbox(async ({ root }) => {
    const calls: number[] = []
    const deps: PluginDeps = { baked: testBaked(), memory: fakeMemory(), settleMs: 0, capture: () => true, maint: nowMs => { calls.push(nowMs); return { removed: [] } }, workspace: async cwd => noProject(cwd) }
    const a = await createBuraclePlugin(deps).setup(fakeServerContext(root).ctx)
    await until(() => calls.length === 1)
    const b = await createBuraclePlugin(deps).setup(fakeServerContext(root).ctx)
    await Bun.sleep(20)
    expect(calls.length).toBe(1)
    for (const c of [a, b]) if (typeof c === 'function') await (c as () => Promise<void>)()
  }))

  test('H21: setup prepares the workspace of the project directory in the background', () => withSandbox(async ({ root }) => {
    const prepared: string[] = []
    const deps: PluginDeps = { baked: testBaked(), memory: fakeMemory(), settleMs: 0, capture: () => true, maint: () => ({ removed: [] }), workspace: async cwd => { prepared.push(cwd); return noProject(cwd) } }
    const stop = await createBuraclePlugin(deps).setup(fakeServerContext(root).ctx)
    await until(() => prepared.length === 1)
    expect(prepared[0]).toBe(fakeServerContext(root).ctx.location.project.directory || root)
    if (typeof stop === 'function') await (stop as () => Promise<void>)()
  }))

  test('H16: the default maintenance is the shared sessionMaint (idle OpenCode state goes, recent state stays)', () => withSandbox(async ({ root }) => {
    const aged = new Date(Date.now() - 30 * 86_400_000)
    const old = paths.sessionDir('opencode', 'ses_old1')
    const recent = paths.sessionDir('opencode', 'ses_new1')
    for (const d of [old, recent]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'opencode.json'), '{"v":1}') }
    utimesSync(join(old, 'opencode.json'), aged, aged)
    utimesSync(old, aged, aged)
    const rt = new BuracleRuntime(fakeServerContext(root).ctx, { baked: testBaked(), memory: fakeMemory(), settleMs: 0 })
    rt.runMaintenance()
    expect({ old: existsSync(old), recent: existsSync(recent) }).toEqual({ old: false, recent: true })
  }))

  test('H02: inside a Buracle checkout (package name or configured repo) all of harness/** is protected', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'buracle-clone')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'buracle' }))
    const inRepo = await runtime(repo)
    const denied = await inRepo.f.trigger('permission.evaluate', evaluation('edit', [join(repo, 'harness', 'next', 'x.md')]))
    expect(denied.effect).toBe('deny')
    expect(denied.message).toContain('buracle build')
    expect((await inRepo.f.trigger('permission.evaluate', evaluation('edit', [join(repo, 'src', 'x.ts')]))).effect).toBe('allow')
    expect(inRepo.rt.writeContext(join(repo, 'src'), testBaked().defaults).buracleRepo).toBe(repo)

    const other = join(root, 'other')
    mkdirSync(join(other, '.git'), { recursive: true })
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'other' }))
    const plain = await runtime(other)
    expect((await plain.f.trigger('permission.evaluate', evaluation('edit', [join(other, 'harness', 'next', 'x.md')]))).effect).toBe('allow')
    expect(plain.rt.writeContext(other, testBaked().defaults).buracleRepo).toBeUndefined()

    writeRuntimeConfig(c => c, { repoRoot: other })
    clearRepoCache()
    const configured = await runtime(other)
    expect((await configured.f.trigger('permission.evaluate', evaluation('edit', [join(other, 'harness', 'next', 'x.md')]))).effect).toBe('deny')
  }))

  test('H10: with plan.autoPause a user message pauses a running plan; continuations and "devam" do not', () => withSandbox(async ({ root }) => {
    writeRuntimeConfig(c => ({ ...c, plan: { ...c.plan, autoPause: true } }))
    saveState('opencode', SID, planState())
    const { f } = await runtime(root)
    const prompt = (text: string) => ({ sessionID: SID, messageID: 'msg_p', prompt: { text }, delivery: 'steer' as const })
    await f.trigger('session.prompt', prompt('Buracle stop guard: the plan is not VERIFIED, keep working'))
    expect(loadState('opencode', SID).interaction).toBeUndefined()
    await f.trigger('session.prompt', prompt('please also cover the parser edge case'))
    expect(loadState('opencode', SID).interaction).toMatchObject({ state: 'paused', kind: 'discussion', reason: AUTO_PAUSE_REASON })
    await f.trigger('session.prompt', prompt('devam'))
    expect(loadState('opencode', SID).interaction?.state).toBe('running')
    await f.trigger('session.prompt', { ...prompt('hello'), sessionID: 'ses_noplan2' })
    expect(existsSync(join(paths.sessionDir('opencode', 'ses_noplan2'), 'state.json'))).toBe(false)
  }))

  test('H10: autoPause off (default) leaves a running plan running', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    const { f } = await runtime(root)
    await f.trigger('session.prompt', { sessionID: SID, messageID: 'msg_p', prompt: { text: 'please also cover the parser edge case' }, delivery: 'steer' })
    expect(loadState('opencode', SID).interaction).toBeUndefined()
  }))

  test('H08/H11 go through stopGuardVerdict: one set of counters, persisted', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState({ phase: 'plan', status: 'PENDING', path: join(root, 'docs', 'plans', 'missing.md') }))
    const { f, rt } = await runtime(root)
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await cycle(rt)
    expect(f.prompts.map(p => p.metadata?.['hook'])).toEqual(['H11'])
    expect(loadState('opencode', SID).guard).toMatchObject({ blocksForPlan: 1, blocksInChain: 1 })
  }))

  test('a runaway cap releases the session and tells the user once per chain', () => withSandbox(async ({ root }) => {
    let clock = 5_000_000
    const plan = planState()
    saveState('opencode', SID, { ...plan, guard: { blocksForPlan: testBaked().defaults.plan.runaway.perPlan, blocksInChain: 0 } })
    const { f, rt, notices, mem } = await runtime(root, { now: () => clock })
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    await cycle(rt)
    clock += 120_000
    await cycle(rt)
    clock += 120_000
    await cycle(rt)
    expect(f.prompts.map(p => p.text.includes('runaway: continue, pivot or abandon?'))).toEqual([true])
    expect(notices.length).toBe(1)
    expect(notices[0]?.message).toContain(plan.plan?.path as string)
    expect(mem.appended.flatMap(a => a.entries).filter(e => e.ev === 'note').length).toBe(1)
  }))

  test('the re-prompt chain is shared by plugin instances: a reloaded instance does not restart a capped chain', () => withSandbox(async ({ root }) => {
    saveState('opencode', SID, planState())
    let clock = 9_000_000
    const a = await runtime(root, { now: () => clock })
    await a.rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    for (let i = 0; i < 3; i++) { clock += 120_000; await cycle(a.rt) }
    expect(a.f.prompts.length).toBe(3)
    const b = await runtime(root, { now: () => clock })
    await b.rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: root } } })
    for (let i = 0; i < 4; i++) { clock += 120_000; await cycle(b.rt) }
    expect(a.f.prompts.length + b.f.prompts.length).toBe(testBaked().defaults.plan.runaway.perChain + 1)
    expect(b.notices.length).toBe(1)
  }))

  test('H03: a shell nudge is appended once per call (routeTool owns it)', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    await f.trigger('tool.execute.before', { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_g', input: { command: 'grep -r foo .' } })
    await f.trigger('permission.evaluate', evaluation('shell', ['grep -r foo .'], 'call_g'))
    await f.trigger('permission.evaluate', evaluation('shell', ['grep -r foo .'], 'call_g'))
    const after: ToolExecuteAfter = { tool: 'shell', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_g', input: { command: 'grep -r foo .' }, status: 'completed', result: { output: { exit: 0 }, content: [{ type: 'text', text: 'out' }] } }
    await f.trigger('tool.execute.after', after)
    const texts = after.status === 'completed' ? (after.result.content as unknown as Array<{ text: string }>).map(c => c.text) : []
    expect(texts.length).toBe(2)
    expect(texts[0]).toBe('out')
  }))
})

describe('H28 project assets on OpenCode', () => {
  test('session.context lists the unindexed path rules; setup and a turn end start the link run; an edit of a rule gets its index line', () => withSandbox(async ({ root }) => {
    const { clearAssetsContextCache } = await import('../../../src/adapters/shared/project-assets')
    clearAssetsContextCache()
    const { makeRepo, write } = await import('../../workflow/fixture')
    const repo = await makeRepo(root)
    write(join(repo, 'AGENTS.md'), '# Demo\n\n## Scoped rules\n\n')
    const rule = join(repo, '.claude', 'rules', 'web.md')
    write(rule, '---\npaths: ["src/**/*.tsx"]\n---\n')
    write(join(repo, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a diff\n---\n')
    write(join(repo, '.agents', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy\n---\n')
    const info = (cwd: string): WorkspaceInfo => ({ cwd, root: repo, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } })
    const spawned: string[] = []
    let clock = Date.UTC(2026, 9, 17, 9, 0, 0)
    const f = fakeServerContext(repo)
    const rt = new BuracleRuntime(f.ctx, {
      baked: testBaked(), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }), capture: () => true, now: () => clock,
      maint: () => ({ removed: [] }), workspace: async cwd => info(cwd), workspaceRead: async cwd => info(cwd),
      assetsSpawn: (argv, cwd) => { spawned.push(`${argv.slice(-4).join(' ')} @ ${cwd}`) },
    })
    await rt.register()
    rt.scheduleWorkspace()
    await until(() => spawned.length === 1)
    expect(spawned).toEqual([`project sync --auto --quiet @ ${repo}`])
    await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: repo } } })
    const ev: SessionContextEvent = { sessionID: SID, model: { id: 'm1', providerID: 'p' }, agent: 'build', system: [], messages: [], options: {}, tools: {} }
    await f.trigger('session.context', ev)
    const text = ev.system.map(p => p.text).join('\n\n')
    expect(text).toContain('- `.claude/rules/web.md` \u2014 `src/**/*.tsx`')
    expect(text).not.toContain('Review a diff')
    const input = { filePath: rule, content: '---\npaths: ["src/**/*.tsx"]\n---\n' }
    await f.trigger('tool.execute.before', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_w', input })
    const after: ToolExecuteAfter = { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'call_w', input, status: 'completed', result: { output: {}, content: [{ type: 'text', text: 'Wrote web.md' }] } }
    await f.trigger('tool.execute.after', after)
    const out = after.status === 'completed' ? (after.result.content as unknown as Array<{ text: string }>).map(c => c.text).join('\n') : ''
    expect(out).toContain('.claude/rules/web.md is not in AGENTS.md')
    clock += 31_000
    await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
    expect(spawned).toEqual([`project sync --auto --quiet @ ${repo}`, `project sync --auto --quiet @ ${repo}`])
    rt.dispose()
    clearAssetsContextCache()
  }))
})

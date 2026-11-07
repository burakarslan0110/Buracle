import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { claudeHook, type HookDeps } from '../../../src/adapters/claude/hook'
import type { AdapterContext } from '../../../src/adapters/registry'
import { defaultConfig } from '../../../src/core/config'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { readBoard } from '../../../src/workflow/board-store'
import { workAsk, workDone, workJoin, workNote, workPublish } from '../../../src/workflow/board'
import type { ResolvedSession } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctxAt, g, makeRepo, planDoc, write } from '../../workflow/fixture'

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const REPO = join(import.meta.dir, '..', '..', '..')
const LEAD: ResolvedSession = { harness: 'claude', sessionId: 'lead-claude', source: '--session' }
const WORKER: ResolvedSession = { harness: 'claude', sessionId: 'worker-claude', source: '--session' }
const OTHER: ResolvedSession = { harness: 'codex', sessionId: 'worker-codex', source: '--session' }
let base: CanonicalBundle | undefined

function ctx(): AdapterContext {
  const canonical = { ...(base ??= loadCanonicalSync(join(REPO, 'canonical'))), notices: [] }
  return { repoRoot: REPO, config: defaultConfig(), paths, buracleBin: paths.shimPath(), canonical }
}

function deps(now = NOW): Partial<HookDeps> {
  return {
    now: () => now,
    importModule: async () => undefined,
    branch: async () => 'main',
    project: async () => 'demo',
    sessionMaint: () => undefined,
    env: name => process.env[name],
    buracleRepo: async () => undefined,
    realpath: p => { try { return realpathSync(p) } catch { return undefined } },
    run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    prepareWorkspace: async () => undefined,
  }
}

function payload(sid: string, event: string, cwd: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: sid, cwd, hook_event_name: event, transcript_path: '/tmp/t.jsonl', permission_mode: 'bypassPermissions', ...extra })
}

interface Out { raw: string, context: string, decision?: string, terminalSequence?: string }

function parse(stdout: string): Out {
  if (stdout === '') return { raw: '', context: '' }
  const j = JSON.parse(stdout) as Record<string, unknown>
  const hso = (j['hookSpecificOutput'] ?? {}) as Record<string, unknown>
  return {
    raw: stdout, context: String(hso['additionalContext'] ?? ''),
    ...(typeof hso['permissionDecision'] === 'string' ? { decision: hso['permissionDecision'] } : {}),
    ...(typeof j['terminalSequence'] === 'string' ? { terminalSequence: j['terminalSequence'] } : {}),
  }
}

async function hook(sid: string, event: string, cwd: string, extra: Record<string, unknown> = {}, now = NOW): Promise<Out> {
  return parse((await claudeHook(event, payload(sid, event, cwd, extra), ctx(), deps(now))).stdout)
}

const writeTool = (sid: string, cwd: string, file: string, now = NOW) => hook(sid, 'PreToolUse', cwd, { tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }, now)
const editTool = (sid: string, cwd: string, file: string, now = NOW) => hook(sid, 'PreToolUse', cwd, { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } }, now)
const bash = (sid: string, cwd: string, now = NOW) => hook(sid, 'PreToolUse', cwd, { tool_name: 'Bash', tool_input: { command: 'ls' } }, now)
const stopEvent = (sid: string, cwd: string, now = NOW) => hook(sid, 'Stop', cwd, { last_assistant_message: 'Done for now.', stop_hook_active: false }, now)

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

async function board(root: string, o: { leaseSec?: number } = {}): Promise<{ repo: string, plan: string, path: string }> {
  const repo = await makeRepo(root)
  const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
  write(plan, planDoc({ n: 2, status: 'IN_PROGRESS', approved: true }))
  const pub = await workPublish({ planPath: plan, ...(o.leaseSec !== undefined ? { leaseSec: o.leaseSec } : {}) }, ctxAt(repo, NOW), LEAD)
  if (pub.code !== 0) throw new Error(pub.errors.join('; '))
  return { repo, plan, path: String(pub.data['path']) }
}

describe('Claude hooks and the task board', () => {
  test('1. the join offer appears once at SessionStart, for a session that is on no board', () => sandbox(async root => {
    const { repo } = await board(root)
    const first = await hook('fresh-claude', 'SessionStart', repo, { source: 'startup' })
    expect(first.context).toContain('`/buracle-join rate-limit`')
    const second = await hook('fresh-claude', 'SessionStart', repo, { source: 'startup' })
    expect(second.context).not.toContain('/buracle-join')
    const lead = await hook('lead-claude', 'SessionStart', repo, { source: 'startup' })
    expect(lead.context).not.toContain('/buracle-join')
  }))

  test('2. and 3. a note reaches the worker once: at the next prompt, or at the next tool call while a turn runs', () => sandbox(async root => {
    const { repo } = await board(root)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    workNote('rebase onto main please', {}, ctxAt(repo, NOW + 1), LEAD)
    const prompt = await hook('worker-claude', 'UserPromptSubmit', repo, { prompt: 'go on' }, NOW + 2)
    expect(prompt.context).toContain('rebase onto main please')
    expect((await hook('worker-claude', 'UserPromptSubmit', repo, { prompt: 'go on' }, NOW + 3)).context).not.toContain('rebase onto main')
    workNote('and run the tests', {}, ctxAt(repo, NOW + 4), LEAD)
    const tool = await bash('worker-claude', repo, NOW + 5)
    expect(tool.context).toContain('and run the tests')
    expect(tool.decision).toBeUndefined()
    expect((await bash('worker-claude', repo, NOW + 6)).context).not.toContain('and run the tests')
    workNote('one for the lead', {}, ctxAt(repo, NOW + 7), WORKER)
    expect((await hook('lead-claude', 'UserPromptSubmit', repo, { prompt: 'status?' }, NOW + 8)).context).toContain('one for the lead')
  }))

  test('11. a waiting task resumes at the tool result after the question tool: not at the result of the command that asked, not at a tool call', () => sandbox(async root => {
    const { repo, path } = await board(root)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    expect((await workAsk('which port?', ctxAt(repo, NOW + 1), WORKER)).code).toBe(0)
    const result = (now: number, tool: string, input: Record<string, unknown>) => hook('worker-claude', 'PostToolUse', wt, { tool_name: tool, tool_input: input, tool_response: {} }, now)
    expect((await result(NOW + 2, 'Bash', { command: 'buracle work ask "which port?"' })).context).not.toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    await hook('worker-claude', 'PreToolUse', wt, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }, NOW + 3)
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    const answered = await result(NOW + 4, 'AskUserQuestion', { questions: [] })
    expect(answered.context).toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('claimed')
    expect(readBoard(path)?.tasks[0]?.leaseUntil).toBe(NOW + 4 + 300_000)
  }))

  test('4. and 5. a worker cannot write outside its worktree; the lead cannot edit a claimed task\'s file', () => sandbox(async root => {
    const { repo } = await board(root)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    const outside = await writeTool('worker-claude', wt, join(repo, 'src', 'app.ts'))
    expect(outside.decision).toBe('deny')
    expect(outside.raw).toContain('rate-limit-t1')
    expect(outside.raw).toContain('Task 1')
    expect((await writeTool('worker-claude', wt, join(wt, 'src', 's1.ts'))).decision).toBeUndefined()
    // The worker's subagent writes under the same rule.
    const sub = await hook('worker-claude', 'PreToolUse', wt, { tool_name: 'Write', tool_input: { file_path: join(repo, 'src', 'app.ts'), content: 'x' }, agent_id: 'sub-1' })
    expect(sub.decision).toBe('deny')
    expect((await hook('worker-claude', 'PreToolUse', wt, { tool_name: 'Write', tool_input: { file_path: join(wt, 'src', 's1.ts'), content: 'x' }, agent_id: 'sub-1' })).decision).toBeUndefined()
    const leadEdit = await editTool('lead-claude', repo, join(repo, 'src', 's1.ts'))
    expect(leadEdit.decision).toBe('deny')
    expect(leadEdit.raw).toContain('Task 1')
    expect(leadEdit.raw).toContain('buracle work wait')
    expect((await editTool('lead-claude', repo, join(repo, 'src', 's2.ts'))).decision).toBeUndefined()
  }))

  test('6. a worker session without a plan is held at Stop while its task is claimed, and released after work done', () => sandbox(async root => {
    const { repo } = await board(root)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    const held = await stopEvent('worker-claude', repo)
    expect(held.raw).toContain('buracle work done')
    expect(held.raw).toContain('Task 1')
    write(join(wt, 'src', 's1.ts'), 'export const s1 = 1\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1')
    expect((await workDone({ verify: 'bun test → pass' }, ctxAt(repo, NOW + 1), WORKER)).code).toBe(0)
    expect((await stopEvent('worker-claude', repo, NOW + 2)).raw).toBe('')
  }))

  test('7. the lead at Stop is told to merge while the board holds done tasks, never to implement them', () => sandbox(async root => {
    const { repo, plan } = await board(root)
    const { planRegister } = await import('../../../src/workflow/plan')
    expect((await planRegister(plan, undefined, ctxAt(repo, NOW), LEAD)).code).toBe(0)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), OTHER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    write(join(wt, 'src', 's1.ts'), 'export const s1 = 1\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1')
    expect((await workDone({ verify: 'bun test → pass' }, ctxAt(repo, NOW + 1), OTHER)).code).toBe(0)
    const held = await stopEvent('lead-claude', repo, NOW + 2)
    expect(held.raw).toContain('buracle work merge')
    expect(held.raw).not.toContain('next unticked')
  }))

  test('8. SessionEnd returns the worker\'s task to open and keeps the worktree', () => sandbox(async root => {
    const { repo, path } = await board(root)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    await hook('worker-claude', 'SessionEnd', repo, { reason: 'exit' }, NOW + 1)
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'open', lastWorker: { session: 'worker-claude' } })
    expect(readBoard(path)?.tasks[0]?.worktree).toBeDefined()
  }))

  test('9. after a stale takeover the old worker\'s Write is denied as reassigned and its Stop goes through', () => sandbox(async root => {
    const { repo } = await board(root, { leaseSec: 1 })
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    const second = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2000), OTHER)
    expect(second.data).toMatchObject({ task: { n: 1 } })
    const denied = await writeTool('worker-claude', wt, join(wt, 'src', 's1.ts'), NOW + 3000)
    expect(denied.decision).toBe('deny')
    expect(denied.raw).toContain('reassigned')
    expect((await stopEvent('worker-claude', repo, NOW + 4000)).raw).toBe('')
  }))

  test('10. without a board nothing changes: no offer, writes pass, Stop is quiet', () => sandbox(async root => {
    const repo = await makeRepo(root)
    expect((await hook('solo-claude', 'SessionStart', repo, { source: 'startup' })).context).not.toContain('Buracle task board')
    expect((await writeTool('solo-claude', repo, join(repo, 'src', 'app.ts'))).decision).toBeUndefined()
    expect((await stopEvent('solo-claude', repo)).raw).toBe('')
    expect((await hook('solo-claude', 'UserPromptSubmit', repo, { prompt: 'hi' })).context).not.toContain('board')
  }))

  test('the terminal sequence left by work ask is emitted once, by the next synchronous PreToolUse (the question tool), never by the asynchronous PostToolUse of the command that asked', () => sandbox(async root => {
    const { repo } = await board(root)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    await workAsk('which port?', ctxAt(repo, NOW + 1), WORKER)
    const live = <T>(fn: () => Promise<T>) => withEnv({ BURACLE_NO_NOTIFY: undefined }, fn)
    const post = await live(() => hook('worker-claude', 'PostToolUse', repo, { tool_name: 'Bash', tool_input: { command: 'buracle work ask "which port?"' }, tool_response: { stdout: '', stderr: '' } }, NOW + 2))
    expect(post.terminalSequence).toBeUndefined()
    const pre = await live(() => hook('worker-claude', 'PreToolUse', repo, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }, NOW + 3))
    expect(pre.terminalSequence).toContain('\x1b]9;Task 1 of rate-limit needs you: which port?\x07')
    expect(pre.terminalSequence).toContain('\x1b]777;notify;')
    expect(pre.decision).toBeUndefined()
    expect((await live(() => hook('worker-claude', 'PreToolUse', repo, { tool_name: 'Bash', tool_input: { command: 'ls' } }, NOW + 4))).terminalSequence).toBeUndefined()
    expect((await live(() => hook('worker-claude', 'PostToolUse', repo, { tool_name: 'AskUserQuestion', tool_input: { questions: [] }, tool_response: { answers: {} } }, NOW + 5))).context).toContain('claimed again')
    // BURACLE_NO_NOTIFY=1 (the test default): the sequence is taken and dropped, so nothing reaches the terminal, now or later.
    await workAsk('and the host?', ctxAt(repo, NOW + 6), WORKER)
    expect((await hook('worker-claude', 'PreToolUse', repo, { tool_name: 'AskUserQuestion', tool_input: { questions: [] } }, NOW + 7)).terminalSequence).toBeUndefined()
    expect((await live(() => hook('worker-claude', 'PreToolUse', repo, { tool_name: 'Bash', tool_input: { command: 'ls' } }, NOW + 8))).terminalSequence).toBeUndefined()
  }))
})

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { handleCodexHook } from '../../../src/adapters/codex/hook'
import { readBoard } from '../../../src/workflow/board-store'
import { workAsk, workDone, workJoin, workNote, workPublish } from '../../../src/workflow/board'
import { planRegister } from '../../../src/workflow/plan'
import type { ResolvedSession } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctxAt, g, makeRepo, planDoc, write } from '../../workflow/fixture'
import { ctx, deps, payload, quiet } from './hook-helpers'

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const LEAD: ResolvedSession = { harness: 'codex', sessionId: 'lead-codex', source: '--session' }
const WORKER: ResolvedSession = { harness: 'codex', sessionId: 'worker-codex', source: '--session' }
const OTHER: ResolvedSession = { harness: 'claude', sessionId: 'worker-claude', source: '--session' }

interface Out { raw: string, context: string, decision?: string, block?: string }

function parse(stdout: string): Out {
  if (stdout === '') return { raw: '', context: '' }
  const j = JSON.parse(stdout) as Record<string, unknown>
  const hso = (j['hookSpecificOutput'] ?? {}) as Record<string, unknown>
  return {
    raw: stdout, context: String(hso['additionalContext'] ?? ''),
    ...(typeof hso['permissionDecision'] === 'string' ? { decision: hso['permissionDecision'] } : {}),
    ...(j['decision'] === 'block' ? { block: String(j['reason'] ?? '') } : {}),
  }
}

function at(now: number) {
  const d = deps(quiet)
  d.now = () => now
  return d
}

async function hook(sid: string, event: string, cwd: string, extra: Record<string, unknown> = {}, now = NOW): Promise<Out> {
  return parse((await handleCodexHook(event, payload(event, { session_id: sid, cwd, ...extra }), ctx(), at(now))).stdout)
}

const patchFor = (file: string) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n`
const patchTool = (sid: string, cwd: string, file: string, now = NOW) => hook(sid, 'PreToolUse', cwd, { tool_name: 'apply_patch', tool_input: { command: patchFor(file) } }, now)
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

describe('Codex hooks and the task board', () => {
  test('1. the join offer appears once at SessionStart, for a session that is on no board', () => sandbox(async root => {
    const { repo } = await board(root)
    const first = (await hook('fresh-codex', 'SessionStart', repo, { source: 'startup' })).context
    expect(first).toContain('`$buracle-join rate-limit`')
    expect(first).not.toContain('`/buracle-join ')
    expect((await hook('fresh-codex', 'SessionStart', repo, { source: 'startup' })).context).not.toContain('$buracle-join')
    expect((await hook('lead-codex', 'SessionStart', repo, { source: 'startup' })).context).not.toContain('$buracle-join')
  }))

  test('2. and 3. a note reaches the worker once: at the next prompt, or at the next tool call while a turn runs', () => sandbox(async root => {
    const { repo } = await board(root)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    workNote('rebase onto main please', {}, ctxAt(repo, NOW + 1), LEAD)
    expect((await hook('worker-codex', 'UserPromptSubmit', repo, { prompt: 'go on' }, NOW + 2)).context).toContain('rebase onto main please')
    expect((await hook('worker-codex', 'UserPromptSubmit', repo, { prompt: 'go on' }, NOW + 3)).context).not.toContain('rebase onto main')
    workNote('and run the tests', {}, ctxAt(repo, NOW + 4), LEAD)
    const tool = await bash('worker-codex', repo, NOW + 5)
    expect(tool.context).toContain('and run the tests')
    expect(tool.decision).toBeUndefined()
    expect((await bash('worker-codex', repo, NOW + 6)).context).not.toContain('and run the tests')
    workNote('one for the lead', {}, ctxAt(repo, NOW + 7), WORKER)
    expect((await hook('lead-codex', 'UserPromptSubmit', repo, { prompt: 'status?' }, NOW + 8)).context).toContain('one for the lead')
  }))

  test('11. a waiting task resumes at the tool result after the question tool: not at the result of the command that asked, not at a tool call', () => sandbox(async root => {
    const { repo, path } = await board(root)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    expect((await workAsk('which port?', ctxAt(repo, NOW + 1), WORKER)).code).toBe(0)
    const result = (now: number, tool: string, input: Record<string, unknown>) => hook('worker-codex', 'PostToolUse', wt, { tool_name: tool, tool_input: input, tool_response: {} }, now)
    expect((await result(NOW + 2, 'Bash', { command: 'buracle work ask "which port?"' })).context).not.toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    await hook('worker-codex', 'PreToolUse', wt, { tool_name: 'request_user_input', tool_input: { questions: [] } }, NOW + 3)
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    const answered = await result(NOW + 4, 'request_user_input', { questions: [] })
    expect(answered.context).toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('claimed')
  }))

  test('4. and 5. a worker cannot patch outside its worktree; the lead cannot patch a claimed task\'s file', () => sandbox(async root => {
    const { repo } = await board(root)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    const outside = await patchTool('worker-codex', wt, join(repo, 'src', 'app.ts'))
    expect(outside.decision).toBe('deny')
    expect(outside.raw).toContain('rate-limit-t1')
    expect((await patchTool('worker-codex', wt, join(wt, 'src', 's1.ts'))).decision).toBeUndefined()
    // The worker's subagent patches under the same rule.
    expect((await hook('worker-codex', 'PreToolUse', wt, { tool_name: 'apply_patch', tool_input: { command: patchFor(join(repo, 'src', 'app.ts')) }, agent_id: 'sub-1' })).decision).toBe('deny')
    expect((await hook('worker-codex', 'PreToolUse', wt, { tool_name: 'apply_patch', tool_input: { command: patchFor(join(wt, 'src', 's1.ts')) }, agent_id: 'sub-1' })).decision).toBeUndefined()
    const leadPatch = await patchTool('lead-codex', repo, join(repo, 'src', 's1.ts'))
    expect(leadPatch.decision).toBe('deny')
    expect(leadPatch.raw).toContain('Task 1')
    expect(leadPatch.raw).toContain('buracle work wait')
    expect((await patchTool('lead-codex', repo, join(repo, 'src', 's2.ts'))).decision).toBeUndefined()
  }))

  test('6. a worker session without a plan is held at Stop while its task is claimed, and released after work done', () => sandbox(async root => {
    const { repo } = await board(root)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    const held = await stopEvent('worker-codex', repo)
    expect(held.block).toContain('buracle work done')
    expect(held.block).toContain('Task 1')
    write(join(wt, 'src', 's1.ts'), 'export const s1 = 1\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1')
    expect((await workDone({ verify: 'bun test → pass' }, ctxAt(repo, NOW + 1), WORKER)).code).toBe(0)
    expect((await stopEvent('worker-codex', repo, NOW + 2)).block).toBeUndefined()
  }))

  test('7. the lead at Stop is told to merge while the board holds done tasks, never to implement them', () => sandbox(async root => {
    const { repo, plan } = await board(root)
    expect((await planRegister(plan, undefined, ctxAt(repo, NOW), LEAD)).code).toBe(0)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), OTHER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    write(join(wt, 'src', 's1.ts'), 'export const s1 = 1\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1')
    expect((await workDone({ verify: 'bun test → pass' }, ctxAt(repo, NOW + 1), OTHER)).code).toBe(0)
    const held = await stopEvent('lead-codex', repo, NOW + 2)
    expect(held.block).toContain('buracle work merge')
    expect(held.block).not.toContain('next unticked')
  }))

  test('8. SessionEnd returns the worker\'s task to open and keeps the worktree', () => sandbox(async root => {
    const { repo, path } = await board(root)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    await hook('worker-codex', 'SessionEnd', repo, { reason: 'exit' }, NOW + 1)
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'open', lastWorker: { session: 'worker-codex' } })
    expect(readBoard(path)?.tasks[0]?.worktree).toBeDefined()
  }))

  test('9. after a stale takeover the old worker\'s patch is denied as reassigned and its Stop goes through', () => sandbox(async root => {
    const { repo } = await board(root, { leaseSec: 1 })
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), WORKER)
    const wt = String((j.data['worktree'] as { path: string }).path)
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2000), OTHER)).data).toMatchObject({ task: { n: 1 } })
    const denied = await patchTool('worker-codex', wt, join(wt, 'src', 's1.ts'), NOW + 3000)
    expect(denied.decision).toBe('deny')
    expect(denied.raw).toContain('reassigned')
    expect((await stopEvent('worker-codex', repo, NOW + 4000)).block).toBeUndefined()
  }))

  test('10. without a board nothing changes: no offer, patches pass, Stop is quiet', () => sandbox(async root => {
    const repo = await makeRepo(root)
    expect((await hook('solo-codex', 'SessionStart', repo, { source: 'startup' })).context).not.toContain('Buracle task board')
    expect((await patchTool('solo-codex', repo, join(repo, 'src', 'app.ts'))).decision).toBeUndefined()
    expect((await stopEvent('solo-codex', repo)).block).toBeUndefined()
    expect((await hook('solo-codex', 'UserPromptSubmit', repo, { prompt: 'hi' })).context).not.toContain('board')
  }))
})

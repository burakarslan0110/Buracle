import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { HEARTBEAT_EVERY_MS, boardCounts, boardJoinOffer, boardPromptNotice, boardSessionEnd, boardStopInput, boardTerminalSequence, boardToolSeen, boardWriteDenial } from '../../../src/adapters/shared/board'
import { readBoard, sessionBoard } from '../../../src/workflow/board-store'
import { workAsk, workDone, workJoin, workNote, workPublish } from '../../../src/workflow/board'
import type { ResolvedSession } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctxAt, g, makeRepo, planDoc, write } from '../../workflow/fixture'

const LEAD: ResolvedSession = { harness: 'claude', sessionId: 'lead-1', source: '--session' }
const A: ResolvedSession = { harness: 'codex', sessionId: 'worker-a', source: '--session' }
const B: ResolvedSession = { harness: 'omp', sessionId: 'worker-b', source: '--session' }
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

async function board(root: string, o: { n?: number, leaseSec?: number } = {}): Promise<{ repo: string, path: string }> {
  const repo = await makeRepo(root)
  const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
  write(plan, planDoc({ n: o.n ?? 2, status: 'IN_PROGRESS', approved: true }))
  const pub = await workPublish({ planPath: plan, ...(o.leaseSec !== undefined ? { leaseSec: o.leaseSec } : {}) }, ctxAt(repo, NOW), LEAD)
  if (pub.code !== 0) throw new Error(pub.errors.join('; '))
  return { repo, path: String(pub.data['path']) }
}

describe('boardJoinOffer', () => {
  test('offers once per session to a session that is neither lead nor worker, only while a task is ready, and never to the lead', () => sandbox(async root => {
    const { repo } = await board(root)
    const first = boardJoinOffer('opencode', 'fresh-1', join(repo, 'src'), NOW)
    expect(first).toContain('`/buracle-join rate-limit`')
    expect(first).toContain('2 task(s) ready')
    expect(boardJoinOffer('omp', 'fresh-omp', repo, NOW, '/buracle-join')).toContain('`/buracle-join rate-limit`')
    expect(boardJoinOffer('opencode', 'fresh-1', repo, NOW)).toBeUndefined()
    expect(boardJoinOffer('claude', 'lead-1', repo, NOW)).toBeUndefined()
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    expect(boardJoinOffer('codex', 'worker-a', repo, NOW)).toBeUndefined()
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), B)
    expect(boardJoinOffer('opencode', 'fresh-2', repo, NOW)).toBeUndefined()
    expect(boardJoinOffer('opencode', 'fresh-3', root, NOW)).toBeUndefined()
  }))
})

describe('boardPromptNotice and boardToolSeen', () => {
  test('a prompt delivers notes once, resumes a waiting task and renews the lease; a tool call delivers too and heartbeats at most every 30 s', () => sandbox(async root => {
    const { repo, path } = await board(root)
    expect(boardPromptNotice('codex', 'worker-a', repo, NOW)).toBeUndefined()
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    expect(boardPromptNotice('codex', 'worker-a', repo, NOW + 1)).toBeUndefined()
    workNote('rebase onto main', {}, ctxAt(repo, NOW + 2), LEAD)
    const seen = boardToolSeen('codex', 'worker-a', repo, NOW + 3, false, 'before')
    expect(seen?.context).toContain('[nudge] from the lead')
    expect(seen?.context).toContain('rebase onto main')
    expect(seen?.deny).toBeUndefined()
    expect(boardToolSeen('codex', 'worker-a', repo, NOW + 4, false, 'after')).toBeUndefined()
    expect(boardPromptNotice('codex', 'worker-a', repo, NOW + 5)).toBeUndefined()
    expect(sessionBoard('codex', 'worker-a')?.heartbeatAt).toBe(NOW + 5)
    expect(readBoard(path)?.tasks[0]?.leaseUntil).toBe(NOW + 5 + 300_000)
    expect(boardToolSeen('codex', 'worker-a', repo, NOW + 6, false, 'before')).toBeUndefined()
    expect(readBoard(path)?.tasks[0]?.leaseUntil).toBe(NOW + 5 + 300_000)
    // A write tool checks the token but renews the lease only when the 30 s are up.
    expect(boardToolSeen('codex', 'worker-a', repo, NOW + 7, true, 'before')).toBeUndefined()
    expect(readBoard(path)?.tasks[0]?.leaseUntil).toBe(NOW + 5 + 300_000)
    expect(sessionBoard('codex', 'worker-a')?.heartbeatAt).toBe(NOW + 5)
    boardToolSeen('codex', 'worker-a', repo, NOW + 5 + HEARTBEAT_EVERY_MS, false, 'before')
    expect(readBoard(path)?.tasks[0]?.leaseUntil).toBe(NOW + 5 + HEARTBEAT_EVERY_MS + 300_000)
    await workAsk('which port?', ctxAt(repo, NOW + 40_000), A)
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    // The question tool's call (before) and the result of the command that asked (the first after) keep the task waiting; the result after the question tool resumes it.
    expect(boardToolSeen('codex', 'worker-a', repo, NOW + 40_500, false, 'before')).toBeUndefined()
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    expect(boardToolSeen('codex', 'worker-a', repo, NOW + 40_800, false, 'after')).toBeUndefined()
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    expect(boardToolSeen('codex', 'worker-a', repo, NOW + 40_900, false, 'before')).toBeUndefined()
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    const resumed = boardToolSeen('codex', 'worker-a', repo, NOW + 41_000, false, 'after')
    expect(resumed?.context).toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('claimed')
    // Asked again and answered in a prompt instead: the prompt resumes and clears the ask mark, so a later tool result keeps nothing waiting.
    await workAsk('and the host?', ctxAt(repo, NOW + 41_500), A)
    expect(boardPromptNotice('codex', 'worker-a', repo, NOW + 41_600)).toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('claimed')
    await workAsk('and the user?', ctxAt(repo, NOW + 41_700), A)
    expect(boardToolSeen('codex', 'worker-a', repo, NOW + 41_800, false, 'after')).toBeUndefined()
    expect(readBoard(path)?.tasks[0]?.status).toBe('waiting')
    expect(boardToolSeen('codex', 'worker-a', repo, NOW + 41_900, false, 'after')?.context).toContain('claimed again')
    // An ask mark older than a minute (the ask's own tool result never arrived) is ignored: the next tool result resumes.
    await workAsk('and the password?', ctxAt(repo, NOW + 42_000), A)
    expect(boardToolSeen('codex', 'worker-a', repo, NOW + 42_000 + 61_000, false, 'after')?.context).toContain('claimed again')
    expect(readBoard(path)?.tasks[0]?.status).toBe('claimed')
    workNote('one more', { to: 'worker-a' }, ctxAt(repo, NOW + 42_000), LEAD)
    expect(boardPromptNotice('codex', 'worker-a', repo, NOW + 43_000)).toContain('one more')
    expect(boardPromptNotice('claude', 'lead-1', repo, NOW + 44_000)).toContain('[question] from the worker')
    expect(boardPromptNotice('claude', 'lead-1', repo, NOW + 45_000)).toBeUndefined()
  }))

  test('a reassigned worker is denied on a write tool, told on a read tool, keeps the worker role, and its stop input has no task', () => sandbox(async root => {
    const { repo, path } = await board(root, { leaseSec: 1 })
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    const claimed = boardStopInput('codex', 'worker-a', NOW + 500)
    expect(claimed).toEqual({ slug: 'rate-limit', role: 'worker', task: { n: 1, status: 'claimed' }, summary: { open: 1, claimed: 1, waiting: 0, done: 0, merged: 0, stale: 0, workers: 1, total: 2 } })
    expect(boardStopInput('codex', 'worker-a', NOW + 2000)?.task).toBeUndefined()
    await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2500), B)
    expect(readBoard(path)?.tasks[0]?.worker?.session).toBe('worker-b')
    const denied = boardToolSeen('codex', 'worker-a', repo, NOW + 3000, true, 'before')
    expect(denied?.deny).toContain('reassigned')
    expect(denied?.deny).toContain('buracle work join rate-limit')
    expect(sessionBoard('codex', 'worker-a')).toEqual({ slug: 'rate-limit', path, role: 'worker' })
    expect(boardStopInput('codex', 'worker-a', NOW + 3100)).toMatchObject({ role: 'worker' })
    expect(boardStopInput('codex', 'worker-a', NOW + 3100)?.task).toBeUndefined()
    const told = boardToolSeen('codex', 'worker-a', repo, NOW + 3200, false, 'before')
    expect(told).toBeUndefined()
    expect(boardWriteDenial('codex', 'worker-a', repo, [join(repo, 'src', 'app.ts')])).toContain('buracle work join')
    expect(boardStopInput('omp', 'worker-b', NOW + 3300)?.task).toEqual({ n: 1, status: 'claimed' })
  }))
})

describe('boardSessionEnd', () => {
  test('releases a worker\'s task and drops its binding; the lead keeps its binding and its stop input', () => sandbox(async root => {
    const { repo, path } = await board(root)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    boardSessionEnd('codex', 'worker-a', NOW + 1)
    expect(readBoard(path)?.tasks[0]?.status).toBe('open')
    expect(readBoard(path)?.events.at(-1)).toMatchObject({ kind: 'released', task: 1 })
    expect(sessionBoard('codex', 'worker-a')).toBeUndefined()
    boardSessionEnd('claude', 'lead-1', NOW + 2)
    expect(sessionBoard('claude', 'lead-1')).toMatchObject({ slug: 'rate-limit', path, role: 'lead' })
    expect(boardStopInput('claude', 'lead-1', NOW + 3)).toMatchObject({ slug: 'rate-limit', role: 'lead' })
  }))
})

describe('boardWriteDenial', () => {
  test('the lead working in a plan worktree is denied a claimed task\'s file there too; a worker is denied the plan worktree', () => sandbox(async root => {
    const { repo } = await board(root)
    const planWt = join(repo, '.worktrees', 'rate-limit')
    await g(repo, 'worktree', 'add', '-q', '-b', 'plan-build/rate-limit', planWt, 'main')
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    const wt = String((j.data['worktree'] as { path: string }).path)
    const real = (p: string) => { try { return realpathSync(p) } catch { return undefined } }
    expect(boardWriteDenial('claude', 'lead-1', planWt, [join(planWt, 'src', 's1.ts')], real)).toContain('Task 1')
    expect(boardWriteDenial('claude', 'lead-1', planWt, ['src/s1.ts'], real)).toContain('Task 1')
    expect(boardWriteDenial('claude', 'lead-1', planWt, [join(planWt, 'src', 'other.ts')], real)).toBeUndefined()
    expect(boardWriteDenial('claude', 'lead-1', repo, [join(repo, 'src', 's1.ts')], real)).toContain('Task 1')
    expect(boardWriteDenial('codex', 'worker-a', wt, [join(planWt, 'src', 's1.ts')], real)).toContain('.worktrees/rate-limit-t1')
  }))

  test('a worker edits only inside its lane worktree, with .., symlinks and case folded; the lead not a claimed task\'s file; outside the repo nothing applies', () => sandbox(async root => {
    const { repo } = await board(root)
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    const wt = String((j.data['worktree'] as { path: string }).path)
    const real = (p: string) => { try { return realpathSync(p) } catch { return undefined } }
    expect(boardWriteDenial('codex', 'worker-a', wt, ['src/s1.ts'], real)).toBeUndefined()
    expect(boardWriteDenial('codex', 'worker-a', wt, [join(wt, 'src', 'new.ts')], real)).toBeUndefined()
    expect(boardWriteDenial('codex', 'worker-a', wt, ['../../src/app.ts'], real)).toContain('.worktrees/rate-limit-t1')
    expect(boardWriteDenial('codex', 'worker-a', repo, [join(repo, 'SRC', 'APP.ts')], real)).toContain('Task 1')
    mkdirSync(join(root, 'links'), { recursive: true })
    symlinkSync(join(repo, 'src'), join(root, 'links', 'src'))
    expect(boardWriteDenial('codex', 'worker-a', wt, [join(root, 'links', 'src', 'app.ts')], real)).toContain('Task 1')
    expect(boardWriteDenial('codex', 'worker-a', wt, [join(root, 'scratch.txt')], real)).toBeUndefined()
    expect(boardWriteDenial('claude', 'lead-1', repo, [join(repo, 'src', 's1.ts')], real)).toContain('Task 1')
    expect(boardWriteDenial('claude', 'lead-1', repo, [join(repo, 'src', 'other.ts')], real)).toBeUndefined()
    expect(boardWriteDenial('claude', 'lead-1', repo, [], real)).toBeUndefined()
    expect(boardWriteDenial('opencode', 'nobody', repo, [join(repo, 'src', 's1.ts')], real)).toBeUndefined()
  }))
})

describe('boardSessionEnd, boardTerminalSequence and boardCounts', () => {
  test('the session end releases a claimed task and drops the binding; the terminal sequence is taken once; counts follow the board', () => sandbox(async root => {
    const { repo, path } = await board(root)
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    expect(boardCounts('codex', 'worker-a', NOW)).toMatchObject({ slug: 'rate-limit', role: 'worker', summary: { claimed: 1, open: 1 } })
    expect(boardCounts('claude', 'lead-1', NOW)).toMatchObject({ role: 'lead' })
    expect(boardCounts('omp', 'nobody', NOW)).toBeUndefined()
    await workAsk('which port?', ctxAt(repo, NOW + 1), A)
    expect(boardTerminalSequence('codex', 'worker-a')).toContain('\x1b]9;')
    expect(boardTerminalSequence('codex', 'worker-a')).toBeUndefined()
    const wt = String(readBoard(path)?.tasks[0]?.worktree?.path)
    boardSessionEnd('codex', 'worker-a', NOW + 2)
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'open', lastWorker: { session: 'worker-a' } })
    expect(readBoard(path)?.events.at(-1)).toMatchObject({ kind: 'released', text: 'the worker session ended' })
    expect(existsSync(wt)).toBe(true)
    expect(sessionBoard('codex', 'worker-a')).toBeUndefined()
    boardSessionEnd('claude', 'lead-1', NOW + 3)
    expect(readBoard(path)?.lead).toEqual({ harness: 'claude', session: 'lead-1' })
    boardSessionEnd('omp', 'nobody', NOW + 4)
    const again = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 5), B)
    expect(again.data).toMatchObject({ task: { n: 1 }, worktree: { path: wt, created: false } })
    await g(wt, 'status')
    expect((await workDone({ verify: 'x' }, ctxAt(repo, NOW + 6), B)).code).toBe(0)
  }))
})

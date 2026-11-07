import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claim } from '../../src/core/board/model'
import { boardPath, commonDirOf, readBoard, sessionBoard, setSessionBoard, updateBoard } from '../../src/workflow/board-store'
import { resolveBoardPath, workNote, workPublish, workStatus } from '../../src/workflow/board'
import { repoFacts } from '../../src/workflow/gitx'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, makeRepo, planDoc, write } from './fixture'

const LEAD: ResolvedSession = { harness: 'claude', sessionId: 'lead-1', source: '--session' }
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '200' }, () => fn(root)))
}

function approvedPlan(o: { n?: number, extra?: string } = {}): string {
  const doc = planDoc({ n: o.n ?? 3, status: 'IN_PROGRESS', approved: true })
  return o.extra !== undefined ? doc.replace('## Tasks', `${o.extra}\n\n## Tasks`) : doc
}

describe('the lead\'s binding', () => {
  test('a lead whose binding is gone is rebound from the board file; with two boards the registered plan decides, otherwise usage', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, approvedPlan())
    const pub = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    expect(pub.code).toBe(0)
    setSessionBoard('claude', 'lead-1', undefined)
    expect(sessionBoard('claude', 'lead-1')).toBeUndefined()
    expect(workNote('still here', {}, ctxAt(repo, NOW + 1), LEAD).code).toBe(0)
    expect(sessionBoard('claude', 'lead-1')).toEqual({ slug: 'rate-limit', path: String(pub.data['path']), role: 'lead', cursor: 0 })
    const plan2 = join(repo, 'docs', 'plan-build', '2026-11-07-cache.md')
    write(plan2, approvedPlan({ n: 1 }))
    expect((await workPublish({ planPath: plan2 }, ctxAt(repo, NOW + 2), LEAD)).code).toBe(0)
    setSessionBoard('claude', 'lead-1', undefined)
    const two = workNote('which one?', {}, ctxAt(repo, NOW + 3), LEAD)
    expect(two.data['error']).toBe('usage')
    expect(two.errors.join(' ')).toContain('cache')
    expect(two.errors.join(' ')).toContain('rate-limit')
    expect(sessionBoard('claude', 'lead-1')).toBeUndefined()
  }))
})

describe('work publish', () => {
  test('a plan with every task ticked publishes an all-merged board: exit 0, nothing open, every task merged', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ n: 2, done: 2, status: 'IN_PROGRESS', approved: true }))
    const r = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ ok: true, open: 0 })
    expect((r.data['tasks'] as Array<{ status: string }>).map(t => t.status)).toEqual(['merged', 'merged'])
    expect(readBoard(String(r.data['path']))?.tasks.every(t => t.status === 'merged')).toBe(true)
  }))

  test('writes the approved plan\'s unticked tasks with deps, constraints and context, binds the lead, and is idempotent', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    const extra = '## Context\n- Commands: tests `bun test` · types `bunx tsc --noEmit -p .`\n\n## Constraints\n- No semicolons.\n- Lease 300 s.'
    write(plan, approvedPlan({ extra }).replace('- Modify: `src/s3.ts`', '- Modify: `src/s1.ts`\n- Modify: `src/s3.ts`'))
    const r = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ ok: true, slug: 'rate-limit', base: 'main', lead: { harness: 'claude', session: 'lead-1' }, maxWorkers: 6, leaseSec: 300, changed: [], open: 3 })
    const tasks = r.data['tasks'] as Array<{ n: number, status: string, deps: number[] }>
    expect(tasks.map(t => [t.n, t.status, t.deps])).toEqual([[1, 'open', []], [2, 'open', []], [3, 'open', [1]]])
    const facts = await repoFacts(repo)
    const path = boardPath((facts as { commonDir: string }).commonDir, 'rate-limit')
    expect(r.data['path']).toBe(path)
    expect(commonDirOf(repo)).toBe((facts as { commonDir: string }).commonDir)
    const board = readBoard(path)
    expect(board?.constraints).toEqual(['- No semicolons.', '- Lease 300 s.'])
    expect(board?.context).toBe('- Commands: tests `bun test` · types `bunx tsc --noEmit -p .`')
    expect(board?.plan).toBe(plan)
    expect(sessionBoard('claude', 'lead-1')).toEqual({ slug: 'rate-limit', path, role: 'lead', cursor: 0 })
    expect(r.lines[1]).toContain('/buracle-join rate-limit')

    const again = await workPublish({ planPath: plan }, ctxAt(repo, NOW + 1000), LEAD)
    expect(again.code).toBe(0)
    expect(readBoard(path)?.events.filter(e => e.kind === 'published')).toHaveLength(2)
  }))

  test('refuses an unapproved plan, a missing plan, a directory outside a repository and a slug too long for lane worktrees', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ n: 2 }))
    expect((await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('not_approved')
    expect((await workPublish({ planPath: join(repo, 'docs', 'nope.md') }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('not_found')
    expect((await workPublish({}, ctxAt(repo, NOW), LEAD)).data['error']).toBe('usage')
    write(plan, approvedPlan())
    expect((await workPublish({ planPath: plan }, ctxAt(root, NOW), LEAD)).data['error']).toBe('no_repo')
    const long = join(repo, 'docs', 'plan-build', `2026-11-07-${'a'.repeat(62)}.md`)
    write(long, approvedPlan())
    const r = await workPublish({ planPath: long }, ctxAt(repo, NOW), LEAD)
    expect(r.data['error']).toBe('usage')
    expect(String(r.data['message'])).toContain('64')
    expect((await workPublish({ planPath: plan, leaseSec: 0 }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('usage')
    expect((await workPublish({ planPath: plan, maxWorkers: 0 }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('usage')
    const lease = await workPublish({ planPath: plan, leaseSec: 1, maxWorkers: 2 }, ctxAt(repo, NOW), LEAD)
    expect(lease.data).toMatchObject({ leaseSec: 1, maxWorkers: 2 })
  }))

  test('a second publish keeps an active task\'s files and warns (exit 2) when the plan changed them; a plan with nothing open publishes an empty board', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, approvedPlan())
    const first = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    const path = String(first.data['path'])
    expect(updateBoard(path, NOW, b => claim(b, 1, { harness: 'codex', session: 'w1' }, NOW, 'tok')).ok).toBe(true)
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('- Modify: `src/s1.ts`', '- Modify: `src/s1.ts`\n- Modify: `src/s9.ts`'))
    const second = await workPublish({ planPath: plan }, ctxAt(repo, NOW + 5), LEAD)
    expect(second.code).toBe(2)
    expect(second.errors[0]).toContain('plan_changed_while_active')
    expect(second.errors[0]).toContain('Task 1')
    expect(second.data['changed']).toEqual([1])
    expect(readBoard(path)?.tasks[0]?.files.map(f => f.path)).toEqual(['src/s1.ts'])
    const done = join(repo, 'docs', 'plan-build', '2026-11-07-all-done.md')
    write(done, planDoc({ n: 2, done: 2, status: 'COMPLETE', approved: true }))
    const empty = await workPublish({ planPath: done }, ctxAt(repo, NOW), LEAD)
    expect(empty.code).toBe(0)
    expect(empty.data['open']).toBe(0)
    expect((empty.data['tasks'] as Array<{ status: string }>).map(t => t.status)).toEqual(['merged', 'merged'])
  }))
})

describe('work status', () => {
  test('shows every task with its state, sweeps expired leases, and finds the board by slug, by the session or as the only one', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, approvedPlan())
    const none = await workStatus(undefined, ctxAt(repo, NOW), undefined)
    expect(none.data['error']).toBe('no_board')
    const pub = await workPublish({ planPath: plan, leaseSec: 1 }, ctxAt(repo, NOW), LEAD)
    const path = String(pub.data['path'])
    updateBoard(path, NOW, b => claim(b, 1, { harness: 'codex', session: 'worker-codex-1' }, NOW, 'tok'))
    const live = await workStatus('rate-limit', ctxAt(repo, NOW + 500), undefined)
    expect(live.code).toBe(0)
    expect(live.lines[0]).toContain('1 claimed')
    expect(live.lines).toContain('Task 1 claimed by codex worker-codex… (lease 1 s): Step 1')
    expect(live.data['summary']).toMatchObject({ claimed: 1, open: 2, workers: 1, total: 3 })
    const stale = await workStatus(undefined, ctxAt(repo, NOW + 2000), LEAD)
    expect(stale.lines).toContain('Task 1 stale (was codex worker-codex…): Step 1')
    expect((stale.data['tasks'] as Array<{ status: string, worker?: unknown }>)[0]).toMatchObject({ status: 'stale' })
    expect(readBoard(path)?.tasks[0]?.status).toBe('stale')
    const only = await workStatus(undefined, ctxAt(repo, NOW + 3000), undefined)
    expect(only.data['slug']).toBe('rate-limit')
    const facts = await repoFacts(repo)
    if (facts === undefined) throw new Error('no repo facts')
    expect(resolveBoardPath('Not Valid', facts, undefined)).toMatchObject({ data: { error: 'usage' } })
    expect((await workStatus('other', ctxAt(repo, NOW), undefined)).data['error']).toBe('no_board')
  }))
})

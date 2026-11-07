import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzePlan } from '../../src/workflow/plan-file'
import { readBoard, sessionBoard } from '../../src/workflow/board-store'
import { workClose, workDone, workJoin, workMerge, workPublish, workReopen, workStatus } from '../../src/workflow/board'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, g, makeRepo, planDoc, write } from './fixture'

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)
const sess = (harness: ResolvedSession['harness'], id: string): ResolvedSession => ({ harness, sessionId: id, source: '--session' })

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

async function published(root: string, lead: ResolvedSession, o: { n?: number, dep?: boolean } = {}): Promise<{ repo: string, plan: string, path: string }> {
  const repo = await makeRepo(root)
  const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
  let doc = planDoc({ n: o.n ?? 3, status: 'IN_PROGRESS', approved: true })
  if (o.dep !== false) doc = doc.replace('- Modify: `src/s3.ts`', '- Modify: `src/s1.ts`\n- Modify: `src/s3.ts`')
  write(plan, doc)
  const pub = await workPublish({ planPath: plan }, ctxAt(repo, NOW), lead)
  if (pub.code !== 0) throw new Error(pub.errors.join('; '))
  return { repo, plan, path: String(pub.data['path']) }
}

async function finish(repo: string, worker: ResolvedSession, n: number, at: number, file = `src/s${n}.ts`): Promise<void> {
  const j = await workJoin('rate-limit', { task: n }, ctxAt(repo, at), worker)
  if (j.code !== 0) throw new Error(`join ${n}: ${j.errors.join('; ')}`)
  const wt = String((j.data['worktree'] as { path: string }).path)
  write(join(wt, file), `export const s${n} = ${n}\n`)
  await g(wt, 'add', '-A')
  await g(wt, 'commit', '-q', '-m', `task ${n}: step ${n}`)
  const d = await workDone({ verify: `bun test tests/s${n}.test.ts → pass` }, ctxAt(repo, at + 1), worker)
  if (d.code !== 0) throw new Error(`done ${n}: ${d.errors.join('; ')}`)
}

function ticked(plan: string): number { return analyzePlan(readFileSync(plan, 'utf8')).tasks.done }

async function leadFlow(root: string, lead: ResolvedSession, workers: [ResolvedSession, ResolvedSession, ResolvedSession]): Promise<void> {
  const { repo, plan, path } = await published(root, lead)
  const [a, b, c] = workers
  const ja = await workJoin('rate-limit', {}, ctxAt(repo, NOW), a)
  const jb = await workJoin('rate-limit', {}, ctxAt(repo, NOW), b)
  expect([ja.data['task'], jb.data['task']].map(t => (t as { n: number }).n)).toEqual([1, 2])
  const status = await workStatus('rate-limit', ctxAt(repo, NOW), undefined)
  expect((status.data['tasks'] as Array<{ worker?: { harness: string } }>).map(t => t.worker?.harness)).toEqual([a.harness, b.harness, undefined])
  expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), c)).data['error']).toBe('nothing_to_claim')

  const nothing = await workMerge({}, ctxAt(repo, NOW + 1), lead)
  expect(nothing.data).toMatchObject({ merged: false })
  for (const [w, n] of [[a, 1], [b, 2]] as const) {
    const wt = String(readBoard(path)?.tasks[n - 1]?.worktree?.path)
    write(join(wt, `src/s${n}.ts`), `export const s${n} = ${n}\n`)
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', `task ${n}: step ${n}`)
    expect((await workDone({ verify: `bun test → pass` }, ctxAt(repo, NOW + 2), w)).code).toBe(0)
  }
  expect((await workMerge({}, ctxAt(repo, NOW + 3), a)).data['error']).toBe('not_lead')
  const m1 = await workMerge({}, ctxAt(repo, NOW + 3), lead)
  expect(m1.errors).toEqual([])
  expect(m1.data).toMatchObject({ merged: true, task: 1, ticked: true, remaining: 2 })
  expect(typeof m1.data['commit']).toBe('string')
  expect(ticked(plan)).toBe(1)
  expect(readFileSync(join(repo, 'src', 's1.ts'), 'utf8')).toBe('export const s1 = 1\n')
  expect(readBoard(path)?.tasks[0]?.status).toBe('merged')
  const m2 = await workMerge({}, ctxAt(repo, NOW + 4), lead)
  expect(m2.data).toMatchObject({ merged: true, task: 2, remaining: 1 })
  expect(ticked(plan)).toBe(2)
  expect((await workJoin('rate-limit', { task: 1 }, ctxAt(repo, NOW + 5), c)).data['error']).toBe('task_not_open')
  await finish(repo, c, 3, NOW + 6)
  const m3 = await workMerge({}, ctxAt(repo, NOW + 8), lead)
  expect(m3.data).toMatchObject({ merged: true, task: 3, remaining: 0 })
  expect(m3.lines[0]).toContain('buracle plan complete')
  expect(ticked(plan)).toBe(3)
  expect(await g(repo, 'log', '--format=%s', '-3')).toBe('feat: task 3: step 3\nfeat: task 2: step 2\nfeat: task 1: step 1')
}

describe('work merge', () => {
  test('a Claude lead merges done tasks from Codex, OpenCode and omp workers in dependency order and ticks the plan (R10)', () => sandbox(root => leadFlow(root, sess('claude', 'lead-claude'), [sess('codex', 'worker-codex'), sess('opencode', 'worker-opencode'), sess('omp', 'worker-omp')])))

  test('a Codex lead with a Claude worker works the same way (R10, the other direction)', () => sandbox(root => leadFlow(root, sess('codex', 'lead-codex'), [sess('claude', 'worker-claude'), sess('omp', 'worker-omp'), sess('opencode', 'worker-opencode')])))

  test('a task lane merge commits in the base checkout and never touches the plan file; --task picks one and deps_unmerged guards the order', () => sandbox(async root => {
    const lead = sess('claude', 'lead-1')
    const { repo, plan, path } = await published(root, lead)
    const before = readFileSync(plan, 'utf8')
    await finish(repo, sess('codex', 'w1'), 1, NOW)
    await finish(repo, sess('omp', 'w2'), 2, NOW + 2)
    expect((await workMerge({ task: 3 }, ctxAt(repo, NOW + 4), lead)).data['error']).toBe('task_not_open')
    const m2 = await workMerge({ task: 2 }, ctxAt(repo, NOW + 4), lead)
    expect(m2.data).toMatchObject({ merged: true, task: 2 })
    const after = readFileSync(plan, 'utf8')
    expect(after).toBe(before.replace('- [ ] Task 2 done', '- [x] Task 2 done'))
    expect(await g(repo, 'status', '--porcelain', '--', 'src')).toBe('')
    expect(readFileSync(join(repo, 'src', 's2.ts'), 'utf8')).toBe('export const s2 = 2\n')
    await finish(repo, sess('codex', 'w3'), 1, NOW + 5).catch(() => undefined)
    expect((await workMerge({}, ctxAt(repo, NOW + 6), lead)).data).toMatchObject({ merged: true, task: 1 })
    const done3 = readBoard(path)
    expect(done3?.tasks.map(t => t.status)).toEqual(['merged', 'merged', 'open'])
  }))

  test('a conflict leaves the task done with merge_conflict; the lead merges by hand and records it with --manual', () => sandbox(async root => {
    const lead = sess('claude', 'lead-1')
    const { repo, plan, path } = await published(root, lead, { n: 2, dep: false })
    await finish(repo, sess('codex', 'w1'), 1, NOW, 'src/app.ts')
    write(join(repo, 'src', 'app.ts'), 'export const a = 2 // lead\n')
    await g(repo, 'add', '-A')
    await g(repo, 'commit', '-q', '-m', 'lead: app')
    const m = await workMerge({}, ctxAt(repo, NOW + 3), lead)
    expect(m.code).toBe(1)
    expect(m.data).toMatchObject({ error: 'merge_conflict', task: 1, conflicts: ['src/app.ts'] })
    expect(String(m.data['message'])).toContain('--manual')
    expect(readBoard(path)?.tasks[0]?.status).toBe('done')
    expect(ticked(plan)).toBe(0)
    expect(await g(repo, 'status', '--porcelain', '--', 'src')).toBe('')
    const manual = await workMerge({ task: 1, manual: true }, ctxAt(repo, NOW + 4), lead)
    expect(manual.data).toMatchObject({ merged: true, manual: true, task: 1, commit: null, ticked: true })
    expect(readBoard(path)?.tasks[0]?.status).toBe('merged')
    expect(ticked(plan)).toBe(1)
    expect((await workMerge({ task: 1, manual: true }, ctxAt(repo, NOW + 5), lead)).data['error']).toBe('task_not_open')
  }))
})

describe('work reopen and close', () => {
  test('a merged task reopened for a fix: the plan box opens again, the worker rejoins the kept worktree, and the fix merges on top of the squash', () => sandbox(async root => {
    const lead = sess('claude', 'lead-1')
    const { repo, plan, path } = await published(root, lead, { n: 2, dep: false })
    await finish(repo, sess('codex', 'w1'), 1, NOW)
    expect((await workMerge({}, ctxAt(repo, NOW + 2), lead)).data).toMatchObject({ merged: true, task: 1 })
    expect(ticked(plan)).toBe(1)
    const re = await workReopen('1', { reason: 'the check failed' }, ctxAt(repo, NOW + 3), lead)
    expect(re.errors).toEqual([])
    expect(re.data).toMatchObject({ ok: true, task: 1, status: 'open', unticked: true, laneCaughtUp: true })
    expect(ticked(plan)).toBe(0)
    const wt = String(readBoard(path)?.tasks[0]?.worktree?.path)
    const w2 = sess('omp', 'w2')
    expect((await workJoin('rate-limit', { task: 1 }, ctxAt(repo, NOW + 4), w2)).data).toMatchObject({ task: { n: 1 }, worktree: { path: wt, created: false } })
    write(join(wt, 'src', 's1.ts'), 'export const s1 = 11\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1: the fix')
    expect((await workDone({ verify: 'bun test → pass' }, ctxAt(repo, NOW + 5), w2)).code).toBe(0)
    expect((await workMerge({}, ctxAt(repo, NOW + 6), lead)).data).toMatchObject({ merged: true, task: 1, ticked: true })
    expect(readFileSync(join(repo, 'src', 's1.ts'), 'utf8')).toBe('export const s1 = 11\n')
    expect(ticked(plan)).toBe(1)
    expect(readBoard(path)?.tasks[0]?.status).toBe('merged')
  }))

  test('reopen returns any non-open task to open, keeps its worktree and report, and nudges a claimed worker; close needs --force while tasks are open', () => sandbox(async root => {
    const lead = sess('claude', 'lead-1')
    const a = sess('codex', 'w1')
    const { repo, path } = await published(root, lead, { n: 2, dep: false })
    expect((await workReopen(undefined, {}, ctxAt(repo, NOW), lead)).data['error']).toBe('usage')
    expect((await workReopen('1', {}, ctxAt(repo, NOW), lead)).data['error']).toBe('task_not_open')
    await finish(repo, a, 1, NOW)
    expect((await workMerge({}, ctxAt(repo, NOW + 2), lead)).data).toMatchObject({ merged: true, task: 1 })
    const wt = String(readBoard(path)?.tasks[0]?.worktree?.path)
    expect((await workClose({}, ctxAt(repo, NOW + 3), lead)).data).toMatchObject({ error: 'tasks_open', open: [2] })
    const re = await workReopen('1', { reason: 'checks failed after the merge' }, ctxAt(repo, NOW + 4), lead)
    expect(re.data).toMatchObject({ ok: true, task: 1, status: 'open' })
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'open', worktree: { path: wt } })
    expect(readBoard(path)?.tasks[0]?.report?.branch).toBe('plan-build/rate-limit-t1')
    expect(readBoard(path)?.events.at(-1)).toMatchObject({ kind: 'reopened', task: 1, text: 'checks failed after the merge' })
    const j = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 5), sess('omp', 'w2'))
    expect(j.data).toMatchObject({ task: { n: 1 }, worktree: { path: wt, created: false } })
    const re2 = await workReopen('1', {}, ctxAt(repo, NOW + 6), lead)
    expect(re2.data).toMatchObject({ notified: 'w2' })
    expect(readBoard(path)?.notes.at(-1)).toMatchObject({ to: 'w2', kind: 'nudge' })
    expect((await workReopen('1', {}, ctxAt(repo, NOW + 7), a)).data['error']).toBe('not_lead')
  }))

  test('close removes the merged tasks\' worktrees and the board file; --force closes with open tasks and keeps their worktrees', () => sandbox(async root => {
    const lead = sess('claude', 'lead-1')
    const { repo, path } = await published(root, lead, { n: 2, dep: false })
    await finish(repo, sess('codex', 'w1'), 1, NOW)
    expect((await workMerge({}, ctxAt(repo, NOW + 2), lead)).code).toBe(0)
    const j2 = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 3), sess('omp', 'w2'))
    const wt1 = String(readBoard(path)?.tasks[0]?.worktree?.path)
    const wt2 = String((j2.data['worktree'] as { path: string }).path)
    expect((await workClose({}, ctxAt(repo, NOW + 4), sess('omp', 'w2'))).data['error']).toBe('not_lead')
    const c = await workClose({ force: true }, ctxAt(repo, NOW + 5), lead)
    expect(c.code).toBe(0)
    expect(c.data).toMatchObject({ closed: true, removedWorktrees: ['rate-limit-t1'], keptWorktrees: ['rate-limit-t2'] })
    expect(c.errors.some(e => e.includes('rate-limit-t2'))).toBe(true)
    expect(existsSync(wt1)).toBe(false)
    expect(existsSync(wt2)).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.lock`)).toBe(false)
    expect(sessionBoard('claude', 'lead-1')).toBeUndefined()
    expect((await workStatus('rate-limit', ctxAt(repo, NOW + 6), undefined)).data['error']).toBe('no_board')
  }))
})

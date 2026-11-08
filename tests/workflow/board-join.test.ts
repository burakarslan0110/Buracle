import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { userConfigFile } from '../../src/engine/paths'
import { readBoard, sessionBoard } from '../../src/workflow/board-store'
import { workHeartbeat, workJoin, workPublish, workRelease, workStatus } from '../../src/workflow/board'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { writeTelemetry } from '../../src/workflow/session-store'
import { readMeta } from '../../src/workflow/worktree'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, g, makeRepo, planDoc, write } from './fixture'

const LEAD: ResolvedSession = { harness: 'claude', sessionId: 'lead-1', source: '--session' }
const W = (harness: ResolvedSession['harness'], id: string): ResolvedSession => ({ harness, sessionId: id, source: '--session' })
const A = W('codex', 'worker-a')
const B = W('opencode', 'worker-b')
const C = W('omp', 'worker-c')
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

async function published(root: string, o: { n?: number, leaseSec?: number, maxWorkers?: number, dep?: boolean } = {}): Promise<{ repo: string, plan: string, path: string }> {
  const repo = await makeRepo(root)
  const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
  let doc = planDoc({ n: o.n ?? 3, status: 'IN_PROGRESS', approved: true })
  if (o.dep !== false) doc = doc.replace('- Modify: `src/s3.ts`', '- Modify: `src/s1.ts`\n- Modify: `src/s3.ts`')
  write(plan, doc.replace('## Tasks', '## Constraints\n- No semicolons.\n\n## Tasks'))
  const pub = await workPublish({ planPath: plan, ...(o.leaseSec !== undefined ? { leaseSec: o.leaseSec } : {}), ...(o.maxWorkers !== undefined ? { maxWorkers: o.maxWorkers } : {}) }, ctxAt(repo, NOW), LEAD)
  if (pub.code !== 0) throw new Error(pub.errors.join('; '))
  return { repo, plan, path: String(pub.data['path']) }
}

describe('work join: harness reservations and the swarm harnesses', () => {
  test('a task reserved for codex is skipped by other harnesses and refused to them with --task; a codex worker takes it', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ n: 3, status: 'IN_PROGRESS', approved: true }).replace('**Objective:** Do step 1.', '**Objective:** Do step 1.\n\n**Harness:** codex'))
    expect((await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)).code).toBe(0)
    const b = await workJoin('rate-limit', {}, ctxAt(repo, NOW), B)
    expect(b.data).toMatchObject({ task: { n: 2 } })
    const forced = await workJoin('rate-limit', { task: 1 }, ctxAt(repo, NOW + 1), C)
    expect(forced.code).toBe(1)
    expect(forced.data).toMatchObject({ error: 'wrong_harness' })
    expect(forced.errors[0]).toContain('reserved for codex')
    const a = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2, {}), A)
    expect(a.data).toMatchObject({ task: { n: 1, harness: 'codex' } })
    // The last task is open; an omp worker finds it, while the reserved one would have been named as blocked.
    const c = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 3), C)
    expect(c.data).toMatchObject({ task: { n: 3 } })
  }))

  test('nothing_to_claim names a reservation; a harness that plan.board.harnesses switches off is refused with harness_off', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ n: 1, status: 'IN_PROGRESS', approved: true }).replace('**Objective:** Do step 1.', '**Objective:** Do step 1.\n\n**Harness:** codex'))
    expect((await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)).code).toBe(0)
    const b = await workJoin('rate-limit', {}, ctxAt(repo, NOW), B)
    expect(b.data).toMatchObject({ error: 'nothing_to_claim' })
    expect(b.errors[0]).toContain('Task 1 is reserved for codex')
    mkdirSync(dirname(userConfigFile()), { recursive: true })
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  board:\n    harnesses:\n      codex: false\n')
    const a = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 1), A)
    expect(a.code).toBe(1)
    expect(a.data).toMatchObject({ error: 'harness_off' })
    expect(a.errors[0]).toContain('plan.board.harnesses.codex')
  }))
})

describe('work join', () => {
  test('claims the first ready task, creates its lane worktree from the base branch, binds the session and prints the card with constraints and context', () => sandbox(async root => {
    const { repo, plan, path } = await published(root)
    const r = await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    const wt = realpathSync(join(repo, '.worktrees', 'rate-limit-t1'))
    expect(r.data).toMatchObject({
      ok: true, slug: 'rate-limit', task: { n: 1, title: 'Step 1', objective: 'Do step 1.', deps: [] }, worktree: { slug: 'rate-limit-t1', path: wt, branch: 'plan-build/rate-limit-t1', base: 'main', created: true },
      lease: { until: NOW + 300_000, sec: 300 }, plan, base: 'main', constraints: ['- No semicolons.'], lead: { harness: 'claude', session: 'lead-1' },
    })
    expect(await g(wt, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('plan-build/rate-limit-t1')
    expect(readMeta(realpathSync(join(repo, '.git')), 'rate-limit-t1')).toMatchObject({ lane: true, base: 'main', owner: { harness: 'codex', session: 'worker-a' } })
    expect(sessionBoard('codex', 'worker-a')).toMatchObject({ slug: 'rate-limit', path, role: 'worker', task: 1, worktree: wt })
    expect(typeof sessionBoard('codex', 'worker-a')?.token).toBe('string')
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'claimed', worker: { harness: 'codex', session: 'worker-a' }, worktree: { path: wt } })
    expect(r.lines[0]).toBe('Claimed Task 1 of rate-limit: Step 1')
    expect(r.lines[1]).toContain(wt)

    const second = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 1), B)
    expect(second.data).toMatchObject({ task: { n: 2 } })
    const third = await workJoin(undefined, {}, ctxAt(repo, NOW + 2), C)
    expect(third.data).toMatchObject({ error: 'nothing_to_claim' })
    expect(String(third.data['message'])).toContain('Task 3 waits for Task 1')
  }))

  test('refuses the lead, a session that already holds a task, a full board, a task that is not open and one whose deps are unmerged', () => sandbox(async root => {
    const { repo } = await published(root, { maxWorkers: 1 })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), LEAD)).data['error']).toBe('lead_cannot_join')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)).code).toBe(0)
    const again = await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    expect(again.data['error']).toBe('already_claimed')
    expect(String(again.data['message'])).toContain('Task 1')
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), B)).data['error']).toBe('max_workers')
    const { repo: repo2 } = await published(join(root, 'two'), { n: 3 })
    expect((await workJoin('rate-limit', { task: 3 }, ctxAt(repo2, NOW), A)).data['error']).toBe('deps_unmerged')
    expect((await workJoin('rate-limit', { task: 1 }, ctxAt(repo2, NOW), A)).code).toBe(0)
    expect((await workJoin('rate-limit', { task: 1 }, ctxAt(repo2, NOW), B)).data['error']).toBe('task_not_open')
    expect((await workJoin('rate-limit', { task: 9 }, ctxAt(repo2, NOW), B)).data['error']).toBe('not_found')
    expect((await workJoin('nope', {}, ctxAt(repo2, NOW), B)).data['error']).toBe('no_board')
    expect((await workJoin('Bad Slug', {}, ctxAt(repo2, NOW), B)).data['error']).toBe('usage')
  }))

  test('from the fourth worker on, a rate window at 90% or more refuses the join (usage_low); below it the join passes', () => sandbox(async root => {
    const { repo } = await published(root, { n: 5, dep: false })
    for (const w of [A, B, C]) expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), w)).code).toBe(0)
    writeTelemetry('codex', 'worker-d', { at: NOW, windows: [{ pct: 95, label: '5h' }], windowsAt: NOW })
    const d = W('codex', 'worker-d')
    const hot = await workJoin('rate-limit', {}, ctxAt(repo, NOW), d)
    expect(hot.data['error']).toBe('usage_low')
    expect(String(hot.data['message'])).toContain('95%')
    writeTelemetry('codex', 'worker-d', { at: NOW, windows: [{ pct: 40, label: '5h' }], windowsAt: NOW })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), d)).code).toBe(0)
    writeTelemetry('claude', 'worker-e', { at: NOW, windows: [{ pct: 99, label: '5h' }], windowsAt: NOW })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), W('claude', 'worker-e'))).data['error']).toBe('usage_low')
  }))

  test('a failed worktree gives the claim back: the task returns to its previous state and the next worker takes it', () => sandbox(async root => {
    const { repo, path } = await published(root, { n: 2, dep: false })
    mkdirSync(join(repo, '.worktrees', 'rate-limit-t1'), { recursive: true })
    writeFileSync(join(repo, '.worktrees', 'rate-limit-t1', 'stray.txt'), 'x')
    const r = await workJoin('rate-limit', { task: 1 }, ctxAt(repo, NOW), A)
    expect(r.code).toBe(1)
    expect(r.data).toMatchObject({ error: 'path_exists', task: 1, released: true })
    expect(r.errors.some(e => e.includes('given back'))).toBe(true)
    const t1 = readBoard(path)?.tasks[0]
    expect([t1?.status, t1?.worker, t1?.token]).toEqual(['open', undefined, undefined])
    expect(sessionBoard('codex', 'worker-a')).toBeUndefined()
    rmSync(join(repo, '.worktrees', 'rate-limit-t1'), { recursive: true, force: true })
    expect((await workJoin('rate-limit', { task: 1 }, ctxAt(repo, NOW + 1), B)).code).toBe(0)
  }))
})

describe('heartbeat, release and stale recovery', () => {
  test('heartbeat renews the lease; release opens the task, keeps the worktree, clears the binding and notes the lead', () => sandbox(async root => {
    const { repo, path } = await published(root, { n: 2, dep: false })
    expect(workHeartbeat(ctxAt(repo, NOW), A).data['error']).toBe('usage')
    await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    const hb = workHeartbeat(ctxAt(repo, NOW + 60_000), A)
    expect(hb.code).toBe(0)
    expect(hb.data).toMatchObject({ task: 1, leaseUntil: NOW + 360_000, leaseSec: 300 })
    expect(sessionBoard('codex', 'worker-a')?.heartbeatAt).toBe(NOW + 60_000)
    const wt = String(readBoard(path)?.tasks[0]?.worktree?.path)
    const rel = await workRelease({ reason: 'blocked on the schema' }, ctxAt(repo, NOW + 70_000), A)
    expect(rel.code).toBe(0)
    const t1 = readBoard(path)?.tasks[0]
    expect([t1?.status, t1?.worker, t1?.lastWorker?.session, t1?.worktree?.path]).toEqual(['open', undefined, 'worker-a', wt])
    expect(existsSync(wt)).toBe(true)
    expect(readBoard(path)?.notes.at(-1)).toMatchObject({ to: 'lead', kind: 'nudge', text: 'released Task 1: blocked on the schema' })
    expect(sessionBoard('codex', 'worker-a')).toEqual({ slug: 'rate-limit', path, role: 'worker' })
    const left = await workRelease({}, ctxAt(repo, NOW + 71_000), A)
    expect(left.data).toMatchObject({ ok: true, left: true })
    expect(sessionBoard('codex', 'worker-a')).toBeUndefined()
    expect((await workRelease({}, ctxAt(repo, NOW + 72_000), A)).data['error']).toBe('usage')
  }))

  test('a lease that expires without heartbeats turns the task stale; the next worker resumes the same worktree and the old worker is reassigned', () => sandbox(async root => {
    const { repo, path } = await published(root, { n: 2, dep: false, leaseSec: 1 })
    const first = await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)
    const wt = String((first.data['worktree'] as { path: string }).path)
    const status = await workStatus('rate-limit', ctxAt(repo, NOW + 2000), undefined)
    expect((status.data['tasks'] as Array<{ status: string }>)[0]?.status).toBe('stale')
    expect(status.lines).toContain('Task 1 stale (was codex worker-a): Step 1')
    const second = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 2500), B)
    expect(second.code).toBe(0)
    expect(second.data).toMatchObject({ task: { n: 1 }, worktree: { path: wt, created: false } })
    expect(second.lines[1]).toContain('resumed from the previous worker')
    expect(readBoard(path)?.tasks[0]).toMatchObject({ status: 'claimed', worker: { session: 'worker-b' }, worktree: { path: wt } })
    const old = workHeartbeat(ctxAt(repo, NOW + 2600), A)
    expect(old.code).toBe(1)
    expect(old.data['error']).toBe('reassigned')
    expect(sessionBoard('codex', 'worker-a')).toEqual({ slug: 'rate-limit', path, role: 'worker' })
  }))
})

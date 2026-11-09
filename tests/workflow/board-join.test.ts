import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runWork } from '../../src/cli/commands/work'
import { markDone, markMerged } from '../../src/core/board/model'
import { userConfigFile } from '../../src/engine/paths'
import { readBoard, removeBoard, sessionBoard, updateBoard } from '../../src/workflow/board-store'
import { JOIN_WAIT_DEFAULT_SEC, workHeartbeat, workJoin, workPublish, workRelease, workStatus, type WaitClock } from '../../src/workflow/board'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { writeTelemetry } from '../../src/workflow/session-store'
import { readMeta } from '../../src/workflow/worktree'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, g, makeRepo, memIO, planDoc, write } from './fixture'

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

/** A clock that advances by exactly what `join --wait` sleeps, so the standby loop runs instantly; `onSleep` sees every poll. */
function virtualClock(start: number, onSleep?: (now: number, polls: number) => void): WaitClock & { polls: () => number } {
  let t = start
  let polls = 0
  return { now: () => t, sleep: async (ms: number) => { t += ms; polls++; onSleep?.(t, polls) }, polls: () => polls }
}

/** The lead merged Task n by hand on the board: done with the holder's token, then merged. */
function mergeOnBoard(path: string, n: number, now: number): void {
  const r = updateBoard(path, now, b => {
    const t = b.tasks.find(x => x.n === n)
    if (t?.token === undefined) throw new Error(`Task ${n} holds no token`)
    const done = markDone(b, n, t.token, { branch: `lane-${n}`, commits: ['c'], verify: 'ok' }, now)
    if (!done.ok) throw new Error(done.message)
    return markMerged(done.board, n, now)
  })
  if (!r.ok) throw new Error(r.message)
}

describe('work join --wait', () => {
  test('a dependency merged during the wait: the standby worker claims the task, its binding carries standbyAt and its standby entry is gone', () => sandbox(async root => {
    const { repo, path } = await published(root)
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)).data).toMatchObject({ task: { n: 1 } })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), B)).data).toMatchObject({ task: { n: 2 } })
    const clock = virtualClock(NOW, (now, polls) => {
      if (polls === 1) expect(readBoard(path)?.standby).toEqual([{ harness: 'omp', session: 'worker-c', since: NOW, at: NOW }])
      if (polls === 3) mergeOnBoard(path, 1, now)
    })
    const r = await workJoin('rate-limit', { wait: 60 }, ctxAt(repo, NOW), C, { clock })
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ ok: true, slug: 'rate-limit', task: { n: 3 }, worktree: { slug: 'rate-limit-t3', created: true } })
    // Polls at 1.0 s, 2.5 s and 4.75 s (1000 ms growing by 1.5): the claim happened at the third.
    expect(clock.polls()).toBe(3)
    expect(sessionBoard('omp', 'worker-c')).toMatchObject({ slug: 'rate-limit', path, role: 'worker', task: 3, standbyAt: NOW + 4750 })
    expect(readBoard(path)?.standby).toBeUndefined()
    expect(readBoard(path)?.tasks[2]).toMatchObject({ status: 'claimed', worker: { harness: 'omp', session: 'worker-c' }, claimedAt: NOW + 4750 })
  }))

  test('nothing ready until the deadline: standby (exit 2) with the blocked detail; the entry is registered, refreshed at most every 30 s and the binding carries the wait', () => sandbox(async root => {
    const { repo, path } = await published(root)
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)).code).toBe(0)
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), B)).code).toBe(0)
    const seen = new Set<number>()
    const clock = virtualClock(NOW, () => { const at = readBoard(path)?.standby?.find(s => s.session === 'worker-c')?.at; if (at !== undefined) seen.add(at) })
    const r = await workJoin('rate-limit', { wait: 60 }, ctxAt(repo, NOW), C, { clock })
    expect(r.code).toBe(2)
    expect(r.errors).toEqual([])
    expect(r.data).toEqual({ ok: true, standby: true, slug: 'rate-limit', waitedSec: 60, remaining: 1, blocked: [{ n: 3, detail: 'waits for Task 1 (claimed by codex worker-a)' }] })
    expect(r.lines).toEqual(['Nothing ready yet on rate-limit: Task 3 waits for Task 1 (claimed by codex worker-a). 1 task(s) may still come for omp; run `buracle work join rate-limit --wait --json` again.'])
    expect(sessionBoard('omp', 'worker-c')).toEqual({ slug: 'rate-limit', path, role: 'worker', standbyAt: NOW + 60_000 })
    // Registered at once, refreshed once after 30 s (the polls run 1, 1.5, 2.25, 3.4 and then 5 s apart), never on every poll.
    expect([...seen].sort((a, b) => a - b)).toEqual([NOW, NOW + 33_125])
    expect(readBoard(path)?.standby).toEqual([{ harness: 'omp', session: 'worker-c', since: NOW, at: NOW + 33_125 }])
    // A worker that gives up leaves the board: its entry goes with the binding.
    const left = await workRelease({}, ctxAt(repo, NOW + 61_000), C)
    expect(left.data).toMatchObject({ ok: true, left: true })
    expect(sessionBoard('omp', 'worker-c')).toBeUndefined()
    expect(readBoard(path)?.standby).toBeUndefined()
  }))

  test('retired (no_work) when every remaining task is held or reserved for another harness: standby entry and binding cleared, exit 0', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ n: 2, status: 'IN_PROGRESS', approved: true }).replace('**Objective:** Do step 2.', '**Objective:** Do step 2.\n\n**Harness:** codex'))
    const pub = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    const path = String(pub.data['path'])
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)).data).toMatchObject({ task: { n: 1 } })
    const clock = virtualClock(NOW)
    const r = await workJoin('rate-limit', { wait: 5 }, ctxAt(repo, NOW), C, { clock })
    expect(r.code).toBe(0)
    expect(r.data).toEqual({ ok: true, retired: true, reason: 'no_work', slug: 'rate-limit' })
    expect(r.lines).toEqual(['Nothing is left for omp on rate-limit: every remaining task is merged, held by another worker or reserved for another harness.'])
    expect(clock.now()).toBe(NOW + 5000)
    expect(sessionBoard('omp', 'worker-c')).toBeUndefined()
    expect(readBoard(path)?.standby).toBeUndefined()
    // A codex worker still has the reserved task to wait for, even while another codex worker holds Task 1.
    const d = W('codex', 'worker-d')
    const codex = await workJoin('rate-limit', { wait: 5 }, ctxAt(repo, NOW), d, { clock: virtualClock(NOW) })
    expect(codex.data).toMatchObject({ task: { n: 2, harness: 'codex' } })
  }))

  test('retired (board_closed) when the board file goes away during the wait: the binding is dropped, exit 0', () => sandbox(async root => {
    const { repo, path } = await published(root, { n: 1 })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)).code).toBe(0)
    const clock = virtualClock(NOW, (_now, polls) => { if (polls === 2) removeBoard(path) })
    const r = await workJoin('rate-limit', { wait: 30 }, ctxAt(repo, NOW), B, { clock })
    expect(r.code).toBe(0)
    expect(r.data).toEqual({ ok: true, retired: true, reason: 'board_closed', slug: 'rate-limit' })
    expect(r.lines).toEqual(['The board rate-limit was closed; this session is no longer a worker.'])
    expect(clock.polls()).toBe(2)
    expect(sessionBoard('opencode', 'worker-b')).toBeUndefined()
  }))

  test('a Build board publishes new tasks every round: an empty wait is standby (exit 2), never retired', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'goal-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ type: 'Build', n: 1, status: 'IN_PROGRESS', approved: true }))
    const pub = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    expect(pub.code).toBe(0)
    const path = String(pub.data['path'])
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)).code).toBe(0)
    const r = await workJoin('rate-limit', { wait: 5 }, ctxAt(repo, NOW), B, { clock: virtualClock(NOW) })
    expect(r.code).toBe(2)
    expect(r.data).toEqual({ ok: true, standby: true, slug: 'rate-limit', waitedSec: 5, remaining: 0, blocked: [] })
    expect(r.lines[0]).toContain('next round')
    expect(sessionBoard('opencode', 'worker-b')).toEqual({ slug: 'rate-limit', path, role: 'worker', standbyAt: NOW + 5000 })
    expect(readBoard(path)?.standby).toEqual([{ harness: 'opencode', session: 'worker-b', since: NOW, at: NOW }])
  }))

  test('max_workers counts the standby workers of others; a standby worker joins again freely, and its claim clears the entry', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    // Task 2 shares a file with Task 1, so it waits until Task 1 is merged.
    write(plan, planDoc({ n: 2, status: 'IN_PROGRESS', approved: true }).replace('- Modify: `src/s2.ts`', '- Modify: `src/s1.ts`\n- Modify: `src/s2.ts`'))
    const pub = await workPublish({ planPath: plan, maxWorkers: 2 }, ctxAt(repo, NOW), LEAD)
    const path = String(pub.data['path'])
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)).data).toMatchObject({ task: { n: 1 } })
    const first = await workJoin('rate-limit', { wait: 5 }, ctxAt(repo, NOW), B, { clock: virtualClock(NOW) })
    expect(first.data).toMatchObject({ standby: true, remaining: 1 })
    // One active worker and one standby worker fill the two slots.
    const full = await workJoin('rate-limit', {}, ctxAt(repo, NOW + 6000), C)
    expect(full.data).toMatchObject({ error: 'max_workers' })
    expect(String(full.data['message'])).toContain('1 standby worker(s)')
    expect((await workJoin('rate-limit', { wait: 5 }, ctxAt(repo, NOW + 6000), C, { clock: virtualClock(NOW + 6000) })).data).toMatchObject({ error: 'max_workers' })
    // The standby worker itself is not refused: it waits again (the entry keeps its `since`), and Task 1 merges meanwhile.
    const clock = virtualClock(NOW + 7000, (now, polls) => { if (polls === 2) mergeOnBoard(path, 1, now) })
    const again = await workJoin('rate-limit', { wait: 5 }, ctxAt(repo, NOW + 7000), B, { clock })
    expect(again.code).toBe(0)
    expect(again.data).toMatchObject({ task: { n: 2 } })
    expect(readBoard(path)?.standby).toBeUndefined()
    expect(sessionBoard('opencode', 'worker-b')).toMatchObject({ task: 2, standbyAt: NOW + 7000 + 2500 })
  }))

  test('--wait with --task waits for that task; a merged task, an unknown one or a reservation is refused at once; harness_off comes first; the range is 5 to 600 s', () => sandbox(async root => {
    const { repo, path } = await published(root)
    expect(JOIN_WAIT_DEFAULT_SEC).toBe(90)
    expect((await workJoin('rate-limit', { wait: 4 }, ctxAt(repo, NOW), A)).data).toMatchObject({ error: 'usage' })
    expect((await workJoin('rate-limit', { wait: 601 }, ctxAt(repo, NOW), A)).data).toMatchObject({ error: 'usage' })
    expect((await workJoin('rate-limit', {}, ctxAt(repo, NOW), A)).data).toMatchObject({ task: { n: 1 } })
    const clock = virtualClock(NOW, (now, polls) => { if (polls === 2) mergeOnBoard(path, 1, now) })
    const r = await workJoin('rate-limit', { task: 3, wait: 30 }, ctxAt(repo, NOW), C, { clock })
    expect(r.data).toMatchObject({ task: { n: 3 } })
    expect((await workJoin('rate-limit', { task: 1, wait: 5 }, ctxAt(repo, NOW + 1), B, { clock: virtualClock(NOW + 1) })).data).toMatchObject({ error: 'task_not_open' })
    expect((await workJoin('rate-limit', { task: 9, wait: 5 }, ctxAt(repo, NOW + 1), B, { clock: virtualClock(NOW + 1) })).data).toMatchObject({ error: 'not_found' })
    expect(sessionBoard('opencode', 'worker-b')).toBeUndefined()
    mkdirSync(dirname(userConfigFile()), { recursive: true })
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  board:\n    harnesses:\n      opencode: false\n')
    expect((await workJoin('rate-limit', { wait: 5 }, ctxAt(repo, NOW + 2), B, { clock: virtualClock(NOW + 2) })).data).toMatchObject({ error: 'harness_off' })
    expect(readBoard(path)?.standby).toBeUndefined()
  }))

  test('the CLI: a bare --wait before --json means the default, --wait <sec> and --wait=<sec> set it, an out-of-range or non-numeric value is a usage error', () => sandbox(async root => {
    const { repo, path } = await published(root, { n: 2, dep: false })
    const session = ['--session', 'worker-a', '--harness', 'codex']
    const low = memIO(true)
    expect(await runWork(['join', 'rate-limit', '--wait', '4', '--json', ...session], low, ctxAt(repo, NOW))).toBe(1)
    expect(low.json()).toMatchObject({ error: 'usage' })
    expect(low.err()).toContain('5 to 600')
    const word = memIO(true)
    expect(await runWork(['join', 'rate-limit', '--wait', 'soon', '--json', ...session], word, ctxAt(repo, NOW))).toBe(1)
    expect(word.err()).toContain("unexpected argument 'soon'")
    // A task is ready, so the join claims at once; the binding still records the wait (standbyAt), so the stop guard holds the worker between tasks.
    const bare = memIO(true)
    expect(await runWork(['join', 'rate-limit', '--wait', '--json', ...session], bare, ctxAt(repo, NOW))).toBe(0)
    expect(bare.json()).toMatchObject({ ok: true, task: { n: 1 } })
    expect(sessionBoard('codex', 'worker-a')).toMatchObject({ slug: 'rate-limit', path, task: 1, standbyAt: NOW })
    const valued = memIO(true)
    expect(await runWork(['join', 'rate-limit', '--wait=30', '--json', '--session', 'worker-b', '--harness', 'opencode'], valued, ctxAt(repo, NOW + 1))).toBe(0)
    expect(valued.json()).toMatchObject({ ok: true, task: { n: 2 } })
    expect(sessionBoard('opencode', 'worker-b')).toMatchObject({ task: 2, standbyAt: NOW + 1 })
    // Without --wait the binding carries no standbyAt: the worker's turn ends as before.
    const plain = memIO(true)
    expect(await runWork(['join', 'rate-limit', '--json', '--session', 'worker-c', '--harness', 'omp'], plain, ctxAt(repo, NOW + 2))).toBe(1)
    expect(plain.json()).toMatchObject({ error: 'nothing_to_claim' })
    expect(sessionBoard('omp', 'worker-c')).toBeUndefined()
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

import { describe, expect, test } from 'bun:test'
import type { PlanTask } from '../../../src/core/plan/format'
import type { Board, BoardSession, BoardStopInput } from '../../../src/core/board/model'
import {
  STANDBY_STALE_MS, TASK_STATUSES, activeWorkers, addNote, ask, boardFromPlan, boardLeadStep, boardSummary, boardWorkerBlockReason, boardWriteDenial, claim, claimable, clearStandby, eventsAfter,
  filesOverlap, heartbeat, markDelivered, markDone, markMerged, mergeBoard, nextMergeable, notesFor, release, remainingFor, reopen, resume, setStandby, setWorktree, standbyWorkers, sweep, sweepStandby,
  unclaim,
} from '../../../src/core/board/model'

const LEAD: BoardSession = { harness: 'claude', session: 'lead-1' }
const A: BoardSession = { harness: 'codex', session: 'worker-a' }
const B: BoardSession = { harness: 'opencode', session: 'worker-b' }
const NOW = 1_000_000

function task(n: number, files: string[], over: Partial<PlanTask> = {}): PlanTask {
  return { n, title: `Task ${n}`, done: false, objective: `objective ${n}`, dod: `dod ${n}`, files: files.map(path => ({ verb: 'Modify' as const, path })), ...over }
}

const OPTS = { slug: 'rate-limit', plan: '/repo/docs/plan-build/2026-11-07-rate-limit.md', planType: 'Feature' as const, base: 'dev', lead: LEAD, maxWorkers: 6, leaseSec: 300, constraints: ['- no semicolons'], context: '- Commands: bun test', now: NOW }

function fresh(tasks: PlanTask[] = [task(1, ['src/a.ts']), task(2, ['src/b.ts']), task(3, ['src/a.ts', 'src/c.ts'])]): Board {
  const r = boardFromPlan(tasks, OPTS)
  if (!r.ok) throw new Error(r.message)
  return r.board
}

function must(r: ReturnType<typeof claim>): Board {
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`)
  return r.board
}

describe('boardFromPlan', () => {
  test('derives deps from file overlap with earlier tasks and the Depends on line; ticked tasks enter as merged', () => {
    const b = fresh([task(1, ['src/a.ts'], { done: true }), task(2, ['src/b.ts']), task(3, ['src/a.ts']), task(4, ['src/d.ts'], { dependsOn: [2] })])
    expect(b.tasks.map(t => [t.n, t.status, t.deps])).toEqual([[1, 'merged', []], [2, 'open', []], [3, 'open', [1]], [4, 'open', [2]]])
    expect(b.v).toBe(1)
    expect(b.slug).toBe('rate-limit')
    expect(b.constraints).toEqual(['- no semicolons'])
    expect(b.context).toBe('- Commands: bun test')
    expect(b.lead).toEqual(LEAD)
    expect(b.events.map(e => e.kind)).toEqual(['published'])
  })

  test('rejects an unknown, self or forward Depends on reference with the task number', () => {
    for (const [dependsOn, word] of [[[9], 'Task 9'], [[2], 'itself'], [[3], 'Task 3']] as const) {
      const r = boardFromPlan([task(1, ['a']), task(2, ['b'], { dependsOn: [...dependsOn] }), task(3, ['c'])], OPTS)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.code).toBe('usage')
      expect(r.message).toContain('Task 2')
      expect(r.message).toContain(word)
    }
  })

  test('the overlap rule: equal paths, a folder prefix, a Rename pair and ./ spellings overlap; disjoint paths do not', () => {
    const f = (verb: PlanTask['files'][number]['verb'], path: string) => ({ verb, path })
    expect(filesOverlap([f('Modify', 'src/a.ts')], [f('Test', './src//a.ts')])).toBe(true)
    expect(filesOverlap([f('Modify', 'harness/')], [f('Create', 'harness/claude/x.ts')])).toBe(true)
    expect(filesOverlap([f('Create', 'harness/claude/x.ts')], [f('Modify', 'harness/')])).toBe(true)
    expect(filesOverlap([f('Rename', 'docs/old.md -> docs/new.md')], [f('Modify', 'docs/new.md')])).toBe(true)
    expect(filesOverlap([f('Rename', '`docs/old.md` -> `docs/new.md`')], [f('Modify', 'docs/old.md')])).toBe(true)
    expect(filesOverlap([f('Modify', 'src/a.ts')], [f('Modify', 'src/ab.ts')])).toBe(false)
    expect(filesOverlap([f('Modify', 'src/a')], [f('Modify', 'src/a.ts')])).toBe(false)
  })
})

describe('claimable and claim', () => {
  test('only open or stale tasks whose deps are merged and whose files do not overlap an active task, in number order, with reasons for the rest', () => {
    const b = fresh()
    expect(claimable(b)).toEqual({ ready: [1, 2], blocked: [{ n: 3, reason: 'deps', detail: 'waits for Task 1' }] })
    const c1 = must(claim(b, 1, A, NOW, 'tok-a'))
    expect(claimable(c1).ready).toEqual([2])
    const d = must(markDone(c1, 1, 'tok-a', { branch: 'plan-build/rate-limit-t1', commits: ['abc'], verify: 'bun test' }, NOW + 5))
    expect(claimable(d).blocked).toEqual([{ n: 3, reason: 'deps', detail: 'waits for Task 1' }])
    const m = must(markMerged(d, 1, NOW + 6))
    expect(claimable(m).ready).toEqual([2, 3])
    const c2 = must(claim(m, 2, B, NOW + 7, 'tok-b'))
    const withOverlap = { ...c2, tasks: c2.tasks.map(t => (t.n === 3 ? { ...t, files: [{ verb: 'Modify' as const, path: 'src/b.ts' }] } : t)) }
    expect(claimable(withOverlap)).toEqual({ ready: [], blocked: [{ n: 3, reason: 'files', detail: 'shares src/b.ts with Task 2' }] })
  })

  test('claim writes the worker, the token and the lease; a second claim of the same task fails with task_not_open', () => {
    const b = must(claim(fresh(), 1, A, NOW, 'tok-a'))
    const t = b.tasks[0]
    expect([t?.status, t?.worker, t?.token, t?.leaseUntil, t?.claimedAt]).toEqual(['claimed', A, 'tok-a', NOW + 300_000, NOW])
    expect(b.events.map(e => e.kind)).toEqual(['published', 'claimed'])
    const again = claim(b, 1, B, NOW + 1, 'tok-b')
    expect(again.ok ? 'ok' : again.code).toBe('task_not_open')
    const deps = claim(b, 3, B, NOW + 1, 'tok-b')
    expect(deps.ok ? 'ok' : deps.code).toBe('deps_unmerged')
  })

  test('a task reserved for one harness is ready only for that harness; the lead\'s overview without a harness lists it; claim from another harness fails with wrong_harness', () => {
    const b = fresh([task(1, ['src/a.ts'], { harness: 'codex' }), task(2, ['src/b.ts'])])
    expect(b.tasks[0]?.harness).toBe('codex')
    expect('harness' in (b.tasks[1] ?? {})).toBe(false)
    expect(claimable(b)).toEqual({ ready: [1, 2], blocked: [] })
    expect(claimable(b, 'codex')).toEqual({ ready: [1, 2], blocked: [] })
    expect(claimable(b, 'opencode')).toEqual({ ready: [2], blocked: [{ n: 1, reason: 'harness', detail: 'is reserved for codex' }] })
    const wrong = claim(b, 1, B, NOW, 'tok-b')
    expect(wrong.ok ? 'ok' : [wrong.code, wrong.message]).toEqual(['wrong_harness', 'Task 1 is reserved for codex workers'])
    expect(claim(b, 1, A, NOW, 'tok-a').ok).toBe(true)
    expect(claim(b, 2, B, NOW, 'tok-b').ok).toBe(true)
  })

  test('unclaim restores the pre-claim snapshot when the worktree failed; setWorktree records the lane on a claimed task only', () => {
    const b = fresh()
    const before = b.tasks[0] as (typeof b.tasks)[number]
    const c = must(claim(b, 1, A, NOW, 'tok-a'))
    const back = must(unclaim(c, 1, 'tok-a', before, NOW + 1, 'worktree failed: path_exists'))
    expect(back.tasks[0]).toEqual(before)
    expect(back.events.at(-1)).toMatchObject({ kind: 'released', task: 1, session: 'worker-a', text: 'worktree failed: path_exists' })
    expect(unclaim(back, 1, 'tok-a', before, NOW + 2, 'x').ok).toBe(false)
    const wt = { slug: 'rate-limit-t1', path: '/repo/.worktrees/rate-limit-t1', branch: 'plan-build/rate-limit-t1', base: 'dev' }
    const withWt = must(setWorktree(c, 1, 'tok-a', wt))
    expect(withWt.tasks[0]?.worktree).toEqual(wt)
    expect(withWt.events).toHaveLength(c.events.length)
    expect(setWorktree(c, 1, 'tok-b', wt).ok).toBe(false)
    expect(setWorktree(b, 1, 'tok-a', wt).ok).toBe(false)
  })

  test('heartbeat renews the lease with the matching token and reports reassigned otherwise', () => {
    const b = must(claim(fresh(), 1, A, NOW, 'tok-a'))
    const h = heartbeat(b, 1, 'tok-a', NOW + 60_000)
    expect(h.ok && h.board.tasks[0]?.leaseUntil).toBe(NOW + 360_000)
    expect(h.ok && h.board.tasks[0]?.heartbeatAt).toBe(NOW + 60_000)
    const bad = heartbeat(b, 1, 'tok-x', NOW + 60_000)
    expect(bad.ok ? 'ok' : bad.code).toBe('reassigned')
  })

  test('activeWorkers counts distinct sessions of claimed and waiting tasks', () => {
    let b = must(claim(fresh(), 1, A, NOW, 'tok-a'))
    b = must(claim(b, 2, B, NOW, 'tok-b'))
    b = must(ask(b, 2, 'tok-b', 'which port?', NOW))
    expect(activeWorkers(b)).toEqual([A, B])
  })
})

describe('sweep', () => {
  test('an expired claimed lease becomes stale, keeps the worktree, moves the worker to lastWorker; waiting tasks and live leases stay', () => {
    let b = must(claim(fresh(), 1, A, NOW, 'tok-a'))
    b = { ...b, tasks: b.tasks.map(t => (t.n === 1 ? { ...t, worktree: { slug: 'rate-limit-t1', path: '/repo/.worktrees/rate-limit-t1', branch: 'plan-build/rate-limit-t1', base: 'dev' } } : t)) }
    b = must(claim(b, 2, B, NOW, 'tok-b'))
    b = must(ask(b, 2, 'tok-b', 'q', NOW))
    expect(sweep(b, NOW + 299_000)).toBe(b)
    const s = sweep(b, NOW + 300_001)
    const t1 = s.tasks[0]
    expect([t1?.status, t1?.worker, t1?.token, t1?.lastWorker, t1?.worktree?.path]).toEqual(['stale', undefined, undefined, A, '/repo/.worktrees/rate-limit-t1'])
    expect(s.tasks[1]?.status).toBe('waiting')
    expect(s.events.at(-1)?.kind).toBe('stale')
    expect(claimable(s).ready).toEqual([1])
    const re = must(claim(s, 1, B, NOW + 300_002, 'tok-b2'))
    expect(re.tasks[0]?.worktree?.path).toBe('/repo/.worktrees/rate-limit-t1')
    expect(heartbeat(re, 1, 'tok-a', NOW + 300_003).ok).toBe(false)
  })
})

describe('remainingFor', () => {
  test('counts the open and stale tasks a harness may still take: blocked ones count, held and merged ones do not, a reservation filters', () => {
    const b = fresh([task(1, ['src/a.ts']), task(2, ['src/b.ts'], { harness: 'codex' }), task(3, ['src/a.ts']), task(4, ['src/d.ts'], { done: true })])
    expect(claimable(b, 'omp').ready).toEqual([1])
    expect(remainingFor(b, 'codex')).toBe(3)
    expect(remainingFor(b, 'omp')).toBe(2)
    const c = must(claim(b, 1, A, NOW, 'tok-a'))
    expect(remainingFor(c, 'codex')).toBe(2)
    expect(remainingFor(c, 'omp')).toBe(1)
    const d = must(markDone(c, 1, 'tok-a', { branch: 'x', commits: ['1'], verify: 'v' }, NOW + 1))
    expect(remainingFor(d, 'omp')).toBe(1)
    const m = must(markMerged(d, 1, NOW + 2))
    expect(remainingFor(m, 'omp')).toBe(1)
    expect(remainingFor(m, 'codex')).toBe(2)
    const s = sweep(c, NOW + 300_001)
    expect(s.tasks[0]?.status).toBe('stale')
    expect(remainingFor(s, 'omp')).toBe(2)
    const w = must(ask(must(claim(m, 3, B, NOW + 3, 'tok-b')), 3, 'tok-b', 'q', NOW + 4))
    expect(remainingFor(w, 'opencode')).toBe(0)
    expect(remainingFor(w, 'codex')).toBe(1)
  })
})

describe('standby workers', () => {
  test('setStandby registers a session once and refreshes `at` while keeping `since`; clearStandby removes it; neither writes an event', () => {
    const b = fresh()
    const one = setStandby(b, A, NOW)
    expect(one.standby).toEqual([{ harness: 'codex', session: 'worker-a', since: NOW, at: NOW }])
    expect(one.events).toHaveLength(b.events.length)
    expect(one.seq).toBe(b.seq)
    const again = setStandby(one, A, NOW + 5_000)
    expect(again.standby).toEqual([{ harness: 'codex', session: 'worker-a', since: NOW, at: NOW + 5_000 }])
    const two = setStandby(again, B, NOW + 6_000)
    expect(standbyWorkers(two).map(s => s.session)).toEqual(['worker-a', 'worker-b'])
    expect(standbyWorkers(two, A).map(s => s.session)).toEqual(['worker-b'])
    expect(standbyWorkers(two, { harness: 'omp', session: 'worker-a' })).toHaveLength(2)
    const cleared = clearStandby(two, A)
    expect(standbyWorkers(cleared).map(s => s.session)).toEqual(['worker-b'])
    expect(clearStandby(cleared, A)).toBe(cleared)
    const empty = clearStandby(cleared, B)
    expect('standby' in empty).toBe(false)
    expect(standbyWorkers(empty)).toEqual([])
    expect(empty.events).toHaveLength(b.events.length)
    expect(standbyWorkers(fresh())).toEqual([])
    expect(activeWorkers(two)).toEqual([])
    expect(boardSummary(two).workers).toBe(0)
  })

  test('sweep drops a standby entry whose `at` is older than STANDBY_STALE_MS, beside the expired leases; a live entry stays', () => {
    expect(STANDBY_STALE_MS).toBe(180_000)
    let b = setStandby(must(claim(fresh(), 1, A, NOW, 'tok-a')), B, NOW)
    b = setStandby(b, { harness: 'opencode', session: 'worker-c' }, NOW + 100_000)
    expect(sweepStandby(b, NOW + STANDBY_STALE_MS)).toBe(b)
    expect(sweep(b, NOW + STANDBY_STALE_MS)).toBe(b)
    const s = sweep(b, NOW + STANDBY_STALE_MS + 1)
    expect(standbyWorkers(s).map(x => x.session)).toEqual(['worker-c'])
    expect(s.tasks[0]?.status).toBe('claimed')
    expect(s.events).toHaveLength(b.events.length)
    const later = sweep(b, NOW + 300_001)
    expect(later.tasks[0]?.status).toBe('stale')
    expect(standbyWorkers(later)).toEqual([])
    expect(later.events.at(-1)?.kind).toBe('stale')
  })
})

describe('transitions', () => {
  test('ask, resume, done, release and reopen run only from the allowed states', () => {
    const b = must(claim(fresh(), 1, A, NOW, 'tok-a'))
    expect(ask(fresh(), 1, 'tok-a', 'q', NOW).ok).toBe(false)
    const w = must(ask(b, 1, 'tok-a', 'which port?', NOW + 1))
    expect([w.tasks[0]?.status, w.tasks[0]?.question]).toEqual(['waiting', 'which port?'])
    expect(sweep(w, NOW + 999_999)).toBe(w)
    // Asking again while waiting replaces the question and keeps the task waiting (a follow-up question, or a retry).
    const w2 = must(ask(w, 1, 'tok-a', 'and the host?', NOW + 1))
    expect([w2.tasks[0]?.status, w2.tasks[0]?.question, w2.events.at(-1)?.kind]).toEqual(['waiting', 'and the host?', 'waiting'])
    expect(ask(w, 1, 'tok-b', 'q', NOW + 1).ok).toBe(false)
    const r = must(resume(w, 1, 'tok-a', NOW + 2))
    expect([r.tasks[0]?.status, r.tasks[0]?.question, r.tasks[0]?.leaseUntil]).toEqual(['claimed', undefined, NOW + 2 + 300_000])
    const other = markDone(r, 1, 'tok-b', { branch: 'x', commits: [], verify: 'v' }, NOW + 3)
    expect(other.ok ? 'ok' : other.code).toBe('not_claimed_by_you')
    const d = must(markDone(r, 1, 'tok-a', { branch: 'plan-build/rate-limit-t1', commits: ['abc'], verify: 'bun test → 3 pass' }, NOW + 3))
    expect([d.tasks[0]?.status, d.tasks[0]?.worker, d.tasks[0]?.report?.commits]).toEqual(['done', undefined, ['abc']])
    expect(claim(d, 1, B, NOW + 4, 'tok-b').ok).toBe(false)
    const m = must(markMerged(d, 1, NOW + 5))
    expect(m.tasks[0]?.status).toBe('merged')
    expect(markMerged(m, 1, NOW + 6).ok).toBe(false)
    const ro = must(reopen(m, 1, NOW + 7, 'checks failed'))
    expect([ro.tasks[0]?.status, ro.tasks[0]?.report?.commits, ro.events.at(-1)?.kind]).toEqual(['open', ['abc'], 'reopened'])
    const rel = must(release(must(claim(ro, 1, B, NOW + 8, 'tok-b')), 1, 'tok-b', NOW + 9))
    expect([rel.tasks[0]?.status, rel.tasks[0]?.worker, rel.events.at(-1)?.kind]).toEqual(['open', undefined, 'released'])
    expect(release(rel, 1, 'tok-b', NOW + 10).ok).toBe(false)
  })

  test('nextMergeable is the lowest done task whose deps are merged', () => {
    let b = must(claim(fresh([task(1, ['a']), task(2, ['b']), task(3, ['c'], { dependsOn: [2] })]), 2, A, NOW, 'tok-a'))
    b = must(claim(b, 1, B, NOW, 'tok-b'))
    b = must(markDone(b, 2, 'tok-a', { branch: 'x', commits: ['1'], verify: 'v' }, NOW))
    expect(nextMergeable(b)).toBe(2)
    b = must(markMerged(b, 2, NOW))
    expect(nextMergeable(b)).toBeUndefined()
    b = must(claim(b, 3, A, NOW, 'tok-a2'))
    b = must(markDone(b, 3, 'tok-a2', { branch: 'y', commits: ['2'], verify: 'v' }, NOW))
    b = must(markDone(b, 1, 'tok-b', { branch: 'z', commits: ['3'], verify: 'v' }, NOW))
    expect(nextMergeable(b)).toBe(1)
  })
})

describe('mergeBoard', () => {
  test('keeps states and workers, refreshes open and stale tasks, adds new tasks, reports active tasks whose files changed and reopens unticked merged tasks', () => {
    let old = must(claim(fresh(), 1, A, NOW, 'tok-a'))
    old = must(markDone(must(claim(old, 2, B, NOW, 'tok-b')), 2, 'tok-b', { branch: 'x', commits: ['1'], verify: 'v' }, NOW))
    old = must(markMerged(old, 2, NOW))
    const plan = [task(1, ['src/a.ts', 'src/new.ts']), task(2, ['src/b.ts']), task(3, ['src/zz.ts']), task(4, ['src/d.ts'])]
    const next = boardFromPlan(plan, { ...OPTS, now: NOW + 100, lead: { harness: 'codex', session: 'lead-2' } })
    if (!next.ok) throw new Error(next.message)
    const { board, changed } = mergeBoard(old, next.board)
    expect(changed).toEqual([1, 2])
    expect(board.tasks.map(t => [t.n, t.status])).toEqual([[1, 'claimed'], [2, 'open'], [3, 'open'], [4, 'open']])
    expect(board.tasks[0]?.worker).toEqual(A)
    expect(board.tasks[0]?.files.map(f => f.path)).toEqual(['src/a.ts'])
    expect(board.tasks[1]?.report?.commits).toEqual(['1'])
    expect(board.tasks[2]?.files.map(f => f.path)).toEqual(['src/zz.ts'])
    expect(board.tasks[2]?.deps).toEqual([])
    expect(board.lead).toEqual({ harness: 'codex', session: 'lead-2' })
    expect(board.events.filter(e => e.kind === 'reopened').map(e => e.task)).toEqual([2])
    expect(board.events.at(-1)?.kind).toBe('published')
    expect(board.seq).toBeGreaterThan(old.seq)
  })

  test('a republish refreshes the harness of open tasks and reports a changed harness on an active task as drift', () => {
    const old = must(claim(fresh([task(1, ['src/a.ts']), task(2, ['src/b.ts'], { harness: 'codex' }), task(3, ['src/c.ts'], { harness: 'omp' })]), 1, A, NOW, 'tok-a'))
    const plan = [task(1, ['src/a.ts'], { harness: 'opencode' }), task(2, ['src/b.ts']), task(3, ['src/c.ts'], { harness: 'codex' })]
    const next = boardFromPlan(plan, { ...OPTS, now: NOW + 100 })
    if (!next.ok) throw new Error(next.message)
    const { board, changed } = mergeBoard(old, next.board)
    expect(changed).toEqual([1])
    expect(board.tasks[0]?.status).toBe('claimed')
    expect('harness' in (board.tasks[0] ?? {})).toBe(false)
    expect('harness' in (board.tasks[1] ?? {})).toBe(false)
    expect(board.tasks[2]?.harness).toBe('codex')
  })

  test('a republish keeps the standby workers and takes the fresh harnesses and panes when the plan names them, else keeps the old ones', () => {
    const old: Board = { ...setStandby(fresh(), A, NOW), harnesses: ['claude', 'codex'], panes: 'tmux' }
    const plain = boardFromPlan([task(1, ['src/a.ts']), task(2, ['src/b.ts']), task(3, ['src/a.ts', 'src/c.ts'])], { ...OPTS, now: NOW + 100 })
    if (!plain.ok) throw new Error(plain.message)
    const kept = mergeBoard(old, plain.board).board
    expect(kept.standby).toEqual([{ harness: 'codex', session: 'worker-a', since: NOW, at: NOW }])
    expect([kept.harnesses, kept.panes]).toEqual([['claude', 'codex'], 'tmux'])
    const next = mergeBoard(old, { ...plain.board, harnesses: ['omp'], panes: 'cmux' }).board
    expect([next.harnesses, next.panes]).toEqual([['omp'], 'cmux'])
    expect(next.standby).toEqual(kept.standby)
    const bare = mergeBoard(fresh(), plain.board).board
    expect(['standby' in bare, 'harnesses' in bare, 'panes' in bare]).toEqual([false, false, false])
  })
})

describe('boardLeadStep and boardWorkerBlockReason', () => {
  const summary = (over: Partial<BoardStopInput['summary']> = {}): BoardStopInput['summary'] => ({ open: 0, claimed: 0, waiting: 0, done: 0, merged: 0, stale: 0, workers: 0, total: 5, ...over })
  const lead = (over: Partial<BoardStopInput> = {}): BoardStopInput => ({ slug: 'rate-limit', role: 'lead', summary: summary({ open: 3 }), ...over })
  const spawn = '2 ready task(s) and 0 worker(s) waiting: run `buracle work spawn --json` (or ask the user for more terminals: `/buracle-join rate-limit`)'

  test('the lead is told to spawn when more tasks are ready than workers wait, in every branch, and not otherwise', () => {
    expect(boardLeadStep(lead({ ready: 2, waiting: 0 }))).toContain(spawn)
    expect(boardLeadStep(lead({ ready: 2, waiting: 0 }))).toContain('open for workers')
    const claimed = boardLeadStep(lead({ summary: summary({ open: 3, claimed: 1 }), ready: 2, waiting: 0 }))
    expect(claimed).toContain(spawn)
    expect(claimed).toContain('buracle work wait --json')
    const done = boardLeadStep(lead({ summary: summary({ open: 3, done: 1 }), ready: 2, waiting: 0 }))
    expect(done).toContain(spawn)
    expect(done).toContain('buracle work merge --json')
    expect(boardLeadStep(lead({ ready: 1, waiting: 1 }))).not.toContain('buracle work spawn')
    expect(boardLeadStep(lead({ ready: 1, waiting: 2 }))).not.toContain('buracle work spawn')
    expect(boardLeadStep(lead({ ready: 2 }))).not.toContain('buracle work spawn')
    expect(boardLeadStep(lead({ waiting: 0 }))).not.toContain('buracle work spawn')
    expect(boardLeadStep(lead({ summary: summary({ done: 2, merged: 3 }), ready: 2, waiting: 0 }))).not.toContain('buracle work spawn')
    expect(boardLeadStep(lead({ summary: summary({ merged: 5 }), ready: 1, waiting: 0 }))).toBeUndefined()
    expect(boardLeadStep({ ...lead({ ready: 2, waiting: 0 }), role: 'worker' })).toBeUndefined()
    expect(boardLeadStep(lead())).toBe('the remaining 3 task(s) are open for workers on the board rate-limit: do not implement them yourself; wait with `buracle work wait --json`, or ask the user to open more terminals and run `/buracle-join rate-limit`')
  })

  test('a standby worker without a task is told to wait again or release; a claimed task keeps the claimed text', () => {
    const standby: BoardStopInput = { slug: 'rate-limit', role: 'worker', summary: summary({ open: 3 }), standby: { remaining: 3, waitedAt: NOW }, harness: 'codex' }
    expect(boardWorkerBlockReason(standby)).toBe('this session is a standby worker of the board rate-limit: 3 task(s) may still become ready for codex. Run `buracle work join rate-limit --wait --json` again, or leave the board with `buracle work release`.')
    const { harness: _h, ...unknownHarness } = standby
    expect(boardWorkerBlockReason(unknownHarness)).toContain('may still become ready for this harness.')
    const claimed = boardWorkerBlockReason({ ...standby, task: { n: 2, status: 'claimed' } })
    expect(claimed).toContain('this session holds Task 2 of the board rate-limit (claimed)')
    expect(claimed).not.toContain('standby')
  })
})

describe('notes and events', () => {
  test('notes get a seq, reach the lead, everyone or one session, and are delivered once per recipient', () => {
    const { board: b1, note } = addNote(fresh(), { from: A, role: 'worker', to: 'lead', kind: 'question', text: 'which port?' }, NOW)
    expect(note.seq).toBe(b1.seq)
    expect(b1.events.at(-1)).toEqual({ seq: b1.seq, kind: 'note', at: NOW, session: 'worker-a', harness: 'codex', note: note.seq, text: 'which port?' })
    const { board: b2 } = addNote(b1, { from: LEAD, role: 'lead', to: 'all', kind: 'nudge', text: 'rebase please' }, NOW + 1)
    const { board: b3 } = addNote(b2, { from: LEAD, role: 'lead', to: 'worker-b', kind: 'nudge', text: 'only b' }, NOW + 2)
    expect(notesFor(b3, 'lead-1', 'lead').map(n => n.text)).toEqual(['which port?'])
    expect(notesFor(b3, 'worker-a', 'worker').map(n => n.text)).toEqual(['rebase please'])
    expect(notesFor(b3, 'worker-b', 'worker').map(n => n.text)).toEqual(['rebase please', 'only b'])
    const d = markDelivered(b3, notesFor(b3, 'worker-b', 'worker').map(n => n.seq), 'worker-b')
    expect(notesFor(d, 'worker-b', 'worker')).toEqual([])
    expect(notesFor(d, 'worker-a', 'worker').map(n => n.text)).toEqual(['rebase please'])
    expect(eventsAfter(d, b1.seq).map(e => e.kind)).toEqual(['note', 'note'])
    expect(eventsAfter(d, d.seq)).toEqual([])
  })

  test('boardSummary counts every status, the distinct workers and the total', () => {
    let b = must(claim(fresh(), 1, A, NOW, 'tok-a'))
    b = must(claim(b, 2, B, NOW, 'tok-b'))
    b = must(ask(b, 2, 'tok-b', 'q', NOW))
    expect(boardSummary(b)).toEqual({ open: 1, claimed: 1, waiting: 1, done: 0, merged: 0, stale: 0, workers: 2, total: 3 })
    expect(TASK_STATUSES).toEqual(['open', 'claimed', 'waiting', 'done', 'merged', 'stale'])
  })
})

describe('boardWriteDenial', () => {
  const b = must(claim(fresh(), 1, A, NOW, 'tok-a'))
  test('the lead may not write a file of a claimed or waiting task; other repo files and paths outside the repo pass', () => {
    const lead = { role: 'lead' as const, repoRoot: '/repo', board: b }
    expect(boardWriteDenial(lead, '/repo/src/a.ts')).toContain('Task 1')
    expect(boardWriteDenial(lead, '/repo/src/a.ts')).toContain('worker-a')
    expect(boardWriteDenial(lead, '/repo/src/b.ts')).toBeUndefined()
    expect(boardWriteDenial(lead, '/elsewhere/src/a.ts')).toBeUndefined()
    const waiting = must(ask(b, 1, 'tok-a', 'q', NOW))
    expect(boardWriteDenial({ ...lead, board: waiting }, '/repo/SRC/A.ts')).toContain('Task 1')
    const done = must(markDone(b, 1, 'tok-a', { branch: 'x', commits: [], verify: 'v' }, NOW))
    expect(boardWriteDenial({ ...lead, board: done }, '/repo/src/a.ts')).toBeUndefined()
  })

  test('a worker may write only inside its lane worktree; without a task every repo path is denied', () => {
    const worker = { role: 'worker' as const, repoRoot: '/repo', task: 1, worktree: '/repo/.worktrees/rate-limit-t1' }
    expect(boardWriteDenial(worker, '/repo/.worktrees/rate-limit-t1/src/a.ts')).toBeUndefined()
    expect(boardWriteDenial(worker, '/repo/src/a.ts')).toContain('.worktrees/rate-limit-t1')
    expect(boardWriteDenial(worker, '/repo/.worktrees/other/src/a.ts')).toContain('Task 1')
    expect(boardWriteDenial(worker, '/tmp/scratch.txt')).toBeUndefined()
    expect(boardWriteDenial({ role: 'worker', repoRoot: '/repo' }, '/repo/src/a.ts')).toContain('buracle work join')
  })
})

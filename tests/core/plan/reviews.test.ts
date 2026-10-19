import { describe, expect, test } from 'bun:test'
import type { SessionState } from '../../../src/core/plan/state'
import { emptyState } from '../../../src/core/plan/state'
import {
  companionOf, fileListText, laneReviewCleared, laneReviewLabel, laneReviewStarted, laneReviewsInFlight, planReviews, reviewCollected, reviewFreshness, reviewLabel, reviewOf,
  reviewStarted, reviewSubjectText, reviewsInFlight,
} from '../../../src/core/plan/reviews'

const PLAN = '/r/docs/plans/2026-10-08-x.md'
const bound = (over: Partial<SessionState> = {}): SessionState => ({ ...emptyState(), plan: { path: PLAN, slug: 'x', status: 'PENDING', type: 'Feature', phase: 'plan', registeredAt: 1 }, ...over })

describe('review records (core reviews.ts)', () => {
  test('one record per plan and role: a relaunch replaces the running one, the collected one keeps its handle', () => {
    const a = reviewStarted(bound(), { role: 'changes', handle: '  agent\n7 ', provider: 'codex' }, 10)
    expect(reviewOf(a, 'changes')).toEqual({ role: 'changes', plan: PLAN, state: 'running', startedAt: 10, handle: 'agent 7', provider: 'codex' })
    const b = reviewStarted(a, { role: 'changes', handle: 'agent-8' }, 20)
    expect(planReviews(b)).toEqual([{ role: 'changes', plan: PLAN, state: 'running', startedAt: 20, handle: 'agent-8' }])
    expect(reviewsInFlight(b).map(reviewLabel)).toEqual(['changes-review (handle agent-8)'])
    const c = reviewCollected(b, { role: 'changes', verdict: 'needs_changes', fingerprint: 'f1', base: 'abc', dir: '/r', files: ['b.ts', 'a.ts'] }, 30)
    expect(reviewOf(c, 'changes')).toEqual({ role: 'changes', plan: PLAN, state: 'collected', startedAt: 20, collectedAt: 30, verdict: 'needs_changes', fingerprint: 'f1', handle: 'agent-8', base: 'abc', dir: '/r', files: ['b.ts', 'a.ts'] })
    expect(reviewsInFlight(c)).toEqual([])
  })

  test('a second opinion has its own slot beside the native reviewer of the same role, its own label and an optional note', () => {
    const native = reviewStarted(bound(), { role: 'plan', handle: 'agent-1' }, 10)
    const both = reviewStarted(native, { role: 'plan', handle: 'cmp-plan-1', provider: 'codex', companion: true }, 11)
    expect(planReviews(both)).toHaveLength(2)
    expect(reviewOf(both, 'plan')).toMatchObject({ handle: 'agent-1' })
    expect(companionOf(both, 'plan')).toEqual({ role: 'plan', plan: PLAN, state: 'running', startedAt: 11, handle: 'cmp-plan-1', provider: 'codex', companion: true })
    expect(reviewsInFlight(both).map(reviewLabel)).toEqual(['plan-build-review (handle agent-1)', 'plan-build-review second opinion on codex (job cmp-plan-1)'])
    const done = reviewCollected(both, { role: 'plan', verdict: 'incomplete', companion: true, fingerprint: 'f', note: ' codex: no answer\nwithin 20 min ' }, 30)
    expect(companionOf(done, 'plan')).toEqual({ role: 'plan', plan: PLAN, state: 'collected', startedAt: 11, collectedAt: 30, verdict: 'incomplete', fingerprint: 'f', handle: 'cmp-plan-1', provider: 'codex', companion: true, note: 'codex: no answer within 20 min' })
    expect(reviewOf(done, 'plan')).toMatchObject({ state: 'running', handle: 'agent-1' })
    expect(companionOf(reviewCollected(done, { role: 'plan', verdict: 'pass', fingerprint: 'g' }, 40), 'plan')?.verdict).toBe('incomplete')
  })

  test('without a bound plan, or with an unknown role or verdict, nothing is recorded; another plan\'s records are not this plan\'s', () => {
    const none = emptyState()
    expect(reviewStarted(none, { role: 'plan' }, 1)).toBe(none)
    const s = bound()
    expect(reviewStarted(s, { role: 'security' as never }, 1)).toBe(s)
    expect(reviewCollected(s, { role: 'plan', verdict: 'ok' as never, fingerprint: 'f' }, 1)).toBe(s)
    const other = { ...bound(), reviews: [{ role: 'plan' as const, plan: '/r/docs/plans/other.md', state: 'running' as const, startedAt: 1 }, { role: 'oops' } as never] }
    expect(planReviews(other)).toEqual([])
    expect(reviewsInFlight(other)).toEqual([])
  })

  test('a lane\'s reviewer is mirrored in the lead\'s state without a plan of its own: one per lane and role, cleared per role or per lane', () => {
    const lead = emptyState()
    const a = laneReviewStarted(lead, { lane: 'billing', role: 'changes', handle: 'agent-9', provider: 'claude' }, 10)
    const b = laneReviewStarted(laneReviewStarted(a, { lane: 'billing', role: 'changes', handle: 'agent-10' }, 20), { lane: 'export', role: 'plan' }, 30)
    expect(laneReviewsInFlight(b)).toEqual([{ lane: 'billing', role: 'changes', startedAt: 20, handle: 'agent-10' }, { lane: 'export', role: 'plan', startedAt: 30 }])
    expect(laneReviewsInFlight(b).map(laneReviewLabel)).toEqual(['changes-review for lane billing (handle agent-10)', 'plan-build-review for lane export'])
    expect(planReviews(b)).toEqual([])
    expect(laneReviewsInFlight(laneReviewCleared(b, 'billing', 'plan'))).toHaveLength(2)
    expect(laneReviewsInFlight(laneReviewCleared(b, 'billing', 'changes'))).toEqual([{ lane: 'export', role: 'plan', startedAt: 30 }])
    expect(laneReviewCleared(laneReviewCleared(b, 'billing'), 'export').laneReviews).toBeUndefined()
    expect(laneReviewStarted(lead, { lane: ' ', role: 'plan' }, 1)).toBe(lead)
    expect(laneReviewStarted(lead, { lane: 'x', role: 'security' as never }, 1)).toBe(lead)
  })

  test('at most 12 records are kept, the newest last', () => {
    let s = bound()
    for (let i = 0; i < 15; i++) s = reviewStarted({ ...s, plan: { ...(s.plan as NonNullable<SessionState['plan']>), path: `/r/p${i}.md` } }, { role: 'plan' }, i)
    expect(s.reviews).toHaveLength(12)
    expect(s.reviews?.at(-1)?.plan).toBe('/r/p14.md')
  })

  test('the plan anchor ignores the frontmatter, ticked boxes and trailing blanks, but not a changed line', () => {
    const base = '---\nstatus: PENDING\napproved: false\n---\n# T\n\n- [ ] Task 1 done\n- [ ] keep me\n'
    const ticked = '---\nstatus: COMPLETE\napproved: true\niterations: 2\n---\n# T  \n\n- [x] Task 1 done\n- [ ] keep me\n\n\n'
    expect(reviewSubjectText(ticked)).toBe(reviewSubjectText(base))
    expect(reviewSubjectText(base.replace('- [ ] keep me', '- [x] keep me'))).not.toBe(reviewSubjectText(base))
    expect(reviewSubjectText(base.replace('# T', '# T2'))).not.toBe(reviewSubjectText(base))
  })

  test('the file list is sorted before it is hashed, and freshness compares the anchors', () => {
    expect(fileListText([['b.ts', '2'], ['a.ts', '1']])).toBe(fileListText([['a.ts', '1'], ['b.ts', '2']]))
    const rec = { role: 'plan' as const, plan: PLAN, state: 'collected' as const, startedAt: 1, fingerprint: 'f' }
    expect(reviewFreshness(rec, 'f')).toBe('fresh')
    expect(reviewFreshness(rec, 'g')).toBe('stale')
    expect(reviewFreshness(rec, undefined)).toBe('fresh')
    expect(reviewFreshness({ ...rec, state: 'running' }, 'f')).toBe('missing')
    expect(reviewFreshness(undefined, 'f')).toBe('missing')
  })
})

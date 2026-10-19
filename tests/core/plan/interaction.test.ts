import { describe, expect, test } from 'bun:test'
import { promptInteraction } from '../../../src/core/plan/interaction'
import type { SessionState } from '../../../src/core/plan/state'
import { AUTO_PAUSE_REASON, emptyState } from '../../../src/core/plan/state'
import { CONTROL_GUIDANCE, MODEL_SWITCH_REASON, RUNAWAY_REASON, detectIntent } from '../../../src/core/policy/intents'

function plan(over: Partial<NonNullable<SessionState['plan']>> = {}, rest: Partial<SessionState> = {}): SessionState {
  return { ...emptyState(), plan: { path: '/r/docs/plans/x.md', slug: 'x', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1, ...over }, ...rest }
}
const opts = { autoPause: false, now: 500 }

describe('promptInteraction (H10 on every harness)', () => {
  test('without a plan: guidance only, the state is unchanged', () => {
    const s = emptyState()
    expect(promptInteraction(s, 'pause', 'stop', opts)).toEqual({ next: s, guidance: CONTROL_GUIDANCE.pause })
    expect(promptInteraction(s, 'resume', 'continue', opts)).toEqual({ next: s })
    expect(promptInteraction(s, null, 'hello', { autoPause: true, now: 1 })).toEqual({ next: s })
  })

  test('pause and stop record a discussion pause; a resume ends it', () => {
    const p = promptInteraction(plan(), 'pause', 'wait', opts)
    expect(p.next.interaction).toEqual({ state: 'paused', kind: 'discussion', since: 500, reason: 'the user asked to stop' })
    expect(p.guidance).toBe(CONTROL_GUIDANCE.pausePlan)
    const r = promptInteraction(p.next, 'resume', 'continue', { ...opts, now: 600 })
    expect(r.next.interaction).toEqual({ state: 'running', since: 600 })
    expect(r.guidance).toBe(CONTROL_GUIDANCE.resume)
  })

  test('a bare continue keeps a decision pause and says so (PLAN-BUILD-M2, AGENTS-3)', () => {
    const held = plan({}, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'merge decision' } })
    const r = promptInteraction(held, 'resume', 'devam', opts)
    expect(r.next).toBe(held)
    expect(r.guidance).toContain('stays paused on an open decision ("merge decision")')
  })

  test('the result review: an explicit approval records it and resumes; "continue" does not', () => {
    const review = plan({ status: 'COMPLETE', phase: 'verify' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'result review' } })
    const ok = promptInteraction(review, null, 'LGTM', opts)
    expect(ok.resultApproved).toBe(true)
    expect(ok.next.approvals?.resultApprovedAt).toBe(500)
    expect(ok.next.interaction).toEqual({ state: 'running', since: 500 })
    expect(ok.guidance).toBe(CONTROL_GUIDANCE.resultApproved)
    const cont = promptInteraction(review, 'resume', 'continue', opts)
    expect(cont.next).toBe(review)
    expect(cont.guidance).toContain('"continue" is no approval of the result')
    const stop = promptInteraction(review, 'pause', 'approve? no, wait', opts)
    expect(stop.next.approvals?.resultApprovedAt).toBeUndefined()
    const elsewhere = plan({ status: 'COMPLETE', phase: 'verify' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'merge decision' } })
    expect(promptInteraction(elsewhere, null, 'approve', opts).next.approvals?.resultApprovedAt).toBeUndefined()
  })

  test('the runaway question: "continue" (in either language) is its first answer, so the pause ends', () => {
    const runaway = plan({}, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: RUNAWAY_REASON }, guard: { blocksForPlan: 31, blocksInChain: 6, escalated: 'plan' } })
    for (const text of ['continue', 'devam', 'yes continue', 'devam et', 'keep going']) {
      const r = promptInteraction(runaway, detectIntent(text) as 'resume', text, opts)
      expect({ text, state: r.next.interaction?.state, counters: [r.next.guard.blocksForPlan, r.next.guard.blocksInChain] }).toEqual({ text, state: 'running', counters: [0, 0] })
      expect(r.guidance).toContain('chose to continue')
      expect(r.guidance).not.toContain('does not answer it')
    }
    const pivot = promptInteraction(runaway, null, 'change the approach: mock the API', opts)
    expect(pivot.next).toBe(runaway)
    expect(pivot.guidance).toContain('If this message answers it, act on the answer')
  })

  test('the goal-build hand-back: "continue" (in either language) asks for one more round, so the pause ends', () => {
    const handback = plan({ type: 'Build', phase: 'verify' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'build hand-back: round limit' }, guard: { blocksForPlan: 4, blocksInChain: 2 } })
    for (const text of ['continue', 'devam', 'go on', 'devam et']) {
      const r = promptInteraction(handback, detectIntent(text) as 'resume', text, opts)
      expect({ text, state: r.next.interaction?.state, counters: [r.next.guard.blocksForPlan, r.next.guard.blocksInChain] }).toEqual({ text, state: 'running', counters: [0, 0] })
      expect(r.guidance).toContain('buracle flow start goal-build')
      expect(r.guidance).not.toContain('does not answer it')
    }
    const blocked = plan({ type: 'Build' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'Build hand-back: blocked (the staging database is down)' } })
    expect(promptInteraction(blocked, 'resume', 'continue', opts).next.interaction).toEqual({ state: 'running', since: 500 })
    const question = plan({ type: 'Build' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'which test runner?' } })
    const q = promptInteraction(question, 'resume', 'continue', opts)
    expect(q.next).toBe(question)
    expect(q.guidance).toContain('"continue" alone does not answer it')
  })

  test('the model-switch pause (plan.modelSwitch manual): "continue" after the user switched models resumes the implementation', () => {
    const held = plan({ status: 'APPROVED', phase: 'implement' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: `${MODEL_SWITCH_REASON} switch to the implementation model, then say continue` } })
    for (const text of ['continue', 'devam', 'go on', 'devam et']) {
      const r = promptInteraction(held, detectIntent(text) as 'resume', text, opts)
      expect({ text, state: r.next.interaction?.state }).toEqual({ text, state: 'running' })
      expect(r.guidance).toContain('after the model switch')
      expect(r.guidance).not.toContain('does not answer it')
    }
    const chat = promptInteraction(held, null, 'which model do you suggest?', opts)
    expect(chat.next).toBe(held)
    expect(chat.guidance).toContain('switch models')
    const manual = plan({}, { interaction: { state: 'paused', kind: 'manual', since: 5, reason: `${MODEL_SWITCH_REASON} log in again` } })
    expect(promptInteraction(manual, 'resume', 'continue', opts).next).toBe(manual)
  })

  test('an approval typed during an early "result review" pause is not recorded before COMPLETE', () => {
    const early = plan({ status: 'IN_PROGRESS', phase: 'implement' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'result review' } })
    const r = promptInteraction(early, null, 'lgtm', opts)
    expect(r.resultApproved).toBeUndefined()
    expect(r.next).toBe(early)
    expect(r.guidance).toContain('paused on the result review')
    const build = plan({ type: 'Build', status: 'COMPLETE', phase: 'verify' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'result review' } })
    expect(promptInteraction(build, null, 'approve', opts).next.approvals?.resultApprovedAt).toBeUndefined()
  })

  test('a reply while paused gets the paused-reply guidance and leaves the pause alone', () => {
    const manual = plan({}, { interaction: { state: 'paused', kind: 'manual', since: 5, reason: 'rotate the key' } })
    const r = promptInteraction(manual, null, 'done', { autoPause: true, now: 9 })
    expect(r.next).toBe(manual)
    expect(r.guidance).toContain('reports the manual step ("rotate the key") done')
  })

  test('plan.autoPause pauses a running plan on any other message', () => {
    const r = promptInteraction(plan(), null, 'also add a README line', { autoPause: true, now: 7 })
    expect(r.autoPaused).toBe(true)
    expect(r.next.interaction).toEqual({ state: 'paused', kind: 'discussion', since: 7, reason: AUTO_PAUSE_REASON })
    expect(r.guidance).toBe(CONTROL_GUIDANCE.autoPause)
    expect(promptInteraction(plan(), null, 'hi', opts).next.interaction).toBeUndefined()
    const done = plan({ status: 'VERIFIED', phase: 'done' })
    expect(promptInteraction(done, null, 'hi', { autoPause: true, now: 7 }).next).toBe(done)
  })
})

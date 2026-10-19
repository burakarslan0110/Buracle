import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StopInput } from '../../../src/core/events'
import { defaultConfig } from '../../../src/core/config'
import type { BuracleConfig } from '../../../src/core/config'
import type { Finding, PlanType } from '../../../src/core/plan/format'
import { planSkeleton, validatePlan } from '../../../src/core/plan/format'
import type { SessionState, StopWhy } from '../../../src/core/plan/state'
import {
  AUTO_PAUSE_REASON, ROUTE_AUDIT_AFTER, STOP_GUARD_ESCAPE, STOP_REASON_MAX, answerReceipt, applyIntent, approveResult, asksUserQuestion, dropResultApproval, emptyState,
  planProgressed, planValidateVerdict, resultReviewable, resumePlan, routeAuditAllowed, stopGuardVerdict, stopVerdict, stopVerdictDetailed,
} from '../../../src/core/plan/state'
import { preApprovalEdit, readOnlyStartNotice } from '../../../src/core/plan/plan-mode'
import { HANDBACK_REASON, RUNAWAY_REASON, VERIFICATION_OFF_REASON } from '../../../src/core/policy/intents'
import { freshState } from '../../../src/workflow/session-store'
import * as paths from '../../../src/engine/paths'

const CFG: BuracleConfig['plan'] = defaultConfig().plan
const input = (over: Partial<StopInput> = {}): StopInput => ({ harness: 'claude', sessionId: 's1', cwd: '/repo', now: 1000, ...over })
function withPlan(over: Partial<NonNullable<SessionState['plan']>> = {}, rest: Partial<SessionState> = {}): SessionState {
  return { ...emptyState(), plan: { path: 'docs/plans/2026-10-08-rate-limit.md', slug: 'rate-limit', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1, ...over }, ...rest }
}

describe('emptyState', () => {
  test('deep-equals the session store fresh state and is a new object each time', () => {
    expect(emptyState()).toEqual(freshState())
    expect(emptyState()).toEqual({ v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 } })
    expect(emptyState()).not.toBe(emptyState())
  })
})

describe('the escape sentence', () => {
  test('is copied verbatim from rules/always/core.md and the spec, build and buracle skills', () => {
    const canon = paths.canonicalDir()
    for (const file of ['rules/always/core.md', 'skills/plan-build/SKILL.md', 'skills/goal-build/SKILL.md', 'skills/buracle/SKILL.md']) {
      expect(readFileSync(join(canon, file), 'utf8')).toContain(STOP_GUARD_ESCAPE)
    }
  })

  test('names the English stop words and defers other languages to the prompt hook', () => {
    expect(STOP_GUARD_ESCAPE).toBe('The only way out is a pause: `buracle plan pause` (before a real question or a hand-back), or the user saying "stop", "wait" or "hold on" (or the same in their language), which Buracle records as a pause (run `buracle plan pause --kind discussion` too).')
  })
})

describe('stopVerdict (H08): releases', () => {
  const released = (state: SessionState, inp: StopInput = input(), cfg = CFG) => stopVerdictDetailed(state, inp, cfg)

  test('guard disabled', () => {
    const r = released(withPlan(), input(), { ...CFG, stopGuard: false })
    expect([r.decision.action, r.why]).toEqual(['allow', 'disabled'])
  })

  test('no plan bound', () => {
    expect(released(emptyState()).why).toBe('no-plan')
  })

  test('finished plans: VERIFIED, SAVED, phase done', () => {
    expect(released(withPlan({ status: 'VERIFIED' })).why).toBe('finished')
    expect(released(withPlan({ status: 'SAVED', type: 'Plan' })).why).toBe('finished')
    expect(released(withPlan({ phase: 'done', status: 'COMPLETE' })).why).toBe('finished')
  })

  test('paused, whatever the kind', () => {
    for (const kind of ['discussion', 'decision', 'manual'] as const) {
      expect(released(withPlan({}, { interaction: { state: 'paused', kind, since: 5 } })).why).toBe('paused')
    }
    expect(released(withPlan({}, { interaction: { state: 'running', since: 5 } })).why).toBe('blocked')
  })

  test('awaiting approval: phase plan, not approved, approval on', () => {
    expect(released(withPlan({ phase: 'plan', status: 'PENDING' })).why).toBe('awaiting-approval')
    expect(released(withPlan({ phase: 'plan', status: 'APPROVED' })).why).toBe('blocked')
    expect(released(withPlan({ phase: 'plan', status: 'PENDING' }, { approvals: { planApprovedAt: 9 } })).why).toBe('blocked')
    const off = released(withPlan({ phase: 'plan', status: 'PENDING' }), input(), { ...CFG, planApproval: false })
    expect(off.why).toBe('blocked')
    expect(off.decision.action === 'block' ? off.decision.reason : '').toContain('buracle plan set approved true')
    expect(released(withPlan({ phase: 'plan', status: 'PENDING', type: 'Build' })).why).toBe('blocked')
  })

  test('a direct question to the user in the plan phase', () => {
    const plan = withPlan({ phase: 'plan', status: 'APPROVED' })
    expect(released(plan, input({ lastMessage: 'Plan hazır.\n\nOnaylıyor musun?' })).why).toBe('question')
    expect(released(plan, input({ lastMessage: 'Which option do you prefer?\n1. A\n2. B' })).why).toBe('question')
    expect(released(plan, input({ lastMessage: 'Done with the plan.' })).why).toBe('blocked')
    expect(released(withPlan(), input({ lastMessage: 'Should I continue?' })).why).toBe('blocked')
  })

  test('runaway caps hold the turn once to escalate, then release and say which one', () => {
    const perPlan = released(withPlan({}, { guard: { blocksForPlan: 30, blocksInChain: 0 } }))
    expect([perPlan.decision.action, perPlan.why]).toEqual(['block', 'runaway-escalate'])
    expect(perPlan.next.guard.escalated).toBe('plan')
    const planRelease = released(perPlan.next)
    expect([planRelease.decision.action, planRelease.why]).toEqual(['allow', 'runaway-plan'])
    const perChain = released(withPlan({}, { guard: { blocksForPlan: 3, blocksInChain: 5, escalated: 'chain' } }), input({ hookActive: true }))
    expect([perChain.decision.action, perChain.why]).toEqual(['allow', 'runaway-chain'])
    expect(perChain.next.guard).toEqual({ blocksForPlan: 3, blocksInChain: 0, escalated: 'chain' })
  })
})

describe('stopVerdict (H08): blocking', () => {
  test('the reason names the plan, status, phase and the escape sentence, and starts with the guard marker', () => {
    const { decision } = stopVerdict(withPlan(), input(), CFG)
    expect(decision.action).toBe('block')
    if (decision.action !== 'block') return
    expect(decision.hook).toBe('H08')
    expect(decision.reason).toStartWith('Buracle stop guard:')
    for (const part of ['docs/plans/2026-10-08-rate-limit.md', 'IN_PROGRESS', 'phase implement', STOP_GUARD_ESCAPE]) expect(decision.reason).toContain(part)
  })

  test('the next step depends on status and phase', () => {
    const reason = (s: SessionState): string => { const d = stopVerdict(s, input(), CFG).decision; return d.action === 'block' ? d.reason : '' }
    expect(reason(withPlan({ status: 'APPROVED' }))).toContain('next unticked task')
    expect(reason(withPlan({ status: 'COMPLETE', phase: 'verify' }))).toContain('buracle plan verify')
    expect(reason(withPlan({ status: 'APPROVED', phase: 'plan' }))).toContain('buracle plan set phase implement')
    expect(reason(withPlan({ type: 'Build' }))).toContain('build round')
    expect(reason(withPlan({ type: 'Build', status: 'COMPLETE' }))).toContain('judge')
  })

  test('counters: a block increments both and records the time; an allow resets the chain only', () => {
    const b = stopVerdict(withPlan(), input({ now: 4242 }), CFG)
    expect(b.next.guard).toEqual({ blocksForPlan: 1, blocksInChain: 1, lastBlockAt: 4242 })
    const a = stopVerdict({ ...b.next, interaction: { state: 'paused', since: 1 } }, input(), CFG)
    expect(a.decision.action).toBe('allow')
    expect(a.next.guard).toEqual({ blocksForPlan: 1, blocksInChain: 0, lastBlockAt: 4242 })
  })

  test('hookActive counts toward the chain; a fresh stop starts a new chain', () => {
    let s = withPlan()
    const steps: string[] = []
    for (let i = 0; i < 7; i++) {
      const r = stopVerdictDetailed(s, input({ hookActive: i > 0, now: i }), CFG)
      steps.push(r.why)
      s = r.next
    }
    expect(steps).toEqual(['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'runaway-escalate', 'runaway-chain'])
    const after = stopVerdictDetailed(s, input({ hookActive: false, now: 9 }), CFG)
    expect([after.why, after.next.guard.escalated]).toEqual(['blocked', undefined])
    expect(stopVerdict(withPlan(), input({ hookActive: true }), CFG).next.guard.blocksInChain).toBe(2)
    const stale = withPlan({}, { guard: { blocksForPlan: 4, blocksInChain: 4 } })
    expect(stopVerdict(stale, input({ hookActive: false }), CFG).next.guard).toEqual({ blocksForPlan: 5, blocksInChain: 1, lastBlockAt: 1000 })
    expect(stopVerdict(stale, input(), CFG).next.guard.blocksInChain).toBe(5)
  })

  test('the per-plan cap counts across chains', () => {
    const cfg = { ...CFG, runaway: { perPlan: 3, perChain: 10 } }
    let s = withPlan()
    const whys: string[] = []
    for (let i = 0; i < 5; i++) { const r = stopVerdictDetailed(s, input({ hookActive: false }), cfg); whys.push(r.why); s = r.next }
    expect(whys).toEqual(['blocked', 'blocked', 'blocked', 'runaway-escalate', 'runaway-plan'])
  })

  test('does not mutate the input state and survives a malformed guard', () => {
    const s = withPlan()
    const copy = JSON.parse(JSON.stringify(s)) as SessionState
    stopVerdict(s, input(), CFG)
    expect(s).toEqual(copy)
    const broken = { ...withPlan(), guard: { blocksForPlan: Number.NaN, blocksInChain: -3 } } as SessionState
    expect(stopVerdict(broken, input(), CFG).next.guard).toEqual({ blocksForPlan: 1, blocksInChain: 1, lastBlockAt: 1000 })
  })
})

describe('asksUserQuestion', () => {
  test('recognizes questions near the end of the message, ignoring code', () => {
    expect(asksUserQuestion('Ready?')).toBe(true)
    expect(asksUserQuestion('Hangisini tercih edersin?\n- A\n- B')).toBe(true)
    expect(asksUserQuestion('**Onaylıyor musun?**')).toBe(true)
    expect(asksUserQuestion('Please choose one of the options above')).toBe(true)
    expect(asksUserQuestion('Done.\n```\nwhy?\n```')).toBe(false)
    expect(asksUserQuestion('All tests pass.')).toBe(false)
    expect(asksUserQuestion(undefined)).toBe(false)
  })

  test('recognizes an approval or choice request without a question mark, in English or Turkish', () => {
    expect(asksUserQuestion('The plan is ready.\nDo you approve')).toBe(true)
    expect(asksUserQuestion('Two options above.\nWhich one would you like')).toBe(true)
    expect(asksUserQuestion('Plan hazır.\nOnaylıyor musun')).toBe(true)
    expect(asksUserQuestion('Hangisini seçersin')).toBe(true)
    expect(asksUserQuestion('The plan was approved earlier.')).toBe(false)
  })
})

describe('planValidateVerdict (H11)', () => {
  const planning = withPlan({ phase: 'plan', status: 'PENDING' })
  const err = (message: string, line?: number): Finding => (line === undefined ? { level: 'error', code: 'x', message } : { level: 'error', code: 'x', message, line })

  test('blocks while the plan file is missing', () => {
    const d = planValidateVerdict(planning, false, [])
    expect(d.action).toBe('block')
    if (d.action !== 'block') return
    expect(d.hook).toBe('H11')
    expect(d.reason).toStartWith('Buracle plan check:')
    expect(d.reason).toContain('does not exist')
    expect(d.reason).toContain(STOP_GUARD_ESCAPE)
  })

  test('blocks on errors, listing at most three; warnings and info do not block', () => {
    const d = planValidateVerdict(planning, true, [err('a', 3), err('b'), { level: 'warning', code: 'w', message: 'ignored' }, err('c'), err('d')])
    expect(d.action).toBe('block')
    if (d.action !== 'block') return
    expect(d.reason).toContain('4 errors')
    expect(d.reason).toContain('1) line 3: a')
    expect(d.reason).toContain('3) c')
    expect(d.reason).toContain('and 1 more')
    expect(d.reason).not.toContain('ignored')
    expect(d.reason).toContain('buracle plan validate docs/plans/2026-10-08-rate-limit.md --strict')
    expect(planValidateVerdict(planning, true, [{ level: 'warning', code: 'w', message: 'm' }])).toEqual({ action: 'allow' })
  })

  test('allows outside the planning phase, without a plan, when finished or paused', () => {
    expect(planValidateVerdict(emptyState(), false, [])).toEqual({ action: 'allow' })
    expect(planValidateVerdict(withPlan(), false, [err('x')])).toEqual({ action: 'allow' })
    expect(planValidateVerdict(withPlan({ phase: 'plan', status: 'SAVED', type: 'Plan' }), false, [])).toEqual({ action: 'allow' })
    for (const kind of ['discussion', 'decision', 'manual'] as const) {
      expect(planValidateVerdict({ ...planning, interaction: { state: 'paused', kind, since: 1 } }, false, [])).toEqual({ action: 'allow' })
    }
  })
})

describe('applyIntent', () => {
  test('pause records a user hold on an active plan', () => {
    const s = applyIntent(withPlan(), 'pause', 77)
    expect(s.interaction).toEqual({ state: 'paused', kind: 'discussion', since: 77, reason: 'the user asked to stop' })
    expect(stopVerdict(s, input(), CFG).decision.action).toBe('allow')
  })

  test('pause is idempotent and keeps an existing pause (kind, time, reason)', () => {
    const paused = withPlan({}, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'plan approval' } })
    expect(applyIntent(paused, 'pause', 99)).toBe(paused)
    expect(applyIntent(applyIntent(withPlan(), 'pause', 1), 'pause', 2).interaction?.since).toBe(1)
  })

  test('stop pauses too and never drops the plan', () => {
    const s = applyIntent(withPlan(), 'stop', 3)
    expect(s.plan).toBeDefined()
    expect(s.interaction?.state).toBe('paused')
    expect(s.interaction?.reason).toContain('cancel')
  })

  test('resume ends a discussion pause and restarts the runaway budget; a no-op when running', () => {
    const paused = withPlan({}, { interaction: { state: 'paused', kind: 'discussion', since: 5 }, guard: { blocksForPlan: 30, blocksInChain: 2, lastBlockAt: 4, escalated: 'plan' } })
    const r = applyIntent(paused, 'resume', 9)
    expect(r.interaction).toEqual({ state: 'running', since: 9 })
    expect(r.guard).toEqual({ blocksForPlan: 0, blocksInChain: 0, lastBlockAt: 4 })
    const running = withPlan()
    expect(applyIntent(running, 'resume', 9)).toBe(running)
  })

  test('a resume word keeps a decision or manual pause: it answers neither (the CLI resume still ends any pause)', () => {
    for (const kind of ['decision', 'manual'] as const) {
      const held = withPlan({}, { interaction: { state: 'paused', kind, since: 5, reason: 'merge decision' } })
      expect(applyIntent(held, 'resume', 9)).toBe(held)
      expect(stopVerdict(held, input(), CFG).decision.action).toBe('allow')
      expect(resumePlan(held, 9).interaction).toEqual({ state: 'running', since: 9 })
    }
  })

  test('a resume word answers the runaway question: the escalation\'s own pause ends and the budget restarts', () => {
    const escalated = stopVerdictDetailed(withPlan({}, { guard: { blocksForPlan: 30, blocksInChain: 0 } }), input(), CFG)
    const reason = escalated.decision.action === 'block' ? escalated.decision.reason : ''
    expect(reason).toContain(`buracle plan pause --kind decision --reason "${RUNAWAY_REASON}"`)
    const held = { ...escalated.next, interaction: { state: 'paused' as const, kind: 'decision' as const, since: 5, reason: RUNAWAY_REASON } }
    const r = applyIntent(held, 'resume', 9)
    expect(r.interaction).toEqual({ state: 'running', since: 9 })
    expect([r.guard.blocksForPlan, r.guard.blocksInChain, r.guard.escalated]).toEqual([0, 0, undefined])
    const other = withPlan({}, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: 'merge decision' } })
    expect(applyIntent(other, 'resume', 9)).toBe(other)
  })

  test('a resume word answers the goal-build hand-back (HANDBACK_REASON); a manual step with the same words still holds', () => {
    const handback = withPlan({ type: 'Build' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: `${HANDBACK_REASON} not achievable` }, guard: { blocksForPlan: 3, blocksInChain: 1 } })
    const r = applyIntent(handback, 'resume', 9)
    expect(r.interaction).toEqual({ state: 'running', since: 9 })
    expect([r.guard.blocksForPlan, r.guard.blocksInChain]).toEqual([0, 0])
    const manual = withPlan({ type: 'Build' }, { interaction: { state: 'paused', kind: 'manual', since: 5, reason: `${HANDBACK_REASON} restart the VPN` } })
    expect(applyIntent(manual, 'resume', 9)).toBe(manual)
  })

  test('history, null, no plan and finished plans leave the state unchanged', () => {
    const s = withPlan()
    expect(applyIntent(s, 'history', 1)).toBe(s)
    expect(applyIntent(s, null, 1)).toBe(s)
    const none = emptyState()
    expect(applyIntent(none, 'pause', 1)).toBe(none)
    const done = withPlan({ status: 'VERIFIED' })
    expect(applyIntent(done, 'pause', 1)).toBe(done)
  })
})

describe('stopGuardVerdict (H08 + H11 in one Stop handler)', () => {
  const planning = withPlan({ phase: 'plan', status: 'PENDING' })
  const bad: Finding[] = [{ level: 'error', code: 'missing-objective', message: 'Task 1 needs an **Objective:** line', line: 12 }]

  test('an invalid plan blocks with H11 even while H08 would wait for approval or a question', () => {
    const r = stopGuardVerdict(planning, input(), CFG, { exists: true, findings: bad })
    expect([r.decision.action, r.why]).toEqual(['block', 'plan-invalid'])
    expect(r.decision.action === 'block' ? r.decision.hook : '').toBe('H11')
    expect(r.next.guard).toEqual({ blocksForPlan: 1, blocksInChain: 1, lastBlockAt: 1000 })
    const q = stopGuardVerdict(planning, input({ lastMessage: 'Onaylıyor musun?' }), CFG, { exists: true, findings: bad })
    expect(q.why).toBe('plan-invalid')
  })

  test('a valid plan leaves the decision to H08', () => {
    expect(stopGuardVerdict(planning, input(), CFG, { exists: true, findings: [] }).why).toBe('awaiting-approval')
    expect(stopGuardVerdict(withPlan(), input(), CFG, { exists: true, findings: bad }).why).toBe('blocked')
    expect(stopGuardVerdict(withPlan(), input(), CFG).why).toBe('blocked')
  })

  test('shared releases and caps release both hooks', () => {
    expect(stopGuardVerdict({ ...planning, interaction: { state: 'paused', since: 1 } }, input(), CFG, { exists: false, findings: [] }).why).toBe('paused')
    expect(stopGuardVerdict(planning, input(), { ...CFG, stopGuard: false }, { exists: false, findings: [] }).why).toBe('disabled')
    const capped = { ...planning, guard: { blocksForPlan: 1, blocksInChain: 5 } }
    expect(stopGuardVerdict(capped, input({ hookActive: true }), CFG, { exists: false, findings: [] }).why).toBe('runaway-chain')
    const cappedRunning = withPlan({}, { guard: { blocksForPlan: 1, blocksInChain: 5 } })
    expect(stopGuardVerdict(cappedRunning, input({ hookActive: true }), CFG, { exists: true, findings: [] }).why).toBe('runaway-escalate')
  })
})

describe('routeAuditAllowed (H23 after the stop guard)', () => {
  const every: StopWhy[] = ['disabled', 'no-plan', 'finished', 'paused', 'awaiting-approval', 'question', 'runaway-plan', 'runaway-chain', 'blocked', 'plan-invalid', 'background-wait', 'read-only-mode', 'runaway-escalate', 'decision-answered']

  test('only after no plan, a finished plan or a disabled guard; never after a pause, a wait for the user or a runaway release', () => {
    expect(every.filter(why => routeAuditAllowed(why, 'enforce'))).toEqual(['disabled', 'no-plan', 'finished'])
    expect([...ROUTE_AUDIT_AFTER].sort()).toEqual(['disabled', 'finished', 'no-plan'])
    expect(every.filter(why => routeAuditAllowed(why, 'nudge'))).toEqual(['disabled', 'no-plan', 'finished'])
  })

  test('routing.strictness off never audits; a guard that could not decide (no why) never audits', () => {
    expect(every.filter(why => routeAuditAllowed(why, 'off'))).toEqual([])
    expect(routeAuditAllowed(undefined, 'enforce')).toBe(false)
  })

  test('agrees with the stop guard: a user pause releases the stop without an audit, a finished plan with one', () => {
    const paused = applyIntent(withPlan(), 'pause', 5)
    expect(routeAuditAllowed(stopGuardVerdict(paused, input(), CFG).why, 'enforce')).toBe(false)
    expect(routeAuditAllowed(stopGuardVerdict(withPlan({ status: 'VERIFIED' }), input(), CFG).why, 'enforce')).toBe(true)
    expect(routeAuditAllowed(stopGuardVerdict(emptyState(), input(), CFG).why, 'enforce')).toBe(true)
  })
})

describe('AUTO_PAUSE_REASON', () => {
  test('is the one pause reason plan.autoPause records on every harness, in English', () => {
    expect(AUTO_PAUSE_REASON).toBe('the user sent a message while the plan was running (plan.autoPause)')
  })
})

describe('H11 holds an unfilled plan skeleton', () => {
  for (const type of ['Feature', 'Bugfix', 'Build'] as PlanType[]) {
    test(`${type}: the skeleton blocks with H11, the filled plan does not`, () => {
      const state = withPlan({ phase: 'plan', status: 'PENDING', type })
      const skeleton = planSkeleton({ type, title: 'Rate limit', created: '2026-10-08' })
      const r = stopGuardVerdict(state, input({ lastMessage: 'Done for now.' }), CFG, { exists: true, findings: validatePlan(skeleton) })
      expect([r.decision.action, r.why]).toEqual(['block', 'plan-invalid'])
      expect(r.decision.action === 'block' ? r.decision.hook : '').toBe('H11')
      expect(r.decision.action === 'block' ? r.decision.reason : '').toContain('still unfilled')
      const q = stopGuardVerdict(state, input({ lastMessage: 'Onaylıyor musun?' }), CFG, { exists: true, findings: validatePlan(skeleton) })
      expect(q.why).toBe('plan-invalid')
      const filled = skeleton.replace(/<!--[\s\S]*?-->/g, 'Filled in.').replace(/(Create|Test|Modify): Filled in\./g, '$1: `src/x.ts`')
      const ok = stopGuardVerdict(state, input({ lastMessage: 'Done for now.' }), CFG, { exists: true, findings: validatePlan(filled) })
      expect(ok.why).toBe(type === 'Build' ? 'blocked' : 'awaiting-approval')
    })
  }
})

function featurePlan(ticked: number[], goal = 'API clients get at most 100 requests per minute per key.'): string {
  const cards = [1, 2, 3].map(n => `### Task ${n}: step ${n}\n**Objective:** do ${n}\n**Files:**\n- Modify: \`src/x${n}.ts\`\n**Definition of Done:**\n- works\n- Verify: \`bun test\`\n\n- [${ticked.includes(n) ? 'x' : ' '}] Task ${n} done\n`).join('\n')
  return `---\ncreated: 2026-10-08\nstatus: IN_PROGRESS\napproved: true\nworktree: false\ntype: Feature\niterations: 0\n---\n# Rate limit\n\n## Goal\n${goal}\nDone when:\n- the 101st request in a minute returns 429 with Retry-After\n- other keys are unaffected\n\n## Tasks\n\n${cards}`
}

describe('H08 progress: a newly ticked task resets the runaway counters', () => {
  const doc = (ticked: number[]) => ({ exists: true, findings: [] as Finding[], text: featurePlan(ticked) })

  test('a new tick resets both counters and is reported once; the same ticks again are no progress', () => {
    const busy = withPlan({}, { guard: { blocksForPlan: 29, blocksInChain: 4, ticked: [1] } })
    const r = stopGuardVerdict(busy, input({ hookActive: true }), CFG, doc([1, 2]))
    expect([r.why, r.progressed]).toEqual(['blocked', true])
    expect(r.next.guard).toEqual({ blocksForPlan: 1, blocksInChain: 2, lastBlockAt: 1000, ticked: [1, 2] })
    const again = stopGuardVerdict(r.next, input({ hookActive: true }), CFG, doc([1, 2]))
    expect([again.why, again.progressed]).toEqual(['blocked', undefined])
    expect(again.next.guard.blocksForPlan).toBe(2)
    expect(planProgressed(r.next, featurePlan([1, 2]))).toBe(false)
    expect(planProgressed(r.next, featurePlan([1, 2, 3]))).toBe(true)
  })

  test('the ticked set only grows: unticking and ticking a task again is no progress', () => {
    const s = withPlan({}, { guard: { blocksForPlan: 10, blocksInChain: 0, ticked: [1, 2] } })
    const unticked = stopGuardVerdict(s, input(), CFG, doc([1]))
    expect(unticked.next.guard.ticked).toEqual([1, 2])
    const reticked = stopGuardVerdict(unticked.next, input(), CFG, doc([1, 2]))
    expect(reticked.progressed).toBeUndefined()
    expect(reticked.next.guard.blocksForPlan).toBe(12)
  })

  test('the chain counts from the last new tick: three ticks, then five blocks without progress escalate', () => {
    let s = withPlan()
    const whys: string[] = []
    for (let i = 1; i <= 8; i++) {
      const r = stopGuardVerdict(s, input({ hookActive: i > 1, now: i }), CFG, doc(Array.from({ length: Math.min(i, 3) }, (_, k) => k + 1)))
      whys.push(r.why)
      s = r.next
    }
    expect(whys).toEqual(['blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'blocked', 'runaway-escalate', 'runaway-chain'])
  })
})

describe('H08 continuation text: the objective after the marker', () => {
  test('restates the Goal and its Done-when lines between the next step and the escape sentence', () => {
    const r = stopGuardVerdict(withPlan(), input(), CFG, { exists: true, findings: [], text: featurePlan([1]) })
    const reason = r.decision.action === 'block' ? r.decision.reason : ''
    expect(reason).toStartWith('Buracle stop guard:')
    expect(reason).toContain('Objective: API clients get at most 100 requests per minute per key. Done when: the 101st request in a minute returns 429 with Retry-After; other keys are unaffected.')
    expect(reason.indexOf('keep working')).toBeLessThan(reason.indexOf('Objective:'))
    expect(reason).toEndWith(STOP_GUARD_ESCAPE)
  })

  test('a Bugfix restates its Behavior Contract, Expected first; a Build its open criteria first', () => {
    const bug = '---\ncreated: 2026-10-08\nstatus: IN_PROGRESS\napproved: true\nworktree: false\ntype: Bugfix\niterations: 0\n---\n# Total\n\n## Behavior Contract\n- **Given:** an invoice with two lines\n- **When:** GET /invoices/42/total\n- **Actual:** 20.00\n- **Expected:** 35.00\n- **Unchanged:** single-line totals (tests/total.test.ts)\n\n## Tasks\n'
    const b = stopGuardVerdict(withPlan({ type: 'Bugfix' }), input(), CFG, { exists: true, findings: [], text: bug })
    expect(b.decision.action === 'block' ? b.decision.reason : '').toContain('Behavior contract: Expected: 35.00; Unchanged: single-line totals (tests/total.test.ts); Actual: 20.00')
    const build = '---\ncreated: 2026-10-08\nstatus: IN_PROGRESS\napproved: true\nworktree: false\ntype: Build\nrounds: 0\n---\n# Port\n\n## Goal\nThe CLI runs on Windows.\n\n## Acceptance Criteria\n| # | Criterion | Evidence | Status |\n|---|---|---|---|\n| C1 | `buracle --help` exits 0 | run it | pass |\n| C2 | the tests pass | bun test | open |\n\n## Tasks\n'
    const d = stopGuardVerdict(withPlan({ type: 'Build' }), input(), CFG, { exists: true, findings: [], text: build })
    expect(d.decision.action === 'block' ? d.decision.reason : '').toContain('Objective: The CLI runs on Windows. Acceptance criteria: C2 the tests pass (open); C1 buracle --help exits 0 (pass).')
  })

  test('an unfilled skeleton adds nothing, and the whole reason stays within the cap', () => {
    const skeleton = planSkeleton({ type: 'Feature', title: 'X', created: '2026-10-08' })
    const r = stopGuardVerdict(withPlan(), input(), CFG, { exists: true, findings: [], text: skeleton })
    expect(r.decision.action === 'block' ? r.decision.reason : '').not.toContain('Objective:')
    const long = stopGuardVerdict(withPlan(), input(), CFG, { exists: true, findings: [], text: featurePlan([], 'word '.repeat(400)) })
    const text = long.decision.action === 'block' ? long.decision.reason : ''
    expect(text.length).toBeLessThanOrEqual(STOP_REASON_MAX)
    expect(text).toContain(STOP_GUARD_ESCAPE)
  })
})

describe('H08 releases without counting: read-only plan mode and a background wait (Claude)', () => {
  test('read-only mode lets the turn end and resets the chain only', () => {
    const r = stopVerdictDetailed(withPlan({}, { guard: { blocksForPlan: 4, blocksInChain: 3 } }), input({ readOnly: true, hookActive: true }), CFG)
    expect([r.decision.action, r.why, r.readOnlyNotice]).toEqual(['allow', 'read-only-mode', true])
    expect(r.next.guard).toEqual({ blocksForPlan: 4, blocksInChain: 0, readOnlyNoticed: true })
    expect(stopVerdictDetailed(withPlan({ status: 'VERIFIED' }), input({ readOnly: true }), CFG).why).toBe('finished')
  })

  test('the read-only notice comes once per pause-free run: again after the next block or a resume', () => {
    const first = stopVerdictDetailed(withPlan(), input({ readOnly: true }), CFG)
    expect(first.readOnlyNotice).toBe(true)
    const second = stopVerdictDetailed(first.next, input({ readOnly: true }), CFG)
    expect([second.why, second.readOnlyNotice]).toEqual(['read-only-mode', undefined])
    const block = stopVerdictDetailed(second.next, input(), CFG)
    expect([block.why, block.next.guard.readOnlyNoticed]).toEqual(['blocked', undefined])
    expect(stopVerdictDetailed(block.next, input({ readOnly: true }), CFG).readOnlyNotice).toBe(true)
    expect(resumePlan({ ...first.next, interaction: { state: 'paused', kind: 'discussion', since: 1 } }, 5).guard.readOnlyNoticed).toBeUndefined()
  })

  test('read-only mode gives no notice where the stop goes through anyway, and H11 never holds it', () => {
    const awaiting = stopVerdictDetailed(withPlan({ phase: 'plan', status: 'PENDING' }), input({ readOnly: true }), CFG)
    expect([awaiting.why, awaiting.readOnlyNotice]).toEqual(['awaiting-approval', undefined])
    const paused = stopVerdictDetailed(withPlan({}, { interaction: { state: 'paused', kind: 'decision', since: 1, answeredAt: 2 } }), input({ readOnly: true }), CFG)
    expect([paused.why, paused.readOnlyNotice, paused.next.interaction?.answeredAt]).toEqual(['paused', undefined, 2])
    const bad: Finding[] = [{ level: 'error', code: 'missing-objective', message: 'Task 1 needs an **Objective:** line', line: 12 }]
    expect(stopGuardVerdict(withPlan({ phase: 'plan', status: 'PENDING' }), input({ readOnly: true }), CFG, { exists: true, findings: bad }).why).toBe('awaiting-approval')
  })

  test('a background wait lets the turn end without spending budget; the plan phase still waits for approval first', () => {
    const r = stopVerdictDetailed(withPlan({}, { guard: { blocksForPlan: 4, blocksInChain: 3 } }), input({ backgroundWait: true, hookActive: true }), CFG)
    expect([r.decision.action, r.why]).toEqual(['allow', 'background-wait'])
    expect(r.next.guard).toEqual({ blocksForPlan: 4, blocksInChain: 0 })
    expect(stopVerdictDetailed(withPlan({ phase: 'plan', status: 'PENDING' }), input({ backgroundWait: true }), CFG).why).toBe('awaiting-approval')
  })
})

describe('H08 answer receipt: a decision answered in the question tool while the plan stays paused', () => {
  const held = withPlan({}, { interaction: { state: 'paused', kind: 'decision', since: 100, reason: 'merge decision' } })

  test('answerReceipt records only a decision pause, and only after it began', () => {
    expect(answerReceipt(held, 150).interaction).toEqual({ state: 'paused', kind: 'decision', since: 100, reason: 'merge decision', answeredAt: 150 })
    expect(answerReceipt(held, 50)).toBe(held)
    const manual = withPlan({}, { interaction: { state: 'paused', kind: 'manual', since: 1 } })
    expect(answerReceipt(manual, 5)).toBe(manual)
    expect(answerReceipt(withPlan(), 5).interaction).toBeUndefined()
    const done = withPlan({ status: 'VERIFIED' }, { interaction: { state: 'paused', kind: 'decision', since: 1 } })
    expect(answerReceipt(done, 5)).toBe(done)
  })

  test('blocks once with a reminder to act and resume, then lets the paused turn end', () => {
    const r = stopVerdictDetailed(answerReceipt(held, 150), input({ now: 160 }), CFG)
    expect([r.decision.action, r.why]).toEqual(['block', 'decision-answered'])
    const reason = r.decision.action === 'block' ? r.decision.reason : ''
    expect(reason).toStartWith('Buracle stop guard:')
    expect(reason).toContain('(merge decision) was answered in the question tool')
    expect(reason).toContain('run `buracle plan resume`')
    expect(r.next.interaction).toEqual({ state: 'paused', kind: 'decision', since: 100, reason: 'merge decision' })
    expect(r.next.guard.blocksForPlan).toBe(1)
    expect(stopVerdictDetailed(r.next, input(), CFG).why).toBe('paused')
  })

  test('an answer in the plan phase says how to act on an approval or a change request, never to ask for the approval again', () => {
    const asked = answerReceipt(withPlan({ status: 'PENDING', phase: 'plan' }, { interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'plan approval' } }), 2)
    const r = stopVerdictDetailed(asked, input(), CFG)
    const reason = r.decision.action === 'block' ? r.decision.reason : ''
    expect(r.why).toBe('decision-answered')
    expect(reason).not.toContain('ask the user for approval')
    expect(reason).toContain('if the answer approves the plan, run `buracle plan set approved true`, `buracle plan set status APPROVED` and `buracle plan set phase implement`')
    expect(reason).toContain('otherwise fold the answer into the plan')
  })

  test('the result review names approve-result in the reminder', () => {
    const review = answerReceipt(withPlan({ status: 'COMPLETE', phase: 'verify' }, { interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'result review' } }), 2)
    const r = stopVerdictDetailed(review, input(), CFG)
    expect(r.decision.action === 'block' ? r.decision.reason : '').toContain('buracle plan approve-result')
  })
})

describe('H08 for a criteria-only build (plan.goalVerification false)', () => {
  const reason = (s: SessionState, cfg = CFG): string => { const d = stopVerdict(s, input(), cfg).decision; return d.action === 'block' ? d.reason : '' }
  const off = { ...CFG, goalVerification: false }

  test('at COMPLETE and in phase verify the next step is the hand-back pause, not plan verify', () => {
    const complete = reason(withPlan({ type: 'Build', status: 'COMPLETE', phase: 'implement' }), off)
    expect(complete).toContain('judge every acceptance criterion')
    expect(complete).toContain('Verification: disabled (plan.goalVerification)')
    expect(complete).toContain(`buracle plan pause --kind decision --reason "${VERIFICATION_OFF_REASON}"`)
    const verify = reason(withPlan({ type: 'Build', status: 'IN_PROGRESS', phase: 'verify' }), off)
    expect(verify).toContain(VERIFICATION_OFF_REASON)
    expect(verify).not.toContain('`buracle plan verify` when every criterion passes')
    expect(reason(withPlan({ type: 'Build', status: 'IN_PROGRESS', phase: 'verify' }))).toContain('`buracle plan verify` when every criterion passes')
    expect(reason(withPlan({ type: 'Build', status: 'COMPLETE', phase: 'implement' }))).not.toContain('goalVerification')
    expect(reason(withPlan({ status: 'COMPLETE', phase: 'verify' }), off)).not.toContain('goalVerification')
  })

  test('the value locked at the plan approval wins over the live config either way', () => {
    const locked = (goalVerification: boolean) => withPlan({ type: 'Build', status: 'COMPLETE', phase: 'implement' }, { approvals: { planApprovedAt: 1, switches: { goalVerification, changesReview: true } } })
    expect(reason(locked(false))).toContain(VERIFICATION_OFF_REASON)
    expect(reason(locked(true), off)).not.toContain('goalVerification')
  })

  test('the hand-back pause it names lets the turn end, and a "continue" afterwards resumes another round', () => {
    expect(VERIFICATION_OFF_REASON.startsWith(HANDBACK_REASON)).toBe(true)
    const held = withPlan({ type: 'Build', status: 'COMPLETE', phase: 'implement' }, { interaction: { state: 'paused', kind: 'decision', since: 5, reason: VERIFICATION_OFF_REASON } })
    expect(stopVerdictDetailed(held, input(), off).why).toBe('paused')
    expect(applyIntent(held, 'resume', 9).interaction).toEqual({ state: 'running', since: 9 })
  })
})

describe('H08 at COMPLETE: the result review (plan.resultApproval)', () => {
  const reason = (s: SessionState, cfg = CFG): string => { const d = stopVerdict(s, input(), cfg).decision; return d.action === 'block' ? d.reason : '' }

  test('a Feature or Bugfix run is pointed at the review before verify; approved, it goes to the merge and verify', () => {
    for (const type of ['Feature', 'Bugfix'] as const) {
      const text = reason(withPlan({ type, status: 'COMPLETE', phase: 'verify' }))
      expect(text).toContain('buracle plan pause --kind decision --reason "result review"')
      expect(text).toContain('buracle plan approve-result')
    }
    const approved = reason(withPlan({ status: 'COMPLETE', phase: 'verify' }, { approvals: { planApprovedAt: 1, resultApprovedAt: 2 } }))
    expect(approved).toContain('the user approved the result')
    expect(approved).not.toContain('approve-result')
  })

  test('off, or a Build plan: verify directly', () => {
    expect(reason(withPlan({ status: 'COMPLETE', phase: 'verify' }), { ...CFG, resultApproval: false })).not.toContain('result review')
    expect(reason(withPlan({ type: 'Build', status: 'COMPLETE', phase: 'verify' }))).not.toContain('result review')
  })

  test('approveResult records the approval and ends the pause; dropResultApproval removes only that field', () => {
    const paused = withPlan({ status: 'COMPLETE', phase: 'verify' }, { interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'result review' }, approvals: { planApprovedAt: 1 } })
    const a = approveResult(paused, 50)
    expect(a.approvals).toEqual({ planApprovedAt: 1, resultApprovedAt: 50 })
    expect(a.interaction).toEqual({ state: 'running', since: 50 })
    expect(dropResultApproval(a).approvals).toEqual({ planApprovedAt: 1 })
    expect(dropResultApproval({ ...a, approvals: { resultApprovedAt: 50 } }).approvals).toBeUndefined()
    const done = withPlan({ status: 'VERIFIED' })
    expect(approveResult(done, 5)).toBe(done)
  })

  test('only a COMPLETE Feature or Bugfix plan can record a result approval (the same checks as approve-result)', () => {
    const early = withPlan({ status: 'IN_PROGRESS' }, { interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'result review' } })
    expect(resultReviewable(early)).toBe(false)
    expect(approveResult(early, 5)).toBe(early)
    const build = withPlan({ type: 'Build', status: 'COMPLETE', phase: 'verify' })
    expect(approveResult(build, 5)).toBe(build)
    expect(resultReviewable(withPlan({ type: 'Bugfix', status: 'COMPLETE', phase: 'verify' }))).toBe(true)
  })
})

describe('read-only plan modes and edits before approval (HOOKS-WORKFLOW-5)', () => {
  test('a file-writing workflow started in a read-only plan mode gets one notice per harness', () => {
    for (const h of ['claude', 'codex', 'opencode', 'omp'] as const) {
      const text = readOnlyStartNotice('plan-build', h) as string
      expect(text).toContain('plan-build')
      expect(text).toContain('docs/plans/')
      expect(text).toContain('buracle plan init')
    }
    expect(readOnlyStartNotice('goal-build', 'codex')).toContain('docs/builds/')
    expect(readOnlyStartNotice('requirements', 'omp')).toContain('docs/prd/')
    expect(readOnlyStartNotice('bugfix', 'opencode')).toContain('build agent (Tab)')
    expect(readOnlyStartNotice('plan-build', 'claude')).toContain('Shift+Tab')
    for (const w of ['research', 'inspect', 'dead-code', 'nope', '__proto__']) expect(readOnlyStartNotice(w, 'claude')).toBeUndefined()
  })

  const draft = (over: Partial<NonNullable<SessionState['plan']>> = {}, rest: Partial<SessionState> = {}): SessionState => withPlan({ status: 'PENDING', phase: 'plan', ...over }, rest)
  const opts = { cwd: '/repo', planApproval: true }

  test('an edit of another file while the plan waits for approval gets one note per plan', () => {
    const r = preApprovalEdit(draft(), ['src/app.ts'], opts)
    expect(r.note).toContain('src/app.ts')
    expect(r.note).toContain('docs/plans/2026-10-08-rate-limit.md')
    expect(r.note).toContain('approves the plan')
    expect(r.next.guard.earlyEditNoted).toBe(true)
    expect(preApprovalEdit(r.next, ['src/other.ts'], opts)).toEqual({ next: r.next })
    expect(stopVerdictDetailed(r.next, input({ readOnly: true }), CFG).next.guard.earlyEditNoted).toBe(true)
  })

  test('the plan file, docs/plans, docs/builds and docs/prd never trip it', () => {
    for (const f of ['docs/plans/2026-10-08-rate-limit.md', '/repo/docs/plans/2026-10-08-rate-limit.md', './docs/plans/other.md', 'docs/builds/2026-x.md', 'docs/prd/x.md', '/elsewhere/docs/plans/a.md']) {
      expect({ f, r: preApprovalEdit(draft(), [f], opts).note }).toEqual({ f, r: undefined })
    }
    expect(preApprovalEdit(draft(), ['docs/plans/a.md', 'src/b.ts'], opts).note).toContain('src/b.ts')
    expect(preApprovalEdit(draft(), [], opts).note).toBeUndefined()
  })

  test('an approved, implementing, finished or captured plan, or plan approval off, needs no note', () => {
    const cases: SessionState[] = [
      draft({ status: 'APPROVED' }), draft({}, { approvals: { planApprovedAt: 5 } }), draft({ phase: 'implement' }), draft({ status: 'VERIFIED' }),
      draft({ type: 'Plan', status: 'SAVED' }), emptyState(),
    ]
    for (const s of cases) expect(preApprovalEdit(s, ['src/app.ts'], opts).note).toBeUndefined()
    expect(preApprovalEdit(draft(), ['src/app.ts'], { ...opts, planApproval: false }).note).toBeUndefined()
    expect(preApprovalEdit(draft({ type: 'Build' }), ['src/app.ts'], { ...opts, planApproval: false }).note).toContain('run file is locked')
    expect(preApprovalEdit(draft({ type: 'Bugfix' }), ['src/app.ts'], opts).note).toContain('reproducing test')
  })
})

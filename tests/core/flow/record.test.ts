import { describe, expect, test } from 'bun:test'
import type { FlowRecord } from '../../../src/core/flow/record'
import {
  FLOW_MAX_DEPTH, activeFlow, flowBreadcrumb, flowEnd, flowFromPlan, flowPhase, flowStart, flowStep, flowText, parseFlow, planFlowPhase,
} from '../../../src/core/flow/record'

const T = Date.UTC(2026, 9, 9, 10, 0, 0)

function rec(r: { record: FlowRecord }): FlowRecord { return r.record }

describe('flowStart', () => {
  test('a first start records the workflow, its title and source', () => {
    const r = flowStart(undefined, { workflow: 'plan-build', title: 'Rate limit', source: 'command' }, T)
    expect(r.changed).toBe(true)
    expect(r.record).toEqual({ v: 1, stack: [{ workflow: 'plan-build', title: 'Rate limit', source: 'command', startedAt: T }], updatedAt: T })
  })

  test('starting the workflow already on top changes nothing, except a new title', () => {
    const a = rec(flowStart(undefined, { workflow: 'plan-build', source: 'command' }, T))
    const again = flowStart(a, { workflow: 'plan-build', source: 'cli' }, T + 5_000)
    expect(again.changed).toBe(false)
    expect(again.record).toBe(a)
    const titled = flowStart(a, { workflow: 'plan-build', title: 'Login redirect loop', source: 'cli' }, T + 6_000)
    expect(titled.changed).toBe(true)
    expect(activeFlow(titled.record)).toMatchObject({ workflow: 'plan-build', title: 'Login redirect loop', startedAt: T })
  })

  test('the person starting the same workflow again later begins a new run', () => {
    let r = rec(flowStart(undefined, { workflow: 'plan-build', source: 'command' }, T))
    r = rec(flowPhase(r, { phase: 'verify' }, T + 1_000))
    const seenTwice = flowStart(r, { workflow: 'plan-build', source: 'prompt' }, T + 30_000)
    expect(seenTwice.changed).toBe(false)
    const later = rec(flowStart(r, { workflow: 'plan-build', source: 'command' }, T + 10 * 60_000))
    expect(later.stack).toEqual([{ workflow: 'plan-build', source: 'command', startedAt: T + 10 * 60_000 }])
  })

  test('a skill loaded inside a running workflow nests; a top-level or person start begins a new stack', () => {
    let r = rec(flowStart(undefined, { workflow: 'requirements', source: 'command' }, T))
    r = rec(flowStart(r, { workflow: 'research', source: 'skill' }, T + 1))
    expect(flowBreadcrumb(r)).toEqual(['requirements', 'research'])
    expect(flowStart(r, { workflow: 'research', source: 'cli' }, T + 2).changed).toBe(false)
    expect(flowBreadcrumb(rec(flowStart(r, { workflow: 'plan-build', source: 'cli' }, T + 3)))).toEqual(['plan-build'])
    expect(flowBreadcrumb(rec(flowStart(r, { workflow: 'ab-test', source: 'command' }, T + 4)))).toEqual(['ab-test'])
  })

  test('ended entries on top are dropped by the next start; the stack never grows past its depth', () => {
    let r = rec(flowStart(undefined, { workflow: 'requirements', source: 'command' }, T))
    r = rec(flowStart(r, { workflow: 'research', source: 'skill' }, T + 1))
    r = rec(flowEnd(r, 'done', T + 2))
    expect(flowBreadcrumb(r)).toEqual(['requirements'])
    r = rec(flowStart(r, { workflow: 'ab-test', source: 'skill' }, T + 3))
    expect(r.stack.map(e => e.workflow)).toEqual(['requirements', 'ab-test'])
    for (let i = 0; i < 6; i++) r = rec(flowStart(r, { workflow: i % 2 === 0 ? 'research' : 'new-skill', source: 'skill' }, T + 10 + i))
    expect(r.stack).toHaveLength(FLOW_MAX_DEPTH)
  })

  test('an invalid workflow id is refused', () => {
    const r = flowStart(undefined, { workflow: 'Spec!', source: 'cli' }, T)
    expect(r.error?.code).toBe('invalid')
    expect(r.changed).toBe(false)
  })
})

describe('flowPhase, flowStep, flowEnd', () => {
  test('a phase applies to the active entry and clears the previous step', () => {
    let r = rec(flowStart(undefined, { workflow: 'bugfix', source: 'command' }, T))
    r = rec(flowStep(r, { text: 'reading the stack trace' }, T + 1))
    r = rec(flowPhase(r, { phase: 'red', note: 'repro first' }, T + 2))
    expect(activeFlow(r)).toEqual({ workflow: 'bugfix', source: 'command', startedAt: T, phase: { id: 'red', since: T + 2, note: 'repro first' } })
    expect(flowPhase(r, { phase: 'red' }, T + 9).changed).toBe(false)
  })

  test('an unknown phase of a catalogued workflow and a missing workflow are errors', () => {
    const r = rec(flowStart(undefined, { workflow: 'plan-build', source: 'command' }, T))
    expect(flowPhase(r, { phase: 'judge' }, T).error?.code).toBe('invalid')
    expect(flowPhase(undefined, { phase: 'plan' }, T).error?.code).toBe('no_flow')
    expect(flowStep(undefined, { text: 'x' }, T).error?.code).toBe('no_flow')
  })

  test('a step keeps a one-line text and a bounded count', () => {
    let r = rec(flowStart(undefined, { workflow: 'research', source: 'cli' }, T))
    r = rec(flowStep(r, { text: 'Reading\n  the  docs', done: 7, total: 5 }, T + 1))
    expect(activeFlow(r)?.step).toEqual({ text: 'Reading the docs', done: 5, total: 5, at: T + 1 })
    expect(flowStep(r, { text: '   ' }, T + 2).error?.code).toBe('invalid')
    expect(flowText('x'.repeat(200), 10)).toHaveLength(10)
  })

  test('end marks the active entry; with nothing running it changes nothing', () => {
    let r = rec(flowStart(undefined, { workflow: 'dead-code', source: 'command' }, T))
    r = rec(flowEnd(r, 'cancelled', T + 5))
    expect(r.stack[0]?.ended).toEqual({ outcome: 'cancelled', at: T + 5 })
    expect(activeFlow(r)).toBeUndefined()
    expect(flowEnd(r, 'done', T + 6).changed).toBe(false)
  })
})

describe('parseFlow', () => {
  test('reads back what the reducers write and drops malformed entries', () => {
    let r = rec(flowStart(undefined, { workflow: 'plan-build', title: 'T', source: 'command' }, T))
    r = rec(flowPhase(r, { phase: 'plan' }, T + 1))
    r = rec(flowStep(r, { text: 's', done: 1, total: 2 }, T + 2))
    expect(parseFlow(JSON.parse(JSON.stringify(r)))).toEqual(r)
    expect(parseFlow({ v: 1, stack: [{ workflow: 'BAD' }, { workflow: 'bugfix', startedAt: 1, source: 'nope' }], updatedAt: 3 }))
      .toEqual({ v: 1, stack: [{ workflow: 'bugfix', startedAt: 1, source: 'cli' }], updatedAt: 3 })
    for (const bad of [null, 1, 'x', [], { v: 2, stack: [] }, { v: 1 }]) expect(parseFlow(bad)).toBeUndefined()
  })
})

describe('plans drive spec and build', () => {
  test('the phase a plan implies', () => {
    expect(planFlowPhase('plan-build', { status: 'PENDING', phase: 'plan' })).toBe('plan')
    expect(planFlowPhase('plan-build', { status: 'PENDING', phase: 'plan' }, 'approve')).toBe('approve')
    expect(planFlowPhase('plan-build', { status: 'IN_PROGRESS', phase: 'implement' })).toBe('implement')
    expect(planFlowPhase('plan-build', { status: 'COMPLETE', phase: 'verify' })).toBe('verify')
    expect(planFlowPhase('goal-build', { status: 'PENDING', phase: 'plan' })).toBe('contract')
    expect(planFlowPhase('goal-build', { status: 'IN_PROGRESS', phase: 'implement' })).toBe('build')
    expect(planFlowPhase('goal-build', { status: 'COMPLETE', phase: 'implement' })).toBe('judge')
    expect(planFlowPhase('goal-build', { status: 'VERIFIED', phase: 'done' })).toBe('handback')
    expect(planFlowPhase('bugfix', { status: 'PENDING', phase: 'plan' })).toBeUndefined()
  })

  test('a registered plan starts its workflow, follows the plan and ends when it is verified', () => {
    let r = flowFromPlan(undefined, { type: 'Feature', status: 'PENDING', phase: 'plan', title: 'Rate limit' }, T)
    expect(r.changed).toBe(true)
    expect(activeFlow(r.record)).toMatchObject({ workflow: 'plan-build', source: 'plan', title: 'Rate limit', phase: { id: 'plan' } })
    r = flowFromPlan(r.record, { type: 'Feature', status: 'IN_PROGRESS', phase: 'implement' }, T + 1)
    expect(activeFlow(r.record)?.phase?.id).toBe('implement')
    expect(flowFromPlan(r.record, { type: 'Feature', status: 'IN_PROGRESS', phase: 'implement' }, T + 2).changed).toBe(false)
    r = flowFromPlan(r.record, { type: 'Feature', status: 'VERIFIED', phase: 'done' }, T + 3)
    expect(r.record.stack[0]).toMatchObject({ workflow: 'plan-build', phase: { id: 'verify' }, ended: { outcome: 'done', at: T + 3 } })
  })

  test('the plan finds its workflow below a nested one and leaves the nesting alone', () => {
    let r = rec(flowStart(undefined, { workflow: 'goal-build', source: 'command' }, T))
    r = rec(flowStart(r, { workflow: 'research', source: 'skill' }, T + 1))
    r = rec(flowFromPlan(r, { type: 'Build', status: 'IN_PROGRESS', phase: 'implement' }, T + 2))
    expect(r.stack.map(e => [e.workflow, e.phase?.id])).toEqual([['goal-build', 'build'], ['research', undefined]])
  })

  test('a finished or captured plan never starts a flow', () => {
    expect(flowFromPlan(undefined, { type: 'Feature', status: 'VERIFIED', phase: 'done' }, T).changed).toBe(false)
    expect(flowFromPlan(undefined, { type: 'Plan', status: 'SAVED', phase: 'plan' }, T).changed).toBe(false)
  })
})

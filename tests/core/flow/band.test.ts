import { describe, expect, test } from 'bun:test'
import type { BandInput, BandPlan, BandView } from '../../../src/core/flow/band'
import { bandPlanOf, bandRows, bandSummary, bandText, bandView, criteriaOf, resumeSuggestion } from '../../../src/core/flow/band'
import type { FlowRecord } from '../../../src/core/flow/record'
import { flowEnd, flowPhase, flowStart, flowStep } from '../../../src/core/flow/record'
import { emptyState } from '../../../src/core/plan/state'
import { textWidth } from '../../../src/core/status/format'
import { renderPlainLines } from '../../../src/core/status/render'

const T = Date.UTC(2026, 9, 9, 10, 0, 0)
const MIN = 60_000

function flow(workflow: string, phase?: string, opts: { title?: string, step?: string, at?: number } = {}): FlowRecord {
  let r = flowStart(undefined, opts.title !== undefined ? { workflow, title: opts.title, source: 'command' } : { workflow, source: 'command' }, opts.at ?? T).record
  if (phase !== undefined) r = flowPhase(r, { phase }, (opts.at ?? T) + 1).record
  if (opts.step !== undefined) r = flowStep(r, { text: opts.step }, (opts.at ?? T) + 2).record
  return r
}

function plan(over: Partial<BandPlan> = {}): BandPlan {
  return { path: '/repo/docs/plans/p.md', type: 'Feature', status: 'IN_PROGRESS', phase: 'implement', approved: true, since: T, done: 3, total: 7, current: 'Task 4: parser tests', ...over }
}

function view(over: Partial<BandInput>): BandView {
  return bandView({ nowMs: T + 12 * MIN, foldAfterSec: 8, ...over })
}

function states(v: BandView): string {
  return v.phases.map(p => `${p.id}:${p.state}`).join(' ')
}

function lines(v: BandView, columns: number, maxRows = 3): string[] {
  return renderPlainLines(bandRows(v, columns, maxRows, true)).split('\n').filter(l => l !== '')
}

describe('bandView', () => {
  test('nothing running and no plan: hidden', () => {
    expect(view({}).visible).toBe(false)
    expect(bandRows(view({}), 120, 3, true)).toEqual([])
  })

  test('spec moves through its phases with the plan', () => {
    const planning = view({ flow: flow('plan-build', 'plan'), plan: plan({ status: 'PENDING', phase: 'plan', approved: false, done: 0 }) })
    expect(states(planning)).toBe('plan:current approve:next implement:next verify:next')
    expect(planning.status).toBe('running')
    const approval = view({ flow: flow('plan-build', 'approve'), plan: plan({ status: 'PENDING', phase: 'plan', approved: false }) })
    expect(approval.status).toBe('approval')
    const implement = view({ flow: flow('plan-build', 'implement', { title: 'Rate limit' }), plan: plan() })
    expect(states(implement)).toBe('plan:done approve:done implement:current verify:next')
    expect(implement).toMatchObject({ visible: true, workflow: 'plan-build', breadcrumb: ['plan-build'], title: 'Rate limit', progress: { done: 3, total: 7, unit: 'tasks' }, current: 'Task 4: parser tests', elapsedMin: 12 })
    const verify = view({ flow: flow('plan-build', 'verify'), plan: plan({ status: 'COMPLETE', phase: 'verify', done: 7 }) })
    expect(states(verify)).toBe('plan:done approve:done implement:done verify:current')
  })

  test('an ended run shows as done for foldAfterSec, then folds', () => {
    const ended = flowEnd(flow('plan-build', 'verify'), 'done', T + 10 * MIN).record
    const shown = bandView({ nowMs: T + 10 * MIN + 7_999, foldAfterSec: 8, flow: ended })
    expect(shown.status).toBe('done')
    expect(shown.phases.every(p => p.state === 'done')).toBe(true)
    expect(shown.endedAt).toBe(T + 10 * MIN)
    expect(bandView({ nowMs: T + 10 * MIN + 8_000, foldAfterSec: 8, flow: ended }).visible).toBe(false)
    expect(bandView({ nowMs: T + 10 * MIN + 8_000, foldAfterSec: 8, flow: ended, plan: plan() }).visible).toBe(false)
    const failed = bandView({ nowMs: T + 10 * MIN, foldAfterSec: 8, flow: flowEnd(flow('bugfix', 'prove'), 'failed', T + 10 * MIN).record })
    expect(failed.status).toBe('failed')
    expect(states(failed)).toBe('investigate:done red:done fix:done prove:current gate:next finish:next')
  })

  test('build at round 2 shows the round and the acceptance criteria', () => {
    const p = plan({ type: 'Build', status: 'COMPLETE', phase: 'implement', done: 5, total: 5, rounds: 1, criteria: [
      { id: 'C1', status: 'pass', oracle: false }, { id: 'C2', status: 'fail', oracle: false }, { id: 'C3', status: 'open', oracle: false }, { id: 'C4', status: 'open', oracle: true },
    ] })
    const v = view({ flow: flow('goal-build', 'judge'), plan: p })
    expect(v).toMatchObject({ round: 2, progress: { done: 1, total: 4, unit: 'criteria' } })
    const wide = lines(v, 140).join('\n')
    expect(wide).toContain('R2/4')
    expect(wide).toContain('C1✓ C2✗ C3○ C4★○')
  })

  test('fix takes its phases from the flow record alone', () => {
    const v = view({ flow: flow('bugfix', 'gate', { step: 'bun test' }) })
    expect(states(v)).toBe('investigate:done red:done fix:done prove:done gate:current finish:next')
    expect(v.current).toBe('bun test')
    expect(lines(v, 120).join('\n')).toContain('● Quality gate')
  })

  test('a pause for a decision reads as waiting for the person, with the reason', () => {
    const v = view({ flow: flow('plan-build', 'implement'), plan: plan(), interaction: { state: 'paused', kind: 'decision', reason: 'Redis or in-memory?' } })
    expect(v.status).toBe('waiting')
    expect(v.note).toBe('Redis or in-memory?')
    expect(lines(v, 120).join('\n')).toContain('waiting for you: Redis or in-memory?')
    expect(view({ flow: flow('plan-build', 'implement'), interaction: { state: 'paused', kind: 'discussion' } }).status).toBe('paused')
  })

  test('a nested run shows its breadcrumb', () => {
    let r = flowStart(undefined, { workflow: 'requirements', source: 'command' }, T).record
    r = flowPhase(r, { phase: 'research' }, T + 1).record
    r = flowStart(r, { workflow: 'research', source: 'skill' }, T + 2).record
    r = flowPhase(r, { phase: 'gather' }, T + 3).record
    const v = view({ flow: r })
    expect(v.breadcrumb).toEqual(['requirements', 'research'])
    expect(v.workflow).toBe('research')
    expect(lines(v, 120)[0]).toContain('requirements › research')
    const ended = flowEnd(r, 'done', T + 10).record
    expect(bandView({ nowMs: T + 11, foldAfterSec: 8, flow: ended })).toMatchObject({ workflow: 'research', status: 'done' })
    expect(bandView({ nowMs: T + 10 + 8_000, foldAfterSec: 8, flow: ended })).toMatchObject({ workflow: 'requirements', breadcrumb: ['requirements'], status: 'running' })
  })

  test('a plan bound without a flow record shows its workflow; a finished one does not', () => {
    expect(view({ plan: plan() })).toMatchObject({ visible: true, workflow: 'plan-build', progress: { done: 3, total: 7 } })
    expect(view({ plan: plan({ type: 'Build', status: 'IN_PROGRESS' }) }).workflow).toBe('goal-build')
    expect(view({ plan: plan({ status: 'VERIFIED', phase: 'done' }) }).visible).toBe(false)
  })

  test('the run the person hid stays hidden until another run starts', () => {
    const r = flow('plan-build', 'implement')
    expect(view({ flow: r, hidden: T }).visible).toBe(false)
    expect(view({ flow: flow('bugfix', 'red', { at: T + MIN }), hidden: T }).visible).toBe(true)
  })

  test('the running subagents and the todo in progress', () => {
    const v = view({
      flow: flow('plan-build', 'verify'),
      todos: [{ content: 'Run the e2e scenarios', status: 'in_progress', activeForm: 'Running the e2e scenarios' }],
      agents: [{ id: 't1', label: 'buracle:changes-review', startedAt: T }],
    })
    expect(v.current).toBe('Running the e2e scenarios')
    expect(v.agents).toEqual(['changes-review'])
    expect(lines(v, 120)[2]).toBe('▸ Running the e2e scenarios · ⟳ changes-review')
  })
})

describe('bandRows', () => {
  const v = view({ flow: flow('plan-build', 'implement', { title: 'Rate limit the public API', step: 'Running middleware tests' }), plan: plan(), agents: [{ id: 'a', label: 'plan-build-review', startedAt: T }] })

  test.each([[120, 3, 3], [96, 3, 3], [70, 3, 2], [56, 2, 2], [40, 3, 1], [30, 3, 1], [24, 1, 1], [120, 1, 1], [120, 2, 2]])('width %i, %i rows allowed: %i rows, each within the width', (columns, maxRows, count) => {
    const rows = bandRows(v, columns, maxRows, true)
    expect(rows).toHaveLength(count)
    for (const row of rows) expect(textWidth(row.map(s => s.text).join(''))).toBeLessThanOrEqual(columns)
  })

  test('below 24 columns nothing is drawn', () => {
    expect(bandRows(v, 23, 3, true)).toEqual([])
    expect(bandRows(v, 120, 0, true)).toEqual([])
  })

  test('wide: the run with its status, the phases with a progress bar, the current step', () => {
    const [head, chain, detail] = lines(v, 120)
    expect(head?.startsWith('◆ plan-build · Rate limit the public API')).toBe(true)
    expect(head?.endsWith('running · 12m')).toBe(true)
    expect(textWidth(head ?? '')).toBe(120)
    expect(chain).toBe('✓ Plan ━ ✓ Approve ━ ● Implement 3/7 ▰▰▰▱▱▱▱ ━ ○ Verify')
    expect(detail).toBe('▸ Running middleware tests · ⟳ plan-build-review')
  })

  test('medium and narrow layouts keep the current phase and the progress', () => {
    expect(lines(v, 70)[1]).toBe('✓ Plan ━ ✓ Approve ━ ● Implement 3/7 ━ ○ Verify')
    expect(lines(v, 30)).toEqual(['plan-build ● Implement 3/7'])
  })

  test('reserve keeps room at the end of the first row', () => {
    const [head] = bandRows(v, 120, 3, true, { reserve: 20 })
    expect(textWidth((head ?? []).map(s => s.text).join(''))).toBe(100)
  })

  test('segments carry stable ids for the drawing (phase, progress, current, agents)', () => {
    const ids = bandRows(v, 120, 3, true).flat().map(s => s.id)
    for (const id of ['band-crumb', 'band-status', 'band-phase-plan', 'band-phase-implement', 'band-progress', 'band-current', 'band-agents']) expect(ids).toContain(id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('ASCII glyphs without emoji; every label in English', () => {
    const ascii = renderPlainLines(bandRows(v, 120, 3, false))
    expect(/[^\x20-\x7e\n]/.test(ascii)).toBe(false)
    expect(/[çğıöşüÇĞİÖŞÜ]/.test(renderPlainLines(bandRows(v, 120, 3, true)))).toBe(false)
  })
})

describe('plans, criteria and text', () => {
  const BUILD = `---
created: 2026-10-08
status: COMPLETE
approved: true
worktree: false
type: Build
rounds: 1
---
# Offline mode

## Acceptance Criteria
| # | Criterion | Evidence | Status |
|---|---|---|---|
| C1 | Works offline. | chrome-devtools | pass |
| C2 | Syncs within 10 s. | server log | fail |
| C3 (oracle) | Second profile sees it. | screenshots | open |

## Tasks

### Task 1: Queue writes

**Objective:** Queue.

- [x] Task 1 done

### Task 2: Replay

**Objective:** Replay.

- [ ] Task 2 done
`

  test('criteriaOf reads the acceptance criteria table', () => {
    expect(criteriaOf(BUILD)).toEqual([
      { id: 'C1', status: 'pass', oracle: false },
      { id: 'C2', status: 'fail', oracle: false },
      { id: 'C3', status: 'open', oracle: true },
    ])
    expect(criteriaOf('# none\n')).toEqual([])
    expect(criteriaOf('# B\n\n## Acceptance Criteria\n| C1 | a | b | fail |\n| **C2** (oracle) | a | b | **pass** |\n')).toEqual([
      { id: 'C1', status: 'fail', oracle: false },
      { id: 'C2', status: 'pass', oracle: true },
    ])
  })

  test('bandPlanOf joins the session binding and the plan file', () => {
    const state = { ...emptyState(), plan: { path: '/r/docs/builds/b.md', slug: 'b', status: 'COMPLETE' as const, type: 'Build' as const, phase: 'implement' as const, registeredAt: T } }
    expect(bandPlanOf(state, BUILD)).toEqual({
      path: '/r/docs/builds/b.md', type: 'Build', status: 'COMPLETE', phase: 'implement', approved: true, since: T,
      title: 'Offline mode', done: 1, total: 2, current: 'Task 2: Replay', rounds: 1, criteria: criteriaOf(BUILD),
    })
    expect(bandPlanOf(emptyState(), BUILD)).toBeUndefined()
  })

  test('bandText and the resume suggestion', () => {
    const v = view({ flow: flow('plan-build', 'implement', { title: 'Rate limit' }), plan: plan() })
    expect(bandText(v)).toEqual([
      'plan-build · Rate limit · running · 12m',
      'phases: ✓ Plan  ✓ Approve  ● Implement  ○ Verify',
      'progress: 3/7 tasks',
      'now: Task 4: parser tests',
    ])
    expect(resumeSuggestion(v)).toBe('continue the plan-build run (Implement 3/7): Rate limit')
    expect(bandSummary(v)).toBe('plan-build (Rate limit): phase Implement, 3/7 tasks; now: Task 4: parser tests')
    expect(bandSummary(view({ flow: flow('bugfix', 'red'), interaction: { state: 'paused', kind: 'decision' } }))).toBe('bugfix: phase RED, waiting for you')
    expect(bandSummary(view({}))).toBe('')
    expect(resumeSuggestion(view({}))).toBeUndefined()
    expect(bandText(view({}))).toEqual(['No workflow is running.'])
  })
})

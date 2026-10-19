import { describe, expect, test } from 'bun:test'
import { flowEnd, flowPhase, flowStart } from '../../../src/core/flow/record'
import type { BandState } from '../../../src/core/flow/state'
import {
  bandActive, bandAgentBind, bandAgentEnd, bandAgentStart, bandChanged, bandFoldAt, bandHide, bandRefresh, bandTodoCreate, bandTodoTool,
  bandTodoUpdate, bandTodosWrite, bandViewOf, emptyBand,
} from '../../../src/core/flow/state'
import { emptyState } from '../../../src/core/plan/state'

const T = Date.UTC(2026, 9, 9, 10, 0, 0)
const FLOW = flowPhase(flowStart(undefined, { workflow: 'plan-build', source: 'command' }, T).record, { phase: 'implement' }, T + 1).record
const PLAN_TEXT = '---\ncreated: 2026-10-09\nstatus: IN_PROGRESS\napproved: true\nworktree: false\ntype: Feature\n---\n# Rate limit\n\n## Tasks\n\n### Task 1: Count\n\n**Objective:** x.\n\n- [x] Task 1 done\n\n### Task 2: Limit\n\n**Objective:** y.\n\n- [ ] Task 2 done\n'
const STATE = { ...emptyState(), plan: { path: '/r/docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS' as const, type: 'Feature' as const, phase: 'implement' as const, registeredAt: T }, interaction: { state: 'paused' as const, kind: 'decision' as const, since: T, reason: 'pick one' } }

function refreshed(prev: BandState = emptyBand(), sid = 's1', now = T + 60_000): BandState {
  return bandRefresh(prev, { sid, now, flow: FLOW, state: STATE, planText: PLAN_TEXT, band: true, foldAfterSec: 8 })
}

describe('bandRefresh', () => {
  test('reads the flow, the plan and the pause into plain JSON', () => {
    const b = refreshed()
    expect(b).toMatchObject({ v: 1, sid: 's1', stamp: T + 60_000, foldAfterSec: 8, interaction: { state: 'paused', kind: 'decision', reason: 'pick one' } })
    expect(b.plan).toMatchObject({ title: 'Rate limit', done: 1, total: 2, current: 'Task 2: Limit' })
    expect(JSON.parse(JSON.stringify(b))).toEqual(b)
    expect(bandViewOf(b)).toMatchObject({ visible: true, workflow: 'plan-build', status: 'waiting', progress: { done: 1, total: 2 } })
  })

  test('todos, subagents and the hide carry over within a session and reset with a new one', () => {
    let b = refreshed()
    b = bandTodosWrite(b, [{ content: 'a', status: 'in_progress', activeForm: 'Doing a' }, { content: 1, status: 'x' }])
    b = bandAgentStart(b, { id: 'tu1', label: 'buracle:plan-build-review' }, T)
    b = bandHide(b)
    const same = refreshed(b, 's1', T + 120_000)
    expect(same.todos).toEqual([{ content: 'a', status: 'in_progress', activeForm: 'Doing a' }])
    expect(same.agents.map(a => a.id)).toEqual(['tu1'])
    expect(same.hidden).toBe(T)
    const other = refreshed(b, 's2', T + 120_000)
    expect(other.todos).toEqual([])
    expect(other.agents).toEqual([])
    expect(other.hidden).toBeUndefined()
  })

  test('an unparsable flow file keeps the last good record; workflow.band off draws nothing', () => {
    const b = refreshed()
    expect(bandRefresh(b, { sid: 's1', now: T + 1, flow: 'keep', band: true, foldAfterSec: 8 }).flow).toEqual(FLOW)
    const off = bandRefresh(b, { sid: 's1', now: T + 1, flow: FLOW, band: false, foldAfterSec: 8 })
    expect(off.off).toBe(true)
    expect(bandViewOf(off).visible).toBe(false)
  })
})

describe('todos and subagents', () => {
  test('TaskCreate and TaskUpdate keep a list by id; deleted removes', () => {
    let b = emptyBand()
    b = bandTodoCreate(b, { id: '1', subject: 'Write tests', activeForm: 'Writing tests' })
    b = bandTodoCreate(b, { id: '2', subject: 'Ship' })
    b = bandTodoUpdate(b, { taskId: '1', status: 'in_progress' })
    b = bandTodoUpdate(b, { taskId: '2', status: 'deleted' })
    expect(b.todos).toEqual([{ id: '1', content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }])
  })

  test('the todo tools as the mod sees them: the result first, else the input', () => {
    let b = bandTodoTool(emptyBand(), 'TodoWrite', { todos: [{ content: 'old', status: 'pending', activeForm: 'x' }] }, { oldTodos: [], newTodos: [{ content: 'new', status: 'in_progress', activeForm: 'Doing new' }] })
    expect(b.todos).toEqual([{ content: 'new', status: 'in_progress', activeForm: 'Doing new' }])
    b = bandTodoTool(emptyBand(), 'TaskCreate', { subject: 'Ship', activeForm: 'Shipping' }, { task: { id: '7', subject: 'Ship it' } })
    expect(b.todos).toEqual([{ id: '7', content: 'Ship it', status: 'pending', activeForm: 'Shipping' }])
    b = bandTodoTool(b, 'TaskUpdate', { taskId: '7', status: 'in_progress' }, { success: true })
    expect(b.todos[0]?.status).toBe('in_progress')
    expect(bandTodoTool(b, 'TaskUpdate', { status: 'completed' }, {})).toBe(b)
    expect(bandTodoTool(b, 'Read', { file_path: 'x' }, {})).toBe(b)
  })

  test('a background subagent ends by its own id', () => {
    let b = bandAgentStart(emptyBand(), { id: 'toolu_1', label: 'buracle:changes-review' }, T)
    b = bandAgentBind(b, 'toolu_1', 'agent-7')
    expect(bandAgentEnd(b, 'agent-9')).toBe(b)
    expect(bandAgentEnd(b, 'agent-7').agents).toEqual([])
    expect(bandAgentEnd(bandAgentStart(emptyBand(), { id: 'x', label: 'y' }, T), 'x').agents).toEqual([])
  })
})

describe('active, fold and change detection', () => {
  test('a running workflow is active; an ended one folds foldAfterSec after its end', () => {
    const b = refreshed()
    expect(bandActive(b)).toBe(true)
    expect(bandFoldAt(b)).toBeUndefined()
    const ended = bandRefresh(b, { sid: 's1', now: T + 70_000, flow: flowEnd(FLOW, 'done', T + 65_000).record, band: true, foldAfterSec: 8 })
    expect(bandActive(ended)).toBe(false)
    expect(bandFoldAt(ended)).toBe(T + 73_000)
    expect(bandViewOf({ ...ended, stamp: T + 73_000 }).visible).toBe(false)
  })

  test('a newer stamp within the same minute is no change; a new minute is', () => {
    const b = refreshed()
    expect(bandChanged(b, { ...b, stamp: b.stamp + 1_000 })).toBe(false)
    expect(bandChanged(b, { ...b, stamp: b.stamp + 60_000 })).toBe(true)
    expect(bandChanged(b, bandTodosWrite(b, [{ content: 'x', status: 'pending' }]))).toBe(true)
  })
})

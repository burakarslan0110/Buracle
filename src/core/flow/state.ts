import type { SessionState } from '../plan/state'
import type { BandAgent, BandInput, BandInteraction, BandPlan, BandTodo, BandView } from './band'
import { bandPlanOf, bandView } from './band'
import type { FlowRecord } from './record'
import { flowText } from './record'

export interface BandState {
  v: 1
  sid: string
  stamp: number
  flow?: FlowRecord
  plan?: BandPlan
  interaction?: BandInteraction
  todos: BandTodo[]
  agents: BandAgent[]
  hidden?: number
  off?: boolean
  foldAfterSec: number
}

const AGENT_MAX_MS = 2 * 60 * 60_000
const TODOS_MAX = 50
const AGENTS_MAX = 6

export function emptyBand(): BandState {
  return { v: 1, sid: '', stamp: 0, todos: [], agents: [], foldAfterSec: 8 }
}

export interface BandFiles {
  sid: string
  now: number
  flow: FlowRecord | undefined | 'keep'
  state?: SessionState
  planText?: string
  band: boolean
  foldAfterSec: number
}

export function bandRefresh(prev: BandState, x: BandFiles): BandState {
  const same = prev.sid === x.sid
  const next: BandState = {
    v: 1, sid: x.sid, stamp: x.now,
    todos: same ? prev.todos : [],
    agents: same ? prev.agents.filter(a => x.now - a.startedAt < AGENT_MAX_MS) : [],
    foldAfterSec: Number.isFinite(x.foldAfterSec) && x.foldAfterSec >= 0 ? x.foldAfterSec : 8,
  }
  const flow = x.flow === 'keep' ? (same ? prev.flow : undefined) : x.flow
  if (flow !== undefined) next.flow = flow
  const plan = bandPlanOf(x.state, x.planText)
  if (plan !== undefined) next.plan = plan
  const it = x.state?.interaction
  if (it !== undefined && (it.state === 'paused' || it.state === 'running')) {
    const i: BandInteraction = { state: it.state }
    if (it.kind !== undefined) i.kind = it.kind
    if (typeof it.reason === 'string' && it.reason.trim() !== '') i.reason = flowText(it.reason, 200)
    next.interaction = i
  }
  if (same && prev.hidden !== undefined) next.hidden = prev.hidden
  if (!x.band) next.off = true
  return next
}

export function bandInputOf(b: BandState): BandInput {
  const i: BandInput = { nowMs: b.stamp, todos: b.todos, agents: b.agents, foldAfterSec: b.foldAfterSec }
  if (b.flow !== undefined) i.flow = b.flow
  if (b.plan !== undefined) i.plan = b.plan
  if (b.interaction !== undefined) i.interaction = b.interaction
  if (b.hidden !== undefined) i.hidden = b.hidden
  return i
}

export function bandViewOf(b: BandState): BandView {
  const v = bandView(bandInputOf(b))
  return b.off === true ? { ...v, visible: false } : v
}

export function bandActive(b: BandState): boolean {
  const v = bandViewOf(b)
  return v.visible && v.endedAt === undefined
}

export function bandFoldAt(b: BandState): number | undefined {
  const v = bandViewOf(b)
  return v.visible && v.endedAt !== undefined ? v.endedAt + b.foldAfterSec * 1000 : undefined
}

function minuteOf(b: BandState): string {
  return JSON.stringify({ ...b, stamp: Math.floor(b.stamp / 60_000) })
}

export function bandChanged(a: BandState, b: BandState): boolean {
  return minuteOf(a) !== minuteOf(b)
}

function todoStatus(x: unknown): BandTodo['status'] | undefined {
  return x === 'pending' || x === 'in_progress' || x === 'completed' ? x : undefined
}

export function bandTodosWrite(b: BandState, todos: unknown): BandState {
  if (!Array.isArray(todos)) return b
  const list: BandTodo[] = []
  for (const t of todos) {
    if (t === null || typeof t !== 'object') continue
    const o = t as Record<string, unknown>
    const status = todoStatus(o['status'])
    if (typeof o['content'] !== 'string' || status === undefined) continue
    const todo: BandTodo = { content: flowText(o['content'], 120), status }
    if (typeof o['activeForm'] === 'string' && o['activeForm'].trim() !== '') todo.activeForm = flowText(o['activeForm'], 120)
    list.push(todo)
  }
  return { ...b, todos: list.slice(0, TODOS_MAX) }
}

export function bandTodoCreate(b: BandState, task: { id?: string; subject: string; activeForm?: string }): BandState {
  const todo: BandTodo = { content: flowText(task.subject, 120), status: 'pending' }
  if (task.id !== undefined && task.id !== '') todo.id = task.id
  if (task.activeForm !== undefined && task.activeForm.trim() !== '') todo.activeForm = flowText(task.activeForm, 120)
  return { ...b, todos: [...b.todos, todo].slice(-TODOS_MAX) }
}

export function bandTodoUpdate(b: BandState, u: { taskId: string; status?: string; subject?: string; activeForm?: string }): BandState {
  if (u.status === 'deleted') return { ...b, todos: b.todos.filter(t => t.id !== u.taskId) }
  const status = todoStatus(u.status)
  let found = false
  const todos = b.todos.map(t => {
    if (t.id !== u.taskId) return t
    found = true
    const n: BandTodo = { ...t }
    if (status !== undefined) n.status = status
    if (u.subject !== undefined && u.subject.trim() !== '') n.content = flowText(u.subject, 120)
    if (u.activeForm !== undefined && u.activeForm.trim() !== '') n.activeForm = flowText(u.activeForm, 120)
    return n
  })
  if (!found && u.subject !== undefined && status !== undefined) todos.push({ id: u.taskId, content: flowText(u.subject, 120), status })
  return { ...b, todos }
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

export function bandTodoTool(b: BandState, tool: string, input: Readonly<Record<string, unknown>>, result: unknown): BandState {
  const res = result !== null && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {}
  if (tool === 'TodoWrite') return bandTodosWrite(b, Array.isArray(res['newTodos']) ? res['newTodos'] : input['todos'])
  if (tool === 'TaskCreate') {
    const task = res['task'] !== null && typeof res['task'] === 'object' ? res['task'] as Record<string, unknown> : {}
    const subject = str(task['subject']) ?? str(input['subject'])
    if (subject === undefined) return b
    const t: { id?: string; subject: string; activeForm?: string } = { subject }
    const id = str(task['id'])
    const activeForm = str(input['activeForm'])
    if (id !== undefined) t.id = id
    if (activeForm !== undefined) t.activeForm = activeForm
    return bandTodoCreate(b, t)
  }
  if (tool === 'TaskUpdate') {
    const taskId = str(input['taskId'])
    if (taskId === undefined) return b
    const u: { taskId: string; status?: string; subject?: string; activeForm?: string } = { taskId }
    for (const k of ['status', 'subject', 'activeForm'] as const) {
      const v = str(input[k])
      if (v !== undefined) u[k] = v
    }
    return bandTodoUpdate(b, u)
  }
  return b
}

export function bandAgentStart(b: BandState, a: { id: string; label: string }, now: number): BandState {
  const label = flowText(a.label, 60)
  if (a.id === '' || label === '') return b
  return { ...b, agents: [...b.agents.filter(x => x.id !== a.id), { id: a.id, label, startedAt: now }].slice(-AGENTS_MAX) }
}

export function bandAgentBind(b: BandState, id: string, agentId: string): BandState {
  return { ...b, agents: b.agents.map(a => (a.id === id ? { ...a, agentId } : a)) }
}

export function bandAgentEnd(b: BandState, id: string): BandState {
  const agents = b.agents.filter(a => a.id !== id && a.agentId !== id)
  return agents.length === b.agents.length ? b : { ...b, agents }
}

export function bandHide(b: BandState): BandState {
  const v = bandViewOf(b)
  return v.visible ? { ...b, hidden: v.startedAt ?? b.stamp } : b
}

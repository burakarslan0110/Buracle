import type { PlanStatus, PlanType } from '../plan/format'
import { FLOW_ID_RE, flowDef, flowPhaseProblem, isTopLevelFlow } from './catalog'

export type FlowSource = 'command' | 'prompt' | 'skill' | 'cli' | 'plan'
export type FlowOutcome = 'done' | 'failed' | 'cancelled'

export const FLOW_SOURCES: readonly FlowSource[] = ['command', 'prompt', 'skill', 'cli', 'plan']
export const FLOW_OUTCOMES: readonly FlowOutcome[] = ['done', 'failed', 'cancelled']

export interface FlowEntry {
  workflow: string
  title?: string
  source: FlowSource
  startedAt: number
  phase?: { id: string; since: number; note?: string }
  step?: { text: string; done?: number; total?: number; at: number }
  ended?: { outcome: FlowOutcome; at: number }
}

export interface FlowRecord {
  v: 1
  stack: FlowEntry[]
  updatedAt: number
}

export const FLOW_MAX_DEPTH = 4
export const FLOW_TITLE_MAX = 80
export const FLOW_STEP_MAX = 160
export const FLOW_NOTE_MAX = 200
export const FLOW_SAME_RUN_MS = 60_000

export interface FlowResult {
  record: FlowRecord
  changed: boolean
  entry?: FlowEntry
  error?: { code: 'no_flow' | 'invalid'; message: string }
}

export function emptyFlow(now: number): FlowRecord {
  return { v: 1, stack: [], updatedAt: now }
}

export function flowText(text: string, max: number): string {
  const one = String(text).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return one.length > max ? `${one.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026` : one
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

function count(x: unknown): number | undefined {
  const n = num(x)
  return n !== undefined && n >= 0 ? Math.floor(n) : undefined
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function entryOf(raw: unknown): FlowEntry | undefined {
  if (!isObj(raw)) return undefined
  const workflow = raw['workflow']
  const startedAt = num(raw['startedAt'])
  if (typeof workflow !== 'string' || !FLOW_ID_RE.test(workflow) || startedAt === undefined) return undefined
  const source = FLOW_SOURCES.includes(raw['source'] as FlowSource) ? raw['source'] as FlowSource : 'cli'
  const e: FlowEntry = { workflow, source, startedAt }
  if (typeof raw['title'] === 'string' && raw['title'].trim() !== '') e.title = flowText(raw['title'], FLOW_TITLE_MAX)
  const p = raw['phase']
  if (isObj(p) && typeof p['id'] === 'string' && FLOW_ID_RE.test(p['id']) && num(p['since']) !== undefined) {
    e.phase = { id: p['id'], since: num(p['since']) as number }
    if (typeof p['note'] === 'string' && p['note'].trim() !== '') e.phase.note = flowText(p['note'], FLOW_NOTE_MAX)
  }
  const s = raw['step']
  if (isObj(s) && typeof s['text'] === 'string' && num(s['at']) !== undefined) {
    e.step = { text: flowText(s['text'], FLOW_STEP_MAX), at: num(s['at']) as number }
    const done = count(s['done'])
    const total = count(s['total'])
    if (done !== undefined) e.step.done = done
    if (total !== undefined) e.step.total = total
  }
  const x = raw['ended']
  if (isObj(x) && FLOW_OUTCOMES.includes(x['outcome'] as FlowOutcome) && num(x['at']) !== undefined) {
    e.ended = { outcome: x['outcome'] as FlowOutcome, at: num(x['at']) as number }
  }
  return e
}

export function parseFlow(raw: unknown): FlowRecord | undefined {
  if (!isObj(raw) || raw['v'] !== 1 || !Array.isArray(raw['stack'])) return undefined
  const stack: FlowEntry[] = []
  for (const item of raw['stack']) {
    const e = entryOf(item)
    if (e !== undefined) stack.push(e)
  }
  return { v: 1, stack: stack.slice(-FLOW_MAX_DEPTH), updatedAt: num(raw['updatedAt']) ?? 0 }
}

export function activeFlowIndex(rec: FlowRecord | undefined): number {
  const stack = rec?.stack ?? []
  for (let i = stack.length - 1; i >= 0; i--) if ((stack[i] as FlowEntry).ended === undefined) return i
  return -1
}

export function activeFlow(rec: FlowRecord | undefined): FlowEntry | undefined {
  const i = activeFlowIndex(rec)
  return i >= 0 ? rec?.stack[i] : undefined
}

export function flowBreadcrumb(rec: FlowRecord | undefined): string[] {
  const i = activeFlowIndex(rec)
  return i < 0 ? [] : (rec?.stack ?? []).slice(0, i + 1).filter(e => e.ended === undefined).map(e => e.workflow)
}

function withStack(stack: FlowEntry[], now: number): FlowRecord {
  return { v: 1, stack, updatedAt: now }
}

function replaceAt(stack: readonly FlowEntry[], i: number, e: FlowEntry): FlowEntry[] {
  return stack.map((x, j) => (j === i ? e : x))
}

export function flowStart(rec: FlowRecord | undefined, input: { workflow: string; title?: string; source: FlowSource }, now: number): FlowResult {
  const base = rec ?? emptyFlow(now)
  if (!FLOW_ID_RE.test(input.workflow)) {
    return { record: base, changed: false, error: { code: 'invalid', message: `'${input.workflow}' is not a workflow id (lower-case kebab-case, 1-40 characters)` } }
  }
  const title = input.title !== undefined ? flowText(input.title, FLOW_TITLE_MAX) : ''
  const stack = [...base.stack]
  while (stack.length > 0 && (stack[stack.length - 1] as FlowEntry).ended !== undefined) stack.pop()
  const top = stack[stack.length - 1]
  const byPerson = input.source === 'command' || input.source === 'prompt'
  if (top !== undefined && top.workflow === input.workflow && !(byPerson && now - top.startedAt > FLOW_SAME_RUN_MS)) {
    if (title === '' || title === top.title) {
      return stack.length === base.stack.length ? { record: base, changed: false, entry: top } : { record: withStack(stack, now), changed: true, entry: top }
    }
    const e: FlowEntry = { ...top, title }
    return { record: withStack(replaceAt(stack, stack.length - 1, e), now), changed: true, entry: e }
  }
  const e: FlowEntry = { workflow: input.workflow, source: input.source, startedAt: now }
  if (title !== '') e.title = title
  const fresh = byPerson || isTopLevelFlow(input.workflow)
  const next = fresh ? [e] : [...stack, e].slice(-FLOW_MAX_DEPTH)
  return { record: withStack(next, now), changed: true, entry: e }
}

function noFlow(rec: FlowRecord): FlowResult {
  return { record: rec, changed: false, error: { code: 'no_flow', message: "no workflow is running in this session; start one with 'buracle flow start <workflow>'" } }
}

export function flowPhase(rec: FlowRecord | undefined, input: { phase: string; note?: string }, now: number): FlowResult {
  const base = rec ?? emptyFlow(now)
  const i = activeFlowIndex(base)
  if (i < 0) return noFlow(base)
  const cur = base.stack[i] as FlowEntry
  const problem = flowPhaseProblem(cur.workflow, input.phase)
  if (problem !== undefined) return { record: base, changed: false, entry: cur, error: { code: 'invalid', message: problem } }
  const note = input.note !== undefined ? flowText(input.note, FLOW_NOTE_MAX) : ''
  if (cur.phase?.id === input.phase) {
    if (note === '' || note === cur.phase.note) return { record: base, changed: false, entry: cur }
    const e: FlowEntry = { ...cur, phase: { ...cur.phase, note } }
    return { record: withStack(replaceAt(base.stack, i, e), now), changed: true, entry: e }
  }
  const { step: _step, ...rest } = cur
  const e: FlowEntry = { ...rest, phase: note !== '' ? { id: input.phase, since: now, note } : { id: input.phase, since: now } }
  return { record: withStack(replaceAt(base.stack, i, e), now), changed: true, entry: e }
}

export function flowStep(rec: FlowRecord | undefined, input: { text: string; done?: number; total?: number }, now: number): FlowResult {
  const base = rec ?? emptyFlow(now)
  const i = activeFlowIndex(base)
  if (i < 0) return noFlow(base)
  const cur = base.stack[i] as FlowEntry
  const text = flowText(input.text, FLOW_STEP_MAX)
  if (text === '') return { record: base, changed: false, entry: cur, error: { code: 'invalid', message: 'the step text is empty' } }
  const step: NonNullable<FlowEntry['step']> = { text, at: now }
  const done = count(input.done)
  const total = count(input.total)
  if (done !== undefined) step.done = total !== undefined ? Math.min(done, total) : done
  if (total !== undefined) step.total = total
  const old = cur.step
  if (old !== undefined && old.text === step.text && old.done === step.done && old.total === step.total) return { record: base, changed: false, entry: cur }
  const e: FlowEntry = { ...cur, step }
  return { record: withStack(replaceAt(base.stack, i, e), now), changed: true, entry: e }
}

export function flowEnd(rec: FlowRecord | undefined, outcome: FlowOutcome, now: number): FlowResult {
  const base = rec ?? emptyFlow(now)
  const i = activeFlowIndex(base)
  if (i < 0) return { record: base, changed: false }
  const e: FlowEntry = { ...(base.stack[i] as FlowEntry), ended: { outcome, at: now } }
  return { record: withStack(replaceAt(base.stack, i, e), now), changed: true, entry: e }
}

export type PlanPhase = 'plan' | 'implement' | 'verify' | 'done'

export function workflowOfPlanType(type: PlanType): 'plan-build' | 'goal-build' {
  return type === 'Build' ? 'goal-build' : 'plan-build'
}

export function planFlowPhase(workflow: string, plan: { status: PlanStatus; phase: PlanPhase }, current?: string): string | undefined {
  if (workflow === 'plan-build') {
    if (plan.phase === 'plan') return current === 'approve' ? 'approve' : 'plan'
    return plan.phase === 'implement' ? 'implement' : 'verify'
  }
  if (workflow === 'goal-build') {
    if (plan.phase === 'plan') return 'contract'
    if (plan.phase === 'implement') return plan.status === 'COMPLETE' ? 'judge' : 'build'
    return plan.phase === 'verify' ? 'verify' : 'handback'
  }
  return undefined
}

export function flowFromPlan(rec: FlowRecord | undefined, plan: { type: PlanType; status: PlanStatus; phase: PlanPhase; title?: string }, now: number): FlowResult {
  let base = rec ?? emptyFlow(now)
  if (plan.status === 'SAVED') return { record: base, changed: false }
  const workflow = workflowOfPlanType(plan.type)
  const finished = plan.status === 'VERIFIED' || plan.phase === 'done'
  const find = (r: FlowRecord) => {
    for (let i = r.stack.length - 1; i >= 0; i--) {
      const e = r.stack[i] as FlowEntry
      if (e.ended === undefined && e.workflow === workflow) return i
    }
    return -1
  }
  let changed = false
  let i = find(base)
  if (i < 0) {
    if (finished) return { record: base, changed: false }
    const started = flowStart(base, plan.title !== undefined ? { workflow, title: plan.title, source: 'plan' } : { workflow, source: 'plan' }, now)
    base = started.record
    changed = started.changed
    i = find(base)
    if (i < 0) return { record: base, changed }
  }
  let e = base.stack[i] as FlowEntry
  if (e.title === undefined && plan.title !== undefined && plan.title.trim() !== '') {
    e = { ...e, title: flowText(plan.title, FLOW_TITLE_MAX) }
    changed = true
  }
  const target = planFlowPhase(workflow, plan, e.phase?.id)
  if (target !== undefined && flowDef(workflow)?.phases.some(p => p.id === target) === true && e.phase?.id !== target) {
    const { step: _step, ...rest } = e
    e = { ...rest, phase: { id: target, since: now } }
    changed = true
  }
  if (finished) {
    e = { ...e, ended: { outcome: 'done', at: now } }
    changed = true
  }
  if (!changed) return { record: base, changed: false, entry: e }
  return { record: withStack(replaceAt(base.stack, i, e), now), changed: true, entry: e }
}

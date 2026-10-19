import { join } from 'node:path'
import type { Harness } from '../core/events'
import type { BandInput, BandView } from '../core/flow/band'
import { bandPlanOf, bandText, bandView } from '../core/flow/band'
import { FLOW_ID_RE, flowPhaseLabel } from '../core/flow/catalog'
import type { FlowEntry, FlowOutcome, FlowRecord, FlowResult, FlowSource, PlanPhase } from '../core/flow/record'
import { FLOW_OUTCOMES, activeFlow, flowBreadcrumb, flowEnd, flowFromPlan, flowPhase, flowStart, flowStep, parseFlow } from '../core/flow/record'
import type { PlanStatus, PlanType } from '../core/plan/format'
import { atomicWriteSync, readJsonSafeSync, readTextSync } from '../engine/fsx'
import { log } from '../engine/log'
import { sessionDir } from '../engine/paths'
import { fail, ok, sessionJson, type CmdResult, type WorkflowCtx } from './result'
import type { ResolvedSession } from './session-store'
import { loadState } from './session-store'

export const DEFAULT_FOLD_SEC = 8

export function flowPath(h: Harness, sid: string): string {
  return join(sessionDir(h, sid), 'flow.json')
}

export function readFlow(h: Harness, sid: string): FlowRecord | undefined {
  const r = readJsonSafeSync<unknown>(flowPath(h, sid))
  if (!r.ok) {
    if (r.code !== 'missing') log('warn', 'flow record unreadable; starting a new one', { h, sid, error: r.error })
    return undefined
  }
  const rec = parseFlow(r.value)
  if (rec === undefined) log('warn', 'flow record has an unexpected shape; starting a new one', { h, sid })
  return rec
}

export function writeFlow(h: Harness, sid: string, rec: FlowRecord): void {
  atomicWriteSync(flowPath(h, sid), JSON.stringify(rec, null, 2) + '\n')
}

function entryJson(e: FlowEntry | undefined): Record<string, unknown> | null {
  if (e === undefined) return null
  const out: Record<string, unknown> = { workflow: e.workflow, source: e.source, startedAt: e.startedAt }
  if (e.title !== undefined) out['title'] = e.title
  if (e.phase !== undefined) out['phase'] = { ...e.phase, label: flowPhaseLabel(e.workflow, e.phase.id) }
  if (e.step !== undefined) out['step'] = e.step
  if (e.ended !== undefined) out['ended'] = e.ended
  return out
}

function stepText(e: FlowEntry): string {
  if (e.step === undefined) return ''
  const n = e.step.total !== undefined ? ` ${e.step.done ?? 0}/${e.step.total}` : ''
  return ` · step "${e.step.text}"${n}`
}

function entryLine(e: FlowEntry, rec: FlowRecord): string {
  const crumb = flowBreadcrumb(rec)
  const name = crumb.length > 1 ? crumb.join(' > ') : e.workflow
  const phase = e.phase !== undefined ? ` · phase ${e.phase.id} (${flowPhaseLabel(e.workflow, e.phase.id)})` : ''
  const ended = e.ended !== undefined ? ` · ended: ${e.ended.outcome}` : ''
  return `${name}${e.title !== undefined ? `: ${e.title}` : ''}${phase}${stepText(e)}${ended}`
}

function apply(s: ResolvedSession, fn: (rec: FlowRecord | undefined) => FlowResult, verb: string): CmdResult {
  const rec = readFlow(s.harness, s.sessionId)
  const r = fn(rec)
  if (r.error !== undefined) {
    return fail(r.error.code, r.error.message, { session: sessionJson(s) })
  }
  if (r.changed) {
    try {
      writeFlow(s.harness, s.sessionId, r.record)
    } catch (e) {
      return fail('write_failed', `could not write ${flowPath(s.harness, s.sessionId)}: ${e instanceof Error ? e.message : String(e)}`, { session: sessionJson(s) })
    }
  }
  const data: Record<string, unknown> = {
    ok: true, changed: r.changed, active: entryJson(activeFlow(r.record)), entry: entryJson(r.entry),
    breadcrumb: flowBreadcrumb(r.record), session: sessionJson(s),
  }
  const lines: string[] = []
  if (r.entry === undefined) lines.push(`Nothing is running in the ${s.harness} session ${s.sessionId}; nothing to ${verb}.`)
  else lines.push(`${r.changed ? '' : 'unchanged: '}${entryLine(r.entry, r.record)}`)
  return ok(data, lines)
}

export function flowStartCmd(o: { workflow?: string, title?: string }, ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  if (o.workflow === undefined || !FLOW_ID_RE.test(o.workflow)) {
    return fail('usage', `buracle flow start <workflow>: ${o.workflow === undefined ? 'missing <workflow>' : `'${o.workflow}' is not a workflow id (lower-case kebab-case, as the skill is named)`}`)
  }
  if (o.title !== undefined && /[\r\n]/.test(o.title)) return fail('usage', '--title must be a single line')
  const workflow = o.workflow
  return apply(s, rec => flowStart(rec, o.title !== undefined ? { workflow, title: o.title, source: 'cli' } : { workflow, source: 'cli' }, ctx.now), 'start')
}

export function flowPhaseCmd(o: { phase?: string, note?: string }, ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  if (o.phase === undefined) return fail('usage', 'buracle flow phase <phase>: missing <phase>')
  const phase = o.phase
  return apply(s, rec => flowPhase(rec, o.note !== undefined ? { phase, note: o.note } : { phase }, ctx.now), 'move')
}

function countArg(name: string, v: string | undefined): number | string | undefined {
  if (v === undefined) return undefined
  return /^\d{1,6}$/.test(v) ? Number(v) : `--${name} must be a whole number (got '${v}')`
}

export function flowStepCmd(o: { text?: string, done?: string, total?: string }, ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const text = (o.text ?? '').trim()
  if (text === '') return fail('usage', 'buracle flow step "<text>": missing <text>')
  const done = countArg('done', o.done)
  const total = countArg('total', o.total)
  if (typeof done === 'string') return fail('usage', done)
  if (typeof total === 'string') return fail('usage', total)
  const input: { text: string, done?: number, total?: number } = { text }
  if (done !== undefined) input.done = done
  if (total !== undefined) input.total = total
  return apply(s, rec => flowStep(rec, input, ctx.now), 'update')
}

export function flowEndCmd(o: { outcome?: string }, ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const outcome = (o.outcome ?? 'done').toLowerCase() as FlowOutcome
  if (!FLOW_OUTCOMES.includes(outcome)) return fail('usage', `--outcome must be one of ${FLOW_OUTCOMES.join(', ')} (got '${o.outcome}')`)
  return apply(s, rec => flowEnd(rec, outcome, ctx.now), 'end')
}

export function bandInputFor(h: Harness, sid: string, nowMs: number, foldAfterSec = DEFAULT_FOLD_SEC): BandInput {
  const input: BandInput = { nowMs, foldAfterSec }
  const flow = readFlow(h, sid)
  if (flow !== undefined) input.flow = flow
  const state = loadState(h, sid)
  if (state.plan !== undefined) {
    const text = readTextSync(state.plan.path)
    const plan = bandPlanOf(state, text.ok ? text.value : undefined)
    if (plan !== undefined) input.plan = plan
  }
  const it = state.interaction
  if (it !== undefined) {
    input.interaction = { state: it.state }
    if (it.kind !== undefined) input.interaction.kind = it.kind
    if (it.reason !== undefined) input.interaction.reason = it.reason
  }
  return input
}

export function flowViewFor(h: Harness, sid: string, nowMs: number, foldAfterSec = DEFAULT_FOLD_SEC): BandView {
  return bandView(bandInputFor(h, sid, nowMs, foldAfterSec))
}

export function flowStatusCmd(ctx: WorkflowCtx, s: ResolvedSession | undefined): CmdResult {
  if (s === undefined) {
    return ok({ ok: true, flow: null, active: null, breadcrumb: [], view: null, session: null }, ['no session: no harness session id was found (see `buracle flow --help`)'])
  }
  const rec = readFlow(s.harness, s.sessionId)
  const view = flowViewFor(s.harness, s.sessionId, ctx.now)
  const lines = view.visible ? bandText(view) : [`No workflow is running in the ${s.harness} session ${s.sessionId}.`]
  return ok({ ok: true, flow: rec ?? null, active: entryJson(activeFlow(rec)), breadcrumb: flowBreadcrumb(rec), view, session: sessionJson(s) }, lines)
}

export function recordFlowStart(h: Harness, sid: string, input: { workflow: string, title?: string, source: FlowSource }, now: number): boolean {
  try {
    const r = flowStart(readFlow(h, sid), input, now)
    if (r.changed) writeFlow(h, sid, r.record)
    return r.changed
  } catch (e) {
    log('warn', 'recording a flow start failed', { h, sid, error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

export function syncFlowFromPlan(s: ResolvedSession, plan: { type: PlanType, status: PlanStatus, phase: PlanPhase, title?: string }, now: number): void {
  try {
    const r = flowFromPlan(readFlow(s.harness, s.sessionId), plan, now)
    if (r.changed) writeFlow(s.harness, s.sessionId, r.record)
  } catch (e) {
    log('warn', 'flow sync from the plan failed', { h: s.harness, sid: s.sessionId, error: e instanceof Error ? e.message : String(e) })
  }
}

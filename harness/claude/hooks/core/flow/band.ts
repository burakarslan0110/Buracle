import type { PlanStatus, PlanType } from '../plan/format'
import { parsePlan, planCriteria } from '../plan/format'
import type { SessionState } from '../plan/state'
import type { Segment } from '../status/model'
import { textWidth, truncateToWidth } from '../status/format'
import type { FlowPhaseDef } from './catalog'
import { flowDef } from './catalog'
import type { FlowEntry, FlowRecord, PlanPhase } from './record'
import { flowText, planFlowPhase, workflowOfPlanType } from './record'

export interface BandCriterion { id: string; status: 'open' | 'pass' | 'fail'; oracle: boolean }

export interface BandPlan {
  path: string
  type: PlanType
  status: PlanStatus
  phase: PlanPhase
  approved: boolean
  since: number
  title?: string
  done: number
  total: number
  current?: string
  rounds?: number
  criteria?: BandCriterion[]
}

export interface BandTodo { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string; id?: string }
export interface BandAgent { id: string; agentId?: string; label: string; startedAt: number }
export interface BandInteraction { state: 'running' | 'paused'; kind?: 'discussion' | 'decision' | 'manual'; reason?: string }

export interface BandInput {
  nowMs: number
  flow?: FlowRecord
  plan?: BandPlan
  interaction?: BandInteraction
  todos?: readonly BandTodo[]
  agents?: readonly BandAgent[]
  foldAfterSec: number
  hidden?: number
}

export type BandStatus = 'starting' | 'running' | 'approval' | 'waiting' | 'paused' | 'done' | 'failed' | 'cancelled'

export interface BandPhaseView { id: string; label: string; short: string; state: 'done' | 'current' | 'next' }

export interface BandView {
  visible: boolean
  workflow?: string
  breadcrumb: string[]
  title?: string
  status: BandStatus
  phases: BandPhaseView[]
  progress?: { done: number; total: number; unit: 'tasks' | 'criteria' | 'steps' }
  round?: number
  criteria?: BandCriterion[]
  current?: string
  agents: string[]
  note?: string
  elapsedMin?: number
  startedAt?: number
  endedAt?: number
}

export const BUILD_MAX_ROUNDS = 4

const STATUS_TEXT: Readonly<Record<BandStatus, string>> = {
  starting: 'starting', running: 'running', approval: 'awaiting approval', waiting: 'waiting for you',
  paused: 'paused', done: 'done', failed: 'failed', cancelled: 'cancelled',
}

type Color = NonNullable<Segment['color']>

const STATUS_COLOR: Readonly<Record<BandStatus, Color>> = {
  starting: 'gray', running: 'magenta', approval: 'cyan', waiting: 'yellow', paused: 'yellow', done: 'green', failed: 'red', cancelled: 'gray',
}

function hiddenView(): BandView {
  return { visible: false, breadcrumb: [], status: 'running', phases: [], agents: [] }
}

export function criteriaOf(markdown: string): BandCriterion[] {
  return planCriteria(markdown).slice(0, 12).map(c => ({ id: c.id, status: c.status, oracle: c.oracle }))
}

function planApproved(state: SessionState): boolean {
  const s = state.plan?.status
  return state.approvals?.planApprovedAt !== undefined || s === 'APPROVED' || s === 'IN_PROGRESS' || s === 'COMPLETE' || s === 'VERIFIED'
}

export function bandPlanOf(state: SessionState | undefined, planText: string | undefined): BandPlan | undefined {
  const b = state?.plan
  if (state === undefined || b === undefined) return undefined
  const out: BandPlan = { path: b.path, type: b.type, status: b.status, phase: b.phase, approved: planApproved(state), since: b.registeredAt, done: 0, total: 0 }
  if (typeof planText === 'string' && planText !== '') {
    const p = parsePlan(planText)
    out.done = p.tasks.filter(t => t.done).length
    out.total = p.tasks.length
    out.approved = out.approved || p.header.approved
    if (p.title.trim() !== '') out.title = flowText(p.title, 80)
    const open = p.tasks.find(t => !t.done)
    if (open !== undefined) out.current = flowText(`Task ${open.n}${open.title !== '' ? `: ${open.title}` : ''}`, 120)
    if (typeof p.header.rounds === 'number') out.rounds = p.header.rounds
    if (b.type === 'Build') {
      const c = criteriaOf(planText)
      if (c.length > 0) out.criteria = c
    }
  }
  return out
}

function finishedPlan(p: BandPlan): boolean {
  return p.status === 'VERIFIED' || p.status === 'SAVED' || p.phase === 'done'
}

function agentLabel(label: string): string {
  return flowText(label.replace(/^buracle:/, ''), 40)
}

export function bandView(i: BandInput): BandView {
  const now = Number.isFinite(i.nowMs) ? i.nowMs : 0
  const foldMs = Math.max(0, Number.isFinite(i.foldAfterSec) ? i.foldAfterSec : 0) * 1000
  const stack = i.flow?.stack ?? []
  const live = (e: FlowEntry) => e.ended === undefined || now - e.ended.at < foldMs
  let shownAt = -1
  for (let k = stack.length - 1; k >= 0; k--) if (live(stack[k] as FlowEntry)) { shownAt = k; break }
  let entry: FlowEntry | undefined = shownAt >= 0 ? stack[shownAt] : undefined
  let breadcrumb: string[] = shownAt >= 0 ? stack.slice(0, shownAt + 1).filter(e => live(e)).map(e => e.workflow) : []
  const plan = i.plan
  if (entry === undefined) {
    if (plan === undefined || finishedPlan(plan) || stack.length > 0) return hiddenView()
    entry = { workflow: workflowOfPlanType(plan.type), source: 'plan', startedAt: plan.since }
    breadcrumb = [entry.workflow]
  }
  if (i.hidden !== undefined && entry.startedAt <= i.hidden) return hiddenView()
  const matched = plan !== undefined && workflowOfPlanType(plan.type) === entry.workflow && plan.status !== 'SAVED' ? plan : undefined
  if (matched !== undefined && entry.ended === undefined && finishedPlan(matched) && stack.length > 0) return hiddenView()

  const def = flowDef(entry.workflow)
  const phaseId = entry.phase?.id ?? (matched !== undefined ? planFlowPhase(entry.workflow, matched) : undefined)
  const defs: readonly FlowPhaseDef[] = def?.phases ?? (phaseId !== undefined ? [{ id: phaseId, label: phaseId, short: phaseId }] : [])
  const at = phaseId !== undefined ? defs.findIndex(p => p.id === phaseId) : -1
  const allDone = entry.ended?.outcome === 'done'
  const phases: BandPhaseView[] = defs.map((p, k) => ({
    id: p.id, label: p.label, short: p.short,
    state: allDone || (at >= 0 && k < at) ? 'done' : k === at ? 'current' : 'next',
  }))

  let status: BandStatus
  if (entry.ended !== undefined) status = entry.ended.outcome
  else if (i.interaction?.state === 'paused') status = i.interaction.kind === 'decision' ? 'waiting' : 'paused'
  else if (entry.workflow === 'plan-build' && phaseId === 'approve' && matched !== undefined && !matched.approved) status = 'approval'
  else if (phaseId === undefined) status = 'starting'
  else status = 'running'

  const view: BandView = { visible: true, workflow: entry.workflow, breadcrumb, status, phases, agents: [] }
  if (entry.title !== undefined) view.title = entry.title
  else if (matched?.title !== undefined) view.title = matched.title

  if (matched !== undefined && entry.workflow === 'goal-build') {
    if ((phaseId === 'judge' || phaseId === 'verify' || phaseId === 'handback') && matched.criteria !== undefined) {
      view.progress = { done: matched.criteria.filter(c => c.status === 'pass').length, total: matched.criteria.length, unit: 'criteria' }
    } else if (matched.total > 0) view.progress = { done: matched.done, total: matched.total, unit: 'tasks' }
    if (phaseId === 'build' || phaseId === 'judge') view.round = (matched.rounds ?? 0) + 1
    if (matched.criteria !== undefined) view.criteria = matched.criteria
  } else if (matched !== undefined && (phaseId === 'implement' || phaseId === 'verify') && matched.total > 0) {
    view.progress = { done: matched.done, total: matched.total, unit: 'tasks' }
  } else if (entry.step?.total !== undefined && entry.step.total > 0) {
    view.progress = { done: entry.step.done ?? 0, total: entry.step.total, unit: 'steps' }
  }

  const step = entry.step !== undefined && (entry.phase === undefined || entry.step.at >= entry.phase.since) ? entry.step.text : undefined
  const todo = (i.todos ?? []).find(t => t.status === 'in_progress')
  const task = matched !== undefined && (phaseId === 'implement' || phaseId === 'build') ? matched.current : undefined
  const current = step ?? (todo !== undefined ? flowText(todo.activeForm ?? todo.content, 120) : undefined) ?? task
  if (current !== undefined && current !== '' && entry.ended === undefined) view.current = current
  if (entry.ended === undefined) view.agents = [...new Set((i.agents ?? []).map(a => agentLabel(a.label)).filter(a => a !== ''))].slice(0, 3)

  const reason = i.interaction?.state === 'paused' ? i.interaction.reason : undefined
  if (reason !== undefined && reason.trim() !== '' && entry.ended === undefined) view.note = flowText(reason, 120)
  else if (entry.phase?.note !== undefined && entry.ended === undefined) view.note = entry.phase.note
  if (entry.startedAt > 0) {
    view.startedAt = entry.startedAt
    view.elapsedMin = Math.max(0, Math.floor(((entry.ended?.at ?? now) - entry.startedAt) / 60_000))
  }
  if (entry.ended !== undefined) view.endedAt = entry.ended.at
  return view
}

interface Glyphs { dot: string; head: string; done: string; current: string; next: string; fail: string; sep: string; crumb: string; full: string; empty: string; step: string; agents: string; pass: string; open: string; oracle: string }

const UNICODE: Glyphs = { dot: '\u00B7', head: '\u25C6', done: '\u2713', current: '\u25CF', next: '\u25CB', fail: '\u2717', sep: '\u2501', crumb: '\u203A', full: '\u25B0', empty: '\u25B1', step: '\u25B8', agents: '\u27F3', pass: '\u2713', open: '\u25CB', oracle: '\u2605' }
const ASCII: Glyphs = { dot: '|', head: '*', done: '+', current: '>', next: '.', fail: 'x', sep: '-', crumb: '>', full: '#', empty: '-', step: '>', agents: '~', pass: '+', open: '.', oracle: '*' }

function seg(id: string, text: string, color?: Color, extra: { dim?: boolean; bold?: boolean } = {}): Segment {
  const s: Segment = { id, text }
  if (color !== undefined) s.color = color
  if (extra.dim === true) s.dim = true
  if (extra.bold === true) s.bold = true
  return s
}

function width(row: readonly Segment[]): number {
  return row.reduce((n, s) => n + textWidth(s.text), 0)
}

function fit(row: readonly Segment[], max: number): Segment[] {
  const out: Segment[] = []
  let used = 0
  for (const s of row) {
    const w = textWidth(s.text)
    if (used + w <= max) { out.push(s); used += w; continue }
    const room = max - used
    if (room >= 2) out.push({ ...s, text: truncateToWidth(s.text, room) })
    break
  }
  while (out.length > 0 && (out[out.length - 1] as Segment).text.trim() === '') out.pop()
  return out
}

function progressText(v: BandView, g: Glyphs, bar: boolean): string {
  const p = v.progress
  if (p === undefined) return ''
  let text = ` ${p.done}/${p.total}`
  if (bar && p.total > 0) {
    const cells = Math.min(10, p.total)
    const filled = Math.round((Math.min(p.done, p.total) / p.total) * cells)
    text += ` ${g.full.repeat(filled)}${g.empty.repeat(cells - filled)}`
  }
  return text
}

function roundText(v: BandView): string {
  if (v.round === undefined) return ''
  return v.round <= BUILD_MAX_ROUNDS ? ` R${v.round}/${BUILD_MAX_ROUNDS}` : ` R${v.round}`
}

function glyphOf(state: BandPhaseView['state'], v: BandView, g: Glyphs): string {
  if (state === 'done') return g.done
  if (state === 'current') return v.status === 'failed' || v.status === 'cancelled' ? g.fail : g.current
  return g.next
}

function phaseColor(state: BandPhaseView['state'], v: BandView): Color {
  if (state === 'done') return 'green'
  if (state === 'next') return 'gray'
  return STATUS_COLOR[v.status] === 'gray' ? 'magenta' : STATUS_COLOR[v.status]
}

type ChainForm = 'full' | 'label' | 'short' | 'window'

function phaseRow(v: BandView, g: Glyphs, form: ChainForm): Segment[] {
  const row: Segment[] = []
  const extras = (): Segment[] => {
    const out: Segment[] = []
    const r = roundText(v)
    if (r !== '') out.push(seg('band-round', r, 'magenta'))
    const p = progressText(v, g, form === 'full')
    if (p !== '') out.push(seg('band-progress', p, 'magenta'))
    return out
  }
  if (v.phases.length === 0) {
    row.push(seg('band-phase', `${g.current} ${v.workflow ?? ''}`, STATUS_COLOR[v.status]), ...extras())
    return row
  }
  const cur = v.phases.findIndex(p => p.state === 'current')
  if (form === 'window') {
    const done = v.phases.filter(p => p.state === 'done').length
    const next = v.phases.filter(p => p.state === 'next').length
    if (done > 0) row.push(seg('band-done', `${g.done}${done} `, 'green'))
    const p = cur >= 0 ? v.phases[cur] as BandPhaseView : undefined
    if (p !== undefined) row.push(seg(`band-phase-${p.id}`, `${glyphOf('current', v, g)} ${p.label}`, phaseColor('current', v), { bold: true }), ...extras())
    if (next > 0) row.push(seg('band-next', ` ${g.next}${next}`, 'gray', { dim: true }))
    return row
  }
  v.phases.forEach((p, k) => {
    if (k > 0) row.push(seg(`band-sep-${k}`, form === 'short' ? ' ' : ` ${g.sep} `, 'gray', { dim: true }))
    const label = form === 'short' ? p.short : p.label
    row.push(seg(`band-phase-${p.id}`, `${glyphOf(p.state, v, g)} ${label}`, phaseColor(p.state, v), p.state === 'current' ? { bold: true } : p.state === 'next' ? { dim: true } : {}))
    if (k === cur) row.push(...extras())
  })
  if (cur < 0 && v.progress !== undefined) row.push(...extras())
  if (form === 'full' && v.criteria !== undefined && v.criteria.length > 0) {
    row.push(seg('band-criteria', '  ', undefined))
    v.criteria.forEach((c, k) => {
      const mark = c.status === 'pass' ? g.pass : c.status === 'fail' ? g.fail : g.open
      const color: Color = c.status === 'pass' ? 'green' : c.status === 'fail' ? 'red' : 'gray'
      row.push(seg(`band-crit-${c.id}`, `${k > 0 ? ' ' : ''}${c.id}${c.oracle ? g.oracle : ''}${mark}`, color))
    })
  }
  return row
}

function elapsedText(min: number): string {
  return min < 1 ? '<1m' : min < 120 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60 > 0 ? `${min % 60}m` : ''}`
}

function headRow(v: BandView, g: Glyphs, columns: number): Segment[] {
  const right: Segment[] = [seg('band-status', STATUS_TEXT[v.status], STATUS_COLOR[v.status])]
  if (v.elapsedMin !== undefined) right.push(seg('band-elapsed', ` ${g.dot} ${elapsedText(v.elapsedMin)}`, 'gray', { dim: true }))
  const left: Segment[] = [seg('band-head', `${g.head} `, 'magenta'), seg('band-crumb', v.breadcrumb.join(` ${g.crumb} `), undefined, { bold: true })]
  if (v.title !== undefined && v.title !== '') left.push(seg('band-title', ` ${g.dot} ${v.title}`, 'gray', { dim: true }))
  const room = columns - width(right) - 1
  const head = fit(left, Math.max(0, room))
  const pad = columns - width(head) - width(right)
  return pad >= 1 ? [...head, seg('band-pad', ' '.repeat(pad)), ...right] : fit([...head, seg('band-pad', ' '), ...right], columns)
}

function detailRow(v: BandView, g: Glyphs): Segment[] {
  const row: Segment[] = []
  if ((v.status === 'waiting' || v.status === 'paused') && v.note !== undefined) {
    row.push(seg('band-note', `${g.step} ${STATUS_TEXT[v.status]}: ${v.note}`, 'yellow'))
  } else if (v.current !== undefined) row.push(seg('band-current', `${g.step} ${v.current}`))
  else if (v.note !== undefined) row.push(seg('band-note', `${g.step} ${v.note}`, 'gray', { dim: true }))
  if (v.agents.length > 0) row.push(seg('band-agents', `${row.length > 0 ? ` ${g.dot} ` : ''}${g.agents} ${v.agents.join(', ')}`, 'cyan'))
  return row
}

export function bandRows(v: BandView, columns: number, maxRows: number, emoji: boolean, opts: { reserve?: number } = {}): Segment[][] {
  const cols = Math.floor(Number.isFinite(columns) ? columns : 0)
  const rows = Math.min(3, Math.floor(Number.isFinite(maxRows) ? maxRows : 0))
  if (!v.visible || cols < 24 || rows < 1) return []
  const g = emoji ? UNICODE : ASCII
  const reserve = Math.max(0, Math.min(Math.floor(opts.reserve ?? 0), cols - 24))
  const chain = (forms: readonly ChainForm[]): Segment[] => {
    for (const f of forms) {
      const row = phaseRow(v, g, f)
      if (width(row) <= cols) return row
    }
    return fit(phaseRow(v, g, 'window'), cols)
  }
  if (cols >= 96 && rows >= 2) {
    const out = [headRow(v, g, cols - reserve), chain(['full', 'label', 'short', 'window'])]
    const detail = detailRow(v, g)
    if (rows >= 3 && detail.length > 0) out.push(fit(detail, cols))
    return out
  }
  if (cols >= 56 && rows >= 2) return [headRow(v, g, cols - reserve), chain(['label', 'short', 'window'])]
  const one: Segment[] = [seg('band-crumb', `${v.breadcrumb.join(` ${g.crumb} `)} `, undefined, { bold: true })]
  const cur = v.phases.find(p => p.state === 'current')
  if (cur !== undefined) one.push(seg(`band-phase-${cur.id}`, `${glyphOf('current', v, g)} ${cur.label}`, phaseColor('current', v), { bold: true }))
  else if (v.status === 'done') one.push(seg('band-phase', `${g.done} done`, 'green'))
  const r = roundText(v)
  if (r !== '') one.push(seg('band-round', r, 'magenta'))
  const p = progressText(v, g, false)
  if (p !== '') one.push(seg('band-progress', p, 'magenta'))
  if (v.status !== 'running' && v.status !== 'starting' && v.status !== 'done') one.push(seg('band-status', ` ${g.dot} ${STATUS_TEXT[v.status]}`, STATUS_COLOR[v.status]))
  if (width(one) > cols && v.breadcrumb.length > 1) one[0] = seg('band-crumb', `${v.workflow ?? ''} `, undefined, { bold: true })
  return [fit(one, cols)]
}

export function bandText(v: BandView): string[] {
  if (!v.visible) return ['No workflow is running.']
  const head = `${v.breadcrumb.join(' \u203A ')}${v.title !== undefined ? ` \u00B7 ${v.title}` : ''} \u00B7 ${STATUS_TEXT[v.status]}${v.elapsedMin !== undefined ? ` \u00B7 ${elapsedText(v.elapsedMin)}` : ''}`
  const lines = [head]
  if (v.phases.length > 0) {
    const g = UNICODE
    lines.push(`phases: ${v.phases.map(p => `${glyphOf(p.state, v, g)} ${p.label}`).join('  ')}`)
  }
  const extra = [roundText(v).trim(), v.progress !== undefined ? `${v.progress.done}/${v.progress.total} ${v.progress.unit}` : ''].filter(x => x !== '')
  if (extra.length > 0) lines.push(`progress: ${extra.join(' \u00B7 ')}`)
  if (v.criteria !== undefined && v.criteria.length > 0) lines.push(`criteria: ${v.criteria.map(c => `${c.id}${c.oracle ? ' (oracle)' : ''} ${c.status}`).join(', ')}`)
  if (v.current !== undefined) lines.push(`now: ${v.current}`)
  if (v.agents.length > 0) lines.push(`agents: ${v.agents.join(', ')}`)
  if (v.note !== undefined) lines.push(`note: ${v.note}`)
  return lines
}

export function bandSummary(v: BandView): string {
  if (!v.visible) return ''
  const cur = v.phases.find(p => p.state === 'current')
  const parts: string[] = []
  if (cur !== undefined) parts.push(`phase ${cur.label}`)
  if (v.progress !== undefined) parts.push(`${v.progress.done}/${v.progress.total} ${v.progress.unit}`)
  if (v.status !== 'running' && v.status !== 'starting') parts.push(STATUS_TEXT[v.status])
  const head = `${v.breadcrumb.join(' > ')}${v.title !== undefined ? ` (${v.title})` : ''}`
  const tail = v.current !== undefined ? `; now: ${v.current}` : ''
  return flowText(`${head}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}${tail}`, 240)
}

const NOTICE_STATUSES: ReadonlySet<BandStatus> = new Set(['approval', 'waiting', 'paused', 'done', 'failed', 'cancelled'])

export function bandNotice(v: BandView): { key: string, text: string } | undefined {
  if (!v.visible || !NOTICE_STATUSES.has(v.status)) return undefined
  const summary = bandSummary(v)
  if (summary === '') return undefined
  return { key: `${v.workflow ?? v.breadcrumb.join('>')}#${v.startedAt ?? 0}:${v.status}`, text: `Buracle workflow: ${summary}` }
}

export function resumeSuggestion(v: BandView): string | undefined {
  if (!v.visible || v.status === 'done' || v.status === 'failed' || v.status === 'cancelled') return undefined
  const cur = v.phases.find(p => p.state === 'current')
  const progress = v.progress !== undefined ? ` ${v.progress.done}/${v.progress.total}` : ''
  const where = cur !== undefined ? ` (${cur.label}${progress})` : ''
  return flowText(`continue the ${v.breadcrumb.join(' \u203A ')} run${where}${v.title !== undefined ? `: ${v.title}` : ''}`, 160)
}

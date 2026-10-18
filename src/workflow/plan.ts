import { openSync, closeSync, writeSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { PlanStatus, PlanType } from '../core/plan/format'
import { criteriaTable, planSkeleton, validatePlan, type Finding } from '../core/plan/format'
import type { SessionState } from '../core/plan/state'
import { approveResult, dropResultApproval, goalVerificationOf, isPlanFinished, lockedSwitchesText, needsResultApproval, resumePlan, type LockedSwitches } from '../core/plan/state'
import { nativeBinding, withoutNativeBinding } from '../core/plan/native'
import { RESULT_REVIEW_REASON, VERIFICATION_OFF_REASON, isResultReview } from '../core/policy/intents'
import { loadConfigSync } from '../engine/config'
import { revParse } from '../engine/git'
import type { ResolvedSession } from './session-store'
import { loadState, updateState } from './session-store'
import { parseFrontmatter } from '../core/frontmatter'
import {
  PHASES, SETTABLE_STATUSES, analyzePlan, isValidSlug, localDate, normalizePhase, normalizeStatus, parseBool,
  planSections, readPlanFile, sectionFilled, slugFromPlanPath, slugFromTitle, updateFrontmatterText, writePlanHeader,
  type HeaderValue, type Phase, type PlanInfo,
} from './plan-file'
import { syncFlowFromPlan } from './flow'
import { clearLaneReviews, reviewWarnings, reviewsView, type LaneOwner } from './plan-review'
import { fail, isResult, ok, partial, sessionJson, type CmdResult, type WorkflowCtx } from './result'

type Binding = NonNullable<SessionState['plan']>
type Interaction = NonNullable<SessionState['interaction']>
export type PauseKind = NonNullable<Interaction['kind']>

export const PAUSE_KINDS: readonly PauseKind[] = ['discussion', 'decision', 'manual']
const PAUSE_RANK: Record<PauseKind, number> = { discussion: 1, decision: 2, manual: 3 }

const INIT_TYPES: Record<string, PlanType> = { feature: 'Feature', bugfix: 'Bugfix', build: 'Build' }

function display(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

export function inferPhase(info: Pick<PlanInfo, 'status' | 'approved' | 'phase'>): Phase {
  if (info.phase !== undefined) return info.phase
  if (info.status === 'SAVED') return 'plan'
  if (info.status === 'VERIFIED') return 'done'
  if (info.status === 'COMPLETE') return 'verify'
  if (info.approved !== true) return 'plan'
  return 'implement'
}

export interface PlanView {
  path: string
  slug: string
  type: PlanType
  status: PlanStatus
  phase: Phase
  approved: boolean
  worktree: boolean
  title?: string
  iterations?: number
  rounds?: number
  registeredAt: number
}

function planView(b: Binding, state: SessionState, info?: PlanInfo): PlanView {
  const v: PlanView = {
    path: b.path, slug: b.slug, type: b.type, status: b.status, phase: b.phase,
    approved: info?.approved ?? state.approvals?.planApprovedAt !== undefined,
    worktree: info?.worktree ?? false,
    registeredAt: b.registeredAt,
  }
  if (info?.title !== undefined) v.title = info.title
  if (info?.iterations !== undefined) v.iterations = info.iterations
  if (info?.rounds !== undefined) v.rounds = info.rounds
  return v
}

function interactionView(i: Interaction | undefined): Record<string, unknown> {
  if (i === undefined) return { state: 'running' }
  const out: Record<string, unknown> = { state: i.state }
  if (i.kind !== undefined) out['kind'] = i.kind
  out['since'] = i.since
  if (i.reason !== undefined) out['reason'] = i.reason
  return out
}

function flowPlan(b: Binding, info: PlanInfo | undefined): Parameters<typeof syncFlowFromPlan>[1] {
  return info?.title !== undefined ? { type: b.type, status: b.status, phase: b.phase, title: info.title } : { type: b.type, status: b.status, phase: b.phase }
}

function boundPlan(s: ResolvedSession): { state: SessionState, plan: Binding } | CmdResult {
  const state = loadState(s.harness, s.sessionId)
  if (state.plan === undefined) {
    return fail('no_plan', `no plan is registered in this ${s.harness} session (${s.sessionId}); run 'buracle plan register <path>' first`, { session: sessionJson(s) })
  }
  return { state, plan: state.plan }
}

function readBound(b: Binding): { text: string, info: PlanInfo } | CmdResult {
  const r = readPlanFile(b.path)
  if (!r.ok) {
    return fail(r.code === 'missing' ? 'plan_missing' : 'plan_unreadable', `${r.error}; re-register the plan at its new path ('buracle plan register <path>') or run 'buracle plan unregister'`, { path: b.path })
  }
  if (!r.info.hasFrontmatter) return fail('no_frontmatter', `${b.path} has no YAML frontmatter header`, { path: b.path })
  return { text: r.text, info: r.info }
}

export async function planInit(o: { type?: string, title?: string, slug?: string, dir?: string }, ctx: WorkflowCtx, s?: ResolvedSession): Promise<CmdResult> {
  const type = o.type === undefined ? undefined : INIT_TYPES[o.type.toLowerCase()]
  if (type === undefined) return fail('usage', `--type must be feature, bugfix or build${o.type !== undefined ? ` (got '${o.type}')` : ''}`)
  const title = (o.title ?? '').trim()
  if (title === '') return fail('usage', '--title "<title>" is required')
  if (/[\r\n]/.test(title)) return fail('usage', '--title must be a single line')
  if (o.slug !== undefined && !isValidSlug(o.slug)) return fail('usage', `--slug must be kebab-case ASCII (a-z, 0-9, '-'), at most 64 characters (got '${o.slug}')`)
  const root = (await revParse(ctx.cwd, '--show-toplevel')) ?? ctx.cwd
  const dir = o.dir !== undefined ? resolve(root, o.dir) : join(root, 'docs', type === 'Build' ? 'builds' : 'plans')
  const baseSlug = o.slug ?? slugFromTitle(title)
  const created = localDate(ctx.now)
  let content: string
  try {
    content = planSkeleton({ type, title, created })
    if (s !== undefined) content = updateFrontmatterText(content, { harness: s.harness })
  } catch (e) {
    return fail('skeleton_failed', `could not build the plan skeleton: ${e instanceof Error ? e.message : String(e)}`)
  }
  content = content.replace(/\r\n/g, '\n')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return fail('io', `cannot create ${dir}: ${e instanceof Error ? e.message : String(e)}`)
  }
  for (let n = 1; n <= 50; n++) {
    const slug = n === 1 ? baseSlug : `${baseSlug}-${n}`
    const path = join(dir, `${created}-${slug}.md`)
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o644)
    } catch (e) {
      if ((e as { code?: string }).code === 'EEXIST') continue
      return fail('io', `cannot write ${path}: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      const buf = Buffer.from(content, 'utf8')
      let off = 0
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
    } finally {
      closeSync(fd)
    }
    return ok({ ok: true, path, slug, type, title, created, ...(s !== undefined ? { harness: s.harness } : {}) }, [path])
  }
  return fail('exists', `50 plan files named ${created}-${baseSlug}*.md already exist in ${dir}; pass --slug`)
}

export function planValidate(pathArg: string | undefined, strict: boolean, ctx: WorkflowCtx): CmdResult {
  if (pathArg === undefined) return fail('usage', 'missing <path>: buracle plan validate <path> [--strict] [--json]')
  const path = resolve(ctx.cwd, pathArg)
  const r = readPlanFile(path)
  if (!r.ok) return fail(r.code === 'missing' ? 'plan_missing' : 'plan_unreadable', r.error, { path })
  let findings: Finding[]
  try {
    findings = validatePlan(r.text, { strict })
  } catch (e) {
    return fail('validator_unavailable', `the plan validator failed: ${e instanceof Error ? e.message : String(e)}`, { path })
  }
  const errors = findings.filter(f => f.level === 'error').length
  const warnings = findings.filter(f => f.level === 'warning').length
  const code = errors > 0 ? 1 : strict && warnings > 0 ? 2 : 0
  const shown = display(path, ctx.cwd)
  const lines = findings.map(f => `${shown}${f.line !== undefined ? `:${f.line}` : ''}: ${f.level} ${f.code}: ${f.message}`)
  lines.push(errors === 0 && warnings === 0 ? `${shown}: ok` : `${shown}: ${errors} error(s), ${warnings} warning(s)${code === 2 ? ' (warnings fail with --strict)' : ''}`)
  return { code, data: { path, ok: code === 0, strict, errors, warnings, findings }, lines, errors: [] }
}

export async function planRegister(pathArg: string | undefined, phaseArg: string | undefined, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  if (pathArg === undefined) return fail('usage', 'missing <path>: buracle plan register <path> [--phase plan|implement|verify]')
  let phase: Phase | undefined
  if (phaseArg !== undefined) {
    phase = normalizePhase(phaseArg)
    if (phase === undefined) return fail('usage', `--phase must be one of ${PHASES.join(', ')} (got '${phaseArg}')`)
  }
  const path = resolve(ctx.cwd, pathArg)
  const r = readPlanFile(path)
  if (!r.ok) return fail(r.code === 'missing' ? 'plan_missing' : 'plan_unreadable', r.error, { path })
  const info = r.info
  if (!info.hasFrontmatter) return fail('no_frontmatter', `${path} has no YAML frontmatter header (created, status, approved, worktree, type); create plans with 'buracle plan init'`, { path })
  if (info.status === undefined || info.type === undefined) {
    const what = [info.status === undefined ? 'status' : '', info.type === undefined ? 'type' : ''].filter(Boolean).join(' and ')
    return fail('invalid_header', `${path}: frontmatter ${what} missing or invalid${info.problems.length > 0 ? ` (${info.problems.join('; ')})` : ''}`, { path })
  }
  const status = info.status
  const type = info.type
  const finished = status === 'VERIFIED' || status === 'SAVED'
  if (phase === 'done' && !finished) {
    return fail('usage', `--phase done is only for a VERIFIED plan (this one is ${status}); finish a plan with 'buracle plan verify'`, { path })
  }
  const warnings: string[] = []
  let effectivePhase = phase ?? inferPhase(info)
  if (effectivePhase === 'done' && !finished) {
    effectivePhase = inferPhase({ status, ...(info.approved !== undefined ? { approved: info.approved } : {}) })
    warnings.push(`the plan file says phase: done but its status is ${status}; registered in phase ${effectivePhase} ('buracle plan verify' finishes a plan)`)
  }
  const slug = slugFromPlanPath(path)
  let replaced: Binding | undefined
  const next = updateState(s.harness, s.sessionId, st => {
    const same = st.plan?.path === path
    if (!same && st.plan !== undefined) replaced = st.plan
    const out: SessionState = { ...st }
    out.plan = { path, slug, status, type, phase: effectivePhase, registeredAt: same && st.plan !== undefined ? st.plan.registeredAt : ctx.now }
    if (!same) {
      out.guard = { blocksForPlan: 0, blocksInChain: 0 }
      delete out.interaction
      delete out.reviews
      delete out.native
      const kept = dropResultApproval(out)
      const { switches: _old, ...rest } = kept.approvals ?? {}
      if (Object.keys(rest).length === 0) delete out.approvals
      else out.approvals = rest
    }
    if (info.approved === true) {
      out.approvals = { ...(out.approvals ?? {}), planApprovedAt: same ? st.approvals?.planApprovedAt ?? ctx.now : ctx.now }
      if (type === 'Build' && out.approvals.switches === undefined) out.approvals.switches = currentSwitches()
    } else if (out.approvals !== undefined) {
      const { planApprovedAt: _drop, switches: _sw, ...rest } = out.approvals
      if (Object.keys(rest).length > 0) out.approvals = rest
      else delete out.approvals
    }
    return out
  })
  if ((effectivePhase === 'implement' || effectivePhase === 'verify') && info.approved !== true && type !== 'Plan') {
    warnings.push(`the plan is not approved (approved: false), but it was registered in phase ${effectivePhase}; plans are approved before implementation`)
  }
  if (replaced !== undefined && replaced.status !== 'VERIFIED') warnings.push(`replaced the earlier binding ${replaced.path} (status ${replaced.status}); run 'buracle plan register ${replaced.path}' to go back to it`)
  const b = next.plan as Binding
  syncFlowFromPlan(s, flowPlan(b, info), ctx.now)
  const view = planView(b, next, info)
  const lines = [
    `Registered ${display(path, ctx.cwd)} (${type}, ${status}, phase ${effectivePhase}) for the ${s.harness} session ${s.sessionId}.`,
  ]
  return ok({ ok: true, plan: view, tasks: { done: info.tasks.done, total: info.tasks.total }, session: sessionJson(s) }, lines, warnings)
}

export function planStatus(ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const state = loadState(s.harness, s.sessionId)
  const interaction = interactionView(state.interaction)
  if (state.plan === undefined) {
    const lines = [`No plan is registered in the ${s.harness} session ${s.sessionId}.`]
    if (state.interaction?.state === 'paused') lines.push(`Interaction: paused (${state.interaction.kind ?? 'discussion'})${state.interaction.reason !== undefined ? `: ${state.interaction.reason}` : ''}`)
    return ok({ plan: null, status: null, phase: null, tasks: { done: 0, total: 0 }, interaction, session: sessionJson(s) }, lines)
  }
  const b = state.plan
  const r = readPlanFile(b.path)
  const warnings: string[] = []
  let info: PlanInfo | undefined
  const data: Record<string, unknown> = {}
  if (r.ok) {
    info = r.info
    const drift: Record<string, unknown> = {}
    if (info.status !== undefined && info.status !== b.status) drift['status'] = info.status
    if (info.type !== undefined && info.type !== b.type) drift['type'] = info.type
    if (Object.keys(drift).length > 0) {
      data['file'] = drift
      warnings.push(`the plan file says ${Object.entries(drift).map(([k, v]) => `${k}: ${String(v)}`).join(', ')} but the session has ${Object.keys(drift).map(k => `${k}: ${String((b as unknown as Record<string, unknown>)[k])}`).join(', ')}; status changes go through 'buracle plan set status …' (the session value is the one the stop guard uses)`)
    }
    for (const p of info.problems) warnings.push(`${display(b.path, ctx.cwd)}: ${p}`)
  } else {
    data['fileMissing'] = true
    warnings.push(`${r.error}; re-register the plan or run 'buracle plan unregister'`)
  }
  const tasks = info !== undefined ? { done: info.tasks.done, total: info.tasks.total } : { done: 0, total: 0 }
  const view = planView(b, state, info)
  const lines = [
    `Plan: ${display(b.path, ctx.cwd)}${view.title !== undefined ? ` — ${view.title}` : ''}`,
    `Status: ${b.status} · phase ${b.phase} · ${b.type} · approved ${view.approved ? 'yes' : 'no'} · tasks ${tasks.done}/${tasks.total}${view.worktree ? ' · worktree' : ''}`,
    `Interaction: ${state.interaction?.state === 'paused' ? `paused (${state.interaction.kind ?? 'discussion'})${state.interaction.reason !== undefined ? `: ${state.interaction.reason}` : ''}` : 'running'}`,
  ]
  if (info !== undefined && info.tasks.open.length > 0 && info.tasks.open.length <= 12) {
    lines.push(`Open tasks: ${info.tasks.open.map(t => `${t.n}${t.title !== '' ? ` (${t.title})` : ''}`).join(', ')}`)
  }
  const reviews = reviewsView(state)
  if (reviews.length > 0) data['reviews'] = reviews
  const native = nativeBinding(state)
  if (native !== undefined) {
    data['native'] = { path: native.path, preparedAt: native.at }
    lines.push("Plan mode: prepared (buracle plan prepare-native); the plan approved when the session leaves the harness's plan mode fills this file")
  }
  return ok({ plan: view, status: b.status, phase: b.phase, tasks, interaction, session: sessionJson(s), ...data }, lines, warnings)
}

interface Transition {
  header: Record<string, HeaderValue>
  state: (st: SessionState, b: Binding) => SessionState
}

async function apply(t: Transition, b: Binding, text: string, _ctx: WorkflowCtx, s: ResolvedSession): Promise<{ state: SessionState, info: PlanInfo } | CmdResult> {
  let newText = text
  if (Object.keys(t.header).length > 0) {
    try {
      newText = writePlanHeader(b.path, text, t.header)
    } catch (e) {
      return fail('write_failed', `could not update ${b.path}: ${e instanceof Error ? e.message : String(e)}`, { path: b.path })
    }
  }
  let state: SessionState
  try {
    state = updateState(s.harness, s.sessionId, st => (st.plan !== undefined && st.plan.path === b.path ? t.state(st, st.plan) : st))
  } catch (e) {
    return fail('state_failed', `the plan file was updated but the session state could not be saved (${e instanceof Error ? e.message : String(e)}); re-run the command`, { path: b.path })
  }
  const r = readPlanFile(b.path)
  const info = r.ok ? r.info : analyzePlan(newText)
  return { state, info }
}

function withPlan(st: SessionState, b: Binding, patch: Partial<Binding>): SessionState {
  return { ...st, plan: { ...b, ...patch } }
}

const DECISION_ACTED = 'Resumed: the pending decision was acted on, so the pause ended and the stop guard holds the run again.'

function decisionHeld(st: SessionState): boolean {
  return st.interaction?.state === 'paused' && st.interaction.kind === 'decision'
}

function actOnDecision(st: SessionState, now: number): SessionState {
  return decisionHeld(st) ? resumePlan(st, now) : st
}

export const MERGE_DECISION_ACTED = 'Resumed: the merge decision was acted on, so the pause ended and the stop guard holds the run again.'

export function actOnMergeDecision(s: ResolvedSession | undefined, wt: { slug: string, planPath?: string, lane?: boolean }, now: number): string | undefined {
  if (s === undefined || wt.lane === true) return undefined
  const merging = (st: SessionState): boolean => {
    const p = st.plan
    if (p === undefined || isPlanFinished(st) || p.phase !== 'verify' || !decisionHeld(st) || isResultReview(st.interaction)) return false
    return wt.planPath !== undefined ? wt.planPath === p.path : wt.slug === p.slug
  }
  if (!merging(loadState(s.harness, s.sessionId))) return undefined
  let acted = false
  updateState(s.harness, s.sessionId, st => {
    if (!merging(st)) return st
    acted = true
    return resumePlan(st, now)
  })
  return acted ? MERGE_DECISION_ACTED : undefined
}

export function resultApprovalOn(): boolean {
  try { return loadConfigSync().config.plan.resultApproval !== false } catch { return true }
}

export function goalVerificationOn(): boolean {
  try { return loadConfigSync().config.plan.goalVerification !== false } catch { return true }
}

export function currentSwitches(): LockedSwitches {
  try {
    const p = loadConfigSync().config.plan
    return { goalVerification: p.goalVerification !== false, changesReview: p.reviews?.changes !== false }
  } catch {
    return { goalVerification: true, changesReview: true }
  }
}

const VERIFICATION_OFF = `plan.goalVerification is off, so a build run is not verified: write "Verification: disabled (plan.goalVerification)" under '## Unverified' and hand back with 'buracle plan pause --kind decision --reason "${VERIFICATION_OFF_REASON}"' (the run stays COMPLETE)`

function completeBlockers(info: PlanInfo, b: Binding): string[] {
  const out: string[] = []
  if (info.approved !== true) out.push("the plan is not approved (approved: false); approval comes first ('buracle plan set approved true' after the user approves)")
  if (info.tasks.total === 0) out.push('the plan has no tasks (### Task N: cards under ## Tasks)')
  for (const t of info.tasks.open) out.push(`Task ${t.n}${t.title !== '' ? ` (${t.title})` : ''} is not ticked: its line must read '- [x] Task ${t.n} done'`)
  if (b.status === 'VERIFIED') out.push('the plan is already VERIFIED')
  return out
}

export function evidenceBlockers(text: string, type: PlanType): string[] {
  if (type === 'Plan') return []
  const sections = planSections(parseFrontmatter(text).body)
  const need: Array<[string, string]> = [['Evidence', 'one row per check you ran: what, the command, the result']]
  if (type === 'Feature') {
    need.push(['DoD Audit', 'every task\'s Definition of Done checked against the evidence'])
    if ((sections.get('E2E Scenarios') ?? []).some(l => /\bSC-\d+/.test(l))) need.push(['E2E Results', 'the outcome of every SC-n scenario'])
  }
  if (type === 'Bugfix') need.push(['RED Evidence', 'the failing run of the reproducing test from Task 1'])
  return need
    .filter(([name]) => !sectionFilled(sections.get(name)))
    .map(([name, what]) => `missing evidence: the plan has no filled '## ${name}' section (${what}); record it before verifying`)
}

const BUILD_EXIT = "a build is VERIFIED only when every criterion passes; at the round limit or for a not-achievable criterion, hand back with 'buracle plan pause --kind decision' instead of verifying"

export function buildVerdictBlockers(text: string): string[] {
  const out: string[] = []
  const { criteria, unread } = criteriaTable(text)
  if (criteria.length === 0) out.push(`the run file has no criteria rows ('| C1 | ... | pass |') under '## Acceptance Criteria'; ${BUILD_EXIT}`)
  for (const u of unread) out.push(`line ${u.line} of '## Acceptance Criteria' is not a criterion row (${u.text.length > 60 ? `${u.text.slice(0, 57)}...` : u.text}): write it as '| C<n> | ... | pass |' so its verdict can be read`)
  for (const c of criteria) {
    if (c.status === 'pass') continue
    out.push(`${c.id}${c.oracle ? ' (oracle)' : ''} is ${c.status === 'fail' ? 'fail' : 'open (not judged yet)'}: ${BUILD_EXIT}`)
  }
  if (!sectionFilled(planSections(parseFrontmatter(text).body).get('Unverified'))) {
    out.push("missing evidence: the run file has no filled '## Unverified' section (each check you could not run, with the reason and the risk it leaves, or \"None.\"); record it before verifying")
  }
  return out
}

const RESULT_GATE = `the user has not approved the verified result yet (plan.resultApproval): show it to them (\`buracle plan pause --kind decision --reason "${RESULT_REVIEW_REASON}"\`, then ask), and after their explicit approval run 'buracle plan approve-result'; a bare "continue" or green checks are no approval`

function verifyBlockers(info: PlanInfo, b: Binding, text: string, state?: SessionState): string[] {
  const out: string[] = []
  if (b.status !== 'COMPLETE') out.push(`status is ${b.status}, not COMPLETE: finish the implementation and run 'buracle plan complete' first`)
  if (info.approved !== true) out.push('the plan is not approved (approved: false)')
  if (info.tasks.total === 0) out.push('the plan has no tasks (### Task N: cards under ## Tasks)')
  for (const t of info.tasks.open) out.push(`Task ${t.n}${t.title !== '' ? ` (${t.title})` : ''} is not ticked: its line must read '- [x] Task ${t.n} done'`)
  out.push(...evidenceBlockers(text, info.type ?? b.type))
  if ((info.type ?? b.type) === 'Build') {
    if (!(state !== undefined ? goalVerificationOf(state, goalVerificationOn()) : goalVerificationOn())) out.push(VERIFICATION_OFF)
    out.push(...buildVerdictBlockers(text))
  }
  if (state !== undefined && needsResultApproval(info.type ?? b.type, { resultApproval: resultApprovalOn() }) && state.approvals?.resultApprovedAt === undefined) out.push(RESULT_GATE)
  return out
}

function refused(action: string, b: Binding, reasons: string[], ctx: WorkflowCtx): CmdResult {
  return partial(
    { ok: false, refused: true, action, path: b.path, status: b.status, reasons },
    [],
    [`refused: ${action} ${display(b.path, ctx.cwd)}`, ...reasons.map(r => `  - ${r}`)],
  )
}

async function finishTransition(action: string, b: Binding, res: { state: SessionState, info: PlanInfo }, changed: Record<string, { from: unknown, to: unknown }>, ctx: WorkflowCtx, s: ResolvedSession, extraLines: string[] = [], warnings: string[] = []): Promise<CmdResult> {
  const nb = res.state.plan ?? b
  syncFlowFromPlan(s, flowPlan(nb, res.info), ctx.now)
  const view = planView(nb, res.state, res.info)
  const lines = Object.keys(changed).length === 0
    ? [`${action}: nothing to change (${display(nb.path, ctx.cwd)} is already ${nb.status}, phase ${nb.phase})`]
    : Object.entries(changed).map(([k, v]) => `${k}: ${String(v.from)} → ${String(v.to)}`)
  return ok({ ok: true, plan: view, changed }, [...lines, ...extraLines], warnings)
}

export async function planComplete(ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const bp = boundPlan(s)
  if (isResult(bp)) return bp
  const rb = readBound(bp.plan)
  if (isResult(rb)) return rb
  const b = bp.plan
  if (b.status === 'COMPLETE' && rb.info.status === 'COMPLETE') {
    const res = { state: bp.state, info: rb.info }
    return finishTransition('complete', b, res, {}, ctx, s)
  }
  const blockers = completeBlockers(rb.info, b)
  if (blockers.length > 0) return refused('complete', b, blockers, ctx)
  const held = decisionHeld(bp.state)
  const res = await apply({ header: { status: 'COMPLETE' }, state: (st, cur) => actOnDecision(withPlan(st, cur, { status: 'COMPLETE' }), ctx.now) }, b, rb.text, ctx, s)
  if (isResult(res)) return res
  return finishTransition('complete', b, res, { status: { from: b.status, to: 'COMPLETE' } }, ctx, s, ["Implementation complete; verification is next ('buracle plan set phase verify').", ...(held ? [DECISION_ACTED] : [])])
}

export async function planVerify(ctx: WorkflowCtx, s: ResolvedSession, action = 'verify'): Promise<CmdResult> {
  const bp = boundPlan(s)
  if (isResult(bp)) return bp
  const rb = readBound(bp.plan)
  if (isResult(rb)) return rb
  const b = bp.plan
  if (b.status === 'VERIFIED') {
    const changed: Record<string, { from: unknown, to: unknown }> = {}
    if (b.phase !== 'done' || rb.info.status !== 'VERIFIED' || rb.info.phase !== 'done') {
      const res = await apply({ header: { status: 'VERIFIED', phase: 'done' }, state: (st, cur) => withPlan(st, cur, { status: 'VERIFIED', phase: 'done' }) }, b, rb.text, ctx, s)
      if (isResult(res)) return res
      if (b.phase !== 'done') changed['phase'] = { from: b.phase, to: 'done' }
      return finishTransition(action, b, res, changed, ctx, s)
    }
    return finishTransition(action, b, { state: bp.state, info: rb.info }, changed, ctx, s)
  }
  const blockers = verifyBlockers(rb.info, b, rb.text, bp.state)
  if (blockers.length > 0) {
    if (action !== 'verify') blockers.push(`'buracle plan ${action}' is the same transition as 'buracle plan verify' (status VERIFIED, phase done)`)
    return refused(action, b, blockers, ctx)
  }
  const stale = await reviewWarnings('result', bp.state, ctx)
  const res = await apply({ header: { status: 'VERIFIED', phase: 'done' }, state: (st, cur) => withPlan(st, cur, { status: 'VERIFIED', phase: 'done' }) }, b, rb.text, ctx, s)
  if (isResult(res)) return res
  const changed: Record<string, { from: unknown, to: unknown }> = { status: { from: b.status, to: 'VERIFIED' } }
  if (b.phase !== 'done') changed['phase'] = { from: b.phase, to: 'done' }
  return finishTransition(action, b, res, changed, ctx, s, ['Plan VERIFIED; the stop guard releases this run.'], stale)
}

export const SET_FIELDS = ['status', 'phase', 'approved', 'iterations', 'rounds', 'worktree'] as const
export type SetField = typeof SET_FIELDS[number]

export async function planSet(field: string | undefined, value: string | undefined, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  if (field === undefined || !(SET_FIELDS as readonly string[]).includes(field)) {
    return fail('usage', `buracle plan set <field> <value>: field must be one of ${SET_FIELDS.join(', ')}${field !== undefined ? ` (got '${field}')` : ''}`)
  }
  if (value === undefined) return fail('usage', `buracle plan set ${field} <value>: missing value`)
  const f = field as SetField
  let status: PlanStatus | undefined
  let phase: Phase | undefined
  let flag: boolean | undefined
  let count: number | undefined
  if (f === 'status') {
    status = normalizeStatus(value)
    if (status === undefined || !SETTABLE_STATUSES.includes(status)) return fail('usage', `status must be one of ${SETTABLE_STATUSES.join(', ')} (got '${value}')`)
  } else if (f === 'phase') {
    phase = normalizePhase(value)
    if (phase === undefined) return fail('usage', `phase must be one of ${PHASES.join(', ')} (got '${value}')`)
  } else if (f === 'approved' || f === 'worktree') {
    flag = parseBool(value)
    if (flag === undefined) return fail('usage', `${f} must be true or false (got '${value}')`)
  } else {
    if (!/^\d{1,4}$/.test(value)) return fail('usage', `${f} must be a whole number from 0 to 9999 (got '${value}')`)
    count = Number(value)
  }
  if (status === 'COMPLETE') return planComplete(ctx, s)
  if (status === 'VERIFIED') return planVerify(ctx, s, 'set status VERIFIED')

  const bp = boundPlan(s)
  if (isResult(bp)) return bp
  const rb = readBound(bp.plan)
  if (isResult(rb)) return rb
  const b = bp.plan
  const info = rb.info

  if (f === 'phase' && phase === 'done' && b.status !== 'VERIFIED' && b.status !== 'SAVED') return planVerify(ctx, s, 'set phase done')

  if (b.status === 'VERIFIED' && (f === 'status' || f === 'approved' || (f === 'phase' && phase !== 'done'))) {
    return refused(`set ${f}`, b, ['the plan is VERIFIED and closed; start a new plan instead of reopening it'], ctx)
  }

  const changed: Record<string, { from: unknown, to: unknown }> = {}
  const held = decisionHeld(bp.state)
  let acts = false
  let t: Transition
  switch (f) {
    case 'status': {
      const to = status as PlanStatus
      if ((to === 'APPROVED' || to === 'IN_PROGRESS') && info.approved !== true) {
        return refused(`set status ${to}`, b, ["the plan is not approved yet: run 'buracle plan set approved true' after the user approves (or after locking a build contract)"], ctx)
      }
      if (b.status !== to) changed['status'] = { from: b.status, to }
      acts = to === 'APPROVED' || to === 'IN_PROGRESS'
      t = { header: info.status !== to ? { status: to } : {}, state: (st, cur) => dropResultApproval(acts ? actOnDecision(withPlan(st, cur, { status: to }), ctx.now) : withPlan(st, cur, { status: to })) }
      break
    }
    case 'phase': {
      const to = phase as Phase
      if ((to === 'implement' || to === 'verify') && info.approved !== true) {
        return refused(`set phase ${to}`, b, ["the plan is not approved yet: no implementation before approval ('buracle plan set approved true' after the user approves, or after locking a build contract)"], ctx)
      }
      if (b.phase !== to) changed['phase'] = { from: b.phase, to }
      acts = to === 'implement' || to === 'verify'
      const reopen = to === 'plan' || to === 'implement'
      t = {
        header: info.phase !== to ? { phase: to } : {},
        state: (st, cur) => {
          const moved = withPlan(st, cur, { phase: to })
          const next = acts ? actOnDecision(moved, ctx.now) : moved
          return reopen ? dropResultApproval(next) : next
        },
      }
      break
    }
    case 'approved': {
      const to = flag as boolean
      const build = (info.type ?? b.type) === 'Build'
      const from = info.approved ?? false
      if (from !== to) changed['approved'] = { from, to }
      acts = to
      t = {
        header: info.approved !== to ? { approved: to } : {},
        state: st => {
          if (to) {
            const approvals: NonNullable<SessionState['approvals']> = { ...(st.approvals ?? {}), planApprovedAt: st.approvals?.planApprovedAt ?? ctx.now }
            if (build) approvals.switches = st.approvals?.planApprovedAt !== undefined && st.approvals.switches !== undefined ? st.approvals.switches : currentSwitches()
            return actOnDecision({ ...withoutNativeBinding(st), approvals }, ctx.now)
          }
          const out = dropResultApproval(st)
          if (out.approvals !== undefined) {
            const { planApprovedAt: _drop, switches: _sw, ...rest } = out.approvals
            if (Object.keys(rest).length > 0) out.approvals = rest
            else delete out.approvals
          }
          return out
        },
      }
      break
    }
    case 'worktree': {
      const to = flag as boolean
      const from = info.worktree ?? false
      if (from !== to) changed['worktree'] = { from, to }
      t = { header: info.worktree !== to ? { worktree: to } : {}, state: st => st }
      break
    }
    case 'iterations':
    case 'rounds': {
      const expected = b.type === 'Build' ? 'rounds' : 'iterations'
      if (f !== expected) return fail('usage', `${b.type} plans count ${expected}, not ${f}: use 'buracle plan set ${expected} ${value}'`)
      const from = f === 'rounds' ? info.rounds : info.iterations
      if (from !== count) changed[f] = { from: from ?? null, to: count }
      t = { header: from !== count ? { [f]: count as number } : {}, state: st => st }
      break
    }
  }
  const res = await apply(t, b, rb.text, ctx, s)
  if (isResult(res)) return res
  const extra: string[] = []
  if (f === 'approved' && flag === false && (b.status === 'APPROVED' || b.status === 'IN_PROGRESS' || b.status === 'COMPLETE')) {
    extra.push(`Note: status is still ${b.status}; run 'buracle plan set status PENDING' to send the plan back to planning.`)
  }
  if (held && acts) extra.push(DECISION_ACTED)
  const locked = f === 'approved' && flag === true ? res.state.approvals?.switches : undefined
  if (locked !== undefined) extra.push(`Locked for this run: ${lockedSwitchesText(locked)} (a later config change does not alter them).`)
  const stale = f === 'approved' && flag === true ? await reviewWarnings('approve', res.state, ctx) : []
  return finishTransition(`set ${f}`, b, res, changed, ctx, s, extra, stale)
}

function pauseText(i: Interaction): string {
  return `${i.kind ?? 'discussion'}${i.reason !== undefined ? `: ${i.reason}` : ''}`
}

export function planPause(kindArg: string | undefined, reason: string | undefined, ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const kind = (kindArg ?? 'discussion').toLowerCase() as PauseKind
  if (!PAUSE_KINDS.includes(kind)) return fail('usage', `--kind must be one of ${PAUSE_KINDS.join(', ')} (got '${kindArg}')`)
  const given = reason?.trim()
  const trimmed = given !== undefined && given !== '' ? given : undefined
  const state = loadState(s.harness, s.sessionId)
  if (state.plan === undefined) {
    return ok({ ok: true, changed: false, plan: null, interaction: interactionView(state.interaction), note: 'no plan is registered; nothing to pause' },
      [`No plan is registered in the ${s.harness} session ${s.sessionId}; nothing to pause (the stop guard is not holding this session).`])
  }
  if (isPlanFinished(state)) {
    return ok({ ok: true, changed: false, plan: state.plan.path, interaction: interactionView(state.interaction), note: 'the plan is finished; nothing to pause' },
      [`${display(state.plan.path, ctx.cwd)} is ${state.plan.status} (phase ${state.plan.phase}); the stop guard no longer holds this session, so there is nothing to pause.`])
  }
  let changed = false
  let kept: { i: Interaction, why: 'weaker' | 'same' } | undefined
  const next = updateState(s.harness, s.sessionId, st => {
    if (st.plan === undefined || isPlanFinished(st)) return st
    const cur = st.interaction
    if (cur?.state === 'paused') {
      const curKind: PauseKind = cur.kind !== undefined && PAUSE_KINDS.includes(cur.kind) ? cur.kind : 'discussion'
      if (PAUSE_RANK[curKind] > PAUSE_RANK[kind]) { kept = { i: cur, why: 'weaker' }; return st }
      const nextReason = trimmed ?? cur.reason
      if (curKind === kind && nextReason === cur.reason) { kept = { i: cur, why: 'same' }; return st }
      changed = true
      const i: Interaction = { state: 'paused', kind, since: typeof cur.since === 'number' && Number.isFinite(cur.since) ? cur.since : ctx.now }
      if (nextReason !== undefined) i.reason = nextReason
      return { ...st, interaction: i }
    }
    changed = true
    const i: Interaction = { state: 'paused', kind, since: ctx.now }
    if (trimmed !== undefined) i.reason = trimmed
    return { ...st, interaction: i }
  })
  const i: Interaction = next.interaction ?? { state: 'running', since: ctx.now }
  const lines = kept !== undefined
    ? [kept.why === 'weaker' ? `Already paused (${pauseText(kept.i)}); a ${kind} pause does not replace it.` : `Already paused (${pauseText(kept.i)}); nothing changed.`]
    : [`Paused (${pauseText(i)})`, "The stop guard lets the turn end; run 'buracle plan resume' after the user answers."]
  return ok({ ok: true, changed, interaction: interactionView(next.interaction) }, lines)
}

export function planResume(ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const state = loadState(s.harness, s.sessionId)
  if (state.interaction?.state !== 'paused') {
    return ok({ ok: true, changed: false, interaction: interactionView(state.interaction) }, ['Nothing is paused.'])
  }
  const next = updateState(s.harness, s.sessionId, st => resumePlan(st, ctx.now))
  return ok({ ok: true, changed: true, interaction: interactionView(next.interaction) }, [`Resumed${state.plan !== undefined ? ` ${display(state.plan.path, ctx.cwd)}` : ''}.`])
}

export async function planApproveResult(ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const bp = boundPlan(s)
  if (isResult(bp)) return bp
  const b = bp.plan
  if (b.type === 'Build' || b.type === 'Plan') return refused('approve-result', b, [`a ${b.type} plan has no result review; finish it with 'buracle plan verify'`], ctx)
  if (b.status !== 'COMPLETE') return refused('approve-result', b, [`the result is approved after the verify checks, at status COMPLETE (the plan is ${b.status}); finish the implementation and the checks first`], ctx)
  const held = bp.state.interaction?.state === 'paused'
  const stale = await reviewWarnings('result', bp.state, ctx)
  const next = updateState(s.harness, s.sessionId, st => (st.plan !== undefined && st.plan.path === b.path ? approveResult(st, ctx.now) : st))
  const lines = [
    `Result approved for ${display(b.path, ctx.cwd)}.`,
    ...(held ? ['Resumed: the pause ended and the stop guard holds the run again.'] : []),
    "Next: the worktree merge if the run has one, then 'buracle plan verify'.",
  ]
  return ok({ ok: true, plan: b.path, resultApprovedAt: next.approvals?.resultApprovedAt ?? ctx.now, interaction: interactionView(next.interaction) }, lines, stale)
}

export async function planUnregister(ctx: WorkflowCtx, s: ResolvedSession, owner?: LaneOwner): Promise<CmdResult> {
  clearLaneReviews(owner)
  const state = loadState(s.harness, s.sessionId)
  if (state.plan === undefined) return ok({ ok: true, unregistered: null }, ['No plan is registered; nothing to do.'])
  const b = state.plan
  updateState(s.harness, s.sessionId, st => {
    const out: SessionState = { v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 } }
    for (const [k, v] of Object.entries(st)) {
      if (k === 'plan' || k === 'interaction' || k === 'approvals' || k === 'guard' || k === 'reviews' || k === 'native' || k === 'v') continue
      ;(out as unknown as Record<string, unknown>)[k] = v
    }
    return out
  })
  return ok({ ok: true, unregistered: b.path }, [`Unregistered ${display(b.path, ctx.cwd)}; the plan file is unchanged.`])
}

export async function markPlanWorktree(value: boolean, _ctx: WorkflowCtx, s: ResolvedSession): Promise<{ path: string, changed: boolean } | { error: string } | undefined> {
  const state = loadState(s.harness, s.sessionId)
  if (state.plan === undefined) return undefined
  const r = readPlanFile(state.plan.path)
  if (!r.ok) return { error: r.error }
  if (r.info.worktree === value) return { path: state.plan.path, changed: false }
  try {
    writePlanHeader(state.plan.path, r.text, { worktree: value })
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
  return { path: state.plan.path, changed: true }
}

import type { StopDecision, StopInput } from '../events'
import type { BuracleConfig } from '../config'
import type { Finding, PlanStatus, PlanType } from './format'
import { planOutline } from './format'
import { objectiveLine, planObjectiveOf, tickedTasks, type PlanObjective } from './objective'
import type { Intent } from '../policy/intents'
import type { LaneReview, ReviewRecord } from './reviews'
import type { NativeBinding } from './native'
import { nativeBinding } from './native'
import { GUARD_MARKERS, RUNAWAY_REASON, VERIFICATION_OFF_REASON, isResultReview, resumableDecision } from '../policy/intents'

export interface SessionState {
  v: 1
  plan?: { path: string; slug: string; status: PlanStatus; type: PlanType; phase: 'plan'|'implement'|'verify'|'done'; registeredAt: number }
  interaction?: { state: 'running'|'paused'; kind?: 'discussion'|'decision'|'manual'; since: number; reason?: string; answeredAt?: number }
  guard: { blocksForPlan: number; blocksInChain: number; lastBlockAt?: number; ticked?: number[]; escalated?: 'plan' | 'chain'; readOnlyNoticed?: true; earlyEditNoted?: true }
  approvals?: { planApprovedAt?: number; resultApprovedAt?: number; switches?: LockedSwitches }
  reviews?: ReviewRecord[]
  laneReviews?: LaneReview[]
  native?: NativeBinding
}

export interface LockedSwitches { goalVerification: boolean; changesReview: boolean }

export function lockedSwitchesText(sw: LockedSwitches): string {
  return `reviews.changes ${sw.changesReview ? 'on' : 'off'}, goalVerification ${sw.goalVerification ? 'on' : 'off'}`
}

export function goalVerificationOf(state: SessionState, live: boolean | undefined): boolean {
  const locked = state?.approvals?.switches?.goalVerification
  return typeof locked === 'boolean' ? locked : live !== false
}

export const STOP_GUARD_ESCAPE = 'The only way out is a pause: `buracle plan pause` (before a real question or a hand-back), or the user saying "stop", "wait" or "hold on" (or the same in their language), which Buracle records as a pause (run `buracle plan pause --kind discussion` too).'

export type StopWhy = 'disabled' | 'no-plan' | 'finished' | 'paused' | 'awaiting-approval' | 'question' | 'runaway-plan' | 'runaway-chain' | 'blocked' | 'plan-invalid'
  | 'background-wait' | 'read-only-mode' | 'runaway-escalate' | 'decision-answered'

export const ROUTE_AUDIT_AFTER: readonly StopWhy[] = ['finished', 'no-plan', 'disabled']

export function routeAuditAllowed(why: StopWhy | undefined, strictness: BuracleConfig['routing']['strictness']): boolean {
  return strictness !== 'off' && why !== undefined && ROUTE_AUDIT_AFTER.includes(why)
}

export const AUTO_PAUSE_REASON = 'the user sent a message while the plan was running (plan.autoPause)'

export const STOP_REASON_MAX = 1200
const TICKED_MAX = 200

export function emptyState(): SessionState {
  return { v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 } }
}

function isApproved(state: SessionState): boolean {
  const p = state.plan
  if (!p) return false
  if (state.approvals?.planApprovedAt !== undefined) return true
  return p.status === 'APPROVED' || p.status === 'IN_PROGRESS' || p.status === 'COMPLETE' || p.status === 'VERIFIED'
}

function isFinished(state: SessionState): boolean {
  const p = state.plan
  return p !== undefined && (p.status === 'VERIFIED' || p.status === 'SAVED' || p.phase === 'done')
}

export function isPlanFinished(state: SessionState): boolean {
  return state !== null && typeof state === 'object' && isFinished(state)
}

export function needsResultApproval(type: PlanType | undefined, cfg: Partial<Pick<BuracleConfig['plan'], 'resultApproval'>> | undefined): boolean {
  return cfg?.resultApproval !== false && (type === 'Feature' || type === 'Bugfix')
}

type Guard = SessionState['guard']

function cleanGuard(state: SessionState): Guard {
  const g = (state.guard ?? {}) as Partial<Guard>
  const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0)
  const out: Guard = { blocksForPlan: n(g.blocksForPlan), blocksInChain: n(g.blocksInChain) }
  if (g.lastBlockAt !== undefined) out.lastBlockAt = g.lastBlockAt
  if (Array.isArray(g.ticked)) {
    const ticked = [...new Set(g.ticked.filter((t): t is number => Number.isInteger(t) && t > 0))].sort((a, b) => a - b).slice(0, TICKED_MAX)
    if (ticked.length > 0) out.ticked = ticked
  }
  if (g.escalated === 'plan' || g.escalated === 'chain') out.escalated = g.escalated
  if (g.readOnlyNoticed === true) out.readOnlyNoticed = true
  if (g.earlyEditNoted === true) out.earlyEditNoted = true
  return out
}

function withoutEscalation(g: Guard): Guard {
  const { escalated: _drop, ...rest } = g
  return rest
}

function withoutNotice(g: Guard): Guard {
  const { readOnlyNoticed: _drop, ...rest } = g
  return rest
}

export function asksUserQuestion(text: string | undefined): boolean {
  if (typeof text !== 'string') return false
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, '``').trim()
  if (plain === '') return false
  const lines = plain.split('\n').map(l => l.trim()).filter(l => l !== '')
  const tail = lines.slice(-6)
  if (tail.some(l => /[?？]\s*(?:[*_)"'”’»]+)?\s*$/.test(l))) return true
  const last = (lines[lines.length - 1] ?? '').toLowerCase()
  return /(?:onayl[ıi]yor musun|onay veriyor musun|hangisini (?:se[çc]|tercih)|which (?:option|one) (?:do|would) you|do you approve|please (?:choose|confirm|approve))/.test(last)
}

const VERIFICATION_OFF_STEP = `verification is off (plan.goalVerification): once every criterion passes, write "Verification: disabled (plan.goalVerification)" under \`## Unverified\` and hand back with \`buracle plan pause --kind decision --reason "${VERIFICATION_OFF_REASON}"\` (the run stays COMPLETE)`

const APPROVAL_ANSWERED_STEP = 'if the answer approves the plan, run `buracle plan set approved true`, `buracle plan set status APPROVED` and `buracle plan set phase implement`; otherwise fold the answer into the plan, validate it again and ask for approval once it is ready (pause first)'

const REVIEW_STEP = 'once every check is green, show the result to the user for review (`buracle plan pause --kind decision --reason "result review"`, then ask), and after their explicit approval run `buracle plan approve-result`'

function nextStep(state: SessionState, cfg: BuracleConfig['plan'], answered = false): string {
  const p = state.plan as NonNullable<SessionState['plan']>
  if (p.type === 'Build') {
    if (p.phase === 'plan') return isApproved(state) ? 'the contract is locked: run `buracle plan set phase implement` and start build round 1' : 'finish the run file, have it reviewed and lock the contract'
    const off = !goalVerificationOf(state, cfg?.goalVerification)
    if (p.status === 'COMPLETE') return `judge every acceptance criterion on the running result and record the round${off ? `; ${VERIFICATION_OFF_STEP}` : ''}`
    if (p.phase === 'verify') return off ? VERIFICATION_OFF_STEP : 'finish verification and hand back (`buracle plan verify` when every criterion passes)'
    return 'continue the current build round: work the next unticked task, then judge the criteria'
  }
  if (p.phase === 'plan') {
    if (isApproved(state)) return 'the plan is approved: run `buracle plan set phase implement` and start the first unticked task'
    if (!cfg.planApproval) return 'plan approval is off, so approve it yourself (`buracle plan set approved true`, `buracle plan set status APPROVED`, `buracle plan set phase implement`) and start implementing'
    return answered ? APPROVAL_ANSWERED_STEP : 'finish the plan and ask the user for approval (pause first)'
  }
  if (p.status === 'COMPLETE' || p.phase === 'verify') {
    if (!needsResultApproval(p.type, cfg)) return 'run the verify phase and finish with `buracle plan verify` once the evidence is recorded'
    if (state.approvals?.resultApprovedAt !== undefined) return 'the user approved the result: do the worktree merge if the run has one, then finish with `buracle plan verify`'
    return `run the verify phase; ${REVIEW_STEP}, then finish with \`buracle plan verify\``
  }
  return 'continue with the next unticked task in the plan file; when every task is ticked run `buracle plan complete` and verify'
}

export interface StopGuardResult { decision: StopDecision, next: SessionState, why: StopWhy, progressed?: boolean, readOnlyNotice?: boolean }

export interface PlanDoc { exists: boolean, findings: Finding[], text?: string }

interface Prepared { base: SessionState, progressed: boolean, objective?: PlanObjective }

function prepare(state: SessionState, planText: string | undefined): Prepared {
  const base: SessionState = { ...state, guard: cleanGuard(state) }
  if (typeof planText !== 'string' || state.plan === undefined || isFinished(state)) return { base, progressed: false }
  let outline: ReturnType<typeof planOutline>
  try { outline = planOutline(planText) } catch { return { base, progressed: false } }
  const prepared: Prepared = { base, progressed: false }
  try {
    const objective = planObjectiveOf(outline, state.plan.type)
    if (objective !== undefined) prepared.objective = objective
  } catch {  }
  const seen = new Set(base.guard.ticked ?? [])
  const done = tickedTasks(outline)
  if (!done.some(n => !seen.has(n))) return prepared
  const ticked = [...new Set([...seen, ...done])].sort((a, b) => a - b).slice(0, TICKED_MAX)
  prepared.base = { ...base, guard: { ...withoutEscalation(base.guard), blocksForPlan: 0, blocksInChain: 0, ticked } }
  prepared.progressed = true
  return prepared
}

function mark(r: StopGuardResult, prep: Prepared): StopGuardResult {
  return prep.progressed ? { ...r, progressed: true } : r
}

function allowWith(base: SessionState, why: StopWhy): StopGuardResult {
  return { decision: { action: 'allow' }, next: { ...base, guard: { ...base.guard, blocksInChain: 0 } }, why }
}

function readOnlyRelease(base: SessionState): StopGuardResult {
  const r = allowWith(base, 'read-only-mode')
  if (base.guard.readOnlyNoticed === true) return r
  return { ...r, next: { ...r.next, guard: { ...r.next.guard, readOnlyNoticed: true } }, readOnlyNotice: true }
}

function chainOf(base: SessionState, input: StopInput): number {
  const stored = base.guard.blocksInChain
  return input.hookActive === true ? Math.max(stored, 1) : input.hookActive === false ? 0 : stored
}

function capHit(base: SessionState, chain: number, cfg: BuracleConfig['plan']): 'runaway-plan' | 'runaway-chain' | undefined {
  const perPlan = Math.max(1, Math.floor(cfg.runaway?.perPlan ?? 30))
  const perChain = Math.max(1, Math.floor(cfg.runaway?.perChain ?? 5))
  if (base.guard.blocksForPlan >= perPlan) return 'runaway-plan'
  if (chain >= perChain) return 'runaway-chain'
  return undefined
}

function clipReason(reason: string): string {
  return reason.length <= STOP_REASON_MAX ? reason : `${reason.slice(0, STOP_REASON_MAX - 3).trimEnd()}...`
}

function blockWith(base: SessionState, chain: number, input: StopInput, reason: string, hook: 'H08' | 'H11', why: StopWhy, extra: Partial<Guard> = {}, keepEscalation = false): StopGuardResult {
  const g = withoutNotice(keepEscalation ? base.guard : withoutEscalation(base.guard))
  const next: SessionState = { ...base, guard: { ...g, blocksForPlan: base.guard.blocksForPlan + 1, blocksInChain: chain + 1, lastBlockAt: input.now, ...extra } }
  return { decision: { action: 'block', reason: clipReason(reason), hook }, next, why }
}

function escalation(base: SessionState, chain: number, input: StopInput, cap: 'runaway-plan' | 'runaway-chain', cfg: BuracleConfig['plan']): StopGuardResult {
  const kind = cap === 'runaway-plan' ? 'plan' : 'chain'
  if (base.guard.escalated === kind) return allowWith(base, cap)
  const plan = base.plan as NonNullable<SessionState['plan']>
  const limit = cap === 'runaway-plan' ? `plan.runaway.perPlan, ${cfg.runaway?.perPlan ?? 30}` : `plan.runaway.perChain, ${cfg.runaway?.perChain ?? 5}`
  const reason = `${GUARD_MARKERS[0]} the stop guard reached its limit (${limit}) while the plan ${plan.path} is still ${plan.status}. Before this turn ends: say in two or three lines what you were doing and what blocks you, run \`buracle plan pause --kind decision --reason "${RUNAWAY_REASON}"\`, then ask the user with the question tool whether to continue, change the approach or abandon the plan. The next stop goes through.`
  return blockWith(base, chain, input, reason, 'H08', 'runaway-escalate', { escalated: kind }, true)
}

function answered(state: SessionState, prep: Prepared, input: StopInput, cfg: BuracleConfig['plan']): StopGuardResult {
  const i = state.interaction as NonNullable<SessionState['interaction']>
  const { answeredAt: _drop, ...held } = i
  const base: SessionState = { ...prep.base, interaction: held }
  const chain = chainOf(base, input)
  if (capHit(base, chain, cfg) !== undefined) return allowWith(base, 'paused')
  const approval = isResultReview(i) ? ' An explicit approval of the result is recorded with `buracle plan approve-result`, which also resumes the plan.' : ''
  const what = typeof i.reason === 'string' && i.reason.trim() !== '' ? ` (${i.reason.trim().slice(0, 160)})` : ''
  const path = (state.plan as NonNullable<SessionState['plan']>).path
  const reason = `${GUARD_MARKERS[0]} the pending decision${what} was answered in the question tool, but the plan ${path} is still paused. Act on the answer, run \`buracle plan resume\` and continue: ${nextStep(state, cfg, true)}.${approval} If the answer asks you to wait or stop, keep the hold (\`buracle plan pause --kind discussion\`) and end the turn.`
  return blockWith(base, chain, input, reason, 'H08', 'decision-answered', {}, true)
}

function h08(state: SessionState, prep: Prepared, input: StopInput, cfg: BuracleConfig['plan']): StopGuardResult {
  const base = prep.base
  if (!cfg || cfg.stopGuard === false) return allowWith(base, 'disabled')
  const plan = state.plan
  if (!plan) return allowWith(base, 'no-plan')
  if (isFinished(state)) return allowWith(base, 'finished')
  const i = state.interaction
  if (i?.state === 'paused') {
    if (input.readOnly !== true && i.kind === 'decision' && typeof i.answeredAt === 'number' && !(i.answeredAt < i.since)) return answered(state, prep, input, cfg)
    return allowWith(base, 'paused')
  }
  if (plan.phase === 'plan' && !isApproved(state) && cfg.planApproval !== false && plan.type !== 'Build') return allowWith(base, 'awaiting-approval')
  if (plan.phase === 'plan' && asksUserQuestion(input.lastMessage)) return allowWith(base, 'question')
  if (input.readOnly === true) return readOnlyRelease(base)
  if (input.backgroundWait === true) return allowWith(base, 'background-wait')
  const chain = chainOf(base, input)
  const cap = capHit(base, chain, cfg)
  if (cap) return escalation(base, chain, input, cap, cfg)
  const head = `${GUARD_MARKERS[0]} the plan ${plan.path} is ${plan.status} (type ${plan.type}, phase ${plan.phase}) and not VERIFIED, so keep working: ${nextStep(state, cfg)}.`
  const objective = objectiveLine(prep.objective, STOP_REASON_MAX - head.length - STOP_GUARD_ESCAPE.length - 2)
  const reason = [head, objective, STOP_GUARD_ESCAPE].filter((s): s is string => s !== undefined && s !== '').join(' ')
  return blockWith(base, chain, input, reason, 'H08', 'blocked')
}

export function stopVerdictDetailed(state: SessionState, input: StopInput, cfg: BuracleConfig['plan'], planText?: string): StopGuardResult {
  const prep = prepare(state, planText)
  return mark(h08(state, prep, input, cfg), prep)
}

export function stopGuardVerdict(state: SessionState, input: StopInput, cfg: BuracleConfig['plan'], planCheck?: PlanDoc): StopGuardResult {
  const prep = prepare(state, planCheck?.text)
  const first = h08(state, prep, input, cfg)
  if (!planCheck || input.readOnly === true || !['blocked', 'awaiting-approval', 'question'].includes(first.why)) return mark(first, prep)
  const h11 = planValidateVerdict(state, planCheck.exists, planCheck.findings)
  if (h11.action !== 'block') return mark(first, prep)
  const base = prep.base
  const chain = chainOf(base, input)
  const cap = capHit(base, chain, cfg)
  if (cap) return mark(allowWith(base, cap), prep)
  return mark(blockWith(base, chain, input, h11.reason, 'H11', 'plan-invalid'), prep)
}

export function stopVerdict(state: SessionState, input: StopInput, cfg: BuracleConfig['plan']): { decision: StopDecision, next: SessionState } {
  const { decision, next } = stopVerdictDetailed(state, input, cfg)
  return { decision, next }
}

export function planProgressed(state: SessionState, planText: string | undefined): boolean {
  return prepare(state, planText).progressed
}

export function planValidateVerdict(state: SessionState, planExists: boolean, findings: Finding[]): StopDecision {
  const plan = state?.plan
  if (!plan || plan.phase !== 'plan' || isFinished(state)) return { action: 'allow' }
  if (state.interaction?.state === 'paused' || nativeBinding(state) !== undefined) return { action: 'allow' }
  const validate = `\`buracle plan validate ${plan.path} --strict\``
  if (!planExists) {
    return { action: 'block', hook: 'H11', reason: `${GUARD_MARKERS[1]} the registered plan file ${plan.path} does not exist yet; write it (or run \`buracle plan init\` again) and run ${validate} until it exits 0. ${STOP_GUARD_ESCAPE}` }
  }
  const errors = (Array.isArray(findings) ? findings : []).filter(f => f && f.level === 'error')
  if (errors.length === 0) return { action: 'allow' }
  const listed = errors.slice(0, 3).map((f, i) => `${i + 1}) ${f.line !== undefined ? `line ${f.line}: ` : ''}${f.message}`).join('; ')
  const more = errors.length > 3 ? ` (and ${errors.length - 3} more)` : ''
  return { action: 'block', hook: 'H11', reason: `${GUARD_MARKERS[1]} the plan ${plan.path} has ${errors.length} error${errors.length === 1 ? '' : 's'}: ${listed}${more}; fix them and run ${validate} until it exits 0. ${STOP_GUARD_ESCAPE}` }
}

export function resumePlan(state: SessionState, now: number): SessionState {
  if (state.interaction?.state !== 'paused') return state
  return { ...state, interaction: { state: 'running', since: now }, guard: { ...withoutNotice(withoutEscalation(cleanGuard(state))), blocksForPlan: 0, blocksInChain: 0 } }
}

export function applyIntent(state: SessionState, intent: Intent, now: number): SessionState {
  if (intent !== 'pause' && intent !== 'stop' && intent !== 'resume') return state
  const plan = state.plan
  if (!plan || isFinished(state)) return state
  const paused = state.interaction?.state === 'paused'
  if (intent === 'resume') {
    if (!paused) return state
    const kind = state.interaction?.kind
    if (kind === 'decision' && resumableDecision(state.interaction)) return resumePlan(state, now)
    if (kind === 'decision' || kind === 'manual') return state
    return resumePlan(state, now)
  }
  if (paused) return state
  const reason = intent === 'stop' ? 'the user asked to cancel the task (confirm before discarding anything)' : 'the user asked to stop'
  return { ...state, interaction: { state: 'paused', kind: 'discussion', since: now, reason } }
}

export function answerReceipt(state: SessionState, now: number): SessionState {
  const i = state?.interaction
  if (state?.plan === undefined || isFinished(state) || i?.state !== 'paused' || i.kind !== 'decision') return state
  if (typeof i.since === 'number' && now < i.since) return state
  return { ...state, interaction: { ...i, answeredAt: now } }
}

export function resultReviewable(state: SessionState): boolean {
  const p = state?.plan
  return p !== undefined && !isFinished(state) && p.status === 'COMPLETE' && needsResultApproval(p.type, undefined)
}

export function approveResult(state: SessionState, now: number): SessionState {
  if (!resultReviewable(state)) return state
  const approved: SessionState = { ...state, approvals: { ...(state.approvals ?? {}), resultApprovedAt: now } }
  return resumePlan(approved, now)
}

export function dropResultApproval(state: SessionState): SessionState {
  if (state.approvals?.resultApprovedAt === undefined) return state
  const { resultApprovedAt: _drop, ...rest } = state.approvals
  const out: SessionState = { ...state }
  if (Object.keys(rest).length > 0) out.approvals = rest
  else delete out.approvals
  return out
}

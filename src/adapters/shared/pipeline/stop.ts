import { resolve } from 'node:path'
import type { StopDecision, StopInput } from '../../../core/events'
import type { PlanDoc, SessionState, StopGuardResult, StopWhy } from '../../../core/plan/state'
import { readTextSync } from '../../../engine/fsx'
import { loadLedger, updateLedger } from '../../../workflow/ledger'
import { loadState, updateState } from '../../../workflow/session-store'
import { assetsOptions, startLinkRun } from '../project-assets'
import { readWorkspace, type PipelineDeps } from './types'

export interface StopPorts {
  /** Whether the session is read-only (plan mode); asked once a plan is known to be registered. */
  readOnly(): boolean | Promise<boolean>
  /** The note for a stop the guard lets through; it runs before the audit. */
  stopNotice?(result: StopGuardResult, before: SessionState): string | undefined | Promise<string | undefined>
}

export interface StopResult {
  decision: StopDecision
  /** Which step blocked the stop. */
  blockedBy?: 'guard' | 'audit'
  /** Why the guard let the stop through; absent when it blocked or failed. */
  why?: StopWhy
  notice?: string
  /** The guard failed and the stop was allowed. */
  failed?: boolean
}

interface Guard { result?: StopGuardResult, before?: SessionState, why?: StopWhy, failed?: boolean }

export function turnAuditReason(d: Pick<PipelineDeps, 'harness' | 'core'>, sid: string): string | undefined {
  if (d.core.turnAudit(loadLedger(d.harness, sid)).action !== 'block') return undefined
  let reason: string | undefined
  updateLedger(d.harness, sid, l => {
    const again = d.core.turnAudit(l)
    if (again.action !== 'block') return l
    reason = again.reason
    return d.core.ledgerAudited(l, again)
  })
  return reason
}

async function guard(input: StopInput, d: PipelineDeps & StopPorts): Promise<Guard> {
  const { harness: H, sessionId: sid, cwd } = input
  if (loadState(H, sid).plan === undefined) return { why: 'no-plan' }
  const { subagent: _subagent, ...stop }: StopInput = input
  if (await d.step('read-only mode', false, () => d.readOnly())) stop.readOnly = true
  const planDoc = (s: SessionState): PlanDoc | undefined => {
    if (s.plan === undefined) return undefined
    const text = s.plan.path === '' ? undefined : readTextSync(resolve(cwd === '' ? '/' : cwd, s.plan.path))
    if (text === undefined || !text.ok) return { exists: false, findings: [] }
    return { exists: true, findings: s.plan.phase === 'plan' ? d.core.validatePlan(text.value) : [], text: text.value }
  }
  const g: Guard = {}
  updateState(H, sid, s => {
    g.before = s
    g.result = d.core.stopGuardVerdict(s, stop, d.ctx.config.plan, planDoc(s))
    g.why = g.result.why
    return g.result.next
  })
  return g
}

/**
 * stop: the project's link run (H28), the stop guard (H08, H11) and, for a stop it lets through, the turn audit
 * (H23). A guard that fails lets the stop through.
 */
export async function stop(input: StopInput, d: PipelineDeps & StopPorts): Promise<StopResult> {
  const { sessionId: sid, now } = input
  const sub = input.subagent === true
  if (!sub) await d.step('H28 project assets', false, () => startLinkRun(readWorkspace(d.ctx, d.harness, sid)?.root, assetsOptions(now, d.assetsSpawn)))
  const g = await d.step('stop guard', { failed: true } as Guard, () => guard(input, d))
  if (g.failed === true) return { decision: { action: 'allow' }, failed: true }
  if (g.result?.decision.action === 'block') return { decision: g.result.decision, blockedBy: 'guard' }
  const out: StopResult = { decision: { action: 'allow' } }
  if (g.why !== undefined) out.why = g.why
  const notice = g.result !== undefined && g.before !== undefined ? await d.stopNotice?.(g.result, g.before) : undefined
  if (notice !== undefined) out.notice = notice
  if (!sub && d.core.routeAuditAllowed(g.why, d.ctx.config.routing.strictness)) {
    const reason = await d.step('H23 route.audit', undefined as string | undefined, () => turnAuditReason(d, sid))
    if (reason !== undefined) { out.decision = { action: 'block', reason, hook: 'H23' }; out.blockedBy = 'audit' }
  }
  return out
}

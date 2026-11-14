import type { StopDecision, StopInput } from '../../../core/events'
import type { PlanDoc, SessionState, StopGuardResult, StopWhy } from '../../../core/plan/state'
import { loadLedger, updateLedger } from '../../../workflow/ledger'
import { loadState, updateState } from '../../../workflow/session-store'
import { assetsOptions, startLinkRun } from '../project-assets'
import type { PipelineDeps } from './types'

export interface StopPorts {
  /** The plan file's text, or undefined when it is not there. */
  readPlan(path: string, cwd: string): string | undefined
  /** Complete the input once a plan is known to be registered, for what the harness has to look up (read-only mode). */
  stopInput?(input: StopInput): void | Promise<void>
  /** The note for a stop the guard lets through; it runs before the audit. */
  stopNotice?(result: StopGuardResult, before: SessionState): string | undefined | Promise<string | undefined>
  stopGuard: {
    /** Answer `disabled` from the config alone, without reading the session. */
    gate: boolean
    /** Save the session state after every verdict, or only when the verdict changed it. */
    write: 'always' | 'changed'
    /** Whether the turn audit still runs when the guard itself failed. */
    auditOnFailure: boolean
  }
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
  const cfg = d.ctx.config.plan
  if (d.stopGuard.gate && !cfg.stopGuard) return { why: 'disabled' }
  return d.step('stop guard', { failed: true } as Guard, async () => {
    const state = loadState(H, sid)
    if (state.plan === undefined) return { why: 'no-plan' }
    const { subagent: _subagent, ...stop }: StopInput = input
    await d.stopInput?.(stop)
    const planDoc = (s: SessionState): PlanDoc | undefined => {
      if (s.plan === undefined) return undefined
      const text = d.readPlan(s.plan.path, cwd)
      if (text === undefined) return { exists: false, findings: [] }
      return { exists: true, findings: s.plan.phase === 'plan' ? d.core.validatePlan(text) : [], text }
    }
    const verdict = (s: SessionState): StopGuardResult => d.core.stopGuardVerdict(s, stop, cfg, planDoc(s))
    let before = state
    let result = d.stopGuard.write === 'changed' ? verdict(state) : undefined
    if (result === undefined || JSON.stringify(result.next) !== JSON.stringify(state)) {
      updateState(H, sid, s => {
        before = s
        result = verdict(s)
        return result.next
      })
    }
    return result !== undefined ? { result, before, why: result.why } : { failed: true }
  })
}

/** stop: the project's link run (H28), the stop guard (H08, H11) and, for a stop it lets through, the turn audit (H23). */
export async function stop(input: StopInput, d: PipelineDeps & StopPorts): Promise<StopResult> {
  const { sessionId: sid, now } = input
  const sub = input.subagent === true
  if (!sub) await d.step('H28 project assets', false, () => startLinkRun(d.workspace.read(sid)?.root, assetsOptions(now, d.assetsSpawn)))
  await d.at?.('stop.guard')
  const g = await guard(input, d)
  if (g.failed === true && !d.stopGuard.auditOnFailure) return { decision: { action: 'allow' }, failed: true }
  if (g.result?.decision.action === 'block') return { decision: g.result.decision, blockedBy: 'guard' }
  const out: StopResult = { decision: { action: 'allow' } }
  if (g.why !== undefined) out.why = g.why
  if (g.failed === true) out.failed = true
  const notice = g.result !== undefined && g.before !== undefined ? await d.stopNotice?.(g.result, g.before) : undefined
  if (notice !== undefined) out.notice = notice
  if (!sub && d.core.routeAuditAllowed(g.why, d.ctx.config.routing.strictness)) {
    const reason = await d.step('H23 route.audit', undefined as string | undefined, () => turnAuditReason(d, sid))
    if (reason !== undefined) { out.decision = { action: 'block', reason, hook: 'H23' }; out.blockedBy = 'audit' }
  }
  return out
}

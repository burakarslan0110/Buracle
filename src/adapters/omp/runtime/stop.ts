import { isAbsolute, resolve } from 'node:path'
import type { HookId, StopInput } from '../../../core/events'
import type { PlanDoc, SessionState, StopGuardResult, StopWhy } from '../../../core/plan/index'
import { routeAuditAllowed } from '../../../core/plan/state'
import { GUARD_MARKERS } from '../../../core/policy/intents'
import { ledgerAudited, turnAudit } from '../../../core/policy/usage'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import type { LiveConfig } from './config'
import type { ExtensionDeps } from './deps'
import type { SpoolEntry } from './memory'
import type { OmpContext, OmpExtensionAPI, OmpSessionStopEvent, OmpSessionStopResult } from './types'
import { clip, isMain, messageText, sessionOf } from './util'

export function stopReason(hook: HookId, reason: string): string {
  return GUARD_MARKERS.some(m => reason.startsWith(m)) ? reason : `Buracle ${hook}: ${reason}`
}

export function runawayNotice(why: StopWhy, plan: string): string {
  const what = why === 'runaway-plan' ? 'the plan-wide limit of stop-guard continuations' : 'the limit of consecutive stop-guard continuations'
  return `Buracle: the turn ended although the plan ${plan} is not finished, because ${what} was reached. Check the work, then continue or run \`buracle plan pause\`.`
}

export const READ_ONLY_NOTICE = 'Buracle: Oh My Pi is in plan mode (read-only), so the stop guard lets the turn end. Leave plan mode to continue the plan.'

export function planModeOn(ctx: OmpContext): boolean {
  try {
    const branch = ctx.sessionManager?.getBranch?.()
    if (!Array.isArray(branch)) return false
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i] as { type?: unknown, mode?: unknown } | null
      if (e !== null && typeof e === 'object' && e.type === 'mode_change') return e.mode === 'plan'
    }
    return false
  } catch {
    return false
  }
}

export function promptGuidance(deps: Pick<ExtensionDeps, 'state' | 'plan'>, sid: string, control: 'pause' | 'resume' | 'stop' | null, text: string, opts: { autoPause: boolean, now: number }): string | undefined {
  const before = deps.state.load(sid)
  if (before.plan === undefined) return deps.plan.promptInteraction(before, control, text, opts).guidance
  let guidance: string | undefined
  deps.state.update(sid, s => { const r = deps.plan.promptInteraction(s, control, text, opts); guidance = r.guidance; return r.next })
  return guidance
}

export interface StopGuardHost {
  deps: Pick<ExtensionDeps, 'now' | 'readText' | 'plan' | 'state' | 'ledger'>
  live(): LiveConfig
  guarded<T>(what: string, fn: () => T): T | undefined
  report(what: string, e: unknown): void
  spool(sid: string, entries: SpoolEntry[]): void
  noticed: { get(sid: string): boolean, set(sid: string): void }
  turnEnded?(sid: string): void
  released?(sid: string, ctx: OmpContext, last: string): void
}

export function registerStopGuard(pi: OmpExtensionAPI, host: StopGuardHost): void {
  const { deps, guarded } = host

  const planCheck = (plan: NonNullable<SessionState['plan']>, cwd: string): PlanDoc => {
    const text = deps.readText(isAbsolute(plan.path) ? plan.path : resolve(cwd, plan.path))
    if (text === undefined) return { exists: false, findings: [] }
    if (plan.phase !== 'plan') return { exists: true, findings: [], text }
    return { exists: true, findings: guarded('H11 validatePlan', () => deps.plan.validatePlan(text)) ?? [], text }
  }

  const stopGuard = (sid: string, event: OmpSessionStopEvent, ctx: OmpContext, lc: LiveConfig, last: string): { block?: OmpSessionStopResult, why?: StopWhy } => {
    if (!lc.config.plan.stopGuard) return { why: 'disabled' }
    const state = guarded('state', () => deps.state.load(sid))
    if (state === undefined) return {}
    if (state.plan === undefined) return { why: 'no-plan' }
    const now = deps.now()
    const input: StopInput = { harness: 'omp', sessionId: sid, cwd: ctx.cwd, now }
    if (typeof event.stop_hook_active === 'boolean') input.hookActive = event.stop_hook_active
    if (last !== '') input.lastMessage = last
    if (planModeOn(ctx)) input.readOnly = true
    let result: StopGuardResult | undefined
    const stored = guarded('H08/H11 stopGuardVerdict', () => deps.state.update(sid, s => {
      const check = s.plan !== undefined ? planCheck(s.plan, ctx.cwd) : undefined
      const r = deps.plan.stopGuardVerdict(s, input, lc.config.plan, check)
      result = r
      return r.next
    }))
    const r = result as StopGuardResult | undefined
    if (stored === undefined || r === undefined) return {}
    if (r.why === 'runaway-plan' || r.why === 'runaway-chain') {
      log('warn', 'omp: the stop guard released the turn at a runaway cap', { sid, why: r.why })
      if (!host.noticed.get(sid) && ctx.hasUI !== false) {
        host.noticed.set(sid)
        guarded('runaway notice', () => ctx.ui.notify(runawayNotice(r.why, stored.plan?.path ?? 'the plan'), 'warning'))
      }
    }
    if (r.readOnlyNotice === true && ctx.hasUI !== false) guarded('read-only notice', () => ctx.ui.notify(READ_ONLY_NOTICE, 'info'))
    if (r.decision.action !== 'block') return { why: r.why }
    return { block: { decision: 'block', reason: stopReason(r.decision.hook, r.decision.reason) }, why: r.why }
  }

  const auditTurn = (sid: string): string | undefined => {
    const ledger = deps.ledger.load(sid)
    if (turnAudit(ledger).action !== 'block') return undefined
    let reason: string | undefined
    deps.ledger.update(sid, l => {
      const again = turnAudit(l)
      if (again.action !== 'block') return l
      reason = again.reason
      return ledgerAudited(l, again)
    })
    return reason
  }

  pi.on('session_stop', (event: OmpSessionStopEvent, ctx: OmpContext): OmpSessionStopResult | undefined => {
    try {
      if (!isMain(ctx)) return undefined
      const sid = paths.isValidSessionId(event.session_id) ? event.session_id : sessionOf(ctx)
      if (sid === undefined) return undefined
      const last = messageText(event.last_assistant_message)
      if (last.trim() !== '') host.spool(sid, [{ ts: deps.now(), ev: 'stop', excerpt: clip(last, 2000) }])
      host.turnEnded?.(sid)
      const lc = host.live()
      const guard = stopGuard(sid, event, ctx, lc, last)
      if (guard.block !== undefined) return guard.block
      if (routeAuditAllowed(guard.why, lc.config.routing.strictness)) {
        const reason = guarded('H23 route.audit', () => auditTurn(sid))
        if (reason !== undefined) return { decision: 'block', reason }
      }
      guarded('turn receipt', () => host.released?.(sid, ctx, last))
      return undefined
    } catch (e) {
      host.report('session_stop', e)
      return undefined
    }
  })
}

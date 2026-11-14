import type { HookId, StopInput } from '../../../core/events'
import type { StopWhy } from '../../../core/plan/index'
import { GUARD_MARKERS } from '../../../core/policy/intents'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import { stop, type PipelineDeps } from '../../shared/pipeline/index'
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

export interface StopGuardHost {
  deps: Pick<ExtensionDeps, 'now'>
  /** What the shared pipeline needs for this session. */
  pipe(sid: string): PipelineDeps
  guarded<T>(what: string, fn: () => T): T | undefined
  report(what: string, e: unknown): void
  spool(sid: string, entries: SpoolEntry[]): Promise<void>
  noticed: { get(sid: string): boolean, set(sid: string): void }
  released?(sid: string, ctx: OmpContext, last: string): void
}

/**
 * session_stop is omp's stop: the verdict is the shared pipeline's (the stop guard, then the turn audit). What stays
 * here is the turn's spool entry, the notices omp shows the user itself, and the block in omp's shape, which
 * keeps a guard text verbatim so the continuation stays quiet.
 */
export function registerStopGuard(pi: OmpExtensionAPI, host: StopGuardHost): void {
  const { guarded } = host

  pi.on('session_stop', async (event: OmpSessionStopEvent, ctx: OmpContext): Promise<OmpSessionStopResult | undefined> => {
    try {
      if (!isMain(ctx)) return undefined
      const sid = paths.isValidSessionId(event.session_id) ? event.session_id : sessionOf(ctx)
      if (sid === undefined) return undefined
      const now = host.deps.now()
      const last = messageText(event.last_assistant_message)
      if (last.trim() !== '') await host.spool(sid, [{ ts: now, ev: 'stop', excerpt: clip(last, 2000) }])
      const input: StopInput = { harness: 'omp', sessionId: sid, cwd: ctx.cwd, now }
      if (typeof event.stop_hook_active === 'boolean') input.hookActive = event.stop_hook_active
      if (last !== '') input.lastMessage = last
      const r = await stop(input, {
        ...host.pipe(sid),
        readOnly: () => planModeOn(ctx),
        stopNotice: (result, before) => {
          if (result.why === 'runaway-plan' || result.why === 'runaway-chain') {
            log('warn', 'omp: the stop guard released the turn at a runaway cap', { sid, why: result.why })
            if (!host.noticed.get(sid) && ctx.hasUI !== false) {
              host.noticed.set(sid)
              guarded('runaway notice', () => ctx.ui.notify(runawayNotice(result.why, before.plan?.path ?? 'the plan'), 'warning'))
            }
          }
          if (result.readOnlyNotice === true && ctx.hasUI !== false) guarded('read-only notice', () => ctx.ui.notify(READ_ONLY_NOTICE, 'info'))
          return undefined
        },
      })
      const d = r.decision
      // The turn audit's reason goes out as it is; the stop guard's keeps its marker (stopReason).
      if (d.action === 'block') return r.blockedBy === 'audit' ? { decision: 'block', reason: d.reason } : { decision: 'block', reason: stopReason(d.hook, d.reason) }
      guarded('turn receipt', () => host.released?.(sid, ctx, last))
      return undefined
    } catch (e) {
      host.report('session_stop', e)
      return undefined
    }
  })
}

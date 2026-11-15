import type { HookId } from '../../../core/events'
import type { StopWhy } from '../../../core/plan/index'
import { GUARD_MARKERS } from '../../../core/policy/intents'

/** A stop guard's reason as the model reads it: a guard text keeps its marker verbatim, so the continuation stays quiet. */
export function stopReason(hook: HookId, reason: string): string {
  return GUARD_MARKERS.some(m => reason.startsWith(m)) ? reason : `Buracle ${hook}: ${reason}`
}

export function runawayNotice(why: StopWhy, plan: string): string {
  const what = why === 'runaway-plan' ? 'the plan-wide limit of stop-guard continuations' : 'the limit of consecutive stop-guard continuations'
  return `Buracle: the turn ended although the plan ${plan} is not finished, because ${what} was reached. Check the work, then continue or run \`buracle plan pause\`.`
}

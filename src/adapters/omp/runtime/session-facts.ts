import type { TelemetryPatch } from './deps'
import type { OmpContext, OmpExtensionAPI, OmpSessionSwitchEvent } from './types'
import { strAt } from './util'

type Guarded = <T>(what: string, fn: () => T) => T | undefined

export function telemetryOf(pi: Pick<OmpExtensionAPI, 'getThinkingLevel'>, ctx: OmpContext, now: number, guarded: Guarded): TelemetryPatch {
  const t: TelemetryPatch = { at: now, cwd: ctx.cwd }
  const model = ctx.model?.id ?? ctx.model?.name
  if (model) t.model = model
  if (ctx.model?.id) t.modelId = ctx.model.provider ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model.id
  const effort = guarded('thinking level', () => pi.getThinkingLevel?.())
  if (effort) t.effort = effort
  const u = guarded('context usage', () => ctx.getContextUsage?.())
  if (u && Number.isFinite(u.percent)) t.ctx = { pct: Math.round(u.percent), tokens: u.tokens, window: u.contextWindow }
  return t
}

export function resumedSession(ev: string, event: unknown, ctx: OmpContext, isFile: (path: string) => boolean): boolean {
  if (ev === 'session_switch') return strAt(event, 'reason') === ('resume' satisfies OmpSessionSwitchEvent['reason'])
  if (ev !== 'session_start') return false
  const file = ctx.sessionManager.getSessionFile?.()
  return typeof file === 'string' && file !== '' && isFile(file)
}

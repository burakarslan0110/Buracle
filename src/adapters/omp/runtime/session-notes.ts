import type { BuracleConfig } from '../../../core/config'
import type { Notice } from '../../../core/notices'
import type { ContextBand } from '../../../core/status/context'
import { contextWatch } from '../../../core/status/context'
import { noticesOff, startupNotices } from '../../shared/notices'
import type { OmpContext, OmpExtensionAPI, OmpTurnEndEvent } from './types'
import { hasTui, strAt } from './util'

export const CONTEXT_WARNING_TYPE = 'buracle.context-warning'
export const NOTICE_MESSAGE_TYPE = 'buracle.notice'

export interface NotesHost {
  pi: Pick<OmpExtensionAPI, 'sendMessage'>
  guarded<T>(what: string, fn: () => T): T | undefined
}

export interface ContextMemo { ctxWarned?: ContextBand, contextWarning?: string }

export function contextCheck(host: NotesHost, m: ContextMemo, ctx: OmpContext, event: OmpTurnEndEvent, cfg: BuracleConfig['context']): void {
  const u = host.guarded('context usage', () => ctx.getContextUsage?.())
  const pct = u !== undefined && Number.isFinite(u.percent) ? u.percent : undefined
  const w = contextWatch(m.ctxWarned, pct, cfg)
  m.ctxWarned = w.warned
  if (w.warn === undefined) return
  const warn = w.warn
  if (hasTui(ctx)) host.guarded('H05 notify', () => ctx.ui.notify(warn, 'warning'))
  const continues = strAt(event.message, 'stopReason') === 'toolUse' && Array.isArray(event.toolResults) && event.toolResults.length > 0
  const sent = continues && host.guarded('H05 aside', () => {
    host.pi.sendMessage({ customType: CONTEXT_WARNING_TYPE, content: warn, display: false }, { deliverAs: 'aside' })
    return true
  }) === true
  m.contextWarning = sent ? undefined : warn
}

export function startupNotice(host: NotesHost, ctx: OmpContext, data: { notices?: Notice[], buracleVersion: string }, nowMs: number): void {
  if (noticesOff()) return
  const n = host.guarded('H17 notices', () => startupNotices(data.notices, { version: data.buracleVersion, nowMs, harness: 'omp' }))
  if (n === undefined) return
  host.guarded('H17 notice', () => host.pi.sendMessage({ customType: NOTICE_MESSAGE_TYPE, content: n.model, display: false }, { deliverAs: 'nextTurn' }))
  if (hasTui(ctx)) host.guarded('H17 notice notify', () => ctx.ui.notify(n.user, 'info'))
}

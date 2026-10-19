import { consentNeeded, type ConsentNeed } from '../../../core/policy/consent'
import { consentAnswerOf, consentQuestion, consentRefusal, CONSENT_OPTIONS, type ConsentAnswer } from '../../shared/consent-dialog'
import type { OmpContext, OmpToolCallResult } from './types'
import { hasTui, isMain } from './util'

export { consentNeeded, type ConsentNeed }

export interface ConsentAskHost {
  judge(): Promise<OmpToolCallResult | undefined>
  take(): ConsentNeed | undefined
  record(need: ConsentNeed, answer: 'once' | 'session'): boolean
  cleared(): void
}

export async function judgeWithConsent(ctx: OmpContext, host: ConsentAskHost): Promise<OmpToolCallResult | undefined> {
  let r = await host.judge()
  for (let asked = 0; asked < 8; asked++) {
    const need = host.take()
    if (need === undefined || r?.block !== true || !canAskConsent(ctx)) break
    const answer = await askConsent(ctx, need)
    if (answer === undefined) break
    if (answer === 'refuse') return { block: true, reason: `Buracle H20: ${consentRefusal(need)}` }
    if (!host.record(need, answer)) break
    host.cleared()
    r = await host.judge()
  }
  host.take()
  return r
}

export function canAskConsent(ctx: OmpContext): boolean {
  if (!isMain(ctx) || !hasTui(ctx)) return false
  return typeof ctx.ui.select === 'function' || typeof ctx.ui.confirm === 'function'
}

export async function askConsent(ctx: OmpContext, need: ConsentNeed): Promise<ConsentAnswer | undefined> {
  try {
    if (typeof ctx.ui.select === 'function') return consentAnswerOf(await ctx.ui.select(consentQuestion(need), [...CONSENT_OPTIONS]))
    if (typeof ctx.ui.confirm === 'function') return (await ctx.ui.confirm('Buracle consent', consentQuestion(need))) ? 'once' : 'refuse'
  } catch {
    return undefined
  }
  return undefined
}

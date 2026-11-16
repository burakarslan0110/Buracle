import { consentNeeded, type ConsentNeed } from '../../../core/policy/consent'
import { consentAnswerOf, consentQuestion, consentRefusal, CONSENT_OPTIONS, type ConsentAnswer } from '../consent-dialog'
import { hasTui, isMain, type FamilyContext } from './util'

export interface ConsentContext extends FamilyContext {
  ui: { select?(title: string, options: string[]): Promise<string | undefined>, confirm?(title: string, message: string): Promise<boolean> }
}
/** A tool call's verdict as both hosts take it: `block` with the reason. */
export interface BlockResult { block?: boolean, reason?: string }

export { consentNeeded, type ConsentNeed }

export interface ConsentAskHost<R extends BlockResult> {
  judge(): Promise<R | undefined>
  take(): ConsentNeed | undefined
  record(need: ConsentNeed, answer: 'once' | 'session'): boolean
  cleared(): void
}

export async function judgeWithConsent<R extends BlockResult>(ctx: ConsentContext, host: ConsentAskHost<R>): Promise<R | undefined> {
  let r = await host.judge()
  for (let asked = 0; asked < 8; asked++) {
    const need = host.take()
    if (need === undefined || r?.block !== true || !canAskConsent(ctx)) break
    const answer = await askConsent(ctx, need)
    if (answer === undefined) break
    if (answer === 'refuse') return { block: true, reason: `Buracle Stack H20: ${consentRefusal(need)}` } as R
    if (!host.record(need, answer)) break
    host.cleared()
    r = await host.judge()
  }
  host.take()
  return r
}

export function canAskConsent(ctx: ConsentContext): boolean {
  if (!isMain(ctx) || !hasTui(ctx)) return false
  return typeof ctx.ui.select === 'function' || typeof ctx.ui.confirm === 'function'
}

export async function askConsent(ctx: ConsentContext, need: ConsentNeed): Promise<ConsentAnswer | undefined> {
  try {
    if (typeof ctx.ui.select === 'function') return consentAnswerOf(await ctx.ui.select(consentQuestion(need), [...CONSENT_OPTIONS]))
    if (typeof ctx.ui.confirm === 'function') return (await ctx.ui.confirm('Buracle Stack consent', consentQuestion(need))) ? 'once' : 'refuse'
  } catch {
    return undefined
  }
  return undefined
}

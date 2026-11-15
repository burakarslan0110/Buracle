import { consentQuestion, consentRefusal, heldConsent, recordDialogGrants, type HeldConsent } from '../../shared/consent-dialog'
import { questionHint } from './consent-question'
import { anyTuiPresent, clearAsk, postAsk, readAnswer, tuiPresent, type RelayAnswer } from './consent-relay'
import { denyReason } from '../../shared/pipeline/index'

const HARNESS = 'opencode' as const

export const ASK_POLL_MS = 200
export const ASK_TIMEOUT_MS = 15 * 60_000
export const TUI_ARRIVE_MS = 2_000

export interface ConsentAskHost {
  now(): number
  sleep(ms: number): Promise<void>
  newId(): string
  pollMs?: number
  timeoutMs?: number
  arriveMs?: number
}

async function tuiFor(sid: string, host: ConsentAskHost, poll: number): Promise<boolean> {
  if (tuiPresent(sid, host.now())) return true
  if (!anyTuiPresent(host.now())) return false
  const until = host.now() + (host.arriveMs ?? TUI_ARRIVE_MS)
  while (host.now() < until) {
    await host.sleep(poll)
    if (tuiPresent(sid, host.now())) return true
  }
  return false
}

export interface ConsentAskResult { answer: RelayAnswer; held: HeldConsent }

export async function askInTui(sid: string, command: string, host: ConsentAskHost): Promise<ConsentAskResult | undefined> {
  const poll = Math.max(10, host.pollMs ?? ASK_POLL_MS)
  const held = heldConsent(HARNESS, sid, command)
  if (held === undefined || !await tuiFor(sid, host, poll)) return undefined
  const id = host.newId()
  const start = host.now()
  if (!postAsk(sid, { id, question: consentQuestion(held.need), command: held.need.command, at: start })) return undefined
  const limit = host.timeoutMs ?? ASK_TIMEOUT_MS
  try {
    for (;;) {
      await host.sleep(poll)
      const answer = readAnswer(sid, id)
      if (answer !== undefined) {
        if (answer === 'once' || answer === 'session') recordDialogGrants(HARNESS, sid, held.kinds, answer, host.now())
        return { answer, held }
      }
      const now = host.now()
      if (!tuiPresent(sid, now) || now - start > limit) return undefined
    }
  } finally {
    clearAsk(sid, id)
  }
}

export interface HeldHooks { host: ConsentAskHost; isSubagent(sid: string): Promise<boolean> }

/** What became of a held command: allowed by the user, refused (with the denial to show), or not asked (with the way to ask). */
export interface HeldAnswer { allowed: boolean; refusal?: string; hint?: string }

export async function answerHeld(sid: string, command: string, hooks: HeldHooks): Promise<HeldAnswer> {
  if (await hooks.isSubagent(sid)) return { allowed: false }
  const r = await askInTui(sid, command, hooks.host)
  if (r === undefined) {
    const need = heldConsent(HARNESS, sid, command)?.need
    return { allowed: false, ...(need !== undefined ? { hint: questionHint(need) } : {}) }
  }
  if (r.answer === 'once' || r.answer === 'session') return { allowed: true }
  return { allowed: false, ...(r.answer === 'refuse' ? { refusal: denyReason('H20', consentRefusal(r.held.need)) } : {}) }
}

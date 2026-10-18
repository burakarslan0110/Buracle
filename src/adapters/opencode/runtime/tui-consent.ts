import { ALLOW_ONCE, ALLOW_SESSION, CONSENT_OPTIONS, consentAnswerOf } from '../../shared/consent-dialog'
import { answerAsk, askOpen, openAsks, writeTuiBeat, type RelayAnswer } from './consent-relay'
import type { TuiDialogSelect } from './types'

export const RELAY_TICK_MS = 400
export const BEAT_EVERY_MS = 2_000

export interface ConsentRelayHost {
  sessionID(): string | undefined
  select: TuiDialogSelect
  clear(): void
  now(): number
  pid: number
}

const DESCRIPTION: Readonly<Record<string, string>> = {
  [ALLOW_ONCE]: 'Run this command now',
  [ALLOW_SESSION]: 'Allow this kind for the session',
}

export function consentRelayTick(host: ConsentRelayHost, state: { beatAt?: number, beatSid?: string | undefined, showing?: { sid: string, id: string } }): void {
  const sid = host.sessionID()
  const now = host.now()
  if (state.beatSid !== sid || state.beatAt === undefined || now - state.beatAt >= BEAT_EVERY_MS) {
    writeTuiBeat(sid, now, host.pid)
    state.beatAt = now
    state.beatSid = sid
  }
  if (state.showing !== undefined) {
    if (!askOpen(state.showing.sid, state.showing.id)) { state.showing = undefined; host.clear() }
    return
  }
  if (sid === undefined) return
  const ask = openAsks(sid)[0]
  if (ask === undefined) return
  const showing = { sid, id: ask.id }
  state.showing = showing
  const options = CONSENT_OPTIONS.map(title => ({ title, value: title, ...(DESCRIPTION[title] !== undefined ? { description: DESCRIPTION[title] } : {}) }))
  void host.select({ title: ask.question, options }).then(
    pick => answered(host, state, showing, pick === undefined ? 'dismiss' : consentAnswerOf(pick)),
    () => answered(host, state, showing, 'dismiss'),
  )
}

function answered(host: ConsentRelayHost, state: { showing?: { sid: string, id: string } }, showing: { sid: string, id: string }, answer: RelayAnswer): void {
  try { answerAsk(showing.sid, showing.id, answer, host.now()) } catch {  }
  if (state.showing === showing) state.showing = undefined
}

export function startConsentRelay(host: ConsentRelayHost): () => void {
  const state: { beatAt?: number, beatSid?: string | undefined, showing?: { sid: string, id: string } } = {}
  const timer = setInterval(() => {
    try { consentRelayTick(host, state) } catch {  }
  }, RELAY_TICK_MS)
  return () => clearInterval(timer)
}

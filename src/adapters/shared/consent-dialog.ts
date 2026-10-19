import type { Harness } from '../../core/events'
import { commandTarget, consentNeeds, type ConsentGrant, type ConsentKind, type ConsentNeed } from '../../core/policy/consent'
import { readConsentState, recordUserGrants } from './consent-store'

export const ALLOW_ONCE = 'Allow once'
export const ALLOW_SESSION = 'Allow for this session'
export const REFUSE = 'Refuse'
export const CONSENT_OPTIONS: readonly string[] = [ALLOW_ONCE, ALLOW_SESSION, REFUSE]

export const ONCE_GRANT_MS = 5 * 60_000
export const SESSION_GRANT_MS = 8 * 60 * 60_000

export type ConsentAnswer = 'once' | 'session' | 'refuse'

function shown(command: string): string {
  return command.length > 120 ? `${command.slice(0, 117)}...` : command
}

export function consentQuestion(need: ConsentNeed): string {
  return `Buracle consent: \`${shown(need.command)}\` ${need.summary}. Run it?`
}

export function consentRefusal(need: ConsentNeed): string {
  return `the user refused \`${shown(need.command)}\` in the consent dialog. Do not run it or anything that does the same; ask the user what they want instead.`
}

export function consentAnswerOf(pick: string | undefined): ConsentAnswer {
  return pick === ALLOW_ONCE ? 'once' : pick === ALLOW_SESSION ? 'session' : 'refuse'
}

export function recordDialogGrant(h: Harness, sid: string, kind: ConsentKind, answer: 'once' | 'session', now: number, uses = 1): void {
  const grant: ConsentGrant = answer === 'session'
    ? { kind, until: now + SESSION_GRANT_MS, uses: 1_000, source: 'ask' }
    : { kind, until: now + ONCE_GRANT_MS, uses: Math.max(1, uses), source: 'ask' }
  recordUserGrants(h, sid, [grant], now)
}

export interface HeldConsent { need: ConsentNeed; kinds: ConsentKind[] }

export function heldConsent(h: Harness, sid: string, command: string): HeldConsent | undefined {
  const p = readConsentState(h, sid).pending
  if (p === undefined || !(p.targets ?? []).includes(commandTarget(command))) return undefined
  const kinds = Array.isArray(p.kinds) && p.kinds.length > 0 ? p.kinds : [p.kind]
  const needs = consentNeeds(command).filter(n => kinds.includes(n.kind))
  const summary = needs.length > 0 ? needs.map(n => n.summary).join(' and ') : p.summary
  return { need: { kind: p.kind, summary, command: p.command }, kinds }
}

export function pendingConsent(h: Harness, sid: string): HeldConsent | undefined {
  const p = readConsentState(h, sid).pending
  return p !== undefined ? heldConsent(h, sid, p.command) : undefined
}

export function recordDialogGrants(h: Harness, sid: string, kinds: readonly ConsentKind[], answer: 'once' | 'session', now: number): void {
  for (const kind of kinds) recordDialogGrant(h, sid, kind, answer, now)
}

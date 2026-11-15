import { commandTarget, consentNeeded, type ConsentNeed } from '../../../core/policy/consent'
import type { Harness } from '../../../core/events'
import { readConsentState } from '../consent-store'

export function heldConsentNeed(harness: Harness, sid: string, command: string): ConsentNeed | undefined {
  const p = readConsentState(harness, sid).pending
  if (p !== undefined && (p.targets ?? []).includes(commandTarget(command))) return { kind: p.kind, summary: p.summary, command: p.command }
  return consentNeeded(command)
}

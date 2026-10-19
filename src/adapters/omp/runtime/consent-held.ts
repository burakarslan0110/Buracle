import { commandTarget, consentNeeded, type ConsentNeed } from '../../../core/policy/consent'
import { readConsentState } from '../../shared/consent-store'

export function heldConsentNeed(sid: string, command: string): ConsentNeed | undefined {
  const p = readConsentState('omp', sid).pending
  if (p !== undefined && (p.targets ?? []).includes(commandTarget(command))) return { kind: p.kind, summary: p.summary, command: p.command }
  return consentNeeded(command)
}

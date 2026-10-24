import { join } from 'node:path'
import type { Harness } from '../../core/events'
import { addConsentGrants, applyPromptGrants, consentVerdict, parseConsent, type ConsentGrant, type ConsentState } from '../../core/policy/consent'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import * as paths from '../../engine/paths'
import { withFileLock } from '../../workflow/session-store'

const LOCK_WAIT_MS = 1_500
const LOCK_STALE_MS = 10_000

export function consentFile(h: Harness, sid: string): string {
  return join(paths.sessionDir(h, sid), 'consent.json')
}

export function readConsentState(h: Harness, sid: string): ConsentState {
  const r = readJsonSafeSync<unknown>(consentFile(h, sid))
  return parseConsent(r.ok ? r.value : undefined)
}

export function writeConsentState(h: Harness, sid: string, s: ConsentState): void {
  ensureDirSync(paths.sessionDir(h, sid))
  atomicWriteSync(consentFile(h, sid), JSON.stringify(s) + '\n')
}

function settle<V extends { next: ConsentState }>(h: Harness, sid: string, decide: (s: ConsentState) => V): V {
  const seen = readConsentState(h, sid)
  const quick = decide(seen)
  if (quick.next === seen) return quick
  const update = (): V => {
    const s = readConsentState(h, sid)
    const v = decide(s)
    if (v.next !== s) writeConsentState(h, sid, v.next)
    return v
  }
  let ran = false
  try {
    ensureDirSync(paths.sessionDir(h, sid))
    return withFileLock(consentFile(h, sid), () => { ran = true; return update() }, LOCK_WAIT_MS, LOCK_STALE_MS)
  } catch (err) {
    if (ran) throw err
    return update()
  }
}

export function consentGate(h: Harness, sid: string, command: string, now: number, verdict: typeof consentVerdict = consentVerdict): string | undefined {
  const v = settle(h, sid, s => verdict(command, s, now))
  return v.allow ? undefined : v.reason
}

export function recordPromptGrants(h: Harness, sid: string, prompt: string, now: number): void {
  settle(h, sid, s => ({ next: applyPromptGrants(s, prompt, now) }))
}

export function recordUserGrants(h: Harness, sid: string, grants: readonly ConsentGrant[], now: number): void {
  if (grants.length === 0) return
  settle(h, sid, s => ({ next: addConsentGrants(s, grants, now) }))
}

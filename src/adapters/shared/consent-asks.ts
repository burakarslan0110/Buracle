import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../../core/events'
import { commandTarget } from '../../core/policy/consent'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync, sha256 } from '../../engine/fsx'
import * as paths from '../../engine/paths'

export const CONSENT_ASK_ID = /^[a-f0-9]{12,64}$/
export const CONSENT_ASK_TTL_MS = 15 * 60_000
const SWEEP_AFTER_MS = 24 * 60 * 60_000

export interface ConsentAskRecord { v: 1; key: string; harness: Harness; sid: string; command: string; target: string; at: number; call?: string; asked?: number }

export function consentAsksDir(): string {
  return join(paths.stateDir(), 'consent-asks')
}

export function consentAskKey(id: string): string {
  return sha256(id).slice(0, 32)
}

function file(key: string): string {
  return join(consentAsksDir(), `${key}.json`)
}

function parse(raw: unknown, key: string): ConsentAskRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (o['v'] !== 1 || o['key'] !== key || typeof o['sid'] !== 'string' || typeof o['command'] !== 'string' || typeof o['target'] !== 'string' || typeof o['at'] !== 'number') return undefined
  const h = o['harness']
  if (h !== 'claude' && h !== 'codex' && h !== 'opencode' && h !== 'omp') return undefined
  const out: ConsentAskRecord = { v: 1, key, harness: h, sid: o['sid'], command: o['command'], target: o['target'], at: o['at'] }
  if (typeof o['call'] === 'string') out.call = o['call']
  if (typeof o['asked'] === 'number') out.asked = o['asked']
  return out
}

function readByKey(key: string): ConsentAskRecord | undefined {
  const r = readJsonSafeSync<unknown>(file(key))
  return r.ok ? parse(r.value, key) : undefined
}

export function readConsentAsk(id: string): ConsentAskRecord | undefined {
  return CONSENT_ASK_ID.test(id) ? readByKey(consentAskKey(id)) : undefined
}

function sweep(now: number): void {
  let names: string[]
  try { names = readdirSync(consentAsksDir()) } catch { return }
  for (const name of names) {
    const p = join(consentAsksDir(), name)
    try { if (now - statSync(p).mtimeMs > SWEEP_AFTER_MS) rmSync(p, { force: true }) } catch {  }
  }
}

export function postConsentAsk(h: Harness, sid: string, command: string, id: string, now: number, call?: string): ConsentAskRecord | undefined {
  if (!CONSENT_ASK_ID.test(id) || !paths.isValidSessionId(sid)) return undefined
  ensureDirSync(consentAsksDir())
  sweep(now)
  const rec: ConsentAskRecord = { v: 1, key: consentAskKey(id), harness: h, sid, command, target: commandTarget(command), at: now }
  if (call !== undefined && call !== '') rec.call = call
  atomicWriteSync(file(rec.key), JSON.stringify(rec) + '\n', { mode: 0o600 })
  return rec
}

function sessionAsks(sid: string): ConsentAskRecord[] {
  let names: string[]
  try { names = readdirSync(consentAsksDir()) } catch { return [] }
  const out: ConsentAskRecord[] = []
  for (const name of names) {
    const key = /^([a-f0-9]{32})\.json$/.exec(name)?.[1]
    const rec = key !== undefined ? readByKey(key) : undefined
    if (rec !== undefined && rec.sid === sid) out.push(rec)
  }
  return out
}

export function unaskedConsent(sid: string, command: string, now: number): boolean {
  const target = commandTarget(command)
  return sessionAsks(sid).some(rec => rec.target === target && rec.asked === undefined && now - rec.at <= CONSENT_ASK_TTL_MS)
}

export function dropAnsweredAsks(sid: string, answered: (rec: ConsentAskRecord) => boolean): number {
  let dropped = 0
  for (const rec of sessionAsks(sid)) {
    if (rec.asked === undefined || !answered(rec)) continue
    rmSync(file(rec.key), { force: true })
    dropped++
  }
  return dropped
}

export function markConsentAsked(id: string, sid: string, command: string, now: number): boolean {
  const rec = readConsentAsk(id)
  if (rec === undefined || rec.sid !== sid || rec.command !== command || now - rec.at > CONSENT_ASK_TTL_MS) return false
  atomicWriteSync(file(rec.key), JSON.stringify({ ...rec, asked: now }) + '\n', { mode: 0o600 })
  return true
}

export type ConsentTake = { ok: true, record: ConsentAskRecord } | { ok: false, why: 'unknown' | 'changed' | 'expired' | 'not-asked' }

export function takeConsentAsk(id: string, command: string, now: number): ConsentTake {
  const rec = readConsentAsk(id)
  if (rec === undefined) return { ok: false, why: 'unknown' }
  rmSync(file(rec.key), { force: true })
  if (rec.command !== command || rec.target !== commandTarget(command)) return { ok: false, why: 'changed' }
  if (now - rec.at > CONSENT_ASK_TTL_MS) return { ok: false, why: 'expired' }
  if (rec.asked === undefined) return { ok: false, why: 'not-asked' }
  return { ok: true, record: rec }
}

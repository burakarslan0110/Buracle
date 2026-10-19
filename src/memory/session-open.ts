import { readdirSync, statSync } from 'node:fs'
import type { Harness } from '../core/events'
import { isHarness } from '../core/events'
import type { MemSessionRecord } from '../core/memory/session'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import * as paths from '../engine/paths'
import { sessionRecordFile, sessionRecordsDir } from './layout'
import { activeSpoolFiles } from './spool'

export interface SessionRecord extends MemSessionRecord { harness: Harness }

export function readSessionRecord(h: Harness, sid: string): SessionRecord | undefined {
  const r = readJsonSafeSync<SessionRecord>(sessionRecordFile(h, sid))
  return r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 1 ? r.value : undefined
}

export function writeSessionRecord(rec: SessionRecord): void {
  atomicWriteSync(sessionRecordFile(rec.harness, rec.sid), JSON.stringify(rec, null, 2) + '\n')
}

export const STALE_ACTIVE_MS = 2 * 3600_000

export function openSessions(nowMs: number, max = Number.POSITIVE_INFINITY): Array<{ h: Harness, sid: string }> {
  const out: Array<{ h: Harness, sid: string }> = []
  let names: string[] = []
  try { names = readdirSync(sessionRecordsDir()) } catch { return out }
  const byHarness = new Map<Harness, Set<string>>()
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const dash = n.indexOf('-')
    const h = n.slice(0, dash)
    const sid = n.slice(dash + 1, -'.json'.length)
    if (!isHarness(h) || !paths.isValidSessionId(sid)) continue
    let sids = byHarness.get(h)
    if (sids === undefined) { sids = new Set(); byHarness.set(h, sids) }
    sids.add(sid)
  }
  for (const [h, sids] of byHarness) {
    const spooled = activeSpoolFiles(h, sids)
    for (const sid of sids) {
      let last: number
      try { last = statSync(sessionRecordFile(h, sid)).mtimeMs } catch { continue }
      for (const f of spooled.get(sid) ?? []) { try { last = Math.max(last, statSync(f).mtimeMs) } catch {  } }
      if (nowMs - last >= STALE_ACTIVE_MS) continue
      if (readSessionRecord(h, sid)?.status !== 'active') continue
      out.push({ h, sid })
      if (out.length >= max) return out
    }
  }
  return out
}

export function anySessionOpen(nowMs: number): boolean {
  return openSessions(nowMs, 1).length > 0
}

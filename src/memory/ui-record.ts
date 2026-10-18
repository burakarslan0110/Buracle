import { readJsonSafeSync } from '../engine/fsx'
import * as paths from '../engine/paths'

export interface UiRecord { v: 1; pid: number; port: number; host: string; url: string; startedAt: string; version: string; build?: string; brain: string }

export function readUiRecord(): UiRecord | undefined {
  const r = readJsonSafeSync<UiRecord>(paths.memoryUiStateFile())
  const v = r.ok ? r.value : undefined
  if (v === undefined || v === null || typeof v !== 'object' || typeof v.pid !== 'number' || typeof v.port !== 'number' || typeof v.url !== 'string') return undefined
  return v
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

export function liveUiRecord(): UiRecord | undefined {
  const rec = readUiRecord()
  return rec !== undefined && processAlive(rec.pid) ? rec : undefined
}

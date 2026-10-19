import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Harness } from '../core/events'
import type { RateWindow } from '../core/status/model'
import { readJsonSafeSync } from '../engine/fsx'
import { isValidSessionId, sessionsDir } from '../engine/paths'
import type { Telemetry } from '../workflow/session-store'

export function latestTelemetry(h: Harness, opts: { cwd?: string, maxRead?: number } = {}): Telemetry | undefined {
  const dir = sessionsDir(h)
  let names: string[]
  try { names = readdirSync(dir) } catch { return undefined }
  const files: Array<{ path: string, mtime: number }> = []
  for (const sid of names) {
    if (!isValidSessionId(sid)) continue
    const path = join(dir, sid, 'telemetry.json')
    try { files.push({ path, mtime: statSync(path).mtimeMs }) } catch {  }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const want = opts.cwd !== undefined ? resolve(opts.cwd) : undefined
  let first: Telemetry | undefined
  for (const f of files.slice(0, opts.maxRead ?? 25)) {
    const r = readJsonSafeSync<Telemetry>(f.path)
    if (!r.ok || r.value === null || typeof r.value !== 'object' || r.value.v !== 1) continue
    first ??= r.value
    if (want === undefined) return r.value
    const c = r.value.cwd !== undefined ? resolve(r.value.cwd) : undefined
    if (c !== undefined && (c === want || want.startsWith(c + '/'))) return r.value
  }
  return first
}

export const WINDOWS_MAX_AGE_MS = 6 * 60 * 60_000

export function latestWindows(h: Harness, nowMs: number, opts: { maxAgeMs?: number, maxRead?: number } = {}): RateWindow[] {
  const dir = sessionsDir(h)
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const files: Array<{ path: string, mtime: number }> = []
  for (const sid of names) {
    if (!isValidSessionId(sid)) continue
    const path = join(dir, sid, 'telemetry.json')
    try { files.push({ path, mtime: statSync(path).mtimeMs }) } catch {  }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const maxAge = opts.maxAgeMs ?? WINDOWS_MAX_AGE_MS
  for (const f of files.slice(0, opts.maxRead ?? 25)) {
    const r = readJsonSafeSync<Telemetry>(f.path)
    if (!r.ok || r.value === null || typeof r.value !== 'object' || r.value.v !== 1 || !Array.isArray(r.value.windows)) continue
    const at = typeof r.value.windowsAt === 'number' ? r.value.windowsAt : r.value.at
    if (!(nowMs - at <= maxAge)) continue
    const live = liveWindows(r.value.windows, nowMs)
    if (live.length > 0) return live
  }
  return []
}

export function liveWindows(windows: RateWindow[] | undefined, nowMs: number): RateWindow[] {
  if (!Array.isArray(windows)) return []
  return windows.filter(w => {
    if (w === null || typeof w !== 'object' || typeof w.pct !== 'number' || typeof w.label !== 'string') return false
    if (w.resetsAt === undefined) return true
    const t = Date.parse(w.resetsAt)
    return !Number.isFinite(t) || t > nowMs
  })
}

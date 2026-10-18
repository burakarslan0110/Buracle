import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Harness } from '../core/events'
import { isHarness } from '../core/events'
import { revParse } from '../engine/git'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { locksDir, sessionRecordFile, sessionRecordsDir, spoolDir } from './layout'
import { projectExclusion, resolveProject } from './project'
import { readSessionRecord, writeSessionRecord, type SessionRecord } from './session-open'
import { spawnCli } from './spawn'
import { captureOff } from './spool'
import { maybeStartTick } from './tick-start'

export { anySessionOpen, openSessions, readSessionRecord, STALE_ACTIVE_MS, writeSessionRecord, type SessionRecord } from './session-open'

export interface SessionStartResult {
  skipped?: 'invalid-session' | 'not-a-project' | 'error' | 'capture-off'
  slug?: string
  resumed?: boolean
}

const KICK_ONCE_MS = 2 * 60_000

export function spawnKick(h: Harness, sid: string, cwd: string, opts: { nowMs?: number, spawn?: (args: string[]) => number | undefined } = {}): boolean {
  const nowMs = opts.nowMs ?? Date.now()
  if (process.env['BURACLE_NO_AUTOSTART'] === '1') return false
  try {
    const mark = join(locksDir(), `kick-${h}-${sid}`)
    mkdirSync(locksDir(), { recursive: true })
    try {
      closeSync(openSync(mark, 'wx', 0o600))
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
      try { if (nowMs - statSync(mark).mtimeMs < KICK_ONCE_MS) return false } catch {  }
      try { unlinkSync(mark) } catch {  }
      closeSync(openSync(mark, 'wx', 0o600))
    }
    return (opts.spawn ?? spawnCli)(['mem', 'kick', '--harness', h, '--session', sid, '--cwd', resolve(cwd)]) !== undefined
  } catch { return false  }
}

export async function sessionStart(h: Harness, sid: string, cwd: string, opts: { nowMs?: number, model?: string } = {}): Promise<SessionStartResult> {
  if (paths.isValidSessionId(sid) && isHarness(h)) spawnKick(h, sid, cwd)
  if (captureOff()) return { skipped: 'capture-off' }
  try {
    if (!paths.isValidSessionId(sid) || !isHarness(h)) return { skipped: 'invalid-session' }
    const now = opts.nowMs ?? Date.now()
    const prev = readSessionRecord(h, sid)
    if (prev !== undefined) {
      writeSessionRecord({ ...prev, status: 'active' })
      return { resumed: true, ...(prev.slug !== undefined ? { slug: prev.slug } : {}) }
    }
    const project = await resolveProject(cwd)
    const rec: SessionRecord = { v: 1, harness: h, sid, cwd: resolve(cwd), startedMs: now, status: 'active' }
    if (!project) {
      if ((await projectExclusion(cwd).catch(() => undefined)) !== undefined) rec.excluded = true
      writeSessionRecord(rec)
      return { skipped: 'not-a-project' }
    }
    const [branch, commit] = await Promise.all([revParse(cwd, '--abbrev-ref', 'HEAD'), revParse(cwd, '--short', 'HEAD')])
    rec.slug = project.slug
    if (branch !== undefined && branch !== '' && branch !== 'HEAD') rec.branch = branch
    if (commit !== undefined && /^[0-9a-f]{4,40}$/.test(commit)) rec.commitStart = commit
    writeSessionRecord(rec)
    return { slug: project.slug, resumed: false }
  } catch (e) {
    log('error', 'memory: session start failed', { h, sid, cwd, error: e })
    return { skipped: 'error' }
  }
}

export function latestSessionRecord(slug?: string, h?: Harness): SessionRecord | undefined {
  let names: string[] = []
  try { names = readdirSync(sessionRecordsDir()) } catch { return undefined }
  let best: SessionRecord | undefined
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const dash = n.indexOf('-')
    const rh = n.slice(0, dash)
    const sid = n.slice(dash + 1, -'.json'.length)
    if (!isHarness(rh) || (h !== undefined && rh !== h) || !paths.isValidSessionId(sid)) continue
    const rec = readSessionRecord(rh, sid)
    if (rec === undefined || (slug !== undefined && rec.slug !== slug)) continue
    if (best === undefined || rec.startedMs > best.startedMs) best = rec
  }
  return best
}

export function promptSeen(h: Harness, sid: string, opts: { nowMs?: number } = {}): boolean {
  if (!paths.isValidSessionId(sid) || !isHarness(h) || captureOff()) return false
  try {
    const file = sessionRecordFile(h, sid)
    const rec = readSessionRecord(h, sid)
    if (rec?.status === 'ended') writeSessionRecord({ ...rec, status: 'active' })
    const t = new Date(opts.nowMs ?? Date.now())
    utimesSync(file, t, t)
  } catch {  }
  return maybeStartTick({ harness: h, sid, trigger: 'prompt', ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}) })
}

export function compactSeen(h: Harness, sid: string, opts: { nowMs?: number } = {}): boolean {
  if (!paths.isValidSessionId(sid) || !isHarness(h) || captureOff()) return false
  return maybeStartTick({ harness: h, sid, trigger: 'compact', ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}) })
}

export function recentProjectSlugs(sinceMs: number): string[] {
  let names: string[] = []
  try { names = readdirSync(sessionRecordsDir()) } catch { return [] }
  const best = new Map<string, number>()
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const dash = n.indexOf('-')
    const rh = n.slice(0, dash)
    const sid = n.slice(dash + 1, -'.json'.length)
    if (!isHarness(rh) || !paths.isValidSessionId(sid)) continue
    const rec = readSessionRecord(rh, sid)
    if (rec?.slug === undefined) continue
    const at = Math.max(rec.startedMs, rec.finalizedMs ?? 0)
    if (at < sinceMs) continue
    if ((best.get(rec.slug) ?? 0) < at) best.set(rec.slug, at)
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(e => e[0])
}

export function spawnFinalizer(h: Harness, sid: string): void {
  spawnFinalizerPid(h, sid)
}

export function spawnFinalizerPid(h: Harness, sid: string): number | undefined {
  if (captureOff()) return undefined
  if (!paths.isValidSessionId(sid) || !isHarness(h)) return undefined
  try { mkdirSync(spoolDir(), { recursive: true }) } catch {  }
  return spawnCli(['mem', 'finalize', '--harness', h, '--session', sid], { BURACLE_FINALIZER: '1' })
}

import { mkdirSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Harness } from '../core/events'
import { isHarness } from '../core/events'
import { revParse } from '../engine/git'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { locksDir, sessionRecordFile, spoolDir } from './layout'
import { lockHeld } from './lock'
import { projectExclusion, resolveProject } from './project'
import { readSessionRecord, writeSessionRecord, type SessionRecord } from './session-open'
import { spawnCli } from './spawn'
import { captureOff } from './spool'

export { anySessionOpen, latestSessionRecord, openSessions, readSessionRecord, STALE_ACTIVE_MS, writeSessionRecord, type SessionRecord } from './session-open'

export interface SessionStartResult {
  skipped?: 'invalid-session' | 'not-a-project' | 'error' | 'capture-off'
  slug?: string
  resumed?: boolean
}

export async function sessionStart(h: Harness, sid: string, cwd: string, opts: { nowMs?: number, model?: string } = {}): Promise<SessionStartResult> {
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

/** A prompt arrived: the session is alive. Touches its record (which keeps it "open") and spawns nothing. */
export function promptSeen(h: Harness, sid: string, opts: { nowMs?: number } = {}): void {
  if (!paths.isValidSessionId(sid) || !isHarness(h) || captureOff()) return
  try {
    const file = sessionRecordFile(h, sid)
    const rec = readSessionRecord(h, sid)
    if (rec?.status === 'ended') writeSessionRecord({ ...rec, status: 'active' })
    const t = new Date(opts.nowMs ?? Date.now())
    utimesSync(file, t, t)
  } catch {  }
}

export function spawnFinalizer(h: Harness, sid: string): void {
  spawnFinalizerPid(h, sid)
}

export function spawnFinalizerPid(h: Harness, sid: string): number | undefined {
  if (captureOff()) return undefined
  if (!paths.isValidSessionId(sid) || !isHarness(h)) return undefined
  try { mkdirSync(spoolDir(), { recursive: true }) } catch {  }
  if (lockHeld(join(locksDir(), `finalize-${h}-${sid}.lock`), 5 * 60_000)) return undefined
  return spawnCli(['mem', 'finalize', '--harness', h, '--session', sid], { BURACLE_FINALIZER: '1' })
}

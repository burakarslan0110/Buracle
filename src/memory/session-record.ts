import { mkdirSync, statSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Harness } from '../core/events'
import { isHarness } from '../core/events'
import { revParse } from '../engine/git'
import { run } from '../engine/proc'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { locksDir, sessionRecordFile, spoolDir } from './layout'
import { lockHeld } from './lock'
import { projectExclusion, resolveProject } from './project'
import { readSessionRecord, writeSessionRecord, type SessionRecord } from './session-open'
import { spawnCli } from './spawn'
import { captureOff } from './spool'

export { latestSessionRecord, openSessions, readSessionRecord, STALE_ACTIVE_MS, writeSessionRecord, type SessionRecord } from './session-open'

const BASELINE_MAX = 200

/** A cheap identity of a file as it is now: size and modification time, or `gone` when it does not exist. */
export function fileFingerprint(root: string, rel: string): string {
  try {
    const st = statSync(join(root, rel))
    return `${st.size}:${Math.floor(st.mtimeMs)}`
  } catch { return 'gone' }
}

/**
 * The paths git lists as modified or untracked in a working tree, from one `git status` call, with a fingerprint each.
 * No git, no repository or too many paths: undefined, and the session's file list stays what git reports at its end.
 */
async function gitBaseline(cwd: string, root: string): Promise<Record<string, string> | undefined> {
  const r = await run(['git', '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, timeoutMs: 5000, env: { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } })
  if (r.code !== 0) return undefined
  const parts = r.stdout.split('\0')
  const out: Record<string, string> = {}
  for (let n = 0; n < parts.length; n++) {
    const entry = parts[n] ?? ''
    if (entry.length < 4) continue
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') n++
    out[entry.slice(3)] = fileFingerprint(root, entry.slice(3))
    if (Object.keys(out).length > BASELINE_MAX) return undefined
  }
  return out
}

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
    const [branch, commitAndRoot] = await Promise.all([revParse(cwd, '--abbrev-ref', 'HEAD'), revParse(cwd, '--show-toplevel', '--short', 'HEAD')])
    const [root, commit] = (commitAndRoot ?? '').split('\n')  // git prints the root first
    rec.slug = project.slug
    if (branch !== undefined && branch !== '' && branch !== 'HEAD') rec.branch = branch
    if (commit !== undefined && /^[0-9a-f]{4,40}$/.test(commit)) rec.commitStart = commit
    const baseline = root !== undefined && root !== '' ? await gitBaseline(cwd, root) : undefined
    if (baseline !== undefined && Object.keys(baseline).length > 0) rec.baseline = baseline
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

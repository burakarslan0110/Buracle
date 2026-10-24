import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Harness } from '../core/events'
import { isHarness } from '../core/events'
import { memNoteHarness } from '../core/memory/note'
import { CAPTURE_BUDGET } from '../core/memory/budgets'
import { SESSION_KEEP_MS } from '../core/memory/brain'
import { memSessionAreas, memSessionBody, memSessionMemoryId, memSessionOutcome, memSessionStats, memSessionTitle, type MemCaptureState } from '../core/memory/session'
import { spoolDigest, spoolIsEmptySession, type SpoolDigest } from '../core/memory/spool'
import { memClip, redact } from '../core/memory/text'
import { readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { run } from '../engine/proc'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { loadState } from '../workflow/session-store'
import { capturePreferences, logPending, pendingSessions, type PendingSession, type PreferenceResult } from './capture'
import { distillSession, type DistillResult, type DistillRunner } from './distill'
import { removeDeadLocks } from './housekeeping'
import { locksDir, sessionRecordsDir, spoolDoneDir } from './layout'
import { acquireLock, lockHeld } from './lock'
import { projectExclusion, readProjectsCache, resolveProject, tzOffset, type ProjectRecord } from './project'
import { readSessionRecord, writeSessionRecord, type SessionRecord } from './session-record'
import { captureOff, deleteSpool, pruneRedactions, readSpool, recordRedactions, spoolFiles } from './spool'
import { refreshStatus } from './status'
import { getStored, projectRef, recordEvent, saveItem, withBrainLock } from './store'

export { bunExecutable, cliArgv, moduleCheckout } from './spawn'

export { promptSeen, readSessionRecord, sessionStart, spawnFinalizer, spawnFinalizerPid, type SessionRecord, type SessionStartResult } from './session-record'

export interface CaptureSummary {
  state: MemCaptureState['state']
  preferences: PreferenceResult
  distill?: Pick<DistillResult, 'ran' | 'skipped' | 'detail' | 'candidates' | 'summary' | 'ranBy' | 'model'>
}

export interface FinalizeResult {
  skipped?: 'invalid-session' | 'no-store' | 'busy' | 'unknown-session' | 'capture-off' | 'already-finalized'
  slug?: string
  memoryId?: string
  changed?: boolean
  redactions?: number
  empty?: boolean
  capture?: CaptureSummary
  pending?: Array<{ harness: Harness, sid: string, why: PendingSession['why'], result: FinalizeResult }>
}

interface GitFacts { commitEnd?: string, commits: string[], count?: number, diffstat?: string }

async function gitFacts(cwd: string, commitStart?: string): Promise<GitFacts> {
  const out: GitFacts = { commits: [] }
  if (!existsSync(cwd)) return out
  const head = await run(['git', 'rev-parse', '--short', 'HEAD'], { cwd, timeoutMs: 5000, env: { LC_ALL: 'C' } })
  if (head.code !== 0) return out
  out.commitEnd = head.stdout.trim()
  if (commitStart === undefined || commitStart === out.commitEnd) return out
  const range = `${commitStart}..HEAD`
  const logR = await run(['git', 'log', '--no-merges', '-n', '20', '--format=%h %s', range], { cwd, timeoutMs: 5000, env: { LC_ALL: 'C' } })
  if (logR.code === 0) out.commits = logR.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  const countR = await run(['git', 'rev-list', '--no-merges', '--count', range], { cwd, timeoutMs: 5000, env: { LC_ALL: 'C' } })
  if (countR.code === 0 && /^\d+$/.test(countR.stdout.trim())) out.count = Number(countR.stdout.trim())
  const stat = await run(['git', 'diff', '--shortstat', range], { cwd, timeoutMs: 5000, env: { LC_ALL: 'C' } })
  if (stat.code === 0 && stat.stdout.trim() !== '') out.diffstat = stat.stdout.trim()
  return out
}

function guessProjectFromSpool(digest: SpoolDigest): string | undefined {
  const abs = digest.files.find(f => f.startsWith('/'))
  return abs !== undefined ? dirname(abs) : undefined
}

function spoolSnapshot(h: Harness, sid: string): Map<string, number> {
  const snap = new Map<string, number>()
  for (const f of spoolFiles(h, sid).active) {
    try { snap.set(f, statSync(f).size) } catch {  }
  }
  return snap
}

function moveSpoolToDone(h: Harness, sid: string, now: number, snap: Map<string, number>): boolean {
  const done = spoolDoneDir()
  if (snap.size > 0) mkdirSync(done, { recursive: true })
  for (const [f, size] of snap) {
    let cur: number | undefined
    try { cur = statSync(f).size } catch { continue }
    if (cur !== size) continue
    const stem = basename(f, '.jsonl')
    for (let i = 0; i < 1000; i++) {
      const target = join(done, i === 0 ? `${stem}.jsonl` : `${stem}-f${now}${i === 1 ? '' : `-${i}`}.jsonl`)
      try {
        linkSync(f, target)
        unlinkSync(f)
        break
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === 'EEXIST') continue
        if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV') {
          if (existsSync(target)) continue
          try { renameSync(f, target) } catch (e2) { log('warn', 'memory: cannot move spool file', { f, error: e2 }) }
          break
        }
        log('warn', 'memory: cannot move spool file', { f, error: e })
        break
      }
    }
  }
  const leftBehind = spoolFiles(h, sid).active.length > 0
  try {
    for (const n of readdirSync(done)) {
      const p = join(done, n)
      try { if (now - statSync(p).mtimeMs > 14 * 24 * 3600_000) unlinkSync(p) } catch {  }
    }
  } catch {  }
  return leftBehind
}

export interface FinalizeOptions {
  nowMs?: number
  graceMs?: number
  settleMs?: number
  /** Redo the capture of a session that was finalized before (`buracle mem capture`). */
  force?: boolean
  /** Distill again although the same material was distilled before. */
  redistill?: boolean
  /** How many other stale sessions to capture too; 0 or false skips them (default: the budget's). */
  pending?: number | false
  /** Stop starting pending captures after this time (ms since the epoch). */
  deadlineMs?: number
  runner?: DistillRunner
  model?: string
}

/** The longest a detached finalizer keeps starting work: its own session, then others. */
export const FINALIZE_BUDGET_MS = 12 * 60_000

export async function finalize(h: Harness, sid: string, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
  if (captureOff()) return { skipped: 'capture-off' }
  if (!paths.isValidSessionId(sid) || !isHarness(h)) return { skipped: 'invalid-session' }
  if (cortexdbBinary() === undefined) return { skipped: 'no-store' }
  const deadline = opts.deadlineMs ?? (opts.nowMs ?? Date.now()) + FINALIZE_BUDGET_MS
  if (opts.graceMs !== undefined && opts.graceMs > 0) await Bun.sleep(opts.graceMs)
  const release = await acquireLock(join(locksDir(), `finalize-${h}-${sid}.lock`), { timeoutMs: 30_000, staleMs: 5 * 60_000, heartbeat: true })
  if (!release) return { skipped: 'busy' }
  try {
    const prev = readSessionRecord(h, sid)
    const settled = prev?.status === 'ended' && spoolFiles(h, sid).active.length === 0
    const redo = settled && (opts.force === true || prev.capture?.state === 'retry')
    if (settled && !redo) {
      return { skipped: 'already-finalized', ...(prev.slug !== undefined ? { slug: prev.slug } : {}), ...(prev.memoryId !== undefined ? { memoryId: prev.memoryId } : {}) }
    }
    let pass = redo ? await redoPass(h, sid) : await finalizePass(h, sid, opts)
    for (let n = 1; !redo && n < 3 && pass.result.skipped === undefined; n++) {
      if (opts.settleMs !== undefined && opts.settleMs > 0) await Bun.sleep(opts.settleMs)
      if (spoolFiles(h, sid).active.length === 0) break
      pass = await finalizePass(h, sid, opts)
    }
    if (pass.result.skipped !== undefined) return pass.result
    const now = opts.nowMs ?? Date.now()
    const capture = await captureStep(h, sid, pass, opts)
    if (capture !== undefined) pass.result.capture = capture
    if (opts.pending !== false && opts.pending !== 0) {
      const done = await capturePending({ ...opts, skip: { h, sid }, deadlineMs: deadline, ...(typeof opts.pending === 'number' ? { max: opts.pending } : {}) })
      if (done.length > 0) pass.result.pending = done
    }
    await finalizeTail(h, pass, now, capture)
    return pass.result
  } catch (e) {
    log('error', 'memory: finalize failed', { h, sid, error: e })
    throw e
  } finally {
    release()
  }
}

export interface PendingCaptureOptions extends FinalizeOptions {
  skip?: { h: Harness, sid: string }
  max?: number
}

/** Captures the stale sessions whose capture is still owed (`why` says what is missing), oldest first, within the deadline. */
export async function capturePending(opts: PendingCaptureOptions = {}): Promise<NonNullable<FinalizeResult['pending']>> {
  const now = opts.nowMs ?? Date.now()
  const deadline = opts.deadlineMs ?? now + FINALIZE_BUDGET_MS
  const pending = pendingSessions(now, { ...(opts.skip !== undefined ? { skip: opts.skip } : {}), ...(opts.max !== undefined ? { max: opts.max } : {}) })
  logPending(pending)
  const done: NonNullable<FinalizeResult['pending']> = []
  for (const p of pending) {
    if (Date.now() >= deadline) break
    if (lockHeld(join(locksDir(), `finalize-${p.h}-${p.sid}.lock`), 5 * 60_000)) continue
    try {
      const { skip: _skip, max: _max, ...rest } = opts
      const result = await finalize(p.h, p.sid, { ...rest, graceMs: 0, settleMs: 0, pending: false, force: p.why === 'retry', deadlineMs: deadline })
      done.push({ harness: p.h, sid: p.sid, why: p.why, result })
    } catch (e) { log('warn', 'memory: a stale session was not captured', { h: p.h, sid: p.sid, error: e }) }
  }
  return done
}

interface FinalizePass {
  result: FinalizeResult
  rec: SessionRecord
  project?: ProjectRecord
  digest: SpoolDigest
}

async function projectOf(rec: SessionRecord | undefined, cwd: string | undefined): Promise<{ project?: ProjectRecord, excluded: boolean }> {
  let project: ProjectRecord | undefined
  if (rec?.slug !== undefined) project = readProjectsCache().projects[rec.slug]
  if (!project && cwd !== undefined) project = await resolveProject(cwd)
  const excluded = (await projectExclusion(rec?.cwd ?? cwd ?? project?.roots[0] ?? paths.home()).catch(() => undefined)) !== undefined
  return excluded ? { excluded } : { ...(project !== undefined ? { project } : {}), excluded }
}

/** A session already finalized: read it again for the capture, without rewriting its session memory. */
async function redoPass(h: Harness, sid: string): Promise<FinalizePass> {
  const rec = readSessionRecord(h, sid) as SessionRecord
  const digest = spoolDigest(readSpool(h, sid), rec.cwd)
  const { project } = await projectOf(rec, rec.cwd)
  const result: FinalizeResult = { ...(project !== undefined ? { slug: project.slug } : {}), ...(rec.memoryId !== undefined ? { memoryId: rec.memoryId } : {}) }
  return { result, rec, ...(project !== undefined ? { project } : {}), digest }
}

async function finalizePass(h: Harness, sid: string, opts: FinalizeOptions): Promise<FinalizePass> {
  const now = opts.nowMs ?? Date.now()
  const snap = spoolSnapshot(h, sid)
  const entries = readSpool(h, sid)
  let rec = readSessionRecord(h, sid)
  const cwdGuess = rec?.cwd ?? guessProjectFromSpool(spoolDigest(entries))
  const digest = spoolDigest(entries, cwdGuess)
  if (!rec && entries.length === 0) return { result: { skipped: 'unknown-session' }, rec: { v: 1, harness: h, sid, cwd: paths.home(), startedMs: now, status: 'active' }, digest }
  const { project, excluded } = await projectOf(rec, cwdGuess)
  if (!rec) {
    rec = { v: 1, harness: h, sid, cwd: cwdGuess ?? paths.home(), startedMs: digest.startedMs ?? now, status: 'active' }
    if (project) rec.slug = project.slug
  }
  const result: FinalizeResult = {}
  const harness = memNoteHarness(h)
  let facts: GitFacts | undefined
  if (project) {
    result.slug = project.slug
    const ref = projectRef(project.slug)
    const git = await gitFacts(rec.cwd, rec.commitStart)
    facts = git
    const id = rec.memoryId ?? memSessionMemoryId(harness, sid)
    if (spoolIsEmptySession(digest) && git.commits.length === 0) {
      result.empty = true
    } else await withBrainLock(ref, async () => {
      const existing = await getStored(ref, id)
      let topic: string | undefined
      try { topic = loadState(h, sid).plan?.slug } catch { topic = undefined }
      topic ??= memSessionAreas(digest.files)[0]
      const startedMs = rec.startedMs
      const endedMs = Math.max(digest.endedMs ?? rec.finalizedMs ?? now, startedMs)
      const off = tzOffset(startedMs)
      const summary = digest.finalMessage ?? digest.compactions[digest.compactions.length - 1]?.summary
      const bodyRaw = memSessionBody({ startedMs, endedMs, offsetMin: off, ...(rec.branch !== undefined ? { branch: rec.branch } : {}) }, digest, { commits: git.commits, ...(git.diffstat !== undefined ? { diffstat: git.diffstat } : {}), ...(summary !== undefined ? { summary: memClip(summary, 2000) } : {}) })
      const body = redact(bodyRaw)
      result.redactions = body.count
      recordRedactions(body.count, body.kinds, 'finalize', now)
      const outcome = memSessionOutcome(digest, { commits: git.commits }) ?? ''
      const title = memSessionTitle(harness, startedMs, off, topic)
      const at = new Date(now).toISOString()
      const distilled = existing?.item.tags.includes('distilled') === true ? existing.item.summary : undefined
      await saveItem(ref, {
        id, kind: 'session', layer: 'project', title, summary: distilled ?? outcome, body: body.text,
        tags: ['session', harness, ...(existing?.item.tags.includes('distilled') === true ? ['distilled'] : [])], sources: [], about: [], status: 'active', review: 'ok',
        importance: 2, created: existing?.item.created ?? new Date(startedMs).toISOString(), updated: at, author: 'buracle', version: (existing?.item.version ?? 0) + 1,
        history: [...(existing?.item.history ?? []), { at, by: 'buracle', what: existing ? 'finalized again' : 'session ended' }].slice(-8),
        harness, session: sid, ...(rec.branch !== undefined ? { branch: rec.branch } : {}), ...(git.commitEnd !== undefined ? { commit: git.commitEnd } : {}),
        ...(digest.model !== undefined ? { model: digest.model } : {}), expires: new Date(endedMs + SESSION_KEEP_MS).toISOString(),
      }, existing?.keep ?? {}, { nowMs: now })
      recordEvent({ op: 'write', layer: 'project', project: project.slug, id, kind: 'session', by: harness })
      result.memoryId = id
      result.changed = true
      rec.memoryId = id
    })
  }
  if (excluded) deleteSpool(h, sid)
  else moveSpoolToDone(h, sid, now, snap)
  const { stats: _stale, ...base } = rec
  const measured = facts !== undefined && rec.commitStart !== undefined && facts.commitEnd !== undefined ? facts : undefined
  const stats = excluded ? undefined : memSessionStats(digest, measured !== undefined ? { commits: measured.count ?? measured.commits.length, ...(measured.diffstat !== undefined ? { diffstat: measured.diffstat } : {}) } : undefined)
  const ended: SessionRecord = { ...base, status: 'ended', finalizedMs: now, ...(stats !== undefined ? { stats } : {}) }
  writeSessionRecord(ended)
  return { result, rec: ended, ...(project !== undefined ? { project } : {}), digest }
}

/**
 * Steps two and three of a session end, after the session memory: the user's explicit statements become
 * preference memories (no model), then one bounded model call distills the durable decisions, gotchas and
 * procedures. A model call that fails, is held back by a rate limit, or answers with an invalid reply writes
 * nothing; the session record remembers that another try is owed.
 */
async function captureStep(h: Harness, sid: string, pass: FinalizePass, opts: FinalizeOptions): Promise<CaptureSummary | undefined> {
  const { project, digest } = pass
  if (!project) return undefined
  const now = opts.nowMs ?? Date.now()
  const rec = readSessionRecord(h, sid) ?? pass.rec
  let preferences: PreferenceResult = { written: [], superseded: [], skipped: 0 }
  try {
    preferences = await capturePreferences(digest.signals, { harness: h, sid, cwd: rec.cwd, nowMs: now })
  } catch (e) { log('warn', 'memory: the preferences of a session were not filed', { h, sid, error: e }) }
  let distill: DistillResult | undefined
  try {
    distill = await distillSession(h, sid, { nowMs: now, ...(opts.runner !== undefined ? { runner: opts.runner } : {}), ...(opts.model !== undefined ? { model: opts.model } : {}), force: opts.redistill === true })
  } catch (e) {
    log('warn', 'memory: the distillation of a session failed', { h, sid, error: e })
  }
  const prior = rec.capture
  const tries = prior?.tries ?? 0
  let next: MemCaptureState
  const skipped = distill?.skipped
  if (distill === undefined) next = { state: 'retry', tries: tries + 1, lastTryMs: now, detail: 'the distillation threw' }
  else if (distill.ran) next = { state: 'done', tries, lastTryMs: now, ...(distill.sha !== undefined ? { sha: distill.sha } : {}) }
  else if (skipped === 'runner-failed' || skipped === 'invalid-reply') {
    next = { state: tries + 1 >= CAPTURE_BUDGET.maxTries ? 'gave-up' : 'retry', tries: tries + 1, lastTryMs: now, ...(distill.detail !== undefined ? { detail: memClip(distill.detail, 300) } : {}) }
  } else if (skipped === 'rate-limit' || skipped === 'no-harness' || skipped === 'runner-unavailable' || skipped === 'busy') {
    next = { state: 'retry', tries, lastTryMs: now, ...(distill.detail !== undefined ? { detail: memClip(distill.detail, 300) } : {}) }
  } else next = { state: 'done', tries, lastTryMs: now, ...(distill?.sha !== undefined ? { sha: distill.sha } : prior?.sha !== undefined ? { sha: prior.sha } : {}) }
  writeSessionRecord({ ...rec, capture: next })
  const out: CaptureSummary = { state: next.state, preferences }
  if (distill !== undefined) {
    const { ran, skipped: sk, detail, candidates, summary, ranBy, model } = distill
    out.distill = { ran, ...(sk !== undefined ? { skipped: sk } : {}), ...(detail !== undefined ? { detail } : {}), candidates, ...(summary !== undefined ? { summary } : {}), ...(ranBy !== undefined ? { ranBy } : {}), ...(model !== undefined ? { model } : {}) }
  }
  return out
}

async function finalizeTail(h: Harness, pass: FinalizePass, now: number, capture: CaptureSummary | undefined): Promise<void> {
  const { result, project } = pass
  const harness = memNoteHarness(h)
  const saved = (capture?.preferences.written.length ?? 0) + (capture?.distill?.candidates.length ?? 0)
  await refreshStatus({
    ...(project ? { slug: project.slug } : {}), nowMs: now,
    ...(result.changed === true ? { lastWrite: { by: harness, type: 'session' } } : {}),
    ...(capture?.distill?.ran === true || (capture?.preferences.written.length ?? 0) > 0 ? { lastCapture: { by: harness, saved } } : {}),
  })
  pruneRedactions(now)
  pruneSessionRecords(now)
  try { removeDeadLocks(now) } catch (e) { log('warn', 'memory: dead locks were not cleaned', { error: e }) }
}

const RECORD_KEEP_MS = 30 * 24 * 3600_000

function pruneSessionRecords(now: number): void {
  let names: string[] = []
  try { names = readdirSync(sessionRecordsDir()) } catch { return }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const file = join(sessionRecordsDir(), n)
    try { if (now - statSync(file).mtimeMs <= RECORD_KEEP_MS) continue } catch { continue }
    const r = readJsonSafeSync<SessionRecord>(file)
    if (r.ok && r.value?.status === 'ended' && typeof r.value.finalizedMs === 'number' && now - r.value.finalizedMs > RECORD_KEEP_MS) {
      try { unlinkSync(file) } catch {  }
    }
  }
}

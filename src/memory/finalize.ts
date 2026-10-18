import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Harness } from '../core/events'
import { isHarness } from '../core/events'
import { memNoteHarness } from '../core/memory/note'
import { memSessionAreas, memSessionBody, memSessionMemoryId, memSessionOutcome, memSessionStats, memSessionTitle } from '../core/memory/session'
import { spoolDigest, spoolIsEmptySession, type SpoolDigest } from '../core/memory/spool'
import { memClip, redact } from '../core/memory/text'
import { readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { run } from '../engine/proc'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { loadState } from '../workflow/session-store'
import { locksDir, sessionRecordsDir, spoolDoneDir } from './layout'
import { appendJob } from './jobs'
import { acquireLock } from './lock'
import { projectExclusion, readProjectsCache, resolveProject, tzOffset, type ProjectRecord } from './project'
import { readSessionRecord, writeSessionRecord, type SessionRecord } from './session-record'
import { captureOff, deleteSpool, pruneRedactions, readSpool, recordRedactions, spoolFiles } from './spool'
import { refreshStatus } from './status'
import { getStored, personRef, projectRef, recordEvent, saveItem, withBrainLock } from './store'
import { refreshUpkeepFor } from './sweep'
import { maybeStartTick } from './tick-start'

export { bunExecutable, cliArgv, moduleCheckout } from './spawn'

export { compactSeen, promptSeen, readSessionRecord, sessionStart, spawnFinalizer, spawnFinalizerPid, type SessionRecord, type SessionStartResult } from './session-record'

export interface FinalizeResult {
  skipped?: 'invalid-session' | 'no-store' | 'busy' | 'unknown-session' | 'capture-off' | 'already-finalized'
  slug?: string
  memoryId?: string
  changed?: boolean
  redactions?: number
  empty?: boolean
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
}

const SESSION_KEEP_MS = 45 * 86_400_000
const FINALIZE_DISTILL_RUNS = 3

export async function finalize(h: Harness, sid: string, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
  if (captureOff()) return { skipped: 'capture-off' }
  if (!paths.isValidSessionId(sid) || !isHarness(h)) return { skipped: 'invalid-session' }
  const t0 = Date.now()
  const journal = (outcome: 'ran' | 'skipped' | 'failed', extra: { reason?: string, detail?: string, project?: string } = {}): void => {
    appendJob({ job: 'finalize', trigger: 'session-end', outcome, harness: h, sid, ...extra, ms: Date.now() - t0 }, opts.nowMs ?? Date.now())
  }
  if (cortexdbBinary() === undefined) {
    journal('skipped', { reason: 'no-store', detail: 'CortexDB is not installed' })
    await startRepair(h, sid, opts.nowMs ?? Date.now(), undefined, 'cortexdb_missing')
    return { skipped: 'no-store' }
  }
  if (opts.graceMs !== undefined && opts.graceMs > 0) await Bun.sleep(opts.graceMs)
  const release = await acquireLock(join(locksDir(), `finalize-${h}-${sid}.lock`), { timeoutMs: 30_000, staleMs: 5 * 60_000, heartbeat: true })
  if (!release) { journal('skipped', { reason: 'busy', detail: 'another finalizer holds this session' }); return { skipped: 'busy' } }
  let slug: string | undefined
  try {
    const prev = readSessionRecord(h, sid)
    if (prev?.status === 'ended' && spoolFiles(h, sid).active.length === 0) {
      return { skipped: 'already-finalized', ...(prev.slug !== undefined ? { slug: prev.slug } : {}), ...(prev.memoryId !== undefined ? { memoryId: prev.memoryId } : {}) }
    }
    let pass = await finalizePass(h, sid, opts)
    for (let n = 1; n < 3 && pass.result.skipped === undefined; n++) {
      if (opts.settleMs !== undefined && opts.settleMs > 0) await Bun.sleep(opts.settleMs)
      if (spoolFiles(h, sid).active.length === 0) break
      pass = await finalizePass(h, sid, opts)
    }
    slug = pass.result.slug
    if (pass.result.skipped !== undefined) { journal('skipped', { reason: pass.result.skipped }); return pass.result }
    await finalizeTail(h, sid, pass, opts.nowMs ?? Date.now())
    journal('ran', {
      ...(slug !== undefined ? { project: slug } : {}),
      detail: slug === undefined ? 'not in a project: no session memory' : pass.result.memoryId !== undefined ? `session memory ${pass.result.memoryId}` : 'no model turn: no session memory',
    })
    return pass.result
  } catch (e) {
    log('error', 'memory: finalize failed', { h, sid, error: e })
    journal('failed', { reason: 'error', detail: e instanceof Error ? e.message : String(e), ...(slug !== undefined ? { project: slug } : {}) })
    await startRepair(h, sid, opts.nowMs ?? Date.now(), slug, 'brain_unreadable')
    throw e
  } finally {
    release()
  }
}

async function startRepair(h: Harness, sid: string, nowMs: number, slug: string | undefined, storeProblem?: 'cortexdb_missing' | 'brain_unreadable'): Promise<void> {
  try {
    const { maybeStartHeal } = await import('./heal')
    maybeStartHeal({ ...(slug !== undefined ? { slug } : {}), nowMs, trigger: 'session-end', harness: h, sid, ...(storeProblem !== undefined ? { storeProblem } : {}) })
  } catch (e) { log('warn', 'memory: the repair was not started after the session', { error: e }) }
}

interface FinalizePass {
  result: FinalizeResult
  rec: SessionRecord
  project?: ProjectRecord
  digest: SpoolDigest
}

async function finalizePass(h: Harness, sid: string, opts: FinalizeOptions): Promise<FinalizePass> {
  const now = opts.nowMs ?? Date.now()
  const snap = spoolSnapshot(h, sid)
  const entries = readSpool(h, sid)
  let rec = readSessionRecord(h, sid)
  const cwdGuess = rec?.cwd ?? guessProjectFromSpool(spoolDigest(entries))
  const digest = spoolDigest(entries, cwdGuess)
  if (!rec && entries.length === 0) return { result: { skipped: 'unknown-session' }, rec: { v: 1, harness: h, sid, cwd: paths.home(), startedMs: now, status: 'active' }, digest }
  let project: ProjectRecord | undefined
  if (rec?.slug !== undefined) project = readProjectsCache().projects[rec.slug]
  if (!project && cwdGuess !== undefined) project = await resolveProject(cwdGuess)
  const excluded = (await projectExclusion(rec?.cwd ?? cwdGuess ?? project?.roots[0] ?? paths.home()).catch(() => undefined)) !== undefined
  if (excluded) project = undefined
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
      }, existing?.keep ?? {})
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
  writeSessionRecord({ ...base, status: 'ended', finalizedMs: now, ...(stats !== undefined ? { stats } : {}) })
  return { result, rec, ...(project !== undefined ? { project } : {}), digest }
}

async function finalizeTail(h: Harness, sid: string, pass: FinalizePass, now: number): Promise<void> {
  const { result, rec, project, digest } = pass
  const harness = memNoteHarness(h)
  if (project) {
    const t0 = Date.now()
    try {
      const { recordSessionEvidence, updateProfile } = await import('./profile')
      recordSessionEvidence(h, sid, { digest, project: project.slug, nowMs: now })
      await updateProfile({ nowMs: now, projects: [project.slug] })
      appendJob({ job: 'profile', trigger: 'session-end', outcome: 'ran', harness: h, sid, project: project.slug, ms: Date.now() - t0 }, now)
    } catch (e) {
      log('warn', 'memory: the user profile was not updated', { h, sid, error: e })
      appendJob({ job: 'profile', trigger: 'session-end', outcome: 'failed', reason: 'error', detail: e instanceof Error ? e.message : String(e), harness: h, sid, project: project.slug }, now)
    }
  }
  if (project && result.memoryId !== undefined && process.env['BURACLE_NO_DISTILL'] !== '1') {
    try {
      const { distillPending, enqueueDistill } = await import('./distill')
      enqueueDistill(h, sid)
      await distillPending({ auto: true, nowMs: now, harness: h, first: sid, maxRuns: FINALIZE_DISTILL_RUNS, trigger: 'session-end' })
    } catch (e) { log('warn', 'memory: automatic distill failed', { h, sid, error: e }) }
  }
  if (project && result.memoryId !== undefined && process.env['BURACLE_NO_REFLECT'] !== '1') {
    try {
      const { reflectBrain } = await import('./reflect')
      const { sessionModel } = await import('./runner')
      const model = sessionModel(h, sid)
      const via = { harness: h, ...(model !== undefined ? { model } : {}) }
      await reflectBrain(projectRef(project.slug), { trigger: 'session-end', nowMs: now, ...via })
      await reflectBrain(personRef(), { trigger: 'session-end', nowMs: now, ...via })
    } catch (e) { log('warn', 'memory: automatic reflect failed', { h, sid, error: e }) }
  }
  if (project && result.memoryId !== undefined) {
    try {
      const { maybeStartVerify } = await import('./verify-start')
      maybeStartVerify({ slug: project.slug, nowMs: now, trigger: 'session-end', harness: h, sid })
    } catch (e) { log('warn', 'memory: the verifier was not started after the session', { error: e }) }
  }
  if (project) {
    try { await refreshUpkeepFor(projectRef(project.slug), { cwd: rec.cwd, nowMs: now }) } catch (e) { log('warn', 'memory: upkeep not refreshed after the session', { error: e }) }
  }
  await refreshStatus({ ...(project ? { slug: project.slug } : {}), nowMs: now, ...(result.changed === true ? { lastWrite: { by: harness, type: 'session' } } : {}) })
  await startRepair(h, sid, now, project?.slug)
  pruneRedactions(now)
  pruneSessionRecords(now)
  try { maybeStartTick({ harness: h, sid, trigger: 'session-end', nowMs: now }) } catch (e) { log('warn', 'memory: the finalizer could not wake the tick', { error: e }) }
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

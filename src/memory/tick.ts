import type { Harness } from '../core/events'
import { memIsSlug } from '../core/memory/note'
import { log } from '../engine/log'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { maybeDailyBackup } from './backup'
import { distillPending } from './distill'
import { maybeStartHeal } from './heal'
import { appendJob } from './jobs'
import { handOffSessions, removeDeadLocks, sweepLayersDue } from './kick'
import { tryLock } from './lock'
import { memoryExcludePatterns, resolveProject, slugExclusion } from './project'
import { reflectBrain } from './reflect'
import { sessionModel } from './runner'
import { readSessionRecord, recentProjectSlugs } from './session-record'
import { refreshStatus } from './status'
import { brainExists, brainSig, personRef, projectRef } from './store'
import { readUpkeep } from './upkeep-file'
import { refreshUpkeepFor } from './sweep'
import { chooseHarnesses, choiceUntil } from './model'
import { armTickTimer, claimTickTimer, clearTickTimer, readTickTimer, takeTickAgain, TICK_LOCK_STALE_MS, TICK_TIMER_SLACK_MS, tickLockFile, timerDelayMs, type TickTrigger } from './tick-start'
import { maybeStartVerify } from './verify-start'
import * as paths from '../engine/paths'

export { tickLockFile, type TickTrigger } from './tick-start'

export interface TickOptions {
  harness?: Harness
  sid?: string
  cwd?: string
  nowMs?: number
  trigger?: TickTrigger
  at?: string
  sleep?: (ms: number) => Promise<void>
  armTimer?: (dueMs: number, nowMs: number) => boolean
}

export interface TickReport {
  skipped?: 'busy' | 'store' | 'replaced'
  rateLimited: boolean
  timerAt?: string
  projects: string[]
  swept: string[]
  distilled: number
  reflected: string[]
  verifyStarted: string[]
  healStarted: string[]
  staleFinalized: string[]
  orphansFinalized: string[]
  locksRemoved: number
  rounds: number
  backup?: string
}

const MAX_PROJECTS = 5
const TICK_DISTILL_RUNS = 6
const ACTIVE_WINDOW_MS = 24 * 3600_000
const TICK_MAX_ROUNDS = 3

export async function tick(opts: TickOptions = {}): Promise<TickReport> {
  const now = opts.nowMs ?? Date.now()
  const t0 = Date.now()
  const trigger = opts.trigger ?? 'cli'
  const scope = { ...(opts.harness !== undefined ? { harness: opts.harness } : {}), ...(opts.sid !== undefined ? { sid: opts.sid } : {}) }
  const report: TickReport = { projects: [], swept: [], distilled: 0, reflected: [], verifyStarted: [], healStarted: [], staleFinalized: [], orphansFinalized: [], locksRemoved: 0, rounds: 0, rateLimited: false }
  if (opts.at !== undefined && !(await sleepUntilDue(opts.at, opts.sleep ?? (ms => Bun.sleep(ms))))) return { ...report, skipped: 'replaced' }
  const release = tryLock(tickLockFile(), TICK_LOCK_STALE_MS, { heartbeat: true })
  if (!release) return { ...report, skipped: 'busy' }
  try {
    if (cortexdbBinary() === undefined) {
      maybeStartHeal({ nowMs: now, trigger: 'tick', storeProblem: 'cortexdb_missing', ...scope })
      appendJob({ job: 'tick', trigger, outcome: 'failed', reason: 'cortexdb_missing', detail: 'CortexDB is not installed; the repair was asked to install it', ...scope, ms: Date.now() - t0 }, now)
      return { ...report, skipped: 'store' }
    }
    for (let round = 1; round <= TICK_MAX_ROUNDS; round++) {
      takeTickAgain()
      report.rounds = round
      const roundStart = Date.now()
      await tickRound(opts, report, now, trigger, scope)
      appendJob({
        job: 'tick', trigger, outcome: 'ran',
        detail: [
          round > 1 ? `round ${round}` : undefined,
          `${report.projects.length} project(s)${report.projects.length > 0 ? ` (${report.projects.join(', ')})` : ''}`,
          report.swept.length > 0 ? `swept ${report.swept.join(', ')}` : undefined,
          report.distilled > 0 ? `distilled ${report.distilled}` : undefined,
          report.reflected.length > 0 ? `reflected ${report.reflected.join(', ')}` : undefined,
          report.verifyStarted.length > 0 ? `verifier started for ${report.verifyStarted.join(', ')}` : undefined,
          report.healStarted.length > 0 ? `repair started for ${report.healStarted.join(', ')}` : undefined,
          report.staleFinalized.length > 0 ? `${report.staleFinalized.length} stale session(s)` : undefined,
          report.orphansFinalized.length > 0 ? `${report.orphansFinalized.length} orphan spool(s)` : undefined,
        ].filter(Boolean).join('; '),
        ...(report.projects[0] !== undefined ? { project: report.projects[0] } : {}), ...scope, ms: Date.now() - roundStart,
      }, now)
      if (!takeTickAgain()) break
    }
    await dailyBackup(report, now, trigger, scope)
    if (report.rateLimited) {
      const until = choiceUntil(chooseHarnesses({ nowMs: now }))
      const dueMs = until !== undefined ? Date.parse(until) + TICK_TIMER_SLACK_MS : Number.NaN
      if (Number.isFinite(dueMs)) {
        const armed = (opts.armTimer ?? ((d: number, n: number) => armTickTimer({ dueMs: d, nowMs: n })))(dueMs, now)
        const at = new Date(dueMs).toISOString()
        if (armed) report.timerAt = at
        appendJob({ job: 'tick', trigger, outcome: 'skipped', reason: 'rate-limit', detail: `every harness with usage left is held by a window; ${armed ? `a timer wakes the tick at ${at}` : 'a timer is armed already, or none could start'}`, ...scope }, now)
      }
    }
    return report
  } finally {
    release()
  }
}

async function dailyBackup(report: TickReport, now: number, trigger: TickTrigger, scope: { harness?: Harness, sid?: string }): Promise<void> {
  const t0 = Date.now()
  try {
    const r = await maybeDailyBackup(now)
    const m = r?.manifest
    if (r === undefined || m === undefined) return
    report.backup = m.id
    const detail = [
      `${m.brains.length} brain(s) into brain/backups/${m.id}`,
      r.pruned.length > 0 ? `removed ${r.pruned.length} older backup(s)` : undefined,
      ...(m.skipped ?? []).map(s => `skipped ${s.brain}: ${s.why}`),
    ].filter(Boolean).join('; ')
    appendJob({ job: 'backup', trigger, outcome: 'ran', detail, ...scope, ms: Date.now() - t0 }, now)
  } catch (e) {
    log('warn', 'memory: the daily backup failed', { error: e })
    appendJob({ job: 'backup', trigger, outcome: 'failed', reason: 'error', detail: (e as Error).message, ...scope, ms: Date.now() - t0 }, now)
  }
}

async function sleepUntilDue(atIso: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const dueMs = Date.parse(atIso)
  if (!Number.isFinite(dueMs)) return true
  claimTickTimer(dueMs, Date.now())
  for (;;) {
    const left = timerDelayMs(Date.now(), dueMs)
    if (left <= 0) break
    await sleep(Math.min(left, 30_000))
    const t = readTickTimer()
    if (t === undefined || t.pid !== process.pid) return false
  }
  clearTickTimer()
  return true
}

async function tickRound(opts: TickOptions, report: TickReport, now: number, trigger: TickTrigger, scope: { harness?: Harness, sid?: string }): Promise<void> {
  const add = (list: string[], s: string): void => { if (!list.includes(s)) list.push(s) }
  const slugs: string[] = []
  const take = (s: string | undefined): void => { if (s !== undefined && memIsSlug(s) && !slugs.includes(s)) slugs.push(s) }
  const rec = opts.harness !== undefined && opts.sid !== undefined && paths.isValidSessionId(opts.sid) ? readSessionRecord(opts.harness, opts.sid) : undefined
  take(rec?.slug)
  if (opts.cwd !== undefined) take((await resolveProject(opts.cwd).catch(() => undefined))?.slug)
  for (const s of recentProjectSlugs(now - ACTIVE_WINDOW_MS)) take(s)
  const patterns = memoryExcludePatterns()
  const projects: string[] = []
  for (const s of slugs) {
    if (projects.length >= MAX_PROJECTS) break
    if (brainExists(projectRef(s)) && (await slugExclusion(s, patterns).catch(() => undefined)) === undefined) projects.push(s)
  }
  for (const s of projects) add(report.projects, s)

  try {
    let personDone = false
    for (const s of projects) {
      for (const l of await sweepLayersDue(s, now, { person: !personDone, trigger: 'tick' })) { add(report.swept, l); if (l === 'person') personDone = true }
    }
    if (projects.length === 0) for (const l of await sweepLayersDue(undefined, now, { person: true, trigger: 'tick' })) add(report.swept, l)
  } catch (e) { log('warn', 'memory: the tick could not sweep', { error: e }) }
  try {
    const handed = handOffSessions(opts.harness, opts.sid, now, 'tick')
    for (const s of handed.staleFinalized) add(report.staleFinalized, s)
    for (const s of handed.orphansFinalized) add(report.orphansFinalized, s)
  } catch (e) { log('warn', 'memory: the tick could not hand sessions over', { error: e }) }
  try {
    const removed = removeDeadLocks(now)
    report.locksRemoved += removed
    if (removed > 0) appendJob({ job: 'locks', trigger, outcome: 'ran', detail: `removed ${removed} lock or reader file(s) whose owner is gone`, ...scope }, now)
  } catch (e) { log('warn', 'memory: the tick could not clean the locks', { error: e }) }

  try {
    const results = await distillPending({ auto: true, nowMs: now, maxRuns: TICK_DISTILL_RUNS, trigger: 'tick' })
    report.distilled += results.filter(r => r.ran).length
    if (results.some(r => r.skipped === 'rate-limit')) report.rateLimited = true
  } catch (e) { log('warn', 'memory: the tick could not drain the distill queue', { error: e }) }

  const model = opts.harness !== undefined && opts.sid !== undefined && paths.isValidSessionId(opts.sid) ? sessionModel(opts.harness, opts.sid) : undefined
  const via = { ...(opts.harness !== undefined ? { harness: opts.harness } : {}), ...(model !== undefined ? { model } : {}) }
  for (const s of projects) {
    try {
      const r = await reflectBrain(projectRef(s), { trigger: 'tick', nowMs: now, ...via })
      if (r.skipped === undefined) add(report.reflected, s)
      if (r.skipped === 'rate-limit') report.rateLimited = true
    } catch (e) { log('warn', 'memory: the tick could not reflect a project', { slug: s, error: e }) }
  }
  try {
    const r = await reflectBrain(personRef(), { trigger: 'tick', nowMs: now, ...via })
    if (r.skipped === undefined) add(report.reflected, 'person')
    if (r.skipped === 'rate-limit') report.rateLimited = true
  } catch (e) { log('warn', 'memory: the tick could not reflect the person brain', { error: e }) }

  for (const s of projects) {
    try { if (maybeStartVerify({ slug: s, nowMs: now, trigger: 'tick', ...scope })) add(report.verifyStarted, s) } catch (e) { log('warn', 'memory: the tick could not start the verifier', { slug: s, error: e }) }
    try {
      if (readUpkeep(s)?.sig !== brainSig(projectRef(s).db)) {
        await refreshUpkeepFor(projectRef(s), { nowMs: now })
        await refreshStatus({ slug: s, nowMs: now })
      }
      if (maybeStartHeal({ slug: s, nowMs: now, trigger: 'tick', ...scope })) add(report.healStarted, s)
    } catch (e) { log('warn', 'memory: the tick could not refresh a project', { slug: s, error: e }) }
  }
  try { await refreshStatus({ nowMs: now }) } catch (e) { log('warn', 'memory: the tick could not refresh the global status', { error: e }) }
}

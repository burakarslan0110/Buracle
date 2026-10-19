import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESSES, isHarness, type Harness } from '../core/events'
import { memIsSlug } from '../core/memory/note'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { appendJob } from './jobs'
import { locksDir, sessionRecordFile, sessionRecordsDir, spoolDir } from './layout'
import { lockHeld, removeDeadLock } from './lock'
import { pruneDeadReaders } from './cortex'
import { resolveProject, slugExclusion } from './project'
import { readSessionRecord, spawnFinalizerPid, STALE_ACTIVE_MS } from './session-record'
import { activeSpoolFiles } from './spool'
import { maybeStartTick, type StartTickOptions } from './tick-start'

export interface KickOptions {
  harness?: Harness
  sid?: string
  cwd: string
  nowMs?: number
  deps?: {
    spawnFinalizer?: (h: Harness, sid: string) => number | undefined
    startHeal?: (o: { slug?: string, nowMs: number, storeProblem?: 'cortexdb_missing' | 'brain_unreadable', harness?: Harness, sid?: string }) => boolean
    startTick?: (o: StartTickOptions) => boolean
  }
}

export interface KickReport {
  slug?: string
  swept: string[]
  store: 'ok' | 'cortexdb_missing' | 'brain_unreadable'
  healStarted: boolean
  staleFinalized: string[]
  orphansFinalized: string[]
  locksRemoved: number
}

const STALE_SEGMENT_MS = 10 * 60_000
const ORPHAN_IDLE_MS = 2 * 3600_000
const MAX_FINALIZERS = 3
const SPAWN_MARK_MS = 10 * 60_000
const DEAD_LOCK_AGE_MS = 24 * 3600_000
const STALE_SCAN_RECORDS = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function kick(opts: KickOptions): Promise<KickReport> {
  const now = opts.nowMs ?? Date.now()
  const t0 = Date.now()
  const report: KickReport = { swept: [], store: 'ok', healStarted: false, staleFinalized: [], orphansFinalized: [], locksRemoved: 0 }
  const scope = { ...(opts.harness !== undefined ? { harness: opts.harness } : {}), ...(opts.sid !== undefined ? { sid: opts.sid } : {}) }
  let slug: string | undefined
  try {
    const rec = opts.harness !== undefined && opts.sid !== undefined && paths.isValidSessionId(opts.sid) ? readSessionRecord(opts.harness, opts.sid) : undefined
    slug = rec?.slug ?? (await resolveProject(opts.cwd).catch(() => undefined))?.slug
    if (slug !== undefined && (!memIsSlug(slug) || (await slugExclusion(slug)) !== undefined)) slug = undefined
    if (slug !== undefined) report.slug = slug
  } catch {  }

  try {
    if (cortexdbBinary() === undefined) report.store = 'cortexdb_missing'
    else {
      const { listAll, personRef, projectRef } = await import('./store')
      try {
        await listAll(personRef())
        if (slug !== undefined) await listAll(projectRef(slug))
      } catch (e) {
        report.store = 'brain_unreadable'
        log('warn', 'memory: the kick could not read the brain', { slug, error: e })
      }
    }
    if (report.store === 'ok') report.swept = await sweepDue(slug, now)
    const { maybeStartHeal } = await import('./heal')
    const start = opts.deps?.startHeal ?? ((o: Parameters<NonNullable<NonNullable<KickOptions['deps']>['startHeal']>>[0]) => maybeStartHeal({ ...o, trigger: 'session-start' }))
    report.healStarted = start({
      ...(slug !== undefined ? { slug } : {}), nowMs: now, ...scope,
      ...(report.store !== 'ok' ? { storeProblem: report.store } : {}),
    })
  } catch (e) {
    log('warn', 'memory: the kick could not sweep or check the store', { slug, error: e })
  }

  const handed = handOffSessions(opts.harness, opts.sid, now, 'session-start', opts.deps?.spawnFinalizer)
  report.staleFinalized = handed.staleFinalized
  report.orphansFinalized = handed.orphansFinalized

  try { report.locksRemoved = removeDeadLocks(now) } catch (e) { log('warn', 'memory: the kick could not clean the locks', { error: e }) }
  if (report.locksRemoved > 0) appendJob({ job: 'locks', trigger: 'session-start', outcome: 'ran', detail: `removed ${report.locksRemoved} lock or reader file(s) whose owner is gone`, ...scope }, now)

  try { (opts.deps?.startTick ?? maybeStartTick)({ ...scope, trigger: 'session-start', nowMs: now }) } catch (e) { log('warn', 'memory: the kick could not wake the tick', { error: e }) }

  appendJob({
    job: 'kick', trigger: 'session-start', outcome: report.store === 'ok' ? 'ran' : 'failed', ...(report.store !== 'ok' ? { reason: report.store } : {}),
    detail: [
      report.swept.length > 0 ? `swept ${report.swept.join(', ')}` : 'no sweep due',
      report.healStarted ? 'repair started' : undefined,
      report.staleFinalized.length > 0 ? `${report.staleFinalized.length} stale session(s)` : undefined,
      report.orphansFinalized.length > 0 ? `${report.orphansFinalized.length} orphan spool(s)` : undefined,
      report.locksRemoved > 0 ? `${report.locksRemoved} dead lock(s)` : undefined,
    ].filter(Boolean).join('; '),
    ...(slug !== undefined ? { project: slug } : {}), ...scope, ms: Date.now() - t0,
  }, now)
  return report
}

export function handOffSessions(currentH: Harness | undefined, currentSid: string | undefined, now: number, trigger: 'session-start' | 'tick', spawner?: (h: Harness, sid: string) => number | undefined): { staleFinalized: string[], orphansFinalized: string[] } {
  const scope = { ...(currentH !== undefined ? { harness: currentH } : {}), ...(currentSid !== undefined ? { sid: currentSid } : {}) }
  const spawn = spawner ?? ((h: Harness, sid: string) => spawnFinalizerPid(h, sid))
  const out = { staleFinalized: [] as string[], orphansFinalized: [] as string[] }
  const hand = (x: { h: Harness, sid: string }): string[] => {
    if (!canSpawn(x.h, x.sid, now) || spawn(x.h, x.sid) === undefined) return []
    markSpawned(x.h, x.sid, now)
    return [`${x.h}-${x.sid}`]
  }
  try { out.staleFinalized = staleSessions(currentH, currentSid, now).flatMap(hand).slice(0, MAX_FINALIZERS) } catch (e) { log('warn', 'memory: the session records could not be scanned', { error: e }) }
  try { out.orphansFinalized = orphanSpools(now).flatMap(hand).slice(0, MAX_FINALIZERS) } catch (e) { log('warn', 'memory: the spool could not be scanned', { error: e }) }
  if (out.staleFinalized.length > 0) appendJob({ job: 'stale-finalize', trigger, outcome: 'ran', detail: `handed to finalizers: ${out.staleFinalized.join(', ')}`, ...scope }, now)
  if (out.orphansFinalized.length > 0) appendJob({ job: 'orphan-spool', trigger, outcome: 'ran', detail: `captured sessions without a record handed to finalizers: ${out.orphansFinalized.join(', ')}`, ...scope }, now)
  return out
}

async function sweepDue(slug: string | undefined, now: number): Promise<string[]> {
  return sweepLayersDue(slug, now, { person: true, trigger: 'session-start' })
}

export async function sweepLayersDue(slug: string | undefined, now: number, opts: { person: boolean, trigger: 'session-start' | 'tick' }): Promise<string[]> {
  const { markSweepStarted, PERSON_SWEEP_KEY, sweep, sweepDue: due } = await import('./sweep')
  const project = slug !== undefined && due(slug, now)
  const person = opts.person && due(PERSON_SWEEP_KEY, now)
  if (!project && !person) return []
  if (project && slug !== undefined) markSweepStarted(slug, now)
  if (person) markSweepStarted(PERSON_SWEEP_KEY, now)
  const r = await sweep({ ...(project && slug !== undefined ? { slug } : {}), person, nowMs: now, trigger: opts.trigger })
  try {
    const { refreshStatus } = await import('./status')
    if (project && slug !== undefined) await refreshStatus({ slug, nowMs: now })
    await refreshStatus({ nowMs: now })
  } catch (e) { log('warn', 'memory: the status was not refreshed after the sweep', { error: e }) }
  return r.layers.filter(l => l.skipped === undefined).map(l => l.layer === 'person' ? 'person' : l.project as string)
}

function spawnMarkFile(h: Harness, sid: string): string {
  return join(locksDir(), `finalize-spawn-${h}-${sid}.json`)
}

function canSpawn(h: Harness, sid: string, now: number): boolean {
  try {
    const mark = spawnMarkFile(h, sid)
    if (existsSync(mark) && now - statSync(mark).mtimeMs < SPAWN_MARK_MS) return false
    return !lockHeld(join(locksDir(), `finalize-${h}-${sid}.lock`), 5 * 60_000, now)
  } catch {
    return false
  }
}

function markSpawned(h: Harness, sid: string, now: number): void {
  try { writeFileSync(spawnMarkFile(h, sid), JSON.stringify({ at: new Date(now).toISOString() }), { mode: 0o600 }) } catch {  }
}

export function staleSessions(currentH: Harness | undefined, currentSid: string | undefined, now: number): Array<{ h: Harness, sid: string }> {
  const out: Array<{ h: Harness, sid: string }> = []
  let names: string[] = []
  try { names = readdirSync(sessionRecordsDir()) } catch { return out }
  for (const h of HARNESSES) {
    const sids = new Set<string>()
    for (const n of names) {
      if (!n.startsWith(`${h}-`) || !n.endsWith('.json')) continue
      const sid = n.slice(h.length + 1, -'.json'.length)
      if (!(h === currentH && sid === currentSid) && paths.isValidSessionId(sid)) sids.add(sid)
    }
    const spooled = activeSpoolFiles(h, sids)
    const quiet: Array<{ sid: string, mtime: number }> = []
    for (const sid of sids) {
      if (spooled.has(sid)) continue
      try { quiet.push({ sid, mtime: statSync(sessionRecordFile(h, sid)).mtimeMs }) } catch {  }
    }
    quiet.sort((a, b) => b.mtime - a.mtime || (a.sid < b.sid ? -1 : 1))
    for (const sid of [...spooled.keys(), ...quiet.slice(0, STALE_SCAN_RECORDS).map(q => q.sid)]) {
      if (out.length >= MAX_FINALIZERS) return out
      const rec = readSessionRecord(h, sid)
      if (!rec) continue
      const active = spooled.get(sid) ?? []
      let last = rec.status === 'active' ? rec.startedMs : 0
      if (rec.status === 'active') { try { last = Math.max(last, statSync(sessionRecordFile(h, sid)).mtimeMs) } catch {  } }
      for (const f of active) {
        try { last = Math.max(last, statSync(f).mtimeMs) } catch {  }
      }
      if (rec.status === 'active' ? now - last < STALE_ACTIVE_MS : active.length === 0 || now - last < STALE_SEGMENT_MS) continue
      out.push({ h, sid })
    }
  }
  return out
}

export function orphanSpools(now: number): Array<{ h: Harness, sid: string }> {
  const out: Array<{ h: Harness, sid: string }> = []
  let names: string[] = []
  try { names = readdirSync(spoolDir()) } catch { return out }
  const seen = new Set<string>()
  for (const n of names.sort()) {
    if (!n.endsWith('.jsonl')) continue
    const dash = n.indexOf('-')
    const h = n.slice(0, dash)
    if (dash <= 0 || !isHarness(h)) continue
    const rest = n.slice(dash + 1, -'.jsonl'.length)
    const cuts: string[] = []
    for (let i = rest.length; i > 0; i = rest.lastIndexOf('-', i - 1)) cuts.push(rest.slice(0, i))
    if (cuts.some(sid => paths.isValidSessionId(sid) && readSessionRecord(h, sid) !== undefined)) continue
    const sid = cuts.find(c => UUID_RE.test(c)) ?? rest
    if (!paths.isValidSessionId(sid) || seen.has(`${h}-${sid}`)) continue
    try { if (now - statSync(join(spoolDir(), n)).mtimeMs < ORPHAN_IDLE_MS) continue } catch { continue }
    seen.add(`${h}-${sid}`)
    out.push({ h, sid })
    if (out.length >= MAX_FINALIZERS) break
  }
  return out
}

export function removeDeadLocks(now: number): number {
  let names: string[] = []
  try { names = readdirSync(locksDir()) } catch { return 0 }
  let n = 0
  for (const name of names) {
    const p = join(locksDir(), name)
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      if ((name.startsWith('finalize-spawn-') && name.endsWith('.json')) || name.startsWith('kick-')) {
        if (now - st.mtimeMs > DEAD_LOCK_AGE_MS) { try { unlinkSync(p); n++ } catch {  } }
        continue
      }
      if (name.endsWith('.lock') && removeDeadLock(p, DEAD_LOCK_AGE_MS, now)) n++
    } catch {  }
  }
  return n + pruneDeadReaders()
}

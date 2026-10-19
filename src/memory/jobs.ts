import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { memClip, memOneLine, redact } from '../core/memory/text'
import { atomicWriteSync } from '../engine/fsx'
import { jobsFile, locksDir } from './layout'
import { tryLock } from './lock'

export const JOB_IDS = ['kick', 'tick', 'finalize', 'sweep', 'distill', 'reflect', 'verify', 'heal', 'profile', 'backup', 'stale-finalize', 'orphan-spool', 'locks'] as const
export type JobId = typeof JOB_IDS[number]
export type JobOutcome = 'ran' | 'skipped' | 'failed'

export interface JobEntry {
  v: 1
  at: string
  job: JobId
  trigger: string
  outcome: JobOutcome
  reason?: string
  detail?: string
  harness?: string
  sid?: string
  project?: string
  layer?: 'project' | 'person'
  ms?: number
}

export type JobInput = Omit<JobEntry, 'v' | 'at'>

const DETAIL_MAX = 200
const KEEP_MS = 30 * 86_400_000
const KEEP_LINES = 2000

function isEntry(v: unknown): v is JobEntry {
  if (v === null || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return e['v'] === 1 && typeof e['at'] === 'string' && typeof e['job'] === 'string' && (JOB_IDS as readonly string[]).includes(e['job'] as string)
    && typeof e['trigger'] === 'string' && (e['outcome'] === 'ran' || e['outcome'] === 'skipped' || e['outcome'] === 'failed')
}

export function appendJob(input: JobInput, nowMs: number = Date.now()): void {
  try {
    const entry: JobEntry = { v: 1, at: new Date(nowMs).toISOString(), ...input }
    if (entry.detail !== undefined) {
      const d = memClip(memOneLine(redact(memOneLine(entry.detail)).text), DETAIL_MAX)
      if (d === '') delete entry.detail
      else entry.detail = d
    }
    if (entry.reason !== undefined) entry.reason = memClip(memOneLine(entry.reason), 40)
    const file = jobsFile()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
  } catch {  }
}

export function readJobs(): JobEntry[] {
  let text = ''
  try { text = readFileSync(jobsFile(), 'utf8') } catch { return [] }
  const out: JobEntry[] = []
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue
    try { const v = JSON.parse(l) as unknown; if (isEntry(v)) out.push(v) } catch {  }
  }
  return out
}

export function trimJobs(nowMs: number): number {
  const release = tryLock(join(locksDir(), 'jobs.lock'), 30_000)
  if (!release) return 0
  try {
    let text = ''
    try { text = readFileSync(jobsFile(), 'utf8') } catch { return 0 }
    const lines = text.split('\n').filter(l => l.trim() !== '')
    const atOf = (l: string): number => { try { return Date.parse((JSON.parse(l) as { at?: string }).at ?? '') || 0 } catch { return 0 } }
    const kept = lines.filter(l => nowMs - atOf(l) <= KEEP_MS).slice(-KEEP_LINES)
    if (kept.length === lines.length) return 0
    atomicWriteSync(jobsFile(), kept.length > 0 ? kept.join('\n') + '\n' : '', { mode: 0o600 })
    return lines.length - kept.length
  } catch {
    return 0
  } finally {
    release()
  }
}

export const JOB_SCHEDULE: Readonly<Record<JobId, string>> = {
  kick: 'every session start (in the background)',
  tick: 'at every prompt, session start or end and compaction in any harness, at most once a minute per machine',
  finalize: 'every session end (in the background)',
  sweep: 'at a session start or a tick, when the brain was not swept for 6 hours',
  distill: 'as soon as a session ends, through a harness with usage headroom (its own first)',
  reflect: 'whenever a brain changed since its last run; a 6-hour pass relates what was recalled and takes the captures, duplicates and contradictions that wait for it',
  verify: 'whenever memories wait to be checked against the code',
  heal: 'at a session start or end, or a tick, while the memory status is not ok, at most every 30 minutes',
  profile: 'every project session end',
  backup: 'from the tick, once a day for each brain (a new brain at once) into ~/.buracle/brain/backups (the newest 10 copies of each brain are kept)',
  'stale-finalize': 'at a session start or a tick, for sessions left open for 2 hours',
  'orphan-spool': 'at a session start or a tick, for captured sessions without a session record',
  locks: 'at a session start or a tick, for lock and reader files whose owner is gone',
}

export interface JobView {
  job: JobId
  schedule: string
  last?: JobEntry
  lastRan?: JobEntry
  lastFailed?: JobEntry
  lastSkipped?: JobEntry
  day: { ran: number, skipped: number, failed: number }
}

export function jobsOverview(nowMs: number, opts: { project?: string, entries?: readonly JobEntry[] } = {}): JobView[] {
  const all = (opts.entries ?? readJobs()).filter(e => opts.project === undefined || e.project === undefined || e.project === opts.project)
  return JOB_IDS.map(job => {
    const mine = all.filter(e => e.job === job)
    const day = { ran: 0, skipped: 0, failed: 0 }
    for (const e of mine) if (nowMs - Date.parse(e.at) <= 86_400_000) day[e.outcome]++
    const newest = (o?: JobOutcome): JobEntry | undefined => {
      for (let i = mine.length - 1; i >= 0; i--) { const e = mine[i] as JobEntry; if (o === undefined || e.outcome === o) return e }
      return undefined
    }
    const v: JobView = { job, schedule: JOB_SCHEDULE[job], day }
    const last = newest(); if (last) v.last = last
    const ran = newest('ran'); if (ran) v.lastRan = ran
    const failed = newest('failed'); if (failed) v.lastFailed = failed
    const skipped = newest('skipped'); if (skipped) v.lastSkipped = skipped
    return v
  })
}

export function jobEntryLine(e: JobEntry, nowMs: number): string {
  const ago = Math.max(0, Math.round((nowMs - Date.parse(e.at)) / 60_000))
  const when = ago < 60 ? `${ago} min ago` : ago < 48 * 60 ? `${Math.round(ago / 60)} h ago` : `${Math.round(ago / 1440)} d ago`
  const scope = [e.harness, e.layer === 'person' ? 'person brain' : e.project !== undefined ? `project ${e.project}` : undefined].filter(Boolean).join(', ')
  const why = [e.reason, e.detail].filter(Boolean).join(': ')
  return `${e.outcome} ${when}${scope !== '' ? ` (${scope})` : ''}${why !== '' ? ` - ${why}` : ''}`
}

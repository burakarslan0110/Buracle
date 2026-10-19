import { join } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import {
  CM_RESTORE_MAX_BYTES, cmCaptureBlocked, cmHookInput, cmKeepExtracted, cmPromptRow, cmToolName, renderRestore,
  type CmEvent, type CmExtracted, type CmStoredEvent,
} from '../../../core/context-mode'
import { isHarness, type Harness } from '../../../core/events'
import { loadConfigSync } from '../../../engine/config'
import { cmPackage, cmSessionsDir, cmStorageRoot, ensureCmDirs, type CmPackage } from '../../../engine/context-mode'
import { log } from '../../../engine/log'
import { isValidSessionId } from '../../../engine/paths'
import { acquireLock } from '../../../memory/lock'
import { cmExclusion } from './exclusion'
import { loadCmLibrary, type CmLibrary, type CmSessionDb } from './library'

export interface CmTarget { harness: Harness; sessionId: string; projectDir: string }

export type CmOp = 'capture' | 'snapshot' | 'restore' | 'startup'
export const CM_OPS: readonly CmOp[] = ['capture', 'snapshot', 'restore', 'startup']

export const CM_BUSY_TIMEOUT_MS = 250
export const CM_SESSION_MAX_AGE_DAYS = 7
export const CM_LOCK_WAIT_MS = 5000
export const CM_LOCK_STALE_MS = 30_000
export const CM_SNAPSHOT_MAX_BYTES = 8000

export interface CmOpOutcome {
  ok: boolean
  skipped?: string
  rows?: number
  removed?: number
  snapshot?: string
  text?: string
}

export function cmTargetProblem(t: CmTarget): string | undefined {
  if (!isHarness(t.harness)) return `unknown harness '${String(t.harness)}'`
  if (!isValidSessionId(t.sessionId)) return 'invalid session id'
  if (typeof t.projectDir !== 'string' || t.projectDir.trim() === '' || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(t.projectDir)) return 'the project folder must be an absolute path'
  return undefined
}

export function cmWriterLock(t: Pick<CmTarget, 'harness' | 'projectDir'>): string {
  return join(cmStorageRoot(t.harness, t.projectDir), 'writer.lock')
}

export function openCmSessionDb(lib: CmLibrary, t: CmTarget): { db: CmSessionDb, sessionsDir: string, close(): void } {
  ensureCmDirs(t.harness, t.projectDir)
  const sessionsDir = cmSessionsDir(cmStorageRoot(t.harness, t.projectDir))
  const db = lib.openSessionDb(lib.resolveSessionDbPath({ projectDir: t.projectDir, sessionsDir }))
  try { db.db?.pragma?.(`busy_timeout = ${CM_BUSY_TIMEOUT_MS}`) } catch {  }
  return { db, sessionsDir, close: () => { try { db.close() } catch {  } } }
}

function insertEvents(lib: CmLibrary, db: CmSessionDb, t: CmTarget, events: readonly CmEvent[]): number {
  const runs: Array<{ hook: string, rows: CmExtracted[] }> = []
  for (const ev of events) {
    const hook = ev.kind === 'prompt' ? 'UserPromptSubmit' : 'PostToolUse'
    const rows = ev.kind === 'prompt'
      ? [cmPromptRow(ev), ...cmKeepExtracted(ev, lib.extractUserEvents(ev.text))]
      : cmKeepExtracted(ev, lib.extractEvents(cmHookInput(ev)))
    if (rows.length === 0) continue
    const last = runs[runs.length - 1]
    if (last !== undefined && last.hook === hook) last.rows.push(...rows)
    else runs.push({ hook, rows })
  }
  if (runs.length === 0) return 0
  db.ensureSession(t.sessionId, t.projectDir)
  let total = 0
  for (const r of runs) {
    db.bulkInsertEvents(t.sessionId, r.rows, r.hook)
    total += r.rows.length
  }
  return total
}

function readRows(db: CmSessionDb, sid: string): CmStoredEvent[] {
  const rows = db.getEvents(sid, { limit: 1000 })
  return Array.isArray(rows) ? rows.filter(r => r !== null && typeof r === 'object' && typeof r.type === 'string' && typeof r.data === 'string') : []
}

function capSnapshot(text: string, max: number): string {
  if (Buffer.byteLength(text, 'utf8') <= max) return text
  const close = '\n</session_resume>'
  const lines = text.split('\n')
  const kept: string[] = []
  let n = Buffer.byteLength(close, 'utf8')
  for (const l of lines) {
    const b = Buffer.byteLength(l, 'utf8') + 1
    if (n + b > max) break
    kept.push(l)
    n += b
  }
  return text.startsWith('<session_resume') ? kept.join('\n') + close : kept.join('\n')
}

function restoreText(t: CmTarget, rows: readonly CmStoredEvent[], source: 'compact' | 'resume', maxBytes: number | undefined): string {
  return renderRestore(rows, { source, toolName: tool => cmToolName(t.harness, tool), projectDir: t.projectDir, maxBytes: maxBytes ?? CM_RESTORE_MAX_BYTES })
}

export function cmCaptureOp(lib: CmLibrary, t: CmTarget, events: readonly CmEvent[]): CmOpOutcome {
  if (events.length === 0) return { ok: true, rows: 0 }
  const o = openCmSessionDb(lib, t)
  try {
    return { ok: true, rows: insertEvents(lib, o.db, t, events) }
  } finally {
    o.close()
  }
}

const IDLE_SESSIONS = "SELECT session_id FROM session_meta WHERE COALESCE(last_event_at, started_at) < datetime('now', ?) AND session_id <> ?"

export function cmIdleSessions(db: CmSessionDb, keep: string): string[] | undefined {
  const raw = db.db
  if (typeof raw?.prepare !== 'function') return undefined
  const rows = raw.prepare(IDLE_SESSIONS).all(`-${CM_SESSION_MAX_AGE_DAYS} days`, keep)
  const idle: string[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const sid = (row as { session_id?: unknown } | null)?.session_id
    if (typeof sid === 'string' && sid !== keep) idle.push(sid)
  }
  return idle
}

export function cmStartupOp(lib: CmLibrary, t: CmTarget): CmOpOutcome {
  const o = openCmSessionDb(lib, t)
  try {
    o.db.ensureSession(t.sessionId, t.projectDir)
    const idle = cmIdleSessions(o.db, t.sessionId)
    if (idle === undefined) {
      log('debug', 'context-mode: no raw database handle; idle sessions are left to H16', { harness: t.harness })
      return { ok: true, removed: 0 }
    }
    for (const sid of idle) o.db.deleteSession(sid)
    return { ok: true, removed: idle.length }
  } finally {
    o.close()
  }
}

export function cmSnapshotOp(lib: CmLibrary, t: CmTarget, events: readonly CmEvent[], opts: { maxBytes?: number } = {}): CmOpOutcome {
  const o = openCmSessionDb(lib, t)
  try {
    const rows = insertEvents(lib, o.db, t, events)
    const stored = readRows(o.db, t.sessionId)
    if (stored.length === 0) return { ok: true, rows, text: '' }
    const compactCount = (o.db.getSessionStats(t.sessionId)?.compact_count ?? 0) + 1
    const built = lib.buildResumeSnapshot(stored.filter(r => r.type !== 'rule_content'), { compactCount, searchTool: cmToolName(t.harness, 'ctx_search') })
    const snapshot = typeof built === 'string' ? built : ''
    if (snapshot !== '') {
      o.db.upsertResume(t.sessionId, snapshot, stored.length)
      o.db.incrementCompactCount(t.sessionId)
    }
    const out: CmOpOutcome = { ok: true, rows, text: restoreText(t, stored, 'compact', opts.maxBytes) }
    if (snapshot !== '') out.snapshot = capSnapshot(snapshot, CM_SNAPSHOT_MAX_BYTES)
    return out
  } finally {
    o.close()
  }
}

export function cmRestoreOp(lib: CmLibrary, t: CmTarget, source: 'compact' | 'resume', opts: { maxBytes?: number, eventsFile?: boolean, deadline?: number, now?: () => number } = {}): CmOpOutcome {
  const now = opts.now ?? Date.now
  const late = (): boolean => opts.deadline !== undefined && now() > opts.deadline
  const o = openCmSessionDb(lib, t)
  try {
    const resume = o.db.getResume(t.sessionId)
    if (resume !== null && !resume.consumed) o.db.markResumeConsumed(t.sessionId)
    const stored = readRows(o.db, t.sessionId)
    if (stored.length === 0) return { ok: true, text: '' }
    if (opts.eventsFile !== false && !late()) {
      try {
        const rows = stored.map(r => (r.category === 'user-prompt' ? { ...r, category: 'prompt' } : r))
        lib.writeSessionEventsFile(rows, lib.resolveSessionPath({ projectDir: t.projectDir, sessionsDir: o.sessionsDir, ext: '-events.md' }))
      } catch (e) {
        log('debug', 'context-mode: cannot write the session events file', { error: e })
      }
    }
    return { ok: true, text: restoreText(t, stored, source, opts.maxBytes) }
  } finally {
    o.close()
  }
}

export function cmReadEvents(lib: CmLibrary, t: CmTarget): CmStoredEvent[] | undefined {
  try {
    const o = openCmSessionDb(lib, t)
    try { return readRows(o.db, t.sessionId) } finally { o.close() }
  } catch (e) {
    log('debug', 'context-mode: cannot read the session events', { error: e })
    return undefined
  }
}

export interface CmOpRequest {
  op: CmOp
  target: CmTarget
  events?: readonly CmEvent[]
  source?: 'compact' | 'resume'
  maxBytes?: number
}

export interface CmRunOptions {
  config?: BuracleConfig
  env?: Readonly<Record<string, string | undefined>>
  pkg?: CmPackage | null
  lockWaitMs?: number
}

export async function cmRunOp(req: CmOpRequest, opts: CmRunOptions = {}): Promise<CmOpOutcome> {
  try {
    const problem = cmTargetProblem(req.target)
    if (problem !== undefined) return { ok: false, skipped: problem }
    const config = opts.config ?? loadConfigSync().config
    const blocked = cmCaptureBlocked({ config, env: opts.env ?? process.env })
    if (blocked !== undefined) return { ok: false, skipped: blocked }
    const excluded = await cmExclusion(req.target.projectDir, config)
    if (excluded !== undefined) return { ok: false, skipped: excluded }
    const pkg = opts.pkg === undefined ? cmPackage() : opts.pkg
    if (pkg === null || pkg === undefined) return { ok: false, skipped: 'context-mode is not installed in the toolchain' }
    const lib = await loadCmLibrary(pkg.root)
    if (lib === undefined) return { ok: false, skipped: 'the context-mode session library is unavailable' }
    const t = req.target
    const op = req.op
    if (op === 'restore') return cmRestoreOp(lib, t, req.source ?? 'compact', req.maxBytes !== undefined ? { maxBytes: req.maxBytes } : {})
    ensureCmDirs(t.harness, t.projectDir)
    const release = await acquireLock(cmWriterLock(t), { timeoutMs: opts.lockWaitMs ?? CM_LOCK_WAIT_MS, staleMs: CM_LOCK_STALE_MS })
    if (release === undefined) log('debug', 'context-mode: the writer lock stayed busy; writing without it', { harness: t.harness })
    try {
      switch (op) {
        case 'capture': return cmCaptureOp(lib, t, req.events ?? [])
        case 'startup': return cmStartupOp(lib, t)
        case 'snapshot': return cmSnapshotOp(lib, t, req.events ?? [], req.maxBytes !== undefined ? { maxBytes: req.maxBytes } : {})
        default: {
          const unknown: never = op
          return { ok: false, skipped: `unknown op '${String(unknown)}'` }
        }
      }
    } finally {
      release?.()
    }
  } catch (e) {
    log('warn', `context-mode: session ${req.op} failed`, { harness: req.target.harness, error: e })
    return { ok: false, skipped: `failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

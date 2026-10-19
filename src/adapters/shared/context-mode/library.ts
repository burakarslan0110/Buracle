import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CmExtracted, CmHookInput, CmStoredEvent } from '../../../core/context-mode'
import { log } from '../../../engine/log'

export const CM_LIBRARY_MODULES: readonly string[] = ['build/session/db.js', 'build/session/extract.js', 'build/session/snapshot.js', 'hooks/session-directive.mjs']

export interface CmStoredRow extends CmStoredEvent { id?: number; session_id?: string }

export interface CmSessionDb {
  ensureSession(sessionId: string, projectDir: string): void
  bulkInsertEvents(sessionId: string, events: readonly CmExtracted[], sourceHook: string): void
  getEvents(sessionId: string, opts?: { limit?: number }): CmStoredRow[]
  getSessionStats(sessionId: string): { compact_count?: number } | null
  upsertResume(sessionId: string, snapshot: string, eventCount: number): void
  incrementCompactCount(sessionId: string): void
  getResume(sessionId: string): { consumed?: number } | null
  markResumeConsumed(sessionId: string): void
  deleteSession(sessionId: string): void
  close(): void
  readonly db?: { pragma?(sql: string): unknown, prepare?(sql: string): { all(...params: unknown[]): unknown } }
}

export interface CmLibrary {
  root: string
  version: string
  openSessionDb(dbPath: string): CmSessionDb
  resolveSessionDbPath(opts: { projectDir: string, sessionsDir: string }): string
  resolveSessionPath(opts: { projectDir: string, sessionsDir: string, ext: string }): string
  extractEvents(input: CmHookInput): unknown
  extractUserEvents(message: string): unknown
  buildResumeSnapshot(events: readonly CmStoredEvent[], opts: { compactCount: number, searchTool: string }): unknown
  writeSessionEventsFile(events: readonly CmStoredEvent[], path: string): unknown
}

type Fn = (...args: never[]) => unknown

function fn(mod: Record<string, unknown> | undefined, name: string, problems: string[]): Fn | undefined {
  const f = mod?.[name]
  if (typeof f === 'function') return f as Fn
  problems.push(name)
  return undefined
}

const SESSION_DB_METHODS = ['ensureSession', 'bulkInsertEvents', 'getEvents', 'getSessionStats', 'upsertResume', 'incrementCompactCount', 'getResume', 'markResumeConsumed', 'deleteSession', 'close'] as const

export function cmPackageVersion(root: string): string {
  try {
    const v = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' && v !== '' ? v : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function load(root: string): Promise<CmLibrary | undefined> {
  try {
    const imp = (rel: string): Promise<Record<string, unknown>> => import(pathToFileURL(join(root, rel)).href) as Promise<Record<string, unknown>>
    const [db, extract, snapshot, directive] = await Promise.all(CM_LIBRARY_MODULES.map(imp))
    const problems: string[] = []
    const SessionDB = fn(db, 'SessionDB', problems)
    const resolveSessionDbPath = fn(db, 'resolveSessionDbPath', problems)
    const resolveSessionPath = fn(db, 'resolveSessionPath', problems)
    const extractEvents = fn(extract, 'extractEvents', problems)
    const extractUserEvents = fn(extract, 'extractUserEvents', problems)
    const buildResumeSnapshot = fn(snapshot, 'buildResumeSnapshot', problems)
    const writeSessionEventsFile = fn(directive, 'writeSessionEventsFile', problems)
    const proto = (SessionDB as { prototype?: Record<string, unknown> } | undefined)?.prototype
    for (const m of SESSION_DB_METHODS) if (typeof proto?.[m] !== 'function') problems.push(`SessionDB.${m}`)
    if (problems.length > 0 || SessionDB === undefined || resolveSessionDbPath === undefined || resolveSessionPath === undefined || extractEvents === undefined
      || extractUserEvents === undefined || buildResumeSnapshot === undefined || writeSessionEventsFile === undefined) {
      log('warn', 'context-mode: the session library lacks what the bridge uses; session continuity stands down', { root, missing: problems })
      return undefined
    }
    const Ctor = SessionDB as unknown as new (opts: { dbPath: string }) => CmSessionDb
    return {
      root,
      version: cmPackageVersion(root),
      openSessionDb: dbPath => new Ctor({ dbPath }),
      resolveSessionDbPath: opts => String((resolveSessionDbPath as (o: unknown) => unknown)(opts)),
      resolveSessionPath: opts => String((resolveSessionPath as (o: unknown) => unknown)(opts)),
      extractEvents: input => (extractEvents as (i: unknown) => unknown)(input),
      extractUserEvents: message => (extractUserEvents as (m: unknown) => unknown)(message),
      buildResumeSnapshot: (events, opts) => (buildResumeSnapshot as (e: unknown, o: unknown) => unknown)(events, opts),
      writeSessionEventsFile: (events, path) => (writeSessionEventsFile as (e: unknown, p: unknown) => unknown)(events, path),
    }
  } catch (e) {
    log('warn', 'context-mode: the session library cannot be loaded; session continuity stands down', { root, error: e })
    return undefined
  }
}

const loaded = new Map<string, Promise<CmLibrary | undefined>>()

export function loadCmLibrary(root: string): Promise<CmLibrary | undefined> {
  let p = loaded.get(root)
  if (p === undefined) {
    p = load(root)
    loaded.set(root, p)
  }
  return p
}

// The panes Buracle opened for a board, on disk: one JSON sidecar per board under `<common dir>/buracle/board/mux/`,
// written under a file lock. It lives in a folder of its own because `listBoards` treats every `*.json` in the board
// folder as a board. The board file itself never learns about panes: the lead reads this file to close them.
import { unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BoardSession } from '../core/board/model'
import { HARNESSES } from '../core/events'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { boardDir } from './board-store'
import type { MuxKind, MuxPane } from './mux'
import { MUX_KINDS, validPaneId } from './mux'
import { isValidSlug } from './plan-file'
import { withFileLock } from './session-store'

export const MUX_LOCK_TIMEOUT_MS = 5000
export const MUX_LOCK_STALE_MS = 15_000

/** A recorded pane: what `open` returned plus when, and the worker session that joined from it. */
export interface MuxRecord extends MuxPane { openedAt: number; session?: BoardSession }
export interface MuxStore { v: 1; slug: string; mux: MuxKind; panes: MuxRecord[] }

export type MuxStoreResult = { ok: true; store: MuxStore | undefined } | { ok: false; code: 'locked' | 'unreadable'; message: string }

/** `<commonDir>/buracle/board/mux/<slug>.json`; the slug must be a valid plan slug (callers validate first). */
export function muxStorePath(commonDir: string, slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid board slug '${slug}'`)
  return join(boardDir(commonDir), 'mux', `${slug}.json`)
}

function isSession(x: unknown): x is BoardSession {
  return x !== null && typeof x === 'object' && typeof (x as { harness?: unknown }).harness === 'string' && typeof (x as { session?: unknown }).session === 'string'
}

function isRecord(mux: MuxKind, x: unknown): x is MuxRecord {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (typeof r['id'] !== 'string' || !validPaneId(mux, r['id'])) return false
  if (typeof r['harness'] !== 'string' || !(HARNESSES as readonly string[]).includes(r['harness'])) return false
  if (typeof r['title'] !== 'string' || typeof r['server'] !== 'string' || r['server'] === '' || typeof r['openedAt'] !== 'number') return false
  if (r['pid'] !== undefined && typeof r['pid'] !== 'string') return false
  if (r['ids'] !== undefined && !(Array.isArray(r['ids']) && r['ids'].every(i => typeof i === 'string' && !i.startsWith('-')))) return false
  return r['session'] === undefined || isSession(r['session'])
}

type ReadResult = { ok: true; store: MuxStore } | { ok: false; code: 'missing' | 'invalid' }

function readFile(path: string): ReadResult {
  const r = readJsonSafeSync<unknown>(path)
  if (!r.ok) {
    if (r.code === 'missing') return { ok: false, code: 'missing' }
    log('warn', 'mux store: the pane file is unreadable', { path, error: r.error })
    return { ok: false, code: 'invalid' }
  }
  const v = r.value
  if (v === null || typeof v !== 'object') return { ok: false, code: 'invalid' }
  const s = v as Record<string, unknown>
  if (s['v'] !== 1 || typeof s['slug'] !== 'string' || typeof s['mux'] !== 'string' || !(MUX_KINDS as readonly string[]).includes(s['mux']) || !Array.isArray(s['panes'])) {
    log('warn', 'mux store: the pane file has an unexpected shape', { path })
    return { ok: false, code: 'invalid' }
  }
  const mux = s['mux'] as MuxKind
  const panes: MuxRecord[] = []
  for (const p of s['panes'] as unknown[]) {
    if (isRecord(mux, p)) panes.push(p)
    else log('warn', 'mux store: a pane record was dropped', { path, pane: p })
  }
  return { ok: true, store: { v: 1, slug: s['slug'], mux, panes } }
}

/** The store, or undefined when the file is missing or unreadable (a warning is logged). */
export function readMuxStore(path: string): MuxStore | undefined {
  const r = readFile(path)
  return r.ok ? r.store : undefined
}

export function writeMuxStore(path: string, store: MuxStore): void {
  ensureDirSync(dirname(path))
  atomicWriteSync(path, JSON.stringify(store, null, 2) + '\n')
}

export function removeMuxStore(path: string): void {
  for (const p of [path, `${path}.lock`]) {
    try { unlinkSync(p) } catch {  }
  }
}

/** BURACLE_LOCK_TIMEOUT_MS shortens the wait in tests, as it does for the board and the repository lock. */
function lockTimeoutMs(): number {
  const raw = process.env['BURACLE_LOCK_TIMEOUT_MS']
  const n = raw !== undefined ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : MUX_LOCK_TIMEOUT_MS
}

/**
 * Read-modify-write under the store's lock. `fn` gets the current store (undefined when there is none) and returns
 * the store to write, or undefined to leave the file as it is. An unreadable file is never overwritten.
 */
export function updateMuxStore(path: string, fn: (store: MuxStore | undefined) => MuxStore | undefined): MuxStoreResult {
  try {
    return withFileLock(path, (): MuxStoreResult => {
      const r = readFile(path)
      if (!r.ok && r.code === 'invalid') return { ok: false, code: 'unreadable', message: `the pane file ${path} is unreadable; it was not overwritten` }
      const current = r.ok ? r.store : undefined
      const next = fn(current)
      if (next !== undefined && next !== current) writeMuxStore(path, next)
      return { ok: true, store: next ?? current }
    }, lockTimeoutMs(), MUX_LOCK_STALE_MS)
  } catch (e) {
    return { ok: false, code: 'locked', message: `the pane file ${path} is busy: ${e instanceof Error ? e.message : String(e)}; try again` }
  }
}

export function addPanes(store: MuxStore | undefined, init: { slug: string; mux: MuxKind }, panes: MuxRecord[]): MuxStore {
  // A store whose panes are all gone may change multiplexer with the next spawn; one with panes keeps its own.
  const base: MuxStore = store === undefined || store.panes.length === 0 ? { v: 1, slug: init.slug, mux: init.mux, panes: [] } : store
  const known = new Set(base.panes.map(p => p.id))
  return { ...base, panes: [...base.panes, ...panes.filter(p => !known.has(p.id))] }
}

function handlesOf(p: MuxRecord): string[] { return [p.id, ...(p.ids ?? [])] }

/** The pane recorded under `id`, which may be the main id or one of the extra handles (cmux refs). */
export function findPane(store: MuxStore, id: string): MuxRecord | undefined {
  return store.panes.find(p => handlesOf(p).includes(id))
}

/**
 * Records that `session` joined from the pane `id`; false when no such pane was opened by Buracle. `handles` are other
 * ids the multiplexer has for that pane (cmux: the ref and the UUID of the worker's CMUX_SURFACE_ID): the record keeps
 * them, so that the worker's later calls find the pane by its own id without asking the multiplexer again.
 */
export function bindPane(store: MuxStore, id: string, session: BoardSession, handles: readonly string[] = []): { store: MuxStore; bound: boolean } {
  const pane = findPane(store, id) ?? handles.map(h => findPane(store, h)).find(p => p !== undefined)
  if (pane === undefined) return { store, bound: false }
  const ids = [...new Set([...handlesOf(pane), id, ...handles])].filter(h => !h.startsWith('-'))
  const bound: MuxRecord = { ...pane, session: { harness: session.harness, session: session.session }, ...(ids.length > 1 || pane.ids !== undefined ? { ids } : {}) }
  return { store: { ...store, panes: store.panes.map(p => (p === pane ? bound : p)) }, bound: true }
}

export function removePanes(store: MuxStore, ids: readonly string[]): MuxStore {
  return { ...store, panes: store.panes.filter(p => !ids.includes(p.id)) }
}

export function panesOf(store: MuxStore, session: BoardSession): MuxRecord[] {
  return store.panes.filter(p => p.session !== undefined && p.session.harness === session.harness && p.session.session === session.session)
}

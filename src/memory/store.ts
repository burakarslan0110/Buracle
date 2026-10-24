import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { cortexQuery, fromCortex, toCortexSave, type MemItem, type MemKind, type MemLayer, type MemRankInput } from '../core/memory/brain'
import { log } from '../engine/log'
import { CortexError, cortexFor } from './cortex'
import { brainLockFile, eventsFile, personDbFile, projectDbFile } from './layout'
import { acquireLock } from './lock'

export interface BrainRef { layer: MemLayer, slug?: string, db: string }

export function personRef(): BrainRef {
  return { layer: 'person', db: personDbFile() }
}

export function projectRef(slug: string): BrainRef {
  return { layer: 'project', slug, db: projectDbFile(slug) }
}

export function brainExists(ref: BrainRef): boolean {
  return existsSync(ref.db)
}

export interface Stored { item: MemItem, keep: Record<string, unknown> }

function keepOf(raw: unknown): Record<string, unknown> {
  const meta = raw !== null && typeof raw === 'object' ? (raw as { metadata?: unknown }).metadata : undefined
  if (meta === null || typeof meta !== 'object') return {}
  const m = meta as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['recall_count', 'last_recalled_at', 'superseded_by', 'superseded_at']) if (m[k] !== undefined) out[k] = m[k]
  return out
}

const PAGE = 200
const MAX_LIST = 20_000
const LIST_CACHE_MS = 60_000
const listCache = new Map<string, { sig: string, at: number, items: MemItem[] }>()

export function brainSig(db: string): string {
  const one = (file: string): string => { try { const s = statSync(file); return `${s.mtimeMs}:${s.size}` } catch { return '-' } }
  return `${one(db)}|${one(`${db}-wal`)}`
}

export function forgetListCache(db: string): void {
  listCache.delete(db)
}

export async function listAll(ref: BrainRef): Promise<MemItem[]> {
  if (!brainExists(ref)) return []
  const sig = brainSig(ref.db)
  const hit = listCache.get(ref.db)
  if (hit !== undefined && hit.sig === sig && Date.now() - hit.at < LIST_CACHE_MS) return [...hit.items]
  const items = await listAllNow(ref)
  listCache.set(ref.db, { sig, at: Date.now(), items })
  return [...items]
}

async function listAllNow(ref: BrainRef): Promise<MemItem[]> {
  const c = cortexFor(ref.db)
  const out: MemItem[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < MAX_LIST / PAGE; pages++) {
    const r = await c.call<{ memories?: unknown[], next_cursor?: unknown, truncated?: unknown }>('memory_list_all', { limit: PAGE, ...(cursor !== undefined ? { cursor } : {}) })
    for (const raw of r.memories ?? []) {
      const item = fromCortex(raw, ref.layer)
      if (item !== undefined) out.push(item)
    }
    if (typeof r.next_cursor !== 'string' || r.next_cursor === '') break
    cursor = r.next_cursor
  }
  return out
}

export async function getStored(ref: BrainRef, id: string): Promise<Stored | undefined> {
  if (!brainExists(ref)) return undefined
  try {
    const r = await cortexFor(ref.db).call<{ memory?: unknown }>('memory_get', { memory_id: id })
    const item = fromCortex(r.memory, ref.layer)
    return item !== undefined ? { item, keep: keepOf(r.memory) } : undefined
  } catch (e) {
    if (e instanceof CortexError && e.code === 'not_found') return undefined
    throw e
  }
}

export async function searchLayer(ref: BrainRef, query: string, topK: number): Promise<MemRankInput[]> {
  if (!brainExists(ref)) return []
  const r = await cortexFor(ref.db).call<{ results?: Array<{ memory?: unknown }> }>('memory_search', cortexQuery(query, topK))
  const out: MemRankInput[] = []
  for (const [rank, hit] of (r.results ?? []).entries()) {
    const item = fromCortex(hit.memory, ref.layer)
    if (item !== undefined) out.push({ item, rank })
  }
  return out
}

export async function saveItem(ref: BrainRef, item: MemItem, keep: Record<string, unknown> = {}, opts: { supersedes?: string[], nowMs?: number } = {}): Promise<void> {
  mkdirSync(dirname(ref.db), { recursive: true, mode: 0o700 })
  const args = toCortexSave(item, keep, opts.nowMs ?? Date.now())
  if (opts.supersedes !== undefined && opts.supersedes.length > 0) args['supersedes'] = opts.supersedes
  await cortexFor(ref.db).call('memory_save', args)
  const hit = listCache.get(ref.db)
  if (hit === undefined || (opts.supersedes !== undefined && opts.supersedes.length > 0)) listCache.delete(ref.db)
  else listCache.set(ref.db, { sig: brainSig(ref.db), at: Date.now(), items: [{ ...item }, ...hit.items.filter(i => i.id !== item.id)] })
}

export async function deleteItem(ref: BrainRef, id: string): Promise<boolean> {
  listCache.delete(ref.db)
  if (!brainExists(ref)) return false
  try {
    await cortexFor(ref.db).call('memory_delete', { memory_id: id })
    return true
  } catch (e) {
    if (e instanceof CortexError && e.code === 'not_found') return false
    throw e
  }
}

function brainLockWaitMs(): number {
  const v = Number(process.env['BURACLE_BRAIN_LOCK_WAIT_MS'])
  return Number.isFinite(v) && v > 0 ? v : 15_000
}

export async function withBrainLock<T>(ref: BrainRef, fn: () => Promise<T>, opts: { timeoutMs?: number, staleMs?: number } = {}): Promise<T> {
  const release = await acquireLock(brainLockFile(ref.db), { timeoutMs: opts.timeoutMs ?? brainLockWaitMs(), staleMs: opts.staleMs ?? 60_000, heartbeat: true })
  if (!release) throw new CortexError('busy', `the memory of ${ref.slug ?? 'the person'} is busy; try again`)
  try {
    return await fn()
  } finally {
    release()
  }
}

export type BrainOp = 'write' | 'update' | 'retire' | 'delete' | 'recall' | 'import'

export interface BrainEvent {
  at: string
  op: BrainOp
  layer: MemLayer
  project?: string
  id?: string
  kind?: MemKind
  ids?: string[]
  by?: string
  n?: number
}

const EVENTS_MAX_BYTES = 2 * 1024 * 1024

export function recordEvent(e: Omit<BrainEvent, 'at'> & { at?: string }): void {
  try {
    const file = eventsFile()
    mkdirSync(dirname(file), { recursive: true })
    try { if (statSync(file).size > EVENTS_MAX_BYTES) renameSync(file, `${file}.1`) } catch {  }
    const line: BrainEvent = { at: e.at ?? new Date().toISOString(), op: e.op, layer: e.layer }
    if (e.project !== undefined) line.project = e.project
    if (e.id !== undefined) line.id = e.id
    if (e.kind !== undefined) line.kind = e.kind
    if (e.ids !== undefined) line.ids = e.ids.slice(0, 20)
    if (e.by !== undefined) line.by = e.by
    if (e.n !== undefined) line.n = e.n
    appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 })
  } catch (err) {
    log('debug', 'memory: event not recorded', { error: err })
  }
}

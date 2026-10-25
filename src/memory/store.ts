import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { cortexAbout, cortexQuery, fromCortex, toCortexSave, type MemItem, type MemKind, type MemLayer, type MemRankInput } from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { log } from '../engine/log'
import { CortexError, cortexFor } from './cortex'
import { brainDbFile, brainLockFile, eventsFile } from './layout'
import { acquireLock } from './lock'
import { legacyPending } from './migration-state'

/**
 * One CortexDB file holds the whole brain, in two kinds of bucket: the person's (scope `user`, user id `person`) and one
 * per project (scope `global`, namespace = the slug). A CortexDB memory id is the primary key of the whole file, so every
 * stored id carries its bucket: `u/<id>` for the person, `p/<slug>/<id>` for a project. That prefix is added and removed
 * in this module only; everything else sees the plain id.
 */
export interface BrainRef { layer: MemLayer, slug?: string }

export function personRef(): BrainRef {
  return { layer: 'person' }
}

export function projectRef(slug: string): BrainRef {
  if (!memIsSlug(slug)) throw new Error(`not a project slug: ${JSON.stringify(slug)}`)
  return { layer: 'project', slug }
}

/** `person` or `project:<slug>`: the name of a bucket in locks, caches and counts. */
export function refKey(ref: BrainRef): string {
  return ref.layer === 'person' ? 'person' : `project:${ref.slug ?? ''}`
}

export function refOfKey(key: string): BrainRef | undefined {
  if (key === 'person') return personRef()
  return key.startsWith('project:') && memIsSlug(key.slice('project:'.length)) ? projectRef(key.slice('project:'.length)) : undefined
}

const PERSON_USER = 'person'

function prefixOf(ref: BrainRef): string {
  return ref.layer === 'person' ? 'u/' : `p/${ref.slug ?? ''}/`
}

export function storedId(ref: BrainRef, id: string): string {
  return `${prefixOf(ref)}${id}`
}

function plainId(ref: BrainRef, stored: string): string | undefined {
  const p = prefixOf(ref)
  return stored.startsWith(p) && stored.length > p.length ? stored.slice(p.length) : undefined
}

export function bucketArgs(ref: BrainRef): Record<string, string> {
  return ref.layer === 'person' ? { scope: 'user', user_id: PERSON_USER } : { scope: 'global', namespace: ref.slug ?? '' }
}

/** The bucket a stored row belongs to and its plain id; a row of nobody (no prefix, or fields that disagree with it) is undefined. */
export function rowOwner(raw: unknown): { ref: BrainRef, id: string } | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const stored = r['id']
  if (typeof stored !== 'string') return undefined
  let ref: BrainRef | undefined
  let id = ''
  if (stored.startsWith('u/')) {
    ref = personRef()
    id = stored.slice(2)
    if ((typeof r['scope'] === 'string' && r['scope'] !== 'user') || (typeof r['user_id'] === 'string' && r['user_id'] !== PERSON_USER)) return undefined
  } else {
    const m = /^p\/([^/]+)\/(.+)$/.exec(stored)
    if (m === null || !memIsSlug(m[1])) return undefined
    ref = projectRef(m[1])
    id = m[2] as string
    if ((typeof r['scope'] === 'string' && r['scope'] !== 'global') || (typeof r['namespace'] === 'string' && r['namespace'] !== m[1])) return undefined
  }
  return id === '' ? undefined : { ref, id }
}

/** A stored row as the rest of Buracle reads it: the plain id, and `superseded_by` pointing at a plain id too. Undefined when the row is not in that bucket. */
export function plainRow(raw: unknown, ref: BrainRef): Record<string, unknown> | undefined {
  const owner = rowOwner(raw)
  if (owner === undefined || refKey(owner.ref) !== refKey(ref)) return undefined
  const r = raw as Record<string, unknown>
  const meta = r['metadata'] !== null && typeof r['metadata'] === 'object' ? { ...(r['metadata'] as Record<string, unknown>) } : {}
  if (typeof meta['superseded_by'] === 'string') meta['superseded_by'] = plainId(ref, meta['superseded_by']) ?? meta['superseded_by']
  return { ...r, id: owner.id, metadata: meta }
}

export function brainExists(): boolean {
  return existsSync(brainDbFile())
}

export interface Stored { item: MemItem, keep: Record<string, unknown> }

/** The metadata a re-save carries over from the row it replaces: the recall counters and the retirement. */
export function keepOf(raw: unknown): Record<string, unknown> {
  const meta = raw !== null && typeof raw === 'object' ? (raw as { metadata?: unknown }).metadata : undefined
  if (meta === null || typeof meta !== 'object') return {}
  const m = meta as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['recall_count', 'last_recalled_at', 'superseded_by', 'superseded_at']) if (m[k] !== undefined) out[k] = m[k]
  return out
}

// A memory call that finds Buracle 0.5 files waits for the migration (src/memory/migrate.ts) before it reads or writes
// anything, so half-migrated data is never served and legacy-only data is never reported as an empty brain.
const gateBypass = new AsyncLocalStorage<true>()

export function bypassMigrationGate<T>(fn: () => Promise<T>): Promise<T> {
  return gateBypass.run(true, fn)
}

async function ready(): Promise<void> {
  if (gateBypass.getStore() === true || !legacyPending()) return
  const { ensureMigrated } = await import('./migrate')
  await ensureMigrated()
}

const PAGE = 1000
const MAX_LIST = 200_000
const LIST_CACHE_MS = 60_000

interface Entry { sig: string, at: number, items: MemItem[] }
const listCache = new Map<string, Entry>()
let scanInflight: { file: string, sig: string, p: Promise<Scan> } | undefined
let lastScan: { file: string, sig: string, at: number, counts: BucketCounts } | undefined

export interface BucketCounts { person: number, projects: Map<string, number>, foreign: number }
interface Scan { buckets: Map<string, MemItem[]>, counts: BucketCounts }

function sigOf(db: string): string {
  const one = (file: string): string => { try { const s = statSync(file); return `${s.mtimeMs}:${s.size}` } catch { return '-' } }
  return `${one(db)}|${one(`${db}-wal`)}`
}

export function brainSig(db: string = brainDbFile()): string {
  return sigOf(db)
}

const cacheKey = (ref: BrainRef): string => `${brainDbFile()}\n${refKey(ref)}`

export function forgetListCache(): void {
  listCache.clear()
  lastScan = undefined
}

/** Every raw row of a CortexDB file, page by page. */
export async function rawRows(db: string): Promise<unknown[]> {
  const c = cortexFor(db)
  const out: unknown[] = []
  let cursor: string | undefined
  for (let pages = 0; pages < MAX_LIST / PAGE; pages++) {
    const r = await c.call<{ memories?: unknown[], next_cursor?: unknown }>('memory_list_all', { limit: PAGE, ...(cursor !== undefined ? { cursor } : {}) })
    out.push(...(r.memories ?? []))
    if (typeof r.next_cursor !== 'string' || r.next_cursor === '') break
    cursor = r.next_cursor
  }
  return out
}

async function scanNow(): Promise<Scan> {
  const buckets = new Map<string, MemItem[]>()
  const counts: BucketCounts = { person: 0, projects: new Map(), foreign: 0 }
  for (const raw of await rawRows(brainDbFile())) {
    const owner = rowOwner(raw)
    if (owner === undefined) { counts.foreign++; continue }
    if (owner.ref.layer === 'person') counts.person++
    else counts.projects.set(owner.ref.slug as string, (counts.projects.get(owner.ref.slug as string) ?? 0) + 1)
    const item = fromCortex(plainRow(raw, owner.ref), owner.ref.layer)
    if (item === undefined) continue
    const key = refKey(owner.ref)
    const list = buckets.get(key)
    if (list === undefined) buckets.set(key, [item])
    else list.push(item)
  }
  return { buckets, counts }
}

async function scan(): Promise<Scan> {
  const file = brainDbFile()
  const sig = sigOf(file)
  if (scanInflight !== undefined && scanInflight.file === file && scanInflight.sig === sig) return scanInflight.p
  const p = scanNow().then(s => {
    const at = Date.now()
    for (const [key, items] of s.buckets) listCache.set(`${file}\n${key}`, { sig, at, items })
    lastScan = { file, sig, at, counts: s.counts }
    return s
  }).finally(() => { if (scanInflight?.p === p) scanInflight = undefined })
  scanInflight = { file, sig, p }
  return p
}

/** The memories of one bucket, newest first. One pass over the file serves every bucket until the file changes. */
export async function listAll(ref: BrainRef): Promise<MemItem[]> {
  await ready()
  if (!brainExists()) return []
  const sig = sigOf(brainDbFile())
  const hit = listCache.get(cacheKey(ref))
  if (hit !== undefined && hit.sig === sig && Date.now() - hit.at < LIST_CACHE_MS) return [...hit.items]
  const s = await scan()
  const items = s.buckets.get(refKey(ref)) ?? []
  listCache.set(cacheKey(ref), { sig: sigOf(brainDbFile()) === sig ? sig : '', at: Date.now(), items })
  return [...items]
}

/** How many rows each bucket holds (retired ones too), and how many rows belong to nobody Buracle knows. */
export async function bucketCounts(): Promise<BucketCounts> {
  await ready()
  if (!brainExists()) return { person: 0, projects: new Map(), foreign: 0 }
  const sig = sigOf(brainDbFile())
  if (lastScan !== undefined && lastScan.file === brainDbFile() && lastScan.sig === sig && Date.now() - lastScan.at < LIST_CACHE_MS) return lastScan.counts
  return (await scan()).counts
}

/** True when the bucket holds a row (a retired one counts). */
export async function bucketExists(ref: BrainRef): Promise<boolean> {
  const c = await bucketCounts()
  return ref.layer === 'person' ? c.person > 0 : (c.projects.get(ref.slug ?? '') ?? 0) > 0
}

export async function getStored(ref: BrainRef, id: string): Promise<Stored | undefined> {
  await ready()
  if (!brainExists()) return undefined
  try {
    const r = await cortexFor(brainDbFile()).call<{ memory?: unknown }>('memory_get', { memory_id: storedId(ref, id) })
    const row = plainRow(r.memory, ref)
    const item = fromCortex(row, ref.layer)
    return item !== undefined ? { item, keep: keepOf(row) } : undefined
  } catch (e) {
    if (e instanceof CortexError && e.code === 'not_found') return undefined
    throw e
  }
}

export async function searchLayer(ref: BrainRef, query: string, topK: number, opts: { about?: readonly string[] } = {}): Promise<MemRankInput[]> {
  await ready()
  if (!brainExists()) return []
  const args = { ...cortexAbout(cortexQuery(query, topK), opts.about ?? []), ...bucketArgs(ref) }
  const r = await cortexFor(brainDbFile()).call<{ results?: Array<{ memory?: unknown }> }>('memory_search', args)
  const out: MemRankInput[] = []
  for (const [rank, hit] of (r.results ?? []).entries()) {
    const item = fromCortex(plainRow(hit.memory, ref), ref.layer)
    if (item !== undefined) out.push({ item, rank })
  }
  return out
}

export interface SaveOptions {
  supersedes?: string[]
  nowMs?: number
  /** Keep an `expires` date that has passed as data instead of giving the row a time to live (a migration or a restore of old rows). */
  noTtl?: boolean
}

/** The memory_save arguments of an item in its bucket. */
export function storedSave(ref: BrainRef, item: MemItem, keep: Record<string, unknown> = {}, opts: SaveOptions = {}): Record<string, unknown> {
  const kept = { ...keep }
  if (typeof kept['superseded_by'] === 'string') kept['superseded_by'] = storedId(ref, kept['superseded_by'])
  const args: Record<string, unknown> = { ...toCortexSave(item, kept, opts.nowMs ?? Date.now()), ...bucketArgs(ref), memory_id: storedId(ref, item.id) }
  if (opts.supersedes !== undefined && opts.supersedes.length > 0) args['supersedes'] = opts.supersedes.map(s => storedId(ref, s))
  if (opts.noTtl === true) delete args['ttl_seconds']
  return args
}

async function callSave(args: Record<string, unknown>): Promise<void> {
  const c = cortexFor(brainDbFile())
  try {
    await c.call('memory_save', args)
  } catch (e) {
    // The graph is an enrichment: when the engine rejects the entities or relations, the memory is still saved without them.
    if (!(e instanceof CortexError) || e.code !== 'tool_error' || (args['entities'] === undefined && args['relations'] === undefined)) throw e
    log('debug', 'memory: saved without its graph', { id: args['memory_id'], error: e })
    const { entities: _e, relations: _r, ...rest } = args
    await c.call('memory_save', rest)
  }
}

export async function saveItem(ref: BrainRef, item: MemItem, keep: Record<string, unknown> = {}, opts: SaveOptions = {}): Promise<void> {
  await ready()
  mkdirSync(dirname(brainDbFile()), { recursive: true, mode: 0o700 })
  await callSave(storedSave(ref, item, keep, opts))
  const hit = listCache.get(cacheKey(ref))
  if (hit === undefined || (opts.supersedes !== undefined && opts.supersedes.length > 0)) listCache.delete(cacheKey(ref))
  else listCache.set(cacheKey(ref), { sig: sigOf(brainDbFile()), at: Date.now(), items: [{ ...item }, ...hit.items.filter(i => i.id !== item.id)] })
}

export async function deleteItem(ref: BrainRef, id: string): Promise<boolean> {
  await ready()
  listCache.delete(cacheKey(ref))
  if (!brainExists()) return false
  try {
    await cortexFor(brainDbFile()).call('memory_delete', { memory_id: storedId(ref, id) })
    return true
  } catch (e) {
    if (e instanceof CortexError && e.code === 'not_found') return false
    throw e
  }
}

/** Deletes every row of one bucket by its id prefix and returns how many went. The other buckets are not touched. */
export async function deleteBucket(ref: BrainRef): Promise<number> {
  await ready()
  if (!brainExists()) return 0
  const c = cortexFor(brainDbFile())
  let n = 0
  for (const raw of await rawRows(brainDbFile())) {
    const owner = rowOwner(raw)
    if (owner === undefined || refKey(owner.ref) !== refKey(ref)) continue
    try {
      await c.call('memory_delete', { memory_id: (raw as { id: string }).id })
      n++
    } catch (e) {
      if (!(e instanceof CortexError && e.code === 'not_found')) throw e
    }
  }
  forgetListCache()
  return n
}

function brainLockWaitMs(): number {
  const v = Number(process.env['BURACLE_BRAIN_LOCK_WAIT_MS'])
  return Number.isFinite(v) && v > 0 ? v : 15_000
}

/** Serialises the writers of one bucket; a writer of another project does not wait. */
export async function withBrainLock<T>(ref: BrainRef, fn: () => Promise<T>, opts: { timeoutMs?: number, staleMs?: number } = {}): Promise<T> {
  const release = await acquireLock(brainLockFile(refKey(ref)), { timeoutMs: opts.timeoutMs ?? brainLockWaitMs(), staleMs: opts.staleMs ?? 60_000, heartbeat: true })
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

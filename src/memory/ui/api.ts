import {
  isLive, isMemId, KIND_INFO, MEM_KINDS, rankHits, regionOf, regionSummaries, REGIONS, searchTerms,
  type MemItem, type MemKind, type MemRankInput,
} from '../../core/memory/brain'
import { memIsSlug } from '../../core/memory/note'
import { isPersonRegion, PERSON_REGIONS, personRegionOf, personRegionSummaries } from '../../core/memory/person-brain'
import { memGraph, type MemGraphRegion } from '../../core/memory/graph'
import { memQueryWords } from '../../core/memory/query'
import { memStemForms } from '../../core/memory/stem'
import { cortexdbBinary } from '../../engine/toolchain/cortexdb'
import { CortexError } from '../cortex'
import { brainDir } from '../layout'
import { readProjectsCache, slugExclusion } from '../project'
import { bucketCounts, bucketExists, brainExists, brainSig, getStored, listAll, personRef, projectRef, refKey, type BrainRef } from '../store'

export const CORTEXDB_FIX = 'buracle install'

export class UiApiError extends Error {
  readonly status: number
  readonly code: string
  readonly fix?: string
  constructor(status: number, code: string, message: string, fix?: string) {
    super(message)
    this.name = 'UiApiError'
    this.status = status
    this.code = code
    if (fix !== undefined) this.fix = fix
  }
}

export function errorPayload(e: unknown): { status: number, body: { error: string, message: string, fix?: string } } {
  if (e instanceof UiApiError) return { status: e.status, body: { error: e.code, message: e.message, ...(e.fix !== undefined ? { fix: e.fix } : {}) } }
  if (e instanceof CortexError && e.code === 'not_installed') return { status: 503, body: { error: 'cortexdb_missing', message: 'CortexDB is not installed, so the brain cannot be read.', fix: CORTEXDB_FIX } }
  if (e instanceof CortexError) return { status: 502, body: { error: 'cortexdb_failed', message: e.message } }
  return { status: 500, body: { error: 'failed', message: e instanceof Error ? e.message : String(e) } }
}

export type UiScope =
  | { kind: 'person', key: 'person', ref: BrainRef }
  | { kind: 'project', key: string, slug: string, ref: BrainRef }

export async function knownProjects(): Promise<Map<string, { exists: boolean, name?: string }>> {
  const out = new Map<string, { exists: boolean, name?: string }>()
  try {
    for (const slug of (await bucketCounts()).projects.keys()) out.set(slug, { exists: true })
  } catch {  }
  for (const [slug, rec] of Object.entries(readProjectsCache().projects)) {
    if (!memIsSlug(slug)) continue
    const have = out.get(slug)
    if (have === undefined && rec.scope === 'adhoc') continue
    const e = have ?? { exists: false }
    if (rec.ownerRepo !== undefined && rec.ownerRepo !== '') e.name = rec.ownerRepo
    out.set(slug, e)
  }
  return out
}

export async function parseScope(raw: string | null): Promise<UiScope> {
  if (raw === 'person') return { kind: 'person', key: 'person', ref: personRef() }
  if (raw === null || raw === '') throw new UiApiError(400, 'bad_scope', 'scope is required: person or project:<slug>')
  const m = /^project:(.*)$/su.exec(raw)
  const slug = m?.[1]
  if (slug === undefined || !memIsSlug(slug)) throw new UiApiError(400, 'bad_scope', 'scope must be person or project:<slug> (lowercase letters, digits and dashes)')
  const ref = projectRef(slug)
  if (!(await bucketExists(ref)) && !(await knownProjects()).has(slug)) throw new UiApiError(404, 'unknown_project', `there is no memory for the project ${slug}`)
  return { kind: 'project', key: `project:${slug}`, slug, ref }
}

const CACHE_MAX_AGE_MS = 30_000

export class BrainCache {
  private readonly entries = new Map<string, { sig: string, at: number, items: MemItem[] }>()
  private readonly inflight = new Map<string, Promise<MemItem[]>>()
  private readonly terms = new WeakMap<MemItem, string[]>()

  async items(ref: BrainRef, nowMs = Date.now()): Promise<MemItem[]> {
    if (!brainExists()) return []
    const key = refKey(ref)
    const sig = brainSig()
    const hit = this.entries.get(key)
    if (hit !== undefined && hit.sig === sig && nowMs - hit.at < CACHE_MAX_AGE_MS) return hit.items
    const running = this.inflight.get(key)
    if (running !== undefined) return running
    const p = listAll(ref)
      .then(items => { this.entries.set(key, { sig, at: nowMs, items }); return items })
      .finally(() => { this.inflight.delete(key) })
    this.inflight.set(key, p)
    return p
  }

  termsOf(i: MemItem): string[] {
    let t = this.terms.get(i)
    if (t === undefined) {
      t = searchTerms(`${i.title} ${i.summary} ${i.tags.join(' ')} ${i.body}`)
      this.terms.set(i, t)
    }
    return t
  }
}

export interface UiBrief {
  id: string
  kind: MemKind
  region: MemGraphRegion
  title: string
  summary: string
  tags: string[]
  importance: number
  review: 'pending' | 'ok'
  unverified: boolean
  status: MemItem['status']
  created: string
  updated: string
  author: MemItem['author']
  pinned?: boolean
  recallCount?: number
  lastRecalledAt?: string
  origin?: MemItem['origin']
  confidence?: number
  contradicts?: boolean
}

export function regionFor(scope: Pick<UiScope, 'kind'>): (i: Pick<MemItem, 'kind' | 'title' | 'summary' | 'tags'>) => MemGraphRegion {
  return scope.kind === 'person' ? personRegionOf : (i) => regionOf(i.kind)
}

function brief(i: MemItem, region: (i: MemItem) => MemGraphRegion = (x) => regionOf(x.kind)): UiBrief {
  const b: UiBrief = {
    id: i.id, kind: i.kind, region: region(i), title: i.title, summary: i.summary, tags: i.tags, importance: i.importance,
    review: i.review, unverified: i.review === 'pending' && !KIND_INFO[i.kind].generated, status: i.status,
    created: i.created, updated: i.updated, author: i.author,
  }
  if (i.pinned === true) b.pinned = true
  if (i.recallCount !== undefined) b.recallCount = i.recallCount
  if (i.lastRecalledAt !== undefined) b.lastRecalledAt = i.lastRecalledAt
  if (i.origin !== undefined) b.origin = i.origin
  if (i.confidence !== undefined) b.confidence = i.confidence
  if (i.contradictedAt !== undefined) b.contradicts = true
  return b
}

const byWeight = (a: MemItem, b: MemItem) =>
  Number(b.pinned === true) - Number(a.pinned === true) || b.importance - a.importance || (b.updated || b.created).localeCompare(a.updated || a.created)

function regionCounts(scope: UiScope, items: readonly MemItem[], nowMs: number): Record<string, number> {
  const ids: readonly string[] = scope.kind === 'person' ? PERSON_REGIONS.map(r => r.id) : REGIONS.map(r => r.id)
  const out: Record<string, number> = Object.fromEntries(ids.map(id => [id, 0]))
  const region = regionFor(scope)
  for (const i of items) if (isLive(i, nowMs)) out[region(i)] = (out[region(i)] ?? 0) + 1
  return out
}

function lastActivity(items: readonly MemItem[]): string | undefined {
  let best: string | undefined
  for (const i of items) {
    const t = i.updated || i.created
    if (t !== '' && (best === undefined || t > best)) best = t
  }
  return best
}

export interface UiLayerSummary {
  scope: string
  exists: boolean
  count: number | null
  regions: Record<string, number> | null
  lastActivity?: string
  error?: string
}

async function layerSummary(cache: BrainCache, scope: UiScope, nowMs: number): Promise<UiLayerSummary> {
  const exists = await bucketExists(scope.ref).catch(() => false)
  try {
    const items = await cache.items(scope.ref, nowMs)
    const s: UiLayerSummary = { scope: scope.key, exists, count: items.filter(i => isLive(i, nowMs)).length, regions: regionCounts(scope, items, nowMs) }
    const last = lastActivity(items)
    if (last !== undefined) s.lastActivity = last
    return s
  } catch (e) {
    return { scope: scope.key, exists, count: null, regions: null, error: errorPayload(e).body.error }
  }
}

async function pool<T, R>(list: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(list.length)
  let next = 0
  const worker = async () => {
    while (next < list.length) {
      const i = next++
      out[i] = await fn(list[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker))
  return out
}

export async function overview(cache: BrainCache, nowMs: number): Promise<Record<string, unknown>> {
  const bin = cortexdbBinary()
  const known = await knownProjects()
  const person = await layerSummary(cache, { kind: 'person', key: 'person', ref: personRef() }, nowMs)
  const projects = await pool([...known.entries()], 3, async ([slug, k]) => {
    const excluded = await slugExclusion(slug).catch(() => undefined)
    return {
      slug, ...(k.name !== undefined ? { name: k.name } : {}), ...(excluded !== undefined ? { excluded } : {}),
      ...await layerSummary(cache, { kind: 'project', key: `project:${slug}`, slug, ref: projectRef(slug) }, nowMs),
    }
  })
  projects.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '') || a.slug.localeCompare(b.slug))
  return {
    now: new Date(nowMs).toISOString(),
    store: { engine: 'cortexdb', installed: bin !== undefined, ...(bin !== undefined ? { version: bin.version } : {}), brain: brainDir(), fix: CORTEXDB_FIX },
    regions: REGIONS.map(r => ({ id: r.id, label: r.label, area: r.area, kinds: r.kinds })),
    kinds: Object.fromEntries(MEM_KINDS.map(k => [k, regionOf(k)])),
    person,
    projects,
  }
}

export async function brainOf(cache: BrainCache, scope: UiScope, nowMs: number): Promise<Record<string, unknown>> {
  const items = await cache.items(scope.ref, nowMs)
  const live = items.filter(i => isLive(i, nowMs)).sort(byWeight)
  const regions = scope.kind === 'person'
    ? personRegionSummaries(items, nowMs).map(s => {
      const r = PERSON_REGIONS.find(x => x.id === s.region)
      return { id: s.region, label: r?.label ?? s.region, area: r?.area ?? '', categories: r?.categories ?? [], count: s.count, groups: s.groups, topTags: s.topTags, hypotheses: s.hypotheses, stated: s.stated }
    })
    : (() => {
      const summaries = regionSummaries(items, nowMs)
      return REGIONS.map(r => {
        const s = summaries.find(x => x.region === r.id)
        return { id: r.id, label: r.label, area: r.area, kinds: r.kinds, count: s?.count ?? 0, groups: s?.groups ?? 0, topTags: s?.topTags ?? [] }
      })
    })()
  const out: Record<string, unknown> = {
    scope: scope.key,
    layer: scope.kind,
    design: scope.kind,
    exists: await bucketExists(scope.ref).catch(() => false),
    now: new Date(nowMs).toISOString(),
    regions,
    items: live.map(i => brief(i, regionFor(scope))),
    retired: items.length - live.length,
  }
  if (scope.kind === 'project') out['project'] = scope.slug
  const last = lastActivity(items)
  if (last !== undefined) out['lastActivity'] = last
  return out
}

export async function memoryOf(scope: UiScope, id: string | null): Promise<Record<string, unknown>> {
  if (!isMemId(id)) throw new UiApiError(400, 'bad_id', 'id must be a memory id (lowercase letters, digits and dashes)')
  const got = await getStored(scope.ref, id)
  if (got === undefined) throw new UiApiError(404, 'not_found', `there is no memory ${id} in this brain`)
  const i = got.item
  const provenance: Record<string, string | number> = { version: i.version }
  const keys: Array<keyof MemItem> = ['harness', 'model', 'session', 'branch', 'commit', 'verifiedAt', 'verifiedBy', 'verifiedCommit', 'importedFrom', 'expires', 'supersededBy', 'supersededAt', 'deprecatedAt', 'origin']
  for (const k of keys) {
    const v = i[k]
    if (typeof v === 'string' && v !== '') provenance[k] = v
  }
  if (i.confidence !== undefined) provenance['confidence'] = i.confidence
  const out: Record<string, unknown> = {
    scope: scope.key,
    ...brief(i, regionFor(scope)),
    layer: i.layer,
    body: i.body,
    sources: i.sources,
    about: i.about,
    history: i.history,
    provenance,
  }
  if (i.contradictedNote !== undefined) out['contradictedNote'] = i.contradictedNote
  return out
}

const MAX_QUERY = 200

export async function searchOf(cache: BrainCache, scope: UiScope, rawQuery: string | null, nowMs: number, limit = 40): Promise<Record<string, unknown>> {
  const q = (rawQuery ?? '').trim().slice(0, MAX_QUERY)
  const words = memQueryWords(q)
  if (words.length === 0) return { scope: scope.key, q, items: [] }
  const items = await cache.items(scope.ref, nowMs)
  const forms = words.map(w => [w, ...memStemForms(w)])
  const matched: Array<{ item: MemItem, hits: number }> = []
  for (const i of items) {
    if (!isLive(i, nowMs)) continue
    const terms = cache.termsOf(i)
    let hits = 0
    for (const f of forms) if (f.some(x => terms.some(t => t === x || (x.length >= 3 && t.startsWith(x))))) hits++
    if (hits > 0) matched.push({ item: i, hits })
  }
  matched.sort((a, b) => b.hits - a.hits)
  const ranked = rankHits(q, matched.map((m, rank): MemRankInput => ({ item: m.item, rank })))
  return { scope: scope.key, q, items: ranked.slice(0, limit).map(i => brief(i, regionFor(scope))) }
}

export async function graphOf(cache: BrainCache, scope: UiScope, region: string | null, nowMs: number): Promise<Record<string, unknown>> {
  const ids: readonly string[] = scope.kind === 'person' ? PERSON_REGIONS.map(x => x.id) : REGIONS.map(x => x.id)
  const r = region === null || region === '' ? undefined : (scope.kind === 'person' ? (isPersonRegion(region) ? region : undefined) : REGIONS.find(x => x.id === region)?.id)
  if (r === undefined && region !== null && region !== '') throw new UiApiError(400, 'bad_region', `region must be one of ${ids.join(', ')}, or empty for the whole brain`)
  const items = await cache.items(scope.ref, nowMs)
  return { scope: scope.key, ...memGraph(items, { nowMs, regionOf: regionFor(scope), ...(r !== undefined ? { region: r } : {}) }) }
}

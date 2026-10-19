import { readdirSync, statSync } from 'node:fs'
import {
  isLive, isMemId, KIND_INFO, MEM_KINDS, rankHits, regionOf, regionSummaries, REGIONS, searchTerms,
  type MemItem, type MemKind, type MemRankInput, type UpkeepItem, type UpkeepReason,
} from '../../core/memory/brain'
import { memIsSlug } from '../../core/memory/note'
import { isPersonRegion, PERSON_REGIONS, personRegionOf, personRegionSummaries } from '../../core/memory/person-brain'
import { memGraph, type MemGraphRegion } from '../../core/memory/graph'
import { memQueryWords } from '../../core/memory/query'
import { memStemForms } from '../../core/memory/stem'
import { cortexdbBinary } from '../../engine/toolchain/cortexdb'
import { CortexError } from '../cortex'
import { brainDir, brainProjectsDir } from '../layout'
import { profileLines } from '../profile'
import { readProjectsCache, slugExclusion } from '../project'
import { readUpkeep } from '../sweep'
import { brainExists, getStored, listAll, personRef, projectRef, type BrainRef } from '../store'

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

export function knownProjects(): Map<string, { exists: boolean, name?: string }> {
  const out = new Map<string, { exists: boolean, name?: string }>()
  try {
    for (const f of readdirSync(brainProjectsDir())) {
      const slug = f.endsWith('.db') ? f.slice(0, -3) : ''
      if (memIsSlug(slug)) out.set(slug, { exists: true })
    }
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

export function parseScope(raw: string | null): UiScope {
  if (raw === 'person') return { kind: 'person', key: 'person', ref: personRef() }
  if (raw === null || raw === '') throw new UiApiError(400, 'bad_scope', 'scope is required: person or project:<slug>')
  const m = /^project:(.*)$/su.exec(raw)
  const slug = m?.[1]
  if (slug === undefined || !memIsSlug(slug)) throw new UiApiError(400, 'bad_scope', 'scope must be person or project:<slug> (lowercase letters, digits and dashes)')
  const ref = projectRef(slug)
  if (!brainExists(ref) && !knownProjects().has(slug)) throw new UiApiError(404, 'unknown_project', `there is no memory for the project ${slug}`)
  return { kind: 'project', key: `project:${slug}`, slug, ref }
}

function statSig(file: string): string {
  try {
    const s = statSync(file)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return '-'
  }
}

const CACHE_MAX_AGE_MS = 30_000

export class BrainCache {
  private readonly entries = new Map<string, { sig: string, at: number, items: MemItem[] }>()
  private readonly inflight = new Map<string, Promise<MemItem[]>>()
  private readonly terms = new WeakMap<MemItem, string[]>()

  async items(ref: BrainRef, nowMs = Date.now()): Promise<MemItem[]> {
    if (!brainExists(ref)) return []
    const sig = `${statSig(ref.db)}|${statSig(`${ref.db}-wal`)}`
    const hit = this.entries.get(ref.db)
    if (hit !== undefined && hit.sig === sig && nowMs - hit.at < CACHE_MAX_AGE_MS) return hit.items
    const running = this.inflight.get(ref.db)
    if (running !== undefined) return running
    const p = listAll(ref)
      .then(items => { this.entries.set(ref.db, { sig, at: nowMs, items }); return items })
      .finally(() => { this.inflight.delete(ref.db) })
    this.inflight.set(ref.db, p)
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
  upkeep?: UpkeepReason[]
}

export function regionFor(scope: Pick<UiScope, 'kind'>): (i: Pick<MemItem, 'kind' | 'title' | 'summary' | 'tags'>) => MemGraphRegion {
  return scope.kind === 'person' ? personRegionOf : (i) => regionOf(i.kind)
}

function brief(i: MemItem, upkeep: ReadonlyMap<string, UpkeepItem>, region: (i: MemItem) => MemGraphRegion = (x) => regionOf(x.kind)): UiBrief {
  const b: UiBrief = {
    id: i.id, kind: i.kind, region: region(i), title: i.title, summary: i.summary, tags: i.tags, importance: i.importance,
    review: i.review, unverified: i.review === 'pending' && !KIND_INFO[i.kind].generated, status: i.status,
    created: i.created, updated: i.updated, author: i.author,
  }
  if (i.pinned === true) b.pinned = true
  if (i.recallCount !== undefined) b.recallCount = i.recallCount
  if (i.lastRecalledAt !== undefined) b.lastRecalledAt = i.lastRecalledAt
  const u = upkeep.get(i.id)
  if (u !== undefined) b.upkeep = u.reasons
  return b
}

const byWeight = (a: MemItem, b: MemItem) =>
  Number(b.pinned === true) - Number(a.pinned === true) || b.importance - a.importance || (b.updated || b.created).localeCompare(a.updated || a.created)

function upkeepOf(scope: UiScope): { at?: string, gitAt?: string, items: UpkeepItem[], quiet: UpkeepItem[], byId: Map<string, UpkeepItem> } {
  const rec = readUpkeep(scope.kind === 'project' ? scope.slug : undefined)
  const all = (rec?.items ?? []).filter(u => u.layer === scope.kind && isMemId(u.id))
  const items = all.filter(u => u.quiet !== true)
  const out: { at?: string, gitAt?: string, items: UpkeepItem[], quiet: UpkeepItem[], byId: Map<string, UpkeepItem> } = { items, quiet: all.filter(u => u.quiet === true), byId: new Map(all.map(u => [u.id, u])) }
  if (rec?.at !== undefined) out.at = rec.at
  if (rec?.gitAt !== undefined) out.gitAt = rec.gitAt
  return out
}

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
  upkeep: number
  error?: string
}

async function layerSummary(cache: BrainCache, scope: UiScope, nowMs: number): Promise<UiLayerSummary> {
  const exists = brainExists(scope.ref)
  const upkeep = upkeepOf(scope).items.length
  try {
    const items = await cache.items(scope.ref, nowMs)
    const s: UiLayerSummary = { scope: scope.key, exists, count: items.filter(i => isLive(i, nowMs)).length, regions: regionCounts(scope, items, nowMs), upkeep }
    const last = lastActivity(items)
    if (last !== undefined) s.lastActivity = last
    return s
  } catch (e) {
    return { scope: scope.key, exists, count: null, regions: null, upkeep, error: errorPayload(e).body.error }
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
  const known = knownProjects()
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
  const up = upkeepOf(scope)
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
    exists: brainExists(scope.ref),
    now: new Date(nowMs).toISOString(),
    regions,
    items: live.map(i => brief(i, up.byId, regionFor(scope))),
    retired: items.length - live.length,
    upkeep: up.items.length,
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
  const up = upkeepOf(scope).byId.get(i.id)
  const provenance: Record<string, string | number> = { version: i.version }
  const keys: Array<keyof MemItem> = ['harness', 'model', 'session', 'branch', 'commit', 'verifiedAt', 'verifiedBy', 'verifiedCommit', 'importedFrom', 'expires', 'supersededBy', 'supersededAt', 'deprecatedAt']
  for (const k of keys) {
    const v = i[k]
    if (typeof v === 'string' && v !== '') provenance[k] = v
  }
  const out: Record<string, unknown> = {
    scope: scope.key,
    ...brief(i, new Map(), regionFor(scope)),
    layer: i.layer,
    body: i.body,
    sources: i.sources,
    about: i.about,
    history: i.history,
    provenance,
  }
  if (up !== undefined) {
    out['upkeep'] = up.reasons
    out['upkeepAction'] = up.action
    if (up.twin !== undefined) out['twin'] = up.twin
    if (up.files !== undefined) out['files'] = up.files
    if (up.note !== undefined) out['upkeepNote'] = up.note
  }
  return out
}

const MAX_QUERY = 200

export async function searchOf(cache: BrainCache, scope: UiScope, rawQuery: string | null, nowMs: number, limit = 40): Promise<Record<string, unknown>> {
  const q = (rawQuery ?? '').trim().slice(0, MAX_QUERY)
  const words = memQueryWords(q)
  if (words.length === 0) return { scope: scope.key, q, items: [] }
  const items = await cache.items(scope.ref, nowMs)
  const up = upkeepOf(scope)
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
  return { scope: scope.key, q, items: ranked.slice(0, limit).map(i => brief(i, up.byId, regionFor(scope))) }
}

export async function graphOf(cache: BrainCache, scope: UiScope, region: string | null, nowMs: number): Promise<Record<string, unknown>> {
  const ids: readonly string[] = scope.kind === 'person' ? PERSON_REGIONS.map(x => x.id) : REGIONS.map(x => x.id)
  const r = region === null || region === '' ? undefined : (scope.kind === 'person' ? (isPersonRegion(region) ? region : undefined) : REGIONS.find(x => x.id === region)?.id)
  if (r === undefined && region !== null && region !== '') throw new UiApiError(400, 'bad_region', `region must be one of ${ids.join(', ')}, or empty for the whole brain`)
  const items = await cache.items(scope.ref, nowMs)
  const up = upkeepOf(scope)
  return { scope: scope.key, ...memGraph(items, { nowMs, upkeep: up.byId, regionOf: regionFor(scope), ...(r !== undefined ? { region: r } : {}) }) }
}

export function upkeepPayload(scope: UiScope): Record<string, unknown> {
  const up = upkeepOf(scope)
  const counts: Partial<Record<UpkeepReason, number>> = {}
  for (const u of up.items) for (const r of u.reasons) counts[r] = (counts[r] ?? 0) + 1
  return {
    scope: scope.key,
    ...(up.at !== undefined ? { at: up.at } : {}),
    ...(up.gitAt !== undefined ? { gitAt: up.gitAt } : {}),
    counts,
    quiet: up.quiet.length,
    items: up.items.map(u => ({ id: u.id, kind: u.kind, region: regionFor(scope)({ kind: u.kind, title: u.title, summary: '', tags: [] }), title: u.title, reasons: u.reasons, action: u.action, ...(u.twin !== undefined ? { twin: u.twin } : {}), ...(u.files !== undefined ? { files: u.files } : {}), ...(u.note !== undefined ? { note: u.note } : {}) })),
  }
}

export async function profilePayload(cache: BrainCache, nowMs: number): Promise<Record<string, unknown>> {
  const ref = personRef()
  const items = await cache.items(ref, nowMs)
  const live = items.filter(i => isLive(i, nowMs))
  const facts = live.filter(i => i.kind === 'profile')
  const rank = (i: MemItem) => Number((i.tags.find(t => t.startsWith('rank-')) ?? 'rank-9').slice(5))
  return {
    scope: 'person',
    exists: brainExists(ref),
    lines: profileLines(items, 30, nowMs).map(l => l.replace(/^- /, '')),
    facts: facts.sort((a, b) => rank(a) - rank(b) || b.importance - a.importance || a.title.localeCompare(b.title)).map(i => ({
      id: i.id,
      title: i.title,
      category: i.summary.split(' · ')[0] ?? '',
      confidence: i.summary.split(' · ')[1] ?? '',
      hypothesis: i.tags.includes('hypothesis'),
      stated: i.tags.includes('stated'),
      inferred: i.tags.includes('inferred'),
    })),
    preferences: live.filter(i => i.kind === 'preference').sort(byWeight).map(i => brief(i, new Map(), personRegionOf)),
  }
}

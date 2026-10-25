import { isLive, KIND_INFO, memPreparedMemSimilarity, memSimilarityPrep, parseContradictionNote, regionOf, sourcePath, type MemConflict, type MemItem, type MemKind, type MemRegion, type MemStatusValue } from './brain'
import type { PersonRegion } from './person-brain'

export type MemGraphRegion = MemRegion | PersonRegion

export type MemGraphEntityType = 'tag' | 'file' | 'concept'
export type MemGraphEdgeKind = 'tag' | 'cites' | 'about' | 'mentions' | 'supersedes' | 'contradicts' | 'similar' | 'twin' | 'from' | 'related'

export interface MemGraphMemoryNode {
  id: string
  type: 'memory'
  kind: MemKind
  region: MemGraphRegion
  title: string
  importance: number
  unverified: boolean
  pinned: boolean
  recallCount: number
  focus: boolean
  degree: number
  /** Set only on a retired memory shown beside the memory that replaced it (the `includeRetired` option). */
  retired?: true
}

export interface MemGraphEntityNode {
  id: string
  type: MemGraphEntityType
  label: string
  weight: number
  degree: number
}

export type MemGraphNode = MemGraphMemoryNode | MemGraphEntityNode

export interface MemGraphEdge { source: string, target: string, kind: MemGraphEdgeKind, weight: number }

export interface MemGraph {
  region: MemGraphRegion | null
  nodes: MemGraphNode[]
  edges: MemGraphEdge[]
  truncated: boolean
  stats: { memories: number, entities: number, edges: number }
}

export interface MemGraphOptions {
  nowMs: number
  region?: MemGraphRegion
  regionOf?: (i: MemItem) => MemGraphRegion
  limits?: { memories?: number, entities?: number, edges?: number }
  /** Also draw the retired memories that a memory in focus replaced, linked to it by a `supersedes` edge. */
  includeRetired?: boolean
}

export const MEM_GRAPH_LIMITS = { memories: 220, entities: 140, edges: 900 } as const
export const MEM_GRAPH_MAX_NEIGHBORS = 60
export const MEM_GRAPH_MAX_RETIRED = 40
export const MEM_GRAPH_SIMILAR_MAX_FOCUS = 300
export const MEM_GRAPH_SIMILAR_THRESHOLD = 0.5

const EDGE_WEIGHT: Readonly<Record<Exclude<MemGraphEdgeKind, 'similar'>, number>> = {
  supersedes: 1, twin: 0.9, contradicts: 0.9, mentions: 0.8, related: 0.8, from: 0.6, cites: 0.5, about: 0.5, tag: 0.4,
}

const HIDDEN_TAGS: ReadonlySet<string> = new Set(['hypothesis', 'stated'])

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function recency(i: MemItem): string {
  return i.updated !== '' ? i.updated : i.created
}

function byWeight(a: MemItem, b: MemItem): number {
  return Number(b.pinned === true) - Number(a.pinned === true) || b.importance - a.importance || cmp(recency(b), recency(a)) || cmp(a.id, b.id)
}

/** How one memory points at another: an id written in its text, or a `memory:` / `session:` source. */
export type MemCiteVia = 'text' | 'memory' | 'session'

export interface MemCitation { ref: string, via: MemCiteVia }

function mentionTokens(text: string): string[] {
  const out = new Set<string>()
  for (const token of text.split(/[^A-Za-z0-9_-]+/)) if (token.includes('-')) out.add(token)
  return [...out]
}

/**
 * What a memory points at, before anything is looked up: the ids in its summary and body, and its `memory:` and `session:`
 * sources. The graph and the detail of a memory both start from this, so they draw and list the same links.
 */
export function memCitations(i: Pick<MemItem, 'summary' | 'body' | 'sources'>): MemCitation[] {
  const out: MemCitation[] = mentionTokens(`${i.summary}\n${i.body}`).map(ref => ({ ref, via: 'text' as const }))
  for (const s of i.sources) {
    const src = s.trim()
    if (src.startsWith('session:')) out.push({ ref: src.slice(8).trim(), via: 'session' })
    else if (src.startsWith('memory:')) out.push({ ref: src.slice(7).trim(), via: 'memory' })
  }
  return out
}

/** The protected memories this one was written beside (named in its contradiction note). */
export function memContradicted(i: Pick<MemItem, 'contradictedAt' | 'contradictedNote'>): MemConflict[] {
  return i.contradictedAt !== undefined ? parseContradictionNote(i.contradictedNote) : []
}

/** The live memory that took a retired one's place (following `supersededBy` up to five steps), or undefined when the chain ends nowhere live. */
function survivorLookup(items: readonly MemItem[], live: ReadonlyMap<string, MemItem>): (id: string) => string | undefined {
  const superseded = new Map<string, string>()
  for (const i of items) if (!live.has(i.id) && i.supersededBy !== undefined && !superseded.has(i.id)) superseded.set(i.id, i.supersededBy)
  return (id) => {
    let cur = id
    for (let n = 0; n < 5; n++) {
      if (live.has(cur)) return cur
      const next = superseded.get(cur)
      if (next === undefined) return undefined
      cur = next
    }
    return live.has(cur) ? cur : undefined
  }
}

interface EdgeSet { list: MemGraphEdge[], seen: Set<string> }

function addEdge(set: EdgeSet, source: string, target: string, kind: MemGraphEdgeKind, weight: number): void {
  if (source === target) return
  const key = `${kind}\u0000${source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`}`
  if (set.seen.has(key)) return
  set.seen.add(key)
  set.list.push({ source, target, kind, weight })
}

export function memGraph(items: readonly MemItem[], opts: MemGraphOptions): MemGraph {
  const limits = {
    memories: Math.max(0, Math.floor(opts.limits?.memories ?? MEM_GRAPH_LIMITS.memories)),
    entities: Math.max(0, Math.floor(opts.limits?.entities ?? MEM_GRAPH_LIMITS.entities)),
    edges: Math.max(0, Math.floor(opts.limits?.edges ?? MEM_GRAPH_LIMITS.edges)),
  }
  let truncated = false

  const live = new Map<string, MemItem>()
  for (const i of items) if (!live.has(i.id) && isLive(i, opts.nowMs)) live.set(i.id, i)
  const liveSorted = [...live.values()].sort((a, b) => cmp(a.id, b.id))
  const survivorOf = survivorLookup(items, live)

  const regionFor = opts.regionOf ?? ((i: MemItem) => regionOf(i.kind))
  const inRegion = (i: MemItem) => opts.region === undefined || regionFor(i) === opts.region
  const focusAll = liveSorted.filter(inRegion).sort(byWeight)
  const focus = focusAll.slice(0, limits.memories)
  if (focus.length < focusAll.length) truncated = true
  const focusIds = new Set(focus.map(i => i.id))

  const bySession = new Map<string, string>()
  for (const i of liveSorted) if (i.kind === 'session' && i.session !== undefined && !bySession.has(i.session)) bySession.set(i.session, i.id)

  const links: EdgeSet = { list: [], seen: new Set() }
  for (const a of liveSorted) {
    if (a.supersededBy !== undefined && live.has(a.supersededBy)) addEdge(links, a.supersededBy, a.id, 'supersedes', EDGE_WEIGHT.supersedes)
    for (const c of memCitations(a)) {
      if (c.via === 'text') {
        if (live.has(c.ref)) addEdge(links, a.id, c.ref, 'mentions', EDGE_WEIGHT.mentions)
      } else if (c.via === 'session') {
        const target = live.has(c.ref) ? c.ref : bySession.get(c.ref)
        if (target !== undefined) addEdge(links, a.id, target, 'from', EDGE_WEIGHT.from)
      } else {
        const ref = survivorOf(c.ref)
        if (ref !== undefined) addEdge(links, a.id, ref, 'related', EDGE_WEIGHT.related)
      }
    }
    for (const k of memContradicted(a)) if (live.has(k.id)) addEdge(links, a.id, k.id, 'contradicts', EDGE_WEIGHT.contradicts)
  }

  const neighbors: MemItem[] = []
  if (opts.region !== undefined) {
    const touches = new Map<string, number>()
    for (const e of links.list) {
      const sf = focusIds.has(e.source)
      const tf = focusIds.has(e.target)
      if (sf === tf) continue
      const other = sf ? e.target : e.source
      const o = live.get(other)
      if (o === undefined || inRegion(o)) continue
      touches.set(other, (touches.get(other) ?? 0) + 1)
    }
    const all = [...touches.keys()].map(id => live.get(id) as MemItem)
      .sort((a, b) => (touches.get(b.id) ?? 0) - (touches.get(a.id) ?? 0) || byWeight(a, b))
    neighbors.push(...all.slice(0, MEM_GRAPH_MAX_NEIGHBORS))
    if (neighbors.length < all.length) truncated = true
  }
  const ghosts: MemItem[] = []
  const ghostEdges: MemGraphEdge[] = []
  if (opts.includeRetired === true) {
    const replaced = items.filter(i => !live.has(i.id) && i.supersededBy !== undefined && focusIds.has(i.supersededBy))
      .filter((i, n, all) => all.findIndex(x => x.id === i.id) === n).sort(byWeight)
    ghosts.push(...replaced.slice(0, MEM_GRAPH_MAX_RETIRED))
    if (ghosts.length < replaced.length) truncated = true
    for (const g of ghosts) ghostEdges.push({ source: g.supersededBy as string, target: g.id, kind: 'supersedes', weight: EDGE_WEIGHT.supersedes })
  }
  const ghostIds = new Set(ghosts.map(i => i.id))
  const shown = [...focus, ...neighbors]
  const memories = [...shown, ...ghosts]
  const included = new Set(memories.map(i => i.id))
  const memEdges = [...links.list.filter(e => included.has(e.source) && included.has(e.target)), ...ghostEdges]

  if (focus.length <= MEM_GRAPH_SIMILAR_MAX_FOCUS) {
    const cands = shown.filter(i => !KIND_INFO[i.kind].generated).map(i => ({ id: i.id, prep: memSimilarityPrep(i) }))
    const similar: EdgeSet = { list: [], seen: new Set() }
    for (let x = 0; x < cands.length; x++) {
      const a = cands[x] as (typeof cands)[number]
      for (let y = x + 1; y < cands.length; y++) {
        const b = cands[y] as (typeof cands)[number]
        const s = memPreparedMemSimilarity(a.prep, b.prep)
        if (s >= MEM_GRAPH_SIMILAR_THRESHOLD) addEdge(similar, a.id, b.id, 'similar', Math.round(s * 1000) / 1000)
      }
    }
    memEdges.push(...similar.list)
  }

  interface Hub { id: string, type: MemGraphEntityType, label: string, kind: 'tag' | 'about' | 'cites', members: string[] }
  const hubs = new Map<string, Hub>()
  const hubsOf = (i: MemItem): Array<Omit<Hub, 'members'>> => {
    const out: Array<Omit<Hub, 'members'>> = []
    for (const t of i.tags) {
      const tag = t.trim()
      if (tag === '' || tag.startsWith('rank-') || HIDDEN_TAGS.has(tag)) continue
      out.push({ id: `tag:${tag}`, type: 'tag', label: tag, kind: 'tag' })
    }
    for (const a of i.about) {
      const label = a.trim()
      if (label === '') continue
      out.push({ id: `concept:${label.toLowerCase()}`, type: 'concept', label, kind: 'about' })
    }
    for (const s of i.sources) {
      const src = s.trim()
      if (src.startsWith('session:') || src.startsWith('memory:')) continue
      const path = sourcePath(src)
      if (path !== undefined) out.push({ id: `file:${path}`, type: 'file', label: path, kind: 'cites' })
    }
    return out
  }
  for (const i of focus) {
    for (const h of hubsOf(i)) {
      const hub = hubs.get(h.id) ?? { ...h, members: [] }
      if (!hub.members.includes(i.id)) hub.members.push(i.id)
      hubs.set(h.id, hub)
    }
  }
  for (const i of neighbors) {
    for (const h of hubsOf(i)) {
      const hub = hubs.get(h.id)
      if (hub !== undefined && !hub.members.includes(i.id)) hub.members.push(i.id)
    }
  }
  const hubOrder = (a: Hub, b: Hub) => b.members.length - a.members.length || cmp(a.label, b.label) || cmp(a.id, b.id)
  const hubsAll = [...hubs.values()].filter(h => h.members.length > 0).sort(hubOrder)
  const keptHubs = hubsAll.slice(0, limits.entities)
  if (keptHubs.length < hubsAll.length) truncated = true
  const entityEdges: MemGraphEdge[] = []
  for (const h of keptHubs) for (const m of h.members) entityEdges.push({ source: m, target: h.id, kind: h.kind, weight: EDGE_WEIGHT[h.kind] })

  let edges = [...memEdges, ...entityEdges]
  if (edges.length > limits.edges) {
    truncated = true
    const rank = new Map<string, number>()
    memories.forEach((m, n) => rank.set(m.id, n))
    keptHubs.forEach((h, n) => rank.set(h.id, memories.length + n))
    const far = (e: MemGraphEdge) => Math.max(rank.get(e.source) ?? 0, rank.get(e.target) ?? 0)
    const dropFirst = (a: MemGraphEdge, b: MemGraphEdge) =>
      Number(b.kind === 'similar') - Number(a.kind === 'similar') || a.weight - b.weight || far(b) - far(a) ||
      cmp(a.kind, b.kind) || cmp(a.source, b.source) || cmp(a.target, b.target)
    const drop = new Set([...edges].sort(dropFirst).slice(0, edges.length - limits.edges))
    edges = edges.filter(e => !drop.has(e))
  }

  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1)
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1)
  }
  const liveHubs = keptHubs.filter(h => (degree.get(h.id) ?? 0) > 0)
  if (liveHubs.length < keptHubs.length) truncated = true

  const memoryNodes: MemGraphMemoryNode[] = memories.map(i => ({
    id: i.id, type: 'memory', kind: i.kind, region: regionFor(i), title: i.title, importance: i.importance,
    unverified: i.review === 'pending' && !KIND_INFO[i.kind].generated, pinned: i.pinned === true,
    recallCount: i.recallCount ?? 0, focus: focusIds.has(i.id), degree: degree.get(i.id) ?? 0,
    ...(ghostIds.has(i.id) ? { retired: true as const } : {}),
  }))
  const entityNodes: MemGraphEntityNode[] = liveHubs
    .map(h => ({ id: h.id, type: h.type, label: h.label, weight: h.members.length, degree: degree.get(h.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || cmp(a.label, b.label) || cmp(a.id, b.id))

  const kindOrder: readonly MemGraphEdgeKind[] = ['supersedes', 'contradicts', 'mentions', 'twin', 'from', 'related', 'similar', 'tag', 'about', 'cites']
  edges.sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || cmp(a.source, b.source) || cmp(a.target, b.target))

  return {
    region: opts.region ?? null,
    nodes: [...memoryNodes, ...entityNodes],
    edges,
    truncated,
    stats: { memories: memoryNodes.length, entities: entityNodes.length, edges: edges.length },
  }
}

/** Another memory as a relation names it. `title`, `kind` and `status` are missing when the id names no memory of this brain. */
export interface MemRelationRef { id: string, title?: string, kind?: MemKind, status?: MemStatusValue }

export interface MemRelations {
  /** Memories this one points at: ids in its text and its `memory:` / `session:` sources. */
  cites: Array<MemRelationRef & { via: MemCiteVia }>
  citedBy: MemRelationRef[]
  /** Each entity this memory is about, with the other live memories that are about it too (a bounded list; `total` counts them all). */
  about: Array<{ name: string, total: number, others: MemRelationRef[] }>
  /** Memories this one replaced. */
  supersedes: MemRelationRef[]
  supersededBy?: MemRelationRef
  /** The protected memories this one was written beside, marked as contradicting. */
  contradicts: Array<MemRelationRef & { why: MemConflict['why'] }>
  contradictedBy: MemRelationRef[]
}

export const MEM_RELATION_LIMITS = { cites: 20, citedBy: 20, aboutEntities: 12, aboutOthers: 8, supersedes: 10, contradicts: 10 } as const

function refOf(i: MemItem): MemRelationRef {
  return { id: i.id, title: i.title, kind: i.kind, status: i.status }
}

/**
 * Everything the graph draws around one memory, as lists: what it cites and what cites it, what it is about and who else
 * is, what it replaced and what replaced it, and what it contradicts. It reads the same primitives as {@link memGraph}
 * (citations, `about`, `supersededBy`, the contradiction note), so the detail of a memory and the network agree.
 */
export function memRelations(items: readonly MemItem[], id: string, nowMs: number): MemRelations | undefined {
  const self = items.find(i => i.id === id)
  if (self === undefined) return undefined
  const byId = new Map<string, MemItem>()
  for (const i of items) if (!byId.has(i.id)) byId.set(i.id, i)
  const lim = MEM_RELATION_LIMITS

  const live = new Map<string, MemItem>()
  for (const i of items) if (!live.has(i.id) && isLive(i, nowMs)) live.set(i.id, i)
  const survivorOf = survivorLookup(items, live)
  const cites: MemRelations['cites'] = []
  const seenCite = new Set<string>()
  for (const c of memCitations(self)) {
    // A `memory:` source that names a retired memory points at the live one that took its place, as the graph draws it.
    const target = c.via === 'session' ? byId.get(c.ref) ?? items.find(i => i.kind === 'session' && i.session === c.ref)
      : c.via === 'memory' ? byId.get(survivorOf(c.ref) ?? c.ref) : byId.get(c.ref)
    if (target === undefined || target.id === self.id || seenCite.has(target.id)) continue
    seenCite.add(target.id)
    cites.push({ ...refOf(target), via: c.via })
  }

  const citedBy: MemRelationRef[] = []
  for (const i of items) {
    if (i.id === self.id) continue
    const hit = memCitations(i).some(c => (c.via === 'session' ? (c.ref === self.id || (self.kind === 'session' && self.session === c.ref))
      : c.via === 'memory' ? (survivorOf(c.ref) ?? c.ref) === self.id : c.ref === self.id))
    if (hit) citedBy.push(refOf(i))
  }

  const about = self.about.slice(0, lim.aboutEntities).map(name => {
    const key = name.trim().toLowerCase()
    const same = items.filter(i => i.id !== self.id && isLive(i, nowMs) && i.about.some(a => a.trim().toLowerCase() === key))
      .sort((a, b) => byWeight(a, b))
    return { name, total: same.length, others: same.slice(0, lim.aboutOthers).map(refOf) }
  })

  const supersedes = items.filter(i => i.supersededBy === self.id).sort(byWeight).slice(0, lim.supersedes).map(refOf)
  const successor = self.supersededBy !== undefined ? byId.get(self.supersededBy) : undefined
  const contradicts = memContradicted(self).slice(0, lim.contradicts).map(k => {
    const t = byId.get(k.id)
    return { ...(t !== undefined ? refOf(t) : { id: k.id }), why: k.why }
  })
  const contradictedBy = items.filter(i => i.id !== self.id && memContradicted(i).some(k => k.id === self.id)).sort(byWeight).slice(0, lim.contradicts).map(refOf)

  const out: MemRelations = {
    cites: cites.slice(0, lim.cites),
    citedBy: citedBy.slice(0, lim.citedBy),
    about, supersedes, contradicts, contradictedBy,
  }
  if (self.supersededBy !== undefined) out.supersededBy = successor !== undefined ? refOf(successor) : { id: self.supersededBy }
  return out
}

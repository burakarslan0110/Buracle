import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_DISAGREES_TAG, isLive, sourcePath, type MemItem, type MemKind, type UpkeepItem } from '../core/memory/brain'
import { memClip, memOneLine } from '../core/memory/text'
import { VERIFY_BY } from '../core/memory/verify'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { sameNameFiles } from './curate'
import { distinctFile } from './layout'
import { getStored, recordEvent, saveItem, type BrainRef } from './store'

export const CONTRADICTED_GRACE_DAYS = 7
export const MISSING_GRACE_DAYS = 7
export const CONTRADICTION_STRIKES = 2
export const CURATOR_STRIKES = 3
export const DUPLICATE_STRIKES = 3
const DAY = 86_400_000
const FACT_KINDS: readonly MemKind[] = ['gotcha', 'knowledge', 'procedure', 'reference']

export function contradictionStrikes(i: MemItem): number {
  return i.history.filter(h => h.by === VERIFY_BY && h.what.includes(': contradicted:')).length
}

export function contradictionSettled(i: MemItem, nowMs: number, curatorRuns = 0): boolean {
  if (i.contradictedAt === undefined || i.review !== 'pending' || !isLive(i, nowMs)) return false
  const age = nowMs - Date.parse(i.contradictedAt)
  return contradictionStrikes(i) >= CONTRADICTION_STRIKES || curatorRuns >= CURATOR_STRIKES || (Number.isFinite(age) && age >= CONTRADICTED_GRACE_DAYS * DAY)
}

export interface SettledContradictions { retired: string[], kept: string[] }

export async function settleContradictions(ref: BrainRef, items: readonly MemItem[], nowMs: number, focus: ReadonlyMap<string, readonly string[]> = new Map()): Promise<SettledContradictions> {
  const out: SettledContradictions = { retired: [], kept: [] }
  const at = new Date(nowMs).toISOString()
  const event = (op: 'update' | 'retire', i: MemItem): void => recordEvent({ op, layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), id: i.id, kind: i.kind, by: 'buracle' })
  for (const i of items) {
    const since = i.contradictedAt
    const curatorRuns = since === undefined ? 0 : (focus.get(i.id) ?? []).filter(t => t > since).length
    if (!contradictionSettled(i, nowMs, curatorRuns)) continue
    const cur = await getStored(ref, i.id)
    if (cur === undefined || cur.item.version !== i.version) continue
    const note = memClip(memOneLine(cur.item.contradictedNote ?? ''), 200)
    if (cur.item.pinned === true || !FACT_KINDS.includes(cur.item.kind)) {
      const section = `## The code disagrees (${at.slice(0, 10)})\n\n${note !== '' ? note : 'A background check found the claim contradicted by the code.'}`
      const n: MemItem = {
        ...cur.item, body: cur.item.body === '' ? section : `${cur.item.body}\n\n${section}`, tags: [...new Set([...cur.item.tags, CODE_DISAGREES_TAG])],
        review: 'pending', updated: at, version: cur.item.version + 1,
        history: [...cur.item.history, { at, by: 'buracle', what: memClip(`kept although the code disagrees: ${note}`, 200) }].slice(-8),
      }
      delete n.contradictedAt
      delete n.contradictedNote
      await saveItem(ref, n, cur.keep)
      event('update', n)
      out.kept.push(i.id)
    } else {
      const n: MemItem = {
        ...cur.item, status: 'deprecated', deprecatedAt: at, updated: at, version: cur.item.version + 1,
        history: [...cur.item.history, { at, by: 'buracle', what: memClip(`retired: the code contradicts it${note !== '' ? ` (${note})` : ''}`, 200) }].slice(-8),
      }
      await saveItem(ref, n, cur.keep)
      event('retire', n)
      out.retired.push(i.id)
    }
  }
  return out
}

export const CAPTURE_STRIKES = 3

export async function dropUnfiledCaptures(ref: BrainRef, items: readonly MemItem[], focus: ReadonlyMap<string, readonly string[]>, nowMs: number): Promise<string[]> {
  const out: string[] = []
  const at = new Date(nowMs).toISOString()
  for (const i of items) {
    if (i.kind !== 'capture' || i.pinned === true || !isLive(i, nowMs)) continue
    const runs = (focus.get(i.id) ?? []).filter(t => t > i.updated)
    if (runs.length < CAPTURE_STRIKES) continue
    const cur = await getStored(ref, i.id)
    if (cur === undefined || cur.item.version !== i.version) continue
    const n: MemItem = {
      ...cur.item, status: 'deprecated', deprecatedAt: at, updated: at, version: cur.item.version + 1,
      history: [...cur.item.history, { at, by: 'buracle', what: `dropped: ${runs.length} reflect runs left it unfiled` }].slice(-8),
    }
    await saveItem(ref, n, cur.keep)
    recordEvent({ op: 'retire', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), id: n.id, kind: n.kind, by: 'buracle' })
    out.push(i.id)
  }
  return out
}

interface DistinctState { v: 1, pairs: Record<string, string> }

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

function readDistinct(ref: BrainRef): DistinctState {
  const r = readJsonSafeSync<DistinctState>(distinctFile(ref.slug))
  return r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 1 && typeof r.value.pairs === 'object' && r.value.pairs !== null ? r.value : { v: 1, pairs: {} }
}

const MACHINE_AUTHORS: ReadonlySet<string> = new Set(['buracle', 'buracle-reflect', VERIFY_BY])

function changedAt(i: MemItem): string {
  let at = i.created
  for (const h of i.history) if (!MACHINE_AUTHORS.has(h.by) && h.at > at) at = h.at
  return at
}

export function distinctPairs(ref: BrainRef, items: readonly MemItem[]): Set<string> {
  const byId = new Map(items.map(i => [i.id, i]))
  const out = new Set<string>()
  for (const [pair, at] of Object.entries(readDistinct(ref).pairs)) {
    const [a, b] = pair.split('|').map(id => byId.get(id))
    if (a === undefined || b === undefined || changedAt(a) > at || changedAt(b) > at) continue
    out.add(pair)
  }
  return out
}

export function markDistinctDuplicates(ref: BrainRef, items: readonly MemItem[], upkeep: readonly UpkeepItem[], focus: ReadonlyMap<string, readonly string[]>, nowMs: number): string[] {
  const byId = new Map(items.map(i => [i.id, i]))
  const state = readDistinct(ref)
  const at = new Date(nowMs).toISOString()
  const marked: string[] = []
  for (const u of upkeep) {
    if (!u.reasons.includes('duplicate') || u.twin === undefined) continue
    const a = byId.get(u.id)
    const b = byId.get(u.twin)
    if (a === undefined || b === undefined || !isLive(a, nowMs) || !isLive(b, nowMs)) continue
    const since = changedAt(a) > changedAt(b) ? changedAt(a) : changedAt(b)
    const runs = new Set([...(focus.get(a.id) ?? []), ...(focus.get(b.id) ?? [])].filter(t => t > since))
    if (runs.size < DUPLICATE_STRIKES) continue
    const pair = pairKey(a.id, b.id)
    state.pairs[pair] = at
    marked.push(pair)
  }
  if (marked.length > 0) {
    for (const pair of Object.keys(state.pairs)) if (pair.split('|').some(id => !byId.has(id))) delete state.pairs[pair]
    try { atomicWriteSync(distinctFile(ref.slug), JSON.stringify(state) + '\n', { mode: 0o600 }) } catch (e) { log('warn', 'memory: the distinct pairs were not written', { slug: ref.slug, error: e }); return [] }
  }
  return marked
}

export interface DroppedSources { id: string, files: string[] }

export async function dropGoneSources(ref: BrainRef, items: readonly MemItem[], since: ReadonlyMap<string, string>, root: string, known: ReadonlySet<string>, nowMs: number): Promise<DroppedSources[]> {
  const out: DroppedSources[] = []
  const at = new Date(nowMs).toISOString()
  for (const i of items) {
    const s = since.get(i.id)
    if (s === undefined || !isLive(i, nowMs) || !(nowMs - Date.parse(s) >= MISSING_GRACE_DAYS * DAY)) continue
    const gone = i.sources.filter(src => {
      const p = sourcePath(src)
      return p !== undefined && !existsSync(join(root, p)) && sameNameFiles(p, known).length === 0
    })
    if (gone.length === 0) continue
    const cur = await getStored(ref, i.id)
    if (cur === undefined || cur.item.version !== i.version) continue
    const files = gone.map(g => sourcePath(g) as string)
    const n: MemItem = {
      ...cur.item, sources: cur.item.sources.filter(x => !gone.includes(x)), updated: at, version: cur.item.version + 1,
      history: [...cur.item.history, { at, by: 'buracle', what: memClip(`dropped cited files that are gone: ${files.join(', ')}`, 200) }].slice(-8),
    }
    if (n.review === 'ok') n.review = 'pending'
    await saveItem(ref, n, cur.keep)
    recordEvent({ op: 'update', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), id: n.id, kind: n.kind, by: 'buracle' })
    out.push({ id: i.id, files })
  }
  return out
}

import { fromCortex, type MemItem, type MemLayer } from '../core/memory/brain'
import { keepOf, plainRow, rowOwner, saveItem, storedId, type BrainRef } from './store'

/** A memory with the metadata a re-save carries over (recall counters, retirement). */
export interface Entry { item: MemItem, keep: Record<string, unknown> }

/** What a file or bucket held: its memories, oldest first, and how many rows were not Buracle's. */
export interface Entries { entries: Entry[], foreign: number }

function oldestFirst(a: Entry, b: Entry): number {
  return (a.item.created || a.item.updated).localeCompare(b.item.created || b.item.updated) || a.item.id.localeCompare(b.item.id)
}

/** The rows of a Buracle 0.5 file: ids are plain, and the whole file is one layer. */
export function entriesOfLegacyRows(rows: readonly unknown[], layer: MemLayer): Entries {
  const entries: Entry[] = []
  let foreign = 0
  for (const raw of rows) {
    const item = fromCortex(raw, layer)
    if (item === undefined) { foreign++; continue }
    entries.push({ item, keep: keepOf(raw) })
  }
  return { entries: entries.sort(oldestFirst), foreign }
}

/** The rows of one bucket in a brain.db file or a copy of it. */
export function entriesOfBucketRows(rows: readonly unknown[], ref: BrainRef): Entries {
  const entries: Entry[] = []
  let foreign = 0
  for (const raw of rows) {
    const owner = rowOwner(raw)
    if (owner === undefined) { foreign++; continue }
    if (owner.ref.layer !== ref.layer || owner.ref.slug !== ref.slug) continue
    const plain = plainRow(raw, ref)
    const item = fromCortex(plain, ref.layer)
    if (item === undefined) { foreign++; continue }
    entries.push({ item, keep: keepOf(plain) })
  }
  return { entries: entries.sort(oldestFirst), foreign }
}

export interface RowStamp { updated: string, version: number }

/** What a brain.db already holds, by stored id: so a re-run writes only what is missing or older. */
export function stampsOfRows(rows: readonly unknown[]): Map<string, RowStamp> {
  const out = new Map<string, RowStamp>()
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as { id?: unknown, metadata?: unknown }
    if (typeof r.id !== 'string' || r.metadata === null || typeof r.metadata !== 'object') continue
    const m = r.metadata as Record<string, unknown>
    out.set(r.id, { updated: typeof m['updated'] === 'string' ? m['updated'] : '', version: typeof m['version'] === 'number' ? m['version'] : 0 })
  }
  return out
}

/** The incoming memory replaces the stored one unless the stored one was changed later or is the same write. */
export function incomingWins(have: RowStamp | undefined, item: Pick<MemItem, 'updated' | 'version'>): boolean {
  if (have === undefined) return true
  const a = Date.parse(have.updated)
  const b = Date.parse(item.updated)
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b > a
  return item.version > have.version
}

export interface ImportOutcome { written: number, skipped: number }

/**
 * Saves memories into a bucket of brain.db the way every other write does (prefixed id, scope, namespace, graph,
 * native review state). `existing` makes it idempotent: a memory the file already holds, or holds in a later version,
 * is skipped, so a run that stopped half-way and runs again ends in the same state as one that did not stop.
 */
export async function importEntries(
  ref: BrainRef,
  entries: readonly Entry[],
  o: { nowMs: number, existing?: Map<string, RowStamp>, beforeWrite?: () => void },
): Promise<ImportOutcome> {
  let written = 0
  let skipped = 0
  for (const e of entries) {
    const sid = storedId(ref, e.item.id)
    if (!incomingWins(o.existing?.get(sid), e.item)) { skipped++; continue }
    o.beforeWrite?.()
    const expires = e.item.expires !== undefined ? Date.parse(e.item.expires) : Number.NaN
    // A date that has passed stays as data; only a future one becomes a time to live.
    await saveItem(ref, e.item, e.keep, { nowMs: o.nowMs, noTtl: Number.isFinite(expires) && expires <= o.nowMs })
    o.existing?.set(sid, { updated: e.item.updated, version: e.item.version })
    written++
  }
  return { written, skipped }
}

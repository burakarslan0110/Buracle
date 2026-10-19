import { isLive, type MemItem } from '../core/memory/brain'
import { linkedId, memoryLink } from '../core/memory/reflect'
import { memClip } from '../core/memory/text'
import { getStored, recordEvent, saveItem, type BrainRef } from './store'

export interface LinkFix { id: string, dropped: string[], repointed: Array<{ from: string, to: string }> }

const CHAIN_MAX = 5

async function rewrite(ref: BrainRef, i: MemItem, sources: string[], what: string, at: string, by: string): Promise<boolean> {
  const cur = await getStored(ref, i.id)
  if (cur === undefined || cur.item.version !== i.version) return false
  await saveItem(ref, { ...cur.item, sources, updated: at, version: cur.item.version + 1, history: [...cur.item.history, { at, by, what: memClip(what, 200) }].slice(-8) }, cur.keep)
  recordEvent({ op: 'update', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), id: i.id, kind: i.kind, by })
  return true
}

export async function repointMemoryLinks(ref: BrainRef, items: readonly MemItem[], from: string, to: string, at: string, by = 'buracle'): Promise<string[]> {
  const out: string[] = []
  if (from === to) return out
  for (const i of items) {
    if (i.id === to || !i.sources.some(s => linkedId(s) === from)) continue
    const sources = [...new Set(i.sources.map(s => linkedId(s) === from ? memoryLink(to) : s))]
    if (await rewrite(ref, i, sources, `link followed: ${from} is now ${to}`, at, by)) out.push(i.id)
  }
  return out
}

function survivorOf(id: string, byId: ReadonlyMap<string, MemItem>): string | undefined {
  let cur = id
  for (let n = 0; n < CHAIN_MAX; n++) {
    const m = byId.get(cur)
    if (m === undefined) return undefined
    if (m.status !== 'superseded' || m.supersededBy === undefined) return cur
    cur = m.supersededBy
  }
  return byId.has(cur) ? cur : undefined
}

export async function fixMemoryLinks(ref: BrainRef, items: readonly MemItem[], nowMs: number): Promise<LinkFix[]> {
  const at = new Date(nowMs).toISOString()
  const byId = new Map(items.map(i => [i.id, i]))
  const out: LinkFix[] = []
  for (const i of items) {
    if (!isLive(i, nowMs)) continue
    const fix: LinkFix = { id: i.id, dropped: [], repointed: [] }
    const sources: string[] = []
    for (const s of i.sources) {
      const to = linkedId(s)
      if (to === undefined) { sources.push(s); continue }
      const target = survivorOf(to, byId)
      if (target === undefined || target === i.id) { fix.dropped.push(to); continue }
      if (target !== to) fix.repointed.push({ from: to, to: target })
      sources.push(memoryLink(target))
    }
    if (fix.dropped.length === 0 && fix.repointed.length === 0) continue
    const what = [
      fix.dropped.length > 0 ? `links to gone memories dropped: ${fix.dropped.join(', ')}` : '',
      ...fix.repointed.map(r => `link followed: ${r.from} is now ${r.to}`),
    ].filter(x => x !== '').join('; ')
    if (await rewrite(ref, i, [...new Set(sources)], what, at, 'buracle')) out.push(fix)
  }
  return out
}

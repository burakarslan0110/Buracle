import { isLive, sourcePath, type MemItem, type MemKind } from '../core/memory/brain'
import { evidenceTargets } from '../core/memory/verify'
import { log } from '../engine/log'
import { git } from './evidence'
import { getStored, recordEvent, saveItem, type BrainRef } from './store'

export const SOURCES_PER_SWEEP = 20
export const SOURCES_MAX_FILES = 3
export const SOURCES_MAX_TERMS = 6
const TERM_TOO_COMMON = 20
const SOURCE_KINDS: readonly MemKind[] = ['decision', 'gotcha', 'procedure', 'knowledge', 'reference']

export function citesNoFile(i: MemItem): boolean {
  return !i.sources.some(s => sourcePath(s) !== undefined)
}

export function needsSources(i: MemItem, nowMs: number): boolean {
  return isLive(i, nowMs) && SOURCE_KINDS.includes(i.kind) && citesNoFile(i) && evidenceTargets(i).terms.length > 0
}

export function pickSourceFiles(hits: ReadonlyMap<string, readonly string[]>): string[] {
  const count = new Map<string, number>()
  for (const files of hits.values()) for (const f of new Set(files)) count.set(f, (count.get(f) ?? 0) + 1)
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const agreed = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).map(([f]) => f)
  if (agreed.length > 0) return agreed.slice(0, SOURCES_MAX_FILES)
  if (hits.size !== 1) return []
  const only = [...new Set([...hits.values()][0] ?? [])].sort(cmp)
  return only.length <= SOURCES_MAX_FILES ? only : []
}

export async function findSources(root: string, item: MemItem): Promise<string[]> {
  const hits = new Map<string, string[]>()
  for (const term of evidenceTargets(item).terms.slice(0, SOURCES_MAX_TERMS)) {
    const r = await git(root, ['grep', '-l', '-I', '-F', '--untracked', '-e', term, '--'])
    const files = r.out.split('\n').map(l => l.trim()).filter(Boolean)
    if (files.length === 0 || files.length > TERM_TOO_COMMON) continue
    hits.set(term, files)
  }
  return pickSourceFiles(hits)
}

export interface SourcedItem { id: string, files: string[] }

export async function discoverSources(ref: BrainRef, items: readonly MemItem[], root: string, nowMs: number): Promise<SourcedItem[]> {
  const out: SourcedItem[] = []
  const recency = (i: MemItem) => i.updated || i.created
  const todo = items.filter(i => needsSources(i, nowMs)).sort((a, b) => recency(b).localeCompare(recency(a)) || a.id.localeCompare(b.id)).slice(0, SOURCES_PER_SWEEP)
  const at = new Date(nowMs).toISOString()
  for (const i of todo) {
    let files: string[]
    try { files = await findSources(root, i) } catch (e) { log('warn', 'memory: git grep did not answer while finding sources', { id: i.id, error: e }); continue }
    if (files.length === 0) continue
    const cur = await getStored(ref, i.id)
    if (cur === undefined || cur.item.version !== i.version) continue
    await saveItem(ref, {
      ...cur.item, sources: [...cur.item.sources, ...files], updated: at, version: cur.item.version + 1,
      history: [...cur.item.history, { at, by: 'buracle', what: `sources found by name: ${files.join(', ')}` }].slice(-8),
    }, cur.keep)
    recordEvent({ op: 'update', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), id: i.id, kind: i.kind, by: 'buracle' })
    out.push({ id: i.id, files })
  }
  return out
}

export function pickCandidateSources(named: readonly string[], sessionFiles: readonly string[], text: string): string[] {
  const norm = (p: string) => p.trim().replace(/^\.\//, '')
  const touched: string[] = []
  for (const p of sessionFiles.map(norm)) if (p !== '' && !p.startsWith('/') && !p.startsWith('..') && !/^[A-Za-z]:[\\/]/.test(p) && !touched.includes(p)) touched.push(p)
  const out: string[] = []
  for (const p of named.map(norm)) if (touched.includes(p) && !out.includes(p)) out.push(p)
  if (out.length === 0) {
    for (const p of touched) {
      const base = p.slice(p.lastIndexOf('/') + 1)
      if (base.length >= 3 && text.includes(base) && !out.includes(p)) out.push(p)
    }
  }
  return out.slice(0, SOURCES_MAX_FILES)
}

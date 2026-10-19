import { isLive, searchTerms, SOURCE_LINES, sourcePath, type MemItem, type MemKind } from './brain'
import { memQueryWords } from './query'
import { memStemForms } from './stem'

export interface MemFilter {
  files?: readonly string[]
  tags?: readonly string[]
  about?: readonly string[]
  kinds?: readonly MemKind[]
  since?: number
  until?: number
  any?: boolean
}

function trimPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

export function memFilterPath(raw: string): string | undefined {
  const s = raw.trim()
  if (s === '' || s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return undefined
  const p = trimPath(s.replace(SOURCE_LINES, ''))
  if (p === '' || p === '.' || p.split('/').includes('..')) return undefined
  return p
}

function citedPaths(item: MemItem): string[] {
  const out: string[] = []
  for (const s of item.sources) {
    const p = sourcePath(s)
    if (p !== undefined) out.push(trimPath(p))
  }
  return out
}

export function memCitesFile(item: MemItem, files: readonly string[]): boolean {
  if (files.length === 0) return true
  const cited = citedPaths(item)
  return files.some(f => cited.some(c => c === f || c.startsWith(`${f}/`) || f.startsWith(`${c}/`)))
}

const fold = (s: string): string => s.trim().toLowerCase()

export function memMatchesFilter(item: MemItem, f: MemFilter, nowMs: number): boolean {
  if (f.any !== true && !isLive(item, nowMs)) return false
  if (f.kinds !== undefined && f.kinds.length > 0 && !f.kinds.includes(item.kind)) return false
  if (f.files !== undefined && !memCitesFile(item, f.files)) return false
  if (f.tags !== undefined && f.tags.length > 0) {
    const mine = new Set(item.tags.map(fold))
    if (!f.tags.some(t => mine.has(fold(t)))) return false
  }
  if (f.about !== undefined && f.about.length > 0) {
    const mine = new Set(item.about.map(fold))
    if (!f.about.some(a => mine.has(fold(a)))) return false
  }
  const at = Date.parse(item.updated || item.created)
  if (f.since !== undefined && !(at >= f.since)) return false
  if (f.until !== undefined && !(at <= f.until)) return false
  return true
}

export function memMatchesWords(item: MemItem, query: string): boolean {
  const words = memQueryWords(query)
  if (words.length === 0) return false
  const terms = new Set(searchTerms(`${item.title} ${item.summary} ${item.body} ${item.tags.join(' ')} ${item.about.join(' ')}`))
  return words.some(w => terms.has(w) || memStemForms(w).some(s => terms.has(s)))
}

export function memNewestFirst(a: MemItem, b: MemItem): number {
  return (b.updated || b.created).localeCompare(a.updated || a.created) || a.id.localeCompare(b.id)
}

function recordedOrder(a: MemItem, b: MemItem): number {
  return (a.created || a.updated).localeCompare(b.created || b.updated) || a.id.localeCompare(b.id)
}

export interface MemAround { before: MemItem[], anchor: MemItem, after: MemItem[] }

export function memAround(items: readonly MemItem[], anchor: MemItem, depth: number, keep: (i: MemItem) => boolean = () => true): MemAround {
  const n = Math.max(0, Math.floor(depth))
  const line = items.filter(i => i.layer === anchor.layer && i.id !== anchor.id && keep(i))
  const sorted = [...line, anchor].sort(recordedOrder)
  const at = sorted.findIndex(i => i.id === anchor.id)
  return { before: sorted.slice(Math.max(0, at - n), at), anchor, after: sorted.slice(at + 1, at + 1 + n) }
}

export interface MemPage<T> { rows: T[], from: number, to: number, total: number }

export function memPage<T>(rows: readonly T[], offset: number, limit: number): MemPage<T> {
  const start = Math.max(0, Math.min(Math.floor(offset), rows.length))
  const page = rows.slice(start, start + Math.max(0, Math.floor(limit)))
  return { rows: page, from: page.length === 0 ? start : start + 1, to: start + page.length, total: rows.length }
}

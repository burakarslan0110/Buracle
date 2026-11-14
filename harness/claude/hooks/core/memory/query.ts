import { memStem } from './stem'
import { normalizeForSearch } from './text'

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on',
  'or', 'the', 'to', 'was', 'we', 'what', 'when', 'why', 'with',
  've', 'ile', 'bir', 'bu', 'şu', 'su', 'da', 'de', 'mi', 'mı', 'mu', 'mü', 'ne', 'için', 'icin', 'gibi', 'ama', 'veya',
  'neden', 'nasil', 'nasıl', 'daha', 'çok', 'cok',
])

const SIMILARITY_STOPWORDS = new Set([
  'been', 'but', 'can', 'could', 'does', 'has', 'have', 'had', 'if', 'into', 'its', 'may', 'might', 'must', 'per',
  'should', 'so', 'such', 'than', 'that', 'then', 'these', 'this', 'those', 'use', 'uses', 'used', 'using', 'via',
  'were', 'will', 'would',
  'olarak', 'olan', 'ise', 'her', 'tum', 'en', 'kadar', 'artik',
])

export function memQueryWords(query: string): string[] {
  const words = normalizeForSearch(query).split(/[^\p{L}\p{N}_]+/u).filter(w => w !== '')
  const kept = words.filter(w => !STOPWORDS.has(w))
  const list = kept.length > 0 ? kept : words
  return [...new Set(list)].slice(0, 16)
}

export function memTitleWords(title: string): Set<string> {
  const words = normalizeForSearch(title).split(/[^\p{L}\p{N}_]+/u).filter(w => w.length >= 2 && !STOPWORDS.has(w) && !SIMILARITY_STOPWORDS.has(w))
  return new Set(words.map(memStem))
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  return s.length >= 4 && l.startsWith(s)
}

function softJaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const free = new Set(b)
  let inter = 0
  for (const w of a) {
    let match = free.has(w) ? w : undefined
    if (match === undefined) for (const k of free) if (sameWord(w, k)) { match = k; break }
    if (match === undefined) continue
    free.delete(match)
    inter++
  }
  const union = a.size + b.size - inter
  return union > 0 ? inter / union : 0
}

const flat = (text: string): string => normalizeForSearch(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

export function memTitleSimilarity(a: string, b: string): number {
  return memPreparedSimilarity(memTitlePrep(a), memTitlePrep(b))
}

export interface MemTitlePrep { flat: string, words: ReadonlySet<string> }

export function memTitlePrep(text: string): MemTitlePrep {
  return { flat: flat(text), words: memTitleWords(text) }
}

export function memPreparedSimilarity(a: MemTitlePrep, b: MemTitlePrep): number {
  if (a.flat !== '' && a.flat === b.flat) return 1
  if (a.words.size === 0 || b.words.size === 0) return 0
  return softJaccard(a.words, b.words)
}

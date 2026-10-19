import { memStem, memStemForms } from './stem'
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

function quote(w: string): string {
  return `"${w.replace(/"/g, '""')}"`
}

function wordAlternatives(w: string, mode: 'and' | 'or'): string[] {
  const stems = memStemForms(w)
  const alts = [w.length >= 4 ? `${quote(w)}*` : quote(w), ...stems.map(s => `${quote(s)}*`)]
  const cut = w.slice(0, 5)
  if (mode === 'or' && w.length >= 7 && !stems.some(s => cut.startsWith(s))) alts.push(`${quote(cut)}*`)
  return alts
}

export function memFtsQuery(query: string, mode: 'and' | 'or'): string | undefined {
  const words = memQueryWords(query)
  if (words.length === 0) return undefined
  const terms = words.map(w => wordAlternatives(w, mode))
  if (mode === 'or' || terms.length === 1) return terms.flat().join(' OR ')
  return terms.map(alts => (alts.length === 1 ? alts[0] as string : `(${alts.join(' OR ')})`)).join(' AND ')
}

export function memTrigramQuery(query: string): string | undefined {
  const words = memQueryWords(query).filter(w => w.length >= 3)
  if (words.length === 0) return undefined
  return words.map(quote).join(' OR ')
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

export interface MemSimilarNote { title: string, description?: string | null }

export function memNoteSimilarity(a: MemSimilarNote, b: MemSimilarNote): number {
  const title = memTitleSimilarity(a.title, b.title)
  const da = a.description ?? ''
  const db = b.description ?? ''
  const meaningful = (s: string): boolean => s.split(/\s+/).filter(w => w.length > 1).length >= 3
  if (title === 1 || !meaningful(da) || !meaningful(db)) return title
  return Math.max(title, (title + memTitleSimilarity(da, db)) / 2)
}

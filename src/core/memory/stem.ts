export const MEM_MIN_STEM = 3

const VOWELS = /[aeiou]/
const LAST_VOWEL = /[aeiou](?=[^aeiou]*$)/
const VOICELESS = 'pctkfhs'

type Need = 'V' | 'C' | ''

const CASE = 3
const POSSESSIVE = 2
const PLURAL = 1

const TR_LIST: Array<[string, Need, number]> = [
  ['ndaki', 'V', CASE], ['ndeki', 'V', CASE], ['daki', '', CASE], ['deki', '', CASE], ['taki', '', CASE], ['teki', '', CASE],
  ['ndan', 'V', CASE], ['nden', 'V', CASE], ['dan', '', CASE], ['den', '', CASE], ['tan', '', CASE], ['ten', '', CASE],
  ['nda', 'V', CASE], ['nde', 'V', CASE], ['da', '', CASE], ['de', '', CASE], ['ta', '', CASE], ['te', '', CASE],
  ['nin', 'V', CASE], ['nun', 'V', CASE], ['in', 'C', CASE], ['un', 'C', CASE],
  ['yla', 'V', CASE], ['yle', 'V', CASE], ['la', 'C', CASE], ['le', 'C', CASE],
  ['na', 'V', CASE], ['ne', 'V', CASE], ['ya', 'V', CASE], ['ye', 'V', CASE],
  ['ni', 'V', CASE], ['nu', 'V', CASE], ['yi', 'V', CASE], ['yu', 'V', CASE],
  ['si', 'V', POSSESSIVE], ['su', 'V', POSSESSIVE], ['i', 'C', POSSESSIVE], ['u', 'C', POSSESSIVE],
  ['lar', '', PLURAL], ['ler', '', PLURAL],
]
const TR_SUFFIXES: ReadonlyArray<readonly [string, Need, number]> = [...TR_LIST].sort((a, b) => b[0].length - a[0].length)

const isVowel = (c: string | undefined): boolean => c !== undefined && VOWELS.test(c)

function harmonizes(stem: string, suffix: string): boolean {
  const last = LAST_VOWEL.exec(stem)?.[0]
  const own = /[aeiou]/.exec(suffix)?.[0]
  if (last === undefined) return false
  if (own === undefined) return true
  if (own === 'a') return last !== 'e'
  if (own === 'e') return last !== 'a'
  if (own === 'i') return last === 'a' || last === 'e' || last === 'i'
  return last === 'o' || last === 'u'
}

function stemOk(stem: string): boolean {
  return stem.length >= MEM_MIN_STEM && VOWELS.test(stem)
}

function stripTurkish(w: string, below: number): { stem: string, suffix: string, slot: number } | undefined {
  for (const [suffix, need, slot] of TR_SUFFIXES) {
    if (slot >= below || !w.endsWith(suffix)) continue
    const stem = w.slice(0, w.length - suffix.length)
    if (!stemOk(stem)) continue
    const end = stem[stem.length - 1]
    if (need === 'V' && !isVowel(end)) continue
    if (need === 'C' && isVowel(end)) continue
    if (suffix.startsWith('t') && !VOICELESS.includes(end ?? '')) continue
    if (suffix.startsWith('d') && 'ptkfhs'.includes(end ?? '')) continue
    if (!harmonizes(stem, suffix)) continue
    return { stem, suffix, slot }
  }
  return undefined
}

function undouble(stem: string): string {
  return /([bdgkmnprt])\1$/.test(stem) ? stem.slice(0, -1) : stem
}

function stripEnglish(w: string): string | undefined {
  const cut = (n: number): string | undefined => { const s = w.slice(0, w.length - n); return stemOk(s) ? s : undefined }
  if (w.endsWith('ies')) return cut(3)
  if (w.endsWith('sses')) return cut(2)
  if (/(?:x|ch|sh|z)es$/.test(w)) return cut(2)
  if (/[^siu]s$/.test(w)) return cut(1)
  if (w.endsWith('ing')) { const s = cut(3); return s !== undefined ? undouble(s) : undefined }
  if (w.endsWith('ed') && !w.endsWith('eed')) { const s = cut(2); return s !== undefined ? undouble(s) : undefined }
  return undefined
}

export function memStem(word: string): string {
  return memStemForms(word)[0] ?? word
}

export function memStemForms(word: string): string[] {
  if (word.length < MEM_MIN_STEM + 1 || !/^[a-z]+$/.test(word)) return []
  const en = stripEnglish(word)
  if (en !== undefined) return en === word ? [] : [en]
  let stem = word
  let last = ''
  let below = CASE + 1
  for (;;) {
    const step = stripTurkish(stem, below)
    if (!step) break
    stem = step.stem
    last = step.suffix
    below = step.slot
  }
  if (stem === word) return []
  const out = [stem]
  if (isVowel(last[0]) && stem.length >= 4) {
    const end = stem[stem.length - 1] ?? ''
    const before = stem[stem.length - 2] ?? ''
    const hard: Record<string, string> = { b: 'p', g: 'k', d: 't' }
    const h = hard[end]
    if (h !== undefined && (isVowel(before) || (end === 'g' && before === 'n') || (end === 'd' && before === 'r'))) out.push(stem.slice(0, -1) + h)
  }
  return out
}

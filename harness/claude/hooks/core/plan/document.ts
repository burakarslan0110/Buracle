// The document check of a plan, a build file or a PRD: every document under docs/ is English and
// follows the structural rules of ASD-STE100 (PRD 2026-11-04). It reads the prose units of the
// Markdown (paragraphs, list items, table cells) and reports, as warnings with their line:
//   not-english    a paragraph that reads as Turkish
//   long-sentence  a sentence over MAX_SENTENCE_WORDS words
//   semicolon      a semicolon in prose
//   legacy-folder  a path under an old document folder
// Fenced code, headings, HTML comments (also over several lines), `Verify:` lines, link targets and
// the sections a run writes (Evidence, Deviations, …) are skipped. Code spans count as one word and
// never hold a finding, except a legacy folder path, which plans write in backticks. Blockquote
// markers are not words.
import { AFTER_RUN, type PlanOutline } from './authoring'
import { DOC_DIRS, LEGACY_DOC_DIRS } from './doc-dirs'
import type { Finding } from './format'
import { languageHits } from '../memory/signals'

export const DOCUMENT_CODES = ['not-english', 'long-sentence', 'semicolon', 'legacy-folder'] as const
export const MAX_SENTENCE_WORDS = 25

const HEADING = /^\s{0,3}#{1,6}\s/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/
const BLOCKQUOTE = /^\s*(?:>\s?)+/
const CONTINUATION = /^\s{2,}\S/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/
const VERIFY_LINE = /^\s*[-*+]\s+\**Verify:/
const CODE_SPAN = /`[^`]*`/g
const LINK = /\[([^\]]*)\]\([^)]*\)/g
// A link target stops before a closing bracket or quote, so `(https://…/x.md).` keeps its sentence end.
const URL = /https?:\/\/[^\s)\]>"']+/g
const LABEL = /^\*\*[^*]+:\*\*\s*/
const EMPHASIS = /\*\*|__|(?<![\w`])[*_](?=\S)|(?<=\S)[*_](?![\w`])/g
const SENTENCE_END = /(?<=[.!?])\s+/
const LEGACY_PATH = new RegExp(`docs/(${LEGACY_DOC_DIRS.join('|')})/`)

interface Unit { first: number, lines: readonly string[], cell: boolean }

function at(line: number, code: string, message: string): Finding {
  return { level: 'warning', code, message, line: line + 1 }
}

function skippedLines(o: PlanOutline): Set<number> {
  const skip = new Set<number>()
  for (const s of o.sections) if (AFTER_RUN.has(s.text.trim().toLowerCase())) for (let i = s.line; i < s.end; i++) skip.add(i)
  return skip
}

// Paragraphs, list items (with their indented continuation lines) and table cells, in order.
function units(o: PlanOutline): Unit[] {
  const out: Unit[] = []
  const skip = skippedLines(o)
  let current: { first: number, lines: string[] } | undefined
  let inComment = false
  const flush = () => { if (current !== undefined) { out.push({ ...current, cell: false }); current = undefined } }
  for (let i = o.body; i < o.lines.length; i++) {
    const line = o.lines[i] ?? ''
    if (inComment) { flush(); if (line.includes('-->')) inComment = false; continue }
    if (o.code[i] === true || skip.has(i)) { flush(); continue }
    // A comment marker inside a code span is text, so it never opens a comment that would hide the rest of the file.
    const bare = line.replace(CODE_SPAN, '')
    if (bare.includes('<!--')) { flush(); inComment = bare.lastIndexOf('<!--') > bare.lastIndexOf('-->'); continue }
    if (line.trim() === '' || HEADING.test(line) || VERIFY_LINE.test(line) || TABLE_RULE.test(line)) { flush(); continue }
    if (TABLE_ROW.test(line)) {
      flush()
      for (const cell of line.trim().replace(/^\||\|$/g, '').split('|')) if (cell.trim() !== '') out.push({ first: i, lines: [cell.trim()], cell: true })
      continue
    }
    if (LIST_ITEM.test(line)) { flush(); current = { first: i, lines: [line] }; continue }
    if (current !== undefined && CONTINUATION.test(line) && LIST_ITEM.test(current.lines[0] ?? '')) { current.lines.push(line); continue }
    if (current === undefined) current = { first: i, lines: [line] }
    else current.lines.push(line)
  }
  flush()
  return out
}

// The words of a unit: markers and labels gone, each code span and link target one word.
function plain(u: Unit): string {
  return u.lines
    .map(l => l.replace(BLOCKQUOTE, '').replace(LIST_ITEM, '').replace(LABEL, ''))
    .join(' ')
    .replace(CODE_SPAN, 'code')
    .replace(LINK, '$1')
    .replace(URL, 'url')
    .replace(EMPHASIS, '')
    .trim()
}

function words(sentence: string): number {
  return sentence.split(/\s+/).filter(w => w !== '').length
}

// Stronger evidence than the prompt-language signal, which calls "Retry once per key." Turkish on the
// one word `once`: a letter only Turkish uses with no English majority, or two Turkish function words
// with a margin of two over the English ones.
function readsAsTurkish(text: string): boolean {
  const h = languageHits(text)
  if (h.words < 3) return false
  if (h.letters) return h.tr >= h.en
  return h.tr >= 2 && h.tr - h.en >= 2
}

function legacyMessage(path: string): string {
  const legacy = LEGACY_PATH.exec(path)?.[1]
  const fresh = DOC_DIRS.find(d => d.legacy === legacy)?.dir ?? 'plan-build'
  return `\`docs/${legacy}/\` is an old document folder, new documents go to \`docs/${fresh}/\``
}

export function documentFindings(o: PlanOutline): Finding[] {
  const out: Finding[] = []
  for (const u of units(o)) {
    for (const [k, raw] of u.lines.entries()) {
      if (LEGACY_PATH.test(raw)) { out.push(at(u.first + k, 'legacy-folder', legacyMessage(raw))); break }
    }
    const text = plain(u)
    if (text === '') continue
    const semi = u.lines.findIndex(l => l.replace(CODE_SPAN, '').includes(';'))
    if (semi >= 0) out.push(at(u.first + semi, 'semicolon', 'a semicolon joins two statements: write two sentences or a list'))
    if (readsAsTurkish(text)) out.push(at(u.first, 'not-english', 'this paragraph reads as Turkish: a document under docs is English'))
    for (const sentence of u.cell ? [text] : text.split(SENTENCE_END)) {
      const n = words(sentence)
      if (n > MAX_SENTENCE_WORDS) out.push(at(u.first, 'long-sentence', `a sentence has ${n} words (the limit is ${MAX_SENTENCE_WORDS}): split it, one idea per sentence`))
    }
  }
  return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
}

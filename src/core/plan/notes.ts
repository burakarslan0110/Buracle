export type ReviewNoteKind = 'plan' | 'code'
export type ReviewSide = 'old' | 'new'

export interface ReviewNote {
  id: string
  kind: ReviewNoteKind
  text: string
  quote: string
  at: string
  line?: number
  file?: string
  side?: ReviewSide
  start?: number
  end?: number
  edited?: string
  done?: string
}

export interface ReviewNotesFile {
  v: 1
  root: string
  doc?: string
  branch?: string
  notes: ReviewNote[]
}

export interface NoteInput {
  kind: ReviewNoteKind
  text: string
  quote: string
  line?: number
  file?: string
  side?: ReviewSide
  start?: number
  end?: number
}

export const REVIEW_DOC_DIRS = ['plans', 'builds', 'prd'] as const
export type ReviewDocDir = typeof REVIEW_DOC_DIRS[number]

export const NOTE_TEXT_MAX = 4000
export const NOTE_QUOTE_MAX = 1200
export const NOTE_PATH_MAX = 1024
export const NOTE_RANGE_MAX = 2000
export const NOTES_OPEN_MAX = 200
export const NOTES_DONE_KEEP = 100
export const NOTE_ID_RE = /^n-[0-9a-f]{8}$/
export const NOTES_INBOX_MAX = 60

export function reviewDocOf(rel: string): { dir: ReviewDocDir, name: string } | undefined {
  const m = /^docs\/(plans|builds|prd)\/([^/]+\.md)$/u.exec(rel.replace(/\\/g, '/'))
  if (m === null) return undefined
  const name = m[2] as string
  if (name.startsWith('.')) return undefined
  return { dir: m[1] as ReviewDocDir, name }
}

function fnv1a(s: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

function keyPart(s: string): string {
  const k = s.replace(/[^A-Za-z0-9._~-]+/g, '-').replace(/^[.~-]+/, '').slice(0, 120)
  if (k === s) return k
  return `${k === '' ? 'x' : k}-${fnv1a(s, 0x811c9dc5)}${fnv1a(s, 0x050c5d1f)}`
}

export function docNotesKey(rel: string): string | undefined {
  const d = reviewDocOf(rel)
  return d === undefined ? undefined : `${d.dir}--${keyPart(d.name)}`
}

export function changesNotesKey(branch: string | undefined): string {
  return `changes--${branch === undefined || branch === '' ? '~detached' : keyPart(branch.replace(/\//g, '~'))}`
}

export function emptyNotesFile(root: string, extra: { doc?: string, branch?: string } = {}): ReviewNotesFile {
  return { v: 1, root, ...(extra.doc !== undefined ? { doc: extra.doc } : {}), ...(extra.branch !== undefined ? { branch: extra.branch } : {}), notes: [] }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function posInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 10_000_000
}

export function isReviewNote(x: unknown): x is ReviewNote {
  if (!isObj(x)) return false
  if (typeof x['id'] !== 'string' || !NOTE_ID_RE.test(x['id'])) return false
  if (x['kind'] !== 'plan' && x['kind'] !== 'code') return false
  if (typeof x['text'] !== 'string' || typeof x['quote'] !== 'string' || typeof x['at'] !== 'string') return false
  if (x['kind'] === 'code' && (typeof x['file'] !== 'string' || !posInt(x['start']))) return false
  return true
}

export function isReviewNotesFile(x: unknown): x is ReviewNotesFile {
  return isObj(x) && x['v'] === 1 && typeof x['root'] === 'string' && Array.isArray(x['notes'])
}

export function cleanNotesFile(x: ReviewNotesFile): ReviewNotesFile {
  return { ...x, notes: x.notes.filter(isReviewNote) }
}

function safeRelPath(p: string): boolean {
  if (p === '' || p.length > NOTE_PATH_MAX || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\0')) return false
  return !p.replace(/\\/g, '/').split('/').some(s => s === '..' || s === '')
}

function oneLine(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

export function parseNoteInput(raw: Readonly<Record<string, unknown>>): NoteInput | string {
  const kind = raw['kind']
  if (kind !== 'plan' && kind !== 'code') return 'kind must be plan or code'
  const text = typeof raw['text'] === 'string' ? oneLine(raw['text']).trim() : ''
  if (text === '') return 'the note is empty'
  if (text.length > NOTE_TEXT_MAX) return `the note is longer than ${NOTE_TEXT_MAX} characters`
  const quoteRaw = raw['quote'] === undefined ? '' : raw['quote']
  if (typeof quoteRaw !== 'string') return 'quote must be text'
  const quote = oneLine(quoteRaw).trim().slice(0, NOTE_QUOTE_MAX)
  if (kind === 'plan') {
    if (quote === '') return 'a plan note needs the passage it is about'
    const line = raw['line']
    if (line !== undefined && !posInt(line)) return 'line must be a positive whole number'
    return { kind, text, quote, ...(line !== undefined ? { line: line as number } : {}) }
  }
  const file = raw['file']
  if (typeof file !== 'string' || !safeRelPath(file)) return 'file must be a path inside the repository'
  const side = raw['side'] ?? 'new'
  if (side !== 'old' && side !== 'new') return 'side must be old or new'
  const start = raw['start']
  if (!posInt(start)) return 'start must be a positive whole number'
  const end = raw['end'] ?? start
  if (!posInt(end) || end < start) return 'end must be a whole number not below start'
  if (end - start > NOTE_RANGE_MAX) return `a code note covers at most ${NOTE_RANGE_MAX} lines`
  return { kind, text, quote, file: file.replace(/\\/g, '/'), side, start, end }
}

export function openNotes(f: ReviewNotesFile): ReviewNote[] {
  return f.notes.filter(n => n.done === undefined)
}

function trimDone(notes: readonly ReviewNote[]): ReviewNote[] {
  const done = notes.filter(n => n.done !== undefined).sort((a, b) => (b.done ?? '').localeCompare(a.done ?? '')).slice(0, NOTES_DONE_KEEP)
  const keep = new Set(done.map(n => n.id))
  return notes.filter(n => n.done === undefined || keep.has(n.id))
}

export function withNote(f: ReviewNotesFile, input: NoteInput, id: string, at: string): ReviewNotesFile | string {
  if (!NOTE_ID_RE.test(id)) return 'bad note id'
  if (openNotes(f).length >= NOTES_OPEN_MAX) return `this file already holds ${NOTES_OPEN_MAX} open notes; let the agent apply some first`
  if (f.notes.some(n => n.id === id)) return 'a note with this id exists'
  const note: ReviewNote = { id, ...input, at }
  return { ...f, notes: trimDone([...f.notes, note]) }
}

export function editNote(f: ReviewNotesFile, id: string, text: string, at: string): { file: ReviewNotesFile, found: boolean, problem?: string } {
  const clean = oneLine(text).trim()
  if (clean === '') return { file: f, found: false, problem: 'the note is empty' }
  if (clean.length > NOTE_TEXT_MAX) return { file: f, found: false, problem: `the note is longer than ${NOTE_TEXT_MAX} characters` }
  let found = false
  const notes = f.notes.map(n => {
    if (n.id !== id || n.done !== undefined) return n
    found = true
    return { ...n, text: clean, edited: at }
  })
  return { file: found ? { ...f, notes } : f, found }
}

export function dropNote(f: ReviewNotesFile, id: string): { file: ReviewNotesFile, found: boolean } {
  const notes = f.notes.filter(n => n.id !== id)
  return { file: notes.length === f.notes.length ? f : { ...f, notes }, found: notes.length !== f.notes.length }
}

export function markNotesDone(f: ReviewNotesFile, ids: readonly string[], at: string): { file: ReviewNotesFile, done: string[] } {
  const want = new Set(ids)
  const done: string[] = []
  const notes = f.notes.map(n => {
    if (!want.has(n.id) || n.done !== undefined) return n
    done.push(n.id)
    return { ...n, done: at }
  })
  return { file: done.length === 0 ? f : { ...f, notes: trimDone(notes) }, done }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

export function noteWhere(n: ReviewNote): string {
  if (n.kind === 'plan') return n.line !== undefined ? `line ${n.line}` : 'the document'
  const end = n.end !== undefined && n.end > (n.start ?? 0) ? `-${n.end}` : ''
  return `${n.file ?? '?'}:${n.start ?? '?'}${end}${n.side === 'old' ? ' (removed lines)' : ''}`
}

export function noteLines(n: ReviewNote): string[] {
  const head = `[${n.id}] ${n.kind} note at ${noteWhere(n)}${n.quote !== '' ? `: "${clip(n.quote, 160)}"` : ''}`
  return [head, ...n.text.split('\n').map(l => `    ${l}`)]
}

export interface NotesInboxEntry {
  at: number
  root: string
  key: string
  open: number
  doc?: string
  rel?: string
  checkout?: string
  branch?: string
}

export function isInboxEntry(x: unknown): x is NotesInboxEntry {
  return isObj(x) && typeof x['at'] === 'number' && typeof x['root'] === 'string' && typeof x['key'] === 'string' && typeof x['open'] === 'number'
}

export function inboxWith(entries: readonly NotesInboxEntry[], e: NotesInboxEntry, bump: boolean): NotesInboxEntry[] {
  const prev = entries.find(x => x.root === e.root && x.key === e.key)
  if (prev === undefined && !bump) return [...entries]
  const next: NotesInboxEntry = { ...e, at: bump || prev === undefined ? e.at : prev.at }
  const rest = entries.filter(x => x !== prev)
  return [...rest, next].sort((a, b) => a.at - b.at).slice(-NOTES_INBOX_MAX)
}

export interface NoticeSession { plan?: string, roots: readonly string[] }

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function within(child: string, parent: string): boolean {
  const c = norm(child)
  const p = norm(parent)
  return c === p || (p !== '' && c.startsWith(`${p}/`))
}

export function inboxFor(entries: readonly NotesInboxEntry[], s: NoticeSession, since: number): NotesInboxEntry[] {
  const roots = s.roots.filter(r => r !== '')
  return entries.filter(e => {
    if (e.at <= since || e.open <= 0) return false
    if (e.doc !== undefined) {
      if (s.plan !== undefined) return norm(e.doc) === norm(s.plan)
      return reviewDocOf(e.rel ?? '')?.dir === 'prd' && roots.some(r => within(r, e.root))
    }
    if (s.plan !== undefined) return roots.some(r => within(r, e.root) || (e.checkout !== undefined && within(r, e.checkout)))
    return e.checkout !== undefined && roots.some(r => within(r, e.checkout as string))
  })
}

function singleLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ')
}

function cliPath(path: string): string {
  const flat = singleLine(path)
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(flat) ? flat : `'${flat.replace(/'/g, `'\\''`)}'`
}

export function notesNoticeText(matches: readonly NotesInboxEntry[], s: NoticeSession): string | undefined {
  if (matches.length === 0) return undefined
  const n = matches.reduce((a, e) => a + e.open, 0)
  const where = matches.slice(-3).map(e => (e.doc !== undefined ? singleLine(e.rel ?? e.doc) : `the changes on ${singleLine(e.branch ?? 'this checkout')}`))
  const cmds = new Set<string>()
  const marks = new Set<string>()
  for (const e of matches) {
    if (e.doc === undefined) {
      cmds.add('buracle plan notes --kind code --json')
      marks.add('buracle plan notes --done <id>')
    } else if (s.plan !== undefined && norm(e.doc) === norm(s.plan)) {
      cmds.add('buracle plan notes --json')
      marks.add('buracle plan notes --done <id>')
    } else {
      cmds.add(`buracle plan notes ${cliPath(e.rel ?? e.doc)} --json`)
      marks.add(`buracle plan notes ${cliPath(e.rel ?? e.doc)} --done <id>`)
    }
  }
  const quoted = (xs: Set<string>, sep: string) => [...xs].map(c => `\`${c}\``).join(sep)
  return `Buracle: the user left ${n} open ${n === 1 ? 'note' : 'notes'} in the review page on ${where.join('; ')}. Before you go on, read them with ${quoted(cmds, ' and ')}, apply each one (or say why not), and mark each applied note with ${quoted(marks, ' or ')}.`
}

export function brainPageArg(args: string): 'brain' | 'review' | undefined {
  const w = args.trim().toLowerCase()
  if (w === '') return 'brain'
  return ['review', 'plans', 'changes', 'notes'].includes(w) ? 'review' : undefined
}

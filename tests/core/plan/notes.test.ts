import { describe, expect, test } from 'bun:test'
import {
  brainPageArg, changesNotesKey, docNotesKey, dropNote, editNote, emptyNotesFile, inboxFor, inboxWith, markNotesDone, NOTES_DONE_KEEP,
  notesNoticeText, openNotes, parseNoteInput, reviewDocOf, withNote, type NotesInboxEntry, type ReviewNotesFile,
} from '../../../src/core/plan/notes'

const AT = '2026-10-18T10:00:00.000Z'

function filled(): ReviewNotesFile {
  const f = withNote(emptyNotesFile('/r', { doc: 'docs/plans/p.md' }), { kind: 'plan', text: 'Say which client', quote: 'A single client' }, 'n-00000001', AT)
  if (typeof f === 'string') throw new Error(f)
  return f
}

describe('which files take notes', () => {
  test('only Markdown files directly under docs/plans, docs/builds and docs/prd', () => {
    expect(reviewDocOf('docs/plans/2026-10-18-x.md')).toEqual({ dir: 'plans', name: '2026-10-18-x.md' })
    expect(reviewDocOf('docs/prd/a.md')?.dir).toBe('prd')
    expect(reviewDocOf('docs\\builds\\b.md')?.dir).toBe('builds')
    for (const bad of ['docs/plans/sub/x.md', 'docs/plans/x.txt', 'src/x.md', 'docs/plans/.annotations.md', '../docs/plans/x.md', 'docs/notes/x.md']) expect(reviewDocOf(bad)).toBeUndefined()
  })

  test('a doc and a branch get distinct, file-safe keys', () => {
    expect(docNotesKey('docs/plans/2026-10-18-x.md')).toBe('plans--2026-10-18-x.md')
    expect(docNotesKey('src/x.md')).toBeUndefined()
    expect(changesNotesKey('plan-build/rate-limit')).toBe('changes--plan-build~rate-limit')
    expect(changesNotesKey('plan-build-rate-limit')).not.toBe(changesNotesKey('plan-build/rate-limit'))
    expect(changesNotesKey(undefined)).toBe('changes--~detached')
    expect(changesNotesKey('detached')).not.toBe(changesNotesKey(undefined))
    expect(changesNotesKey('../../etc')).toMatch(/^changes--[A-Za-z0-9._~-]+$/)
  })

  test('two names never share a notes file, also when the key had to change characters', () => {
    const keys = [
      docNotesKey('docs/prd/my plan.md'), docNotesKey('docs/prd/my-plan.md'), docNotesKey('docs/prd/my_plan.md'),
      docNotesKey('docs/prd/çalışma planı.md'), docNotesKey('docs/prd/şalışma planı.md'),
      docNotesKey(`docs/plans/${'a'.repeat(130)}.md`), docNotesKey(`docs/plans/${'a'.repeat(131)}.md`),
      docNotesKey('docs/plans/-x.md'), docNotesKey('docs/plans/x.md'),
      changesNotesKey('feature/my branch'), changesNotesKey('feature/my-branch'), changesNotesKey('feature/my?branch'),
    ]
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^[a-z]+--[A-Za-z0-9._~-]{1,160}$/)
    expect(docNotesKey('docs/prd/my-plan.md')).toBe('prd--my-plan.md')
    expect(docNotesKey('docs/prd/my plan.md')).toMatch(/^prd--my-plan\.md-[0-9a-f]{16}$/)
    expect(docNotesKey('docs/prd/my plan.md')).toBe(docNotesKey('docs/prd/my plan.md'))
  })
})

describe('a note from the page', () => {
  test('a plan note needs its passage and text; a code note needs a safe path and a line range', () => {
    expect(parseNoteInput({ kind: 'plan', text: '  fix this  ', quote: 'the passage', line: 4 })).toEqual({ kind: 'plan', text: 'fix this', quote: 'the passage', line: 4 })
    expect(parseNoteInput({ kind: 'plan', text: 'x', quote: '' })).toBe('a plan note needs the passage it is about')
    expect(parseNoteInput({ kind: 'plan', text: '   ', quote: 'q' })).toBe('the note is empty')
    expect(parseNoteInput({ kind: 'plan', text: 'x'.repeat(4001), quote: 'q' })).toMatch(/longer than 4000/)
    expect(parseNoteInput({ kind: 'plan', text: 'x', quote: 'q', line: 0 })).toMatch(/line must be/)
    expect(parseNoteInput({ kind: 'code', text: 'x', file: 'src/a.ts', start: 3 })).toEqual({ kind: 'code', text: 'x', quote: '', file: 'src/a.ts', side: 'new', start: 3, end: 3 })
    expect(parseNoteInput({ kind: 'code', text: 'x', file: 'src/a.ts', side: 'old', start: 3, end: 5, quote: 'a\r\nb' })).toEqual({ kind: 'code', text: 'x', quote: 'a\nb', file: 'src/a.ts', side: 'old', start: 3, end: 5 })
    for (const file of ['/etc/passwd', '../x', 'a/../b', 'C:/x', '', 'a//b']) expect(parseNoteInput({ kind: 'code', text: 'x', file, start: 1 })).toMatch(/inside the repository/)
    expect(parseNoteInput({ kind: 'code', text: 'x', file: 'a', start: 5, end: 4 })).toMatch(/not below start/)
    expect(parseNoteInput({ kind: 'code', text: 'x', file: 'a', start: 1, side: 'left' })).toMatch(/side must be/)
    expect(parseNoteInput({ kind: 'other', text: 'x' })).toMatch(/kind must be/)
  })

  test('edit and delete act on open notes; done marks keep the note as applied', () => {
    const f = filled()
    expect(openNotes(f).map(n => n.id)).toEqual(['n-00000001'])
    const e = editNote(f, 'n-00000001', 'Name the ticket', '2026-10-18T10:05:00.000Z')
    expect(e.found).toBe(true)
    expect(e.file.notes[0]).toMatchObject({ text: 'Name the ticket', edited: '2026-10-18T10:05:00.000Z' })
    expect(editNote(f, 'n-00000009', 'x', AT).found).toBe(false)
    const d = markNotesDone(e.file, ['n-00000001', 'n-00000009'], '2026-10-18T11:00:00.000Z')
    expect(d.done).toEqual(['n-00000001'])
    expect(openNotes(d.file)).toEqual([])
    expect(editNote(d.file, 'n-00000001', 'too late', AT).found).toBe(false)
    expect(markNotesDone(d.file, ['n-00000001'], AT).done).toEqual([])
    expect(dropNote(d.file, 'n-00000001').file.notes).toEqual([])
  })

  test('a file keeps every open note but only the newest applied ones', () => {
    let f = emptyNotesFile('/r')
    for (let i = 0; i < NOTES_DONE_KEEP + 5; i++) {
      const id = `n-${String(i).padStart(8, '0')}`
      const next = withNote(f, { kind: 'plan', text: 't', quote: 'q' }, id, AT)
      if (typeof next === 'string') throw new Error(next)
      f = markNotesDone(next, [id], new Date(Date.UTC(2026, 9, 18, 0, i)).toISOString()).file
    }
    const open = withNote(f, { kind: 'plan', text: 'still open', quote: 'q' }, 'n-ffffffff', AT)
    if (typeof open === 'string') throw new Error(open)
    expect(open.notes.length).toBe(NOTES_DONE_KEEP + 1)
    expect(open.notes.some(n => n.id === 'n-00000000')).toBe(false)
    expect(openNotes(open).map(n => n.id)).toEqual(['n-ffffffff'])
  })
})

describe('telling a session about new notes', () => {
  const doc: NotesInboxEntry = { at: 100, root: '/repo', key: 'k/plans--p.md', open: 2, doc: '/repo/docs/plans/p.md', rel: 'docs/plans/p.md' }
  const prd: NotesInboxEntry = { at: 110, root: '/repo', key: 'k/prd--x.md', open: 1, doc: '/repo/docs/prd/x.md', rel: 'docs/prd/x.md' }
  const code: NotesInboxEntry = { at: 120, root: '/repo', key: 'k/changes--plan-build~p', open: 1, checkout: '/repo/.worktrees/p', branch: 'plan-build/p' }

  test('a session hears about its own plan, its repository\'s changes, and only notes newer than the last notice', () => {
    const bound = { plan: '/repo/docs/plans/p.md', roots: ['/repo'] }
    expect(inboxFor([doc, prd, code], bound, 0)).toEqual([doc, code])
    expect(inboxFor([doc, prd, code], bound, 100)).toEqual([code])
    expect(inboxFor([{ ...doc, open: 0 }], bound, 0)).toEqual([])
    expect(inboxFor([doc], { plan: '/repo/docs/plans/other.md', roots: ['/repo'] }, 0)).toEqual([])
  })

  test('a session without a plan hears about PRDs of its repository and the changes of its own checkout only', () => {
    expect(inboxFor([doc, prd, code], { roots: ['/repo'] }, 0)).toEqual([prd])
    expect(inboxFor([doc, prd, code], { roots: ['/repo/.worktrees/p'] }, 0)).toEqual([prd, code])
    expect(inboxFor([doc, prd, code], { roots: ['/elsewhere', '/repo-2'] }, 0)).toEqual([])
  })

  test('the notice counts the notes and names the command that reads each kind', () => {
    const text = notesNoticeText([doc, code], { plan: '/repo/docs/plans/p.md', roots: [] }) as string
    expect(text).toContain('3 open notes')
    expect(text).toContain('docs/plans/p.md; the changes on plan-build/p')
    expect(text).toContain('`buracle plan notes --json`')
    expect(text).toContain('`buracle plan notes --kind code --json`')
    expect(text).toContain('buracle plan notes --done <id>')
    expect(notesNoticeText([prd], { roots: ['/repo'] })).toContain('`buracle plan notes docs/prd/x.md --json`')
    expect(notesNoticeText([prd], { roots: ['/repo'] })).toContain('`buracle plan notes docs/prd/x.md --done <id>`')
    expect(notesNoticeText([prd], { roots: ['/repo'] })).not.toContain('`buracle plan notes --done <id>`')
    expect(notesNoticeText([], { roots: [] })).toBeUndefined()
  })

  test('a document name with spaces or shell characters is quoted in the commands the agent is told to run', () => {
    const odd = (rel: string): NotesInboxEntry => ({ ...prd, rel, doc: `/repo/${rel}` })
    const text = (rel: string) => notesNoticeText([odd(rel)], { roots: ['/repo'] }) as string
    expect(text('docs/prd/my plan.md')).toContain("`buracle plan notes 'docs/prd/my plan.md' --json`")
    expect(text('docs/prd/my plan.md')).toContain("`buracle plan notes 'docs/prd/my plan.md' --done <id>`")
    expect(text('docs/prd/$(touch x).md')).toContain("`buracle plan notes 'docs/prd/$(touch x).md' --json`")
    expect(text('docs/prd/a;b`c`.md')).toContain("`buracle plan notes 'docs/prd/a;b`c`.md' --json`")
    expect(text("docs/prd/it's.md")).toContain("`buracle plan notes 'docs/prd/it'\\''s.md' --json`")
    expect(text('docs/prd/x\ny.md')).not.toContain('\n' + 'y.md')
    expect(text('docs/prd/x.md')).toContain('`buracle plan notes docs/prd/x.md --json`')
  })

  test('the inbox keeps one entry per file, moves its time only for the user\'s writes, and stays small', () => {
    const one = inboxWith([], doc, true)
    expect(inboxWith(one, { ...doc, at: 500, open: 0 }, false)).toEqual([{ ...doc, open: 0 }])
    expect(inboxWith(one, { ...doc, at: 500, open: 3 }, true)).toEqual([{ ...doc, at: 500, open: 3 }])
    expect(inboxWith([], code, false)).toEqual([])
    let many: NotesInboxEntry[] = []
    for (let i = 0; i < 80; i++) many = inboxWith(many, { ...code, key: `k${i}`, at: i }, true)
    expect(many.length).toBe(60)
    expect(many[0]?.key).toBe('k20')
  })
})

describe('/brain with an argument', () => {
  test('no argument opens the brain; review, plans, changes and notes open the review page; anything else is a usage error', () => {
    expect(brainPageArg('')).toBe('brain')
    expect(brainPageArg('  Review ')).toBe('review')
    for (const w of ['plans', 'changes', 'notes']) expect(brainPageArg(w)).toBe('review')
    expect(brainPageArg('graph')).toBeUndefined()
  })
})

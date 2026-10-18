import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPlan } from '../../src/cli/commands/plan'
import { withNote, type NoteInput } from '../../src/core/plan/notes'
import * as paths from '../../src/engine/paths'
import { repoFacts } from '../../src/workflow/gitx'
import { notify } from '../../src/workflow/notify'
import { changesTarget, docId, docTarget, newNoteId, notesPath, readInbox, readNotes, updateNotes, type NotesTarget } from '../../src/workflow/review-notes'
import { withSandbox } from '../helpers/sandbox'
import { ctxAt, g, makeRepo, memIO, planDoc, write } from './fixture'

const NOW = Date.UTC(2026, 9, 18, 9)

function pin(t: NotesTarget, input: NoteInput, now = NOW): string {
  const id = newNoteId()
  updateNotes(t, f => {
    const next = withNote(f, input, id, new Date(now).toISOString())
    if (typeof next === 'string') throw new Error(next)
    return { file: next, result: undefined }
  }, { now, byUser: true })
  return id
}

async function plan(repo: string): Promise<string> {
  const path = join(repo, 'docs', 'plans', '2026-10-18-limit.md')
  write(path, planDoc({ title: 'Rate limit' }))
  return path
}

async function notes(repo: string, args: string[], session?: string): Promise<{ code: number, body: Record<string, unknown>, err: string }> {
  const io = memIO(true)
  const code = await runPlan(['notes', ...args, ...(session !== undefined ? ['--session', session, '--harness', 'claude'] : [])], io, ctxAt(repo, NOW))
  return { code, body: io.out() === '' ? {} : io.json(), err: io.err() }
}

describe('buracle plan notes', () => {
  test('lists the open plan notes of a plan and the code notes of the checkout, and marks applied ones', async () => {
    await withSandbox(async ({ root }) => {
      const repo = await makeRepo(root)
      const path = await plan(repo)
      const facts = (await repoFacts(repo))!
      const docT = docTarget(facts, path)!
      const codeT = changesTarget(facts, 'main', repo)
      const a = pin(docT, { kind: 'plan', text: 'Say which client it was', quote: 'Do step 1.', line: 12 })
      const b = pin(codeT, { kind: 'code', text: 'Drop the + 0', quote: 'return x + 0', file: 'src/app.ts', side: 'new', start: 1, end: 1 })

      const all = await notes(repo, [path])
      expect(all.code).toBe(0)
      expect(all.body['open']).toBe(2)
      expect((all.body['notes'] as Array<{ id: string }>).map(n => n.id).sort()).toEqual([a, b].sort())
      expect(all.body['doc']).toEqual({ path: docT.doc!.path, rel: 'docs/plans/2026-10-18-limit.md' })
      expect(all.body['branch']).toBe('main')
      expect(all.body['page']).toBeNull()

      const onlyCode = await notes(repo, ['--kind', 'code'])
      expect((onlyCode.body['notes'] as Array<{ id: string, file: string }>).map(n => [n.id, n.file])).toEqual([[b, 'src/app.ts']])

      const done = await notes(repo, [path, '--done', `${a},${b}`])
      expect(done.code).toBe(0)
      expect(done.body['done']).toEqual([a, b])
      expect(done.body['open']).toBe(0)
      expect(readNotes(docT).notes[0]?.done).toBe(new Date(NOW).toISOString())

      const again = await notes(repo, [path, '--done', a])
      expect(again.code).toBe(1)
      expect(again.body['error']).toBe('not_found')
      expect(readInbox().every(e => e.open === 0)).toBe(true)
    })
  })

  test('without a path it reads the plan bound to the session; plain text tells the agent what to do', async () => {
    await withSandbox(async ({ root }) => {
      const repo = await makeRepo(root)
      const path = await plan(repo)
      const io = memIO(false)
      expect(await runPlan(['register', path, '--session', 'notes-s1', '--harness', 'claude'], io, ctxAt(repo, NOW))).toBe(0)
      const t = docTarget((await repoFacts(repo))!, path)!
      const id = pin(t, { kind: 'plan', text: 'Name the ticket\nand the date', quote: 'Do step 2.', line: 20 })
      const text = memIO(false)
      expect(await runPlan(['notes', '--kind', 'plan', '--session', 'notes-s1', '--harness', 'claude'], text, ctxAt(repo, NOW))).toBe(0)
      expect(text.out()).toContain(`[${id}] plan note at line 20: "Do step 2."`)
      expect(text.out()).toContain('    Name the ticket\n    and the date')
      expect(text.out()).toContain('buracle plan notes --done <id>')
      const none = memIO(false)
      expect(await runPlan(['notes', '--kind', 'plan'], none, ctxAt(repo, NOW))).toBe(1)
      expect(none.err()).toContain('no plan is bound to this session')
    })
  })

  test('a PRD outside any session: the hint names the path, and --done needs it', async () => {
    await withSandbox(async ({ root }) => {
      const repo = await makeRepo(root)
      const prd = join(repo, 'docs', 'prd', '2026-10-18-search.md')
      write(prd, '# Search items\n\nUsers search by name.\n')
      const id = pin(docTarget((await repoFacts(repo))!, prd)!, { kind: 'plan', text: 'Add the empty result', quote: 'Users search by name.', line: 3 })
      const text = memIO(false)
      expect(await runPlan(['notes', 'docs/prd/2026-10-18-search.md', '--kind', 'plan'], text, ctxAt(repo, NOW))).toBe(0)
      expect(text.out()).toContain('then mark it: buracle plan notes docs/prd/2026-10-18-search.md --done <id>[,<id>]')
      expect((await notes(repo, ['--done', id])).body['error']).toBe('not_found')
      const done = await notes(repo, ['docs/prd/2026-10-18-search.md', '--done', id])
      expect(done.code).toBe(0)
      expect(done.body['done']).toEqual([id])
      const spaced = join(repo, 'docs', 'prd', 'my plan.md')
      write(spaced, '# Spaced\n\nText.\n')
      pin(docTarget((await repoFacts(repo))!, spaced)!, { kind: 'plan', text: 'x', quote: 'Text.', line: 3 })
      const quoted = memIO(false)
      expect(await runPlan(['notes', 'docs/prd/my plan.md', '--kind', 'plan'], quoted, ctxAt(repo, NOW))).toBe(0)
      expect(quoted.out()).toContain("buracle plan notes 'docs/prd/my plan.md' --done <id>")
    })
  })

  test('no notes is reported as such, never as an approval; wrong input is refused', async () => {
    await withSandbox(async ({ root }) => {
      const repo = await makeRepo(root)
      const path = await plan(repo)
      const io = memIO(false)
      expect(await runPlan(['notes', path], io, ctxAt(repo, NOW))).toBe(0)
      expect(io.out()).toContain('No open notes from the review page on docs/plans/2026-10-18-limit.md or on the changes of main. No notes is not an approval.')
      expect((await notes(repo, ['README.md'])).body['error']).toBe('not_a_review_doc')
      expect((await notes(repo, ['docs/plans/missing.md'])).body['error']).toBe('not_found')
      expect((await notes(repo, ['--kind', 'diff'])).code).toBe(1)
      expect((await notes(repo, ['--done', 'abc'])).body['error']).toBe('usage')
      const outside = memIO(true)
      expect(await runPlan(['notes', '--kind', 'code'], outside, ctxAt(root, NOW))).toBe(1)
    })
  })

  test('a worktree and the main checkout share the notes of one plan, and the store sits outside the repository', async () => {
    await withSandbox(async ({ root }) => {
      const repo = await makeRepo(root)
      const path = await plan(repo)
      await g(repo, 'add', '.')
      await g(repo, 'commit', '-q', '-m', 'plan')
      const wt = join(root, 'wt-limit')
      await g(repo, 'worktree', 'add', '-q', '-b', 'plan-build/limit', wt)
      const mainT = docTarget((await repoFacts(repo))!, path)!
      const wtT = docTarget((await repoFacts(wt))!, join(wt, 'docs', 'plans', '2026-10-18-limit.md'))!
      expect(notesPath(wtT)).toBe(notesPath(mainT))
      expect(notesPath(mainT).startsWith(paths.reviewNotesDir())).toBe(true)
      pin(changesTarget((await repoFacts(wt))!, 'plan-build/limit', wt), { kind: 'code', text: 'rename this', quote: '', file: 'src/app.ts', side: 'new', start: 1, end: 1 })
      const fromWt = await notes(wt, ['--kind', 'code'])
      expect(fromWt.body['branch']).toBe('plan-build/limit')
      expect(fromWt.body['open']).toBe(1)
      expect((await notes(repo, ['--kind', 'code'])).body['open']).toBe(0)
      expect((await g(repo, 'status', '--porcelain')).split('\n').filter(l => l.includes('review'))).toEqual([])
    })
  })
})

describe('buracle notify names the review page', () => {
  test('an approval notification carries the page of the plan while the web UI runs, and none otherwise', async () => {
    await withSandbox(async ({ root }) => {
      const repo = await makeRepo(root)
      const path = await plan(repo)
      const off = await notify('plan_approval', 'Rate limit', 'ready', { plan: path }, ctxAt(repo, NOW), undefined)
      expect(off.data['page']).toBeNull()
      mkdirSync(paths.stateDir(), { recursive: true })
      writeFileSync(paths.memoryUiStateFile(), JSON.stringify({ v: 1, pid: process.pid, port: 41999, host: '127.0.0.1', url: 'http://127.0.0.1:41999', startedAt: '', version: '0', brain: '' }))
      const on = await notify('plan_approval', 'Rate limit', 'ready', { plan: path }, ctxAt(repo, NOW), undefined)
      expect(on.data['page']).toBe(`http://127.0.0.1:41999/review?doc=${docId(path)}`)
      expect(on.lines).toContain(`Review page: http://127.0.0.1:41999/review?doc=${docId(path)}`)
      const info = await notify('info', 'Rate limit', 'done', { plan: path }, ctxAt(repo, NOW), undefined)
      expect('page' in info.data).toBe(false)
      expect(existsSync(paths.reviewInboxFile())).toBe(false)
      expect(readFileSync(paths.memoryUiStateFile(), 'utf8')).toContain('41999')
    })
  })
})

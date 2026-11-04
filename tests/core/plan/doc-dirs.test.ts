import { describe, expect, test } from 'bun:test'
import { ALL_DOC_DIRS, DOC_DIRS, DOC_DIR_PREFIX, DOC_FILE, LEGACY_DOC_DIRS, docDirFor, docDirOf } from '../../../src/core/plan/doc-dirs'

describe('the document folders', () => {
  test('four workflow folders, each with one legacy name', () => {
    expect(DOC_DIRS.map(d => [d.dir, d.workflow, d.legacy])).toEqual([
      ['requirements', 'requirements', 'prd'],
      ['plan-build', 'plan-build', 'plans'],
      ['goal-build', 'goal-build', 'builds'],
      ['dead-code', 'dead-code', 'cleanup'],
    ])
    expect([...LEGACY_DOC_DIRS]).toEqual(['prd', 'plans', 'builds', 'cleanup'])
    expect([...ALL_DOC_DIRS]).toEqual(['requirements', 'plan-build', 'goal-build', 'dead-code', 'prd', 'plans', 'builds', 'cleanup'])
    expect(DOC_DIRS.map(d => docDirFor(d.workflow))).toEqual(['requirements', 'plan-build', 'goal-build', 'dead-code'])
  })

  test('docDirOf names the folder, its workflow and whether it is legacy', () => {
    expect(docDirOf('docs/plan-build/a.md')).toEqual({ dir: 'plan-build', workflow: 'plan-build', legacy: false })
    expect(docDirOf('docs/plans/a.md')).toEqual({ dir: 'plans', workflow: 'plan-build', legacy: true })
    expect(docDirOf('docs\\prd\\a.md')).toEqual({ dir: 'prd', workflow: 'requirements', legacy: true })
    expect(docDirOf('docs/cleanup/a.md')?.workflow).toBe('dead-code')
    expect(docDirOf('docs/goal-build/çalışma planı.md')?.legacy).toBe(false)
    for (const bad of ['docs/a.md', 'docs/plans/sub/a.md', 'docs/plans/a.txt', 'src/docs/plans/a.md', 'docs/notes/a.md', 'docs/plans/', '']) expect({ bad, r: docDirOf(bad) }).toEqual({ bad, r: undefined })
  })

  test('DOC_FILE matches a Markdown file directly inside a folder, DOC_DIR_PREFIX anything below one', () => {
    for (const ok of ['docs/goal-build/x.md', 'docs/builds/x.md', 'docs/dead-code/x.md', 'docs/cleanup/x.md']) expect({ ok, m: DOC_FILE.test(ok) }).toEqual({ ok, m: true })
    for (const no of ['docs/goal-build/assets/x.md', 'docs/goal-build/x.txt', 'repo/docs/plans/x.md']) expect({ no, m: DOC_FILE.test(no) }).toEqual({ no, m: false })
    for (const ok of ['docs/goal-build/assets/x.png', '/repo/docs/prd/x.md', './docs/plan-build/a.md']) expect({ ok, m: DOC_DIR_PREFIX.test(ok) }).toEqual({ ok, m: true })
    for (const no of ['docs/other/x.md', 'mydocs/plans/x.md', 'docs/plans']) expect({ no, m: DOC_DIR_PREFIX.test(no) }).toEqual({ no, m: false })
  })
})

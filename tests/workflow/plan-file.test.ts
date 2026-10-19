import { describe, expect, test } from 'bun:test'
import { parseFrontmatter } from '../../src/core/frontmatter'
import {
  analyzePlan, fenceMask, isValidSlug, localDate, localTaskProgress, normalizeStatus, planTitle, slugFromPlanPath,
  slugFromTitle, updateFrontmatterText,
} from '../../src/workflow/plan-file'
import { parseCommandArgs } from '../../src/workflow/args'
import { planDoc } from './fixture'

describe('updateFrontmatterText', () => {
  test('changes only the targeted lines and keeps the body byte-identical', () => {
    const doc = planDoc({ n: 2 })
    const next = updateFrontmatterText(doc, { status: 'APPROVED', approved: true })
    const body = (s: string) => s.slice(s.indexOf('\n---\n', 4))
    expect(body(next)).toBe(body(doc))
    expect(next).toContain('\nstatus: APPROVED\n')
    expect(next).toContain('\napproved: true\n')
    expect(next.split('\n').length).toBe(doc.split('\n').length)
    expect(parseFrontmatter(next).data['type']).toBe('Feature')
  })

  test('keeps comments, quoting and unknown keys; inserts a missing key after its predecessor', () => {
    const doc = ['---', 'created: "2026-10-08"', 'status: PENDING # set by the CLI', 'approved: false', 'worktree: false', 'type: Feature', 'iterations: 0', 'tags: [a, b]', '---', '# T', ''].join('\n')
    const next = updateFrontmatterText(doc, { status: 'IN_PROGRESS', phase: 'implement' })
    const lines = next.split('\n')
    expect(lines[1]).toBe('created: "2026-10-08"')
    expect(lines[2]).toBe('status: IN_PROGRESS # set by the CLI')
    expect(lines.indexOf('phase: implement')).toBe(lines.indexOf('type: Feature') + 1)
    expect(lines).toContain('tags: [a, b]')
  })

  test('a key with a block value is replaced as a whole; CRLF and BOM survive', () => {
    const crlf = '﻿---\r\nstatus:\r\n  - weird\r\napproved: false\r\n---\r\n# T\r\n'
    const next = updateFrontmatterText(crlf, { status: 'PENDING' })
    expect(next).toBe('﻿---\r\nstatus: PENDING\r\napproved: false\r\n---\r\n# T\r\n')
  })

  test('strings that look like other types are quoted so they read back unchanged', () => {
    const next = updateFrontmatterText('---\na: 1\n---\n', { title: 'yes', n: 3, flag: false })
    const data = parseFrontmatter(next).data
    expect(data['title']).toBe('yes')
    expect(data['n']).toBe(3)
    expect(data['flag']).toBe(false)
  })

  test('refuses documents without a closed frontmatter block', () => {
    expect(() => updateFrontmatterText('# no header\n', { status: 'PENDING' })).toThrow(/no YAML frontmatter/)
    expect(() => updateFrontmatterText('---\nstatus: X\n# never closed\n', { status: 'PENDING' })).toThrow(/not closed/)
  })
})

describe('analyzePlan', () => {
  test('reads the header, title and task progress', () => {
    const info = analyzePlan(planDoc({ status: 'IN_PROGRESS', approved: true, n: 3, done: 2 }))
    expect(info.status).toBe('IN_PROGRESS')
    expect(info.type).toBe('Feature')
    expect(info.approved).toBe(true)
    expect(info.worktree).toBe(false)
    expect(info.iterations).toBe(0)
    expect(info.title).toBe('Rate-limit the public API')
    expect(info.tasks.total).toBe(3)
    expect(info.tasks.done).toBe(2)
    expect(info.tasks.open).toEqual([{ n: 3, title: 'Step 3' }])
    expect(info.problems).toEqual([])
  })

  test('reports invalid header values instead of guessing', () => {
    const info = analyzePlan('---\nstatus: DONE\ntype: Epic\napproved: maybe\nphase: later\n---\n# T\n')
    expect(info.status).toBeUndefined()
    expect(info.type).toBeUndefined()
    expect(info.problems.length).toBe(4)
  })

  test('normalizes harmless spelling differences', () => {
    expect(normalizeStatus('in progress')).toBe('IN_PROGRESS')
    expect(normalizeStatus('verified')).toBe('VERIFIED')
    expect(normalizeStatus('nope')).toBeUndefined()
  })
})

describe('local task counter', () => {
  test('counts cards and checkboxes inside ## Tasks only, ignoring code fences', () => {
    const body = [
      '# T', '', '## Context', '### Task 9: not a task (outside ## Tasks)', '',
      '## Tasks', '', '### Task 1: First', '- [x] Task 1 done', '',
      '```markdown', '### Task 7: example in a fence', '- [x] Task 7 done', '```', '',
      '### Task 2: Second', '- [ ] Task 2 done', '', '### Task 3: Third', '* [X] Task 3 done', '',
      '## Notes', '- [x] Task 2 done (outside the section: ignored)',
    ].join('\n')
    const p = localTaskProgress(body)
    expect(p.total).toBe(3)
    expect(p.done).toBe(2)
    expect(p.open).toEqual([{ n: 2, title: 'Second' }])
  })

  test('without a ## Tasks section the whole body is scanned', () => {
    expect(localTaskProgress('### Task 1: A\n- [x] Task 1 done\n### Task 2: B\n').done).toBe(1)
  })

  test('fenceMask tracks backtick and tilde fences', () => {
    expect(fenceMask(['a', '```ts', 'x', '```', 'b', '~~~', '```', '~~~', 'c'])).toEqual([false, true, true, true, false, true, true, true, false])
  })

  test('planTitle skips fenced headings', () => {
    expect(planTitle('```\n# not this\n```\n# Real title\n')).toBe('Real title')
  })
})

describe('slugs and dates', () => {
  test('Turkish folding, kebab case, length cap at a word boundary', () => {
    expect(slugFromTitle('Ödeme sayfasında İçerik Güncelleme')).toBe('odeme-sayfasinda-icerik-guncelleme')
    expect(slugFromTitle('Fix: invoice totals drop the last line item')).toBe('fix-invoice-totals-drop-the-last-line-item')
    const long = slugFromTitle('a very long title that keeps going and going well beyond fifty characters')
    expect(long.length).toBeLessThanOrEqual(50)
    expect(long.endsWith('-')).toBe(false)
    expect(slugFromTitle('!!!')).toBe('plan')
  })

  test('slug from a plan path', () => {
    expect(slugFromPlanPath('/r/docs/plans/2026-10-08-rate-limit.md')).toBe('rate-limit')
    expect(slugFromPlanPath('/r/docs/plans/My Plan.md')).toBe('my-plan')
    expect(isValidSlug('rate-limit-2')).toBe(true)
    expect(isValidSlug('Rate')).toBe(false)
    expect(isValidSlug('a--b')).toBe(false)
  })

  test('localDate formats the local calendar date', () => {
    const d = new Date(2026, 0, 5, 23, 30)
    expect(localDate(d.getTime())).toBe('2026-01-05')
  })
})

describe('parseCommandArgs', () => {
  test('flags with and without =, booleans, global flags skipped, -- ends options', () => {
    const r = parseCommandArgs(['set', '--json', 'status', '--reason=a b', '--strict', '-v', '--kind', 'decision', '--', '--not-a-flag'], { reason: 'string', strict: 'bool', kind: 'string' })
    expect(r.positional).toEqual(['set', 'status', '--not-a-flag'])
    expect(r.flags).toEqual({ reason: 'a b', strict: true, kind: 'decision' })
    expect(r.errors).toEqual([])
  })

  test('unknown flags and missing values are errors', () => {
    expect(parseCommandArgs(['--nope'], {}).errors).toEqual(['unknown option --nope'])
    expect(parseCommandArgs(['--kind'], { kind: 'string' }).errors).toEqual(['--kind needs a value'])
    expect(parseCommandArgs(['--kind', '--json'], { kind: 'string' }).errors).toEqual(['--kind needs a value'])
    expect(parseCommandArgs(['--reason', '--weird text'], { reason: 'string' }).flags['reason']).toBe('--weird text')
  })
})

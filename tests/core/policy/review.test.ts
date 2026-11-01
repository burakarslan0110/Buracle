import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEW_CATEGORIES, REVIEW_MAX_FINDINGS, validateReviewJson, type ReviewAgent } from '../../../src/core/policy/review'
import * as paths from '../../../src/engine/paths'

const AGENTS_DIR = join(paths.canonicalDir(), 'agents')
const agentDoc = (id: string): string => readFileSync(join(AGENTS_DIR, `${id}.md`), 'utf8')

const finding = (over: Record<string, unknown> = {}) => ({
  severity: 'must_fix', category: 'correctness', title: 'Date filter runs after pagination', file: 'src/a.ts', line: 48,
  evidence: 'export.ts:41 paginates before filtering', suggested_fix: 'Filter in the query', ...over,
})
const report = (over: Record<string, unknown> = {}) => ({
  verdict: 'needs_changes', summary: 'docs/plans/2026-10-08-x.md: one correctness problem.', findings: [finding()],
  truths: [{ truth: 'export returns only in-range invoices', status: 'failed', evidence: 'export.ts:41-48' }], goal_score: 40, ...over,
})
const v = (x: unknown, opts?: { agent?: string, subject?: string | readonly string[] }) => validateReviewJson(typeof x === 'string' ? x : JSON.stringify(x), opts)

describe('agent definitions', () => {
  test('categories match the "## Categories" section of each canonical agent', () => {
    const ids = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort()
    expect(ids).toEqual(Object.keys(REVIEW_CATEGORIES).sort())
    for (const id of ids) {
      const section = /## Categories\s*\n+([^\n]+)/.exec(agentDoc(id))?.[1] ?? ''
      const listed = [...section.matchAll(/`([a-z_]+)`/g)].map(m => m[1])
      expect(listed).toEqual([...REVIEW_CATEGORIES[id as ReviewAgent]])
    }
  })

  test("each agent's own example output validates", () => {
    for (const id of Object.keys(REVIEW_CATEGORIES)) {
      const example = /Example:\s*\n+```json\n([\s\S]*?)\n```/.exec(agentDoc(id))?.[1]
      expect(example).toBeDefined()
      const r = validateReviewJson(example as string, { agent: id })
      expect(r.errors).toEqual([])
      expect(r.ok).toBe(true)
    }
  })

  test('the limit of 15 findings matches the agents', () => {
    expect(REVIEW_MAX_FINDINGS).toBe(15)
    for (const id of Object.keys(REVIEW_CATEGORIES)) expect(agentDoc(id)).toContain('Report at most 15')
  })
})

describe('validateReviewJson: valid reports', () => {
  test('a complete changes-review report', () => {
    const r = v(report(), { agent: 'changes-review', subject: 'docs/plans/2026-10-08-x.md' })
    expect(r).toEqual({ ok: true, errors: [], review: report() as never })
  })

  test('a passing report with no findings and a goal summary', () => {
    expect(v({ verdict: 'pass', summary: 'goal: the bug is fixed and covered.', findings: [], truths: [] }, { agent: 'changes-review' }).ok).toBe(true)
    expect(v({ verdict: 'pass', summary: 'Goal met.', findings: [{ ...finding({ severity: 'suggestion' }) }] }).ok).toBe(true)
  })

  test('the plugin-prefixed agent name and an absolute subject path are accepted', () => {
    expect(v(report(), { agent: 'buracle:changes-review', subject: '/abs/repo/docs/plans/2026-10-08-x.md' }).ok).toBe(true)
  })

  test('several bound plans (the lead\'s and its plan lanes\'): a summary about any of them passes, about another file it does not', () => {
    const bound = ['/abs/repo/docs/plans/2026-10-08-lead.md', '/abs/repo/.worktrees/billing/docs/plans/2026-10-08-x.md']
    expect(v(report(), { agent: 'changes-review', subject: bound }).ok).toBe(true)
    const other = v(report({ summary: 'docs/plans/other.md: x' }), { agent: 'changes-review', subject: bound })
    expect(other.errors).toContain(`\`summary\` must start with the reviewed path (${bound.join(' or ')}) or "goal"`)
    expect(v(report({ summary: 'goal: fixed.' }), { agent: 'changes-review', subject: bound }).ok).toBe(true)
    expect(v(report({ summary: 'src/app.ts: x' }), { agent: 'changes-review', subject: [] }).ok).toBe(true)
  })

  test('a bound path with a space, in backticks or bold, or as a repo-relative suffix passes; a lookalike does not', () => {
    const spaced = '/Users/me/Desktop/Buracle Plugin/buracle/docs/plans/2026-10-08-x.md'
    const ok = (summary: string, subject: string | readonly string[] = spaced) => v(report({ summary }), { agent: 'changes-review', subject }).ok
    expect(ok(`${spaced}: one correctness problem.`)).toBe(true)
    expect(ok(`\`${spaced}\`: one correctness problem.`)).toBe(true)
    expect(ok('**docs/plans/2026-10-08-x.md**: one correctness problem.')).toBe(true)
    expect(ok('docs/plans/2026-10-08-x.md: one correctness problem.')).toBe(true)
    expect(ok('plans/2026-10-08-x.md - one correctness problem.')).toBe(true)
    expect(ok('**Goal** met.')).toBe(true)
    expect(ok(`${spaced}: ok`, 'docs/plans/2026-10-08-x.md')).toBe(true)
    expect(ok(`/private${spaced}: ok`)).toBe(true)
    expect(ok('docs/plans/2026-10-08-x.md.bak: ok')).toBe(false)
    expect(ok('/Users/me/other/docs/plans/x.md: ok', '/Users/me/repo/docs/plans/x.md')).toBe(false)
    expect(ok('/Users/me/Desktop/Buracle Plugin/buracle/docs/plans/other.md: ok')).toBe(false)
    expect(ok('Reviewed docs/plans/2026-10-08-x.md: ok', 'docs/plans/2026-10-08-x.md')).toBe(false)
    expect(ok('src/a.ts: see /x/docs/plans/2026-10-08-x.md', 'docs/plans/2026-10-08-x.md')).toBe(false)
  })
})

describe('validateReviewJson: contract violations', () => {
  const errorsOf = (x: unknown, opts?: { agent?: string, subject?: string }): string => v(x, opts).errors.join('\n')

  test('verdict must match the findings', () => {
    expect(errorsOf(report({ verdict: 'pass' }))).toContain('must be "needs_changes"')
    expect(errorsOf(report({ verdict: 'needs_changes', findings: [finding({ severity: 'suggestion' })], truths: [] }))).toContain('must be "pass"')
    expect(errorsOf(report({ verdict: 'maybe' }))).toContain('`verdict`')
  })

  test('summary starts with the reviewed path or "goal"', () => {
    expect(errorsOf(report({ summary: 'Looks mostly fine.' }))).toContain('summary')
    expect(errorsOf(report({ summary: 'docs/plans/other.md: x' }), { subject: 'docs/plans/2026-10-08-x.md' })).toContain('reviewed path')
    expect(errorsOf(report({ summary: '' }))).toContain('summary')
  })

  test('categories are checked per agent', () => {
    expect(errorsOf(report(), { agent: 'plan-build-review' })).toContain('not one of plan-build-review')
    expect(v(report({ findings: [finding({ category: 'requirement_gap' })], truths: undefined }), { agent: 'plan-build-review' }).ok).toBe(true)
    expect(errorsOf(report({ findings: [finding({ category: 'vibes' })] }))).toContain('"vibes"')
    expect(v(report({ findings: [finding({ category: 'criterion_fakeable' })] })).ok).toBe(true)
  })

  test('the oracle, false-pass, reference and goal ids belong to goal-build-review; performance and over_engineering to changes-review', () => {
    const goal = (category: string, severity = 'must_fix') => v(report({ summary: 'docs/builds/2026-10-08-x.md: the oracle proves nothing.', findings: [finding({ category, severity })], truths: undefined }), { agent: 'goal-build-review' })
    for (const id of ['oracle_mismatch', 'false_pass_uncaught', 'reference_unobtainable']) expect({ id, ok: goal(id).ok }).toEqual({ id, ok: true })
    for (const id of ['no_measurable_criterion', 'goal_unclear']) expect({ id, ok: goal(id, 'should_fix').ok }).toEqual({ id, ok: true })
    expect(goal('performance').ok).toBe(false)
    const changes = (category: string) => v(report({ findings: [finding({ category, severity: 'should_fix' })], truths: [{ truth: 't', status: 'verified', evidence: 'a.ts:1' }] }), { agent: 'changes-review' })
    expect(changes('performance').ok).toBe(true)
    expect(changes('over_engineering').ok).toBe(true)
    expect(changes('oracle_mismatch').ok).toBe(false)
    expect(errorsOf(report({ findings: [finding({ category: 'performance' })], truths: undefined }), { agent: 'plan-build-review' })).toContain('not one of plan-build-review')
  })

  test('test_quality (redundant, mirroring or mock-only tests) belongs to changes-review only', () => {
    const changes = v(report({ findings: [finding({ category: 'test_quality', severity: 'should_fix' })], truths: [{ truth: 't', status: 'verified', evidence: 'a.ts:1' }] }), { agent: 'changes-review' })
    expect(changes.errors).toEqual([])
    expect(changes.ok).toBe(true)
    const goal = v(report({ summary: 'docs/builds/2026-10-08-x.md: tests.', findings: [finding({ category: 'test_quality', severity: 'should_fix' })], truths: undefined }), { agent: 'goal-build-review' })
    expect(goal.ok).toBe(false)
  })

  test('finding fields', () => {
    const errs = errorsOf(report({ findings: [{ severity: 'blocker', category: '', title: 'x'.repeat(101), evidence: '', suggested_fix: '', file: '', line: 0, extra: 1 }] }))
    for (const needle of ['severity', 'category', 'title', 'evidence', 'suggested_fix', 'file', 'line', 'unknown field `extra`']) expect(errs).toContain(needle)
    expect(errorsOf(report({ findings: [finding({ line: null })] }))).toContain('line')
    expect(errorsOf(report({ findings: 'none' }))).toContain('`findings` must be a list')
  })

  test('findings are sorted by severity and limited to 15', () => {
    const unsorted = [finding({ severity: 'suggestion' }), finding({ severity: 'must_fix' })]
    expect(errorsOf(report({ findings: unsorted }))).toContain('sort findings')
    const many = Array.from({ length: 16 }, () => finding())
    expect(errorsOf(report({ findings: many }))).toContain('at most 15')
  })

  test('truths: shape, required for changes-review, failed truths need a must_fix finding', () => {
    expect(errorsOf(report({ truths: undefined }), { agent: 'changes-review' })).toContain('must include `truths`')
    expect(errorsOf(report({ truths: [{ truth: '', status: 'maybe', evidence: 3 }] }))).toContain('truths[0].status')
    const noMustFix = report({ findings: [finding({ severity: 'should_fix', category: 'test_gap' })] })
    expect(errorsOf(noMustFix, { agent: 'changes-review' })).toContain('backed by a must_fix')
    expect(errorsOf(report({ truths: 'x' }))).toContain('`truths` must be a list')
  })

  test('goal_score is a whole number 0..100 and optional fields are omitted rather than null', () => {
    expect(errorsOf(report({ goal_score: 101 }))).toContain('goal_score')
    expect(errorsOf(report({ goal_score: 50.5 }))).toContain('goal_score')
    expect(errorsOf(report({ goal_score: null }))).toContain('goal_score')
  })

  test('unknown top-level fields are rejected', () => {
    expect(errorsOf(report({ notes: 'x' }))).toContain('unknown field `notes`')
  })
})

describe('validateReviewJson: message framing', () => {
  test('a Markdown fence or surrounding text is reported but the content is still checked', () => {
    const fenced = '```json\n' + JSON.stringify(report({ verdict: 'pass' })) + '\n```'
    const r = validateReviewJson(fenced)
    expect(r.ok).toBe(false)
    expect(r.errors.join('\n')).toContain('Markdown fence')
    expect(r.errors.join('\n')).toContain('must be "needs_changes"')
    const chatty = 'Here is my review:\n' + JSON.stringify(report()) + '\nThanks!'
    expect(validateReviewJson(chatty).errors).toEqual(['text surrounds the JSON object; return only the object'])
  })

  test('invalid JSON, arrays and empty messages', () => {
    expect(validateReviewJson('{nope').errors).toContain('the final message is not valid JSON')
    expect(validateReviewJson('[]').errors).toContain('expected one JSON object')
    expect(validateReviewJson('').ok).toBe(false)
    expect(validateReviewJson(undefined as unknown as string).ok).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Finding, PlanType } from '../../../src/core/plan/format'
import { PLAN_TYPES, criteriaTable, parsePlan, planCriteria, planSkeleton, validatePlan } from '../../../src/core/plan/format'
import * as paths from '../../../src/engine/paths'

const codes = (fs: Finding[], level?: Finding['level']): string[] => fs.filter(f => level === undefined || f.level === level).map(f => f.code)
const errors = (md: string, strict = false): string[] => codes(validatePlan(md, { strict }), 'error')

function skillExample(file: string, marker = '```markdown\n'): string {
  const text = readFileSync(join(paths.canonicalDir(), file), 'utf8')
  const start = text.indexOf(marker)
  const end = text.indexOf('\n```\n', start + marker.length)
  return text.slice(start + marker.length, end + 1)
}

const FEATURE = `---
created: 2026-10-08
status: PENDING
approved: false
worktree: false
type: Feature
iterations: 0
---
# Rate-limit the public API

## Goal
Clients get 429.

## Tasks

### Task 1: Count requests per API key

**Objective:** Middleware counts requests per key.

**Files:**
- Create: \`src/middleware/rate-limit.ts\`
- Modify: \`src/server.ts\`
- Test: \`tests/middleware/rate-limit.test.ts\`

**Definition of Done:**
- The 101st request gets 429.
- Verify: \`bun test tests/middleware/rate-limit.test.ts\`

- [x] Task 1 done

### Task 2: Document the limit

**Objective:** README explains the limit.

**Files:**
- Modify: README.md

**Definition of Done:**
- README has a "Rate limits" section.
- Verify: \`rg -n "Rate limits" README.md\`

- [ ] Task 2 done

## Deviations
- none
`

describe('parsePlan', () => {
  test('a heading keeps a trailing `#` that is part of the text (WF-08 in core: C#, F#); a closing sequence after whitespace goes', () => {
    const doc = FEATURE.replace('# Rate-limit the public API', '# Port the client to C#').replace('### Task 1: Count requests per API key', '### Task 1: Support F# ##')
    const p = parsePlan(doc)
    expect(p.title).toBe('Port the client to C#')
    expect(p.tasks[0]?.title).toBe('Support F#')
  })

  test('reads header, title, sections and task cards', () => {
    const p = parsePlan(FEATURE)
    expect(p.header).toEqual({ created: '2026-10-08', status: 'PENDING', approved: false, worktree: false, type: 'Feature', iterations: 0 })
    expect(p.title).toBe('Rate-limit the public API')
    expect(p.sections).toEqual(['Goal', 'Tasks', 'Deviations'])
    expect(p.tasks).toEqual([
      {
        n: 1, title: 'Count requests per API key', done: true, objective: 'Middleware counts requests per key.',
        files: [{ verb: 'Create', path: 'src/middleware/rate-limit.ts' }, { verb: 'Modify', path: 'src/server.ts' }, { verb: 'Test', path: 'tests/middleware/rate-limit.test.ts' }],
        dod: '- The 101st request gets 429.\n- Verify: `bun test tests/middleware/rate-limit.test.ts`',
      },
      { n: 2, title: 'Document the limit', done: false, objective: 'README explains the limit.', files: [{ verb: 'Modify', path: 'README.md' }], dod: '- README has a "Rate limits" section.\n- Verify: `rg -n "Rate limits" README.md`' },
    ])
  })

  test('is lenient with case, yes/no booleans and missing fields', () => {
    const p = parsePlan('---\nstatus: in_progress\napproved: yes\ntype: bugfix\nrounds: "2"\n---\n# T\n')
    expect(p.header).toEqual({ created: '', status: 'IN_PROGRESS', approved: true, worktree: false, type: 'Bugfix', rounds: 2 })
    expect(parsePlan('').header.status).toBe('PENDING')
    expect(parsePlan('no frontmatter at all').tasks).toEqual([])
  })

  test('ignores headings inside code fences and cards outside ## Tasks', () => {
    const md = `${FEATURE}\n## Notes\n\`\`\`bash\n# not a title\n### Task 9: not a task\n\`\`\`\n### Task 3: outside tasks\n`
    const p = parsePlan(md)
    expect(p.tasks.map(t => t.n)).toEqual([1, 2])
    expect(p.title).toBe('Rate-limit the public API')
  })

  test('accepts dash separators and bold labels with the colon outside', () => {
    const md = FEATURE.replace('### Task 2: Document the limit', '### Task 2 — Document the limit').replace('**Objective:** README', '**Objective**: README')
    const p = parsePlan(md)
    expect(p.tasks[1]?.title).toBe('Document the limit')
    expect(p.tasks[1]?.objective).toBe('README explains the limit.')
  })
})

describe('validatePlan: valid plans', () => {
  test('a complete feature plan has no findings, also in strict mode', () => {
    expect(validatePlan(FEATURE)).toEqual([])
    expect(validatePlan(FEATURE, { strict: true })).toEqual([])
  })

  test('the examples in the spec, bugfix and build skills validate without errors', () => {
    for (const [file, marker] of [['skills/plan-build/references/plan.md', '```markdown\n'], ['skills/plan-build/references/bugfix-plan.md', '```markdown\n'], ['skills/goal-build/references/goal-and-contract.md', '```markdown\n']] as const) {
      const md = skillExample(file, marker)
      expect(md.startsWith('---\n')).toBe(true)
      expect(validatePlan(md).filter(f => f.level === 'error')).toEqual([])
    }
  })

  test('unknown ## sections are accepted', () => {
    const extra = ['Context', 'Scope', 'Approach', 'Inventory', 'E2E Scenarios', 'E2E Results', 'DoD Audit', 'Evidence', 'Gaps', 'Unverified', 'Follow-ups', 'Review Notes', 'RED Evidence', 'Behavior Contract', 'Root Cause', 'Risks', 'Assumptions', 'Reference', 'Acceptance Criteria', 'Rounds', 'Files Touched', 'Anything Else']
    const md = FEATURE + extra.map(s => `\n## ${s}\ntext\n`).join('')
    expect(validatePlan(md, { strict: true })).toEqual([])
  })

  test('Build cards need only Objective and the checkbox', () => {
    const md = `---\ncreated: 2026-10-08\nstatus: APPROVED\napproved: true\nworktree: false\ntype: Build\nrounds: 1\n---\n# Offline notes\n\n## Tasks\n\n### Task 1: Queue writes\n\n**Objective:** Writes go to a queue (C1).\n\n- [ ] Task 1 done\n`
    expect(validatePlan(md)).toEqual([])
  })

  test('a captured native plan (type Plan, SAVED) needs no task cards', () => {
    const md = '---\ncreated: 2026-10-08\nstatus: SAVED\napproved: true\nworktree: false\ntype: Plan\niterations: 0\n---\n# Captured plan\n\n## Summary\nDo the thing.\n'
    expect(validatePlan(md)).toEqual([])
  })
})

describe('validatePlan: finding codes', () => {
  test('crlf', () => {
    expect(errors(FEATURE.replace(/\n/g, '\r\n'))).toContain('crlf')
    const f = validatePlan(FEATURE.replace('# Rate', '\r# Rate')).find(x => x.code === 'crlf')
    expect(f?.line).toBe(9)
  })

  test('missing frontmatter, missing and bad fields', () => {
    expect(errors('# T\n\n## Tasks\n')).toContain('missing-frontmatter')
    expect(errors(FEATURE.replace('created: 2026-10-08\n', ''))).toContain('missing-field')
    expect(errors(FEATURE.replace('status: PENDING', 'status: DONE'))).toEqual(['bad-status'])
    expect(errors(FEATURE.replace('status: PENDING', 'status: pending'))).toEqual(['bad-status'])
    expect(errors(FEATURE.replace('type: Feature', 'type: Epic'))).toEqual(['bad-type'])
    expect(errors(FEATURE.replace('approved: false', 'approved: yes'))).toEqual(['bad-field'])
    expect(errors(FEATURE.replace('created: 2026-10-08', 'created: yesterday'))).toEqual(['bad-field'])
    expect(errors(FEATURE.replace('iterations: 0', 'iterations: -1'))).toEqual(['bad-field'])
    const missingCounter = validatePlan(FEATURE.replace('iterations: 0\n', ''))
    expect(codes(missingCounter)).toEqual(['missing-field'])
    expect(missingCounter[0]?.level).toBe('warning')
  })

  test('the line of a bad frontmatter field is reported', () => {
    expect(validatePlan(FEATURE.replace('status: PENDING', 'status: DONE'))[0]?.line).toBe(3)
  })

  test('inconsistent state is a warning', () => {
    const f = validatePlan(FEATURE.replace('status: PENDING', 'status: IN_PROGRESS'))
    expect(f.map(x => [x.code, x.level])).toEqual([['inconsistent-state', 'warning']])
  })

  test('title and tasks section', () => {
    expect(errors(FEATURE.replace('# Rate-limit the public API\n', ''))).toContain('missing-title')
    expect(errors(FEATURE.replace('## Tasks', '## Work'))).toContain('missing-tasks')
    expect(errors(FEATURE.replace(/### Task \d: /g, '#### '))).toContain('missing-tasks')
    expect(errors(`${FEATURE}\n## Tasks\n`)).toContain('duplicate-section')
  })

  test('task numbering and headings', () => {
    expect(errors(FEATURE.replace('### Task 2:', '### Task 3:').replace('Task 2 done', 'Task 3 done'))).toEqual(['task-numbering'])
    expect(errors(FEATURE.replace('### Task 2:', '### Task 1:').replace('Task 2 done', 'Task 1 done'))).toEqual(['task-numbering'])
    expect(errors(FEATURE.replace('### Task 2: Document the limit', '### Task two: Document'))).toContain('task-heading')
    expect(errors(FEATURE.replace('### Task 2: Document the limit', '### Task 2:'))).toContain('task-heading')
  })

  test('card fields: objective, files, verbs, DoD, checkbox', () => {
    expect(errors(FEATURE.replace('**Objective:** README explains the limit.', ''))).toEqual(['missing-objective'])
    expect(errors(FEATURE.replace('**Objective:** README explains the limit.', '**Objective:**'))).toEqual(['missing-objective'])
    expect(errors(FEATURE.replace('**Files:**\n- Modify: README.md\n', ''))).toEqual(['missing-files'])
    expect(errors(FEATURE.replace('- Modify: README.md', '- Update: README.md')).sort()).toEqual(['bad-file-verb', 'missing-files'])
    expect(errors(FEATURE.replace('- Modify: `src/server.ts`', '- `src/server.ts`'))).toEqual(['bad-file-verb'])
    expect(errors(FEATURE.replace('- Modify: `src/server.ts`', '- modify: `src/server.ts`'))).toEqual([])
    expect(errors(FEATURE.replace(/\*\*Definition of Done:\*\*\n- README has a "Rate limits" section.\n- Verify: `rg -n "Rate limits" README.md`\n/, ''))).toEqual(['missing-dod'])
    expect(errors(FEATURE.replace('- [ ] Task 2 done', ''))).toEqual(['missing-checkbox'])
    expect(errors(FEATURE.replace('- [ ] Task 2 done', '- [ ] Task 3 done'))).toEqual(['checkbox-mismatch'])
  })

  test('placeholders are errors inside task cards and strict warnings elsewhere', () => {
    const inCard = FEATURE.replace('README explains the limit.', 'TODO decide what README says')
    expect(errors(inCard)).toEqual(['placeholder'])
    expect(validatePlan(inCard).find(f => f.code === 'placeholder')?.line).toBe(33)
    expect(errors(FEATURE.replace('Clients get 429.', 'Clients get 429. TBD: headers'))).toEqual([])
    expect(codes(validatePlan(FEATURE.replace('Clients get 429.', 'Clients get 429. TBD: headers'), { strict: true }), 'warning')).toEqual(['placeholder'])
    expect(errors(FEATURE.replace('README explains the limit.', 'No new `TODO` markers; update the todo list.'))).toEqual([])
    expect(errors(FEATURE.replace('README explains the limit.', 'Fix FIXME'))).toEqual(['placeholder'])
  })

  test('strict mode adds Verify, unfilled-comment and size checks', () => {
    const noVerify = FEATURE.replace('- Verify: `rg -n "Rate limits" README.md`\n', '')
    expect(validatePlan(noVerify)).toEqual([])
    expect(codes(validatePlan(noVerify, { strict: true }))).toEqual(['missing-verify'])
    expect(codes(validatePlan(FEATURE.replace('Clients get 429.', '<!-- fill me -->'), { strict: true }))).toEqual(['unfilled'])
  })

  test('strict build checks: criteria count, oracle, false pass, task count', () => {
    const build = `---\ncreated: 2026-10-08\nstatus: PENDING\napproved: false\nworktree: false\ntype: Build\nrounds: 0\n---\n# B\n\n## Acceptance Criteria\n| # | Criterion | Evidence | Status |\n|---|---|---|---|\n| C1 | a | b | open |\n| C2 (oracle) | a | b | open |\n\n## Tasks\n\n### Task 1: t\n\n**Objective:** o\n\n- [ ] Task 1 done\n`
    expect(validatePlan(build)).toEqual([])
    expect(codes(validatePlan(build, { strict: true })).sort()).toEqual(['criteria-count', 'missing-false-pass', 'task-count'])
    const twoOracles = build.replace('| C1 | a |', '| C1 (oracle) | a |')
    expect(codes(validatePlan(twoOracles, { strict: true }))).toContain('oracle-count')
  })

  test('strict build counts: the split rule outranks a band, so 7 criteria and 8 tasks pass; only too few or far too many warn', () => {
    const run = (criteria: number, tasks: number): string => {
      const rows = Array.from({ length: criteria }, (_, i) => `| C${i + 1}${i === 0 ? ' (oracle)' : ''} | claim ${i + 1} | check | open |`)
      const cards = Array.from({ length: tasks }, (_, i) => `### Task ${i + 1}: t${i + 1}\n\n**Objective:** o (C1).\n\n- [ ] Task ${i + 1} done\n`)
      return `---\ncreated: 2026-10-08\nstatus: PENDING\napproved: false\nworktree: false\ntype: Build\nrounds: 0\n---\n# B\n\n## Acceptance Criteria\n| # | Criterion | Evidence | Status |\n|---|---|---|---|\n${rows.join('\n')}\n\n**False pass:** a cached copy; C1 catches it.\n\n## Tasks\n\n${cards.join('\n')}`
    }
    expect(codes(validatePlan(run(7, 8), { strict: true }))).toEqual([])
    expect(codes(validatePlan(run(10, 12), { strict: true }))).toEqual([])
    expect(codes(validatePlan(run(2, 3), { strict: true }))).toEqual(['criteria-count'])
    const tooMany = validatePlan(run(11, 13), { strict: true })
    expect(codes(tooMany)).toEqual(['criteria-count', 'task-count'])
    expect(tooMany[0]?.message).toContain('never merge or drop a real criterion')
  })

  test('planCriteria reads the C-rows of the criteria table: verdict, oracle mark and line', () => {
    const md = `---\ntype: Build\n---\n# B\n\n## Acceptance Criteria\n| # | Criterion | Evidence | Status |\n|---|---|---|---|\n| C1 | a | b | pass |\n| c2 | a | b | FAIL, not achievable: the API has no webhook |\n| C3 (oracle) | a | b | open |\n| note | not a criterion | x | pass |\n\n\`\`\`\n| C9 | in a fence | x | pass |\n\`\`\`\n\n## Rounds\n| C7 | elsewhere | x | fail |\n`
    expect(planCriteria(md)).toEqual([
      { id: 'C1', status: 'pass', oracle: false, line: 9 },
      { id: 'C2', status: 'fail', oracle: false, line: 10 },
      { id: 'C3', status: 'open', oracle: true, line: 11 },
    ])
    expect(planCriteria('# none\n')).toEqual([])
    expect(planCriteria(undefined as unknown as string)).toEqual([])
  })

  test('criteriaTable strips emphasis, keeps a header-less first row and lists the rows it cannot read', () => {
    const head = '---\ntype: Build\n---\n# B\n\n## Acceptance Criteria\n'
    const t = criteriaTable(`${head}| **C1** | a | b | **pass** |\n| C2 **(oracle)** | a | b | \`fail\` |\n| note | x | y | pass |\n| C4 |\n`)
    expect(t.criteria).toEqual([
      { id: 'C1', status: 'pass', oracle: false, line: 7 },
      { id: 'C2', status: 'fail', oracle: true, line: 8 },
    ])
    expect(t.unread).toEqual([{ line: 9, text: '| note | x | y | pass |' }, { line: 10, text: '| C4 |' }])
    expect(criteriaTable(`${head}| # | Criterion | Status |\n|-|:-:|-:|\n| C1 | a | pass |\n`)).toEqual({ criteria: [{ id: 'C1', status: 'pass', oracle: false, line: 9 }], unread: [] })
    expect(criteriaTable(`${head}| # | Criterion | Status |\n| C1 | a | pass |\n`).unread).toEqual([{ line: 7, text: '| # | Criterion | Status |' }])
    const build = `---\ncreated: 2026-10-08\nstatus: PENDING\napproved: false\nworktree: false\ntype: Build\nrounds: 0\n---\n# B\n\n## Acceptance Criteria\n| # | Criterion | Evidence | Status |\n|---|---|---|---|\n| C1 | a | b | open |\n| Second | a | b | open |\n| C3 (oracle) | a | b | open |\n\n**False pass:** a cached copy.\n\n## Tasks\n\n### Task 1: t\n\n**Objective:** o\n\n- [ ] Task 1 done\n\n### Task 2: t\n\n**Objective:** o\n\n- [ ] Task 2 done\n\n### Task 3: t\n\n**Objective:** o\n\n- [ ] Task 3 done\n`
    expect(validatePlan(build, { strict: true }).map(f => [f.code, f.line])).toEqual([['criteria-row', 15]])
  })

  test('the build skeleton asks for an Out of Scope section', () => {
    const skel = planSkeleton({ type: 'Build', title: 't', created: '2026-10-08' })
    expect(skel).toMatch(/\*\*False pass:\*\*.*\n\n## Out of Scope\n<!-- .* "None\." -->\n\n## Tasks/)
  })

  test('strict bugfix checks need the behavior contract and root cause sections', () => {
    const bug = FEATURE.replace('type: Feature', 'type: Bugfix')
    expect(codes(validatePlan(bug, { strict: true }))).toEqual(['missing-section', 'missing-section'])
  })

  test('never throws and handles empty input', () => {
    expect(codes(validatePlan(''))).toEqual(['empty'])
    expect(codes(validatePlan(undefined as unknown as string))).toEqual(['empty'])
    for (const s of ['---', '---\n---', '# x\n```\nunclosed', '---\nstatus: [\n---\n', '### Task 1:\n'.repeat(1000)]) expect(() => validatePlan(s, { strict: true })).not.toThrow()
  })

  test('every finding has a level, a code and a message; lines are 1-based', () => {
    const bad = '---\nstatus: X\n---\n\n## Tasks\n### Task 2: x\n'
    for (const f of validatePlan(bad, { strict: true })) {
      expect(['error', 'warning', 'info']).toContain(f.level)
      expect(f.code).toMatch(/^[a-z-]+$/)
      expect(f.message.length).toBeGreaterThan(5)
      if (f.line !== undefined) expect(f.line).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('validatePlan: plan-build authoring checks', () => {
  const task1Dod = '- The 101st request gets 429.'
  const at = (md: string, code: string) => validatePlan(md, { strict: true }).filter(f => f.code === code)

  test('files-incomplete: a path an Objective, DoD or Verify line names that no task lists is a warning, also without --strict', () => {
    const md = FEATURE.replace(task1Dod, `${task1Dod}\n- The limit is read from \`config/limits.yaml\`.`)
    const f = at(md, 'files-incomplete')
    expect(f.map(x => [x.level, x.line])).toEqual([['warning', 27]])
    expect(f[0]?.message).toContain('`config/limits.yaml`')
    expect(f[0]?.message).toContain('Task 1')
    expect(codes(validatePlan(md))).toEqual(['files-incomplete'])
    const viaVerify = FEATURE.replace('- Verify: `rg -n "Rate limits" README.md`', '- Verify: `bun test tests/docs/readme.test.ts`')
    expect(at(viaVerify, 'files-incomplete').map(x => x.message)).toEqual([expect.stringContaining('tests/docs/readme.test.ts')])
    const inObjective = FEATURE.replace('**Objective:** README explains the limit.', '**Objective:** User action: copy `.github/workflows/ci.yml` to the org settings.')
    expect(at(inObjective, 'files-incomplete')).toHaveLength(1)
  })

  test('files-incomplete is union-scoped and exempts path:line, routes, hosts, directories without a slash and tech names', () => {
    const otherTask = FEATURE.replace('README explains the limit.', 'README explains the limit set in `src/middleware/rate-limit.ts`.')
    expect(at(otherTask, 'files-incomplete')).toEqual([])
    for (const text of ['`src/server.ts:41`', '`GET /api/items/:id`', '`curl -s localhost:3000/invoices/42`', '`bun test tests/middleware`', 'runs on `Node.js` 20', '`https://example.com/a.ts`', '`plan.worktreeDir`', '`server.ts`', '`tests/middleware/`']) {
      const md = FEATURE.replace(task1Dod, `${task1Dod}\n- Uses ${text}.`)
      expect({ text, found: at(md, 'files-incomplete').length }).toEqual({ text, found: 0 })
    }
    const unknownDir = FEATURE.replace(task1Dod, `${task1Dod}\n- Docs live in \`docs/limits/\`.`)
    expect(at(unknownDir, 'files-incomplete')).toHaveLength(1)
    const listedDir = unknownDir.replace('- Modify: README.md', '- Modify: README.md\n- Create: `docs/limits/`')
    expect(at(listedDir.replace('Docs live in `docs/limits/`.', 'Docs live in `docs/limits/overview.md`.'), 'files-incomplete')).toEqual([])
  })

  test('files-incomplete: a script a Verify command only runs is exempt; a test file handed to a test runner is not', () => {
    const verify = (cmd: string) => at(FEATURE.replace('- Verify: `rg -n "Rate limits" README.md`', `- Verify: \`${cmd}\``), 'files-incomplete').map(x => x.message.match(/`([^`]+)`/)?.[1])
    expect(verify('bun scripts/check.ts && bun test tests/y.test.ts')).toEqual(['tests/y.test.ts'])
    expect(verify('CI=1 python3 -u tools/smoke.py; ./scripts/e2e.sh --fast | head -5')).toEqual([])
    expect(verify('scripts/e2e.sh')).toEqual(['scripts/e2e.sh'])
    expect(verify('bun run scripts/build.ts')).toEqual([])
    expect(verify('python -m pytest tests/test_limit.py')).toEqual(['tests/test_limit.py'])
    expect(verify('rg -n limit docs/limits.md')).toEqual(['docs/limits.md'])
    const block = FEATURE.replace('- Verify: `rg -n "Rate limits" README.md`', '- Verify:\n  ```bash\n  bash scripts/smoke.sh\n  cat config/limits.yaml\n  ```')
    expect(at(block, 'files-incomplete').map(x => x.message.match(/`([^`]+)`/)?.[1])).toEqual(['config/limits.yaml'])
    const inDod = FEATURE.replace(task1Dod, `${task1Dod}\n- \`bun scripts/check.ts\` passes.`)
    expect(at(inDod, 'files-incomplete')).toHaveLength(1)
    expect(at(FEATURE.replace('- Verify: `rg -n "Rate limits" README.md`', '- Verify: `bun test tests/y.test.ts`'), 'files-incomplete')[0]?.message).toContain('`Test:` for a test the task runs but does not change')
  })

  test('files-incomplete: a rename line lists both of its paths', () => {
    const md = FEATURE.replace('- Modify: README.md', '- Rename: `docs/old.md` -> `docs/limits.md`').replace('README explains the limit.', 'Move `docs/old.md` to `docs/limits.md`.').replace('README.md`', 'docs/limits.md`')
    expect(at(md, 'files-incomplete')).toEqual([])
    expect(parsePlan(md).tasks[1]?.files).toEqual([{ verb: 'Rename', path: 'docs/old.md` -> `docs/limits.md' }])
  })

  test('vague-placeholder: filler in a task card is a warning, elsewhere an info, after-run sections and code are skipped', () => {
    const inCard = FEATURE.replace('README explains the limit.', 'README explains the limit; handle edge cases.')
    expect(at(inCard, 'vague-placeholder').map(f => [f.level, f.line])).toEqual([['warning', 33]])
    expect(at(FEATURE.replace(task1Dod, `${task1Dod}\n- Add appropriate error handling.`), 'vague-placeholder')[0]?.level).toBe('warning')
    expect(at(FEATURE.replace('README explains the limit.', 'Same as Task 1, for the docs.'), 'vague-placeholder')).toHaveLength(1)
    expect(at(FEATURE.replace('Clients get 429.', 'Clients get 429; details below.'), 'vague-placeholder').map(f => f.level)).toEqual(['info'])
    expect(at(FEATURE.replace('## Deviations\n- none', '## Follow-ups\n- Retry budgets: implement later.'), 'vague-placeholder')).toEqual([])
    expect(at(FEATURE.replace('README explains the limit.', 'README quotes `handle edge cases` from the old docs.'), 'vague-placeholder')).toEqual([])
  })

  test('vague-placeholder recognizes the Turkish forms of the same filler', () => {
    for (const text of ["Task 1'deki gibi yap.", 'Uç durumları ele al.', 'Uygun hata yönetimi ekle.', 'Ayrıntıları sonra doldur.', 'Daha sonra uygulanacak.', 'Görev 1 ile benzer şekilde.']) {
      const md = FEATURE.replace('README explains the limit.', text)
      expect({ text, levels: at(md, 'vague-placeholder').map(f => f.level) }).toEqual({ text, levels: ['warning'] })
    }
    for (const text of ['Task 1 ile aynı dosyayı okur.', 'Sınır değeri 100 istektir.', 'Sonradan eklenen anahtarlar sayılmaz.']) {
      expect({ text, n: at(FEATURE.replace('README explains the limit.', text), 'vague-placeholder').length }).toEqual({ text, n: 0 })
    }
  })

  test('inventory-unmapped: every Inventory row names an existing task or a reason for dropping it', () => {
    const inv = (rows: string) => `${FEATURE}\n## Inventory\n| Replaced | Kept by | Reason if dropped |\n|---|---|---|\n${rows}\n`
    expect(at(inv('| `GET /v1/limits` | Task 1 | |\n| `--legacy` flag | | unused since 2024 |\n| `oldLimit()` | 2 | |'), 'inventory-unmapped')).toEqual([])
    const f = at(inv('| `GET /v1/limits` | | |\n| `--legacy` flag | Task 7 | |\n| `x` | - | - |'), 'inventory-unmapped')
    expect(f.map(x => x.message)).toEqual([expect.stringContaining('"GET /v1/limits" names no task'), expect.stringContaining('Task 7, which the plan does not have'), expect.stringContaining('"x" names no task')])
    expect(f.every(x => x.level === 'warning')).toBe(true)
    expect(at(`${FEATURE}\n## Inventory\nNothing is replaced.\n`, 'inventory-unmapped')).toEqual([])
  })

  test('identifier-drift is an info that never fails --strict', () => {
    const md = FEATURE.replace('Middleware counts requests per key.', 'Middleware `clearLayers` counts requests per key.').replace('README explains the limit.', 'README explains `clear_layers` and `createServer` next to `createServr`, `rateLimiters` and `rateLimiter`.')
    const f = at(md, 'identifier-drift')
    expect(f.map(x => x.level)).toEqual(['info', 'info'])
    expect(f.map(x => x.message)).toEqual([expect.stringContaining('`clearLayers` and `clear_layers`'), expect.stringContaining('`createServer` and `createServr`')])
    expect(validatePlan(md, { strict: true }).filter(x => x.level !== 'info')).toEqual([])
  })

  test('identifier-drift stays bounded: at most 5 findings, and only the first 400 names are compared', () => {
    const letters = (i: number) => [i % 26, Math.floor(i / 26) % 26].map(c => String.fromCharCode(97 + c)).join('')
    const many = Array.from({ length: 600 }, (_, i) => `handleRequestFor${letters(i)}Value`)
    const md = FEATURE.replace('README explains the limit.', `README lists ${many.map(n => `\`${n}\``).join(', ')}.`)
    const f = at(md, 'identifier-drift')
    expect(f).toHaveLength(5)
    const after = (n: number) => FEATURE.replace('README explains the limit.', `README lists ${[...Array.from({ length: n }, (_, i) => `name${i}`), 'clearLayers', 'clear_layers'].map(x => `\`${x}\``).join(', ')}.`)
    expect(at(after(100), 'identifier-drift').map(x => x.message)).toEqual([expect.stringContaining('`clearLayers` and `clear_layers`')])
    expect(at(after(420), 'identifier-drift')).toEqual([])
  })

  test('the checks apply to Feature and Bugfix plans only; the skills\' own examples pass them in strict mode', () => {
    const build = `---\ncreated: 2026-10-08\nstatus: APPROVED\napproved: true\nworktree: false\ntype: Build\nrounds: 1\n---\n# Offline notes\n\n## Tasks\n\n### Task 1: Queue writes\n\n**Objective:** Writes go to \`src/queue.ts\`; handle edge cases.\n\n- [ ] Task 1 done\n`
    expect(codes(validatePlan(build, { strict: true })).filter(c => ['files-incomplete', 'vague-placeholder'].includes(c))).toEqual([])
    for (const file of ['skills/plan-build/references/plan.md', 'skills/plan-build/references/bugfix-plan.md']) {
      const md = skillExample(file)
      expect({ file, findings: validatePlan(md, { strict: true }) }).toEqual({ file, findings: [] })
    }
  })
})

function fill(md: string): string {
  return md.replace(/<!--[\s\S]*?-->/g, 'Filled in.').replace('Create: Filled in.', 'Create: `src/x.ts`').replace(/(Test|Modify): Filled in\./g, '$1: `src/x.ts`')
}

describe('planSkeleton', () => {
  test.each(PLAN_TYPES.map(t => [t]))('%s skeleton has a valid structure and uses LF', (type) => {
    const md = planSkeleton({ type: type as PlanType, title: 'Add rate limiting', created: '2026-10-08' })
    expect(md.includes('\r')).toBe(false)
    expect(md.endsWith('\n')).toBe(true)
    expect(codes(validatePlan(md))).toEqual(type === 'Plan' ? [] : ['unfilled'])
    const p = parsePlan(md)
    expect(p.header.type).toBe(type as PlanType)
    expect(p.header.created).toBe('2026-10-08')
    expect(p.title).toBe('Add rate limiting')
  })

  test.each([['Feature'], ['Bugfix'], ['Build']])('an unfilled %s skeleton fails the non-strict validation H11 uses', (type) => {
    const md = planSkeleton({ type: type as PlanType, title: 'Add rate limiting', created: '2026-10-08' })
    const f = validatePlan(md).find(x => x.code === 'unfilled')
    expect(f?.level).toBe('error')
    expect(f?.message).toContain('buracle plan init')
    expect(f?.line).toBeGreaterThan(8)
    expect(validatePlan(md, { strict: true }).filter(x => x.level === 'error').map(x => x.code)).toEqual(['unfilled'])
  })

  test.each([['Feature'], ['Bugfix'], ['Build']])('a filled %s skeleton has no errors', (type) => {
    const md = fill(planSkeleton({ type: type as PlanType, title: 'Add rate limiting', created: '2026-10-08' }))
    expect(md).not.toContain('<!--')
    expect(validatePlan(md).filter(f => f.level === 'error')).toEqual([])
  })

  test('each placeholder left counts; other comments are only a --strict warning', () => {
    const md = planSkeleton({ type: 'Feature', title: 'X', created: '2026-10-08' })
    const all = md.match(/<!--/g)?.length ?? 0
    const one = fill(md).replace('## Risks\nFilled in.', '## Risks\n<!-- or "None." -->')
    expect(validatePlan(one).find(f => f.code === 'unfilled')?.message).toStartWith('1 placeholder from')
    expect(validatePlan(md).find(f => f.code === 'unfilled')?.message).toStartWith(`${all} placeholders`)
    const own = fill(md).replace('## Risks\nFilled in.', '## Risks\n<!-- prettier-ignore -->\nNone.')
    expect(validatePlan(own)).toEqual([])
    expect(validatePlan(own, { strict: true }).map(f => [f.code, f.level])).toEqual([['unfilled', 'warning']])
    expect(validatePlan(fill(md) + '\n```\n<!-- an observable outcome -->\n```\n')).toEqual([])
  })

  test('the captured-plan skeleton (type Plan) stays valid: H12 replaces its placeholder', () => {
    const md = planSkeleton({ type: 'Plan', title: 'Captured', created: '2026-10-08' })
    expect(validatePlan(md)).toEqual([])
    expect(codes(validatePlan(md, { strict: true }), 'warning')).toEqual(['unfilled'])
  })

  test('feature/bugfix/build skeletons start PENDING and unapproved; the captured kind is SAVED', () => {
    expect(parsePlan(planSkeleton({ type: 'Feature', title: 't', created: '2026-10-08' })).header).toEqual({ created: '2026-10-08', status: 'PENDING', approved: false, worktree: false, type: 'Feature', iterations: 0 })
    expect(parsePlan(planSkeleton({ type: 'Build', title: 't', created: '2026-10-08' })).header).toEqual({ created: '2026-10-08', status: 'PENDING', approved: false, worktree: false, type: 'Build', rounds: 0 })
    expect(parsePlan(planSkeleton({ type: 'Plan', title: 't', created: '2026-10-08' })).header.status).toBe('SAVED')
  })

  test('a bugfix skeleton has the three standard tasks; validation flags what is still unfilled', () => {
    const md = planSkeleton({ type: 'Bugfix', title: 'Fix: totals drop the last item', created: '2026-10-08' })
    expect(parsePlan(md).tasks.map(t => t.title)).toEqual(['Reproduce the bug in a failing test', 'Fix the root cause', 'Quality gate'])
    expect(parsePlan(md).sections).toEqual(['Behavior Contract', 'Root Cause', 'Context', 'Tasks', 'Risks', 'Assumptions'])
    expect(codes(validatePlan(md, { strict: true }), 'error')).toEqual(['unfilled'])
    expect(codes(validatePlan(md), 'error')).toEqual(['unfilled'])
  })

  test('titles are made single-line; awkward titles stay valid YAML-free Markdown', () => {
    const md = planSkeleton({ type: 'Feature', title: '  Fix: "quotes"\nand: colons  ', created: '2026-10-08' })
    expect(parsePlan(md).title).toBe('Fix: "quotes" and: colons')
    expect(planSkeleton({ type: 'Feature', title: '', created: '2026-10-08' })).toContain('# Untitled plan')
  })
})

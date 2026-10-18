import { describe, expect, test } from 'bun:test'
import { auditPlan, parseNameStatus, type DiffEntry } from '../../../src/core/plan/audit'

function plan(o: { task2Done?: boolean, extra?: string } = {}): string {
  return [
    '---', 'created: 2026-10-08', 'status: COMPLETE', 'approved: true', 'worktree: false', 'type: Feature', 'iterations: 0', '---',
    '# Move the parser', '', '## Tasks', '',
    '### Task 1: Split the parser', '', '**Objective:** The parser lives in its own module.', '', '**Files:**',
    '- Create: `src/a.ts`', '- Modify: `src/b.ts`', '- Test: `tests/a.test.ts`', '- Delete: `src/old.ts`', '- Rename: `src/x.ts` -> `src/y.ts`', '',
    '**Definition of Done:**', '- Verify: `bun test tests/a.test.ts`', '', '- [x] Task 1 done', '',
    '### Task 2: Add the cache', '', '**Objective:** Parsed files are cached.', '', '**Files:**', '- Create: `src/c.ts`', '',
    '**Definition of Done:**', '- Verify: `bun test`', '', `- [${o.task2Done === true ? 'x' : ' '}] Task 2 done`, '',
    ...(o.extra !== undefined ? [o.extra, ''] : []),
  ].join('\n')
}

const DONE: DiffEntry[] = [
  { status: 'A', path: 'src/a.ts' },
  { status: 'M', path: 'src/b.ts' },
  { status: 'A', path: 'tests/a.test.ts' },
  { status: 'D', path: 'src/old.ts' },
  { status: 'R', path: 'src/y.ts', from: 'src/x.ts' },
  { status: 'M', path: 'docs/plans/2026-10-08-parser.md' },
]
const ON_DISK = new Set(['src/a.ts', 'src/b.ts', 'tests/a.test.ts', 'src/y.ts', 'src/stray.ts', 'src/helper.ts', 'src/c.ts'])
const exists = (p: string) => ON_DISK.has(p)
const codes = (fs: ReturnType<typeof auditPlan>) => fs.map(f => `${f.level} ${f.code}${f.path !== undefined ? ` ${f.path}` : ''}`)

describe('parseNameStatus', () => {
  test('reads git diff --name-status -z output, renames and copies with both paths', () => {
    expect(parseNameStatus('M\0src/a.ts\0R100\0src/x.ts\0src/y.ts\0D\0old file.md\0C75\0a\0b\0')).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'src/y.ts', from: 'src/x.ts' },
      { status: 'D', path: 'old file.md' },
      { status: 'C', path: 'b', from: 'a' },
    ])
    expect(parseNameStatus('')).toEqual([])
  })
})

describe('auditPlan', () => {
  test('a diff that does what the plan says has no warnings; an unticked task reports as info', () => {
    const f = auditPlan(plan(), DONE, { exists })
    expect(codes(f)).toEqual(['info unimplemented src/c.ts'])
    expect(f[0]?.message).toContain('not ticked yet')
    expect(auditPlan(plan({ task2Done: true }), [...DONE, { status: 'A', path: 'src/c.ts' }], { exists })).toEqual([])
  })

  test('unimplemented: an unchanged Modify, a missing Create, a deleted Modify, a Test path that does not exist', () => {
    const changes = DONE.filter(c => c.path !== 'src/b.ts' && c.path !== 'src/a.ts' && c.path !== 'tests/a.test.ts')
    const gone = (p: string) => p !== 'src/a.ts' && p !== 'tests/a.test.ts' && exists(p)
    expect(codes(auditPlan(plan(), changes, { exists: gone }))).toEqual([
      'warning unimplemented src/a.ts', 'warning unimplemented src/b.ts', 'warning unimplemented tests/a.test.ts', 'info unimplemented src/c.ts',
    ])
    const deleted = auditPlan(plan(), [...changes, { status: 'D', path: 'src/b.ts' }], { exists: gone })
    expect(deleted.find(x => x.path === 'src/b.ts')?.message).toContain('the diff deletes it')
  })

  test('a Test path the diff leaves alone is only info while the file exists, so a planned extension that never happened still shows', () => {
    const f = auditPlan(plan({ task2Done: true }), [...DONE.filter(c => c.path !== 'tests/a.test.ts'), { status: 'A', path: 'src/c.ts' }], { exists })
    expect(codes(f)).toEqual(['info unimplemented tests/a.test.ts'])
    expect(f[0]?.message).toBe('Task 1: Test `tests/a.test.ts` is unchanged; fine when the task only runs it')
    expect(f.filter(x => x.level === 'warning')).toEqual([])
  })

  test('delete-pending: the file still exists, or the diff never deletes it', () => {
    const still = auditPlan(plan(), DONE.filter(c => c.path !== 'src/old.ts'), { exists: p => p === 'src/old.ts' || exists(p) })
    expect(codes(still)).toContain('warning delete-pending src/old.ts')
    expect(still.find(x => x.code === 'delete-pending')?.message).toContain('still exists')
    const never = auditPlan(plan(), DONE.filter(c => c.path !== 'src/old.ts'), { exists })
    expect(never.find(x => x.code === 'delete-pending')?.message).toContain('does not delete it')
  })

  test('rename-mismatch: the old path is left, the new one is missing, or the diff shows no rename', () => {
    const noRename = DONE.filter(c => c.status !== 'R')
    const both = auditPlan(plan(), noRename, { exists: p => p === 'src/x.ts' || exists(p) })
    expect(both.find(x => x.code === 'rename-mismatch')?.message).toContain('`src/x.ts` still exists')
    const missing = auditPlan(plan(), noRename, { exists: p => p !== 'src/y.ts' && exists(p) })
    expect(missing.find(x => x.code === 'rename-mismatch')?.message).toContain('`src/y.ts` does not exist')
    const viaAddDelete = [...noRename, { status: 'D', path: 'src/x.ts' }, { status: 'A', path: 'src/y.ts' }]
    expect(auditPlan(plan(), viaAddDelete, { exists }).filter(x => x.code === 'rename-mismatch')).toEqual([])
    const single = plan().replace('- Rename: `src/x.ts` -> `src/y.ts`', '- Rename: `src/x.ts`')
    expect(auditPlan(single, DONE, { exists }).filter(x => x.code === 'rename-mismatch')).toEqual([])
    expect(codes(auditPlan(single, noRename, { exists }))).toContain('warning rename-mismatch src/x.ts')
  })

  test('unplanned: a changed path no task and no Deviations line names; plan files and ignored paths never count', () => {
    const changes = [...DONE, { status: 'M', path: 'src/stray.ts' }, { status: 'A', path: 'src/helper.ts' }, { status: 'M', path: 'notes/plan.md' }]
    expect(codes(auditPlan(plan(), changes, { exists, ignore: ['notes/plan.md'] }))).toEqual([
      'info unimplemented src/c.ts', 'warning unplanned src/stray.ts', 'warning unplanned src/helper.ts',
    ])
    const withDeviation = plan({ extra: '## Deviations\n- Task 1: split parsing into src/helper.ts (files: src/helper.ts)\n- Task 1: also touched `src/stray.ts` for the import' })
    expect(codes(auditPlan(withDeviation, changes, { exists, ignore: ['notes/plan.md'] }))).toEqual(['info unimplemented src/c.ts'])
    const underDir = plan().replace('- Create: `src/c.ts`', '- Create: `src/cache/`')
    expect(auditPlan(underDir, [...DONE, { status: 'A', path: 'src/cache/index.ts' }], { exists }).filter(x => x.code !== 'inventory-open')).toEqual([])
  })

  test('inventory-open: a row kept by an unticked or missing task, or with no task and no reason', () => {
    const inv = plan({ extra: '## Inventory\n| Replaced | Kept by | Reason if dropped |\n|---|---|---|\n| `parseOld()` | Task 1 | |\n| cache flag | Task 2 | |\n| `--fast` | Task 9 | |\n| `--legacy` | | unused |\n| `x` | | |' })
    expect(auditPlan(inv, DONE, { exists }).filter(x => x.code === 'inventory-open').map(x => x.message)).toEqual([
      expect.stringContaining('"cache flag" is kept by Task 2, which is not ticked'),
      expect.stringContaining('"--fast" names Task 9'),
      expect.stringContaining('"x" names no task'),
    ])
  })
})

import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { runPlan } from '../../src/cli/commands/plan'
import { planRegister } from '../../src/workflow/plan'
import { planAudit } from '../../src/workflow/plan-audit'
import { worktreeCreate } from '../../src/workflow/worktree'
import { worktreeBranch } from '../../src/workflow/worktree-branch'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { SESSION, ctxAt, g, makeRepo, memIO, write } from './fixture'

function sandbox(fn: (root: string) => Promise<void>): Promise<void> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

function planText(files: string[], done = true): string {
  return [
    '---', 'created: 2026-10-08', `status: ${done ? 'COMPLETE' : 'IN_PROGRESS'}`, 'approved: true', 'worktree: false', 'type: Feature', 'iterations: 0', '---',
    '# Rate limit', '', '## Tasks', '', '### Task 1: Count requests', '', '**Objective:** Count requests per key.', '', '**Files:**',
    ...files.map(f => `- ${f}`), '', '**Definition of Done:**', '- Verify: `bun test`', '', `- [${done ? 'x' : ' '}] Task 1 done`, '',
  ].join('\n')
}

interface AuditJson { ok: boolean, mode: string, diff_range: string, changed: number, findings: Array<{ level: string, code: string, path?: string }> }

describe('buracle plan audit', () => {
  test('working-tree mode: untracked and modified files count, the plan file itself never does', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(plan, planText(['Modify: `src/app.ts`', 'Create: `src/limit.ts`']))
    write(join(repo, 'src', 'app.ts'), 'export const a = 2\n')
    write(join(repo, 'src', 'limit.ts'), 'export const limit = 100\n')
    write(join(repo, 'src', 'extra.ts'), 'export const extra = 1\n')
    const r = await planAudit(plan, {}, ctxAt(repo), undefined)
    expect(r.code).toBe(2)
    const data = r.data as unknown as AuditJson
    expect(data).toMatchObject({ ok: false, mode: 'working-tree', diff_range: 'HEAD' })
    expect(data.findings.map(f => `${f.level} ${f.code} ${f.path ?? ''}`)).toEqual(['warning unplanned src/extra.ts'])
    expect(r.lines.at(-1)).toContain('1 warning(s)')
    rmSync(join(repo, 'src', 'extra.ts'))
    const clean = await planAudit(plan, {}, ctxAt(repo), undefined)
    expect(clean.code).toBe(0)
    expect(clean.data).toMatchObject({ ok: true, findings: [] })
  }))

  test('worktree mode through the session: a planned Delete must show as D, and existence is read in the worktree', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(plan, planText(['Delete: `README.md`', 'Modify: `src/app.ts`']))
    await planRegister(plan, undefined, ctxAt(repo), SESSION)
    const wt = String((await worktreeCreate('rate-limit', {}, ctxAt(repo), SESSION)).data['path'])
    write(join(wt, 'src', 'app.ts'), 'export const a = 3\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task 1: modify app')
    const pending = await planAudit(undefined, {}, ctxAt(repo), SESSION)
    expect(pending.code).toBe(2)
    expect((pending.data as unknown as AuditJson)).toMatchObject({ mode: 'worktree', diff_range: 'main...plan-build/rate-limit' })
    expect((pending.data as unknown as AuditJson).findings.map(f => f.code)).toEqual(['delete-pending'])
    await g(wt, 'rm', '-q', 'README.md')
    await g(wt, 'commit', '-q', '-m', 'task 1: drop readme')
    const done = await planAudit(undefined, {}, ctxAt(repo), SESSION)
    expect(done.code).toBe(0)
    expect((done.data as unknown as AuditJson).changed).toBe(2)
  }))

  test('branch mode with HEAD elsewhere: existence is read in the branch tree, not in the checkout', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(root, 'plans', '2026-10-08-rate-limit.md')
    write(plan, planText(['Delete: `README.md`', 'Create: `src/limit.ts`', 'Modify: `src/app.ts`']))
    await worktreeBranch('rate-limit', {}, ctxAt(repo), undefined)
    await g(repo, 'rm', '-q', 'README.md')
    write(join(repo, 'src', 'limit.ts'), 'export const limit = 100\n')
    write(join(repo, 'src', 'app.ts'), 'export const a = 2\n')
    await g(repo, 'add', '-A')
    await g(repo, 'commit', '-q', '-m', 'task 1')
    await g(repo, 'checkout', '-q', 'main')
    const r = await planAudit(plan, { slug: 'rate-limit' }, ctxAt(repo), undefined)
    expect(r.data).toMatchObject({ mode: 'branch', diff_range: 'main...plan-build/rate-limit', findings: [] })
    expect(r.code).toBe(0)
  }))

  test('the CLI: exit codes, --json, usage errors, and no plan without a path or a session', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(plan, planText(['Modify: `src/app.ts`']))
    const io = memIO(true)
    expect(await runPlan(['audit', plan], io, ctxAt(repo))).toBe(2)
    expect(io.json<AuditJson>().findings.map(f => f.code)).toEqual(['unimplemented'])
    const none = memIO(true)
    expect(await runPlan(['audit'], none, ctxAt(repo))).toBe(1)
    expect(none.json<{ error: string }>().error).toBe('usage')
    expect(await runPlan(['audit', plan, 'extra'], memIO(), ctxAt(repo))).toBe(1)
    expect(await runPlan(['audit', plan, '--base', 'no-such-ref'], memIO(), ctxAt(repo))).toBe(1)
    expect(await runPlan(['audit', join(repo, 'missing.md')], memIO(), ctxAt(repo))).toBe(1)
  }))
})

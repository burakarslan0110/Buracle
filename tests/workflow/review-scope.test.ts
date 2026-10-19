import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { planRegister } from '../../src/workflow/plan'
import { reviewScope } from '../../src/workflow/review-scope'
import { worktreeCreate } from '../../src/workflow/worktree'
import { worktreeBranch } from '../../src/workflow/worktree-branch'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { SESSION, ctxAt, g, makeRepo, planDoc, write } from './fixture'

function sandbox(fn: (root: string) => Promise<void>): Promise<void> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1' }, () => fn(root)))
}

async function commit(dir: string, file: string, content: string, msg: string): Promise<void> {
  write(join(dir, file), content)
  await g(dir, 'add', '-A')
  await g(dir, 'commit', '-q', '-m', msg)
}

describe('review-scope', () => {
  test('worktree mode via --slug, the current directory, or the session plan', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(plan, planDoc({ status: 'IN_PROGRESS', approved: true }))
    await planRegister(plan, undefined, ctxAt(repo), SESSION)
    const wt = String((await worktreeCreate('rate-limit', {}, ctxAt(repo), SESSION)).data['path'])
    await commit(wt, 'src/limit.ts', 'x\n', 'task 1')

    const bySlug = await reviewScope('rate-limit', ctxAt(repo), undefined)
    expect(bySlug.code).toBe(0)
    expect(bySlug.data).toMatchObject({ mode: 'worktree', base_ref: 'main', diff_range: 'main...plan-build/rate-limit', worktree_path: wt, ahead: 1 })
    expect(bySlug.data['warning']).toBeUndefined()
    expect((await g(repo, 'diff', '--name-only', String(bySlug.data['diff_range'])))).toBe('src/limit.ts')

    expect((await reviewScope(undefined, ctxAt(join(wt, 'src')), undefined)).data).toMatchObject({ mode: 'worktree', diff_range: 'main...plan-build/rate-limit' })
    expect((await reviewScope(undefined, ctxAt(repo), SESSION)).data).toMatchObject({ mode: 'worktree' })

    write(join(wt, 'src', 'wip.ts'), 'wip\n')
    const dirty = await reviewScope('rate-limit', ctxAt(repo), undefined)
    expect(String(dirty.data['warning'])).toContain('uncommitted')
  }))

  test("the session plan finds its worktree through the recorded plan path, whatever the worktree's slug", () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plans', '2026-10-08-odeme-sayfasi.md')
    write(plan, planDoc({ status: 'IN_PROGRESS', approved: true }))
    await planRegister(plan, undefined, ctxAt(repo), SESSION)
    const wt = String((await worktreeCreate('cache-work', {}, ctxAt(repo), SESSION)).data['path'])
    await commit(wt, 'src/cache.ts', 'c\n', 'task 1')
    expect((await reviewScope(undefined, ctxAt(repo), SESSION)).data).toMatchObject({ mode: 'worktree', slug: 'cache-work', diff_range: 'main...plan-build/cache-work' })
  }))

  test('branch mode on a clean feature branch; working-tree mode once it has uncommitted changes', () => sandbox(async root => {
    const repo = await makeRepo(root)
    await g(repo, 'checkout', '-q', '-b', 'feature')
    await commit(repo, 'src/f.ts', 'f\n', 'feature work')
    await commit(repo, 'src/g.ts', 'g\n', 'more work')
    const clean = await reviewScope(undefined, ctxAt(repo), undefined)
    expect(clean.data).toMatchObject({ mode: 'branch', base_ref: 'main', diff_range: 'main...feature', ahead: 2 })
    expect(clean.data['warning']).toBeUndefined()

    await g(repo, 'checkout', '-q', 'main')
    await commit(repo, 'other.txt', 'o\n', 'main work')
    await g(repo, 'checkout', '-q', 'feature')
    expect(await g(repo, 'diff', '--name-only', 'main...feature')).toBe('src/f.ts\nsrc/g.ts')

    write(join(repo, 'src', 'f.ts'), 'f2\n')
    write(join(repo, 'new.ts'), 'n\n')
    const dirty = await reviewScope(undefined, ctxAt(repo), undefined)
    const mb = await g(repo, 'merge-base', 'HEAD', 'main')
    expect(dirty.data).toMatchObject({ mode: 'working-tree', base_ref: mb, diff_range: mb, base_branch: 'main', ahead: 2, untracked: ['new.ts'] })
    expect((await g(repo, 'diff', '--name-only', mb))).toBe('src/f.ts\nsrc/g.ts')
  }))

  test('a branch made by worktree branch is diffed against its recorded base, not the default branch', () => sandbox(async root => {
    const repo = await makeRepo(root)
    await g(repo, 'checkout', '-q', '-b', 'feature-x')
    await commit(repo, 'src/parent.ts', 'p\n', 'parent work')
    await worktreeBranch('rate-limit', {}, ctxAt(repo), undefined)
    await commit(repo, 'src/limit.ts', 'l\n', 'task 1')
    const clean = await reviewScope(undefined, ctxAt(repo), undefined)
    expect(clean.data).toMatchObject({ mode: 'branch', base_ref: 'feature-x', diff_range: 'feature-x...plan-build/rate-limit', ahead: 1, slug: 'rate-limit' })
    expect(String(clean.data['note'])).toContain('created from feature-x')
    expect(await g(repo, 'diff', '--name-only', String(clean.data['diff_range']))).toBe('src/limit.ts')

    write(join(repo, 'src', 'wip.ts'), 'w\n')
    const dirty = await reviewScope(undefined, ctxAt(repo), undefined)
    expect(dirty.data).toMatchObject({ mode: 'working-tree', base_branch: 'feature-x', untracked: ['src/wip.ts'] })
    expect(await g(repo, 'diff', '--name-only', String(dirty.data['diff_range']))).toBe('src/limit.ts')

    expect((await reviewScope(undefined, ctxAt(repo), undefined, { base: 'main' })).data).toMatchObject({ base_branch: 'main', ahead: 2 })
    await g(repo, 'stash', '-q', '-u')
    await g(repo, 'checkout', '-q', 'main')
    const bySlug = await reviewScope('rate-limit', ctxAt(repo), undefined)
    expect(bySlug.data).toMatchObject({ mode: 'branch', diff_range: 'feature-x...plan-build/rate-limit', ahead: 1 })
    expect(String(bySlug.data['note'])).toContain('HEAD is not on it')
  }))

  test('on the default branch: working-tree against HEAD, with a warning when there is nothing to review', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const nothing = await reviewScope(undefined, ctxAt(repo), undefined)
    expect(nothing.data).toMatchObject({ mode: 'working-tree', base_ref: 'HEAD', diff_range: 'HEAD' })
    expect(String(nothing.data['warning'])).toContain('nothing to review')
    write(join(repo, 'src', 'app.ts'), 'changed\n')
    const dirty = await reviewScope(undefined, ctxAt(repo), undefined)
    expect(dirty.data).toMatchObject({ mode: 'working-tree', diff_range: 'HEAD', uncommitted: { tracked: 1, untracked: 0 } })
    expect(dirty.data['warning']).toBeUndefined()
  }))

  test('unpushed commits on main are reviewed against origin/main', () => sandbox(async root => {
    const upstream = await makeRepo(root, 'upstream')
    const clone = join(root, 'clone')
    await g(root, 'clone', '-q', upstream, clone)
    await g(clone, 'config', 'user.name', 'T')
    await g(clone, 'config', 'user.email', 't@example.com')
    await commit(clone, 'src/x.ts', 'x\n', 'local fix on main')
    const r = await reviewScope(undefined, ctxAt(clone), undefined)
    expect(r.data).toMatchObject({ mode: 'branch', base_ref: 'origin/main', diff_range: 'origin/main...main', ahead: 1 })
  }))

  test('a --slug without a worktree falls back to the checkout with a note; outside git is an error', () => sandbox(async root => {
    const repo = await makeRepo(root)
    write(join(repo, 'src', 'app.ts'), 'changed\n')
    const r = await reviewScope('ghost', ctxAt(repo), undefined)
    expect(r.data).toMatchObject({ mode: 'working-tree' })
    expect(String(r.data['note'])).toContain("no plan worktree for 'ghost'")
    expect(r.data['warning']).toBeUndefined()
    expect((await reviewScope(undefined, ctxAt(root), undefined)).code).toBe(1)
  }))

  test('a repository without commits warns', () => sandbox(async root => {
    const dir = join(root, 'empty')
    await g(root, 'init', '-q', '-b', 'main', dir)
    write(join(dir, 'a.txt'), 'a\n')
    const r = await reviewScope(undefined, ctxAt(dir), undefined)
    expect(r.data).toMatchObject({ mode: 'working-tree' })
    expect(String(r.data['warning'])).toContain('no commits')
  }))
})

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWorktree } from '../../src/cli/commands/worktree'
import { lockTestHooks } from '../../src/engine/lockfile'
import { analyzePlan } from '../../src/workflow/plan-file'
import { MERGE_DECISION_ACTED, planRegister } from '../../src/workflow/plan'
import { loadState, updateState } from '../../src/workflow/session-store'
import { acquireRepoLock, updateExclude } from '../../src/workflow/gitx'
import {
  readMeta, worktreeCleanup, worktreeCreate, worktreeDetect, worktreeDiff, worktreeStatus,
} from '../../src/workflow/worktree'
import { branchRecordFor, worktreeBranch } from '../../src/workflow/worktree-branch'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { SESSION, ctxAt, g, makeRepo, memIO, planDoc, write } from './fixture'

const S = SESSION

async function setup(root: string, o: { plan?: boolean } = {}): Promise<{ repo: string, plan: string }> {
  const repo = await makeRepo(root)
  const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
  if (o.plan !== false) {
    write(plan, planDoc({ status: 'IN_PROGRESS', approved: true }))
    await planRegister(plan, undefined, ctxAt(repo), S)
  }
  return { repo, plan }
}

function sandbox(fn: (root: string) => Promise<void>): Promise<void> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

async function commitIn(dir: string, file: string, content: string, msg: string): Promise<void> {
  write(join(dir, file), content)
  await g(dir, 'add', '-A')
  await g(dir, 'commit', '-q', '-m', msg)
}

describe('worktree create / detect / status / diff', () => {
  test('creates .worktrees/<slug> on spec/<slug>, excludes the dir, marks the plan', () => sandbox(async root => {
    const { repo, plan } = await setup(root)
    const ctx = ctxAt(repo)
    const r = await worktreeCreate('rate-limit', {}, ctx, S)
    expect(r.code).toBe(0)
    const path = realpathSync(join(repo, '.worktrees', 'rate-limit'))
    expect(r.data).toMatchObject({ created: true, path, branch: 'plan-build/rate-limit', base: 'main', slug: 'rate-limit' })
    expect(r.lines[0]).toBe(path)
    expect(await g(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('plan-build/rate-limit')
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.worktrees/')
    expect(await g(repo, 'status', '--porcelain')).not.toContain('.worktrees')
    expect(analyzePlan(readFileSync(plan, 'utf8')).worktree).toBe(true)
    const meta = readMeta(realpathSync(join(repo, '.git')), 'rate-limit')
    expect(meta).toMatchObject({ slug: 'rate-limit', branch: 'plan-build/rate-limit', base: 'main', path, planPath: plan })

    const again = await worktreeCreate('rate-limit', {}, ctx, S)
    expect(again.code).toBe(0)
    expect(again.data['created']).toBe(false)

    const b = await worktreeCreate('offline', { prefix: 'goal-build' }, ctx, undefined)
    expect(b.data['branch']).toBe('goal-build/offline')
    expect(b.errors.some(e => e.includes('no harness session'))).toBe(true)
  }))

  test('refuses bad input instead of guessing', () => sandbox(async root => {
    const { repo } = await setup(root, { plan: false })
    const ctx = ctxAt(repo)
    expect((await worktreeCreate('Bad Slug', {}, ctx, undefined)).code).toBe(1)
    expect((await worktreeCreate('x', { prefix: 'feat' }, ctx, undefined)).code).toBe(1)
    expect((await worktreeCreate('x', { base: 'nope' }, ctx, undefined)).data['error']).toBe('no_base')
    await g(repo, 'checkout', '-q', '--detach')
    expect((await worktreeCreate('x', {}, ctx, undefined)).data['error']).toBe('detached_head')
    expect((await worktreeCreate('x', { base: 'main' }, ctx, undefined)).code).toBe(0)
    mkdirSync(join(repo, '.worktrees', 'taken'), { recursive: true })
    expect((await worktreeCreate('taken', { base: 'main' }, ctx, undefined)).data['error']).toBe('path_exists')
    expect((await worktreeCreate('x', {}, ctxAt(root), undefined)).data['error']).toBe('not_a_repo')
  }))

  test('detect, status and diff', () => sandbox(async root => {
    const { repo } = await setup(root)
    const ctx = ctxAt(repo)
    const created = await worktreeCreate('rate-limit', {}, ctx, S)
    const wt = String(created.data['path'])
    expect((await worktreeDetect(ctx, S)).data).toMatchObject({ inWorktree: false, planWorktree: { slug: 'rate-limit', path: wt } })
    const inside = await worktreeDetect(ctxAt(join(wt, 'src')), undefined)
    expect(inside.data).toMatchObject({ inWorktree: true, path: wt, branch: 'plan-build/rate-limit', base: 'main', slug: 'rate-limit' })
    expect((await worktreeDetect(ctxAt(root), undefined)).data).toMatchObject({ inWorktree: false, path: null })

    await commitIn(wt, 'src/limit.ts', 'export const limit = 100\n', 'task 1: limiter')
    write(join(wt, 'scratch.txt'), 'wip\n')
    const d = await worktreeDiff('rate-limit', ctx)
    expect(d.code).toBe(0)
    expect(d.data).toMatchObject({ diff_range: 'main...plan-build/rate-limit', stat: { files: 1, insertions: 1, deletions: 0 } })
    expect(d.data['commits']).toMatchObject([{ subject: 'task 1: limiter' }])
    expect(d.data['files']).toEqual([{ status: 'A', path: 'src/limit.ts' }])
    expect(d.data['uncommitted']).toEqual({ tracked: [], untracked: ['scratch.txt'] })
    expect(d.errors.some(e => e.includes('uncommitted'))).toBe(true)

    const st = await worktreeStatus(ctx, S)
    expect(st.data['worktrees']).toMatchObject([{ slug: 'rate-limit', exists: true, ahead: 1, behind: 0, dirty: 1 }])
    expect(st.data['session']).toMatchObject({ plan: 'rate-limit', worktree: 'rate-limit' })
    expect((await worktreeDiff('nope', ctx)).data['error']).toBe('not_found')
  }))
})

describe('worktree create inside a plan worktree', () => {
  test('create inside a plan worktree refuses with inside_worktree', () => sandbox(async root => {
    const { repo } = await setup(root)
    const wt = String((await worktreeCreate('rate-limit', {}, ctxAt(repo), S)).data['path'])
    const r = await worktreeCreate('other', {}, ctxAt(wt), S)
    expect(r.code).toBe(1)
    expect(r.data).toMatchObject({ error: 'inside_worktree', message: "you are inside the plan worktree 'rate-limit'; run this from the main checkout or pass --base <branch>" })
    expect(existsSync(join(repo, '.worktrees', 'other'))).toBe(false)
  }))
})

describe('worktree create: bugfix worktrees and the session plan', () => {
  test('a bugfix worktree leaves the session\'s unrelated plan untouched', () => sandbox(async root => {
    const { repo, plan } = await setup(root)
    const before = readFileSync(plan, 'utf8')
    const ctx = ctxAt(repo)
    const created = await worktreeCreate('totals', { prefix: 'bugfix' }, ctx, S)
    expect(created.code).toBe(0)
    expect(created.data['plan']).toBeNull()
    expect(created.errors).toContain("warning: a bugfix worktree belongs to no plan: the session's plan docs/plans/2026-10-08-rate-limit.md was left untouched")
    expect(readMeta(realpathSync(join(repo, '.git')), 'totals')?.planPath).toBeUndefined()
    expect(readFileSync(plan, 'utf8')).toBe(before)
  }))

  test('a bugfix worktree still marks an unfinished Bugfix plan of the session', () => sandbox(async root => {
    const { repo, plan } = await setup(root, { plan: false })
    const ctx = ctxAt(repo)
    write(plan, planDoc({ type: 'Bugfix', status: 'IN_PROGRESS', approved: true }))
    await planRegister(plan, undefined, ctx, S)
    const created = await worktreeCreate('rate-limit', { prefix: 'bugfix' }, ctx, S)
    expect(created.code).toBe(0)
    expect(created.data['plan']).toMatchObject({ worktree: true, changed: true })
    expect(analyzePlan(readFileSync(plan, 'utf8')).worktree).toBe(true)
    expect(readMeta(realpathSync(join(repo, '.git')), 'rate-limit')?.planPath).toBe(plan)
  }))

})

describe('worktree cleanup', () => {
  test('unmerged work needs --force; uncommitted work needs --discard', () => sandbox(async root => {
    const { repo } = await setup(root)
    const ctx = ctxAt(repo)
    const wt = String((await worktreeCreate('rate-limit', {}, ctx, S)).data['path'])
    await commitIn(wt, 'src/limit.ts', 'x\n', 'task 1')
    const refused = await worktreeCleanup('rate-limit', { force: false, discard: false }, ctx)
    expect(refused.code).toBe(2)
    expect((refused.data['reasons'] as string[])[0]).toContain('not in main')
    const forced = await worktreeCleanup('rate-limit', { force: true, discard: false }, ctx)
    expect(forced.code).toBe(0)
    expect(existsSync(wt)).toBe(false)

    const wt2 = String((await worktreeCreate('second', {}, ctx, undefined)).data['path'])
    write(join(wt2, 'wip.txt'), 'wip\n')
    expect((await worktreeCleanup('second', { force: true, discard: false }, ctx)).code).toBe(2)
    expect(existsSync(wt2)).toBe(true)
    const discarded = await worktreeCleanup('second', { force: false, discard: true }, ctx)
    expect(discarded.code).toBe(0)
    expect(existsSync(wt2)).toBe(false)
    expect((await worktreeCleanup('second', { force: false, discard: false }, ctx)).lines[0]).toContain('Nothing to clean up')
  }), 60_000)

  test('in phase verify, discarding the plan\'s worktree ends a held merge-decision pause; a lane worktree an older Buracle left and a refused cleanup do not (HOOKS-WORKFLOW-3)', () => sandbox(async root => {
    const { repo } = await setup(root)
    const ctx = ctxAt(repo)
    const wt = String((await worktreeCreate('rate-limit', {}, ctx, S)).data['path'])
    await commitIn(wt, 'src/limit.ts', 'x\n', 'task 1')
    const lane = String((await worktreeCreate('rate-limit-2', {}, ctxAt(repo, ctx.now + 1), undefined)).data['path'])
    const laneMeta = join(realpathSync(join(repo, '.git')), 'buracle', 'worktrees', 'rate-limit-2.json')
    write(laneMeta, JSON.stringify({ ...(JSON.parse(readFileSync(laneMeta, 'utf8')) as object), lane: true }))
    write(join(lane, 'wip.txt'), 'wip\n')
    const hold = () => updateState(S.harness, S.sessionId, st => ({
      ...st, plan: { ...(st.plan as NonNullable<typeof st.plan>), status: 'COMPLETE', phase: 'verify' }, interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'merge decision' },
    }))

    hold()
    const laneGone = await worktreeCleanup('rate-limit-2', { force: false, discard: true }, ctx, S)
    expect(laneGone.code).toBe(0)
    expect(laneGone.data['resumed']).toBeUndefined()
    const refused = await worktreeCleanup('rate-limit', { force: false, discard: false }, ctx, S)
    expect(refused.code).toBe(2)
    expect(loadState(S.harness, S.sessionId).interaction?.state).toBe('paused')

    const discarded = await worktreeCleanup('rate-limit', { force: false, discard: true }, ctx, S)
    expect(discarded.code).toBe(0)
    expect(discarded.data['resumed']).toBe(true)
    expect(discarded.lines).toContain(MERGE_DECISION_ACTED)
    expect(loadState(S.harness, S.sessionId).interaction).toEqual({ state: 'running', since: ctx.now })
  }), 60_000)

  test('a branch whose changes already landed elsewhere is removed without --force', () => sandbox(async root => {
    const { repo } = await setup(root)
    const ctx = ctxAt(repo)
    const wt = String((await worktreeCreate('rate-limit', {}, ctx, S)).data['path'])
    await commitIn(wt, 'src/limit.ts', 'x\n', 'task 1')
    await g(repo, 'merge', '-q', '--squash', 'plan-build/rate-limit')
    await g(repo, 'commit', '-q', '-m', 'manual squash')
    const c = await worktreeCleanup('rate-limit', { force: false, discard: false }, ctx)
    expect(c.code).toBe(0)
  }))
})

describe('worktree branch', () => {
  test('switches to <prefix>/<slug> from HEAD, carries local changes, records the base, and is a no-op on a re-run', () => sandbox(async root => {
    const { repo, plan } = await setup(root)
    await g(repo, 'checkout', '-q', '-b', 'feature-x')
    await commitIn(repo, 'src/f.ts', 'f\n', 'feature work')
    const head = await g(repo, 'rev-parse', 'HEAD')
    write(join(repo, 'src', 'app.ts'), 'dirty\n')
    const r = await worktreeBranch('rate-limit', {}, ctxAt(repo), S)
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ created: true, switched: true, branch: 'plan-build/rate-limit', base: 'feature-x', baseCommit: head, carried: 1 })
    expect(await g(repo, 'branch', '--show-current')).toBe('plan-build/rate-limit')
    expect(await g(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('M src/app.ts')
    const common = await g(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    expect(branchRecordFor(common, 'plan-build/rate-limit')).toMatchObject({ slug: 'rate-limit', base: 'feature-x', baseCommit: head, planPath: plan })
    expect(listMetaSlugs(common)).toEqual([])
    const again = await worktreeBranch('rate-limit', {}, ctxAt(repo), S)
    expect(again.data).toMatchObject({ created: false, switched: false, branch: 'plan-build/rate-limit' })
    expect(analyzePlan(readFileSync(plan, 'utf8')).worktree).toBe(false)
    await g(repo, 'commit', '-qam', 'task 1')
    await g(repo, 'checkout', '-q', 'feature-x')
    const back = await worktreeBranch('rate-limit', {}, ctxAt(repo), S)
    expect(back.data).toMatchObject({ created: false, switched: true, branch: 'plan-build/rate-limit' })
    expect(await g(repo, 'branch', '--show-current')).toBe('plan-build/rate-limit')
  }))

  test('a taken name gets the next free suffix; --base starts elsewhere; --prefix names the workflow', () => sandbox(async root => {
    const { repo } = await setup(root, { plan: false })
    await g(repo, 'branch', 'plan-build/rate-limit')
    await g(repo, 'branch', 'plan-build/rate-limit-2')
    const r = await worktreeBranch('rate-limit', {}, ctxAt(repo), undefined)
    expect(r.data).toMatchObject({ created: true, branch: 'plan-build/rate-limit-3', base: 'main' })
    expect(r.errors.join('\n')).toContain('plan-build/rate-limit already exists')
    await g(repo, 'checkout', '-q', 'main')
    await commitIn(repo, 'src/later.ts', 'l\n', 'later on main')
    const first = await g(repo, 'rev-list', '--max-parents=0', 'HEAD')
    const g2 = await worktreeBranch('totals', { base: first, prefix: 'goal-build' }, ctxAt(repo), undefined)
    expect(g2.data).toMatchObject({ branch: 'goal-build/totals', base: first, baseCommit: first })
    expect(await g(repo, 'rev-parse', 'HEAD')).toBe(first)
  }))

  test('refuses what it cannot do safely, and changes nothing then', () => sandbox(async root => {
    const { repo } = await setup(root, { plan: false })
    expect((await worktreeBranch('Bad Slug', {}, ctxAt(repo), undefined)).code).toBe(1)
    expect((await worktreeBranch('x', { prefix: 'nope' }, ctxAt(repo), undefined)).code).toBe(1)
    expect((await worktreeBranch('x', { base: 'no-such-ref' }, ctxAt(repo), undefined)).data['error']).toBe('no_base')
    await g(repo, 'checkout', '-q', '-b', 'other')
    await commitIn(repo, 'src/app.ts', 'other\n', 'other work')
    await g(repo, 'checkout', '-q', 'main')
    write(join(repo, 'src', 'app.ts'), 'mine\n')
    const clash = await worktreeBranch('x', { base: 'other' }, ctxAt(repo), undefined)
    expect(clash.data['error']).toBe('switch_failed')
    expect(await g(repo, 'branch', '--show-current')).toBe('main')
    expect(readFileSync(join(repo, 'src', 'app.ts'), 'utf8')).toBe('mine\n')
    const wt = String((await worktreeCreate('rate-limit', {}, ctxAt(repo), undefined)).data['path'])
    expect((await worktreeBranch('y', {}, ctxAt(wt), undefined)).data['error']).toBe('inside_worktree')
  }))

  test('a plan-build/<slug> branch made by hand is adopted with an assumed base', () => sandbox(async root => {
    const { repo } = await setup(root, { plan: false })
    await g(repo, 'checkout', '-q', '-b', 'plan-build/rate-limit')
    const r = await worktreeBranch('rate-limit', {}, ctxAt(repo), undefined)
    expect(r.data).toMatchObject({ created: false, adopted: true, base: 'main' })
    expect(r.errors.join('\n')).toContain('assuming main')
  }))

  test('the CLI subcommand', () => sandbox(async root => {
    const { repo } = await setup(root, { plan: false })
    const io = memIO(true)
    expect(await runWorktree(['branch', 'rate-limit'], io, ctxAt(repo))).toBe(0)
    expect(io.json()).toMatchObject({ branch: 'plan-build/rate-limit' })
    expect(await runWorktree(['branch'], memIO(), ctxAt(repo))).toBe(1)
    expect(await runWorktree(['branch', 'a', '--lane'], memIO(), ctxAt(repo))).toBe(1)
  }))
})

function listMetaSlugs(common: string): string[] {
  try { return readdirSync(join(common, 'buracle', 'worktrees')) } catch { return [] }
}

describe('repository lock and exclude block', () => {
  test('the lock is exclusive, times out with the holder, and breaks stale locks', () => sandbox(async root => {
    const common = join(root, 'common')
    mkdirSync(common)
    const l1 = await acquireRepoLock(common, 'first', 200)
    await expect(acquireRepoLock(common, 'second', 200)).rejects.toThrow(/first/)
    l1.release()
    const l2 = await acquireRepoLock(common, 'second', 200)
    l2.release()
    writeFileSync(join(common, 'buracle', 'lock'), JSON.stringify({ pid: 999999, host: (await import('node:os')).hostname(), at: 0, what: 'dead' }))
    const l3 = await acquireRepoLock(common, 'third', 500)
    l3.release()
    expect(existsSync(join(common, 'buracle', 'lock'))).toBe(false)
  }))

  test('O11: a waiter never removes the fresh lock another waiter took after breaking the same dead holder\'s lock', () => sandbox(async root => {
    const common = join(root, 'common')
    mkdirSync(join(common, 'buracle'), { recursive: true })
    const lock = join(common, 'buracle', 'lock')
    const host = (await import('node:os')).hostname()
    writeFileSync(lock, JSON.stringify({ pid: 999999, host, at: 0, what: 'dead' }))
    const fresh = JSON.stringify({ pid: process.pid, host, at: Date.now(), what: 'other waiter', token: 'x' }) + '\n'
    lockTestHooks.beforeBreak = path => { unlinkSync(path); writeFileSync(path, fresh) }
    try {
      await expect(acquireRepoLock(common, 'late waiter', 300)).rejects.toThrow(/other waiter/)
    } finally {
      delete lockTestHooks.beforeBreak
    }
    expect(readFileSync(lock, 'utf8')).toBe(fresh)
  }))

  test('exclude entries are added once, inside a managed block, next to user lines', () => sandbox(async root => {
    const common = join(root, 'c')
    write(join(common, 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n.worktrees\n*.log\n')
    const a = updateExclude(common, ['/.worktrees/', '/.claude/settings.local.json'])
    expect(a.added).toEqual(['/.claude/settings.local.json'])
    const b = updateExclude(common, ['/.claude/settings.local.json', '/.claude/skills/x'])
    expect(b.added).toEqual(['/.claude/skills/x'])
    const c = updateExclude(common, [], l => l.startsWith('/.claude/skills/'))
    expect(c.removed).toEqual(['/.claude/skills/x'])
    const text = readFileSync(join(common, 'info', 'exclude'), 'utf8')
    expect(text).toContain('*.log\n')
    expect(text.match(/settings\.local\.json/g)?.length).toBe(1)
    expect(text).toContain('# >>> buracle')
  }))
})

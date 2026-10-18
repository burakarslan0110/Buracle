import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig } from '../../src/core/config'
import { projectSync } from '../../src/workflow/project'
import { indexNewWorktree, keepWorktreesOutOfSemble, updateSembleIgnore } from '../../src/workflow/workspace-index'
import { worktreeCreate } from '../../src/workflow/worktree'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, g, makeRepo, write } from './fixture'

function sandbox(fn: (root: string, home: string) => Promise<void>): Promise<void> {
  return withSandbox(({ root, home }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root, home)))
}

describe('.sembleignore for plan worktrees', () => {
  test('worktree create keeps the worktree folder out of the main checkout\'s semble index, git status stays clean', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const r = await worktreeCreate('rate-limit', {}, ctxAt(repo), undefined)
    expect(r.code).toBe(0)
    const ignore = readFileSync(join(repo, '.sembleignore'), 'utf8')
    expect(ignore).toBe('# >>> buracle (managed by the buracle CLI; edit outside this block)\n/.worktrees/\n# <<< buracle\n')
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.sembleignore')
    expect(await g(repo, 'status', '--porcelain')).toBe('')
    expect(r.errors.some(e => e.includes('.sembleignore'))).toBe(false)
    expect((await worktreeCreate('second', {}, ctxAt(repo), undefined)).code).toBe(0)
    expect(readFileSync(join(repo, '.sembleignore'), 'utf8')).toBe(ignore)
  }))

  test('a .sembleignore the repository tracks is left alone and the user is told which line to add', () => sandbox(async root => {
    const repo = await makeRepo(root)
    write(join(repo, '.sembleignore'), 'fixtures/\n')
    await g(repo, 'add', '.sembleignore')
    await g(repo, 'commit', '-q', '-m', 'semble ignore')
    const r = await worktreeCreate('rate-limit', {}, ctxAt(repo), undefined)
    expect(r.code).toBe(0)
    expect(readFileSync(join(repo, '.sembleignore'), 'utf8')).toBe('fixtures/\n')
    expect(r.errors.some(e => e.includes('.sembleignore is tracked by git: add the line /.worktrees/'))).toBe(true)
  }))

  test('the managed block keeps the user\'s own lines and is not repeated', () => sandbox(async root => {
    const repo = await makeRepo(root)
    write(join(repo, '.sembleignore'), 'fixtures/\n')
    expect(updateSembleIgnore(repo, ['/.worktrees/'])).toMatchObject({ added: ['/.worktrees/'] })
    expect(updateSembleIgnore(repo, ['/.worktrees/', '.worktrees'])).toMatchObject({ added: [] })
    expect(updateSembleIgnore(repo, ['/build-cache/']).added).toEqual(['/build-cache/'])
    expect(readFileSync(join(repo, '.sembleignore'), 'utf8')).toBe('fixtures/\n\n# >>> buracle (managed by the buracle CLI; edit outside this block)\n/.worktrees/\n/build-cache/\n# <<< buracle\n')
  }))

  test('a worktree folder outside the checkout needs nothing', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const common = realpathSync(join(repo, '.git'))
    expect(await keepWorktreesOutOfSemble(repo, common, join(root, 'elsewhere'))).toEqual({ status: 'outside' })
    expect(existsSync(join(repo, '.sembleignore'))).toBe(false)
  }))

  test('project sync adds the entry once the worktree folder exists', () => sandbox(async root => {
    const repo = await makeRepo(root)
    write(join(repo, 'AGENTS.md'), '# Demo\n')
    const before = await projectSync('sync', ctxAt(repo), undefined)
    expect(before.data['sembleignore']).toBeNull()
    expect(existsSync(join(repo, '.sembleignore'))).toBe(false)
    mkdirSync(join(repo, '.worktrees'))
    const after = await projectSync('sync', ctxAt(repo), undefined)
    expect(after.code).toBe(0)
    expect(after.data['sembleignore']).toMatchObject({ status: 'updated', entry: '/.worktrees/' })
    expect(after.lines).toContain('.sembleignore: added /.worktrees/')
    expect(await g(repo, 'status', '--porcelain')).toBe('?? AGENTS.md')
    expect((await projectSync('sync', ctxAt(repo), undefined)).data['sembleignore']).toMatchObject({ status: 'unchanged' })
  }))
})

describe('a new worktree gets its own code indexes', () => {
  test('one background index run for the worktree when index.auto is on', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const wt = join(repo, '.worktrees', 'feature')
    await g(repo, 'worktree', 'add', '-q', '-b', 'plan-build/feature', wt)
    const facts = { mainRoot: repo, commonDir: realpathSync(join(repo, '.git')) }
    const spawned: Array<{ argv: string[], cwd: string }> = []
    const spawn = (argv: string[], cwd: string) => { spawned.push({ argv, cwd }) }
    expect(await indexNewWorktree(wt, facts, 1_000, { cfg: defaultConfig(), argv: ['buracle'], spawn })).toEqual([])
    expect(spawned).toEqual([])
    await withEnv({ BURACLE_NO_AUTOSTART: undefined }, async () => {
      expect(await indexNewWorktree(wt, facts, 1_000, { cfg: defaultConfig(), argv: ['buracle'], spawn })).toEqual([])
      const off = defaultConfig()
      await indexNewWorktree(wt, facts, 1_000, { cfg: { ...off, index: { ...off.index, auto: false } }, argv: ['buracle'], spawn })
    })
    const real = realpathSync(wt)
    expect(spawned).toEqual([{ argv: ['buracle', 'index', 'ensure', '--cwd', real, '--if-due', '--quiet'], cwd: real }])
  }))
})

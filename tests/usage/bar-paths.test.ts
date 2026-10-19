import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { GitState } from '../../src/core/status/model'
import { dirLabel, tildePath } from '../../src/usage/bar'
import { withEnv, withSandbox } from '../helpers/sandbox'

const GIT: GitState = { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, stash: 0, conflicts: 0 }

describe('the folder segment of the status line', () => {
  test('a folder under home is ~/ with / between the parts', () => withSandbox(async ({ home, root }) => {
    expect(tildePath(home, home)).toBe('~')
    expect(tildePath(join(home, 'notes', 'daily'), home)).toBe('~/notes/daily')
    expect(tildePath(join(root, 'elsewhere'), home)).toBe(join(root, 'elsewhere'))
  }))

  test('a subfolder of the repository is shown relative to it, after the worktree name', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'src', 'a'), { recursive: true })
    expect(dirLabel(join(repo, 'src', 'a'), { git: GIT, toplevel: repo })).toBe('src/a')
    expect(dirLabel(join(repo, 'src', 'a'), { git: { ...GIT, worktree: 'wt' }, toplevel: repo })).toBe('wt/src/a')
  }))

  // The alias stands in for Windows' 8.3 spelling of the cwd (C:\Users\RUNNER~1\...) next to git's long toplevel.
  test('on Windows a cwd spelled another way than git\'s toplevel still lands inside it', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, 'src'), { recursive: true })
    const alias = join(root, 'alias')
    symlinkSync(repo, alias)
    if (process.platform !== 'win32') expect(dirLabel(join(alias, 'src'), { git: GIT, toplevel: repo })).toBeUndefined()
    await withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
      expect(dirLabel(join(alias, 'src'), { git: GIT, toplevel: repo })).toBe('src')
    })
  }))
})

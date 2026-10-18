import { describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { commonDir, currentBranch, gitStatusPorcelainV2, isRepo, ownerRepoFromUrl, projectIdentity, projectSlug, remoteUrl, revParse, slugPart } from '../../src/engine/git'
import { sha256 } from '../../src/engine/fsx'
import { run } from '../../src/engine/proc'
import { withSandbox } from '../helpers/sandbox'

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await run(['git', ...args], { cwd, env: GIT_ENV })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

describe('remote URL parsing', () => {
  test('owner/repo from common URL shapes', () => {
    expect(ownerRepoFromUrl('git@github.com:burak/Buracle.git')).toEqual({ owner: 'burak', repo: 'Buracle' })
    expect(ownerRepoFromUrl('https://github.com/burak/buracle')).toEqual({ owner: 'burak', repo: 'buracle' })
    expect(ownerRepoFromUrl('https://github.com/burak/buracle.git/')).toEqual({ owner: 'burak', repo: 'buracle' })
    expect(ownerRepoFromUrl('ssh://git@gitlab.example.com:2222/group/sub/proj.git')).toEqual({ owner: 'sub', repo: 'proj' })
    expect(ownerRepoFromUrl('/srv/git/solo.git')).toEqual({ owner: 'git', repo: 'solo' })
    expect(ownerRepoFromUrl('solo')).toEqual({ repo: 'solo' })
    expect(ownerRepoFromUrl('')).toBeUndefined()
  })

  test('slugPart folds Turkish and punctuation', () => {
    expect(slugPart('Çalışma Alanı İçin Güzel Şey')).toBe('calisma-alani-icin-guzel-sey')
    expect(slugPart('My_Repo.v2')).toBe('my-repo-v2')
    expect(slugPart('---')).toBe('project')
    expect(slugPart('x'.repeat(80)).length).toBe(60)
  })
})

describe('git queries', () => {
  test('repository facts and the project slug (worktrees unify)', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'My Project')
    mkdirSync(repo)
    await git(repo, 'init', '-q', '-b', 'main')
    await git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
    expect(await isRepo(repo)).toBe(true)
    expect(await currentBranch(repo)).toBe('main')
    expect(realpathSync(await commonDir(repo) as string)).toBe(join(repo, '.git'))
    expect(await revParse(repo, '--abbrev-ref', 'HEAD')).toBe('main')
    expect(await gitStatusPorcelainV2(repo)).toContain('# branch.head main')
    expect(await remoteUrl(repo)).toBeUndefined()

    expect(await projectSlug(repo)).toBe('my-project')

    await git(repo, 'remote', 'add', 'origin', 'git@github.com:burak/Buracle-Core.git')
    expect(await remoteUrl(repo)).toBe('git@github.com:burak/Buracle-Core.git')
    const id = await projectIdentity(repo)
    expect(id.slug).toBe('buracle-core')
    expect(id.ownerRepo).toBe('burak/Buracle-Core')
    expect(realpathSync(id.root)).toBe(repo)

    const wt = join(root, 'wt-feature')
    await git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt)
    expect(await projectSlug(wt)).toBe('buracle-core')
    expect(await currentBranch(wt)).toBe('feature')
    expect(realpathSync((await projectIdentity(wt)).root)).toBe(repo)
  }))

  test('outside git: folder name plus a short hash', () => withSandbox(async ({ root }) => {
    const dir = join(root, 'Scratch Dir')
    mkdirSync(dir)
    expect(await isRepo(dir)).toBe(false)
    expect(await gitStatusPorcelainV2(dir)).toBeUndefined()
    expect(await commonDir(dir)).toBeUndefined()
    expect(await currentBranch(dir)).toBeUndefined()
    const slug = await projectSlug(dir)
    expect(slug).toBe(`scratch-dir-${sha256(dir).slice(0, 6)}`)
    expect(basename(dir)).toBe('Scratch Dir')
  }))
})

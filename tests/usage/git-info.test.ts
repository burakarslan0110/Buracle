import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { defaultDeps } from '../../src/adapters/omp/runtime/deps'
import { gitInfo } from '../../src/usage/bar'
import { withSandbox } from '../helpers/sandbox'
import { makeRepo, write } from '../workflow/fixture'

// src/app.ts holds one line after makeRepo; three added and that one removed gives +3 -1.
function editApp(repo: string): void {
  write(join(repo, 'src', 'app.ts'), 'export const b = 2\nexport const c = 3\nexport const d = 4\n')
}

describe('working-tree lines in the git status', () => {
  test('gitInfo and the omp git state count the lines added and removed against HEAD', async () => {
    await withSandbox(async ({ root }) => {
      const repo = await makeRepo(root, 'lines')
      expect((await gitInfo(repo, 5000))?.git.lines).toBeUndefined()
      editApp(repo)
      expect((await gitInfo(repo, 5000))?.git.lines).toEqual({ added: 3, removed: 1 })
      expect((await defaultDeps().gitState(repo))?.lines).toEqual({ added: 3, removed: 1 })
    })
  })

  test('a repository without commits shows the rest of the git state and no line counts', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'fresh')
      mkdirSync(repo, { recursive: true })
      await Bun.spawn(['git', 'init', '-q', '-b', 'main'], { cwd: repo, env: { ...process.env } }).exited
      write(join(repo, 'README.md'), '# fresh\n')
      const info = await gitInfo(repo, 5000)
      expect(info?.git).toMatchObject({ branch: 'main', untracked: 1 })
      expect(info?.git.lines).toBeUndefined()
      const omp = await defaultDeps().gitState(repo)
      expect(omp).toMatchObject({ branch: 'main', untracked: 1 })
      expect(omp?.lines).toBeUndefined()
    })
  })
})

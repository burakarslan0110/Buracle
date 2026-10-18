import { describe, expect, test } from 'bun:test'
import { gitFromPorcelainV2 } from '../../../src/core/status/git'

const SAMPLE = [
  '# branch.oid 4f2a9c1e0b7d3a5f6e8c9b0a1d2e3f4a5b6c7d8e',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '# stash 3',
  '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb src/a.ts',
  '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb src/b.ts',
  '1 MM N... 100644 100644 100644 aaaaaaa bbbbbbb src/c.ts',
  '1 A. N... 000000 100644 100644 0000000 bbbbbbb src/new.ts',
  '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 src/renamed.ts\tsrc/old.ts',
  'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc src/conflict.ts',
  '? notes.txt',
  '? tmp/',
  '! node_modules/',
  '',
].join('\n')

describe('gitFromPorcelainV2', () => {
  test('branch, ahead/behind, stash and per-kind counts', () => {
    expect(gitFromPorcelainV2(SAMPLE)).toEqual({
      branch: 'main', ahead: 2, behind: 1, staged: 4, unstaged: 2, untracked: 2, stash: 3, conflicts: 1,
    })
  })

  test('detached HEAD shows the short commit id', () => {
    const s = gitFromPorcelainV2('# branch.oid 4f2a9c1e0b7d3a5f6e8c9b0a1d2e3f4a5b6c7d8e\n# branch.head (detached)\n')
    expect(s).toEqual({ branch: '4f2a9c1', detached: true, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, stash: 0, conflicts: 0 })
  })

  test('a fresh repository without commits or upstream', () => {
    const s = gitFromPorcelainV2('# branch.oid (initial)\n# branch.head main\n? README.md\n')
    expect(s).toEqual({ branch: 'main', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 1, stash: 0, conflicts: 0 })
    const d = gitFromPorcelainV2('# branch.oid (initial)\n# branch.head (detached)\n')
    expect(d.detached).toBe(true)
    expect(d.branch).toBeUndefined()
  })

  test('linked worktree when the git dir differs from the common dir', () => {
    const wt = gitFromPorcelainV2('# branch.head spec/auth-fix\n', '/repo/.git/worktrees/auth-fix', '/repo/.git')
    expect(wt.worktree).toBe('auth-fix')
    expect(wt.branch).toBe('spec/auth-fix')
    expect(gitFromPorcelainV2('# branch.head main\n', '/repo/.git', '/repo/.git/').worktree).toBeUndefined()
    expect(gitFromPorcelainV2('# branch.head main\n', '/repo/.git').worktree).toBeUndefined()
    expect(gitFromPorcelainV2('# branch.head main\n', 'C:\\repo\\.git\\worktrees\\wt1', 'C:\\repo\\.git').worktree).toBe('wt1')
  })

  test('CRLF output, empty output and junk lines', () => {
    const crlf = SAMPLE.replace(/\n/g, '\r\n')
    expect(gitFromPorcelainV2(crlf)).toEqual(gitFromPorcelainV2(SAMPLE))
    expect(gitFromPorcelainV2('')).toEqual({ ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, stash: 0, conflicts: 0 })
    expect(gitFromPorcelainV2('fatal: not a git repository\n# branch.ab garbage\n# stash x\n')).toEqual({ ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, stash: 0, conflicts: 0 })
  })
})

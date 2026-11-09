import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Board } from '../../src/core/board/model'
import { boardFromPlan, claim, mergeBoard } from '../../src/core/board/model'
import { tryLock } from '../../src/memory/lock'
import {
  boardCountsFor, boardLockPath, boardPath, commonDirOf, isBoard, listBoards, newToken, patchSessionBoard, publishBoard, readBoard, readBoardFile, removeBoard, sessionBoard, setSessionBoard, updateBoard, writeBoard,
} from '../../src/workflow/board-store'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { g, makeRepo } from './fixture'

const NOW = 1_700_000_000_000
const LEAD = { harness: 'claude' as const, session: 'lead-1' }

function sample(now = NOW): Board {
  const r = boardFromPlan([
    { n: 1, title: 'One', done: false, objective: 'o1', dod: 'd1', files: [{ verb: 'Modify', path: 'src/a.ts' }] },
    { n: 2, title: 'Two', done: false, objective: 'o2', dod: 'd2', files: [{ verb: 'Modify', path: 'src/b.ts' }] },
  ], { slug: 'rate-limit', plan: '/repo/docs/plan-build/2026-11-07-rate-limit.md', planType: 'Feature', base: 'main', lead: LEAD, maxWorkers: 6, leaseSec: 1, constraints: [], context: '', now })
  if (!r.ok) throw new Error(r.message)
  return r.board
}

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '200' }, () => fn(root)))
}

describe('board paths', () => {
  test('the store stays light: it imports no worktree, plan or git module (the hooks of every harness load it)', () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'workflow', 'board-store.ts'), 'utf8')
    const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1] as string)
    expect(imports.filter(i => /\/(worktree|plan|gitx|board)(?:-[a-z]+)?$/.test(i) && !i.endsWith('/plan-file') && !i.endsWith('core/board/model') && !i.endsWith('core/plan/state'))).toEqual([])
    // plan.ts reaches the board through the store only: board.ts imports worktree.ts, which imports plan.ts.
    const plan = readFileSync(join(import.meta.dir, '..', '..', 'src', 'workflow', 'plan.ts'), 'utf8')
    expect([...plan.matchAll(/from '([^']+)'/g)].map(m => m[1] as string).filter(i => i.endsWith('/board') || i.endsWith('/worktree'))).toEqual([])
  })

  test('the board file and its lock live under <commonDir>/buracle/board; an invalid slug is refused', () => {
    expect(boardPath('/repo/.git', 'rate-limit')).toBe('/repo/.git/buracle/board/rate-limit.json')
    expect(boardLockPath(boardPath('/repo/.git', 'rate-limit'))).toBe('/repo/.git/buracle/board/rate-limit.json.lock')
    expect(() => boardPath('/repo/.git', '../x')).toThrow(/invalid board slug/)
    expect(() => boardPath('/repo/.git', 'Rate Limit')).toThrow(/invalid board slug/)
  })

  test('commonDirOf finds the git common dir from the main checkout and from a linked worktree without git, and nothing outside a repository', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const common = realpathSync(join(repo, '.git'))
    expect(commonDirOf(repo)).toBe(common)
    expect(commonDirOf(join(repo, 'src'))).toBe(common)
    const wt = join(root, 'wt')
    await g(repo, 'worktree', 'add', '-q', '-b', 'lane', wt)
    expect(commonDirOf(wt)).toBe(common)
    expect(commonDirOf(join(wt, 'src'))).toBe(common)
    mkdirSync(join(root, 'plain'), { recursive: true })
    expect(commonDirOf(join(root, 'plain'))).toBeUndefined()
  }))
})

describe('reading and writing', () => {
  test('readBoardFile: missing, invalid JSON and a wrong shape; writeBoard round-trips', () => sandbox(async root => {
    const path = join(root, 'buracle', 'board', 'rate-limit.json')
    expect(readBoardFile(path)).toEqual({ ok: false, code: 'missing', error: `no board at ${path}` })
    expect(readBoard(path)).toBeUndefined()
    const board = sample()
    writeBoard(path, board)
    expect(readBoard(path)).toEqual(board)
    writeFileSync(path, '{ not json')
    expect(readBoardFile(path).ok).toBe(false)
    expect((readBoardFile(path) as { code: string }).code).toBe('invalid')
    writeFileSync(path, JSON.stringify({ v: 2, slug: 'rate-limit' }))
    expect((readBoardFile(path) as { code: string }).code).toBe('invalid')
    expect(isBoard({ ...board, tasks: [{ n: 1, status: 'flying' }] })).toBe(false)
    expect(isBoard(board)).toBe(true)
  }))

  test('isBoard accepts the optional standby, harnesses and panes fields and they round-trip; a malformed one is refused', () => sandbox(async root => {
    const path = join(root, 'buracle', 'board', 'rate-limit.json')
    const board: Board = { ...sample(), standby: [{ harness: 'codex', session: 'w1', since: NOW, at: NOW + 5 }], harnesses: ['claude', 'codex'], panes: 'tmux' }
    expect(isBoard(board)).toBe(true)
    writeBoard(path, board)
    expect(readBoard(path)).toEqual(board)
    // A board written before standby workers has none of the fields.
    expect(isBoard(sample())).toBe(true)
    expect(isBoard({ ...board, standby: 'w1' })).toBe(false)
    expect(isBoard({ ...board, standby: [{ harness: 'codex', session: 'w1' }] })).toBe(false)
    expect(isBoard({ ...board, harnesses: 'claude' })).toBe(false)
    expect(isBoard({ ...board, harnesses: ['gemini'] })).toBe(false)
    expect(isBoard({ ...board, panes: 3 })).toBe(false)
  }))

  test('updateBoard sweeps first, writes under <slug>.json.lock, keeps the sweep when fn fails, and leaves an unreadable file alone', () => sandbox(async root => {
    const path = join(root, 'buracle', 'board', 'rate-limit.json')
    const claimed = claim(sample(), 1, { harness: 'codex', session: 'w1' }, NOW, 'tok')
    if (!claimed.ok) throw new Error(claimed.message)
    writeBoard(path, claimed.board)
    let lockSeen = false
    const failed = updateBoard(path, NOW + 1500, b => {
      lockSeen = existsSync(`${path}.lock`)
      expect(b.tasks[0]?.status).toBe('stale')
      return { ok: false, code: 'task_not_open', message: 'no' }
    })
    expect(lockSeen).toBe(true)
    expect(existsSync(`${path}.lock`)).toBe(false)
    expect(failed).toEqual({ ok: false, code: 'task_not_open', message: 'no' })
    expect(readBoard(path)?.tasks[0]?.status).toBe('stale')
    const unchanged = updateBoard(path, NOW + 1600, b => ({ ok: true, board: b }))
    expect(unchanged.ok && unchanged.changed).toBe(false)
    const changed = updateBoard(path, NOW + 1700, b => ({ ok: true, board: { ...b, maxWorkers: 2 } }))
    expect(changed.ok && changed.changed).toBe(true)
    expect(readBoard(path)?.maxWorkers).toBe(2)
    expect(updateBoard(join(root, 'nope.json'), NOW, b => ({ ok: true, board: b }))).toMatchObject({ ok: false, code: 'no_board' })
    writeFileSync(path, '{ broken')
    expect(updateBoard(path, NOW, b => ({ ok: true, board: b }))).toMatchObject({ ok: false, code: 'unreadable' })
    expect(readFileSync(path, 'utf8')).toBe('{ broken')
  }))

  test('a held lock makes updateBoard report locked after the timeout', () => sandbox(async root => {
    const path = join(root, 'buracle', 'board', 'rate-limit.json')
    writeBoard(path, sample())
    const release = tryLock(`${path}.lock`)
    expect(release).toBeDefined()
    try {
      const r = updateBoard(path, NOW, b => ({ ok: true, board: b }))
      expect(r).toMatchObject({ ok: false, code: 'locked' })
      expect((r as { message: string }).message).toContain('busy')
    } finally {
      release?.()
    }
  }))

  test('publishBoard creates, then merges, and never overwrites an unreadable board', () => sandbox(async root => {
    const path = join(root, 'buracle', 'board', 'rate-limit.json')
    const first = publishBoard(path, sample(), mergeBoard)
    expect(first.ok && first.changedTasks).toEqual([])
    const claimed = updateBoard(path, NOW, b => claim(b, 1, { harness: 'codex', session: 'w1' }, NOW, 'tok'))
    expect(claimed.ok).toBe(true)
    const fresh = sample(NOW + 10)
    fresh.tasks[0] = { ...(fresh.tasks[0] as Board['tasks'][number]), files: [{ verb: 'Modify', path: 'src/other.ts' }] }
    const second = publishBoard(path, fresh, mergeBoard)
    expect(second.ok && second.changedTasks).toEqual([1])
    expect(readBoard(path)?.tasks[0]?.status).toBe('claimed')
    expect(readBoard(path)?.tasks[0]?.files.map(f => f.path)).toEqual(['src/a.ts'])
    writeFileSync(path, 'nope')
    expect(publishBoard(path, sample(), mergeBoard)).toMatchObject({ ok: false, code: 'unreadable' })
    expect(readFileSync(path, 'utf8')).toBe('nope')
    removeBoard(path)
    expect(existsSync(path)).toBe(false)
  }))

  test('listBoards lists every board file with its content, and tolerates a broken one', () => sandbox(async root => {
    const common = join(root, 'common')
    expect(listBoards(common)).toEqual([])
    writeBoard(boardPath(common, 'rate-limit'), sample())
    writeFileSync(boardPath(common, 'broken'), '{')
    const all = listBoards(common)
    expect(all.map(b => [b.slug, b.board !== undefined])).toEqual([['broken', false], ['rate-limit', true]])
  }))
})

describe('boardCountsFor', () => {
  test('gives the session\'s board counts after a sweep, and nothing for a session without a board or with a gone board', () => sandbox(async root => {
    const path = join(root, 'buracle', 'board', 'rate-limit.json')
    const claimed = claim(sample(), 1, { harness: 'codex', session: 'w1' }, NOW, 'tok')
    if (!claimed.ok) throw new Error(claimed.message)
    writeBoard(path, claimed.board)
    expect(boardCountsFor('claude', 'lead-1', NOW)).toBeUndefined()
    setSessionBoard('claude', 'lead-1', { slug: 'rate-limit', path, role: 'lead', cursor: 0 })
    expect(boardCountsFor('claude', 'lead-1', NOW + 10)).toEqual({ slug: 'rate-limit', role: 'lead', summary: { open: 1, claimed: 1, waiting: 0, done: 0, merged: 0, stale: 0, workers: 1, total: 2 } })
    expect(boardCountsFor('claude', 'lead-1', NOW + 5000)?.summary).toMatchObject({ claimed: 0, stale: 1 })
    expect(boardCountsFor('claude', undefined, NOW)).toBeUndefined()
    removeBoard(path)
    expect(boardCountsFor('claude', 'lead-1', NOW)).toBeUndefined()
  }))
})

describe('the session binding', () => {
  test('setSessionBoard writes, patchSessionBoard changes and clears fields, and undefined removes the binding', () => sandbox(async () => {
    expect(sessionBoard('claude', 's1')).toBeUndefined()
    setSessionBoard('claude', 's1', { slug: 'rate-limit', path: '/x/rate-limit.json', role: 'worker', task: 1, token: 'tok', worktree: '/x/wt' })
    expect(sessionBoard('claude', 's1')).toEqual({ slug: 'rate-limit', path: '/x/rate-limit.json', role: 'worker', task: 1, token: 'tok', worktree: '/x/wt' })
    expect(patchSessionBoard('claude', 's1', { task: undefined, token: undefined, worktree: undefined })).toEqual({ slug: 'rate-limit', path: '/x/rate-limit.json', role: 'worker' })
    expect(sessionBoard('claude', 's1')).toEqual({ slug: 'rate-limit', path: '/x/rate-limit.json', role: 'worker' })
    expect(patchSessionBoard('claude', 'other', { task: 2 })).toBeUndefined()
    setSessionBoard('claude', 's1', undefined)
    expect(sessionBoard('claude', 's1')).toBeUndefined()
    expect(newToken()).not.toBe(newToken())
    expect(newToken()).toMatch(/^[0-9a-f-]{36}$/)
  }))
})

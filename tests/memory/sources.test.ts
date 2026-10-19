import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { write } from '../../src/memory/api'
import { pickCandidateSources, pickSourceFiles } from '../../src/memory/sources'
import { getStored, projectRef } from '../../src/memory/store'
import { sweepLayer } from '../../src/memory/sweep'
import { agentCtx, git, withBrain } from './helpers'

describe('sources by name', () => {
  test('pickSourceFiles: the files two names agree on, else one name in a few files, never more than three', () => {
    expect(pickSourceFiles(new Map([['a', ['x.ts', 'y.ts']], ['b', ['y.ts', 'z.ts']]]))).toEqual(['y.ts'])
    expect(pickSourceFiles(new Map([['a', ['y.ts', 'x.ts']]]))).toEqual(['x.ts', 'y.ts'])
    expect(pickSourceFiles(new Map([['a', ['1', '2', '3', '4']]]))).toEqual([])
    expect(pickSourceFiles(new Map([['a', ['x.ts']], ['b', ['y.ts']]]))).toEqual([])
    expect(pickSourceFiles(new Map([['a', ['1', '2', '3', '4']], ['b', ['4', '3', '2', '1']], ['c', ['1']]]))).toEqual(['1', '2', '3'])
    expect(pickSourceFiles(new Map())).toEqual([])
  })

  test('pickCandidateSources: the named paths the session touched, else the session files the text names; never a path outside the repository', () => {
    expect(pickCandidateSources(['./src/orders.ts', 'src/nope.ts'], ['src/orders.ts', 'src/a.ts'], 'x')).toEqual(['src/orders.ts'])
    expect(pickCandidateSources([], ['src/orders.ts', 'src/a.ts', 'lib/b.ts'], 'See orders.ts and b.ts')).toEqual(['src/orders.ts', 'lib/b.ts'])
    expect(pickCandidateSources([], ['src/orders.ts'], 'nothing here')).toEqual([])
    expect(pickCandidateSources(['/etc/passwd', '../x.ts', 'C:\\x.ts'], ['/etc/passwd', '../x.ts', 'C:\\x.ts'], 'passwd x.ts')).toEqual([])
  })

  test('the sweep gives a memory that cites no file the files that hold its quoted names', async () => {
    await withBrain(async ({ repo }) => {
      mkdirSync(join(repo, 'src'), { recursive: true })
      writeFileSync(join(repo, 'src', 'orders.ts'), 'export const ORDER_CACHE_TTL_SECONDS = 300\nexport const ORDERS_TABLE = "orders_v2"\n')
      writeFileSync(join(repo, 'src', 'cache.ts'), 'import { ORDER_CACHE_TTL_SECONDS } from "./orders"\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'files')
      writeFileSync(join(repo, 'src', 'refunds.ts'), 'export const REFUNDS_TABLE = "refunds"\n')
      const two = (await write(agentCtx(repo), { type: 'gotcha', title: 'The orders cache TTL and table live together', summary: 'one file', body: 'Look at `ORDER_CACHE_TTL_SECONDS` next to `ORDERS_TABLE`.' })).id
      const one = (await write(agentCtx(repo), { type: 'knowledge', title: 'Refunds have their own table', summary: 'untracked yet', body: 'The table is `REFUNDS_TABLE`.' })).id
      const cited = (await write(agentCtx(repo), { type: 'knowledge', title: 'Already cited', summary: 'has a file', body: 'See `ORDERS_TABLE`.', sources: ['src/orders.ts:2'] })).id
      const none = (await write(agentCtx(repo), { type: 'decision', title: 'No names at all', summary: 'prose only', body: 'Nothing quoted here.' })).id
      const r = await sweepLayer(projectRef('demo'), { nowMs: Date.now() })
      expect(r.sourced?.map(s => s.id).sort()).toEqual([one, two].sort())
      const t = (await getStored(projectRef('demo'), two))?.item
      expect(t?.sources).toEqual(['src/orders.ts'])
      expect(t?.history.at(-1)?.what).toBe('sources found by name: src/orders.ts')
      expect((await getStored(projectRef('demo'), one))?.item.sources).toEqual(['src/refunds.ts'])
      expect((await getStored(projectRef('demo'), cited))?.item.sources).toEqual(['src/orders.ts:2'])
      expect((await getStored(projectRef('demo'), none))?.item.sources).toEqual([])
      expect((await sweepLayer(projectRef('demo'), { nowMs: Date.now() })).sourced).toBeUndefined()
    })
  })
})

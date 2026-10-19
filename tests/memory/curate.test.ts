import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { write } from '../../src/memory/api'
import { curatorEvidence, movedSources, sameNameFiles } from '../../src/memory/curate'
import { resolveProject } from '../../src/memory/project'
import { getStored, projectRef, saveItem } from '../../src/memory/store'
import { readUpkeep, sweep } from '../../src/memory/sweep'
import { agentCtx, git, withBrain } from './helpers'

describe('moved sources', () => {
  test('exactly one tracked file of the same name is a move; two are not; a file still there is not', () => {
    const tracked = new Set(['lib/a.ts', 'src/b.ts', 'x/c.ts', 'y/c.ts', 'README.md'])
    expect(sameNameFiles('src/a.ts', tracked)).toEqual(['lib/a.ts'])
    expect(sameNameFiles('src/c.ts', tracked)).toEqual(['x/c.ts', 'y/c.ts'])
    const items = [
      { id: 'm1', sources: ['src/a.ts:12', 'src/b.ts'] }, { id: 'm2', sources: ['src/c.ts', 'memory:m1', 'https://x.example/doc'] },
    ].map(i => ({ ...i, kind: 'decision' as const, layer: 'project' as const, title: i.id, summary: '', body: '', tags: [], about: [], status: 'active' as const, review: 'ok' as const, importance: 3, created: '', updated: '', author: 'agent' as const, version: 1, history: [] }))
    expect([...movedSources(items, tracked).entries()]).toEqual([['src/a.ts', 'lib/a.ts']])
  })

  test('the sweep re-sources a memory whose cited file git moved, and sends it back to the verifier', async () => {
    await withBrain(async ({ repo }) => {
      mkdirSync(join(repo, 'src'), { recursive: true })
      writeFileSync(join(repo, 'src', 'ttl.ts'), 'export const TTL = 300\n')
      git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'ttl')
      await resolveProject(repo)
      const id = (await write(agentCtx(repo), { type: 'knowledge', title: 'The cache TTL is five minutes', summary: 'TTL 300', sources: ['src/ttl.ts:1', 'README.md'], review: 'ok' })).id
      mkdirSync(join(repo, 'lib'), { recursive: true })
      git(repo, 'mv', 'src/ttl.ts', 'lib/ttl.ts'); git(repo, 'commit', '-q', '-m', 'move')
      const r = await sweep({ slug: 'demo', person: false })
      expect(r.layers[0]?.moved).toEqual([{ id, from: 'src/ttl.ts', to: 'lib/ttl.ts' }])
      const after = (await getStored(projectRef('demo'), id))?.item
      expect(after?.sources).toEqual(['lib/ttl.ts:1', 'README.md'])
      expect(after?.review).toBe('pending')
      expect(after?.history.at(-1)?.what).toBe('sources moved by git: src/ttl.ts -> lib/ttl.ts')
      expect(readUpkeep('demo')?.items.find(u => u.id === id)?.reasons ?? []).not.toContain('source-missing')
      expect((await sweep({ slug: 'demo', person: false })).layers[0]?.moved).toBeUndefined()
    })
  })
})

describe('the evidence', () => {
  test('a contradicted memory gets its note and the excerpts of its cited files; a missing file gets its candidates', async () => {
    await withBrain(async ({ repo }) => {
      mkdirSync(join(repo, 'src', 'orders'), { recursive: true })
      mkdirSync(join(repo, 'lib', 'cache'), { recursive: true })
      mkdirSync(join(repo, 'app', 'cache'), { recursive: true })
      writeFileSync(join(repo, 'src', 'orders', 'db.ts'), 'import { Pool } from "cockroachdb"\nexport const pool = new Pool({ db: "orders" })\n')
      writeFileSync(join(repo, 'lib', 'cache', 'ttl.ts'), 'export const TTL = 300\n')
      writeFileSync(join(repo, 'app', 'cache', 'ttl.ts'), 'export const TTL = 60\n')
      git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'files')
      await resolveProject(repo)
      const ref = projectRef('demo')
      const wrong = (await write(agentCtx(repo), { type: 'decision', title: 'Orders live in PostgreSQL', summary: 'one database', body: 'The orders service writes to PostgreSQL.', sources: ['src/orders/db.ts:2'] })).id
      const s = await getStored(ref, wrong)
      await saveItem(ref, { ...(s?.item as NonNullable<typeof s>['item']), review: 'pending', contradictedAt: new Date().toISOString(), contradictedNote: 'db.ts opens a CockroachDB pool' }, s?.keep)
      const orphan = (await write(agentCtx(repo), { type: 'knowledge', title: 'The cache TTL is five minutes', summary: 'TTL 300', sources: ['src/cache/ttl.ts', 'memory:' + wrong], review: 'ok' })).id
      await sweep({ slug: 'demo', person: false })
      const upkeep = readUpkeep('demo')?.items ?? []
      expect(upkeep.find(u => u.id === orphan)?.reasons).toContain('source-missing')
      const items = [(await getStored(ref, wrong))?.item, (await getStored(ref, orphan))?.item].filter(i => i !== undefined)
      const ev = await curatorEvidence({ root: repo, items: items as NonNullable<typeof items[number]>[], upkeep })
      expect(ev.get(wrong)).toMatchObject({ contradicted: true, note: 'db.ts opens a CockroachDB pool', missing: [], candidates: [] })
      expect(ev.get(wrong)?.excerpts[0]).toMatchObject({ file: 'src/orders/db.ts', start: 1 })
      expect(ev.get(wrong)?.excerpts[0]?.text).toContain('cockroachdb')
      expect(ev.get(orphan)).toEqual({ contradicted: false, missing: ['src/cache/ttl.ts'], candidates: ['app/cache/ttl.ts', 'lib/cache/ttl.ts'], excerpts: [] })
      const bare = await curatorEvidence({ items: items as NonNullable<typeof items[number]>[], upkeep })
      expect(bare.get(wrong)?.excerpts).toEqual([])
      expect(bare.get(orphan)?.candidates).toEqual([])
    })
  })
})

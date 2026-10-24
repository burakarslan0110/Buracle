import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MemItem } from '../../src/core/memory/brain'
import { cortexFor, closeAllCortex } from '../../src/memory/cortex'
import { brainDbFile, brainLockFile } from '../../src/memory/layout'
import { tryLock } from '../../src/memory/lock'
import {
  bucketCounts, bucketExists, deleteBucket, deleteItem, getStored, listAll, personRef, projectRef, rawRows, refKey, rowOwner, saveItem, searchLayer, storedId, storedSave, withBrainLock,
} from '../../src/memory/store'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { REAL_CORTEXDB, withBrain } from './helpers'

function item(over: Partial<MemItem> & Pick<MemItem, 'id' | 'title'>): MemItem {
  return {
    kind: 'decision', layer: 'project', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'pending',
    importance: 3, created: '2026-10-13T10:00:00Z', updated: '2026-10-13T10:00:00Z', author: 'agent', version: 1, history: [], ...over,
  }
}

const rawOf = async (stored: string) => (await cortexFor(brainDbFile()).call<{ memory?: Record<string, unknown> }>('memory_get', { memory_id: stored })).memory

describe('buckets in the one brain file', () => {
  test('the same memory id in the person bucket and in two projects stays three memories', async () => {
    await withSandbox(async () => {
      await saveItem(projectRef('alpha'), item({ id: 'decision-shared', title: 'Alpha decides tabs' }))
      await saveItem(projectRef('beta'), item({ id: 'decision-shared', title: 'Beta decides spaces' }))
      await saveItem(personRef(), item({ id: 'decision-shared', title: 'The person decides tea', layer: 'person' }))
      expect((await getStored(projectRef('alpha'), 'decision-shared'))?.item.title).toBe('Alpha decides tabs')
      expect((await getStored(projectRef('beta'), 'decision-shared'))?.item.title).toBe('Beta decides spaces')
      expect((await getStored(personRef(), 'decision-shared'))?.item.title).toBe('The person decides tea')
      expect((await listAll(projectRef('alpha'))).map(i => i.title)).toEqual(['Alpha decides tabs'])
      expect((await listAll(personRef())).map(i => [i.id, i.layer])).toEqual([['decision-shared', 'person']])
      // One file, three rows, each under its bucket.
      const rows = await rawRows(brainDbFile())
      expect(rows.map(r => (r as { id: string }).id).sort()).toEqual(['p/alpha/decision-shared', 'p/beta/decision-shared', 'u/decision-shared'])
      expect(await rawOf('u/decision-shared')).toMatchObject({ scope: 'user', user_id: 'person', namespace: 'default', session_id: 'memory:user:person:default' })
      expect(await rawOf('p/beta/decision-shared')).toMatchObject({ scope: 'global', namespace: 'beta', session_id: 'memory:global:beta' })
    })
  })

  test('a search reaches only its own bucket; the engine itself, asked without a bucket, sees none of them', async () => {
    await withSandbox(async () => {
      await saveItem(projectRef('alpha'), item({ id: 'gotcha-zebra-a', title: 'Zebra in alpha', kind: 'gotcha' }))
      await saveItem(projectRef('beta'), item({ id: 'gotcha-zebra-b', title: 'Zebra in beta', kind: 'gotcha' }))
      await saveItem(personRef(), item({ id: 'preference-zebra', title: 'Zebra for the person', kind: 'preference', layer: 'person' }))
      expect((await searchLayer(projectRef('alpha'), 'zebra', 10)).map(h => h.item.id)).toEqual(['gotcha-zebra-a'])
      expect((await searchLayer(projectRef('beta'), 'zebra', 10)).map(h => h.item.id)).toEqual(['gotcha-zebra-b'])
      expect((await searchLayer(personRef(), 'zebra', 10)).map(h => h.item.id)).toEqual(['preference-zebra'])
      const bare = await cortexFor(brainDbFile()).call<{ results?: unknown[] }>('memory_search', { query: 'zebra', top_k: 10 })
      expect(bare.results ?? []).toEqual([])
    })
  })

  test('the engine keeps one row per id whatever the bucket, which is why every stored id carries its bucket', async () => {
    await withSandbox(async () => {
      const c = cortexFor(brainDbFile())
      await c.call('memory_save', { memory_id: 'decision-x', content: 'first zebra', scope: 'global', namespace: 'alpha' })
      await c.call('memory_save', { memory_id: 'decision-x', content: 'second zebra', scope: 'global', namespace: 'beta' })
      const rows = (await c.call<{ memories?: Array<{ id: string, namespace: string }> }>('memory_list_all', { limit: 10 })).memories ?? []
      expect(rows.map(r => [r.id, r.namespace])).toEqual([['decision-x', 'beta']])
      expect(storedId(projectRef('alpha'), 'decision-x')).not.toBe(storedId(projectRef('beta'), 'decision-x'))
    })
  })

  test('a row whose id or fields do not name its bucket belongs to no one', () => {
    expect(rowOwner({ id: 'u/preference-a', scope: 'user', user_id: 'person' })?.ref).toEqual(personRef())
    expect(rowOwner({ id: 'p/alpha/decision-a', scope: 'global', namespace: 'alpha' })).toMatchObject({ id: 'decision-a', ref: { layer: 'project', slug: 'alpha' } })
    expect(rowOwner({ id: 'decision-a', scope: 'global', namespace: 'default' })).toBeUndefined()
    expect(rowOwner({ id: 'p/alpha/decision-a', scope: 'global', namespace: 'beta' })).toBeUndefined()
    expect(rowOwner({ id: 'u/preference-a', scope: 'global', namespace: 'default' })).toBeUndefined()
    expect(rowOwner({ id: 'p/Not A Slug/x' })).toBeUndefined()
  })

  test('one pass over the file serves every bucket, and the counts tell them apart', async () => {
    await withSandbox(async () => {
      await saveItem(projectRef('alpha'), item({ id: 'decision-a1', title: 'A1' }))
      await saveItem(projectRef('alpha'), item({ id: 'decision-a2', title: 'A2' }))
      await saveItem(projectRef('beta'), item({ id: 'decision-b1', title: 'B1' }))
      await saveItem(personRef(), item({ id: 'preference-p1', title: 'P1', kind: 'preference', layer: 'person' }))
      await cortexFor(brainDbFile()).call('memory_save', { memory_id: 'stray', content: 'not ours' })
      const c = await bucketCounts()
      expect(c.person).toBe(1)
      expect([...c.projects].sort()).toEqual([['alpha', 2], ['beta', 1]])
      expect(c.foreign).toBe(1)
      expect(await bucketExists(projectRef('alpha'))).toBe(true)
      expect(await bucketExists(projectRef('gamma'))).toBe(false)
    })
  })

  test('a write by another process shows up: the cache is tied to the file', async () => {
    await withSandbox(async () => {
      await saveItem(projectRef('alpha'), item({ id: 'decision-a1', title: 'A1' }))
      expect(await listAll(projectRef('alpha'))).toHaveLength(1)
      // Another process writes to a different project of the same file.
      await cortexFor(brainDbFile()).call('memory_save', { ...storedSave(projectRef('alpha'), item({ id: 'decision-a2', title: 'A2' })) })
      expect((await listAll(projectRef('alpha'))).map(i => i.id).sort()).toEqual(['decision-a1', 'decision-a2'])
    })
  })

  test('deleting a bucket removes its rows by prefix and leaves every other bucket whole', async () => {
    await withSandbox(async () => {
      await saveItem(projectRef('alpha'), item({ id: 'decision-a1', title: 'A1' }))
      await saveItem(projectRef('alpha'), item({ id: 'decision-a2', title: 'A2' }))
      await saveItem(projectRef('alpha-two'), item({ id: 'decision-t1', title: 'T1' }))
      await saveItem(personRef(), item({ id: 'preference-p1', title: 'P1', kind: 'preference', layer: 'person' }))
      expect(await deleteBucket(projectRef('alpha'))).toBe(2)
      expect(await listAll(projectRef('alpha'))).toEqual([])
      expect((await listAll(projectRef('alpha-two'))).map(i => i.id)).toEqual(['decision-t1'])
      expect((await listAll(personRef())).map(i => i.id)).toEqual(['preference-p1'])
      expect(await bucketExists(projectRef('alpha'))).toBe(false)
      expect(await deleteBucket(projectRef('alpha'))).toBe(0)
    })
  })

  test('a superseded memory points at the plain id of its successor, and the engine hides it from search', async () => {
    await withSandbox(async () => {
      const ref = projectRef('alpha')
      await saveItem(ref, item({ id: 'decision-old', title: 'Orders on postgres' }))
      await saveItem(ref, item({ id: 'decision-new', title: 'Orders on cockroach' }), {}, { supersedes: ['decision-old'] })
      const old = await getStored(ref, 'decision-old')
      expect(old?.item).toMatchObject({ status: 'superseded', supersededBy: 'decision-new' })
      expect(old?.keep['superseded_by']).toBe('decision-new')
      expect((await rawOf('p/alpha/decision-old'))?.['metadata']).toMatchObject({ superseded_by: 'p/alpha/decision-new' })
      // A re-save of the old one keeps it retired, whatever bucket prefix the engine stored.
      await saveItem(ref, { ...(old?.item as MemItem), version: 2 }, old?.keep)
      expect((await getStored(ref, 'decision-old'))?.item).toMatchObject({ status: 'superseded', supersededBy: 'decision-new' })
      expect((await searchLayer(ref, 'orders', 10)).map(h => h.item.id)).toEqual(['decision-new'])
    })
  })

  test('the engine learns the review state, and what a memory is about becomes its graph', async () => {
    await withSandbox(async () => {
      const ref = projectRef('alpha')
      await saveItem(ref, item({ id: 'gotcha-retries', title: 'Retries double-charge', kind: 'gotcha', about: ['Payments'], sources: ['src/payments/retry.ts:10-20'], review: 'ok', verifiedBy: 'user', verifiedAt: '2026-10-13T11:00:00.000Z' }))
      await saveItem(ref, item({ id: 'gotcha-pending', title: 'Unrelated pending words', kind: 'gotcha', origin: 'inferred' }))
      expect(await rawOf('p/alpha/gotcha-retries')).toMatchObject({ review_status: 'accepted' })
      expect(await rawOf('p/alpha/gotcha-pending')).toMatchObject({ review_status: 'proposed' })
      // A search narrowed by `about` follows the graph: the memory is found without one of its words in the query.
      expect((await searchLayer(ref, 'qzxv plainly distinct', 10)).map(h => h.item.id)).toEqual([])
      expect((await searchLayer(ref, 'qzxv plainly distinct', 10, { about: ['payments'] })).map(h => h.item.id)).toEqual(['gotcha-retries'])
      expect((await searchLayer(ref, 'qzxv plainly distinct', 10, { about: ['src/payments/retry.ts'] })).map(h => h.item.id)).toEqual(['gotcha-retries'])
      expect((await searchLayer(projectRef('beta'), 'qzxv plainly distinct', 10, { about: ['payments'] }))).toEqual([])
    })
  })

  test.skipIf(REAL_CORTEXDB)('when the engine rejects the graph, the memory is still saved without it', async () => {
    await withSandbox(async () => {
      const ref = projectRef('alpha')
      await withEnv({ FAKE_CORTEXDB_REJECT_GRAPH: '1' }, async () => {
        await closeAllCortex()
        await saveItem(ref, item({ id: 'gotcha-graph', title: 'Saved without a graph', about: ['payments'], sources: ['src/a.ts'] }))
      })
      await closeAllCortex()
      expect((await getStored(ref, 'gotcha-graph'))?.item.title).toBe('Saved without a graph')
      expect((await searchLayer(ref, 'nothing matches this', 10, { about: ['payments'] }))).toEqual([])
    })
  })

  test('writers of different projects do not wait for each other, writers of one project do', async () => {
    await withSandbox(async () => {
      const a = tryLock(brainLockFile(refKey(projectRef('alpha'))), 60_000)
      expect(a).toBeDefined()
      try {
        expect(await withBrainLock(projectRef('beta'), async () => 'beta wrote', { timeoutMs: 100 })).toBe('beta wrote')
        expect(await withBrainLock(personRef(), async () => 'person wrote', { timeoutMs: 100 })).toBe('person wrote')
        await expect(withBrainLock(projectRef('alpha'), async () => 'never', { timeoutMs: 50 })).rejects.toMatchObject({ code: 'busy' })
      } finally {
        a?.()
      }
    })
  })

  test('deleting one memory by its plain id touches only its bucket', async () => {
    await withBrain(async () => {
      await saveItem(projectRef('alpha'), item({ id: 'decision-same', title: 'Alpha' }))
      await saveItem(projectRef('beta'), item({ id: 'decision-same', title: 'Beta' }))
      expect(await deleteItem(projectRef('alpha'), 'decision-same')).toBe(true)
      expect(await getStored(projectRef('alpha'), 'decision-same')).toBeUndefined()
      expect((await getStored(projectRef('beta'), 'decision-same'))?.item.title).toBe('Beta')
      expect(existsSync(join(brainDbFile(), '..', 'person.db'))).toBe(false)
    })
  })
})

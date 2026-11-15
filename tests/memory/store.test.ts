import { afterEach, describe, expect, test } from 'bun:test'
import type { MemItem } from '../../src/core/memory/brain'
import { closeAllCortex, CortexError, cortexFor } from '../../src/memory/cortex'
import { brainLockFile } from '../../src/memory/layout'
import { tryLock } from '../../src/memory/lock'
import { bucketExists, deleteItem, getStored, listAll, personRef, projectRef, refKey, saveItem, searchLayer, withBrainLock } from '../../src/memory/store'
import { withEnv, withSandbox } from '../helpers/sandbox'

afterEach(async () => { await closeAllCortex() })

function item(over: Partial<MemItem> & Pick<MemItem, 'id' | 'title'>): MemItem {
  return {
    kind: 'decision', layer: 'project', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'pending',
    importance: 3, created: '2026-10-13T10:00:00Z', updated: '2026-10-13T10:00:00Z', author: 'agent', version: 1, history: [], ...over,
  }
}

describe('store', () => {
  test('a live holder keeps the brain lock past staleMs (heartbeat); a waiter gets it only after the release, and a lock wait fails as busy', async () => {
    await withSandbox(async () => {
      const ref = projectRef('alpha')
      const lock = brainLockFile(refKey(ref))
      let released = false
      const holder = withBrainLock(ref, async () => { await Bun.sleep(900); released = true }, { staleMs: 300 })
      await Bun.sleep(100)
      const attempts: boolean[] = []
      for (let n = 0; n < 7; n++) { attempts.push(tryLock(lock, 300) !== undefined); await Bun.sleep(100) }
      expect(attempts).toEqual([false, false, false, false, false, false, false])
      await expect(withBrainLock(ref, async () => 'never', { timeoutMs: 50, staleMs: 300 })).rejects.toMatchObject({ code: 'busy', message: 'the memory of alpha is busy; try again' })
      await holder
      expect(released).toBe(true)
      const release = tryLock(lock, 300)
      expect(release).toBeDefined()
      release?.()
    })
  })

  test('a saved memory reads back whole, with its body and metadata', async () => {
    await withSandbox(async () => {
      const ref = projectRef('alpha')
      await saveItem(ref, item({ id: 'decision-use-cortexdb', title: 'Use CortexDB per project', summary: 'One file per project', body: 'Nothing leaks.', tags: ['memory'], sources: ['src/memory/store.ts:10'] }))
      const got = await getStored(ref, 'decision-use-cortexdb')
      expect(got?.item.title).toBe('Use CortexDB per project')
      expect(got?.item.summary).toBe('One file per project')
      expect(got?.item.body).toBe('Nothing leaks.')
      expect(got?.item.tags).toEqual(['memory'])
      expect(got?.item.sources).toEqual(['src/memory/store.ts:10'])
      expect(got?.item.layer).toBe('project')
      const all = await listAll(ref)
      expect(all.map(i => i.id)).toEqual(['decision-use-cortexdb'])
    })
  })

  test('search reaches Turkish inflections and the dotless i through the terms line', async () => {
    await withSandbox(async () => {
      const ref = personRef()
      await saveItem(ref, { ...item({ id: 'preference-short-answers', title: 'Kullanıcının yanıtları kısa olmalı', kind: 'preference' }), layer: 'person' })
      for (const q of ['yanıt', 'yanit', 'kullanici', 'KULLANICI', 'kısa']) {
        const hits = await searchLayer(ref, q, 10)
        expect(hits.map(h => h.item.id)).toEqual(['preference-short-answers'])
      }
    })
  })

  test('one project never answers for another', async () => {
    await withSandbox(async () => {
      await saveItem(projectRef('alpha'), item({ id: 'gotcha-canary', title: 'Canary only in alpha', kind: 'gotcha' }))
      expect(await listAll(projectRef('beta'))).toEqual([])
      expect(await searchLayer(projectRef('beta'), 'canary', 10)).toEqual([])
      expect(await getStored(projectRef('beta'), 'gotcha-canary')).toBeUndefined()
      expect(await bucketExists(projectRef('beta'))).toBe(false)
    })
  })

  test('superseding hides the old memory from search and marks it superseded', async () => {
    await withSandbox(async () => {
      const ref = projectRef('alpha')
      await saveItem(ref, item({ id: 'decision-orders-on-postgres', title: 'Orders live in PostgreSQL' }))
      await saveItem(ref, item({ id: 'decision-orders-on-cockroach', title: 'Orders live in CockroachDB' }), {}, { supersedes: ['decision-orders-on-postgres'] })
      expect((await searchLayer(ref, 'orders', 10)).map(h => h.item.id)).toEqual(['decision-orders-on-cockroach'])
      const old = await getStored(ref, 'decision-orders-on-postgres')
      expect(old?.item.status).toBe('superseded')
      expect(old?.item.supersededBy).toBe('decision-orders-on-cockroach')
    })
  })

  test('delete removes a memory and reports a missing one', async () => {
    await withSandbox(async () => {
      const ref = projectRef('alpha')
      await saveItem(ref, item({ id: 'decision-x', title: 'X' }))
      expect(await deleteItem(ref, 'decision-x')).toBe(true)
      expect(await deleteItem(ref, 'decision-x')).toBe(false)
      expect(await getStored(ref, 'decision-x')).toBeUndefined()
    })
  })

  test('the child gets only CORTEXDB_PATH of the CortexDB variables', async () => {
    await withSandbox(async (sb) => {
      await withEnv({ CORTEXDB_REMOTE: 'brain.example:47821', CORTEXDB_EMBED_BASE_URL: 'http://embed.example' }, async () => {
        const { cortexEnv } = await import('../../src/memory/cortex')
        const env = cortexEnv(`${sb.home}/x.db`)
        expect(env['CORTEXDB_PATH']).toBe(`${sb.home}/x.db`)
        expect(env['CORTEXDB_REMOTE']).toBeUndefined()
        expect(env['CORTEXDB_EMBED_BASE_URL']).toBeUndefined()
      })
    })
  })

  test('a missing binary is a not_installed error', async () => {
    await withSandbox(async (sb) => {
      await withEnv({ BURACLE_CORTEXDB_BIN: `${sb.root}/nope` }, async () => {
        const err = await cortexFor(`${sb.home}/y.db`).call('memory_list_all', {}).catch(e => e)
        expect(err).toBeInstanceOf(CortexError)
        expect((err as CortexError).code).toBe('not_installed')
      })
    })
  })
})

import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_DISAGREES_TAG } from '../../src/core/memory/brain'
import { VERIFY_BY } from '../../src/core/memory/verify'
import { remember, update, write } from '../../src/memory/api'
import { appendReflectRun, markReflectUndone, type ReflectRunEntry } from '../../src/memory/reflect-log'
import { CAPTURE_STRIKES, CURATOR_STRIKES, DUPLICATE_STRIKES } from '../../src/memory/settle'
import { getStored, projectRef, saveItem } from '../../src/memory/store'
import { sweepLayer } from '../../src/memory/sweep'
import { readUpkeep } from '../../src/memory/upkeep-file'
import { agentCtx, git, withBrain } from './helpers'

const DAY = 86_400_000
const item = async (id: string) => (await getStored(projectRef('demo'), id))?.item

async function contradict(id: string, strikes: number, atMs: number): Promise<void> {
  const ref = projectRef('demo')
  const s = await getStored(ref, id)
  if (s === undefined) throw new Error(id)
  const at = new Date(atMs).toISOString()
  const lines = Array.from({ length: strikes }, (_, n) => ({ at, by: VERIFY_BY, what: `verify vf-${n}: contradicted: the table is orders_v2` }))
  await saveItem(ref, { ...s.item, review: 'pending', contradictedAt: at, contradictedNote: 'the table is orders_v2 (src/orders.ts)', updated: at, version: s.item.version + 1, history: [...s.item.history, ...lines].slice(-8) }, s.keep)
}

describe('the sweep settles contradictions and gone sources', () => {
  test('a fact contradicted twice, or once for a week, is retired; a decision or a pinned memory is kept, tagged and quiet; a fresh strike waits', async () => {
    await withBrain(async ({ repo }) => {
      const now = Date.now()
      const gotcha = (await write(agentCtx(repo), { type: 'gotcha', title: 'Orders are stored in the orders_v1 table', summary: 'table', body: 'See the table.' })).id
      const decision = (await write(agentCtx(repo), { type: 'decision', title: 'Orders stay in one table', summary: 'one table', body: 'Chosen for simplicity.' })).id
      const pinned = (await write(agentCtx(repo), { type: 'knowledge', title: 'The orders table is never renamed', summary: 'stable name', body: 'By agreement.', pin: true })).id
      const young = (await write(agentCtx(repo), { type: 'knowledge', title: 'Refunds run nightly', summary: 'nightly', body: 'A cron at two.' })).id
      const old = (await write(agentCtx(repo), { type: 'knowledge', title: 'Invoices run weekly', summary: 'weekly', body: 'A cron on Mondays.' })).id
      await contradict(gotcha, 2, now - 3600_000)
      await contradict(decision, 2, now - 3600_000)
      await contradict(pinned, 2, now - 3600_000)
      await contradict(young, 1, now - 3600_000)
      await contradict(old, 1, now - 8 * DAY)
      const r = await sweepLayer(projectRef('demo'), { nowMs: now })
      expect([...(r.settled?.retired ?? [])].sort()).toEqual([gotcha, old].sort())
      expect([...(r.settled?.kept ?? [])].sort()).toEqual([decision, pinned].sort())
      const g = await item(gotcha)
      expect(g).toMatchObject({ status: 'deprecated' })
      expect(g?.deprecatedAt).toBeDefined()
      expect(g?.history.at(-1)?.what).toBe('retired: the code contradicts it (the table is orders_v2 (src/orders.ts))')
      const d = await item(decision)
      expect(d?.status).toBe('active')
      expect(d?.tags).toContain(CODE_DISAGREES_TAG)
      expect(d?.contradictedAt).toBeUndefined()
      expect(d?.review).toBe('pending')
      expect(d?.body).toContain('## The code disagrees (')
      expect(d?.body).toContain('the table is orders_v2 (src/orders.ts)')
      expect((await item(pinned))?.tags).toContain(CODE_DISAGREES_TAG)
      expect((await item(young))?.contradictedAt).toBeDefined()
      expect(readUpkeep('demo')?.items.find(u => u.id === young)?.reasons).toContain('contradicted')
      expect(readUpkeep('demo')?.items.find(u => u.id === decision)?.reasons ?? []).not.toContain('contradicted')
      expect((await sweepLayer(projectRef('demo'), { nowMs: now })).settled).toBeUndefined()
    })
  })

  test('a cited file gone for a week with no file of the same name is dropped; a fresh one waits with its date', async () => {
    await withBrain(async ({ repo }) => {
      mkdirSync(join(repo, 'src'), { recursive: true })
      writeFileSync(join(repo, 'src', 'orders.ts'), 'export const ORDERS_TABLE = "orders_v2"\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'orders')
      const now = Date.now()
      const gone = (await write(agentCtx(repo), { type: 'knowledge', title: 'Refunds live in their own module', summary: 'module', body: 'See the module.', sources: ['src/refunds.ts:1', 'src/orders.ts'], review: 'ok' })).id
      const first = await sweepLayer(projectRef('demo'), { nowMs: now })
      expect(first.dropped).toBeUndefined()
      const seen = readUpkeep('demo')?.items.find(u => u.id === gone)
      expect(seen?.reasons).toContain('source-missing')
      expect(Date.parse(seen?.since ?? '')).toBeGreaterThanOrEqual(now)
      expect(Date.parse(seen?.since ?? '')).toBeLessThan(now + 60_000)
      expect((await item(gone))?.sources).toEqual(['src/refunds.ts:1', 'src/orders.ts'])
      const later = now + 8 * DAY
      const second = await sweepLayer(projectRef('demo'), { nowMs: later })
      expect(second.dropped).toEqual([{ id: gone, files: ['src/refunds.ts'] }])
      const after = await item(gone)
      expect(after?.sources).toEqual(['src/orders.ts'])
      expect(after?.review).toBe('pending')
      expect(after?.history.at(-1)?.what).toBe('dropped cited files that are gone: src/refunds.ts')
      expect(readUpkeep('demo')?.items.find(u => u.id === gone)?.reasons ?? []).not.toContain('source-missing')
    })
  })

  test('a capture that three reflect runs showed and left unfiled is dropped; two runs, runs before its last change, dry and undone runs do not count; a pinned capture stays', async () => {
    await withBrain(async ({ repo }) => {
      const now = Date.now()
      const ref = projectRef('demo')
      const ctx = agentCtx(repo)
      const note = (await remember(ctx, 'bunu test amaçlı hatırlamanı istiyorum')).id
      const draft = (await remember(ctx, 'a second note that only two runs saw')).id
      const pinned = (await remember(ctx, 'a pinned note nobody files')).id
      const p = await getStored(ref, pinned)
      await saveItem(ref, { ...(p as NonNullable<typeof p>).item, pinned: true }, (p as NonNullable<typeof p>).keep)
      let n = 0
      const run = async (atMs: number, focus: string[], over: Partial<ReflectRunEntry> = {}): Promise<string> => {
        const id = `rf-test-${String(++n).padStart(4, '0')}`
        const entry: ReflectRunEntry = {
          v: 1, id, at: new Date(atMs).toISOString(), layer: 'project', project: 'demo', trigger: 'tick', model: 'default',
          rounds: 1, subQueries: 0, shown: focus.length, focus, proposed: 0, applied: [], rejected: [], inputChars: 10, outputChars: 10, ...over,
        }
        expect(await appendReflectRun(entry, now)).toBe(true)
        return id
      }
      await run(now - 3600_000, [note, draft, pinned])
      await run(now + 1000, [note, pinned], { dryRun: true })
      await markReflectUndone(await run(now + 2000, [note, draft]), new Date(now + 2500).toISOString())
      await run(now + 3000, [note, draft, pinned])
      await run(now + 4000, [note, draft, pinned])
      await run(now + 5000, [note, pinned])
      expect(CAPTURE_STRIKES).toBe(3)
      const r = await sweepLayer(ref, { nowMs: now + 10_000 })
      expect(r.unfiled).toEqual([note])
      const dropped = await item(note)
      expect(dropped).toMatchObject({ status: 'deprecated', kind: 'capture' })
      expect(dropped?.deprecatedAt).toBeDefined()
      expect(dropped?.history.at(-1)?.what).toBe('dropped: 3 reflect runs left it unfiled')
      expect((await item(draft))?.status).toBe('active')
      expect((await item(pinned))?.status).toBe('active')
      const backlog = (readUpkeep('demo')?.items ?? []).map(u => u.id)
      expect(backlog).not.toContain(note)
      expect(backlog).toContain(draft)
      expect((await sweepLayer(ref, { nowMs: now + 20_000 })).unfiled).toBeUndefined()
    })
  })
})

describe('what reflect leaves alone does not wait', () => {
  let n = 0
  const run = async (atMs: number, focus: string[]): Promise<void> => {
    const entry: ReflectRunEntry = {
      v: 1, id: `rf-left-${String(++n).padStart(4, '0')}`, at: new Date(atMs).toISOString(), layer: 'project', project: 'demo', trigger: 'tick', model: 'default',
      rounds: 1, subQueries: 0, shown: focus.length, focus, proposed: 0, applied: [], rejected: [], inputChars: 10, outputChars: 10,
    }
    expect(await appendReflectRun(entry, atMs)).toBe(true)
  }

  test('a contradicted memory the curator leaves for three reflect runs is settled at once; runs before the contradiction do not count', async () => {
    await withBrain(async ({ repo }) => {
      const now = Date.now()
      const ref = projectRef('demo')
      const fact = (await write(agentCtx(repo), { type: 'gotcha', title: 'Orders are stored in the orders_v1 table', summary: 'table', body: 'See the table.' })).id
      const decision = (await write(agentCtx(repo), { type: 'decision', title: 'Orders stay in one table', summary: 'one table', body: 'Chosen for simplicity.' })).id
      await run(now - 3 * 3600_000, [fact, decision])
      await contradict(fact, 1, now - 2 * 3600_000)
      await contradict(decision, 1, now - 2 * 3600_000)
      await run(now - 90 * 60_000, [fact, decision])
      await run(now - 60 * 60_000, [fact, decision])
      expect((await sweepLayer(ref, { nowMs: now })).settled).toBeUndefined()
      expect(CURATOR_STRIKES).toBe(3)
      await run(now - 30 * 60_000, [fact, decision])
      const r = await sweepLayer(ref, { nowMs: now })
      expect(r.settled).toEqual({ retired: [fact], kept: [decision] })
      expect((await item(fact))?.status).toBe('deprecated')
      expect((await item(decision))?.tags).toContain(CODE_DISAGREES_TAG)
      expect(readUpkeep('demo')?.items.filter(u => u.reasons.includes('contradicted'))).toEqual([])
    })
  })

  test('a duplicate pair three reflect runs leave unmerged counts as two distinct memories (reflect\'s own edits do not reset the count); an agent\'s change flags it again', async () => {
    await withBrain(async ({ repo }) => {
      const now = Date.now()
      const ref = projectRef('demo')
      const a = (await write(agentCtx(repo), { type: 'reference', title: 'The orders are stored in CockroachDB', summary: 'orders store' })).id
      const b = (await write(agentCtx(repo), { type: 'reference', title: 'The orders are stored in CockroachDB now', summary: 'orders store', force: true })).id
      await sweepLayer(ref, { nowMs: now })
      const flagged = () => (readUpkeep('demo')?.items ?? []).filter(u => u.reasons.includes('duplicate')).map(u => [u.id, u.twin].sort())
      expect(flagged()).toEqual([[a, b].sort()])
      await run(now + 1000, [a, b])
      const s = await getStored(ref, b)
      const at = new Date(now + 1500).toISOString()
      await saveItem(ref, { ...s!.item, tags: ['orders'], updated: at, version: s!.item.version + 1, history: [...s!.item.history, { at, by: 'buracle-reflect', what: 'reflect rf-x: tags + orders' }] }, s!.keep)
      await run(now + 2000, [b])
      expect((await sweepLayer(ref, { nowMs: now + 3000 })).distinct).toBeUndefined()
      expect(DUPLICATE_STRIKES).toBe(3)
      await run(now + 4000, [a])
      const r = await sweepLayer(ref, { nowMs: now + 5000 })
      expect(r.distinct).toEqual([[a, b].sort().join('|')])
      expect(flagged()).toEqual([])
      await update({ ...agentCtx(repo), now: () => now + 6000 }, { id: b, patch: { body: 'Moved from PostgreSQL in 2026.' } })
      await sweepLayer(ref, { nowMs: now + 7000 })
      expect(flagged()).toEqual([[a, b].sort()])
    })
  })
})

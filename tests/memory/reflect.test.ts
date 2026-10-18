import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemItem } from '../../src/core/memory/brain'
import { remember, update, write } from '../../src/memory/api'
import { contextText } from '../../src/memory/context'
import { reflectRunsFile, reflectUndoFile } from '../../src/memory/layout'
import { readJobs } from '../../src/memory/jobs'
import { listReflectRuns, readReflectRuns, reflectBrain, reflectOverview, undoReflect, type ReflectRunner } from '../../src/memory/reflect'
import { getStored, listAll, personRef, projectRef, saveItem } from '../../src/memory/store'
import { sweep } from '../../src/memory/sweep'
import { readUpkeep } from '../../src/memory/upkeep-file'
import { writeTelemetry } from '../../src/workflow/session-store'
import { withEnv } from '../helpers/sandbox'
import { agentCtx, git, withBrain } from './helpers'

const SID_A = '0199a213-81c0-7800-8aa1-bbab2a035a61'
const SID_B = '0199a213-81c0-7800-8aa1-bbab2a035a62'

function scripted(replies: Array<unknown | ((prompt: string) => unknown | Promise<unknown>)>): ReflectRunner & { prompts: string[] } {
  const prompts: string[] = []
  const fn: ReflectRunner = async (prompt: string) => {
    prompts.push(prompt)
    const next = replies.shift()
    const value = typeof next === 'function' ? await (next as (p: string) => unknown)(prompt) : next
    return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value ?? { ops: [] }) }
  }
  return Object.assign(fn, { prompts })
}

interface Seed { orders: string, ranges: string, flaky: string, payments: string, capture: string }

async function seed(repo: string): Promise<Seed> {
  const ctx = agentCtx(repo)
  const orders = (await write(ctx, { type: 'decision', title: 'Orders live in CockroachDB', summary: 'moved from PostgreSQL', tags: ['db'], review: 'ok' })).id
  const ranges = (await write(ctx, { type: 'knowledge', title: 'CockroachDB ranges split at 512 MiB', summary: 'range size', tags: ['db'], review: 'ok' })).id
  const payments = (await write(ctx, { type: 'decision', title: 'Payments go through Stripe', summary: 'one provider', tags: ['db'], review: 'ok' })).id
  const flaky = (await write(ctx, { type: 'gotcha', title: 'The flaky test needs a running server', summary: 'start it first', tags: ['test'] })).id
  const capture = (await remember(ctx, 'Cache TTL of the orders service is 5 minutes')).id
  return { orders, ranges, flaky, payments, capture }
}

const byId = async (id: string): Promise<MemItem | undefined> => (await getStored(projectRef('demo'), id))?.item

describe('reflect', () => {
  test('two rounds: a sub-query shows more memories, the allowlist decides, the brain records who changed what', async () => {
    await withBrain(async ({ repo }) => {
      const s = await seed(repo)
      const runner = scripted([
        { queries: [{ for: s.flaky, q: 'cockroachdb' }] },
        {
          ops: [
            { op: 'tag', id: s.flaky, add: ['testing'], why: 'group the test gotchas' },
            { op: 'relate', id: s.flaky, to: s.orders, why: 'the test hits the orders database' },
            { op: 'doubt', id: s.ranges, reason: 'the range size is configurable now', why: 'version change' },
            { op: 'file', id: s.capture, kind: 'knowledge', why: 'a stable fact' },
            { op: 'tag', id: s.payments, add: ['stripe'], why: 'never shown' },
            { op: 'delete', id: s.orders, why: 'not allowed' },
          ],
        },
      ])
      const run = await reflectBrain(projectRef('demo'), { trigger: 'manual', runner })
      expect(run.skipped).toBeUndefined()
      expect(run.rounds).toBe(2)
      expect(run.subQueries).toBe(1)
      expect(runner.prompts[0]).toContain(s.flaky)
      expect(runner.prompts[0]).toContain(s.capture)
      expect(runner.prompts[0]).not.toContain(s.orders)
      expect(runner.prompts[1]).toContain(s.orders)
      expect(runner.prompts[1]).toContain(s.ranges)
      expect(runner.prompts[1]).not.toContain(s.payments)
      expect(run.applied.map(a => a.op)).toEqual(['tag', 'relate', 'doubt', 'file'])
      expect(run.rejected).toEqual([{ op: 'tag', id: s.payments, reason: 'not-shown' }, { op: 'delete', id: s.orders, reason: 'unknown-op' }])
      expect(run.logged).toBe(true)

      const flaky = await byId(s.flaky)
      expect(flaky?.tags).toEqual(['test', 'testing'])
      expect(flaky?.sources).toEqual([`memory:${s.orders}`])
      expect(flaky?.review).toBe('pending')
      expect(flaky?.history.slice(-2).map(h => h.by)).toEqual(['buracle-reflect', 'buracle-reflect'])
      expect(flaky?.history.at(-1)?.what).toBe(`reflect ${run.id}: related to ${s.orders}`)
      const ranges = await byId(s.ranges)
      expect(ranges?.review).toBe('pending')
      expect(ranges?.title).toBe('CockroachDB ranges split at 512 MiB')
      expect(ranges?.history.at(-1)?.what).toContain('doubt: the range size is configurable now')
      expect(await byId(s.capture)).toBeUndefined()
      const filed = (await listAll(projectRef('demo'))).find(i => i.title === 'Cache TTL of the orders service is 5 minutes')
      expect(filed).toMatchObject({ kind: 'knowledge', review: 'pending' })
      expect(filed?.id.startsWith('knowledge-')).toBe(true)
      expect((await byId(s.payments))?.version).toBe(1)
      expect((await byId(s.orders))?.status).toBe('active')
      const logged = readFileSync(reflectRunsFile(), 'utf8')
      expect(logged).not.toContain('moved from PostgreSQL')
      expect(logged).not.toContain('Cache TTL')
      expect(existsSync(reflectUndoFile(run.id))).toBe(true)
    })
  })

  test('a memory that changed while the model thought is skipped with reason changed', async () => {
    await withBrain(async ({ repo }) => {
      const s = await seed(repo)
      const runner = scripted([
        async () => {
          await update(agentCtx(repo), { id: s.flaky, patch: { review: 'ok' } })
          return { queries: [], ops: [{ op: 'tag', id: s.flaky, add: ['testing'] }, { op: 'tag', id: s.capture, add: ['cache'] }] }
        },
      ])
      const run = await reflectBrain(projectRef('demo'), { trigger: 'manual', runner })
      expect(run.rounds).toBe(1)
      expect(run.applied.map(a => a.id)).toEqual([s.capture])
      expect(run.rejected).toEqual([{ op: 'tag', id: s.flaky, reason: 'changed' }])
      expect((await byId(s.flaky))?.tags).toEqual(['test'])
    })
  })

  test('a dry run applies nothing, writes no undo journal and logs the plan', async () => {
    await withBrain(async ({ repo }) => {
      const s = await seed(repo)
      const before = await listAll(projectRef('demo'))
      const run = await reflectBrain(projectRef('demo'), { trigger: 'manual', dryRun: true, runner: scripted([{ ops: [{ op: 'tag', id: s.flaky, add: ['testing'] }] }]) })
      expect(run.dryRun).toBe(true)
      expect(run.applied).toEqual([])
      expect(run.planned).toEqual([{ op: 'tag', id: s.flaky, why: '' }])
      expect(existsSync(reflectUndoFile(run.id))).toBe(false)
      expect((await listAll(projectRef('demo'))).map(i => `${i.id}@${i.version}`).sort()).toEqual(before.map(i => `${i.id}@${i.version}`).sort())
      expect(readReflectRuns().map(e => e.id)).toEqual([run.id])
      expect(listReflectRuns()[0]?.undo).toBeUndefined()
    })
  })

  test('the session\'s harness and model go first and reach the runner and the log; when every harness with room is held, the run waits', async () => {
    await withBrain(async ({ repo, root }) => {
      const s = await seed(repo)
      const models: Array<string | undefined> = []
      const runner: ReflectRunner = async (_p, o) => { models.push(o.model); return { ok: true, text: JSON.stringify({ ops: [{ op: 'tag', id: s.flaky, add: ['testing'] }] }) } }
      writeTelemetry('claude', SID_A, { at: Date.now(), windows: [{ label: '7d', pct: 99 }] })
      const run = await reflectBrain(projectRef('demo'), { trigger: 'manual', harness: 'codex', model: 'gpt-6-luna', runner })
      expect(run).toMatchObject({ harness: 'codex', model: 'gpt-6-luna', rounds: 1 })
      expect(models).toEqual(['gpt-6-luna'])
      expect(readReflectRuns().at(-1)).toMatchObject({ harness: 'codex', model: 'gpt-6-luna' })
      expect(await reflectBrain(projectRef('demo'), { trigger: 'manual', harness: 'omp', runner })).toMatchObject({ harness: 'omp', model: 'default' })
      expect(models).toEqual(['gpt-6-luna', undefined])
      writeTelemetry('codex', SID_B, { at: Date.now() + 1, windows: [{ label: '5h', pct: 90 }] })
      expect(await reflectBrain(projectRef('demo'), { trigger: 'manual', harness: 'codex', runner })).toMatchObject({ skipped: 'rate-limit', detail: expect.stringContaining('codex: 5-hour window at 90% (limit 75%); claude: 7-day window at 99% (limit 85%)'), rounds: 0 })
      const empty = join(root, 'empty-bin')
      mkdirSync(empty, { recursive: true })
      writeTelemetry('codex', SID_B, { at: Date.now() + 2, windows: [] })
      await withEnv({ BURACLE_NO_REFLECT: undefined, PATH: empty }, async () => {
        expect(await reflectBrain(projectRef('demo'), { trigger: 'manual', harness: 'codex' })).toMatchObject({ skipped: 'rate-limit', detail: expect.stringContaining('codex: codex is not on PATH; claude: 7-day window at 99% (limit 85%)'), rounds: 0 })
      })
      expect(models).toHaveLength(2)
    })
  })

  test('no cap and no interval: a brain is reflected whenever it changed; BURACLE_NO_REFLECT and nothing to do', async () => {
    await withBrain(async ({ repo }) => {
      expect((await reflectBrain(projectRef('demo'), { trigger: 'manual', runner: scripted([]) })).skipped).toBe('no-brain')
      const s = await seed(repo)
      const off = await reflectBrain(projectRef('demo'), { trigger: 'manual' })
      expect(off).toMatchObject({ skipped: 'disabled', detail: 'BURACLE_NO_REFLECT=1', rounds: 0, logged: false })
      const first = await reflectBrain(projectRef('demo'), { trigger: 'session-end', runner: scripted([{ ops: [{ op: 'tag', id: s.flaky, add: ['testing'] }] }]) })
      expect(first.applied).toHaveLength(1)
      expect(await reflectBrain(projectRef('demo'), { trigger: 'session-end', runner: scripted([]) })).toMatchObject({ skipped: 'unchanged', logged: false })
      expect(await reflectBrain(projectRef('demo'), { trigger: 'tick', runner: scripted([]) })).toMatchObject({ skipped: 'unchanged', logged: false })
      const written = (await write(agentCtx(repo), { type: 'gotcha', title: 'The test server needs port 3000 free', summary: 'kill the old one' })).id
      const again = await reflectBrain(projectRef('demo'), { trigger: 'tick', runner: scripted([{ ops: [{ op: 'tag', id: written, add: ['ports'] }] }]) })
      expect(again).toMatchObject({ rounds: 1 })
      expect(again.applied.map(a => a.id)).toEqual([written])
      await write(agentCtx(repo), { type: 'knowledge', layer: 'person', title: 'Bun runs TypeScript directly', tags: ['bun'], review: 'ok' })
      await write(agentCtx(repo), { type: 'knowledge', layer: 'person', title: 'Bun has a test runner', tags: ['bun'], review: 'ok' })
      const runner = scripted([])
      expect(await reflectBrain(personRef(), { trigger: 'manual', runner })).toMatchObject({ skipped: 'nothing-to-do', rounds: 0 })
      expect(runner.prompts).toEqual([])
      for (let i = 0; i < 8; i++) expect((await reflectBrain(projectRef('demo'), { trigger: 'manual', runner: scripted([{ ops: [] }]) })).rounds).toBeGreaterThan(0)
    })
  })

  test('undo restores exactly what the run changed, un-merges, retires drafts, and reports conflicts', async () => {
    await withBrain(async ({ repo }) => {
      const s = await seed(repo)
      const ctx = agentCtx(repo)
      const keep = (await write(ctx, { type: 'knowledge', title: 'The API uses gRPC for internal calls', summary: 'protobuf', tags: ['api'], sources: ['src/api.ts'], review: 'ok' })).id
      const twin = (await write(ctx, { type: 'knowledge', title: 'The API uses gRPC for all internal calls', tags: ['grpc'], sources: ['src/rpc.ts'], force: true })).id
      const snapshot = async () => (await listAll(projectRef('demo'))).filter(i => i.status !== 'superseded' || i.id === twin)
        .map(i => ({ id: i.id, kind: i.kind, tags: i.tags, about: i.about, sources: i.sources, summary: i.summary, review: i.review, status: i.status }))
        .sort((a, b) => a.id.localeCompare(b.id))
      const before = await snapshot()
      const run = await reflectBrain(projectRef('demo'), {
        trigger: 'manual',
        runner: scripted([{
          ops: [
            { op: 'merge', id: twin, into: keep, why: 'same claim' },
            { op: 'tag', id: s.flaky, add: ['testing'] },
            { op: 'about', id: s.flaky, add: ['bun test'] },
            { op: 'summary', id: s.flaky, text: 'Start the server before the suite.' },
            { op: 'file', id: s.capture, kind: 'reference' },
            { op: 'synthesize', from: [keep, s.flaky], title: 'Integration tests need the gRPC server running', body: 'Both memories point at a server the tests need.' },
          ],
        }]),
      })
      expect(run.applied.map(a => a.op)).toEqual(['tag', 'about', 'summary', 'merge', 'synthesize', 'file'])
      expect((await byId(twin))?.status).toBe('superseded')
      expect((await byId(keep))?.tags).toEqual(['api', 'grpc'])
      expect((await byId(keep))?.sources).toEqual(['src/api.ts', 'src/rpc.ts'])
      const draftId = run.applied.find(a => a.op === 'synthesize')?.id as string
      expect(await byId(draftId)).toMatchObject({ kind: 'capture', review: 'pending', author: 'buracle', sources: [`memory:${keep}`, `memory:${s.flaky}`] })
      const view = listReflectRuns()[0]
      expect(view?.undo).toBe(`buracle mem reflect --undo ${run.id}`)

      const u = await undoReflect(run.id)
      expect(u.conflicts).toEqual([])
      expect(u.retired).toEqual([draftId])
      expect(u.restored.sort()).toEqual([keep, s.capture, s.flaky, twin].sort())
      const after = (await snapshot()).filter(i => i.id !== draftId)
      expect(after).toEqual(before)
      expect((await byId(twin))?.status).toBe('active')
      expect((await byId(draftId))?.status).toBe('deprecated')
      expect((await byId(s.flaky))?.history.at(-1)).toMatchObject({ by: 'buracle-reflect', what: `reflect ${run.id} undone: restored` })
      expect(readReflectRuns().find(e => e.id === run.id)?.undone).toBeDefined()
      expect(listReflectRuns()[0]?.undo).toBeUndefined()
      await expect(undoReflect(run.id)).rejects.toThrow('undone already')
      await expect(undoReflect('../../etc/passwd')).rejects.toThrow('not a reflect run id')

      const second = await reflectBrain(projectRef('demo'), { trigger: 'manual', runner: scripted([{ ops: [{ op: 'tag', id: s.flaky, add: ['later'] }, { op: 'tag', id: keep, add: ['wire'] }] }]) })
      expect(second.applied).toHaveLength(2)
      await update(ctx, { id: s.flaky, patch: { tags: ['test', 'later', 'mine'] } })
      const u2 = await undoReflect(second.id)
      expect(u2.conflicts).toEqual([{ id: s.flaky, reason: 'changed' }])
      expect(u2.restored).toEqual([keep])
      expect((await byId(s.flaky))?.tags).toEqual(['test', 'later', 'mine'])
      expect((await byId(keep))?.tags).toEqual(['api'])
    })
  })

  test('overview: the switches, the guards and the runs of one brain', async () => {
    await withBrain(async ({ repo }) => {
      const s = await seed(repo)
      const run = await reflectBrain(projectRef('demo'), { trigger: 'manual', runner: scripted([{ ops: [{ op: 'tag', id: s.flaky, add: ['testing'], why: 'group' }] }]) })
      const o = reflectOverview({ kind: 'project', slug: 'demo' }, Date.now())
      expect(o.scope).toBe('project:demo')
      expect(o.config).toEqual({ harnesses: [], held: [], maxOpsPerRun: 8, maxSubQueries: 6, relateEveryMin: 360, runsToday: 1 })
      expect(o.guards).toEqual(['allowlist', 'shown-only', 'no-delete', 'no-verify', 'claims-locked', 'generated-locked', 'redacted', 'budget', 'lock-and-version', 'undo', 'local-only'])
      expect(o.runs).toHaveLength(1)
      expect(o.runs[0]).toMatchObject({ id: run.id, layer: 'project', project: 'demo', trigger: 'manual', model: 'default', applied: [{ op: 'tag', id: s.flaky, why: 'group' }], undo: `buracle mem reflect --undo ${run.id}` })
      expect(reflectOverview({ kind: 'person' }, Date.now()).runs).toEqual([])
    })
  })

  test('the person brain is reflected when it changed, whoever starts the run; an unchanged brain is no news for the journal', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'knowledge', layer: 'person', title: 'Bun has a built-in test runner', summary: 'bun test' })
      const now = Date.now()
      const first = await reflectBrain(personRef(), { trigger: 'heal', nowMs: now, runner: scripted([{ ops: [] }]) })
      expect({ skipped: first.skipped, detail: first.detail, logged: first.logged, rounds: first.rounds }).toEqual({ skipped: undefined, detail: undefined, logged: true, rounds: 1 })
      const second = await reflectBrain(personRef(), { trigger: 'heal', nowMs: now + 2 * 3600_000, runner: scripted([]) })
      expect(second).toMatchObject({ skipped: 'unchanged', logged: false })
      await write(agentCtx(repo), { type: 'knowledge', layer: 'person', title: 'Bun bundles TypeScript with its own transpiler', summary: 'no tsc at run time' })
      const third = await reflectBrain(personRef(), { trigger: 'session-end', nowMs: now + 3 * 3600_000, runner: scripted([{ ops: [] }]) })
      expect({ skipped: third.skipped, detail: third.detail, rounds: third.rounds }).toEqual({ skipped: undefined, detail: undefined, rounds: 1 })
      const journal = readJobs().filter(e => e.job === 'reflect')
      expect(journal.map(e => [e.trigger, e.outcome, e.reason ?? null, e.layer])).toEqual([
        ['heal', 'ran', null, 'person'], ['session-end', 'ran', null, 'person'],
      ])
    })
  })

  test('the curator: a contradicted memory is restated from the code excerpts, a memory with a gone file is re-sourced from the candidates, one is retired; undo puts all three back', async () => {
    await withBrain(async ({ repo }) => {
      mkdirSync(join(repo, 'src', 'orders'), { recursive: true })
      mkdirSync(join(repo, 'lib', 'cache'), { recursive: true })
      mkdirSync(join(repo, 'app', 'cache'), { recursive: true })
      writeFileSync(join(repo, 'src', 'orders', 'db.ts'), 'import { Pool } from "cockroachdb"\nexport const pool = new Pool({ db: "orders" })\n')
      writeFileSync(join(repo, 'lib', 'cache', 'ttl.ts'), 'export const TTL = 300\n')
      writeFileSync(join(repo, 'app', 'cache', 'ttl.ts'), 'export const TTL = 60\n')
      git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'files')
      const ctx = agentCtx(repo)
      const ref = projectRef('demo')
      const wrong = (await write(ctx, { type: 'decision', title: 'Orders live in PostgreSQL', summary: 'one database', body: 'The orders service writes to PostgreSQL.', sources: ['src/orders/db.ts:2'], review: 'ok' })).id
      const dead = (await write(ctx, { type: 'decision', title: 'Payments go through Braintree', summary: 'one provider', sources: ['src/orders/db.ts'], review: 'ok' })).id
      for (const id of [wrong, dead]) {
        const s = await getStored(ref, id)
        await saveItem(ref, { ...(s as NonNullable<typeof s>).item, review: 'pending', contradictedAt: new Date().toISOString(), contradictedNote: 'db.ts opens a CockroachDB pool for orders; nothing names Braintree' }, (s as NonNullable<typeof s>).keep)
      }
      const orphan = (await write(ctx, { type: 'knowledge', title: 'The cache TTL is five minutes', summary: 'TTL 300', sources: ['src/cache/ttl.ts'], review: 'ok' })).id
      await sweep({ slug: 'demo', person: false })
      const runner = scripted([(prompt: string) => {
        expect(prompt).toContain('contradicted="true"')
        expect(prompt).toContain('<evidence file="src/orders/db.ts"')
        expect(prompt).toContain('candidate-files: app/cache/ttl.ts, lib/cache/ttl.ts')
        return { ops: [
          { op: 'rewrite', id: wrong, title: 'Orders live in CockroachDB', body: 'src/orders/db.ts opens a CockroachDB pool for the orders database.', why: 'the pool is CockroachDB' },
          { op: 'sources', id: orphan, set: ['lib/cache/ttl.ts'], why: 'TTL 300 is in lib' },
          { op: 'retire', id: dead, why: 'nothing in the code names Braintree' },
          { op: 'rewrite', id: orphan, title: 'x', why: 'not contradicted' },
        ] }
      }])
      const run = await reflectBrain(ref, { trigger: 'manual', runner })
      expect(run.skipped).toBeUndefined()
      expect(run.applied.map(a => a.op)).toEqual(['rewrite', 'sources', 'retire'])
      expect(run.rejected).toEqual([{ op: 'rewrite', id: orphan, reason: 'not-contradicted' }])
      const w = await byId(wrong)
      expect(w).toMatchObject({ title: 'Orders live in CockroachDB', body: 'src/orders/db.ts opens a CockroachDB pool for the orders database.', summary: 'one database', review: 'pending' })
      expect(w?.contradictedAt).toBeUndefined()
      expect(w?.history.at(-1)?.what).toContain('restated after a contradiction')
      expect(await byId(orphan)).toMatchObject({ sources: ['lib/cache/ttl.ts'], review: 'pending' })
      expect(await byId(dead)).toMatchObject({ status: 'deprecated' })
      const undo = await undoReflect(run.id)
      expect(undo.restored.sort()).toEqual([dead, orphan, wrong].sort())
      expect(await byId(wrong)).toMatchObject({ title: 'Orders live in PostgreSQL', body: 'The orders service writes to PostgreSQL.', review: 'pending', contradictedNote: 'db.ts opens a CockroachDB pool for orders; nothing names Braintree' })
      expect((await byId(wrong))?.contradictedAt).toBeDefined()
      expect(await byId(orphan)).toMatchObject({ sources: ['src/cache/ttl.ts'], review: 'ok' })
      expect(await byId(dead)).toMatchObject({ status: 'active' })
      expect((await byId(dead))?.deprecatedAt).toBeUndefined()
    })
  })

  test('a filed capture keeps the links other memories had to it (the graph follows the new id); undo points them back', async () => {
    await withBrain(async ({ repo }) => {
      const s = await seed(repo)
      const ref = projectRef('demo')
      const linker = (await write(agentCtx(repo), { type: 'decision', title: 'Cache the orders for five minutes', summary: 'ttl', sources: [`memory:${s.capture}`], review: 'ok' })).id
      const run = await reflectBrain(ref, { trigger: 'manual', runner: scripted([{ ops: [{ op: 'file', id: s.capture, kind: 'knowledge', why: 'a stable fact' }] }]) })
      const filed = run.applied.find(a => a.op === 'file')?.to as string
      expect(filed.startsWith('knowledge-')).toBe(true)
      expect((await byId(linker))?.sources).toEqual([`memory:${filed}`])
      expect((await byId(linker))?.history.at(-1)?.what).toBe(`link followed: ${s.capture} is now ${filed}`)
      await undoReflect(run.id)
      expect((await byId(linker))?.sources).toEqual([`memory:${s.capture}`])
    })
  })

  test('reflect drafts the human part of an empty core page and keeps the detected part; the start text then lists the page; undo empties it again', async () => {
    await withBrain(async ({ repo }) => {
      await seed(repo)
      await sweep({ slug: 'demo', person: false })
      const ref = projectRef('demo')
      const block = '<!-- buracle:detected:start -->\nDetected from the repository (Buracle keeps this part current):\n- demo\n<!-- buracle:detected:end -->'
      const stored = await getStored(ref, 'core-brief')
      expect(stored?.item.body).toBe('')
      await saveItem(ref, { ...(stored as NonNullable<typeof stored>).item, body: block, version: 2 }, (stored as NonNullable<typeof stored>).keep)
      const architecture = (await byId('core-architecture'))?.body ?? ''
      const runner = scripted([(prompt: string) => {
        expect(prompt).toContain('focus="core"')
        return { ops: [
          { op: 'core', id: 'core-brief', body: 'A demo service: orders, their cache and the flaky test that needs a server.', why: 'from the decisions and gotchas shown' },
          { op: 'core', id: 'core-architecture', body: 'One repository, one service.', why: 'the structure is small' },
          { op: 'core', id: 'core-glossary', body: 'never shown: only two empty pages per run', why: 'third' },
        ] }
      }])
      const run = await reflectBrain(ref, { trigger: 'manual', runner })
      expect(run.applied.map(a => a.op)).toEqual(['core', 'core'])
      expect(run.rejected).toEqual([{ op: 'core', id: 'core-glossary', reason: 'not-shown' }])
      const brief = await byId('core-brief')
      expect(brief?.body).toBe(`A demo service: orders, their cache and the flaky test that needs a server.\n\n${block}`)
      expect(brief?.history.at(-1)?.what).toBe(`reflect ${run.id}: drafted by reflect: from the decisions and gotchas shown`)
      expect((await byId('core-architecture'))?.body.startsWith('One repository, one service.')).toBe(true)
      const text = await contextText({ cwd: repo, harness: 'claude' })
      expect(text).toContain('A demo service: orders, their cache and the flaky test that needs a server.')
      await undoReflect(run.id)
      expect((await byId('core-brief'))?.body).toBe(block)
      expect((await byId('core-architecture'))?.body).toBe(architecture)
    })
  })

  test('a capture nobody filed gets another look six hours after the last run although nothing happened in the brain', async () => {
    await withBrain(async ({ repo }) => {
      const ref = projectRef('demo')
      await remember(agentCtx(repo), 'bunu test amaçlı hatırlamanı istiyorum')
      await sweep({ slug: 'demo', person: false })
      await Bun.sleep(5)
      const now = Date.now()
      const first = await reflectBrain(ref, { trigger: 'tick', nowMs: now, runner: scripted([{ ops: [] }]) })
      expect(first.skipped).toBeUndefined()
      expect(await reflectBrain(ref, { trigger: 'tick', nowMs: now + 2 * 3600_000, runner: scripted([]) })).toMatchObject({ skipped: 'unchanged' })
      const third = await reflectBrain(ref, { trigger: 'tick', nowMs: now + 7 * 3600_000, runner: scripted([{ ops: [] }]) })
      expect(third.skipped).toBeUndefined()
      expect(third.focus?.some(id => id.startsWith('capture-'))).toBe(true)
    })
  })

  test('a capture is dropped without evidence, with its twin named; the run log keeps the focus ids; undo restores it', async () => {
    await withBrain(async ({ repo }) => {
      const s = await seed(repo)
      const note = (await remember(agentCtx(repo), 'bunu test amaçlı hatırlamanı istiyorum')).id
      const runner = scripted([(prompt: string) => {
        expect(prompt).toContain('"op":"drop"')
        expect(prompt).toContain('a capture never waits')
        return { ops: [
          { op: 'drop', id: s.capture, twin: s.flaky, why: 'the gotcha already states it' },
          { op: 'drop', id: note, why: 'a test note, nothing durable' },
          { op: 'drop', id: s.flaky, why: 'not a capture' },
        ] }
      }])
      const run = await reflectBrain(projectRef('demo'), { trigger: 'manual', runner })
      expect(run.skipped).toBeUndefined()
      expect(run.applied).toEqual([
        { op: 'drop', id: s.capture, why: 'the gotcha already states it', to: s.flaky },
        { op: 'drop', id: note, why: 'a test note, nothing durable' },
      ])
      expect(run.rejected).toEqual([{ op: 'drop', id: s.flaky, reason: 'not-capture' }])
      expect([...(run.focus ?? [])].sort()).toEqual([s.capture, s.flaky, note].sort())
      const dropped = await byId(s.capture)
      expect(dropped).toMatchObject({ status: 'deprecated', kind: 'capture' })
      expect(dropped?.deprecatedAt).toBeDefined()
      expect(dropped?.history.at(-1)?.what).toBe(`reflect ${run.id}: dropped: the gotcha already states it (already in ${s.flaky})`)
      expect((await byId(note))?.status).toBe('deprecated')
      expect((await byId(s.flaky))?.status).toBe('active')
      const logged = readReflectRuns().find(e => e.id === run.id)
      expect([...(logged?.focus ?? [])].sort()).toEqual([s.capture, s.flaky, note].sort())
      expect(readFileSync(reflectRunsFile(), 'utf8')).not.toContain('test amaçlı')
      await sweep({ slug: 'demo', person: false })
      expect((readUpkeep('demo')?.items ?? []).map(u => u.id)).not.toContain(s.capture)
      const undo = await undoReflect(run.id)
      expect(undo.restored.sort()).toEqual([s.capture, note].sort())
      expect(await byId(s.capture)).toMatchObject({ status: 'active', kind: 'capture' })
      expect((await byId(note))?.deprecatedAt).toBeUndefined()
    })
  })
})

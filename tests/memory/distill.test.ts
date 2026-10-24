import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { write } from '../../src/memory/api'
import { checkReply, currentWindows, distillSession, latestWindows, type DistillRunner } from '../../src/memory/distill'
import { runnerRefusesForGood, runnerUnavailable } from '../../src/memory/runner'
import { withEnv } from '../helpers/sandbox'
import { finalize } from '../../src/memory/finalize'
import { readSessionRecord, sessionStart, writeSessionRecord } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { getStored, listAll, personRef, projectRef } from '../../src/memory/store'
import { writeTelemetry } from '../../src/workflow/session-store'
import { agentCtx, humanCtx, withBrain } from './helpers'

const SID = '0199a213-81c0-7800-8aa1-bbab2a035a53'
const OTHER = '0199a213-81c0-7800-8aa1-bbab2a035a54'

const runner = (out: unknown): DistillRunner => async () => ({ ok: true, text: JSON.stringify(out) })

async function finishedSession(repo: string, sid = SID, excerpt = 'Moved the orders service to CockroachDB and fixed the flaky test.'): Promise<void> {
  await sessionStart('codex', sid, repo)
  appendSpool('codex', sid, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt }])
  await finalize('codex', sid, { pending: false })
}

function brainBytes(): string {
  const read = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '')
  return `${read(projectRef('demo').db)}\n${read(personRef().db)}`
}

const candidate = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'procedure', scope: 'project', title: 'Run the migration before the deploy', description: 'two steps', body: '1. migrate\n2. deploy', confidence: 0.9, sources: [], ...over,
})

describe('checkReply: the whole answer is read before anything is written', () => {
  test('accepts a well-formed answer, with or without candidates, inside prose or a fence', () => {
    expect(checkReply(JSON.stringify({ summary: 'did things', candidates: [] }))).toEqual({ ok: true, reply: { summary: 'did things', candidates: [] } })
    expect(checkReply('Here you go:\n```json\n' + JSON.stringify({ candidates: [candidate()] }) + '\n```')).toMatchObject({ ok: true, reply: { summary: '', candidates: [{ type: 'procedure', scope: 'project', confidence: 0.9 }] } })
    expect(checkReply(JSON.stringify({ candidates: [candidate({ scope: undefined, description: undefined, body: undefined, sources: undefined })] }))).toMatchObject({ ok: true, reply: { candidates: [{ scope: 'project', description: '', body: '', sources: [] }] } })
    expect(checkReply(JSON.stringify({ candidates: [candidate({ type: 'preference', scope: undefined })] }))).toMatchObject({ ok: true, reply: { candidates: [{ scope: 'person' }] } })
  })

  test('one bad part rejects the whole answer, and the reason names it', () => {
    const bad = (reply: unknown): string => {
      const r = checkReply(typeof reply === 'string' ? reply : JSON.stringify(reply))
      expect(r.ok).toBe(false)
      return r.ok ? '' : r.why
    }
    expect(bad('no json here')).toContain('no JSON object')
    expect(bad('{ "candidates": [')).toContain('no JSON object')
    expect(bad('{ nope }')).toContain('not valid JSON')
    expect(bad('{"summary": 4}')).toContain('summary')
    expect(bad({ summary: 'x'.repeat(1300) })).toContain('summary')
    expect(bad({ candidates: 'many' })).toContain('candidates must be a list')
    expect(bad({ candidates: [candidate(), candidate(), candidate(), candidate()] })).toContain('more than 3 candidates')
    expect(bad({ candidates: [candidate(), candidate({ type: 'session' })] })).toContain('candidate 2: type must be one of')
    expect(bad({ candidates: [candidate({ type: 'capture' })] })).toContain('type must be one of')
    expect(bad({ candidates: [candidate({ scope: 'world' })] })).toContain('scope must be project or person')
    expect(bad({ candidates: [candidate({ title: '   ' })] })).toContain('title is required')
    expect(bad({ candidates: [candidate({ title: 'x'.repeat(201) })] })).toContain('title is longer than 200')
    expect(bad({ candidates: [candidate({ description: 'x'.repeat(301) })] })).toContain('description')
    expect(bad({ candidates: [candidate({ body: 'x'.repeat(4001) })] })).toContain('body')
    expect(bad({ candidates: [candidate({ confidence: 'high' })] })).toContain('confidence must be a number between 0 and 1')
    expect(bad({ candidates: [candidate({ confidence: 1.5 })] })).toContain('confidence')
    expect(bad({ candidates: [candidate({ confidence: -0.1 })] })).toContain('confidence')
    expect(bad({ candidates: [candidate({ confidence: undefined })] })).toContain('confidence')
    expect(bad({ candidates: [candidate({ sources: 'src/a.ts' })] })).toContain('sources')
    expect(bad({ candidates: [candidate({ sources: ['a', 'b', 'c', 'd'] })] })).toContain('sources')
    expect(bad({ candidates: [candidate({ sources: [1] })] })).toContain('sources')
  })
})

describe('distill', () => {
  test('a promoted candidate cites the session files its claim is about, never a path the session did not touch', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      appendSpool('codex', SID, [
        { ts: Date.now(), ev: 'prompt' },
        { ts: Date.now() + 1, ev: 'tool', tool: 'Edit', kind: 'edit', paths: ['src/orders.ts', 'src/cache.ts'] },
        { ts: Date.now() + 2, ev: 'stop', excerpt: 'Raised the TTL in orders.ts.' },
      ])
      await finalize('codex', SID, { pending: false })
      const r = await distillSession('codex', SID, { runner: runner({ summary: 's', candidates: [
        { type: 'gotcha', title: 'The orders TTL is read at start', description: 'restart after a change', body: 'Edit `ORDER_CACHE_TTL_SECONDS` and restart.', confidence: 0.9, sources: ['src/orders.ts', 'src/nope.ts'] },
        { type: 'knowledge', title: 'The cache module imports the TTL', description: 'one import', body: 'See cache.ts.', confidence: 0.9 },
      ] }) })
      expect(r.candidates).toHaveLength(2)
      const all = await listAll(projectRef('demo'))
      expect(all.find(i => i.kind === 'gotcha')?.sources).toEqual([`session:session-codex-035a53`, 'src/orders.ts'])
      expect(all.find(i => i.kind === 'knowledge')?.sources).toEqual([`session:session-codex-035a53`, 'src/cache.ts'])
    })
  })

  test('summary, ADD (promoted and captured), UPDATE and NOOP; every written memory is inferred with the model\'s confidence', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'gotcha', title: 'The flaky test needs the server to be up', summary: 'await the start', body: 'Await it.' })
      await write(agentCtx(repo), { type: 'decision', title: 'Orders live in CockroachDB', summary: 'moved from PostgreSQL', body: '' })
      await finishedSession(repo)
      const r = await distillSession('codex', SID, {
        runner: runner({
          summary: 'Moved orders to CockroachDB; fixed the flaky test.',
          candidates: [
            { type: 'decision', title: 'Orders live in CockroachDB', description: 'same claim', body: '', confidence: 0.9 },
            { type: 'gotcha', title: 'The flaky test needs a running server', description: 'await the start of the server', body: '', confidence: 0.7 },
            { type: 'preference', title: 'Short answers please', description: '', body: '', confidence: 0.3 },
          ],
        }),
      })
      expect(r.ran).toBe(true)
      expect(r.summary).toBe('Moved orders to CockroachDB; fixed the flaky test.')
      expect(r.decisions.map(d => d.op)).toEqual(['noop', 'update', 'add'])
      expect(r.decisions[2]).toMatchObject({ promoted: false, confidence: 0.3 })
      const project = await listAll(projectRef('demo'))
      const session = project.find(i => i.kind === 'session')
      expect(session?.summary).toBe('Moved orders to CockroachDB; fixed the flaky test.')
      expect(session?.tags).toContain('distilled')
      expect(project.find(i => i.kind === 'gotcha')?.body).toContain('Evidence:')
      const capture = (await listAll(personRef())).find(i => i.kind === 'capture')
      expect(capture).toMatchObject({ title: 'Short answers please', origin: 'inferred', confidence: 0.3 })
    })
  })

  test('a confident new claim is written as a memory of its kind, pending review, inferred, with the model\'s confidence', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      const r = await distillSession('codex', SID, { runner: runner({ summary: 's', candidates: [candidate({ confidence: 0.8 })] }) })
      expect(r.decisions).toMatchObject([{ op: 'add', promoted: true }])
      expect((await listAll(projectRef('demo'))).find(i => i.kind === 'procedure')).toMatchObject({
        review: 'pending', title: 'Run the migration before the deploy', sources: [`session:session-codex-035a53`], origin: 'inferred', confidence: 0.8,
      })
    })
  })

  test('a candidate near the promotion line: 0.6 is filed as its kind, 0.59 waits as a capture', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      const r = await distillSession('codex', SID, { runner: runner({ summary: 's', candidates: [
        candidate({ title: 'Warm the cache before the load test', confidence: 0.6 }),
        candidate({ title: 'Rotate the signing key every quarter', confidence: 0.59 }),
      ] }) })
      expect(r.decisions.map(d => d.promoted)).toEqual([true, false])
      const all = await listAll(projectRef('demo'))
      expect(all.find(i => i.title === 'Warm the cache before the load test')?.kind).toBe('procedure')
      expect(all.find(i => i.title === 'Rotate the signing key every quarter')?.kind).toBe('capture')
    })
  })

  test('a preference that holds only in this codebase stays in the project brain; one about how the user works everywhere goes to the person brain', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      const r = await distillSession('codex', SID, { runner: runner({ summary: 's', candidates: [
        { type: 'preference', scope: 'project', title: 'The orders service keeps its retries in one place', description: 'no retries in the handlers', body: '', confidence: 0.9 },
        { type: 'preference', scope: 'person', title: 'Answer in short paragraphs', description: 'no long lists', body: '', confidence: 0.9 },
        { type: 'preference', title: 'Name branches after the ticket', description: 'scope left out', body: '', confidence: 0.9 },
      ] }) })
      expect(r.decisions.map(d => d.op)).toEqual(['add', 'add', 'add'])
      const project = (await listAll(projectRef('demo'))).filter(i => i.kind !== 'session')
      const person = await listAll(personRef())
      expect(project.map(i => [i.kind, i.title])).toEqual([['preference', 'The orders service keeps its retries in one place']])
      expect(person.map(i => [i.kind, i.title, i.origin]).sort()).toEqual([['preference', 'Answer in short paragraphs', 'inferred'], ['preference', 'Name branches after the ticket', 'inferred']])
      await finishedSession(repo, OTHER)
      await distillSession('codex', OTHER, { runner: runner({ summary: 's', candidates: [
        { type: 'preference', scope: 'project', title: 'Orders tests run against a real broker', description: 'a guess', body: '', confidence: 0.2 },
      ] }) })
      expect((await listAll(projectRef('demo'))).find(i => i.kind === 'capture')?.title).toBe('Orders tests run against a real broker')
      expect((await listAll(personRef())).filter(i => i.kind === 'capture')).toEqual([])
    })
  })

  test('a candidate that resembles an explicit, pinned or verified memory never changes it: it is stored beside it, marked as contradicting', async () => {
    await withBrain(async ({ repo }) => {
      const explicit = await write(humanCtx(repo), { type: 'decision', title: 'Orders live in PostgreSQL', summary: 'storage choice', body: 'Chosen for transactions.' })
      const pinned = await write(agentCtx(repo), { type: 'gotcha', title: 'The flaky test needs the server to be up', summary: 'await the start', body: 'Await it.', pin: true })
      const verified = await write(agentCtx(repo), { type: 'procedure', title: 'Release with the three checks', summary: 'tsc, build, tests', body: '', review: 'ok' })
      await finishedSession(repo)
      const before = new Map((await listAll(projectRef('demo'))).map(i => [i.id, JSON.stringify([i.version, i.body, i.summary, i.title, i.status])]))
      const r = await distillSession('codex', SID, { runner: runner({ summary: 's', candidates: [
        candidate({ type: 'decision', title: 'Orders live in PostgreSQL 16 with replicas', description: 'storage choice with replicas', body: 'Actually the replicas matter.', confidence: 0.8 }),
        candidate({ type: 'gotcha', title: 'The flaky test needs a running server up', description: 'await the start of the server', body: 'Wait for it.', confidence: 0.8 }),
        candidate({ type: 'procedure', title: 'Release with the three checks run in order', description: 'tsc, build check, tests', body: 'In order.', confidence: 0.8 }),
      ] }) })
      expect(r.decisions.map(d => d.op)).toEqual(['add', 'add', 'add'])
      expect(r.decisions.map(d => d.conflicts?.[0]?.why)).toEqual(['explicit', 'pinned', 'verified'])
      const after = await listAll(projectRef('demo'))
      for (const id of [explicit.id, pinned.id, verified.id]) {
        const i = after.find(x => x.id === id)
        expect(JSON.stringify([i?.version, i?.body, i?.summary, i?.title, i?.status])).toBe(before.get(id) as string)
        expect(i?.body ?? '').not.toContain('Evidence:')
      }
      const mine = after.filter(i => r.candidates.includes(i.id))
      expect(mine).toHaveLength(3)
      for (const m of mine) expect(m).toMatchObject({ origin: 'inferred', review: 'pending', status: 'active' })
      for (const m of mine) expect(m.contradictedNote).toContain('left as it is')
      expect(mine.every(m => m.contradictedAt !== undefined)).toBe(true)
    })
  })

  test('an unverified, inferred twin still takes the new evidence', async () => {
    await withBrain(async ({ repo }) => {
      const loose = await write(agentCtx(repo), { type: 'gotcha', title: 'The flaky test needs the server to be up', summary: 'await the start', body: 'Await it.' })
      await finishedSession(repo)
      const r = await distillSession('codex', SID, { runner: runner({ summary: 's', candidates: [candidate({ type: 'gotcha', title: 'The flaky test needs a running server', description: 'await the start of the server', confidence: 0.8 })] }) })
      expect(r.decisions).toMatchObject([{ op: 'update', target: loose.id }])
      expect((await getStored(projectRef('demo'), loose.id))?.item.body).toContain('Evidence:')
    })
  })

  test('an invalid, failed or held answer writes nothing: the brain files stay byte for byte as they were', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'decision', title: 'Orders live in PostgreSQL', summary: 'storage choice', body: '' })
      await finishedSession(repo)
      const frozen = brainBytes()
      const answers: Array<[string, DistillRunner, string]> = [
        ['text with no JSON', async () => ({ ok: true, text: 'Sorry, I cannot do that.' }), 'invalid-reply'],
        ['broken JSON', async () => ({ ok: true, text: '{ "summary": "x", "candidates": [' }), 'invalid-reply'],
        ['one valid and one bad candidate', runner({ summary: 'half', candidates: [candidate(), candidate({ type: 'prophecy' })] }), 'invalid-reply'],
        ['a candidate without a confidence', runner({ summary: 's', candidates: [candidate({ confidence: undefined })] }), 'invalid-reply'],
        ['more candidates than allowed', runner({ summary: 's', candidates: [candidate(), candidate(), candidate(), candidate()] }), 'invalid-reply'],
        ['a failing CLI', async () => ({ ok: false, text: '', error: 'codex: not logged in' }), 'runner-failed'],
        ['a missing CLI', async () => ({ ok: false, text: '', error: 'codex: codex is not on PATH', unavailable: true }), 'runner-unavailable'],
      ]
      for (const [what, run, skipped] of answers) {
        const r = await distillSession('codex', SID, { runner: run })
        expect([what, r.ran, r.skipped]).toEqual([what, false, skipped])
        expect([what, brainBytes() === frozen]).toEqual([what, true])
      }
      const session = (await listAll(projectRef('demo'))).find(i => i.kind === 'session')
      expect(session?.tags).not.toContain('distilled')
    })
  })

  test('a rate-limited harness writes nothing and does not call the model', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      writeTelemetry('codex', SID, { at: Date.now(), windows: [{ label: '5h', pct: 90 }] })
      const frozen = brainBytes()
      let calls = 0
      const counting: DistillRunner = async () => { calls++; return { ok: true, text: JSON.stringify({ summary: 's', candidates: [candidate()] }) } }
      expect(await distillSession('codex', SID, { runner: counting })).toMatchObject({ ran: false, skipped: 'rate-limit', detail: expect.stringContaining('5-hour window at 90% (limit 75%)') })
      expect(calls).toBe(0)
      expect(brainBytes()).toBe(frozen)
    })
  })

  test('the session\'s own harness and model: another harness\'s rate limit never holds it, its own does', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      writeTelemetry('codex', SID, { at: Date.now(), model: 'gpt-6-luna', modelId: 'gpt-6-luna' })
      writeTelemetry('claude', OTHER, { at: Date.now() + 1, windows: [{ label: '7d', pct: 99 }] })
      const models: Array<string | undefined> = []
      const seen: DistillRunner = async (_p, o) => { models.push(o.model); return { ok: true, text: JSON.stringify({ summary: 's' }) } }
      const r = await distillSession('codex', SID, { runner: seen })
      expect(r).toMatchObject({ ran: true, model: 'gpt-6-luna' })
      expect(models).toEqual(['gpt-6-luna'])
      writeTelemetry('codex', SID, { at: Date.now() + 2, windows: [{ label: '5h', pct: 90 }] })
      expect(await distillSession('codex', SID, { runner: seen })).toMatchObject({ skipped: 'rate-limit', detail: expect.stringContaining('5-hour window at 90% (limit 75%)') })
      expect(models).toHaveLength(1)
    })
  })

  test('a harness that refuses the runner for good is named in the detail', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      const refusing: DistillRunner = async () => ({ ok: false, text: '', error: "codex: Error: OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building." })
      const r = await distillSession('codex', SID, { runner: refusing })
      expect(r.skipped).toBe('runner-failed')
      expect(r.detail).toContain('the harness refuses the memory runner for good')
      expect(runnerRefusesForGood('codex: unknown model gpt-9')).toBe(true)
      expect(runnerRefusesForGood('claude: model claude-x is not available')).toBe(true)
      expect(runnerRefusesForGood('codex: not logged in')).toBe(false)
      expect(runnerRefusesForGood('claude: no answer within 300 s')).toBe(false)
    })
  })

  test('without a session memory there is nothing to distill, and the default runner never runs in tests', async () => {
    await withBrain(async ({ repo }) => {
      expect((await distillSession('codex', 'no-such-session', { runner: runner({ summary: 'x' }) })).skipped).toBe('no-session-memory')
      expect((await distillSession('codex', SID, {})).skipped).toBe('no-session-memory')
      await finishedSession(repo)
      expect((await distillSession('codex', SID, {})).skipped).toBe('disabled')
    })
  })

  test('the same material is not sent twice unless it is forced', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      let calls = 0
      const counting: DistillRunner = async () => { calls++; return { ok: true, text: JSON.stringify({ summary: 'Moved orders.' }) } }
      const first = await distillSession('codex', SID, { runner: counting })
      expect(first.ran).toBe(true)
      expect(first.sha).toMatch(/^[0-9a-f]{16}$/)
      const rec = readSessionRecord('codex', SID)
      if (rec === undefined) throw new Error('no record')
      writeSessionRecord({ ...rec, capture: { state: 'done', tries: 0, sha: first.sha as string } })
      expect(await distillSession('codex', SID, { runner: counting })).toMatchObject({ ran: false, skipped: 'already-distilled' })
      expect(calls).toBe(1)
      expect((await distillSession('codex', SID, { runner: counting, force: true })).ran).toBe(true)
      expect(calls).toBe(2)
    })
  })

  test('a harness CLI that is not on PATH holds the session without a failure', async () => {
    await withBrain(async ({ repo, root }) => {
      await finishedSession(repo)
      const empty = join(root, 'empty-bin')
      mkdirSync(empty, { recursive: true })
      await withEnv({ PATH: empty }, async () => {
        const r = await distillSession('codex', SID, { env: {} })
        expect(r).toMatchObject({ ran: false, skipped: 'runner-unavailable' })
        expect(r.detail).toContain('codex is not on PATH')
        expect(runnerUnavailable('codex', Date.now() + 3600_000, { which: () => '/usr/bin/codex' })).toContain('not on PATH')
        expect(runnerUnavailable('codex', Date.now() + 7 * 3600_000, { which: () => '/usr/bin/codex' })).toBeUndefined()
      })
    })
  })

  test('one model call at a time on the machine: two sessions that end together queue for the runner', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      await finishedSession(repo, OTHER, 'Renamed the billing queue and moved its worker.')
      let active = 0
      let most = 0
      const slow: DistillRunner = async () => {
        active++
        most = Math.max(most, active)
        await Bun.sleep(120)
        active--
        return { ok: true, text: JSON.stringify({ summary: 's' }) }
      }
      const both = await Promise.all([distillSession('codex', SID, { runner: slow }), distillSession('codex', OTHER, { runner: slow })])
      expect(both.map(r => r.ran)).toEqual([true, true])
      expect(most).toBe(1)
    })
  })

  test('usage windows that have reset, or reports older than their window, hold nothing', async () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z')
    const hour = 3600_000
    expect(currentWindows([{ label: '5h', pct: 90, resetsAt: '2026-10-14T11:00:00.000Z' }, { label: '7d', pct: 95, resetsAt: '2026-10-20T00:00:00.000Z' }], now - hour, now).map(w => w.label)).toEqual(['7d'])
    expect(currentWindows([{ label: '5h', pct: 90 }], now - 6 * hour, now)).toEqual([])
    expect(currentWindows([{ label: '5h', pct: 90 }], now - 2 * hour, now).map(w => w.label)).toEqual(['5h'])
    expect(latestWindows('codex', now)).toEqual([])
  })
})


import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { write } from '../../src/memory/api'
import { currentWindows, distillPending, distillSession, enqueueDistill, latestWindows, type DistillRunner } from '../../src/memory/distill'
import { readJobs } from '../../src/memory/jobs'
import { runnerRefusesForGood, runnerUnavailable } from '../../src/memory/runner'
import { withEnv } from '../helpers/sandbox'
import { finalize } from '../../src/memory/finalize'
import { distillLockFile, distillQueueDir, distillRunsFile, locksDir } from '../../src/memory/layout'
import { sessionStart } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { listAll, personRef, projectRef } from '../../src/memory/store'
import { writeTelemetry } from '../../src/workflow/session-store'
import { agentCtx, withBrain } from './helpers'

const SID = '0199a213-81c0-7800-8aa1-bbab2a035a53'
const OTHER = '0199a213-81c0-7800-8aa1-bbab2a035a54'
const OLDER = '0199a213-81c0-7800-8aa1-bbab2a035a55'

function queued(): string[] {
  try { return readdirSync(distillQueueDir()) } catch { return [] }
}

const runner = (out: unknown): DistillRunner => async () => ({ ok: true, text: JSON.stringify(out) })

async function finishedSession(repo: string, sid = SID, excerpt = 'Moved the orders service to CockroachDB and fixed the flaky test.'): Promise<void> {
  await sessionStart('codex', sid, repo)
  appendSpool('codex', sid, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt }])
  await finalize('codex', sid)
}

const PROCEDURE = { summary: 's', candidates: [{ type: 'procedure', title: 'Run the migration before the deploy', description: 'two steps', body: '1. migrate\n2. deploy', confidence: 'high' }] }

describe('distill', () => {
  test('a promoted candidate cites the session files its claim is about, never a path the session did not touch', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      appendSpool('codex', SID, [
        { ts: Date.now(), ev: 'prompt' },
        { ts: Date.now() + 1, ev: 'tool', tool: 'Edit', kind: 'edit', paths: ['src/orders.ts', 'src/cache.ts'] },
        { ts: Date.now() + 2, ev: 'stop', excerpt: 'Raised the TTL in orders.ts.' },
      ])
      await finalize('codex', SID)
      const r = await distillSession('codex', SID, { runner: runner({ summary: 's', candidates: [
        { type: 'gotcha', title: 'The orders TTL is read at start', description: 'restart after a change', body: 'Edit `ORDER_CACHE_TTL_SECONDS` and restart.', confidence: 'high', sources: ['src/orders.ts', 'src/nope.ts'] },
        { type: 'knowledge', title: 'The cache module imports the TTL', description: 'one import', body: 'See cache.ts.', confidence: 'high' },
      ] }) })
      expect(r.candidates).toHaveLength(2)
      const all = await listAll(projectRef('demo'))
      expect(all.find(i => i.kind === 'gotcha')?.sources).toEqual([`session:session-codex-035a53`, 'src/orders.ts'])
      expect(all.find(i => i.kind === 'knowledge')?.sources).toEqual([`session:session-codex-035a53`, 'src/cache.ts'])
    })
  })

  test('summary, ADD (promoted and captured), UPDATE and NOOP', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'gotcha', title: 'The flaky test needs the server to be up', summary: 'await the start', body: 'Await it.', review: 'ok' })
      await write(agentCtx(repo), { type: 'decision', title: 'Orders live in CockroachDB', summary: 'moved from PostgreSQL', body: '' })
      await finishedSession(repo)
      const r = await distillSession('codex', SID, {
        runner: runner({
          summary: 'Moved orders to CockroachDB; fixed the flaky test.',
          candidates: [
            { type: 'decision', title: 'Orders live in CockroachDB', description: 'same claim', body: '', confidence: 'high' },
            { type: 'gotcha', title: 'The flaky test needs a running server', description: 'await the start of the server', body: '', confidence: 'medium' },
            { type: 'preference', title: 'Short answers please', description: '', body: '', confidence: 'low' },
          ],
        }),
      })
      expect(r.ran).toBe(true)
      expect(r.summary).toBe('Moved orders to CockroachDB; fixed the flaky test.')
      expect(r.decisions.map(d => d.op)).toEqual(['noop', 'update', 'add'])
      expect(r.decisions[2]?.promoted).toBe(false)
      const project = await listAll(projectRef('demo'))
      const session = project.find(i => i.kind === 'session')
      expect(session?.summary).toBe('Moved orders to CockroachDB; fixed the flaky test.')
      expect(session?.tags).toContain('distilled')
      const gotcha = project.find(i => i.kind === 'gotcha')
      expect(gotcha?.body).toContain('Evidence:')
      expect(gotcha?.review).toBe('ok')
      expect((await listAll(personRef())).map(i => i.kind)).toEqual(['capture'])
      await finalize('codex', SID)
      expect((await listAll(projectRef('demo'))).find(i => i.kind === 'session')?.summary).toBe('Moved orders to CockroachDB; fixed the flaky test.')
    })
  })

  test('a confident new claim is written as a memory of its kind, pending review', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      const r = await distillSession('codex', SID, { runner: runner({ summary: 's', candidates: [{ type: 'procedure', title: 'Run the migration before the deploy', description: 'two steps', body: '1. migrate\n2. deploy', confidence: 'high' }] }) })
      expect(r.decisions).toMatchObject([{ op: 'add', promoted: true }])
      expect((await listAll(projectRef('demo'))).find(i => i.kind === 'procedure')).toMatchObject({ review: 'pending', title: 'Run the migration before the deploy', sources: [`session:session-codex-035a53`] })
    })
  })

  test('a preference that holds only in this codebase stays in the project brain; one about how the user works everywhere goes to the person brain', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      const r = await distillSession('codex', SID, { runner: runner({ summary: 's', candidates: [
        { type: 'preference', scope: 'project', title: 'The orders service keeps its retries in one place', description: 'no retries in the handlers', body: '', confidence: 'high' },
        { type: 'preference', scope: 'person', title: 'Answer in short paragraphs', description: 'no long lists', body: '', confidence: 'high' },
        { type: 'preference', title: 'Name branches after the ticket', description: 'scope left out', body: '', confidence: 'high' },
      ] }) })
      expect(r.decisions.map(d => d.op)).toEqual(['add', 'add', 'add'])
      const project = (await listAll(projectRef('demo'))).filter(i => i.kind !== 'session')
      const person = await listAll(personRef())
      expect(project.map(i => [i.kind, i.title])).toEqual([['preference', 'The orders service keeps its retries in one place']])
      expect(person.map(i => [i.kind, i.title]).sort()).toEqual([['preference', 'Answer in short paragraphs'], ['preference', 'Name branches after the ticket']])
      await finishedSession(repo, OTHER)
      await distillSession('codex', OTHER, { runner: runner({ summary: 's', candidates: [
        { type: 'preference', scope: 'project', title: 'Orders tests run against a real broker', description: 'a guess', body: '', confidence: 'low' },
      ] }) })
      expect((await listAll(projectRef('demo'))).find(i => i.kind === 'capture')?.title).toBe('Orders tests run against a real broker')
      expect((await listAll(personRef())).filter(i => i.kind === 'capture')).toEqual([])
    })
  })

  test('the model reads the user\'s prompts and infers how they work: a hypothesis in the person brain at first, a profile line once three sessions show it', async () => {
    await withBrain(async ({ repo }) => {
      const sent: string[] = []
      const inferring: DistillRunner = async (p) => {
        sent.push(p)
        const same = /- (infer:\S+): Reviews the plan/.exec(p)?.[1]
        return { ok: true, text: JSON.stringify({ summary: 's', inferences: [{ text: 'Reviews the plan before any code is written', category: 'workflow', why: 'asked to see the plan first', ...(same !== undefined ? { same } : {}) }] }) }
      }
      for (const [i, sid] of [SID, OTHER, OLDER].entries()) {
        await sessionStart('codex', sid, repo)
        appendSpool('codex', sid, [
          { ts: Date.now() + i * 10, ev: 'prompt', excerpt: 'Show me the plan first, no code yet.' },
          { ts: Date.now() + i * 10 + 1, ev: 'prompt', excerpt: 'ok, go ahead' },
          { ts: Date.now() + i * 10 + 2, ev: 'stop', excerpt: `Wrote the plan, then the code (${i}).` },
        ])
        await finalize('codex', sid)
        const r = await distillSession('codex', sid, { runner: inferring })
        expect(r.inferences).toHaveLength(1)
        const person = (await listAll(personRef())).filter(m => m.kind === 'profile' && m.tags.includes('inferred'))
        expect(person).toHaveLength(1)
        expect(person[0]).toMatchObject({ title: 'Reviews the plan before any code is written', layer: 'person' })
        expect(person[0]?.body).toContain('Latest sign: asked to see the plan first')
        expect(person[0]?.tags.includes('hypothesis')).toBe(i < 2)
        expect(person[0]?.summary).toBe(i < 2 ? 'workflow · hypothesis · inferred from sessions' : 'workflow · medium · inferred from sessions')
      }
      expect(sent[0]).toContain("The user's prompts in this session, oldest first:\n- Show me the plan first, no code yet.\n- ok, go ahead")
      expect(sent[0]).toContain('<known>\n(nothing yet)\n</known>')
      expect(sent[1]).toMatch(/<known>\n- infer:\S+: Reviews the plan before any code is written/)
      expect((await listAll(projectRef('demo'))).filter(m => m.kind === 'convention')).toEqual([])
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

  test('a harness that keeps failing on a session drops it from the queue after three runs', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      enqueueDistill('codex', SID)
      const failing: DistillRunner = async () => ({ ok: false, text: '', error: 'codex: not logged in' })
      for (let i = 1; i <= 2; i++) {
        expect(await distillSession('codex', SID, { runner: failing })).toMatchObject({ skipped: 'runner-failed', detail: 'codex: not logged in' })
        expect(queued()).toEqual([`codex-${SID}`])
      }
      expect((await distillSession('codex', SID, { runner: failing })).detail).toBe('codex: not logged in; dropped from the queue after 3 failed runs')
      expect(queued()).toEqual([])
    })
  })

  test('a harness that refuses the runner for good (a free tier, an unknown model) drops the session at once', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      enqueueDistill('codex', SID)
      const refusing: DistillRunner = async () => ({ ok: false, text: '', error: "codex: Error: OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building." })
      const r = await distillSession('codex', SID, { runner: refusing })
      expect(r.skipped).toBe('runner-failed')
      expect(r.detail).toContain('dropped from the queue: the harness refuses the memory runner for good')
      expect(queued()).toEqual([])
      enqueueDistill('codex', SID)
      writeTelemetry('claude', '0199a213-81c0-7800-8aa1-bbab2a035b77', { at: Date.now(), modelId: 'claude-opus-5-5', windows: [{ label: '7d', pct: 99, resetsAt: new Date(Date.now() + 3600_000).toISOString() }] })
      const held = await distillSession('codex', SID, { runner: refusing })
      expect(held.skipped).toBe('runner-failed')
      expect(held.detail ?? '').not.toContain('dropped from the queue')
      expect(queued()).toEqual([`codex-${SID}`])
      expect(runnerRefusesForGood('codex: unknown model gpt-9')).toBe(true)
      expect(runnerRefusesForGood('claude: model claude-x is not available')).toBe(true)
      expect(runnerRefusesForGood('codex: not logged in')).toBe(false)
      expect(runnerRefusesForGood('claude: no answer within 300 s')).toBe(false)
    })
  })

  test('failed runs count toward no daily cap, and a drain spends its budget only on answered runs', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      await finishedSession(repo, OTHER)
      const failing: DistillRunner = async () => ({ ok: false, text: '', error: 'codex: not logged in' })
      for (let i = 0; i < 2; i++) expect((await distillSession('codex', SID, { runner: failing })).skipped).toBe('runner-failed')
      expect(readFileSync(distillRunsFile(), 'utf8').trim().split('\n')).toHaveLength(2)
      enqueueDistill('codex', SID)
      enqueueDistill('codex', OTHER)
      let calls = 0
      const second: DistillRunner = async () => { calls++; return calls === 1 ? { ok: false, text: '', error: 'codex: not logged in' } : { ok: true, text: JSON.stringify({ summary: 'again' }) } }
      const drained = await distillPending({ runner: second, maxRuns: 1, harness: 'codex', first: OTHER })
      expect(drained.map(d => d.ran || d.skipped)).toEqual(['runner-failed', true])
      expect(calls).toBe(2)
    })
  })

  test('the pending queue: one harness at a time, the session that just ended first, at most maxRuns model calls', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      enqueueDistill('claude', OTHER)
      enqueueDistill('codex', OLDER)
      enqueueDistill('codex', SID)
      const calls: string[] = []
      const seen: DistillRunner = async p => { calls.push(p); return { ok: true, text: JSON.stringify({ summary: 's' }) } }
      const r = await distillPending({ harness: 'codex', first: SID, maxRuns: 1, runner: seen })
      expect(r.map(x => [x.harness, x.sid, x.ran])).toEqual([['codex', SID, true]])
      expect(calls).toHaveLength(1)
      expect(queued().sort()).toEqual([`claude-${OTHER}`, `codex-${OLDER}`].sort())
      expect((await distillPending({ harness: 'codex', runner: seen })).map(x => x.skipped)).toEqual(['no-session-memory'])
      expect(queued()).toEqual([`claude-${OTHER}`])
    })
  })

  test('a rate-limit stop holds the live entries, and entries without a session memory still leave the queue', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      enqueueDistill('codex', SID)
      enqueueDistill('codex', OLDER)
      writeTelemetry('codex', SID, { at: Date.now(), windows: [{ label: '7d', pct: 95 }] })
      const calls: string[] = []
      const seen: DistillRunner = async p => { calls.push(p); return { ok: true, text: JSON.stringify({ summary: 's' }) } }
      const r = await distillPending({ harness: 'codex', first: SID, runner: seen })
      expect(r.map(x => [x.sid, x.skipped])).toEqual([[SID, 'rate-limit'], [OLDER, 'no-session-memory']])
      expect(calls).toHaveLength(0)
      expect(queued()).toEqual([`codex-${SID}`])
    })
  })

  test('two finalizers of one harness that drain the queue together send a session to the model once', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      enqueueDistill('codex', SID)
      let open = (): void => {}
      const gate = new Promise<void>(resolve => { open = resolve })
      const calls: string[] = []
      const slow: DistillRunner = async p => {
        calls.push(p)
        if (calls.length >= 2) open()
        await gate
        return { ok: true, text: JSON.stringify(PROCEDURE) }
      }
      const runs = [distillPending({ harness: 'codex', first: SID, runner: slow }), distillPending({ harness: 'codex', first: SID, runner: slow })]
      void Promise.race(runs).then(() => open())
      const results = (await Promise.all(runs)).flat()
      expect(calls).toHaveLength(1)
      expect(results.map(r => r.ran ? 'ran' : r.skipped).sort()).toEqual(['busy', 'ran'])
      expect((await listAll(projectRef('demo'))).filter(i => i.kind === 'procedure')).toHaveLength(1)
      expect(queued()).toEqual([])
    })
  })

  test('a run never distills a session that another run finished after its queue was listed', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      await finishedSession(repo, OTHER, 'Renamed the billing queue and moved its worker.')
      enqueueDistill('codex', SID)
      enqueueDistill('codex', OTHER)
      let open = (): void => {}
      const gate = new Promise<void>(resolve => { open = resolve })
      const calls = { orders: 0, billing: 0 }
      const runner: DistillRunner = async p => {
        if (p.includes('billing')) {
          calls.billing++
          if (calls.billing >= 2) open()
          await gate
        } else calls.orders++
        return { ok: true, text: JSON.stringify({ summary: 's' }) }
      }
      const runs = [distillPending({ harness: 'codex', first: SID, runner }), distillPending({ harness: 'codex', first: OTHER, runner })]
      void Promise.race(runs).then(() => open())
      const results = (await Promise.all(runs)).flat().map(r => `${r.sid === SID ? 'orders' : 'billing'}:${r.ran ? 'ran' : r.skipped}`)
      expect(calls).toEqual({ orders: 1, billing: 1 })
      expect(results.sort()).toEqual(['billing:busy', 'billing:ran', 'orders:not-queued', 'orders:ran'])
      expect(queued()).toEqual([])
    })
  })

  test('a claim left by a run that died does not hold the session', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      enqueueDistill('codex', SID)
      const dead = Bun.spawnSync(['true'], { env: { ...process.env } }).pid
      mkdirSync(locksDir(), { recursive: true })
      writeFileSync(distillLockFile('codex', SID), JSON.stringify({ pid: dead, at: new Date().toISOString(), token: 'crashed-run' }))
      const r = await distillPending({ harness: 'codex', runner: runner({ summary: 's' }) })
      expect(r.map(x => [x.sid, x.ran])).toEqual([[SID, true]])
      expect(queued()).toEqual([])
    })
  })

  test('the same material is never sent twice, and each run or skip lands in the jobs journal', async () => {
    await withBrain(async ({ repo }) => {
      await finishedSession(repo)
      let calls = 0
      const counting: DistillRunner = async () => { calls++; return { ok: true, text: JSON.stringify({ summary: 'Moved orders.' }) } }
      expect((await distillSession('codex', SID, { runner: counting })).ran).toBe(true)
      const again = await distillSession('codex', SID, { runner: counting })
      expect(again).toMatchObject({ ran: false, skipped: 'already-distilled' })
      expect(calls).toBe(1)
      const jobs = readJobs().filter(e => e.job === 'distill')
      expect(jobs.map(e => [e.outcome, e.reason ?? null])).toEqual([['ran', null], ['skipped', 'already-distilled']])
      expect(jobs[0]).toMatchObject({ harness: 'codex', sid: SID, trigger: 'cli' })
    })
  })

  test('a harness CLI that is not on PATH holds the session without spending a run or a failure', async () => {
    await withBrain(async ({ repo, root }) => {
      await finishedSession(repo)
      enqueueDistill('codex', SID)
      const empty = join(root, 'empty-bin')
      mkdirSync(empty, { recursive: true })
      await withEnv({ PATH: empty }, async () => {
        const r = await distillSession('codex', SID, { env: {} })
        expect(r).toMatchObject({ ran: false, skipped: 'runner-unavailable' })
        expect(r.detail).toContain('codex is not on PATH')
        expect(runnerUnavailable('codex', Date.now() + 3600_000, { which: () => '/usr/bin/codex' })).toContain('not on PATH')
        expect(runnerUnavailable('codex', Date.now() + 7 * 3600_000, { which: () => '/usr/bin/codex' })).toBeUndefined()
      })
      expect(queued()).toEqual([`codex-${SID}`])
      expect(existsSync(distillRunsFile()) ? readFileSync(distillRunsFile(), 'utf8') : '').toBe('')
    })
  })

  test('usage windows that have reset, or reports older than their window, hold nothing', async () => {
    const now = Date.parse('2026-10-14T12:00:00.000Z')
    const hour = 3600_000
    expect(currentWindows([{ label: '5h', pct: 90, resetsAt: '2026-10-14T11:00:00.000Z' }, { label: '7d', pct: 95, resetsAt: '2026-10-20T00:00:00.000Z' }], now - hour, now).map(w => w.label)).toEqual(['7d'])
    expect(currentWindows([{ label: '5h', pct: 90 }], now - 6 * hour, now)).toEqual([])
    expect(currentWindows([{ label: '5h', pct: 90 }], now - 4 * hour, now).map(w => w.pct)).toEqual([90])
    expect(currentWindows([{ label: '30d', pct: 50, windowMinutes: 60 }], now - 2 * hour, now)).toEqual([])
    await withBrain(async () => {
      writeTelemetry('codex', SID, { at: now - 2 * hour, windows: [{ label: '5h', pct: 95, resetsAt: '2026-10-14T11:30:00.000Z' }] })
      expect(latestWindows('codex', now)).toEqual([])
      expect(latestWindows('codex', now - 2 * hour).map(w => w.pct)).toEqual([95])
    })
  })
})

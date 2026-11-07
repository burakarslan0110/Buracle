import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promptSignals } from '../../src/core/memory/signals'
import { contextText } from '../../src/memory/context'
import { pendingSessions } from '../../src/memory/capture'
import { closeAllCortex, cortexFor } from '../../src/memory/cortex'
import { captureChecks } from '../../src/memory/doctor'
import { checkReply, statedByUser, type DistillRunner } from '../../src/memory/distill'
import { capturePending, finalize } from '../../src/memory/finalize'
import { brainDbFile, locksDir } from '../../src/memory/layout'
import { writeHandoff } from '../../src/memory/handoff'
import { promptSeen, readSessionRecord, sessionStart, writeSessionRecord } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { readStatus } from '../../src/memory/status'
import { forgetListCache, getStored, listAll, personRef, projectRef, storedId } from '../../src/memory/store'
import { writeTelemetry } from '../../src/workflow/session-store'
import * as paths from '../../src/engine/paths'
import { withEnv } from '../helpers/sandbox'
import { git, REAL_CORTEXDB, withBrain } from './helpers'

const SID = '0199a213-81c0-7800-8aa1-bbab2a035a80'
const OTHER = '0199a213-81c0-7800-8aa1-bbab2a035a81'
const HOUR = 3600_000
const DAY = 24 * HOUR

const answer = (out: unknown): DistillRunner => async () => ({ ok: true, text: JSON.stringify(out) })
const PROCEDURE = { summary: 'Moved the orders.', candidates: [{ type: 'procedure', scope: 'project', title: 'Run the migration before the deploy', description: 'two steps', body: '1. migrate\n2. deploy', confidence: 0.9, sources: [] }] }

async function spooled(repo: string, sid: string, entries: Parameters<typeof appendSpool>[2] = [], excerpt = 'Moved the orders service to CockroachDB.'): Promise<void> {
  await sessionStart('codex', sid, repo)
  appendSpool('codex', sid, [{ ts: Date.now(), ev: 'prompt' }, ...entries, { ts: Date.now() + 5, ev: 'stop', excerpt }])
}

const statement = (text: string, ts = Date.now() + 1) => promptSignals(text).map(signal => ({ ts, ev: 'prompt-signal' as const, signal }))

describe('finalize', () => {
  test('a late segment gets a second pass of the session memory, but the tail runs once', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      appendSpool('codex', SID, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: 'Fixed the flaky test.' }])
      // A working runner, because a disabled distill now owes the capture instead of finishing it (PRD R2).
      const running = finalize('codex', SID, { settleMs: 600, runner: answer(PROCEDURE) })
      for (let i = 0; i < 200 && readSessionRecord('codex', SID)?.status !== 'ended'; i++) await Bun.sleep(25)
      appendSpool('codex', SID, [{ ts: Date.now() + 2, ev: 'stop', excerpt: 'Also renamed the helper.' }], { suffix: 'late' })
      const r = await running
      expect(r.memoryId).toBeDefined()
      const mem = await getStored(projectRef('demo'), r.memoryId as string)
      expect(mem?.item.history.map(h => h.what)).toEqual(['session ended', 'finalized again', 'distilled'])
      expect(mem?.item.body).toContain('Also renamed the helper.')
      expect(r.capture?.state).toBe('done')
    })
  })

  test('without CortexDB the finalizer skips: nothing is written and nothing is started', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      await withEnv({ BURACLE_CORTEXDB_BIN: join(repo, 'no-such-cortexdb') }, async () => {
        expect(await finalize('codex', SID)).toEqual({ skipped: 'no-store' })
      })
      expect(readSessionRecord('codex', SID)?.status).toBe('active')
    })
  })

  test('a second finalize with nothing new spooled does nothing (several plugin instances may ask); a new segment finalizes again', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      appendSpool('codex', SID, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: 'Fixed the flaky test.' }])
      // A working runner, because a disabled distill now owes the capture instead of finishing it (PRD R2).
      const first = await finalize('codex', SID, { runner: answer(PROCEDURE) })
      expect(first.memoryId).toBeDefined()
      const again = await Promise.all([finalize('codex', SID), finalize('codex', SID), finalize('codex', SID)])
      expect(again.map(r => r.skipped)).toEqual(['already-finalized', 'already-finalized', 'already-finalized'])
      expect(again[0]).toMatchObject({ slug: 'demo', memoryId: first.memoryId })
      appendSpool('codex', SID, [{ ts: Date.now() + 2, ev: 'stop', excerpt: 'Resumed and renamed the helper.' }], { suffix: 'resume' })
      const resumed = await finalize('codex', SID, { runner: answer(PROCEDURE) })
      expect(resumed.skipped).toBeUndefined()
      expect((await getStored(projectRef('demo'), first.memoryId as string))?.item.body).toContain('Resumed and renamed the helper.')
    })
  })

  test('the session record keeps counts of the session (prompts, tools, files, tests, commits and the diffstat), never text', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      const t0 = Date.now()
      writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'add a')
      writeFileSync(join(repo, 'b.ts'), 'export const b = 2\nexport const c = 3\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'add b')
      appendSpool('codex', SID, [
        { ts: t0, ev: 'prompt', excerpt: 'secret prompt text' },
        { ts: t0 + 1, ev: 'tool', tool: 'apply_patch', kind: 'edit', paths: [join(repo, 'a.ts'), join(repo, 'b.ts')] },
        { ts: t0 + 2, ev: 'tool', tool: 'Bash', cmd: 'bun test', exit: 1 },
        { ts: t0 + 3, ev: 'tool', tool: 'Bash', cmd: 'bun test', exit: 0 },
        { ts: t0 + 4, ev: 'turn', model: 'gpt-6.1-sol' },
        { ts: t0 + 5, ev: 'stop', excerpt: 'Added a and b.' },
      ])
      await finalize('codex', SID)
      const rec = readSessionRecord('codex', SID)
      expect(rec?.stats).toEqual({
        endedMs: t0 + 5, prompts: 1, turns: 1, tools: 3, commands: 2, files: 2, tests: 2, testFailures: 1, model: 'gpt-6.1-sol',
        commits: 2, filesChanged: 2, insertions: 3, topTools: [['Bash', 2], ['apply_patch', 1]],
      })
      expect(JSON.stringify(rec)).not.toContain('secret prompt text')
    })
  })

  test('a session that started without a commit to count from records no commit count and no diffstat, only the other counts', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      const { commitStart: _start, ...rec } = readSessionRecord('codex', SID) as NonNullable<ReturnType<typeof readSessionRecord>>
      expect(_start).toBeDefined()
      writeSessionRecord(rec)
      writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'add a')
      const t0 = Date.now()
      appendSpool('codex', SID, [{ ts: t0, ev: 'prompt' }, { ts: t0 + 1, ev: 'tool', tool: 'Bash', cmd: 'git commit -m x', exit: 0 }, { ts: t0 + 2, ev: 'stop', excerpt: 'Done.' }])
      await finalize('codex', SID)
      const stats = readSessionRecord('codex', SID)?.stats
      expect(stats).toMatchObject({ prompts: 1, tools: 1, commands: 1 })
      for (const k of ['commits', 'filesChanged', 'insertions', 'deletions'] as const) expect({ k, v: stats?.[k] }).toEqual({ k, v: undefined })
    })
  })

  test('a folder memory.exclude keeps out gets no counts in its session record', async () => {
    await withBrain(async ({ repo, buracleHome }) => {
      await sessionStart('codex', SID, repo)
      writeFileSync(join(buracleHome, 'config.yaml'), `memory:\n  exclude:\n    - ${repo}\n`)
      appendSpool('codex', SID, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: 'Done.' }])
      await finalize('codex', SID)
      const rec = readSessionRecord('codex', SID)
      expect(rec?.status).toBe('ended')
      expect(rec?.stats).toBeUndefined()
    })
  })

  test('the session memory is saved with CortexDB\'s own time to live (45 days): the engine drops it, no sweep does', async () => {
    await withBrain(async ({ repo, root }) => {
      const clock = join(root, 'cortex-clock')
      await withEnv({ FAKE_CORTEXDB_CLOCK_FILE: clock }, async () => {
        const t0 = Date.now()
        await spooled(repo, SID)
        const r = await finalize('codex', SID, { pending: false, nowMs: t0 })
        const id = r.memoryId as string
        const item = (await getStored(projectRef('demo'), id))?.item
        expect(Date.parse(item?.expires as string)).toBeGreaterThan(t0 + 44 * DAY)
        expect(Date.parse(item?.expires as string)).toBeLessThan(t0 + 46 * DAY)
        const raw = await cortexFor(brainDbFile()).call<{ memory?: { expires_at?: string, metadata?: Record<string, unknown> } }>('memory_get', { memory_id: storedId(projectRef('demo'), id) })
        expect(Math.abs(Date.parse(raw.memory?.expires_at as string) - Date.parse(item?.expires as string))).toBeLessThan(5_000)
        expect(raw.memory?.metadata?.['ttl_seconds']).toBeGreaterThan(44 * 86_400)
        // The real engine keeps its own clock, so only the fake lets a test move time forward.
        if (REAL_CORTEXDB) return
        writeFileSync(clock, String(t0 + 44 * DAY))
        expect(await getStored(projectRef('demo'), id)).toBeDefined()
        writeFileSync(clock, String(t0 + 46 * DAY))
        expect(await getStored(projectRef('demo'), id)).toBeUndefined()
        forgetListCache()
        expect((await listAll(projectRef('demo'))).map(i => i.id)).not.toContain(id)
      })
    })
  })

  // A lasting preference comes from the session-end model call in any language (PRD follow-up 2026-11-06):
  // it is explicit only when the user's own words it quotes appear in the session's prompts.
  const STATED = 'Schreib Commit-Nachrichten ab jetzt immer auf Deutsch.'
  const preference = (stated?: string) => ({ summary: 'Agreed on the commit language.', candidates: [{ type: 'preference', scope: 'person', title: 'Write commit messages in German', description: 'the commit language', body: '', confidence: 0.8, sources: [], ...(stated !== undefined ? { stated } : {}) }] })

  test('a preference the user stated in any language is filed as explicit when its quote is in the prompts', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID, [{ ts: Date.now() + 1, ev: 'prompt', excerpt: STATED }])
      const r = await finalize('codex', SID, { pending: false, runner: answer(preference(STATED)) })
      expect(r.capture).toMatchObject({ state: 'done', distill: { ran: true } })
      const [pref] = (await listAll(personRef())).filter(i => i.kind === 'preference')
      expect(pref).toMatchObject({ layer: 'person', origin: 'explicit', confidence: 1, review: 'ok', status: 'active', title: 'Write commit messages in German' })
      expect(pref?.body).toContain(STATED)
    })
  })

  test('a quote the user never typed, or no quote, keeps the preference inferred', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID, [{ ts: Date.now() + 1, ev: 'prompt', excerpt: 'Fix the parser.' }])
      await finalize('codex', SID, { pending: false, runner: answer(preference(STATED)) })
      expect((await listAll(personRef())).find(i => i.kind === 'preference')).toMatchObject({ origin: 'inferred', confidence: 0.8 })
    })
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID, [{ ts: Date.now() + 1, ev: 'prompt', excerpt: STATED }])
      await finalize('codex', SID, { pending: false, runner: answer(preference()) })
      expect((await listAll(personRef())).find(i => i.kind === 'preference')).toMatchObject({ origin: 'inferred', confidence: 0.8 })
    })
  })

  test('statedByUser: a quote of at least 20 characters and 3 words, matched with case, spacing and quote marks folded', () => {
    const prompts = ['Fix the parser.', 'From now on, ALWAYS   write the failing test "first".']
    expect(statedByUser('from now on, always write the failing test first.', prompts)).toBe(true)
    expect(statedByUser('always write', prompts)).toBe(false)
    expect(statedByUser('Fix the parser.', prompts)).toBe(false)
    expect(statedByUser('never push to main without a review', prompts)).toBe(false)
    expect(statedByUser(undefined, prompts)).toBe(false)
  })

  test('an over-long stated quote is dropped, not the whole reply: the candidate stays, inferred', () => {
    const r = checkReply(JSON.stringify(preference('x'.repeat(400))))
    expect(r.ok).toBe(true)
    expect(r.ok ? r.reply.candidates[0]?.stated : 'bad').toBeUndefined()
  })

  test('without a model, a standing rule in the prompts files nothing: no word list reads it', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID, statement('Always run the tests before you commit.'))
      const r = await finalize('codex', SID, { pending: false })
      expect(r.capture?.preferences.written).toEqual([])
      expect((await listAll(personRef())).filter(i => i.kind === 'preference')).toEqual([])
    })
  })

  test('one bounded model call distills the session after the deterministic steps; the session record remembers the material', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID)
      let calls = 0
      const counting: DistillRunner = async p => { calls++; return answer(PROCEDURE)(p, { maxOutputTokens: 1, timeoutMs: 1 }) }
      const r = await finalize('codex', SID, { pending: false, runner: counting })
      expect(calls).toBe(1)
      expect(r.capture).toMatchObject({ state: 'done', distill: { ran: true } })
      expect((await listAll(projectRef('demo'))).find(i => i.kind === 'procedure')).toMatchObject({ origin: 'inferred', confidence: 0.9 })
      const rec = readSessionRecord('codex', SID)
      expect(rec?.capture).toMatchObject({ state: 'done', tries: 0, sha: expect.stringMatching(/^[0-9a-f]{16}$/) })
      expect(readStatus('demo')?.last_capture).toMatchObject({ by: 'codex', saved: 1 })
      const again = await finalize('codex', SID, { pending: false, runner: counting, force: true })
      expect(again.capture?.distill).toMatchObject({ ran: false, skipped: 'already-distilled' })
      expect(calls).toBe(1)
      const forced = await finalize('codex', SID, { pending: false, runner: counting, force: true, redistill: true })
      expect(forced.capture?.distill?.ran).toBe(true)
      expect(calls).toBe(2)
    })
  })

  test('a failed or invalid model answer leaves a retry mark in the session record and changes no memory; the third failure gives up', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID)
      const bad: DistillRunner = async () => ({ ok: true, text: '{ "candidates": [ { "type": "wish" } ] }' })
      const first = await finalize('codex', SID, { pending: false, runner: bad })
      expect(first.capture).toMatchObject({ state: 'retry', distill: { ran: false, skipped: 'invalid-reply' } })
      const before = JSON.stringify((await listAll(projectRef('demo'))).map(i => [i.id, i.version]))
      expect(readSessionRecord('codex', SID)?.capture).toMatchObject({ state: 'retry', tries: 1 })
      const failing: DistillRunner = async () => ({ ok: false, text: '', error: 'codex: not logged in' })
      expect((await finalize('codex', SID, { pending: false, runner: failing, force: true })).capture?.state).toBe('retry')
      expect(readSessionRecord('codex', SID)?.capture).toMatchObject({ state: 'retry', tries: 2 })
      expect((await finalize('codex', SID, { pending: false, runner: failing, force: true })).capture?.state).toBe('gave-up')
      expect(readSessionRecord('codex', SID)?.capture).toMatchObject({ state: 'gave-up', tries: 3 })
      expect(JSON.stringify((await listAll(projectRef('demo'))).map(i => [i.id, i.version]))).toBe(before)
    })
  })

  test('a rate-limited harness owes a retry without spending a try', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID)
      writeTelemetry('codex', SID, { at: Date.now(), windows: [{ label: '5h', pct: 95 }] })
      const r = await finalize('codex', SID, { pending: false, runner: answer(PROCEDURE) })
      expect(r.capture).toMatchObject({ state: 'retry', distill: { skipped: 'rate-limit' } })
      expect(readSessionRecord('codex', SID)?.capture).toMatchObject({ state: 'retry', tries: 0 })
      expect((await listAll(projectRef('demo'))).some(i => i.kind === 'procedure')).toBe(false)
    })
  })

  test('the next session end takes up to three stale sessions whose capture is owed, once their age is a few hours', async () => {
    await withBrain(async ({ repo }) => {
      const t0 = Date.now()
      const failing: DistillRunner = async () => ({ ok: false, text: '', error: 'codex: not logged in' })
      await spooled(repo, SID)
      await finalize('codex', SID, { pending: false, runner: failing, nowMs: t0 })
      expect(readSessionRecord('codex', SID)?.capture?.state).toBe('retry')
      await spooled(repo, OTHER)
      let seen = 0
      const ok: DistillRunner = async () => { seen++; return { ok: true, text: JSON.stringify(PROCEDURE) } }
      const soon = await finalize('codex', OTHER, { runner: ok, nowMs: t0 + HOUR })
      expect(soon.pending).toBeUndefined()
      expect(seen).toBe(1)
      await spooled(repo, '0199a213-81c0-7800-8aa1-bbab2a035a82', [], 'Renamed the billing queue and moved its worker.')
      const later = await finalize('codex', '0199a213-81c0-7800-8aa1-bbab2a035a82', { runner: ok, nowMs: t0 + 4 * HOUR })
      expect(later.pending?.map(p => [p.sid, p.why, p.result.capture?.state])).toEqual([[SID, 'retry', 'done']])
      expect(readSessionRecord('codex', SID)?.capture).toMatchObject({ state: 'done' })
      expect(seen).toBe(3)
      expect(await capturePending({ runner: ok, nowMs: t0 + 8 * HOUR })).toEqual([])
    })
  })

  test('a session whose harness died before its end hook ran is finalized by a later session end', async () => {
    await withBrain(async ({ repo }) => {
      const t0 = Date.now()
      // A spool written before PRD follow-up 2026-11-06 still holds the H26 statement; finalize files it.
      await spooled(repo, SID, [{ ts: Date.now() + 1, ev: 'prompt-signal', signal: { kind: 'statement', key: 'said:amend-commits-published', polarity: -1, category: 'avoid', text: 'Never amend published commits', quote: 'Never amend published commits.' } }])
      expect(readSessionRecord('codex', SID)?.status).toBe('active')
      await spooled(repo, OTHER)
      const r = await finalize('codex', OTHER, { nowMs: t0 + 4 * HOUR })
      expect(r.pending?.map(p => [p.sid, p.why, p.result.skipped])).toEqual([[SID, 'stale', undefined]])
      expect(readSessionRecord('codex', SID)?.status).toBe('ended')
      expect((await listAll(personRef())).filter(i => i.kind === 'preference').map(i => i.origin)).toEqual(['explicit'])
      expect((await listAll(projectRef('demo'))).filter(i => i.kind === 'session')).toHaveLength(2)
    })
  })

  test('a session start, a prompt, the start text and a handoff start no process: only the session end does', async () => {
    await withBrain(async ({ repo }) => {
      const real = Bun.spawn
      const realSync = Bun.spawnSync
      const started: string[] = []
      const note = (cmd: unknown): void => { const argv = (Array.isArray(cmd) ? cmd : (cmd as { cmd?: unknown[] })?.cmd ?? []) as string[]; if (argv[0] !== 'git' && !String(argv[0]).endsWith('cortexdb-mcp') && !String(argv[0]).includes('fake-cortexdb') && !String(argv[1] ?? '').includes('fake-cortexdb')) started.push(argv.join(' ')) }
      ;(Bun as unknown as { spawn: unknown }).spawn = ((cmd: unknown, ...rest: unknown[]) => { note(cmd); return (real as (...a: unknown[]) => unknown)(cmd, ...rest) }) as unknown
      ;(Bun as unknown as { spawnSync: unknown }).spawnSync = ((cmd: unknown, ...rest: unknown[]) => { note(cmd); return (realSync as (...a: unknown[]) => unknown)(cmd, ...rest) }) as unknown
      try {
        Bun.spawnSync(['true'], { env: { ...process.env } })
        expect(started).toEqual(['true'])
        started.length = 0
        await withEnv({ BURACLE_NO_CAPTURE: undefined, BURACLE_NO_AUTOSTART: undefined }, async () => {
          await sessionStart('codex', SID, repo)
          promptSeen('codex', SID)
          await contextText({ cwd: repo })
          await writeHandoff({ harness: 'codex', sessionId: SID, cwd: repo, slug: 'handoff-a', markdown: '---\ntitle: "Handoff"\n---\nopen work\n' })
        })
      } finally {
        ;(Bun as unknown as { spawn: unknown }).spawn = real
        ;(Bun as unknown as { spawnSync: unknown }).spawnSync = realSync
      }
      expect(started).toEqual([])
      const state = existsSync(locksDir()) ? readdirSync(locksDir()).filter(n => !n.startsWith('brain-')) : []
      expect(state).toEqual([])
    })
  })

  test('the session end leaves none of the machinery that used to run in the background: no jobs journal, tick, sweep, repair, upkeep or profile files', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID, statement('Always run the tests before you commit.'))
      const r = await finalize('codex', SID, { pending: false })
      expect(r.memoryId).toBeDefined()
      expect(r.capture?.distill).toMatchObject({ ran: false, skipped: 'disabled' })
      const names = readdirSync(paths.memoryStateDir())
      for (const gone of ['jobs.jsonl', 'tick.json', 'sweep.json', 'heal.json', 'upkeep', 'distinct', 'profile', 'reflect', 'verify', 'distill', 'scan']) expect(names).not.toContain(gone)
    })
  })

  test('the capture state says retry while the model call runs, so a death mid-call leaves a session the pending scan can finish (PRD R1)', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID)
      let release!: (r: { ok: true, text: string }) => void
      const gate = new Promise<{ ok: true, text: string }>(resolve => { release = resolve })
      const running = finalize('codex', SID, { pending: false, runner: () => gate })
      let mid: string | undefined
      for (let i = 0; i < 160 && mid === undefined; i++) {
        await Bun.sleep(25)
        const c = readSessionRecord('codex', SID)?.capture
        if (c !== undefined) mid = c.state
      }
      release({ ok: true, text: JSON.stringify(PROCEDURE) })
      const r = await running
      expect(mid).toBe('retry')
      expect(r.capture?.state).toBe('done')
      expect(readSessionRecord('codex', SID)?.capture).toMatchObject({ state: 'done', tries: 0 })
    })
  })

  test('an ended session whose capture state was never written is listed as pending and captured from its done spool (PRD R1)', async () => {
    await withBrain(async ({ repo }) => {
      const t0 = Date.now()
      await spooled(repo, SID)
      await finalize('codex', SID, { pending: false, runner: answer(PROCEDURE), nowMs: t0 })
      // A crash before any capture state was written: the state is missing, the spool already sits in done.
      const { capture: _c, ...rec } = readSessionRecord('codex', SID) as NonNullable<ReturnType<typeof readSessionRecord>>
      writeSessionRecord(rec)
      expect(pendingSessions(t0 + HOUR, { afterMs: 0 }).map(p => [p.sid, p.why])).toEqual([[SID, 'retry']])
      const done = await capturePending({ runner: answer(PROCEDURE), nowMs: t0 + 4 * HOUR })
      expect(done.map(d => [d.sid, d.result.capture?.state])).toEqual([[SID, 'done']])
      expect((await listAll(projectRef('demo'))).filter(i => i.kind === 'procedure')).toHaveLength(1)
    })
  })

  test('a session that ends outside any project bucket is marked done and never listed as pending (PRD R1)', async () => {
    await withBrain(async ({ repo, buracleHome }) => {
      await sessionStart('codex', SID, repo)
      writeFileSync(join(buracleHome, 'config.yaml'), `memory:\n  exclude:\n    - ${repo}\n`)
      appendSpool('codex', SID, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: 'Done.' }])
      await finalize('codex', SID, { pending: false })
      const rec = readSessionRecord('codex', SID)
      expect(rec?.status).toBe('ended')
      expect(rec?.capture).toMatchObject({ state: 'done' })
      expect(pendingSessions(Date.now(), { afterMs: 0 }).find(p => p.sid === SID)).toBeUndefined()
      expect(captureChecks(Date.now())).toEqual([{ level: 'ok', check: 'capture', detail: 'no session waits for its capture' }])
    })
  })

  test('a session whose distill is disabled owes its capture: the state stays retry without spending a try (PRD R2)', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID)
      const r = await finalize('codex', SID, { pending: false })
      expect(r.capture?.distill).toMatchObject({ ran: false, skipped: 'disabled' })
      expect(r.capture?.state).toBe('retry')
      expect(readSessionRecord('codex', SID)?.capture).toMatchObject({ state: 'retry', tries: 0 })
    })
  })

  test('a brain that cannot read the session memory owes a retry that spends a try, not a done capture (PRD R2)', async () => {
    await withBrain(async ({ repo }) => {
      const t0 = Date.now()
      await spooled(repo, SID)
      await finalize('codex', SID, { pending: false, runner: answer(PROCEDURE), nowMs: t0 })
      await withEnv({ FAKE_CORTEXDB_FAIL: 'memory_get' }, async () => {
        await closeAllCortex()
        const again = await finalize('codex', SID, { pending: false, runner: answer(PROCEDURE), force: true, nowMs: t0 + HOUR })
        expect(again.capture?.distill).toMatchObject({ ran: false, skipped: 'no-session-memory' })
        expect(again.capture?.state).toBe('retry')
        expect(readSessionRecord('codex', SID)?.capture).toMatchObject({ state: 'retry', tries: 1 })
      })
    })
  })

  test('an empty session with no session memory is done at once, not a retry that burns tries (PRD R2)', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      appendSpool('codex', SID, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: '' }])
      const r = await finalize('codex', SID, { pending: false })
      expect(r.empty).toBe(true)
      expect(r.capture?.state).toBe('done')
      expect(readSessionRecord('codex', SID)?.capture).toMatchObject({ state: 'done', tries: 0 })
    })
  })

  test('the doctor does not count a session whose model call is running right now (PRD R1)', async () => {
    await withBrain(async ({ repo }) => {
      await spooled(repo, SID)
      let release!: (r: { ok: true, text: string }) => void
      const gate = new Promise<{ ok: true, text: string }>(resolve => { release = resolve })
      const running = finalize('codex', SID, { pending: false, runner: () => gate })
      let mid: string | undefined
      for (let i = 0; i < 160 && mid === undefined; i++) {
        await Bun.sleep(25)
        const c = readSessionRecord('codex', SID)?.capture
        if (c !== undefined) mid = c.state
      }
      expect(mid).toBe('retry')
      const midCall = captureChecks(Date.now())
      release({ ok: true, text: JSON.stringify(PROCEDURE) })
      const r = await running
      expect(midCall).toEqual([{ level: 'ok', check: 'capture', detail: 'no session waits for its capture' }])
      expect(r.capture?.state).toBe('done')
    })
  })
})

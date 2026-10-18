import { describe, expect, test } from 'bun:test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { update, write } from '../../src/memory/api'
import { appendJob, readJobs } from '../../src/memory/jobs'
import { getStored, projectRef } from '../../src/memory/store'
import { refreshUpkeepFor } from '../../src/memory/sweep'
import { keyOf, knownFiles } from '../../src/memory/evidence'
import { fitExcerpts, readVerifyRuns, undoVerify, verifyProject, VERIFY_BY } from '../../src/memory/verify'
import { headShaSync, maybeStartVerify, readVerifyState, verifiableCount, writeVerifyState } from '../../src/memory/verify-start'
import type { ModelRunner } from '../../src/memory/runner'
import { withEnv } from '../helpers/sandbox'
import { agentCtx, git, withBrain } from './helpers'

const ORDERS = [
  '// The orders service.',
  'export const ORDERS_TABLE = "orders_v2"',
  'export const ORDER_CACHE_TTL_SECONDS = 300',
  '',
  'export function orderKey(id: string): string {',
  '  return `order:${id}`',
  '}',
  '',
].join('\n')

function scripted(reply: (prompt: string) => unknown): ModelRunner & { prompts: string[] } {
  const prompts: string[] = []
  const fn: ModelRunner = async prompt => { prompts.push(prompt); return { ok: true, text: JSON.stringify(reply(prompt)) } }
  return Object.assign(fn, { prompts })
}

async function seedRepo(repo: string): Promise<{ head: string }> {
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'orders.ts'), ORDERS)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'orders')
  return { head: git(repo, 'rev-parse', '--short', 'HEAD') }
}

async function claim(repo: string, title: string, body: string): Promise<string> {
  return (await write(agentCtx(repo), { type: 'knowledge', title, summary: 'from the orders service', body, sources: ['src/orders.ts:3'] })).id
}

const item = async (id: string) => (await getStored(projectRef('demo'), id))?.item
const readVerifyRunsCount = () => readVerifyRuns().length

describe('verify', () => {
  test('a claim whose quote is in the cited file is verified with the pack commit, journaled, and can be undone', async () => {
    await withBrain(async ({ repo }) => {
      const { head } = await seedRepo(repo)
      const id = await claim(repo, 'Order cache entries live five minutes', 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.')
      const runner = scripted(() => ({ verdicts: [{ id, verdict: 'holds', checked: 'the TTL constant', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 300' }], note: '' }] }))
      const run = await verifyProject('demo', { trigger: 'manual', runner })
      expect(run.skipped).toBeUndefined()
      expect(run.verified.map(v => v.id)).toEqual([id])
      expect(runner.prompts[0]).toContain('ORDER_CACHE_TTL_SECONDS = 300')
      const after = await item(id)
      expect(after).toMatchObject({ review: 'ok', verifiedBy: VERIFY_BY, verifiedCommit: head })
      expect(after?.history.at(-1)?.what).toContain(`verify ${run.id}: verified against src/orders.ts`)
      expect(readJobs().filter(e => e.job === 'verify').at(-1)).toMatchObject({ outcome: 'ran', project: 'demo', trigger: 'manual' })
      const u = await undoVerify(run.id)
      expect(u.restored).toEqual([id])
      const back = await item(id)
      expect(back?.review).toBe('pending')
      expect(back?.verifiedBy).toBeUndefined()
    })
  })

  test('a claim is checked against the working tree: uncommitted edits and untracked files count, and the commit is marked with +', async () => {
    await withBrain(async ({ repo }) => {
      const { head } = await seedRepo(repo)
      const id = await claim(repo, 'Order cache entries live one hour', 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.')
      writeFileSync(join(repo, 'src', 'orders.ts'), ORDERS.replace('= 300', '= 3600'))
      writeFileSync(join(repo, 'src', 'refunds.ts'), 'export const REFUNDS_TABLE = "refunds"\n')
      const fresh = (await write(agentCtx(repo), { type: 'knowledge', title: 'Refunds have their own table', summary: 'from the refunds module', body: 'The table is `REFUNDS_TABLE`.', sources: ['src/refunds.ts'] })).id
      const runner = scripted(() => ({ verdicts: [
        { id, verdict: 'holds', checked: 'the TTL', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 3600' }], note: '' },
        { id: fresh, verdict: 'holds', checked: 'the table', quotes: [{ file: 'src/refunds.ts', text: 'export const REFUNDS_TABLE = "refunds"' }], note: '' },
      ] }))
      const run = await verifyProject('demo', { trigger: 'manual', runner })
      expect(runner.prompts).toHaveLength(1)
      expect(runner.prompts[0]).toContain('ORDER_CACHE_TTL_SECONDS = 3600')
      expect(run.verified.map(v => v.id).sort()).toEqual([fresh, id].sort())
      expect((await item(id))?.verifiedCommit).toBe(`${head}+`)
      expect((await item(fresh))?.verifiedCommit).toBe(`${head}+`)
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'ttl and refunds')
      await refreshUpkeepFor(projectRef('demo'), { nowMs: Date.now(), git: true })
      const again = await verifyProject('demo', { trigger: 'manual', runner: scripted(() => ({ verdicts: [] })) })
      expect(again.skipped).toBe('nothing-to-do')
    })
  })

  test('a made-up quote changes nothing and backs the memory off until its file changes', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      const id = await claim(repo, 'Order cache entries live one hour', 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.')
      const runner = scripted(() => ({ verdicts: [{ id, verdict: 'holds', checked: 'the TTL', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 3600' }], note: '' }] }))
      const run = await verifyProject('demo', { trigger: 'manual', runner })
      expect(run.verified).toEqual([])
      expect(run.unsure).toEqual([{ id, why: 'quote-not-found' }])
      expect((await item(id))?.review).toBe('pending')
      const again = await verifyProject('demo', { trigger: 'manual', runner: scripted(() => ({ verdicts: [] })) })
      expect(again.skipped).toBe('nothing-to-do')
      writeFileSync(join(repo, 'src', 'orders.ts'), ORDERS.replace('300', '3600'))
      git(repo, 'commit', '-q', '-am', 'longer ttl')
      const third = await verifyProject('demo', { trigger: 'manual', runner: scripted(() => ({ verdicts: [{ id, verdict: 'holds', checked: 'the TTL', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 3600' }], note: '' }] })) })
      expect(third.verified.map(v => v.id)).toEqual([id])
    })
  })

  test('a quoted contradiction keeps the memory pending and sends it to the agent as contradicted', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      const id = await claim(repo, 'Orders are stored in the orders_v1 table', 'The table is `ORDERS_TABLE`.')
      const runner = scripted(() => ({ verdicts: [{ id, verdict: 'wrong', checked: 'the table name', quotes: [{ file: 'src/orders.ts', text: 'export const ORDERS_TABLE = "orders_v2"' }], note: 'The table is orders_v2, not orders_v1.' }] }))
      const run = await verifyProject('demo', { trigger: 'manual', runner })
      expect(run.contradicted.map(c => c.id)).toEqual([id])
      const after = await item(id)
      expect(after?.review).toBe('pending')
      expect(after?.contradictedNote).toBe('The table is orders_v2, not orders_v1. (src/orders.ts)')
      const up = await refreshUpkeepFor(projectRef('demo'), { nowMs: Date.now() })
      expect(up.items.find(u => u.id === id)?.reasons).toContain('contradicted')
      const again = await verifyProject('demo', { trigger: 'manual', runner: scripted(() => ({ verdicts: [] })) })
      expect(again.skipped).toBe('nothing-to-do')
    })
  })

  test('a cited file that changes during the run is not judged on the old excerpts; an unrelated commit changes nothing', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      const id = await claim(repo, 'Order cache entries live five minutes', 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.')
      const runner = scripted(() => {
        writeFileSync(join(repo, 'src', 'orders.ts'), ORDERS.replace('= 300', '= 3600'))
        return { verdicts: [{ id, verdict: 'holds', checked: 'the TTL', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 300' }], note: '' }] }
      })
      const run = await verifyProject('demo', { trigger: 'manual', runner })
      expect(run.skipped).toBeUndefined()
      expect(run.verified).toEqual([])
      expect(run.unsure).toEqual([{ id, why: 'its files changed during the run' }])
      expect((await item(id))?.review).toBe('pending')
      const again = await verifyProject('demo', { trigger: 'manual', runner: scripted(() => {
        writeFileSync(join(repo, 'NOTES.md'), 'meanwhile\n')
        git(repo, 'add', '-A')
        git(repo, 'commit', '-q', '-m', 'meanwhile')
        return { verdicts: [{ id, verdict: 'wrong', checked: 'the TTL', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 3600' }], note: 'The TTL is an hour.' }] }
      }) })
      expect(again.contradicted.map(c => c.id)).toEqual([id])
    })
  })

  test('a claim without any evidence is settled at once: quiet in the backlog, not started again until the memory or its files change', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      const id = (await write(agentCtx(repo), { type: 'knowledge', title: 'Deploys go out on Tuesdays', summary: 'the release train', body: 'The train leaves on Tuesday at eleven; hotfixes any day.' })).id
      const run = await verifyProject('demo', { trigger: 'manual', runner: scripted(() => ({ verdicts: [] })) })
      expect(run.unsure).toEqual([{ id, why: 'no evidence: no cited or quoted file found in the repository' }])
      expect(readVerifyState().backoff[id]?.tries).toBe(2)
      const later = Date.now() + 8 * 86_400_000
      const up = await refreshUpkeepFor(projectRef('demo'), { nowMs: later, git: true })
      expect(up.items.find(u => u.id === id)).toMatchObject({ reasons: ['unverified'], quiet: true })
      expect(verifiableCount('demo', later)).toBe(0)
      await update(agentCtx(repo), { id, patch: { sources: ['src/orders.ts:3'] } })
      const again = await refreshUpkeepFor(projectRef('demo'), { nowMs: later, git: true })
      expect(again.items.find(u => u.id === id)?.quiet).toBeUndefined()
      expect(verifiableCount('demo', later)).toBe(1)
      const third = await verifyProject('demo', { trigger: 'manual', runner: scripted(() => ({ verdicts: [{ id, verdict: 'holds', checked: 'the constant', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 300' }], note: '' }] })) })
      expect(third.verified.map(v => v.id)).toEqual([id])
    })
  })

  test('an answer without verdicts counts as no try: the run fails with the start of the answer, and the memory is tried again after ten minutes', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      const id = await claim(repo, 'Order cache entries live five minutes', 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.')
      const prose: ModelRunner = async () => ({ ok: true, text: 'I need to read the code first before I can judge these memories.' })
      const run = await verifyProject('demo', { trigger: 'manual', runner: prose })
      expect(run).toMatchObject({ skipped: 'runner-failed', checked: 1, unsure: [] })
      expect(run.detail).toContain('I need to read the code first')
      expect(readVerifyState().backoff[id]?.tries).toBe(0)
      expect(readJobs().filter(e => e.job === 'verify').map(e => e.outcome)).toEqual(['failed'])
      expect((await verifyProject('demo', { trigger: 'manual', runner: prose })).skipped).toBe('nothing-to-do')
      expect((await verifyProject('demo', { trigger: 'manual', nowMs: Date.now() + 9 * 60_000, runner: prose })).skipped).toBe('nothing-to-do')
      const holds = scripted(() => ({ verdicts: [{ id, verdict: 'holds', checked: 'the TTL', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 300' }], note: '' }] }))
      const later = await verifyProject('demo', { trigger: 'manual', nowMs: Date.now() + 11 * 60_000, runner: holds })
      expect(later.verified.map(v => v.id)).toEqual([id])
    })
  })

  test('a lone claim the code can neither confirm nor refute, whose evidence fit the prompt, is settled at once: one model call, out of the backlog', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      const id = await claim(repo, 'Order cache entries live five minutes', 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.')
      const unsure = scripted(() => ({ verdicts: [{ id, verdict: 'unsure', checked: 'the TTL', quotes: [], note: 'the excerpt does not show it' }] }))
      const run = await verifyProject('demo', { trigger: 'manual', runner: unsure })
      expect(run).toMatchObject({ rounds: 1, checked: 1, unsure: [{ id, why: 'the excerpt does not show it' }] })
      expect(unsure.prompts).toHaveLength(1)
      expect(readVerifyState().backoff[id]?.tries).toBe(2)
      expect((await verifyProject('demo', { trigger: 'manual', runner: unsure })).skipped).toBe('nothing-to-do')
    })
  })

  test('a claim whose evidence was cut gets its second try at once with more room, and leaves the backlog at the end of the same run, also when its files changed since it was verified', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      const big = `${ORDERS}${Array.from({ length: 30 }, (_, n) => `// filler ${n} ${'z'.repeat(900)}`).join('\n')}\n`
      writeFileSync(join(repo, 'src', 'orders.ts'), big)
      git(repo, 'commit', '-q', '-am', 'long orders file')
      const id = await claim(repo, 'Order cache entries live five minutes', 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.')
      const other = await claim(repo, 'Order keys are prefixed with order', 'Keys come from `orderKey`.')
      const quote = { file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 300' }
      const keyQuote = { file: 'src/orders.ts', text: 'export function orderKey(id: string): string {' }
      const both = scripted(() => ({ verdicts: [{ id, verdict: 'holds', checked: 'the TTL', quotes: [quote], note: '' }, { id: other, verdict: 'holds', checked: 'the key', quotes: [keyQuote], note: '' }] }))
      expect((await verifyProject('demo', { trigger: 'manual', runner: both })).verified.map(v => v.id).sort()).toEqual([id, other].sort())
      writeFileSync(join(repo, 'src', 'orders.ts'), `${big}export const ORDER_PAGE_SIZE = 50\n`)
      git(repo, 'commit', '-q', '-am', 'page size')
      const t0 = Date.now()
      expect((await refreshUpkeepFor(projectRef('demo'), { nowMs: t0, git: true })).items.filter(u => u.reasons.includes('source-changed')).map(u => u.id).sort()).toEqual([id, other].sort())
      const mixed = scripted(p => ({ verdicts: [
        { id, verdict: 'unsure', checked: 'the TTL', quotes: [], note: 'the excerpt does not show it' },
        ...(p.includes(`id="${other}"`) ? [{ id: other, verdict: 'holds', checked: 'the key', quotes: [keyQuote], note: '' }] : []),
      ] }))
      const run = await verifyProject('demo', { trigger: 'manual', nowMs: t0, runner: mixed })
      expect(run).toMatchObject({ rounds: 2, checked: 2 })
      expect(run.verified.map(v => v.id)).toEqual([other])
      expect(run.unsure).toEqual([{ id, why: 'the excerpt does not show it' }])
      expect(mixed.prompts).toHaveLength(2)
      expect(mixed.prompts[1]).not.toContain(`id="${other}"`)
      expect((mixed.prompts[1] as string).length).toBeGreaterThan((mixed.prompts[0] as string).length / 2)
      expect(readVerifyState().backoff[id]?.tries).toBe(2)
      const up = await refreshUpkeepFor(projectRef('demo'), { nowMs: t0, git: true })
      expect(up.items.find(u => u.id === id)).toMatchObject({ reasons: ['source-changed'], quiet: true })
      expect(up.items.find(u => u.id === other)).toBeUndefined()
      expect(verifiableCount('demo', t0)).toBe(0)
      expect((await verifyProject('demo', { trigger: 'manual', nowMs: t0, runner: mixed })).skipped).toBe('nothing-to-do')
    })
  })

  test('a second round that gets no verdicts keeps the first round, and its memories wait ten minutes', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      writeFileSync(join(repo, 'src', 'orders.ts'), `${ORDERS}${Array.from({ length: 30 }, (_, n) => `// filler ${n} ${'z'.repeat(900)}`).join('\n')}\n`)
      git(repo, 'commit', '-q', '-am', 'long orders file')
      const id = await claim(repo, 'Order cache entries live five minutes', 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.')
      const other = await claim(repo, 'Order keys are prefixed with order', 'Keys come from `orderKey`.')
      const keyQuote = { file: 'src/orders.ts', text: 'export function orderKey(id: string): string {' }
      let calls = 0
      const flaky: ModelRunner = async () => ({ ok: true, text: ++calls === 1 ? JSON.stringify({ verdicts: [{ id, verdict: 'unsure', checked: 'x', quotes: [], note: 'not shown' }, { id: other, verdict: 'holds', checked: 'the key', quotes: [keyQuote], note: '' }] }) : 'Sorry, I can only answer in prose.' })
      const t0 = Date.now()
      const run = await verifyProject('demo', { trigger: 'manual', nowMs: t0, runner: flaky })
      expect(run.skipped).toBeUndefined()
      expect(run.rounds).toBe(2)
      expect(run.verified.map(v => v.id)).toEqual([other])
      expect(run.detail).toContain('round 2 stopped (runner-failed)')
      expect(readVerifyState().backoff[id]).toMatchObject({ tries: 1 })
      expect(readVerifyRunsCount()).toBe(1)
      const quote = { file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 300' }
      const holds = scripted(() => ({ verdicts: [{ id, verdict: 'holds', checked: 'the TTL', quotes: [quote], note: '' }] }))
      expect((await verifyProject('demo', { trigger: 'manual', nowMs: t0 + 5 * 60_000, runner: holds })).skipped).toBe('nothing-to-do')
      expect((await verifyProject('demo', { trigger: 'manual', nowMs: t0 + 11 * 60_000, runner: holds })).verified.map(v => v.id)).toEqual([id])
    })
  })

  test('every candidate has its file fingerprint, not only the first 24: a memory far down the list is judged, not taken as changed during the run', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      const ref = projectRef('demo')
      const held: string[] = []
      const words = 'amber birch cobalt dune ember fjord garnet harbor iris juniper kelp lagoon marble nectar onyx prairie quartz raven saffron tundra umber velvet willow xenon yarrow zephyr'.split(' ')
      for (const w of words) held.push((await write(agentCtx(repo), { type: 'knowledge', title: `${w} ${w}s ${w}ed`, summary: w, body: 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.', sources: ['src/orders.ts:3'], force: true })).id)
      await Bun.sleep(5)
      const last = (await write(agentCtx(repo), { type: 'knowledge', title: 'Order cache entries live five minutes', summary: 'the TTL', body: 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.', sources: ['src/orders.ts:3'], force: true })).id
      const known = await knownFiles(repo)
      const at = new Date().toISOString()
      const backoff: Record<string, { at: string, key: string, tries: number }> = {}
      for (const id of held) backoff[id] = { at, key: keyOf(repo, (await getStored(ref, id))!.item, known), tries: 2 }
      writeVerifyState({ v: 1, backoff }, Date.now())
      const runner = scripted(() => ({ verdicts: [{ id: last, verdict: 'holds', checked: 'the TTL', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 300' }], note: '' }] }))
      const run = await verifyProject('demo', { trigger: 'manual', runner })
      expect(run.unsure).toEqual([])
      expect(run.verified.map(v => v.id)).toEqual([last])
    })
  })

  test('a file taken out of git but still on disk does not count as a changed source', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      mkdirSync(join(repo, 'notes'), { recursive: true })
      writeFileSync(join(repo, 'notes', 'design.md'), '# Orders\nThe cache TTL is ORDER_CACHE_TTL_SECONDS.\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'notes')
      const id = (await write(agentCtx(repo), { type: 'knowledge', title: 'The design notes name the cache TTL', summary: 'notes', body: 'See `ORDER_CACHE_TTL_SECONDS`.', sources: ['notes/design.md', 'src/orders.ts'] })).id
      await update(agentCtx(repo), { id, patch: { review: 'ok' } })
      git(repo, 'rm', '-q', '--cached', 'notes/design.md')
      writeFileSync(join(repo, '.gitignore'), 'notes/\n')
      git(repo, 'add', '.gitignore')
      git(repo, 'commit', '-q', '-m', 'keep the notes local')
      expect((await refreshUpkeepFor(projectRef('demo'), { nowMs: Date.now(), git: true })).items.find(u => u.id === id)).toBeUndefined()
      writeFileSync(join(repo, 'src', 'orders.ts'), `${ORDERS}export const ORDER_PAGE_SIZE = 50\n`)
      git(repo, 'commit', '-q', '-am', 'page size')
      expect((await refreshUpkeepFor(projectRef('demo'), { nowMs: Date.now(), git: true })).items.find(u => u.id === id)).toMatchObject({ reasons: ['source-changed'], files: ['src/orders.ts'] })
    })
  })

  test('switches and start rules: BURACLE_NO_VERIFY, nothing waiting, no interval; a later mark holds ten minutes unless HEAD moves', async () => {
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      expect(await verifyProject('demo', { trigger: 'manual' })).toMatchObject({ skipped: 'disabled', logged: false })
      await withEnv({ BURACLE_NO_AUTOSTART: undefined, BURACLE_NO_VERIFY: undefined }, () => {
        expect(maybeStartVerify({ slug: 'demo', nowMs: Date.now(), trigger: 'session-end' })).toBe(false)
      })
      const id = await claim(repo, 'Order cache entries live five minutes', 'The cache TTL is `ORDER_CACHE_TTL_SECONDS`.')
      const later = Date.now() + 7 * 3600_000
      await refreshUpkeepFor(projectRef('demo'), { nowMs: later })
      appendJob({ job: 'verify', trigger: 'session-end', outcome: 'ran', detail: 'earlier', project: 'demo' }, Date.now() - 30 * 60_000)
      expect(verifiableCount('demo', later)).toBe(1)
      writeVerifyState({ v: 1, backoff: { [id]: { at: new Date(later).toISOString(), key: 'k', head: headShaSync(repo), tries: 1 } } }, later)
      expect(verifiableCount('demo', later + 60_000)).toBe(1)
      writeVerifyState({ v: 1, backoff: { [id]: { at: new Date(later).toISOString(), key: 'k', head: headShaSync(repo), tries: 1, until: new Date(later + 10 * 60_000).toISOString() } } }, later)
      expect(verifiableCount('demo', later + 5 * 60_000)).toBe(0)
      expect(verifiableCount('demo', later + 11 * 60_000)).toBe(1)
      writeFileSync(join(repo, 'src', 'orders.ts'), ORDERS.replace('300', '3600'))
      git(repo, 'commit', '-q', '-am', 'longer ttl')
      expect(verifiableCount('demo', later + 5 * 60_000)).toBe(1)
      expect(readJobs().filter(e => e.job === 'verify' && e.reason === 'interval')).toEqual([])
    })
  })

  test('large evidence is cut to each pack\'s share, so the candidates are still shown (and a prompt with none is never sent)', async () => {
    const big = { file: 'src/a.ts', start: 1, text: Array.from({ length: 400 }, (_, i) => `const line${i} = ${i} // ${'x'.repeat(60)}`).join('\n') }
    const cut = fitExcerpts([big, { file: 'src/b.ts', start: 1, text: 'b' }], 2000)
    expect(cut).toHaveLength(1)
    expect(cut[0]?.text.split('\n').length).toBeGreaterThan(5)
    expect(cut[0]?.text.length).toBeLessThan(2000)
    expect(big.text.startsWith(cut[0]?.text ?? '-')).toBe(true)
    await withBrain(async ({ repo }) => {
      await seedRepo(repo)
      for (const n of ['one', 'two', 'three', 'four', 'five']) writeFileSync(join(repo, 'src', `${n}.ts`), Array.from({ length: 190 }, (_, i) => i === 95 ? 'export const ORDER_CACHE_TTL_SECONDS = 300' : `// filler ${n} ${i} ${'y'.repeat(200)}`).join('\n'))
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'big files')
      const id = (await write(agentCtx(repo), { type: 'gotcha', title: 'The order cache TTL is set in many places', summary: 'TTL', body: 'Look for `ORDER_CACHE_TTL_SECONDS` before changing it.' })).id
      const runner = scripted(() => ({ verdicts: [{ id, verdict: 'holds', checked: 'the constant', quotes: [{ file: 'src/orders.ts', text: 'export const ORDER_CACHE_TTL_SECONDS = 300' }], note: '' }] }))
      const run = await verifyProject('demo', { trigger: 'manual', runner })
      expect(run.checked).toBe(1)
      expect(runner.prompts).toHaveLength(1)
      expect(run.inputChars).toBeLessThanOrEqual(8000 * 4)
    })
  })
})

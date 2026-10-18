import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finalize } from '../../src/memory/finalize'
import { readJobs } from '../../src/memory/jobs'
import { readSessionRecord, sessionStart, writeSessionRecord } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { getStored, projectRef } from '../../src/memory/store'
import { withEnv } from '../helpers/sandbox'
import { git, withBrain } from './helpers'

const SID = '0199a213-81c0-7800-8aa1-bbab2a035a80'

describe('finalize', () => {
  test('a late segment gets a second pass of the session memory, but the tail runs once', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      appendSpool('codex', SID, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: 'Fixed the flaky test.' }])
      const running = finalize('codex', SID, { settleMs: 600 })
      for (let i = 0; i < 200 && readSessionRecord('codex', SID)?.status !== 'ended'; i++) await Bun.sleep(25)
      appendSpool('codex', SID, [{ ts: Date.now() + 2, ev: 'stop', excerpt: 'Also renamed the helper.' }], { suffix: 'late' })
      const r = await running
      expect(r.memoryId).toBeDefined()
      const mem = await getStored(projectRef('demo'), r.memoryId as string)
      expect(mem?.item.history.map(h => h.what)).toEqual(['session ended', 'finalized again'])
      expect(mem?.item.body).toContain('Also renamed the helper.')
      const jobs = readJobs()
      expect(jobs.filter(e => e.job === 'profile')).toHaveLength(1)
      expect(jobs.filter(e => e.job === 'finalize')).toEqual([expect.objectContaining({ outcome: 'ran', project: 'demo', harness: 'codex', sid: SID })])
    })
  })

  test('without CortexDB the finalizer journals the skip and asks the repair', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      await withEnv({ BURACLE_CORTEXDB_BIN: join(repo, 'no-such-cortexdb') }, async () => {
        expect(await finalize('codex', SID)).toEqual({ skipped: 'no-store' })
      })
      expect(readJobs().find(e => e.job === 'finalize')).toMatchObject({ outcome: 'skipped', reason: 'no-store' })
    })
  })

  test('a second finalize with nothing new spooled does nothing (several plugin instances may ask); a new segment finalizes again', async () => {
    await withBrain(async ({ repo }) => {
      await sessionStart('codex', SID, repo)
      appendSpool('codex', SID, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: 'Fixed the flaky test.' }])
      const first = await finalize('codex', SID)
      expect(first.memoryId).toBeDefined()
      const again = await Promise.all([finalize('codex', SID), finalize('codex', SID), finalize('codex', SID)])
      expect(again.map(r => r.skipped)).toEqual(['already-finalized', 'already-finalized', 'already-finalized'])
      expect(again[0]).toMatchObject({ slug: 'demo', memoryId: first.memoryId })
      expect(readJobs().filter(e => e.job === 'profile')).toHaveLength(1)
      expect(readJobs().filter(e => e.job === 'finalize')).toHaveLength(1)
      appendSpool('codex', SID, [{ ts: Date.now() + 2, ev: 'stop', excerpt: 'Resumed and renamed the helper.' }], { suffix: 'resume' })
      const resumed = await finalize('codex', SID)
      expect(resumed.skipped).toBeUndefined()
      expect((await getStored(projectRef('demo'), first.memoryId as string))?.item.body).toContain('Resumed and renamed the helper.')
      expect(readJobs().filter(e => e.job === 'finalize')).toHaveLength(2)
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
})

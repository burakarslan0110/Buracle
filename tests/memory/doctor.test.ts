import { describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureChecks, doctorExitCode, memDoctor, runLeakCheck } from '../../src/memory/doctor'
import { finalize } from '../../src/memory/finalize'
import { sessionStart } from '../../src/memory/session-record'
import { projectRef, saveItem } from '../../src/memory/store'
import { migrationLockFile, sessionRecordsDir, spoolDir } from '../../src/memory/layout'
import { tryLock } from '../../src/memory/lock'
import { appendSpool } from '../../src/memory/spool'
import { withEnv } from '../helpers/sandbox'
import { installLegacyBrain, REAL_CORTEXDB, withBrain } from './helpers'

describe('mem doctor', () => {
  test('a healthy setup passes every check, the leak check included', async () => {
    await withBrain(async ({ repo }) => {
      const checks = await memDoctor({ cwd: repo })
      const by = Object.fromEntries(checks.map(c => [c.check, c]))
      expect(by['cortexdb']?.level).toBe('ok')
      expect(by['project memory']?.detail).toContain('demo')
      expect(by['leak check']).toMatchObject({ level: 'ok' })
      expect(by['mcp']).toMatchObject({ level: 'ok', detail: expect.stringContaining('6 tools') })
      expect(doctorExitCode(checks)).toBe(0)
    })
  }, 60_000)

  test('the doctor names the sessions whose capture is still owed, and says nothing waits otherwise', async () => {
    await withBrain(async ({ repo }) => {
      expect(captureChecks(Date.now())).toEqual([{ level: 'ok', check: 'capture', detail: 'no session waits for its capture' }])
      const sid = '0199a213-81c0-7800-8aa1-bbab2a035a90'
      await sessionStart('codex', sid, repo)
      appendSpool('codex', sid, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: 'Done.' }])
      await finalize('codex', sid, { pending: false, runner: async () => ({ ok: false, text: '', error: 'codex: not logged in' }) })
      const [warn] = captureChecks(Date.now())
      expect(warn).toMatchObject({ level: 'warn', check: 'capture' })
      expect(warn?.detail).toContain('1 session(s) wait for their capture (1 for another model try')
      expect(warn?.detail).toContain('buracle mem capture --pending')
    })
  })

  test('a session whose files were written in the same millisecond as the check still counts as waiting', async () => {
    await withBrain(async ({ repo }) => {
      const sid = '0199a213-81c0-7800-8aa1-bbab2a035a91'
      await sessionStart('codex', sid, repo)
      appendSpool('codex', sid, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: 'Done.' }])
      await finalize('codex', sid, { pending: false, runner: async () => ({ ok: false, text: '', error: 'codex: not logged in' }) })
      // File times carry sub-millisecond digits and Date.now() is cut to whole milliseconds, so a file written a moment
      // before the check can be dated after it: put every file of the session 5 ms ahead.
      const ahead = (Date.now() + 5) / 1000
      for (const dir of [sessionRecordsDir(), spoolDir()]) {
        for (const name of readdirSync(dir)) if (name.includes(sid)) utimesSync(join(dir, name), ahead, ahead)
      }
      const [warn] = captureChecks(Date.now())
      expect(warn).toMatchObject({ level: 'warn', check: 'capture' })
    })
  })

  test('a project bucket without a project record is a warning that names it and the way back', async () => {
    await withBrain(async ({ repo }) => {
      await saveItem(projectRef('ghost'), { id: 'decision-ghost', kind: 'decision', layer: 'project', title: 'A ghost decision', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'pending', importance: 3, created: '2026-10-13T10:00:00Z', updated: '2026-10-13T10:00:00Z', author: 'agent', version: 1, history: [] })
      const checks = await memDoctor({ cwd: repo, mcp: false, leak: false })
      const warn = checks.find(c => c.check === 'brain' && c.level === 'warn')
      expect(warn?.detail).toContain('1 project bucket(s) without a project record')
      expect(warn?.detail).toContain('ghost')
      expect(warn?.detail).toContain('buracle project init')
    })
  })

  test.skipIf(REAL_CORTEXDB)('the doctor reports the migration: pending while another process holds it, complete with what was kept afterwards', async () => {
    await withBrain(async ({ repo }) => {
      installLegacyBrain()
      const holder = tryLock(migrationLockFile(), 60_000)
      try {
        await withEnv({ BURACLE_MIGRATE_WAIT_MS: '100' }, async () => {
          const checks = await memDoctor({ cwd: repo, mcp: false, leak: false })
          const m = checks.find(c => c.check === 'migration')
          expect(m).toMatchObject({ level: 'warn' })
          expect(m?.detail).toContain('person.db')
          expect(m?.detail).toContain('buracle mem migrate')
          expect(checks.find(c => c.level === 'error')?.detail).toContain('migrated')
          expect(doctorExitCode(checks)).toBe(1)
        })
      } finally {
        holder?.()
      }
      const done = await memDoctor({ cwd: repo, mcp: false, leak: false })
      const ms = done.filter(c => c.check === 'migration')
      expect(ms[0]).toMatchObject({ level: 'ok' })
      expect(ms[0]?.detail).toContain('complete')
      expect(ms[1]).toMatchObject({ level: 'info' })
      expect(ms[1]?.detail).toContain('--purge-legacy')
      expect(done.find(c => c.check === 'buckets')?.detail).toContain('person 5, demo 6')
      expect(doctorExitCode(done)).toBe(0)
    })
  })

  test.skipIf(REAL_CORTEXDB)('CortexDB\'s own self-test of the brain file is part of the report, and its failure is an error', async () => {
    await withBrain(async ({ repo }) => {
      await saveItem(projectRef('demo'), { id: 'decision-a', kind: 'decision', layer: 'project', title: 'A', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'pending', importance: 3, created: '2026-10-13T10:00:00Z', updated: '2026-10-13T10:00:00Z', author: 'agent', version: 1, history: [] })
      const ok = await memDoctor({ cwd: repo, mcp: false, leak: false })
      expect(ok.find(c => c.check === 'brain file')).toMatchObject({ level: 'ok' })
      await withEnv({ FAKE_CORTEXDB_DOCTOR: 'fail' }, async () => {
        const bad = await memDoctor({ cwd: repo, mcp: false, leak: false })
        expect(bad.find(c => c.check === 'brain file')).toMatchObject({ level: 'error' })
        expect(bad.find(c => c.check === 'brain file')?.detail).toContain('injected failure')
      })
    })
  })

  test('without CortexDB it is an error with the install command', async () => {
    await withBrain(async ({ repo, root }) => {
      await withEnv({ BURACLE_CORTEXDB_BIN: join(root, 'missing') }, async () => {
        const checks = await memDoctor({ cwd: repo, mcp: false })
        expect(checks.find(c => c.check === 'cortexdb')?.level).toBe('error')
        expect(doctorExitCode(checks)).toBe(1)
      })
    })
  })

  test('an old vault that was not imported yet is a warning; an imported one is information', async () => {
    await withBrain(async ({ home, repo }) => {
      mkdirSync(join(home, 'Documents', 'Buracle', 'projects', 'demo', 'decisions'), { recursive: true })
      writeFileSync(join(home, 'Documents', 'Buracle', 'projects', 'demo', 'decisions', 'x.md'), '---\ntitle: X\n---\nx\n')
      let vault = (await memDoctor({ cwd: repo, mcp: false, leak: false })).find(c => c.check === 'old vault')
      expect(vault?.level).toBe('warn')
      const { importVault } = await import('../../src/memory/import-vault')
      await importVault()
      vault = (await memDoctor({ cwd: repo, mcp: false, leak: false })).find(c => c.check === 'old vault')
      expect(vault?.level).toBe('info')
    })
  }, 60_000)

  test('the leak check proves itself: project A finds its canary, project B does not', async () => {
    const r = await runLeakCheck()
    expect(r).toEqual({ ok: true, detail: expect.stringContaining('did not reach project B') })
  }, 60_000)
})

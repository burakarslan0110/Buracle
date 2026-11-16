import { describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeAllCortex } from '../../src/memory/cortex'
import { captureChecks, doctorExitCode, memDoctor, runLeakCheck } from '../../src/memory/doctor'
import { finalize } from '../../src/memory/finalize'
import { projectsFile } from '../../src/memory/layout'
import { resolveProject } from '../../src/memory/project'
import { sessionStart } from '../../src/memory/session-record'
import { projectRef, saveItem } from '../../src/memory/store'
import { sessionRecordsDir, spoolDir } from '../../src/memory/layout'
import { appendSpool } from '../../src/memory/spool'
import { withEnv } from '../helpers/sandbox'
import { REAL_CORTEXDB, withBrain } from './helpers'

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

  test('the doctor reports an unreadable projects cache and the backup it kept (PRD R14)', async () => {
    await withBrain(async ({ repo }) => {
      mkdirSync(join(projectsFile(), '..'), { recursive: true })
      writeFileSync(projectsFile(), '{ nope')
      const checks = await memDoctor({ cwd: repo, mcp: false, leak: false })
      const c = checks.find(x => x.check === 'projects cache')
      expect(c?.level).toBe('warn')
      expect(c?.detail).toContain('backup')
      // After the rebuild the report becomes information that names the kept backup.
      await resolveProject(repo)
      const after = await memDoctor({ cwd: repo, mcp: false, leak: false })
      const info = after.find(x => x.check === 'projects cache')
      expect(info?.level).toBe('info')
      expect(info?.detail).toContain('corrupt-')
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

  test.skipIf(REAL_CORTEXDB)('CortexDB\'s own self-test of the brain file is part of the report: a failed self-test is an error that names the restore', async () => {
    await withBrain(async ({ repo }) => {
      await saveItem(projectRef('demo'), { id: 'decision-a', kind: 'decision', layer: 'project', title: 'A', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'pending', importance: 3, created: '2026-10-13T10:00:00Z', updated: '2026-10-13T10:00:00Z', author: 'agent', version: 1, history: [] })
      const ok = await memDoctor({ cwd: repo, mcp: false, leak: false })
      expect(ok.find(c => c.check === 'brain file')).toMatchObject({ level: 'ok' })
      await withEnv({ FAKE_CORTEXDB_DOCTOR: 'self-test' }, async () => {
        const bad = (await memDoctor({ cwd: repo, mcp: false, leak: false })).find(c => c.check === 'brain file')
        expect(bad).toMatchObject({ level: 'error' })
        expect(bad?.detail).toContain('injected failure')
        expect(bad?.detail).toContain('restore a backup')
      })
    })
  })

  test.skipIf(REAL_CORTEXDB)('a failed status with a passing self-test, on a brain that answers, is a warning that names no restore (a restore drops the newer memories)', async () => {
    await withBrain(async ({ repo }) => {
      await saveItem(projectRef('demo'), { id: 'decision-a', kind: 'decision', layer: 'project', title: 'A', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'pending', importance: 3, created: '2026-10-13T10:00:00Z', updated: '2026-10-13T10:00:00Z', author: 'agent', version: 1, history: [] })
      await withEnv({ FAKE_CORTEXDB_DOCTOR: 'fail' }, async () => {
        const checks = await memDoctor({ cwd: repo, mcp: false, leak: false })
        const file = checks.find(c => c.check === 'brain file')
        expect(file).toMatchObject({ level: 'warn' })
        expect(file?.detail).toContain('injected failure')
        expect(file?.detail).not.toContain('restore')
        expect(checks.find(c => c.check === 'project memory')).toMatchObject({ level: 'ok' })
      })
    })
  })

  test.skipIf(REAL_CORTEXDB)('a brain that does not answer keeps the error and the restore, also when the self-test passed', async () => {
    await withBrain(async ({ repo }) => {
      await saveItem(projectRef('demo'), { id: 'decision-a', kind: 'decision', layer: 'project', title: 'A', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'pending', importance: 3, created: '2026-10-13T10:00:00Z', updated: '2026-10-13T10:00:00Z', author: 'agent', version: 1, history: [] })
      await withEnv({ FAKE_CORTEXDB_DOCTOR: 'fail', FAKE_CORTEXDB_FAIL: 'memory_list_all' }, async () => {
        // The running CortexDB child started without the failure; the next one starts with it.
        await closeAllCortex()
        const checks = await memDoctor({ cwd: repo, mcp: false, leak: false })
        expect(checks.filter(c => c.check === 'brain').map(c => c.level)).toContain('error')
        const file = checks.find(c => c.check === 'brain file')
        expect(file).toMatchObject({ level: 'error' })
        expect(file?.detail).toContain('restore a backup')
        expect(file?.detail).not.toContain('self-test failed')
      })
    })
  })

  test.skipIf(REAL_CORTEXDB)('a CortexDB below the minimum is an error that names both versions and the install', async () => {
    await withBrain(async ({ repo, root }) => {
      const old = join(root, 'old-cortexdb.ts')
      writeFileSync(old, `process.env.FAKE_CORTEXDB_VERSION = '2.130.1'\nawait import(${JSON.stringify(join(import.meta.dir, '..', 'fixtures', 'cortexdb', 'fake-cortexdb.ts'))})\n`)
      await withEnv({ BURACLE_CORTEXDB_BIN: old }, async () => {
        const checks = await memDoctor({ cwd: repo, mcp: false, leak: false })
        const found = checks.find(c => c.check === 'cortexdb')
        expect(found?.level).toBe('error')
        expect(found?.detail).toBe(`${old}: it is CortexDB 2.130.1, older than the 2.137.0 Buracle Stack needs (buracle install takes the newest release)`)
        expect(doctorExitCode(checks)).toBe(1)
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

  test('the leak check proves itself: project A finds its canary, project B does not', async () => {
    const r = await runLeakCheck()
    expect(r).toEqual({ ok: true, detail: expect.stringContaining('did not reach project B') })
  }, 60_000)
})

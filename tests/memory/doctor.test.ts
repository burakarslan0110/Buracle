import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureChecks, doctorExitCode, memDoctor, runLeakCheck } from '../../src/memory/doctor'
import { finalize } from '../../src/memory/finalize'
import { sessionStart } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { brainProjectsDir } from '../../src/memory/layout'
import { withEnv } from '../helpers/sandbox'
import { withBrain } from './helpers'

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

  test('a brain file without a project record is a warning that names it and the way back', async () => {
    await withBrain(async ({ repo }) => {
      mkdirSync(brainProjectsDir(), { recursive: true })
      writeFileSync(join(brainProjectsDir(), 'ghost.db'), '')
      const checks = await memDoctor({ cwd: repo, mcp: false, leak: false })
      const warn = checks.find(c => c.check === 'brain' && c.level === 'warn')
      expect(warn?.detail).toContain('1 brain file(s) without a project record')
      expect(warn?.detail).toContain('ghost.db')
      expect(warn?.detail).toContain('buracle project init')
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
  })

  test('the leak check proves itself: project A finds its canary, project B does not', async () => {
    const r = await runLeakCheck()
    expect(r).toEqual({ ok: true, detail: expect.stringContaining('did not reach project B') })
  }, 60_000)
})

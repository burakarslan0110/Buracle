import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as installRun } from '../../../src/cli/commands/install'
import { run as rollbackRun } from '../../../src/cli/commands/rollback'
import { applyPlans, listTxns, RETENTION } from '../../../src/engine/txn'
import { projectInit } from '../../../src/memory/project-init'
import { makeRepo as makeProject } from '../../memory/helpers'
import { withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, withDeps } from './helpers'

describe('rollback and background transactions', () => {
  test('without an id it undoes the newest install run, not a newer removal of an old memory redirect', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: join(home, '.codex/a.txt'), content: 'v1\n', owner: 'codex' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect(existsSync(join(home, '.codex/a.txt'))).toBe(true)
      const project = makeProject(join(root, 'project'))
      const settings = join(project, '.claude', 'settings.local.json')
      await applyPlans([{ id: 'memory-project-demo', harness: 'claude', ops: [{ kind: 'json-merge', path: settings, set: { autoMemoryDirectory: join(home, 'Documents', 'Buracle', 'projects', 'demo', 'claude') }, owner: 'memory' }] }])
      expect((await projectInit(project)).claudeRedirect).toBe('removed')
      const newest = (await listTxns())[0]
      expect(newest?.plans.map(p => p.id)).toEqual(['memory-project-redirect-off-0'])

      const io = memoryIO()
      expect(await rollbackRun([], io)).toBe(0)
      expect(existsSync(join(home, '.codex/a.txt'))).toBe(false)
      const left = existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown> : {}
      expect(left['autoMemoryDirectory']).toBeUndefined()
      expect(io.out()).not.toContain(newest?.txn as string)

      const list = memoryIO()
      expect(await rollbackRun(['--list'], list)).toBe(0)
      expect(list.out()).toMatch(new RegExp(`${newest?.txn}.*memory-project-redirect-off-0\\s+hook`))
    })
  }), 60_000)

  test('memory redirects have their own backup budget: many of them never prune an install\'s backups', () => withSandbox(async ({ home }) => {
    const file = join(home, '.codex', 'a.txt')
    await applyPlans([{ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: file, content: 'v1\n', owner: 'codex' }] }], { run: 'r1' })
    for (let i = 0; i < RETENTION.backups + 3; i++) {
      await applyPlans([{ id: `memory-project-p${i}`, harness: 'claude', ops: [{ kind: 'json-merge', path: join(home, `p${i}`, '.claude', 'settings.local.json'), set: { autoMemoryDirectory: `/v/${i}` }, owner: 'memory' }] }])
    }
    const install = (await listTxns()).find(j => j.run === 'r1')
    expect(install?.backupsPruned).toBeUndefined()
    const io = memoryIO()
    expect(await rollbackRun([], io)).toBe(0)
    expect(existsSync(file)).toBe(false)
    const background = (await listTxns()).filter(j => j.plans.every(p => p.id.startsWith('memory-project-')))
    expect(background.some(j => j.backupsPruned === true)).toBe(true)
  }), 60_000)
})

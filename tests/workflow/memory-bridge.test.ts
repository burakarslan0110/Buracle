import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyPlans } from '../../src/engine/txn'
import { listAll, projectRef } from '../../src/memory/store'
import { notify } from '../../src/workflow/notify'
import { planRegister } from '../../src/workflow/plan'
import { projectSync } from '../../src/workflow/project'
import { resetMemoryBridgeCache } from '../../src/workflow/memory-bridge'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { SESSION, ctxAt, g, makeRepo, planDoc, write } from './fixture'

function withMemory(fn: (o: { root: string, home: string }) => Promise<void>): Promise<void> {
  return withSandbox(({ root, home }) => {
    resetMemoryBridgeCache()
    return withEnv({ BURACLE_NO_MEMORY: undefined }, () => fn({ root, home }))
  })
}

const settingsOf = (repo: string) => join(repo, '.claude', 'settings.local.json')

describe('project memory setup', () => {
  test('project init creates the core pages in the project\'s own brain; Claude Code settings stay untouched', () => withMemory(async ({ root }) => {
    const repo = await makeRepo(root)
    write(join(repo, 'AGENTS.md'), '# Demo\n')
    const r = await projectSync('init', ctxAt(repo), undefined)
    expect(r.code).toBe(0)
    const memory = r.data['memory'] as { status: string, path: string, detail: string[] }
    expect(memory.status).toBe('ok')
    expect(memory.path.endsWith(join('brain', 'projects', 'repo.db'))).toBe(true)
    expect(memory.detail[0]).toStartWith('project repo')
    const core = (await listAll(projectRef('repo'))).filter(i => i.kind === 'core').map(i => i.id).sort()
    expect(core).toEqual(['core-architecture', 'core-brief', 'core-commands', 'core-conventions', 'core-glossary', 'core-progress'])
    expect(existsSync(settingsOf(repo))).toBe(false)
    const again = await projectSync('sync', ctxAt(repo), undefined)
    expect(again.code).toBe(0)
    expect((await listAll(projectRef('repo'))).filter(i => i.kind === 'core').length).toBe(6)
  }), 30_000)

  test('the redirect an older Buracle wrote is taken back; a value the user set is not touched', () => withMemory(async ({ root }) => {
    const repo = await makeRepo(root)
    write(join(repo, 'AGENTS.md'), '# Demo\n')
    await applyPlans([{ id: 'memory-project-repo', harness: 'claude', ops: [{ kind: 'json-merge', path: settingsOf(repo), set: { autoMemoryDirectory: join(root, 'vault', 'projects', 'repo', 'claude') }, owner: 'memory' }] }])
    const r = await projectSync('sync', ctxAt(repo), undefined)
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect((r.data['memory'] as { detail: string[] }).detail).toContain('the old Claude Code memory redirect was taken back')
    const left = existsSync(settingsOf(repo)) ? JSON.parse(readFileSync(settingsOf(repo), 'utf8')) as Record<string, unknown> : {}
    expect(left['autoMemoryDirectory']).toBeUndefined()

    const other = await makeRepo(root, 'other')
    write(join(other, 'AGENTS.md'), '# Other\n')
    write(settingsOf(other), JSON.stringify({ autoMemoryDirectory: join(root, 'elsewhere') }, null, 2) + '\n')
    const mine = await projectSync('sync', ctxAt(other), undefined)
    expect(mine.errors).toEqual([])
    expect(mine.code).toBe(0)
    expect(JSON.parse(readFileSync(settingsOf(other), 'utf8'))).toEqual({ autoMemoryDirectory: join(root, 'elsewhere') })
  }), 30_000)

  test('a tracked settings file is left byte-identical and the repo stays clean', () => withMemory(async ({ root }) => {
    const repo = await makeRepo(root)
    write(join(repo, 'AGENTS.md'), '# Demo\n')
    const original = '{\n  "permissions": {}\n}\n'
    write(settingsOf(repo), original)
    await g(repo, 'add', '-A')
    await g(repo, 'commit', '-q', '-m', 'track local settings')
    for (const mode of ['init', 'sync'] as const) {
      const r = await projectSync(mode, ctxAt(repo), undefined)
      expect(r.code).toBe(0)
      expect(readFileSync(settingsOf(repo), 'utf8')).toBe(original)
      expect(await g(repo, 'status', '--porcelain')).toBe('')
    }
  }), 30_000)
})

describe('plans and notifications are not memory', () => {
  test('plan register and attention_needed write nothing into the brain', () => withMemory(async ({ root }) => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(plan, planDoc())
    const r = await planRegister(plan, undefined, ctxAt(repo), SESSION)
    expect(r.code).toBe(0)
    expect(r.data['card']).toBeUndefined()
    const n = await notify('attention_needed', 'Decision needed', 'Redis or LRU?', { plan: 'docs/plans/x.md' }, ctxAt(repo), SESSION)
    expect(n.code).toBe(0)
    expect(Object.keys(n.data['delivery'] as object)).toEqual(['macos'])
    expect(await listAll(projectRef('repo'))).toEqual([])
  }))
})

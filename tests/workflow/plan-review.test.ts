import { describe, expect, test } from 'bun:test'
import { readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPlan } from '../../src/cli/commands/plan'
import { userConfigFile } from '../../src/engine/paths'
import { planRegister, planSet } from '../../src/workflow/plan'
import { loadState, saveState } from '../../src/workflow/session-store'
import type { SessionState } from '../../src/core/plan/state'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { SESSION, ctxAt, evidenceSections, g, makeRepo, memIO, planDoc, write } from './fixture'

const S = SESSION
const AS = ['--session', S.sessionId, '--harness', S.harness]

function sandbox(fn: (root: string) => Promise<void>): Promise<void> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

async function plan(repo: string, args: string[]): Promise<{ code: number, out: string, err: string, json: () => Record<string, unknown> }> {
  const io = memIO(args.includes('--json'))
  const code = await runPlan([...args, ...AS], io, ctxAt(repo))
  return { code, out: io.out(), err: io.err(), json: () => io.json() }
}

describe('buracle plan review: durable reviewer records', () => {
  test('start records the handle, done anchors the plan text; a body edit after it makes the approval warn, ticks and the header do not', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const file = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(file, planDoc())
    await planRegister(file, 'plan', ctxAt(repo), S)
    expect((await plan(repo, ['review', 'start', '--role', 'plan', '--handle', 'agent-7f3', '--provider', 'claude'])).code).toBe(0)
    expect(loadState('claude', S.sessionId).reviews).toEqual([{ role: 'plan', plan: file, state: 'running', startedAt: ctxAt(repo).now, handle: 'agent-7f3', provider: 'claude' }])
    const status = await plan(repo, ['status', '--json'])
    expect(status.json()['reviews']).toEqual([{ role: 'plan', agent: 'plan-build-review', state: 'running', startedAt: ctxAt(repo).now, handle: 'agent-7f3', provider: 'claude' }])
    expect((await plan(repo, ['review', 'done', '--role', 'plan', '--verdict', 'needs_changes'])).code).toBe(0)
    expect(loadState('claude', S.sessionId).reviews?.[0]).toMatchObject({ state: 'collected', verdict: 'needs_changes', handle: 'agent-7f3', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })

    writeFileSync(file, readFileSync(file, 'utf8').replace('- [ ] Task 1 done', '- [x] Task 1 done').replace('iterations: 0', 'iterations: 1'))
    const fresh = await plan(repo, ['review', 'status', '--json'])
    expect(fresh.json()['reviews']).toEqual([expect.objectContaining({ role: 'plan', freshness: 'fresh' })])
    writeFileSync(file, readFileSync(file, 'utf8').replace('- [x] Task 1 done', '- [ ] Task 1 done').replace('## Risks', '## Risks\n- A new risk the reviewer never saw.'))
    const approve = await planSet('approved', 'true', ctxAt(repo), S)
    expect(approve.code).toBe(0)
    expect(approve.errors).toEqual([expect.stringContaining('the plan changed after plan-build-review was collected')])
    expect(approve.errors[0]).toContain("'buracle plan review done --role plan --verdict <verdict>'")
  }))

  test('a missing plan review warns at the approval while plan.reviews.plan is on, and not when it is off', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const file = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(file, planDoc())
    await planRegister(file, 'plan', ctxAt(repo), S)
    expect((await planSet('approved', 'true', ctxAt(repo), S)).errors).toEqual([expect.stringContaining('no collected plan-build-review is recorded for this plan')])
    write(file, planDoc())
    await planRegister(file, 'plan', ctxAt(repo), S)
    write(userConfigFile(), 'version: 1\nplan:\n  reviews:\n    plan: false\n')
    expect((await planSet('approved', 'true', ctxAt(repo), S)).errors).toEqual([])
  }))

  test('changes: the anchor covers the reviewed files, survives a commit, and turns stale on a later edit or a newly changed file', () => sandbox(async root => {
    const repo = await makeRepo(root)
    await g(repo, 'checkout', '-q', '-b', 'feature')
    const file = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(file, [planDoc({ status: 'COMPLETE', approved: true, n: 1, done: 1 }), ...evidenceSections()].join('\n'))
    write(join(repo, 'src', 'app.ts'), 'export const a = 2\n')
    write(join(repo, 'src', 'limit.ts'), 'export const limit = 100\n')
    await planRegister(file, 'verify', ctxAt(repo), S)
    const done = await plan(repo, ['review', 'done', '--role', 'changes', '--verdict', 'pass', '--json'])
    expect(done.code).toBe(0)
    const rec = loadState('claude', S.sessionId).reviews?.[0]
    expect(rec?.files).toEqual(['src/app.ts', 'src/limit.ts'])

    await g(repo, 'add', '-A')
    await g(repo, 'commit', '-q', '-m', 'work')
    const committed = await plan(repo, ['review', 'status', '--json'])
    expect(committed.json()['reviews']).toEqual([expect.objectContaining({ role: 'changes', freshness: 'fresh' })])

    write(join(repo, 'src', 'other.ts'), 'export const o = 1\n')
    const added = await plan(repo, ['approve-result'])
    expect(added.err).toContain('the code changed after changes-review was collected (files changed since the review that it did not see: src/other.ts)')

    rmSync(join(repo, 'src', 'other.ts'))
    write(join(repo, 'src', 'limit.ts'), 'export const limit = 50\n')
    const edited = await plan(repo, ['verify'])
    expect(edited.code).toBe(0)
    expect(edited.err).toContain('a reviewed file changed after the review was collected')
  }))

  test('changes: a plan registered through a symlinked repo path stays out of the reviewed files', () => sandbox(async root => {
    const repo = await makeRepo(root)
    await g(repo, 'checkout', '-q', '-b', 'feature')
    const link = join(root, 'linked')
    symlinkSync(repo, link)
    const file = join(link, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(file, [planDoc({ status: 'COMPLETE', approved: true, n: 1, done: 1 }), ...evidenceSections()].join('\n'))
    write(join(repo, 'src', 'app.ts'), 'export const a = 2\n')
    await planRegister(file, 'verify', ctxAt(link), S)
    expect((await plan(link, ['review', 'done', '--role', 'changes', '--verdict', 'pass'])).code).toBe(0)
    expect(loadState('claude', S.sessionId).reviews?.[0]?.files).toEqual(['src/app.ts'])
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n## DoD Audit\n- Task 1: met.\n`)
    const result = await plan(link, ['approve-result'])
    expect(result.err).not.toContain('changes-review')
  }))

  test('verify warns about a missing changes review for a Feature only while plan.reviews.changes is on; a Bugfix always needs one', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const file = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(userConfigFile(), 'version: 1\nplan:\n  resultApproval: false\n  reviews:\n    changes: false\n')
    write(file, planDoc({ status: 'COMPLETE', approved: true, n: 1, done: 1, evidence: true }))
    await planRegister(file, 'verify', ctxAt(repo), S)
    const feature = await plan(repo, ['verify'])
    expect(feature.code).toBe(0)
    expect(feature.err).not.toContain('changes-review')
    const bug = join(repo, 'docs', 'plans', '2026-10-09-fix.md')
    write(bug, planDoc({ type: 'Bugfix', status: 'COMPLETE', approved: true, n: 1, done: 1, evidence: true }))
    await planRegister(bug, 'verify', ctxAt(repo), S)
    const bugfix = await plan(repo, ['verify'])
    expect(bugfix.code).toBe(0)
    expect(bugfix.err).toContain('no collected changes-review is recorded for this plan')
  }))

  test('the records belong to one plan: registering another plan or unregistering drops them; usage errors exit 1', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const a = join(repo, 'docs', 'plans', '2026-10-08-a.md')
    const b = join(repo, 'docs', 'plans', '2026-10-08-b.md')
    write(a, planDoc())
    write(b, planDoc())
    await planRegister(a, 'plan', ctxAt(repo), S)
    await plan(repo, ['review', 'start', '--role', 'plan'])
    await planRegister(a, 'plan', ctxAt(repo), S)
    expect(loadState('claude', S.sessionId).reviews).toHaveLength(1)
    await planRegister(b, 'plan', ctxAt(repo), S)
    expect(loadState('claude', S.sessionId).reviews).toBeUndefined()
    await plan(repo, ['review', 'start', '--role', 'goal'])
    expect((await plan(repo, ['unregister'])).code).toBe(0)
    expect(loadState('claude', S.sessionId).reviews).toBeUndefined()
    await planRegister(a, 'plan', ctxAt(repo), S)
    expect((await plan(repo, ['review', 'start', '--role', 'security'])).code).toBe(1)
    expect((await plan(repo, ['review', 'done', '--role', 'plan', '--verdict', 'ok'])).code).toBe(1)
    expect((await plan(repo, ['review', 'launch'])).code).toBe(1)
    expect((await plan(repo, ['review'])).code).toBe(1)
  }))
})

describe('buracle plan: state of an older Buracle that carries plan-lane fields', () => {
  test('a state file with laneReviews and a worktree record with lane fields still load; the fields are ignored', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const lead = join(repo, 'docs', 'plans', '2026-10-08-lead.md')
    write(lead, planDoc())
    await planRegister(lead, 'plan', ctxAt(repo), S)
    const old = { ...loadState('claude', S.sessionId), laneReviews: [{ lane: 'billing', role: 'changes', startedAt: 7, handle: 'agent-b2' }] }
    saveState('claude', S.sessionId, old as unknown as SessionState)
    expect(loadState('claude', S.sessionId).plan?.path).toBe(lead)
    const status = await plan(repo, ['status', '--json'])
    expect(status.code).toBe(0)
    expect(status.json()['plan']).toMatchObject({ path: lead })
    expect(status.json()['lanes']).toBeUndefined()
    expect(status.out).not.toContain('Lane billing')
    expect((await plan(repo, ['review', 'start', '--role', 'plan'])).code).toBe(0)
    expect((await plan(repo, ['unregister'])).code).toBe(0)

    const { runWorktree } = await import('../../src/cli/commands/worktree')
    const io = memIO(true)
    expect(await runWorktree(['create', 'billing'], io, ctxAt(repo))).toBe(0)
    const meta = join(realpathSync(join(repo, '.git')), 'buracle', 'worktrees', 'billing.json')
    write(meta, JSON.stringify({ ...(JSON.parse(readFileSync(meta, 'utf8')) as object), lane: true, parent: 'main', owner: { harness: S.harness, session: S.sessionId }, synced: { at: 1 } }))
    const list = memIO(true)
    expect(await runWorktree(['status'], list, ctxAt(repo))).toBe(0)
    expect((list.json()['worktrees'] as Array<Record<string, unknown>>).map(w => w['slug'])).toEqual(['billing'])
    expect((list.json()['worktrees'] as Array<Record<string, unknown>>)[0]?.['lane']).toBeUndefined()
  }))

  test('--lane is no longer a plan flag', () => sandbox(async root => {
    const repo = await makeRepo(root)
    expect((await plan(repo, ['status', '--lane', 'billing'])).code).toBe(1)
  }))
})

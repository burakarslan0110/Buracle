import { describe, expect, test } from 'bun:test'
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPlan } from '../../src/cli/commands/plan'
import { userConfigFile } from '../../src/engine/paths'
import { planRegister, planSet } from '../../src/workflow/plan'
import { loadState } from '../../src/workflow/session-store'
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

describe('buracle plan --lane: a whole workflow in a lane worktree keeps its own binding', () => {
  test('the lead creates the lane worktree; the lane registers with --lane; the lead\'s binding is untouched and its status lists the lane', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const lead = join(repo, 'docs', 'plans', '2026-10-08-lead.md')
    write(lead, planDoc({ status: 'IN_PROGRESS', approved: true }))
    await planRegister(lead, undefined, ctxAt(repo), S)
    const io = memIO(true)
    const { runWorktree } = await import('../../src/cli/commands/worktree')
    expect(await runWorktree(['create', 'billing', '--lane', ...AS], io, ctxAt(repo))).toBe(0)
    const lanePath = String(io.json()['path'])
    const lanePlan = join(lanePath, 'docs', 'plans', '2026-10-08-billing.md')
    write(lanePlan, planDoc({ title: 'Billing export' }))

    const child = memIO(true)
    const childEnv = { BURACLE_NO_NOTIFY: '1', BURACLE_NO_MEMORY: '1', BURACLE_SESSION_ID: 'child-session-9', BURACLE_HARNESS: 'opencode' }
    expect(await runPlan(['register', lanePlan, '--phase', 'plan', '--lane', 'billing', '--json'], child, ctxAt(lanePath, undefined, childEnv))).toBe(0)
    expect(child.json()['session']).toEqual({ harness: 'claude', id: `${S.sessionId}.lane-billing`, source: '--lane billing' })
    expect(loadState('claude', S.sessionId).plan?.path).toBe(lead)
    expect(loadState('claude', `${S.sessionId}.lane-billing`).plan).toMatchObject({ path: lanePlan, status: 'PENDING', phase: 'plan' })

    expect(await runPlan(['pause', '--kind', 'decision', '--reason', 'plan approval', '--lane', 'billing'], memIO(), ctxAt(lanePath, undefined, childEnv))).toBe(0)
    const status = await plan(repo, ['status', '--json'])
    expect(status.json()['plan']).toMatchObject({ path: lead })
    expect(status.json()['lanes']).toEqual([{ lane: 'billing', session: `${S.sessionId}.lane-billing`, plan: lanePlan, type: 'Feature', status: 'PENDING', phase: 'plan', interaction: 'paused (decision): plan approval' }])
    const text = memIO()
    await runPlan(['status', ...AS], text, ctxAt(repo))
    expect(text.out()).toContain(`Lane billing: ${lanePlan} (Feature, PENDING, phase plan; paused (decision): plan approval)`)

    expect((await plan(repo, ['review', 'start', '--role', 'plan', '--handle', 'agent-l1', '--lane', 'billing'])).code).toBe(0)
    expect(loadState('claude', S.sessionId).laneReviews).toEqual([{ lane: 'billing', role: 'plan', startedAt: ctxAt(repo).now, handle: 'agent-l1' }])
    expect(loadState('claude', `${S.sessionId}.lane-billing`).reviews).toEqual([expect.objectContaining({ role: 'plan', state: 'running', handle: 'agent-l1' })])
    expect((await plan(repo, ['review', 'done', '--role', 'plan', '--verdict', 'pass', '--lane', 'billing'])).code).toBe(0)
    expect(loadState('claude', S.sessionId).laneReviews).toBeUndefined()
    await plan(repo, ['review', 'start', '--role', 'changes', '--lane', 'billing'])
    expect(loadState('claude', S.sessionId).laneReviews).toHaveLength(1)

    expect((await plan(repo, ['set', 'approved', 'true', '--lane', 'billing'])).code).toBe(0)
    expect(loadState('claude', `${S.sessionId}.lane-billing`).interaction?.state).toBe('running')
    expect(loadState('claude', S.sessionId).plan).toMatchObject({ path: lead, status: 'IN_PROGRESS' })
    expect(loadState('claude', S.sessionId).interaction).toBeUndefined()
    const laneStatus = await plan(repo, ['status', '--lane', 'billing', '--json'])
    expect(laneStatus.json()['plan']).toMatchObject({ path: lanePlan, approved: true })
    expect(loadState('claude', S.sessionId).laneReviews).toHaveLength(1)
    expect((await plan(repo, ['unregister', '--lane', 'billing'])).code).toBe(0)
    expect(loadState('claude', S.sessionId).laneReviews).toBeUndefined()
    expect(loadState('claude', S.sessionId).plan?.path).toBe(lead)
  }))

  test('the finish sequence of a lane whose plan file stays in the lead\'s checkout: sync, verify --lane, cleanup; a plan file inside the lane worktree stops the sync', () => sandbox(async root => {
    const repo = await makeRepo(root)
    write(userConfigFile(), 'version: 1\nplan:\n  resultApproval: false\n')
    const { runWorktree } = await import('../../src/cli/commands/worktree')
    const created = memIO(true)
    expect(await runWorktree(['create', 'billing', '--lane', ...AS], created, ctxAt(repo))).toBe(0)
    const lanePath = String(created.json()['path'])
    const inside = join(lanePath, 'docs', 'plans', '2026-10-08-billing.md')
    write(inside, planDoc({ title: 'Billing export' }))
    write(join(lanePath, 'src', 'billing.ts'), 'export const b = 1\n')
    await g(lanePath, 'add', 'src')
    await g(lanePath, 'commit', '-q', '-m', 'billing')
    const refused = memIO(true)
    expect(await runWorktree(['sync', 'billing', ...AS], refused, ctxAt(repo))).toBe(1)
    expect(refused.err() + refused.out()).toContain('uncommitted change(s)')
    rmSync(inside)

    const lanePlan = join(repo, 'docs', 'plans', '2026-10-08-billing.md')
    write(lanePlan, planDoc({ title: 'Billing export', status: 'COMPLETE', approved: true, done: 2, evidence: true }))
    expect(await runPlan(['register', lanePlan, '--phase', 'verify', '--lane', 'billing'], memIO(), ctxAt(lanePath, undefined, { BURACLE_SESSION_ID: 'child-session-9', BURACLE_HARNESS: 'opencode' }))).toBe(0)
    const synced = memIO(true)
    expect(await runWorktree(['sync', 'billing', ...AS], synced, ctxAt(repo))).toBe(0)
    expect(readFileSync(join(repo, 'src', 'billing.ts'), 'utf8')).toBe('export const b = 1\n')
    expect((await plan(repo, ['verify', '--lane', 'billing'])).code).toBe(0)
    expect(readFileSync(lanePlan, 'utf8')).toContain('status: VERIFIED')
    const cleaned = memIO(true)
    expect(await runWorktree(['cleanup', 'billing'], cleaned, ctxAt(repo))).toBe(0)
    expect(cleaned.json()['ok']).toBe(true)
  }), 60_000)

  test('cleaning up a lane worktree ends the lane\'s binding and the lead\'s record of its reviewer; unregister --lane still clears a lane whose worktree is gone', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const { runWorktree } = await import('../../src/cli/commands/worktree')
    expect(await runWorktree(['create', 'billing', '--lane', ...AS], memIO(), ctxAt(repo))).toBe(0)
    const lanePlan = join(repo, 'docs', 'plans', '2026-10-08-billing.md')
    write(lanePlan, planDoc({ title: 'Billing export' }))
    expect((await plan(repo, ['register', lanePlan, '--phase', 'plan', '--lane', 'billing'])).code).toBe(0)
    expect((await plan(repo, ['review', 'start', '--role', 'plan', '--handle', 'h1', '--lane', 'billing'])).code).toBe(0)
    expect(await runWorktree(['cleanup', 'billing'], memIO(), ctxAt(repo))).toBe(0)
    expect(loadState('claude', S.sessionId).laneReviews).toBeUndefined()
    expect(loadState('claude', `${S.sessionId}.lane-billing`).plan).toBeUndefined()
    expect((await plan(repo, ['status', '--json'])).json()['lanes']).toBeUndefined()

    expect(await runWorktree(['create', 'export', '--lane'], memIO(), ctxAt(repo))).toBe(0)
    expect((await plan(repo, ['register', lanePlan, '--phase', 'plan', '--lane', 'export'])).code).toBe(0)
    expect((await plan(repo, ['review', 'start', '--role', 'plan', '--lane', 'export'])).code).toBe(0)
    expect(await runWorktree(['cleanup', 'export'], memIO(), ctxAt(repo))).toBe(0)
    expect((await plan(repo, ['status', '--json'])).json()['lanes']).toEqual([expect.objectContaining({ lane: 'export' })])
    expect((await plan(repo, ['status', '--lane', 'export'])).code).toBe(1)
    expect((await plan(repo, ['unregister', '--lane', 'export'])).code).toBe(0)
    expect(loadState('claude', S.sessionId).laneReviews).toBeUndefined()
    expect((await plan(repo, ['status', '--json'])).json()['lanes']).toBeUndefined()
  }))

  test('--lane needs a lane worktree of that slug and a valid slug', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const missing = await plan(repo, ['status', '--lane', 'nope'])
    expect(missing.code).toBe(1)
    expect(missing.err).toContain("there is no lane worktree 'nope' in this repository")
    const { runWorktree } = await import('../../src/cli/commands/worktree')
    expect(await runWorktree(['create', 'plain', ...AS], memIO(), ctxAt(repo))).toBe(0)
    expect((await plan(repo, ['status', '--lane', 'plain'])).code).toBe(1)
    expect((await plan(repo, ['status', '--lane', 'Bad Slug'])).code).toBe(1)
    expect((await plan(repo, ['init', '--lane', 'x', '--type', 'feature', '--title', 't'])).code).toBe(1)
  }))
})

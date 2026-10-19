import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planSkeleton, validatePlan } from '../../src/core/plan/format'
import { applyIntent } from '../../src/core/plan/state'
import { analyzePlan, localDate } from '../../src/workflow/plan-file'
import {
  planApproveResult, planComplete, planInit, planPause, planRegister, planResume, planSet, planStatus, planUnregister, planValidate, planVerify,
} from '../../src/workflow/plan'
import { userConfigFile } from '../../src/engine/paths'
import { loadState, saveState, freshState } from '../../src/workflow/session-store'
import { stillStubbed, testWhenImplemented } from '../helpers/not-implemented'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { SESSION, ctxAt, makeRepo, planDoc } from './fixture'

const S = SESSION

function withPlanRepo(fn: (o: { repo: string, plan: string }) => Promise<void>, doc = planDoc()): Promise<void> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1' }, async () => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
    writeFileSync(plan, doc)
    await fn({ repo, plan })
  }))
}

describe('plan init', () => {
  test('writes docs/plans/<date>-<slug>.md with a PENDING header and prints {path, slug}', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const ctx = ctxAt(join(repo, 'src'))
    const r = await planInit({ type: 'feature', title: 'Rate-limit the public API' }, ctx)
    expect(r.code).toBe(0)
    const path = join(repo, 'docs', 'plans', `${localDate(ctx.now)}-rate-limit-the-public-api.md`)
    expect(r.data['path']).toBe(path)
    expect(r.data['slug']).toBe('rate-limit-the-public-api')
    expect(r.lines[0]).toBe(path)
    const text = readFileSync(path, 'utf8')
    expect(text.includes('\r')).toBe(false)
    const info = analyzePlan(text)
    expect(info.status).toBe('PENDING')
    expect(info.approved).toBe(false)
    expect(info.type).toBe('Feature')
    expect(info.created).toBe(localDate(ctx.now))
    expect(info.title).toBe('Rate-limit the public API')

    const again = await planInit({ type: 'feature', title: 'Rate-limit the public API' }, ctx)
    expect(again.data['slug']).toBe('rate-limit-the-public-api-2')
    expect(existsSync(String(again.data['path']))).toBe(true)
  }))

  test('build plans go to docs/builds with rounds; --slug and --dir are honored', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const ctx = ctxAt(repo)
    const b = await planInit({ type: 'build', title: 'Offline mode' }, ctx)
    expect(String(b.data['path'])).toBe(join(repo, 'docs', 'builds', `${localDate(ctx.now)}-offline-mode.md`))
    const info = analyzePlan(readFileSync(String(b.data['path']), 'utf8'))
    expect(info.type).toBe('Build')
    expect(info.rounds).toBe(0)
    const c = await planInit({ type: 'Bugfix', title: 'Fix: totals', slug: 'totals', dir: 'notes/specs' }, ctx)
    expect(String(c.data['path'])).toBe(join(repo, 'notes', 'specs', `${localDate(ctx.now)}-totals.md`))
    expect(analyzePlan(readFileSync(String(c.data['path']), 'utf8')).type).toBe('Bugfix')
  }))

  test('usage errors exit 1', () => withSandbox(async ({ root }) => {
    const ctx = ctxAt(root)
    expect((await planInit({ type: 'epic', title: 'x' }, ctx)).code).toBe(1)
    expect((await planInit({ type: 'feature' }, ctx)).code).toBe(1)
    expect((await planInit({ type: 'feature', title: 'a\nb' }, ctx)).code).toBe(1)
    expect((await planInit({ type: 'feature', title: 'x', slug: 'Bad Slug' }, ctx)).code).toBe(1)
  }))

  test('outside git the plan goes under the current directory', () => withSandbox(async ({ root }) => {
    const ctx = ctxAt(root)
    const r = await planInit({ type: 'feature', title: 'Solo' }, ctx)
    expect(String(r.data['path'])).toBe(join(root, 'docs', 'plans', `${localDate(ctx.now)}-solo.md`))
  }))

  test('with a session, the header records the harness that wrote the plan; the validator ignores the key', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const ctx = ctxAt(repo)
    for (const harness of ['codex', 'omp'] as const) {
      const r = await planInit({ type: 'build', title: `Run on ${harness}` }, ctx, { harness, sessionId: `s-${harness}`, source: '--session' })
      expect(r.data['harness']).toBe(harness)
      const text = readFileSync(String(r.data['path']), 'utf8')
      expect(text.split('\n').slice(1, 8)).toEqual(['created: ' + localDate(ctx.now), 'status: PENDING', 'approved: false', 'worktree: false', 'type: Build', 'rounds: 0', `harness: ${harness}`])
      expect(validatePlan(text).filter(f => f.level === 'error').map(f => f.code)).toEqual(['unfilled'])
    }
    const none = await planInit({ type: 'feature', title: 'No session' }, ctx)
    expect(none.data['harness']).toBeUndefined()
    expect(readFileSync(String(none.data['path']), 'utf8')).not.toContain('harness:')
  }))
})

describe('plan validate', () => {
  test('a missing file is an error', () => withSandbox(({ root }) => {
    expect(planValidate(join(root, 'nope.md'), false, ctxAt(root)).code).toBe(1)
    expect(planValidate(undefined, false, ctxAt(root)).code).toBe(1)
  }))

  if (stillStubbed(() => validatePlan('', {}))) {
    test('reports an unavailable validator as an error (exit 1)', () => withPlanRepo(async ({ repo, plan }) => {
      const r = planValidate(plan, false, ctxAt(repo))
      expect(r.code).toBe(1)
      expect(r.data['error']).toBe('validator_unavailable')
    }))
  }

  testWhenImplemented('exit codes follow the findings (0 ok, 1 errors, 2 warnings with --strict)', () => validatePlan('', {}), () => withPlanRepo(async ({ repo, plan }) => {
    const ok = planValidate(plan, false, ctxAt(repo))
    expect(ok.code).toBe(0)
    expect(ok.data['errors']).toBe(0)
    const strict = planValidate(plan, true, ctxAt(repo))
    expect([0, 2]).toContain(strict.code)
    expect(strict.code === 2).toBe((strict.data['warnings'] as number) > 0)
    writeFileSync(plan, planDoc().replace(/\n/g, '\r\n'))
    const crlf = planValidate(plan, false, ctxAt(repo))
    expect(crlf.code).toBe(1)
    expect(Array.isArray(crlf.data['findings'])).toBe(true)
  }))

  test('init writes the core planSkeleton; validate reports its unfilled placeholders and --strict never passes it', () => withSandbox(async ({ root }) => {
    const repo = await makeRepo(root)
    const ctx = ctxAt(repo)
    for (const [type, coreType] of [['feature', 'Feature'], ['bugfix', 'Bugfix'], ['build', 'Build']] as const) {
      const r = await planInit({ type, title: `Skeleton ${type}` }, ctx)
      expect(r.code).toBe(0)
      const path = String(r.data['path'])
      const text = readFileSync(path, 'utf8')
      expect(text).toBe(planSkeleton({ type: coreType, title: `Skeleton ${type}`, created: localDate(ctx.now) }))
      const core = validatePlan(text, {})
      const plain = planValidate(path, false, ctx)
      expect({ type, code: plain.code }).toEqual({ type, code: core.some(f => f.level === 'error') ? 1 : 0 })
      const strict = planValidate(path, true, ctx)
      expect({ type, strictFails: strict.code !== 0 }).toEqual({ type, strictFails: true })
      expect((strict.data['findings'] as Array<{ code: string }>).some(f => f.code === 'unfilled')).toBe(true)
    }
  }))
})

describe('plan register and status', () => {
  test('binds the plan with the phase its header implies; status reports tasks and interaction', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    const r = await planRegister(plan, undefined, ctx, S)
    expect(r.code).toBe(0)
    expect(r.data['plan']).toMatchObject({ path: plan, slug: 'rate-limit', type: 'Feature', status: 'PENDING', phase: 'plan', approved: false })
    expect(r.data['card']).toBeUndefined()
    const st = loadState('claude', S.sessionId)
    expect(st.plan).toEqual({ path: plan, slug: 'rate-limit', status: 'PENDING', type: 'Feature', phase: 'plan', registeredAt: ctx.now })

    const s = planStatus(ctx, S)
    expect(s.code).toBe(0)
    expect(s.data['plan']).toMatchObject({ path: plan, slug: 'rate-limit', type: 'Feature', status: 'PENDING', phase: 'plan' })
    expect(s.data['tasks']).toEqual({ done: 0, total: 2 })
    expect(s.data['interaction']).toEqual({ state: 'running' })
  }))

  test('phase inference: approved → implement, COMPLETE → verify, explicit --phase wins', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    writeFileSync(plan, planDoc({ status: 'APPROVED', approved: true }))
    expect((await planRegister(plan, undefined, ctx, S)).data['plan']).toMatchObject({ phase: 'implement', approved: true })
    expect(loadState('claude', S.sessionId).approvals?.planApprovedAt).toBe(ctx.now)
    writeFileSync(plan, planDoc({ status: 'COMPLETE', approved: true, done: 2 }))
    expect((await planRegister(plan, undefined, ctx, S)).data['plan']).toMatchObject({ phase: 'verify' })
    expect((await planRegister(plan, 'implement', ctx, S)).data['plan']).toMatchObject({ phase: 'implement' })
    expect((await planRegister(plan, 'later', ctx, S)).code).toBe(1)
  }))

  test('a locked build registered without --phase keeps the phase its run file records (goal-build resume)', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    writeFileSync(plan, planDoc({ type: 'Build', status: 'COMPLETE', approved: true, done: 2, extraFm: 'phase: verify' }))
    expect((await planRegister(plan, undefined, ctx, S)).data['plan']).toMatchObject({ type: 'Build', phase: 'verify' })
    writeFileSync(plan, planDoc({ type: 'Build', status: 'COMPLETE', approved: true, done: 2, extraFm: 'phase: implement' }))
    expect((await planRegister(plan, undefined, ctx, S)).data['plan']).toMatchObject({ type: 'Build', phase: 'implement' })
  }))

  test('a different plan replaces the binding and resets both guard counters; the same plan keeps them', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    const st = loadState('claude', S.sessionId)
    saveState('claude', S.sessionId, { ...st, guard: { blocksForPlan: 7, blocksInChain: 2, lastBlockAt: 3 } })
    await planRegister(plan, undefined, { ...ctx, now: ctx.now + 5 }, S)
    expect(loadState('claude', S.sessionId).guard).toEqual({ blocksForPlan: 7, blocksInChain: 2, lastBlockAt: 3 })
    expect(loadState('claude', S.sessionId).plan?.registeredAt).toBe(ctx.now)
    const other = join(repo, 'docs', 'plans', '2026-10-09-other.md')
    writeFileSync(other, planDoc())
    const r = await planRegister(other, undefined, ctx, S)
    expect(r.errors.some(e => e.includes('replaced the earlier binding'))).toBe(true)
    expect(loadState('claude', S.sessionId).guard).toEqual({ blocksForPlan: 0, blocksInChain: 0 })
  }))

  test('files that are not plans are refused', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    expect((await planRegister(join(repo, 'missing.md'), undefined, ctx, S)).data['error']).toBe('plan_missing')
    writeFileSync(plan, '# no header\n')
    expect((await planRegister(plan, undefined, ctx, S)).data['error']).toBe('no_frontmatter')
    writeFileSync(plan, '---\nstatus: DONE\ntype: Feature\n---\n# x\n')
    expect((await planRegister(plan, undefined, ctx, S)).data['error']).toBe('invalid_header')
    expect(loadState('claude', S.sessionId).plan).toBeUndefined()
  }))

  test('status without a binding, and drift between file and session is reported, not adopted', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    expect(planStatus(ctx, S).data).toMatchObject({ plan: null, tasks: { done: 0, total: 0 }, interaction: { state: 'running' } })
    await planRegister(plan, undefined, ctx, S)
    writeFileSync(plan, planDoc({ status: 'VERIFIED' }))
    const s = planStatus(ctx, S)
    expect(s.data['plan']).toMatchObject({ status: 'PENDING' })
    expect(s.data['file']).toEqual({ status: 'VERIFIED' })
    expect(s.errors.some(e => e.includes('plan set status'))).toBe(true)
    expect(loadState('claude', S.sessionId).plan?.status).toBe('PENDING')
  }))
})

describe('plan set', () => {
  test('approved, status and phase update the frontmatter and the session together', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    const before = readFileSync(plan, 'utf8')

    const refused = await planSet('status', 'APPROVED', ctx, S)
    expect(refused.code).toBe(2)
    expect(refused.data['reasons']).toBeDefined()
    expect(readFileSync(plan, 'utf8')).toBe(before)

    expect((await planSet('approved', 'true', ctx, S)).code).toBe(0)
    expect(analyzePlan(readFileSync(plan, 'utf8')).approved).toBe(true)
    expect(loadState('claude', S.sessionId).approvals?.planApprovedAt).toBe(ctx.now)

    const st = await planSet('status', 'APPROVED', ctx, S)
    expect(st.code).toBe(0)
    expect(st.data['changed']).toEqual({ status: { from: 'PENDING', to: 'APPROVED' } })
    expect(analyzePlan(readFileSync(plan, 'utf8')).status).toBe('APPROVED')
    expect(loadState('claude', S.sessionId).plan?.status).toBe('APPROVED')

    expect((await planSet('phase', 'implement', ctx, S)).code).toBe(0)
    expect(analyzePlan(readFileSync(plan, 'utf8')).phase).toBe('implement')
    expect(loadState('claude', S.sessionId).plan?.phase).toBe('implement')

    const after = readFileSync(plan, 'utf8')
    expect(after.slice(after.indexOf('# Rate-limit'))).toBe(before.slice(before.indexOf('# Rate-limit')))

    const same = await planSet('status', 'approved', ctx, S)
    expect(same.code).toBe(0)
    expect(same.data['changed']).toEqual({})
  }))

  test('iterations/rounds follow the plan type; worktree is a header flag; bad values exit 1', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    expect((await planSet('iterations', '2', ctx, S)).code).toBe(0)
    expect(analyzePlan(readFileSync(plan, 'utf8')).iterations).toBe(2)
    expect((await planSet('rounds', '1', ctx, S)).code).toBe(1)
    expect((await planSet('worktree', 'true', ctx, S)).code).toBe(0)
    expect(analyzePlan(readFileSync(plan, 'utf8')).worktree).toBe(true)
    expect((await planSet('worktree', 'maybe', ctx, S)).code).toBe(1)
    expect((await planSet('phase', 'later', ctx, S)).code).toBe(1)
    expect((await planSet('status', 'SAVED', ctx, S)).code).toBe(1)
    expect((await planSet('iterations', '-1', ctx, S)).code).toBe(1)
    expect((await planSet('owner', 'me', ctx, S)).code).toBe(1)
    expect((await planSet('status', undefined, ctx, S)).code).toBe(1)
  }))

  test('no implementation phase before approval', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    const r = await planSet('phase', 'implement', ctx, S)
    expect(r.code).toBe(2)
    expect(loadState('claude', S.sessionId).plan?.phase).toBe('plan')
    expect(analyzePlan(readFileSync(plan, 'utf8')).phase).toBeUndefined()
    expect((await planSet('phase', 'plan', ctx, S)).code).toBe(0)
    const warned = await planRegister(plan, 'implement', ctx, S)
    expect(warned.code).toBe(0)
    expect(warned.errors.some(e => e.includes('not approved'))).toBe(true)
  }))

  test('binding a different plan drops the old pause', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    planPause('decision', 'continue A or start B?', ctx, S)
    await planRegister(plan, undefined, ctx, S)
    expect(loadState('claude', S.sessionId).interaction?.state).toBe('paused')
    const other = join(repo, 'docs', 'plans', '2026-10-09-b.md')
    writeFileSync(other, planDoc())
    await planRegister(other, undefined, ctx, S)
    expect(loadState('claude', S.sessionId).interaction).toBeUndefined()
  }))

  test('without a registered plan: exit 1 with a hint', () => withSandbox(async ({ root }) => {
    const r = await planSet('phase', 'implement', ctxAt(root), S)
    expect(r.code).toBe(1)
    expect(r.data['error']).toBe('no_plan')
  }))

  test('IN_PROGRESS is allowed again from COMPLETE (verify loopback)', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    writeFileSync(plan, planDoc({ status: 'COMPLETE', approved: true, done: 2 }))
    await planRegister(plan, undefined, ctx, S)
    const r = await planSet('status', 'IN_PROGRESS', ctx, S)
    expect(r.code).toBe(0)
    expect(loadState('claude', S.sessionId).plan?.status).toBe('IN_PROGRESS')
    expect(analyzePlan(readFileSync(plan, 'utf8')).status).toBe('IN_PROGRESS')
  }))
})

describe('plan pause / resume', () => {
  test('pause is idempotent, keeps the stronger kind, and resume is a no-op when nothing is paused', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    expect(planPause('decision', 'q', ctx, S).data['changed']).toBe(false)
    await planRegister(plan, undefined, ctx, S)
    expect(planResume(ctx, S).data['changed']).toBe(false)

    const p1 = planPause(undefined, 'user said stop', ctx, S)
    expect(p1.data['interaction']).toEqual({ state: 'paused', kind: 'discussion', since: ctx.now, reason: 'user said stop' })
    const p2 = planPause('discussion', undefined, { ...ctx, now: ctx.now + 10 }, S)
    expect(p2.data['changed']).toBe(false)
    expect(p2.data['interaction']).toEqual({ state: 'paused', kind: 'discussion', since: ctx.now, reason: 'user said stop' })
    const up = planPause('decision', 'plan approval', { ...ctx, now: ctx.now + 20 }, S)
    expect(up.data['changed']).toBe(true)
    expect(up.data['interaction']).toEqual({ state: 'paused', kind: 'decision', since: ctx.now, reason: 'plan approval' })
    const weaker = planPause('discussion', 'stop', ctx, S)
    expect(weaker.data['changed']).toBe(false)
    expect(loadState('claude', S.sessionId).interaction).toMatchObject({ state: 'paused', kind: 'decision', reason: 'plan approval' })
    expect(planPause('manual', undefined, ctx, S).data['interaction']).toEqual({ state: 'paused', kind: 'manual', since: ctx.now, reason: 'plan approval' })
    expect(planPause('manual', 'create the API key', ctx, S).data['interaction']).toMatchObject({ kind: 'manual', reason: 'create the API key' })
    expect(planPause('later', undefined, ctx, S).code).toBe(1)

    const st = loadState('claude', S.sessionId)
    saveState('claude', S.sessionId, { ...st, guard: { blocksForPlan: 12, blocksInChain: 3, lastBlockAt: 5 } })
    const r = planResume({ ...ctx, now: ctx.now + 99 }, S)
    expect(r.data['changed']).toBe(true)
    expect(loadState('claude', S.sessionId).interaction).toEqual({ state: 'running', since: ctx.now + 99 })
    expect(loadState('claude', S.sessionId).guard).toEqual({ blocksForPlan: 0, blocksInChain: 0, lastBlockAt: 5 })
    expect(planStatus(ctx, S).data).toMatchObject({ interaction: { state: 'running', since: ctx.now + 99 }, status: 'PENDING', phase: 'plan' })
  }))

  test('pause and resume write exactly what core applyIntent writes for the same transition', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    const base = loadState('claude', S.sessionId)
    saveState('claude', S.sessionId, { ...base, guard: { blocksForPlan: 4, blocksInChain: 2, lastBlockAt: 9 } })
    const before = loadState('claude', S.sessionId)
    const viaIntent = applyIntent(before, 'pause', ctx.now)
    planPause('discussion', 'the user asked to stop', ctx, S)
    expect(loadState('claude', S.sessionId)).toEqual(viaIntent)
    const paused = loadState('claude', S.sessionId)
    const resumed = applyIntent(paused, 'resume', ctx.now + 7)
    planResume({ ...ctx, now: ctx.now + 7 }, S)
    expect(loadState('claude', S.sessionId)).toEqual(resumed)
    expect(resumed.guard).toEqual({ blocksForPlan: 0, blocksInChain: 0, lastBlockAt: 9 })
    saveState('claude', S.sessionId, applyIntent(loadState('claude', S.sessionId), 'pause', ctx.now + 8))
    const recorded = loadState('claude', S.sessionId)
    expect(planPause('discussion', undefined, { ...ctx, now: ctx.now + 9 }, S).data['changed']).toBe(false)
    expect(loadState('claude', S.sessionId)).toEqual(recorded)
  }))

  test('a finished plan has nothing to pause (like applyIntent); resume still clears a stale pause', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    writeFileSync(plan, planDoc({ status: 'VERIFIED', approved: true, done: 2 }))
    await planRegister(plan, undefined, ctx, S)
    const st = loadState('claude', S.sessionId)
    expect(applyIntent(st, 'pause', ctx.now)).toBe(st)
    const r = planPause('decision', 'q', ctx, S)
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ changed: false, note: 'the plan is finished; nothing to pause' })
    expect(loadState('claude', S.sessionId).interaction).toBeUndefined()
    saveState('claude', S.sessionId, { ...st, interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'merge decision' }, guard: { blocksForPlan: 3, blocksInChain: 1 } })
    const res = planResume({ ...ctx, now: ctx.now + 1 }, S)
    expect(res.data['changed']).toBe(true)
    expect(loadState('claude', S.sessionId)).toMatchObject({ interaction: { state: 'running', since: ctx.now + 1 }, guard: { blocksForPlan: 0, blocksInChain: 0 } })
  }))
})

describe('plan complete / verify', () => {
  test('complete refuses with the reasons until every task is ticked; verify needs COMPLETE', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    writeFileSync(plan, planDoc({ status: 'IN_PROGRESS', approved: true, n: 3, done: 1 }))
    await planRegister(plan, undefined, ctx, S)

    const v0 = await planVerify(ctx, S)
    expect(v0.code).toBe(2)
    expect((v0.data['reasons'] as string[]).some(r => r.includes('not COMPLETE'))).toBe(true)

    const c1 = await planComplete(ctx, S)
    expect(c1.code).toBe(2)
    const reasons = c1.data['reasons'] as string[]
    expect(reasons.filter(r => r.includes('is not ticked')).length).toBe(2)
    expect(c1.errors.join('\n')).toContain('Task 2 (Step 2)')
    expect(analyzePlan(readFileSync(plan, 'utf8')).status).toBe('IN_PROGRESS')

    writeFileSync(plan, planDoc({ status: 'IN_PROGRESS', approved: true, n: 3, done: 3, evidence: true }))
    const c2 = await planComplete(ctx, S)
    expect(c2.code).toBe(0)
    expect(analyzePlan(readFileSync(plan, 'utf8')).status).toBe('COMPLETE')
    expect(loadState('claude', S.sessionId).plan?.status).toBe('COMPLETE')
    expect((await planComplete(ctx, S)).data['changed']).toEqual({})

    const gated = await planVerify(ctx, S)
    expect(gated.code).toBe(2)
    expect((gated.data['reasons'] as string[]).some(r => r.includes('has not approved the verified result'))).toBe(true)
    expect((await planApproveResult(ctx, S)).code).toBe(0)
    const v1 = await planVerify(ctx, S)
    expect(v1.code).toBe(0)
    const info = analyzePlan(readFileSync(plan, 'utf8'))
    expect(info.status).toBe('VERIFIED')
    expect(info.phase).toBe('done')
    expect(loadState('claude', S.sessionId).plan).toMatchObject({ status: 'VERIFIED', phase: 'done' })
    expect((await planVerify(ctx, S)).code).toBe(0)

    expect((await planSet('status', 'IN_PROGRESS', ctx, S)).code).toBe(2)
    expect((await planSet('approved', 'false', ctx, S)).code).toBe(2)
  }))

  test('verify refuses an unticked plan even when the file says COMPLETE; complete needs approval', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    writeFileSync(plan, planDoc({ status: 'COMPLETE', approved: true, n: 2, done: 1 }))
    await planRegister(plan, undefined, ctx, S)
    const v = await planVerify(ctx, S)
    expect(v.code).toBe(2)
    expect((v.data['reasons'] as string[]).some(r => r.startsWith('Task 2'))).toBe(true)

    writeFileSync(plan, planDoc({ status: 'IN_PROGRESS', approved: false, n: 1, done: 1 }))
    await planRegister(plan, undefined, ctx, S)
    const c = await planComplete(ctx, S)
    expect(c.code).toBe(2)
    expect((c.data['reasons'] as string[])[0]).toContain('not approved')
  }))

  test('set status COMPLETE / VERIFIED go through the same checks', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    writeFileSync(plan, planDoc({ status: 'IN_PROGRESS', approved: true, n: 1, done: 0 }))
    await planRegister(plan, undefined, ctx, S)
    expect((await planSet('status', 'COMPLETE', ctx, S)).code).toBe(2)
    expect((await planSet('status', 'VERIFIED', ctx, S)).code).toBe(2)
  }))

  test('a build verifies only when every criterion passes and ## Unverified is filled', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    const criteria = (c1: string, c2: string, c3: string) => [
      '## Acceptance Criteria', '| # | Criterion | Evidence | Status |', '|---|---|---|---|',
      `| C1 | Notes survive a reload offline. | chrome-devtools snapshot | ${c1} |`,
      `| C2 | Edits sync within 10 s. | server log | ${c2} |`,
      `| C3 (oracle) | A second profile sees the note. | screenshots | ${c3} |`, '',
    ].join('\n')
    const run = (rows: string, unverified?: string) => [
      planDoc({ type: 'Build', status: 'COMPLETE', approved: true, done: 2, evidence: true }),
      rows,
      ...(unverified !== undefined ? ['## Unverified', unverified, ''] : []),
    ].join('\n')
    const reasons = async (): Promise<string[]> => {
      const r = await planVerify(ctx, S)
      expect(r.code).toBe(2)
      expect(loadState('claude', S.sessionId).plan?.status).toBe('COMPLETE')
      return r.data['reasons'] as string[]
    }
    writeFileSync(plan, run(criteria('pass', 'fail', 'open'), 'None.'))
    await planRegister(plan, 'verify', ctx, S)
    const failing = await reasons()
    expect(failing.filter(r => r.startsWith('C'))).toEqual([
      expect.stringMatching(/^C2 is fail: a build is VERIFIED only when every criterion passes; .*'buracle plan pause --kind decision'/),
      expect.stringMatching(/^C3 \(oracle\) is open \(not judged yet\): /),
    ])
    expect(failing.some(r => r.includes('Unverified'))).toBe(false)

    writeFileSync(plan, run(criteria('pass', 'pass', 'pass')))
    expect(await reasons()).toEqual([expect.stringContaining("no filled '## Unverified' section")])
    writeFileSync(plan, run(criteria('pass', 'pass', 'pass'), '<!-- checks you could not run -->'))
    expect(await reasons()).toEqual([expect.stringContaining("no filled '## Unverified' section")])
    writeFileSync(plan, run('', 'None.'))
    expect(await reasons()).toEqual([expect.stringContaining('no criteria rows')])

    writeFileSync(plan, run(criteria('pass', 'pass', 'pass'), 'None.'))
    const ok = await planVerify(ctx, S)
    expect(ok.code).toBe(0)
    expect(analyzePlan(readFileSync(plan, 'utf8')).status).toBe('VERIFIED')
    expect(loadState('claude', S.sessionId).plan).toMatchObject({ status: 'VERIFIED', phase: 'done' })
  }))

  test('plan.goalVerification false: a passing build is refused and pointed at the hand-back pause; a Feature plan is not affected', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    const run = [
      planDoc({ type: 'Build', status: 'COMPLETE', approved: true, done: 2, evidence: true }),
      '## Acceptance Criteria', '| # | Criterion | Evidence | Status |', '|---|---|---|---|',
      '| C1 | a | b | pass |', '| C2 | a | b | pass |', '| C3 (oracle) | a | b | pass |', '',
      '## Unverified', 'Verification: disabled (plan.goalVerification).', '',
    ].join('\n')
    writeFileSync(plan, run)
    mkdirSync(join(userConfigFile(), '..'), { recursive: true })
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  goalVerification: false\n')
    await planRegister(plan, 'implement', ctx, S)
    expect(loadState('claude', S.sessionId).approvals?.switches).toEqual({ goalVerification: false, changesReview: true })
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  goalVerification: true\n')
    const r = await planVerify(ctx, S)
    expect(r.code).toBe(2)
    expect(r.data['reasons']).toEqual([expect.stringContaining('plan.goalVerification is off, so a build run is not verified')])
    expect((r.data['reasons'] as string[])[0]).toContain('buracle plan pause --kind decision --reason "build hand-back: done, verification off"')
    expect(loadState('claude', S.sessionId).plan?.status).toBe('COMPLETE')
    writeFileSync(plan, planDoc({ status: 'COMPLETE', approved: true, n: 2, done: 2, evidence: true }))
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  goalVerification: false\n  resultApproval: false\n')
    await planRegister(plan, 'verify', ctx, S)
    expect((await planVerify(ctx, S)).code).toBe(0)
  }))

  test('the switches are fixed at the lock: set approved true records them, a later config change does not alter the run, another plan drops them', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    writeFileSync(plan, [
      planDoc({ type: 'Build', status: 'PENDING', approved: false, done: 2, evidence: true }),
      '## Acceptance Criteria', '| # | Criterion | Evidence | Status |', '|---|---|---|---|',
      '| C1 | a | b | pass |', '| C2 | a | b | pass |', '| C3 (oracle) | a | b | pass |', '', '## Unverified', 'None.', '',
    ].join('\n'))
    await planRegister(plan, 'plan', ctx, S)
    expect(loadState('claude', S.sessionId).approvals?.switches).toBeUndefined()
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  reviews:\n    changes: false\n')
    const lock = await planSet('approved', 'true', ctx, S)
    expect(lock.lines).toContain('Locked for this run: reviews.changes off, goalVerification on (a later config change does not alter them).')
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  goalVerification: false\n')
    expect(loadState('claude', S.sessionId).approvals?.switches).toEqual({ goalVerification: true, changesReview: false })
    await planSet('status', 'COMPLETE', ctx, S)
    const verified = await planVerify(ctx, S)
    expect(verified.code).toBe(0)
    expect(verified.errors.join('\n')).not.toContain('changes-review')
    const other = join(repo, 'docs', 'plans', '2026-10-09-other.md')
    writeFileSync(other, planDoc({ status: 'APPROVED', approved: true }))
    await planRegister(other, undefined, ctx, S)
    expect(loadState('claude', S.sessionId).approvals).toEqual({ planApprovedAt: ctx.now })
  }))

  test('the build gate reads emphasized and header-less criteria rows and refuses a row it cannot read', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    const head = ['| # | Criterion | Evidence | Status |', '|---|---|---|---|']
    const run = (rows: string[]): string => [
      planDoc({ type: 'Build', status: 'COMPLETE', approved: true, done: 2, evidence: true }),
      '## Acceptance Criteria', ...rows, '', '## Unverified', 'None.', '',
    ].join('\n')
    const reasons = async (rows: string[]): Promise<string[]> => {
      writeFileSync(plan, run(rows))
      const r = await planVerify(ctx, S)
      expect(r.code).toBe(2)
      return r.data['reasons'] as string[]
    }
    writeFileSync(plan, run([...head, '| C1 | a | b | pass |']))
    await planRegister(plan, 'verify', ctx, S)
    expect(await reasons([...head, '| C1 | a | b | pass |', '| **C2** | a | b | fail |', '| C3 (oracle) | a | b | pass |'])).toEqual([expect.stringMatching(/^C2 is fail: /)])
    expect(await reasons([...head, '| C1 | a | b | pass |', '| C2 | a | b | pass |', '| C3 **(oracle)** | a | b | fail |'])).toEqual([expect.stringMatching(/^C3 \(oracle\) is fail: /)])
    expect(await reasons(['| C1 | a | b | fail |', '| C2 | a | b | pass |', '| C3 (oracle) | a | b | pass |', '| C4 | a | b | pass |'])).toEqual([expect.stringMatching(/^C1 is fail: /)])
    const unread = [...head, '| C1 | a | b | pass |', '| Criterion two | a | b | fail |', '| C3 (oracle) | a | b | pass |']
    const line = run(unread).split('\n').indexOf('| Criterion two | a | b | fail |') + 1
    expect(await reasons(unread)).toEqual([`line ${line} of '## Acceptance Criteria' is not a criterion row (| Criterion two | a | b | fail |): write it as '| C<n> | ... | pass |' so its verdict can be read`])

    writeFileSync(plan, run([...head, '| **C1** | a | b | **pass** |', '| `C2` | a | b | _passed_ |', '| **C3 (oracle)** | a | b | **pass** |']))
    const ok = await planVerify(ctx, S)
    expect(ok.code).toBe(0)
    expect(loadState('claude', S.sessionId).plan).toMatchObject({ status: 'VERIFIED' })
  }))

  test('a missing plan file is an error with a hint', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    writeFileSync(plan + '.bak', readFileSync(plan))
    const { unlinkSync } = await import('node:fs')
    unlinkSync(plan)
    const r = await planComplete(ctx, S)
    expect(r.code).toBe(1)
    expect(r.data['error']).toBe('plan_missing')
    expect(planStatus(ctx, S).data['fileMissing']).toBe(true)
  }))
})

describe('plan unregister', () => {
  test('removes the binding, the pause and the approval; keeps the file', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    await planSet('approved', 'true', ctx, S)
    planPause('decision', 'q', ctx, S)
    const before = readFileSync(plan, 'utf8')
    const r = await planUnregister(ctx, S)
    expect(r.data['unregistered']).toBe(plan)
    expect(loadState('claude', S.sessionId)).toEqual(freshState())
    expect(readFileSync(plan, 'utf8')).toBe(before)
    expect((await planUnregister(ctx, S)).data['unregistered']).toBeNull()
  }))
})

describe('the result review (plan.resultApproval, plan approve-result)', () => {
  const complete = planDoc({ status: 'COMPLETE', approved: true, n: 2, done: 2, evidence: true })

  test('approve-result needs a Feature or Bugfix plan at COMPLETE, records the time and ends the review pause', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    writeFileSync(plan, planDoc({ status: 'IN_PROGRESS', approved: true, n: 2, done: 1 }))
    await planRegister(plan, undefined, ctx, S)
    const early = await planApproveResult(ctx, S)
    expect(early.code).toBe(2)
    expect((early.data['reasons'] as string[])[0]).toContain('at status COMPLETE')
    writeFileSync(plan, complete)
    await planRegister(plan, undefined, ctx, S)
    planPause('decision', 'result review', ctx, S)
    const r = await planApproveResult({ ...ctx, now: ctx.now + 5 }, S)
    expect(r.code).toBe(0)
    expect(r.lines.join('\n')).toContain('Resumed')
    const st = loadState('claude', S.sessionId)
    expect(st.approvals?.resultApprovedAt).toBe(ctx.now + 5)
    expect(st.interaction).toEqual({ state: 'running', since: ctx.now + 5 })
    expect((await planVerify(ctx, S)).code).toBe(0)
  }, planDoc()))

  test('a loop back to implement, a reopened phase, an unapproved plan or another plan drops the approval', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    for (const [field, value] of [['status', 'IN_PROGRESS'], ['phase', 'implement'], ['approved', 'false']] as const) {
      writeFileSync(plan, complete)
      await planRegister(plan, undefined, ctx, S)
      expect((await planApproveResult(ctx, S)).code).toBe(0)
      expect((await planSet(field, value, ctx, S)).code).toBe(0)
      expect({ field, approved: loadState('claude', S.sessionId).approvals?.resultApprovedAt }).toEqual({ field, approved: undefined })
    }
    writeFileSync(plan, complete)
    await planRegister(plan, undefined, ctx, S)
    expect((await planApproveResult(ctx, S)).code).toBe(0)
    const other = join(repo, 'docs', 'plans', '2026-10-09-other.md')
    writeFileSync(other, complete)
    await planRegister(other, undefined, ctx, S)
    expect(loadState('claude', S.sessionId).approvals?.resultApprovedAt).toBeUndefined()
    expect((await planVerify(ctx, S)).code).toBe(2)
  }, planDoc({ status: 'COMPLETE', approved: true, n: 2, done: 2, evidence: true })))

  test('Build plans need no result review; plan.resultApproval false turns the gate off', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    expect((await planApproveResult(ctx, S)).code).toBe(2)
    writeFileSync(plan, complete)
    await planRegister(plan, undefined, ctx, S)
    writeFileSync(userConfigFile(), 'version: 1\nplan:\n  resultApproval: false\n')
    expect((await planVerify(ctx, S)).code).toBe(0)
  }, planDoc({ type: 'Build', status: 'COMPLETE', approved: true, n: 3, done: 3, evidence: true })))
})

describe('the decision safety net: acting on a held decision ends its pause', () => {
  test('set approved true, set status IN_PROGRESS, set phase verify and complete resume a decision pause and say so', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    planPause('decision', 'plan approval', ctx, S)
    const a = await planSet('approved', 'true', { ...ctx, now: ctx.now + 1 }, S)
    expect(a.lines.join('\n')).toContain('the pending decision was acted on')
    expect(loadState('claude', S.sessionId).interaction).toEqual({ state: 'running', since: ctx.now + 1 })
    for (const [field, value] of [['status', 'IN_PROGRESS'], ['phase', 'verify']] as const) {
      planPause('decision', 'q', ctx, S)
      await planSet(field, value, ctx, S)
      expect({ field, state: loadState('claude', S.sessionId).interaction?.state }).toEqual({ field, state: 'running' })
    }
    writeFileSync(plan, planDoc({ status: 'IN_PROGRESS', approved: true, n: 2, done: 2 }))
    planPause('decision', 'q', ctx, S)
    expect((await planComplete(ctx, S)).lines.join('\n')).toContain('the pending decision was acted on')
  }))

  test('a manual or discussion pause is never ended by these commands', () => withPlanRepo(async ({ repo, plan }) => {
    const ctx = ctxAt(repo)
    await planRegister(plan, undefined, ctx, S)
    for (const kind of ['manual', 'discussion'] as const) {
      planResume(ctx, S)
      planPause(kind, 'the user does it', ctx, S)
      const r = await planSet('approved', 'true', ctx, S)
      expect(r.lines.join('\n')).not.toContain('acted on')
      expect({ kind, state: loadState('claude', S.sessionId).interaction?.state }).toEqual({ kind, state: 'paused' })
    }
  }))
})

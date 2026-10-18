import { describe, expect, test } from 'bun:test'
import { planSkeleton } from '../../../src/core/plan/format'
import { NATIVE_PLAN_ENTER, nativeBinding, nativeConflictNote, nativeFilledNote, nativePlanText, withNativeBinding, withoutNativeBinding } from '../../../src/core/plan/native'
import { preApprovalEdit, readOnlyStartNotice } from '../../../src/core/plan/plan-mode'
import { emptyState, planValidateVerdict, stopGuardVerdict, type SessionState } from '../../../src/core/plan/state'
import { defaultConfig } from '../../../src/core/config'
import { HARNESSES } from '../../../src/core/events'

const PATH = '/repo/docs/plans/2026-10-08-add-a-cache.md'
const SHA = 'a'.repeat(64)
const BINDING = { path: PATH, sha: SHA, at: 5 }

function planning(over: Partial<NonNullable<SessionState['plan']>> = {}, rest: Partial<SessionState> = {}): SessionState {
  return { ...emptyState(), plan: { path: PATH, slug: 'add-a-cache', status: 'PENDING', type: 'Feature', phase: 'plan', registeredAt: 1, ...over }, ...rest }
}

const REGISTERED = planSkeleton({ type: 'Feature', title: 'Add a cache', created: '2026-10-08' })
const HEAD = REGISTERED.slice(0, REGISTERED.indexOf('# Add a cache'))

describe('nativeBinding: the single-use binding of a registered plan to a harness plan mode', () => {
  test('counts only for the bound Feature plan while it is PENDING, in its plan phase and not approved', () => {
    expect(nativeBinding(withNativeBinding(planning(), BINDING))).toEqual(BINDING)
    expect(nativeBinding(planning({}, { native: BINDING }))).toEqual(BINDING)
    expect(nativeBinding(planning())).toBeUndefined()
    expect(nativeBinding(planning({ path: '/repo/docs/plans/other.md' }, { native: BINDING }))).toBeUndefined()
    expect(nativeBinding(planning({ type: 'Bugfix' }, { native: BINDING }))).toBeUndefined()
    expect(nativeBinding(planning({ phase: 'implement' }, { native: BINDING }))).toBeUndefined()
    expect(nativeBinding(planning({ status: 'APPROVED' }, { native: BINDING }))).toBeUndefined()
    expect(nativeBinding(planning({}, { native: BINDING, approvals: { planApprovedAt: 9 } }))).toBeUndefined()
    expect(nativeBinding(planning({}, { native: { ...BINDING, sha: 'not-a-hash' } }))).toBeUndefined()
    expect(nativeBinding({ ...emptyState(), native: BINDING })).toBeUndefined()
    expect(withoutNativeBinding(planning({}, { native: BINDING }))).toEqual(planning())
  })

  test('while it holds, the stop guard lets the planning turn end with the skeleton plan (H11) and no early-edit note fires; without it both apply again', () => {
    const errors = [{ level: 'error' as const, code: 'unfilled', message: '14 placeholders' }]
    const bound = planning({}, { native: BINDING })
    expect(planValidateVerdict(bound, true, errors)).toEqual({ action: 'allow' })
    expect(planValidateVerdict(planning(), true, errors).action).toBe('block')
    const input = { harness: 'codex' as const, sessionId: 's', cwd: '/repo', now: 10, hookActive: false }
    expect(stopGuardVerdict(bound, input, defaultConfig().plan, { exists: true, findings: errors }).decision.action).toBe('allow')
    expect(stopGuardVerdict(planning(), input, defaultConfig().plan, { exists: true, findings: errors }).decision.action).toBe('block')
    const opts = { cwd: '/repo', planApproval: true }
    expect(preApprovalEdit(bound, ['/home/u/.claude/plans/quiet-fox.md'], opts).note).toBeUndefined()
    expect(preApprovalEdit(planning(), ['/home/u/.claude/plans/quiet-fox.md'], opts).note).toContain('is still in its plan phase')
  })
})

describe('nativePlanText: the approved text under the registered frontmatter', () => {
  const BODY = '# Add a cache\n\n## Goal\nFaster reads.\n\n## Tasks\n\n### Task 1: Cache\n'

  test('keeps the registered frontmatter byte for byte and replaces the body', () => {
    expect(nativePlanText(REGISTERED, BODY)).toBe(`${HEAD}${BODY}`)
    expect(nativePlanText(REGISTERED.replace(/\n/g, '\r\n'), `${BODY}\r\n`)).toBe(`${HEAD}${BODY}`)
  })

  test('drops a frontmatter the agent copied and chatter before the title; keeps a body without a title under the registered one', () => {
    expect(nativePlanText(REGISTERED, `---\nstatus: VERIFIED\napproved: true\n---\n${BODY}`)).toBe(`${HEAD}${BODY}`)
    expect(nativePlanText(REGISTERED, `Switch back to the build agent (Tab) and say continue.\n\n${BODY}`)).toBe(`${HEAD}${BODY}`)
    expect(nativePlanText(REGISTERED, '## Goal\nFaster reads.\n')).toBe(`${HEAD}# Add a cache\n\n## Goal\nFaster reads.\n`)
    expect(nativePlanText(REGISTERED, '## Goal\nx\n\n# Later heading\ny\n')).toBe(`${HEAD}# Add a cache\n\n## Goal\nx\n\n# Later heading\ny\n`)
  })

  test('nothing to write: an empty text or a registered file without frontmatter', () => {
    expect(nativePlanText(REGISTERED, '  \n')).toBeUndefined()
    expect(nativePlanText(REGISTERED, '---\nx: 1\n---\n')).toBeUndefined()
    expect(nativePlanText('# No header\n', BODY)).toBeUndefined()
  })
})

describe('the texts agents read', () => {
  test('the H12 notes say what was written and what comes next', () => {
    const approved = nativeFilledNote({ path: 'docs/plans/p.md', harness: 'omp', approved: true, errors: 2, staleReview: true })
    expect(approved).toContain('approved in Oh My Pi plan mode was written into the registered plan docs/plans/p.md')
    expect(approved).toContain('`buracle plan validate docs/plans/p.md --strict`')
    expect(approved).toContain('`buracle plan set approved false` first')
    expect(approved).toContain('reports 2 errors')
    expect(approved).toContain('run it again')
    const draft = nativeFilledNote({ path: 'docs/plans/p.md', harness: 'opencode', approved: false, errors: 0, staleReview: false })
    expect(draft).toContain('OpenCode has no approval step, so it is not approved yet')
    expect(draft).toContain('ask the user to approve it')
    expect(draft).not.toContain('error')
    expect(nativeConflictNote('docs/plans/p.md', 'docs/plans/p-2.md', 'codex')).toContain('saved the plan from Codex plan mode to docs/plans/p-2.md instead')
    expect(nativeConflictNote('docs/plans/p.md', undefined, 'claude')).toContain('could not save the plan')
  })

  test('every harness has its way into plan mode, and the read-only start note tells a prepared plan-build run to keep planning', () => {
    for (const h of HARNESSES) expect(NATIVE_PLAN_ENTER[h].length).toBeGreaterThan(10)
    expect(NATIVE_PLAN_ENTER.claude).toContain('EnterPlanMode')
    for (const h of ['codex', 'opencode', 'omp'] as const) expect(NATIVE_PLAN_ENTER[h]).toContain('end the turn')
    expect(readOnlyStartNotice('plan-build', 'codex')).toContain('`buracle plan prepare-native`) keeps planning here')
    expect(readOnlyStartNotice('goal-build', 'codex')).not.toContain('prepare-native')
  })
})

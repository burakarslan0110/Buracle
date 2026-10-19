import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bandInputFor, flowEndCmd, flowPath, flowPhaseCmd, flowStartCmd, flowStatusCmd, flowStepCmd, readFlow, recordFlowStart } from '../../src/workflow/flow'
import { planComplete, planRegister, planSet, planVerify, planApproveResult } from '../../src/workflow/plan'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { SESSION, ctxAt, makeRepo, planDoc } from './fixture'

const S = SESSION
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('flow commands', () => {
  test('start, phase, step and end write the session record', () => withSandbox(({ buracleHome }) => {
    const path = join(buracleHome, 'sessions', 'claude', S.sessionId, 'flow.json')
    expect(flowPath('claude', S.sessionId)).toBe(path)
    const start = flowStartCmd({ workflow: 'bugfix', title: 'Totals off by one' }, ctxAt('/', NOW), S)
    expect(start.code).toBe(0)
    expect(start.data).toMatchObject({ changed: true, active: { workflow: 'bugfix', title: 'Totals off by one', source: 'cli', startedAt: NOW }, breadcrumb: ['bugfix'] })
    expect(flowStartCmd({ workflow: 'bugfix' }, ctxAt('/', NOW + 1), S).data['changed']).toBe(false)
    expect(flowPhaseCmd({ phase: 'red', note: 'reproduce first' }, ctxAt('/', NOW + 2), S).data['active']).toMatchObject({ phase: { id: 'red', label: 'RED', since: NOW + 2, note: 'reproduce first' } })
    expect(flowStepCmd({ text: 'writing the failing test', done: '1', total: '3' }, ctxAt('/', NOW + 3), S).lines[0]).toBe('bugfix: Totals off by one · phase red (RED) · step "writing the failing test" 1/3')
    const end = flowEndCmd({ outcome: 'failed' }, ctxAt('/', NOW + 4), S)
    expect(end.data).toMatchObject({ changed: true, active: null, entry: { ended: { outcome: 'failed', at: NOW + 4 } } })
    expect(json(path)).toMatchObject({ v: 1, updatedAt: NOW + 4, stack: [{ workflow: 'bugfix', ended: { outcome: 'failed' } }] })
    expect(flowEndCmd({}, ctxAt('/', NOW + 5), S)).toMatchObject({ code: 0, lines: [`Nothing is running in the claude session ${S.sessionId}; nothing to end.`] })
    expect(flowPhaseCmd({ phase: 'fix' }, ctxAt('/', NOW + 5), S)).toMatchObject({ code: 1, data: { error: 'no_flow' } })
  }))

  test('usage errors and unknown phases exit 1 and write nothing', () => withSandbox(() => {
    expect(flowStartCmd({}, ctxAt('/', NOW), S).code).toBe(1)
    expect(flowStartCmd({ workflow: 'Not A Workflow' }, ctxAt('/', NOW), S).code).toBe(1)
    expect(flowStartCmd({ workflow: 'plan-build', title: 'two\nlines' }, ctxAt('/', NOW), S).code).toBe(1)
    expect(readFlow('claude', S.sessionId)).toBeUndefined()
    flowStartCmd({ workflow: 'plan-build' }, ctxAt('/', NOW), S)
    const bad = flowPhaseCmd({ phase: 'judge' }, ctxAt('/', NOW), S)
    expect(bad.code).toBe(1)
    expect(bad.errors[0]).toContain('plan, approve, implement, verify')
    expect(flowStepCmd({ text: 'x', done: 'two' }, ctxAt('/', NOW), S).code).toBe(1)
    expect(flowEndCmd({ outcome: 'maybe' }, ctxAt('/', NOW), S).code).toBe(1)
  }))

  test('a hook records a start with the same reducer: the skill\'s own start is then the same run', () => withSandbox(() => {
    expect(recordFlowStart('codex', 'thread-9', { workflow: 'plan-build', title: 'Rate limit', source: 'prompt' }, NOW)).toBe(true)
    expect(recordFlowStart('codex', 'thread-9', { workflow: 'plan-build', source: 'prompt' }, NOW + 5_000)).toBe(false)
    const cs = { harness: 'codex' as const, sessionId: 'thread-9', source: '--session' }
    expect(flowStartCmd({ workflow: 'plan-build' }, ctxAt('/', NOW + 9_000), cs).data['changed']).toBe(false)
    expect(readFlow('codex', 'thread-9')?.stack).toEqual([{ workflow: 'plan-build', title: 'Rate limit', source: 'prompt', startedAt: NOW }])
    expect(recordFlowStart('codex', '../escape', { workflow: 'plan-build', source: 'prompt' }, NOW)).toBe(false)
  }))

  test('an unreadable record is replaced instead of failing the command', () => withSandbox(() => {
    mkdirSync(join(flowPath('claude', S.sessionId), '..'), { recursive: true })
    writeFileSync(flowPath('claude', S.sessionId), '{ torn')
    expect(flowStartCmd({ workflow: 'research' }, ctxAt('/', NOW), S).code).toBe(0)
    expect(readFlow('claude', S.sessionId)?.stack.map(e => e.workflow)).toEqual(['research'])
  }))

  test('status: the view of the running workflow, and nulls without a session', () => withSandbox(() => {
    const none = flowStatusCmd(ctxAt('/', NOW), undefined)
    expect(none).toMatchObject({ code: 0, data: { flow: null, active: null, view: null, session: null } })
    expect(none.lines[0]).toContain('no session')
    expect(flowStatusCmd(ctxAt('/', NOW), S).lines).toEqual([`No workflow is running in the claude session ${S.sessionId}.`])
    flowStartCmd({ workflow: 'research', title: 'Queue libraries' }, ctxAt('/', NOW), S)
    flowPhaseCmd({ phase: 'gather' }, ctxAt('/', NOW + 60_000), S)
    const st = flowStatusCmd(ctxAt('/', NOW + 3 * 60_000), S)
    expect(st.data).toMatchObject({ active: { workflow: 'research', phase: { id: 'gather', label: 'Gather' } }, view: { visible: true, status: 'running', elapsedMin: 3 } })
    expect(st.lines[0]).toBe('research · Queue libraries · running · 3m')
  }))
})

describe('plans keep spec and build in step', () => {
  function withRepo(fn: (o: { repo: string, plan: string }) => Promise<void>, doc = planDoc()): Promise<void> {
    return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1' }, async () => {
      const repo = await makeRepo(root)
      const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
      mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
      writeFileSync(plan, doc)
      await fn({ repo, plan })
    }))
  }

  test('register, approve, implement, complete, verify: the spec flow follows and ends done', () => withRepo(async ({ repo, plan }) => {
    const at = (n: number) => ctxAt(repo, NOW + n * 1000)
    expect((await planRegister(plan, 'plan', at(0), S)).code).toBe(0)
    expect(readFlow('claude', S.sessionId)?.stack).toEqual([{ workflow: 'plan-build', source: 'plan', title: 'Rate-limit the public API', startedAt: NOW, phase: { id: 'plan', since: NOW } }])
    flowPhaseCmd({ phase: 'approve' }, at(1), S)
    expect((await planSet('approved', 'true', at(2), S)).code).toBe(0)
    expect((await planSet('status', 'APPROVED', at(3), S)).code).toBe(0)
    expect(readFlow('claude', S.sessionId)?.stack[0]?.phase?.id).toBe('approve')
    expect((await planSet('phase', 'implement', at(4), S)).code).toBe(0)
    expect(readFlow('claude', S.sessionId)?.stack[0]?.phase).toEqual({ id: 'implement', since: NOW + 4000 })
    expect(bandInputFor('claude', S.sessionId, NOW + 5000).plan).toMatchObject({ done: 0, total: 2, current: 'Task 1: Step 1' })
    writeFileSync(plan, readFileSync(plan, 'utf8').replace(/- \[ \] Task (\d) done/g, '- [x] Task $1 done'))
    expect((await planComplete(at(6), S)).code).toBe(0)
    expect((await planSet('phase', 'verify', at(7), S)).code).toBe(0)
    expect(readFlow('claude', S.sessionId)?.stack[0]?.phase?.id).toBe('verify')
    writeFileSync(plan, `${readFileSync(plan, 'utf8')}\n## Evidence\n| Check | Command | Result |\n|---|---|---|\n| Tests | \`bun test\` | pass |\n\n## DoD Audit\n| Task | Result | Evidence |\n|---|---|---|\n| 1 | met | row 1 |\n`)
    expect((await planApproveResult(at(8), S)).code).toBe(0)
    expect((await planVerify(at(8), S)).code).toBe(0)
    expect(readFlow('claude', S.sessionId)?.stack[0]).toMatchObject({ workflow: 'plan-build', phase: { id: 'verify' }, ended: { outcome: 'done', at: NOW + 8000 } })
  }))

  test('a build plan maps to build: contract, build, judge once complete', () => withRepo(async ({ repo, plan }) => {
    const at = (n: number) => ctxAt(repo, NOW + n * 1000)
    await planRegister(plan, 'plan', at(0), S)
    expect(readFlow('claude', S.sessionId)?.stack[0]).toMatchObject({ workflow: 'goal-build', phase: { id: 'contract' } })
    await planSet('approved', 'true', at(1), S)
    await planSet('phase', 'implement', at(2), S)
    expect(readFlow('claude', S.sessionId)?.stack[0]?.phase?.id).toBe('build')
    writeFileSync(plan, readFileSync(plan, 'utf8').replace(/- \[ \] Task (\d) done/g, '- [x] Task $1 done'))
    expect((await planComplete(at(3), S)).code).toBe(0)
    expect(readFlow('claude', S.sessionId)?.stack[0]?.phase?.id).toBe('judge')
  }, planDoc({ type: 'Build' })))

  test('a flow record that cannot be written never fails a plan command', () => withRepo(async ({ repo, plan }) => {
    mkdirSync(flowPath('claude', S.sessionId), { recursive: true })
    expect((await planRegister(plan, 'plan', ctxAt(repo, NOW), S)).code).toBe(0)
    expect(existsSync(join(flowPath('claude', S.sessionId), 'x'))).toBe(false)
  }))
})

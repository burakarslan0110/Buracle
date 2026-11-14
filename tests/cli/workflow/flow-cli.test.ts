import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../../src/engine/proc'
import { withSandbox } from '../../helpers/sandbox'
import { GIT_TEST_ENV, makeRepo, planDoc, write } from '../../workflow/fixture'

const CLI = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'main.ts')

interface Entry { workflow: string, title?: string, source?: string, phase?: { id: string, note?: string }, step?: { text: string, done?: number, total?: number }, ended?: { outcome: string } }
const flowStack = (buracleHome: string, harness: string, sid: string): Entry[] => (JSON.parse(readFileSync(join(buracleHome, 'sessions', harness, sid, 'flow.json'), 'utf8')) as { stack: Entry[] }).stack

interface Run { code: number, stdout: string, stderr: string, json: <T = Record<string, unknown>>() => T }

function cli(cwd: string, env: Record<string, string | undefined>) {
  return async (...args: string[]): Promise<Run> => {
    const r = await run([process.execPath, CLI, ...args], { cwd, env: { ...GIT_TEST_ENV, BURACLE_NO_MEMORY: '1', ...env }, timeoutMs: 60_000 })
    return { ...r, json: <T>() => JSON.parse(r.stdout) as T }
  }
}

describe('buracle flow', () => {
  test('start, phase, step and end in one session', () => withSandbox(async ({ root, home, buracleHome }) => {
    const b = cli(root, { HOME: home, BURACLE_HOME: buracleHome, BURACLE_HARNESS: 'opencode', BURACLE_SESSION_ID: 'ses_flow1' })
    const start = await b('flow', 'start', 'requirements', '--title', 'Notes sync', '--json')
    expect(start.code).toBe(0)
    expect(start.json()).toMatchObject({ ok: true, changed: true, active: { workflow: 'requirements', title: 'Notes sync', source: 'cli' }, session: { harness: 'opencode', id: 'ses_flow1' } })
    expect((await b('flow', 'phase', 'research')).stdout).toBe('requirements: Notes sync · phase research (Research)\n')
    expect((await b('flow', 'start', 'research')).code).toBe(0)
    expect((await b('flow', 'start', 'research', '--json')).json()).toMatchObject({ changed: false, breadcrumb: ['requirements', 'research'] })
    expect((await b('flow', 'phase', 'gather', '--note', 'three sources')).code).toBe(0)
    expect((await b('flow', 'step', 'Reading', 'the', 'CRDT', 'papers', '--done', '1', '--total', '3')).stdout).toBe('requirements > research · phase gather (Gather) · step "Reading the CRDT papers" 1/3\n')

    expect(flowStack(buracleHome, 'opencode', 'ses_flow1').at(-1)).toMatchObject({ workflow: 'research', phase: { id: 'gather', note: 'three sources' }, step: { text: 'Reading the CRDT papers', done: 1, total: 3 } })

    expect((await b('flow', 'end', '--json')).json()).toMatchObject({ entry: { workflow: 'research', ended: { outcome: 'done' } }, active: { workflow: 'requirements' } })
    expect((await b('flow', 'end', '--outcome', 'cancelled')).code).toBe(0)
    expect(flowStack(buracleHome, 'opencode', 'ses_flow1').map(e => [e.workflow, e.ended?.outcome])).toEqual([['requirements', 'cancelled'], ['research', 'done']])
  }), 60_000)

  test('without a session the writers exit 2', () => withSandbox(async ({ root, home, buracleHome }) => {
    const b = cli(root, { HOME: home, BURACLE_HOME: buracleHome })
    for (const args of [['start', 'plan-build'], ['phase', 'plan'], ['step', 'x'], ['end']]) {
      const r = await b('flow', ...args)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('no session')
    }
    expect(existsSync(join(buracleHome, 'sessions'))).toBe(false)
  }), 60_000)

  test('usage errors exit 1; --session and --harness pick the session', () => withSandbox(async ({ root, home, buracleHome }) => {
    const b = cli(root, { HOME: home, BURACLE_HOME: buracleHome })
    expect((await b('flow')).code).toBe(1)
    expect((await b('flow', 'jump')).code).toBe(1)
    expect((await b('flow', 'status')).code).toBe(1)
    expect((await b('flow', 'start', 'plan-build', '--outcome', 'done', '--session', 's1', '--harness', 'omp')).code).toBe(1)
    expect((await b('flow', 'start', 'plan-build', '--session', 's1', '--harness', 'omp')).code).toBe(0)
    const bad = await b('flow', 'phase', 'judge', '--session', 's1', '--harness', 'omp')
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain("'judge' is not a phase of plan-build")
    expect(flowStack(buracleHome, 'omp', 's1').map(e => e.workflow)).toEqual(['plan-build'])
  }), 60_000)

  test('plan commands keep the spec flow in step (Claude session id)', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = await makeRepo(root)
    const b = cli(repo, { HOME: home, BURACLE_HOME: buracleHome, CLAUDE_CODE_SESSION_ID: 'cc-flow-1' })
    const plan = join(repo, 'docs', 'plans', '2026-10-09-limits.md')
    write(plan, planDoc({ title: 'Limits' }))
    expect((await b('plan', 'register', plan, '--phase', 'plan')).code).toBe(0)
    expect(flowStack(buracleHome, 'claude', 'cc-flow-1').at(-1)).toMatchObject({ workflow: 'plan-build', title: 'Limits', source: 'plan', phase: { id: 'plan' } })
    for (const args of [['set', 'approved', 'true'], ['set', 'status', 'APPROVED'], ['set', 'phase', 'implement']]) expect((await b('plan', ...args)).code).toBe(0)
    expect(flowStack(buracleHome, 'claude', 'cc-flow-1').at(-1)).toMatchObject({ workflow: 'plan-build', phase: { id: 'implement' } })
  }), 60_000)
})

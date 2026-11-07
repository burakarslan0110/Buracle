import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { run } from '../../../src/engine/proc'
import { withSandbox } from '../../helpers/sandbox'
import { GIT_TEST_ENV, makeRepo, planDoc, write } from '../../workflow/fixture'

const CLI = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'main.ts')

interface Run { code: number, stdout: string, stderr: string, json: <T = Record<string, unknown>>() => T }

export function cli(cwd: string, env: Record<string, string | undefined>) {
  return async (...args: string[]): Promise<Run> => {
    const r = await run([process.execPath, CLI, ...args], { cwd, env: { ...GIT_TEST_ENV, BURACLE_NO_NOTIFY: '1', BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000', ...env }, timeoutMs: 60_000 })
    return { ...r, json: <T>() => JSON.parse(r.stdout) as T }
  }
}

describe('buracle work, end to end', () => {
  test('publish needs a session and an approved plan; status reads the board from any session or none', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ n: 2, status: 'IN_PROGRESS', approved: true }))
    const base = { HOME: home, BURACLE_HOME: buracleHome }
    const lead = cli(repo, { ...base, CLAUDE_CODE_SESSION_ID: 'lead-e2e' })
    const anon = cli(repo, base)

    const noSession = await anon('work', 'publish', plan, '--json')
    expect(noSession.code).toBe(2)
    expect(noSession.json()).toMatchObject({ ok: false, error: 'no_session' })

    const pub = await lead('work', 'publish', plan, '--lease-sec', '1', '--max-workers', '2', '--json')
    expect(pub.stderr).toBe('')
    expect(pub.code).toBe(0)
    expect(pub.json()).toMatchObject({ ok: true, slug: 'rate-limit', leaseSec: 1, maxWorkers: 2, lead: { harness: 'claude', session: 'lead-e2e' } })

    const status = await anon('work', 'status', '--json')
    expect(status.code).toBe(0)
    expect(status.json()).toMatchObject({ ok: true, slug: 'rate-limit', summary: { open: 2, total: 2 } })
    const text = await anon('work', 'status')
    expect(text.stdout).toContain('Task 1 open: Step 1')

    const bad = await lead('work', 'publish', plan, '--lease-sec', 'soon', '--json')
    expect(bad.code).toBe(1)
    expect(bad.json()).toMatchObject({ error: 'usage' })
    expect((await anon('work', 'status', '--json', '--session', 'x', '--bogus')).code).toBe(1)
    const unknown = await anon('work', 'frobnicate')
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unknown subcommand 'frobnicate'")
    expect((await anon('work')).code).toBe(1)
    const help = await anon('work', '--help')
    expect(help.stdout).toContain('publish [<plan path>]')
  }))

  test('two joins that start at the same moment from different harnesses take different tasks; a third finds nothing', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ n: 2, status: 'IN_PROGRESS', approved: true }))
    const base = { HOME: home, BURACLE_HOME: buracleHome }
    const lead = cli(repo, { ...base, CLAUDE_CODE_SESSION_ID: 'lead-e2e' })
    expect((await lead('work', 'publish', plan, '--json')).code).toBe(0)
    const w1 = cli(repo, { ...base, CLAUDE_CODE_SESSION_ID: 'worker-one' })
    const w2 = cli(repo, { ...base, CODEX_THREAD_ID: 'worker-two' })
    const [a, b] = await Promise.all([w1('work', 'join', 'rate-limit', '--json'), w2('work', 'join', 'rate-limit', '--json')])
    expect([a.code, b.code]).toEqual([0, 0])
    const tasks = [a.json<{ task: { n: number } }>().task.n, b.json<{ task: { n: number } }>().task.n].sort()
    expect(tasks).toEqual([1, 2])
    const status = await lead('work', 'status', '--json')
    const workers = (status.json<{ tasks: Array<{ worker?: { harness: string } }> }>().tasks).map(t => t.worker?.harness).sort()
    expect(workers).toEqual(['claude', 'codex'])
    const w3 = cli(repo, { ...base, OMP_SESSION_ID: 'worker-three' })
    const none = await w3('work', 'join', 'rate-limit', '--json')
    expect(none.code).toBe(1)
    expect(none.json()).toMatchObject({ error: 'nothing_to_claim' })
    expect((await w1('work', 'heartbeat', '--json')).json()).toMatchObject({ ok: true, leaseSec: 300 })
    expect((await w1('work', 'release', '--reason', 'done for today', '--json')).json()).toMatchObject({ ok: true, status: 'open' })
    expect((await w3('work', 'join', 'rate-limit', '--json')).code).toBe(0)
  }), 120_000)
})

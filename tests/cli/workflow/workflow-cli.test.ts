import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../../../src/cli/router'
import { run } from '../../../src/engine/proc'
import { analyzePlan } from '../../../src/workflow/plan-file'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { GIT_TEST_ENV, evidenceSections, g, makeRepo, memIO, write } from '../../workflow/fixture'

const CLI = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'main.ts')

interface Run { code: number, stdout: string, stderr: string, json: <T = Record<string, unknown>>() => T }

function cli(cwd: string, env: Record<string, string | undefined>) {
  return async (...args: string[]): Promise<Run> => {
    const r = await run([process.execPath, CLI, ...args], { cwd, env: { ...GIT_TEST_ENV, BURACLE_NO_NOTIFY: '1', BURACLE_NO_MEMORY: '1', ...env }, timeoutMs: 60_000 })
    return { ...r, json: <T>() => JSON.parse(r.stdout) as T }
  }
}

function tick(path: string): void {
  writeFileSync(path, readFileSync(path, 'utf8').replace(/- \[ \] Task (\d+) done/g, '- [x] Task $1 done'))
}

function fillPlan(path: string): void {
  const text = readFileSync(path, 'utf8')
  const head = text.slice(0, text.indexOf('## Tasks'))
  writeFileSync(path, `${head}## Tasks\n\n### Task 1: Count requests\n\n**Objective:** Count requests per key.\n\n**Files:**\n- Create: \`src/limit.ts\`\n\n**Definition of Done:**\n- Verify: \`bun test\`\n\n- [ ] Task 1 done\n`)
}

describe('skill command lines, end to end', () => {
  test('spec flow: init → register → approve → worktree → implement → complete → review → result approval → sync → cleanup → verify', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = await makeRepo(root)
    const env = { HOME: home, BURACLE_HOME: buracleHome, CLAUDE_CODE_SESSION_ID: 'e2e-session' }
    const b = cli(repo, env)

    expect((await b('plan', 'status', '--json')).json()).toMatchObject({ plan: null, tasks: { done: 0, total: 0 } })

    const init = await b('plan', 'init', '--type', 'feature', '--title', 'Rate limit the API', '--json')
    expect(init.code).toBe(0)
    const { path, slug } = init.json<{ path: string, slug: string }>()
    expect(slug).toBe('rate-limit-the-api')
    expect(existsSync(path)).toBe(true)

    expect((await b('plan', 'register', path, '--phase', 'plan')).code).toBe(0)
    fillPlan(path)
    const validate = await b('plan', 'validate', path, '--strict', '--json')
    expect([0, 1, 2]).toContain(validate.code)

    expect((await b('notify', 'plan_approval', 'Rate limit', 'Plan ready: 1 task', '--plan', path)).code).toBe(0)
    expect((await b('plan', 'pause', '--kind', 'decision', '--reason', 'plan approval')).code).toBe(0)
    expect((await b('plan', 'status', '--json')).json<{ interaction: { state: string } }>().interaction.state).toBe('paused')
    expect((await b('plan', 'resume')).code).toBe(0)
    expect((await b('plan', 'set', 'approved', 'true')).code).toBe(0)
    expect((await b('plan', 'set', 'status', 'APPROVED')).code).toBe(0)
    expect((await b('plan', 'set', 'phase', 'implement')).code).toBe(0)

    const wt = await b('worktree', 'create', slug, '--json')
    expect(wt.code).toBe(0)
    const wtPath = wt.json<{ path: string, branch: string }>().path
    expect(wt.json<{ branch: string }>().branch).toBe(`plan-build/${slug}`)
    expect(analyzePlan(readFileSync(path, 'utf8')).worktree).toBe(true)
    expect((await b('worktree', 'detect', '--json')).json()).toMatchObject({ inWorktree: false })
    expect((await cli(wtPath, env)('worktree', 'detect', '--json')).json()).toMatchObject({ inWorktree: true, slug })
    expect((await b('worktree', 'status', '--json')).json()).toMatchObject({ session: { plan: slug, worktree: slug } })

    expect((await b('plan', 'set', 'status', 'IN_PROGRESS')).code).toBe(0)
    write(join(wtPath, 'src', 'limit.ts'), 'export const limit = 100\n')
    await g(wtPath, 'add', '-A')
    await g(wtPath, 'commit', '-q', '-m', 'task 1: count requests')

    const early = await b('plan', 'complete')
    expect(early.code).toBe(2)
    expect(early.stderr).toContain('Task 1')
    tick(path)
    expect((await b('plan', 'complete')).code).toBe(0)
    expect((await b('plan', 'set', 'phase', 'verify')).code).toBe(0)

    const scope = await b('review-scope', '--json')
    expect(scope.json()).toMatchObject({ mode: 'worktree', base_ref: 'main', diff_range: `main...plan-build/${slug}` })
    expect((await b('review-scope', '--slug', slug, '--json')).json()).toMatchObject({ mode: 'worktree' })
    expect((await b('worktree', 'diff', slug, '--json')).json()).toMatchObject({ commits: [{ subject: 'task 1: count requests' }] })

    expect((await b('plan', 'pause', '--kind', 'decision', '--reason', 'result review')).code).toBe(0)
    const reviewed = await b('plan', 'approve-result')
    expect(reviewed.code).toBe(0)
    expect(reviewed.stdout).toContain('Result approved')
    expect((await b('plan', 'status', '--json')).json()).toMatchObject({ interaction: { state: 'running' } })

    const sync = await b('worktree', 'sync', slug, '--json')
    expect(sync.code).toBe(0)
    expect(sync.json()).toMatchObject({ merged: true, subject: 'feat: rate limit the API' })
    expect((await b('worktree', 'cleanup', slug)).code).toBe(0)
    expect(existsSync(wtPath)).toBe(false)

    const bare = await b('plan', 'verify')
    expect(bare.code).toBe(2)
    expect(bare.stderr).toContain("missing evidence: the plan has no filled '## Evidence' section")
    writeFileSync(path, readFileSync(path, 'utf8') + '\n' + evidenceSections('Feature').join('\n'))
    const verify = await b('plan', 'verify')
    expect(verify.code).toBe(0)
    expect((await b('plan', 'status', '--json')).json()).toMatchObject({ plan: { status: 'VERIFIED', phase: 'done' }, tasks: { done: 1, total: 1 } })
    expect((await b('notify', 'verification_complete', 'Rate limit', 'VERIFIED', '--plan', path)).code).toBe(0)
    expect((await b('plan', 'unregister')).code).toBe(0)
    const notes = readFileSync(join(buracleHome, 'state', 'notifications.jsonl'), 'utf8').trim().split('\n')
    expect(notes.length).toBe(2)
    expect(await g(repo, 'log', '-1', '--format=%s')).toBe('feat: rate limit the API')
  }), 120_000)

  test('build flow pieces: build plans, rounds, verify loopback, pause kinds', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = await makeRepo(root)
    const b = cli(repo, { HOME: home, BURACLE_HOME: buracleHome, CODEX_THREAD_ID: 'thread-1' })
    const init = await b('plan', 'init', '--type', 'build', '--title', 'Offline mode', '--json')
    const { path } = init.json<{ path: string }>()
    expect(path).toContain(join('docs', 'builds'))
    expect((await b('plan', 'register', path, '--phase', 'plan')).code).toBe(0)
    fillPlan(path)
    for (const args of [['set', 'approved', 'true'], ['set', 'status', 'APPROVED'], ['set', 'phase', 'implement'], ['set', 'status', 'IN_PROGRESS']]) {
      expect((await b('plan', ...args)).code).toBe(0)
    }
    const slug = String(init.json<{ slug: string }>().slug)
    const wt = await b('worktree', 'create', slug, '--prefix', 'goal-build', '--json')
    expect(wt.code).toBe(0)
    expect(wt.json<{ branch: string }>().branch).toBe(`goal-build/${slug}`)
    expect(analyzePlan(readFileSync(path, 'utf8')).worktree).toBe(true)
    expect((await b('notify', 'prd_approval', 'Offline mode', 'docs/prd/2026-10-08-offline-mode.md')).code).toBe(0)
    tick(path)
    expect((await b('plan', 'complete')).code).toBe(0)
    expect((await b('plan', 'set', 'rounds', '1')).code).toBe(0)
    expect((await b('plan', 'set', 'iterations', '1')).code).toBe(1)
    expect((await b('plan', 'set', 'status', 'IN_PROGRESS')).code).toBe(0)
    expect((await b('plan', 'pause', '--kind', 'discussion', '--reason', 'user asked to stop')).code).toBe(0)
    expect((await b('plan', 'pause', '--kind', 'manual', '--reason', 'create the API key')).code).toBe(0)
    const st = (await b('plan', 'status', '--json')).json<{ interaction: { kind: string }, session: { harness: string } }>()
    expect(st.interaction.kind).toBe('manual')
    expect(st.session.harness).toBe('codex')
    expect(analyzePlan(readFileSync(path, 'utf8')).rounds).toBe(1)
  }), 120_000)

  test('no session: plan commands exit 2 and name buracle doctor; the rest still work', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = await makeRepo(root)
    const b = cli(repo, { HOME: home, BURACLE_HOME: buracleHome })
    for (const sub of [['status', '--json'], ['register', 'x.md'], ['pause'], ['resume'], ['complete'], ['verify'], ['unregister'], ['set', 'phase', 'plan']]) {
      const r = await b('plan', ...sub)
      expect(r.code).toBe(2)
      expect(r.stderr).toContain('no session')
      expect(r.stderr).toContain('buracle doctor')
    }
    const j = await b('plan', 'status', '--json')
    expect(j.json()).toMatchObject({ ok: false, error: 'no_session' })
    expect((await b('plan', 'init', '--type', 'fix', '--title', 'x')).code).toBe(1)
    expect((await b('review-scope', '--json')).code).toBe(0)
    expect((await b('worktree', 'detect', '--json')).code).toBe(0)
    expect((await b('notify', 'info', 'Hi', 'there')).code).toBe(0)
    const proj = await b('project', 'init', '--json')
    expect(proj.code).toBe(2)
    expect(proj.json<{ guidance: string[] }>().guidance[0]).toContain('project-rules')
  }), 120_000)
})

describe('router-level usage', () => {
  test('usage errors exit 1; --help prints usage; unknown subcommands are named', async () => {
    await withEnv({ CLAUDE_CODE_SESSION_ID: undefined }, async () => {
      for (const argv of [['plan'], ['plan', 'frobnicate'], ['plan', 'init', '--nope'], ['plan', 'validate', 'a', 'b'], ['plan', 'status', '--strict'],
        ['worktree'], ['worktree', 'create'], ['worktree', 'cleanup', 'x', '--force', '--discard'], ['review-scope', 'extra'],
        ['notify', 'info', 'a', 'b', 'c'], ['project'], ['project', 'nuke'], ['skills'], ['skills', 'list', '--strict'], ['rules'], ['rules', 'check']]) {
        const io = memIO()
        expect({ argv, code: await main(argv, io) }).toEqual({ argv, code: 1 })
        expect(io.err().length).toBeGreaterThan(0)
      }
      for (const cmd of ['plan', 'worktree', 'review-scope', 'notify', 'project', 'skills', 'rules']) {
        const io = memIO()
        expect(await main([cmd, '--help'], io)).toBe(0)
        expect(io.out()).toContain(`buracle ${cmd}`)
      }
      const j = memIO(true)
      expect(await main(['plan', 'frobnicate', '--json'], j)).toBe(1)
      expect(JSON.parse(j.out())).toMatchObject({ ok: false, error: 'usage' })
    })
  })
})

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWork } from '../../src/cli/commands/work'
import { STANDBY_STALE_MS, claim, setStandby } from '../../src/core/board/model'
import { boardPath, commonDirOf, readBoard, sessionBoard, setSessionBoard, updateBoard } from '../../src/workflow/board-store'
import { resolveBoardPath, workNote, workPublish, workStatus } from '../../src/workflow/board'
import { repoFacts } from '../../src/workflow/gitx'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, makeRepo, memIO, planDoc, write } from './fixture'

const LEAD: ResolvedSession = { harness: 'claude', sessionId: 'lead-1', source: '--session' }
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0)

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '200' }, () => fn(root)))
}

function approvedPlan(o: { n?: number, extra?: string } = {}): string {
  const doc = planDoc({ n: o.n ?? 3, status: 'IN_PROGRESS', approved: true })
  return o.extra !== undefined ? doc.replace('## Tasks', `${o.extra}\n\n## Tasks`) : doc
}

/** A plan shaped for waves: Task 1 is the foundation, Tasks 2 to 4 depend on it, Task 5 closes; `assumptions` goes under `## Assumptions`. */
function wavePlan(o: { approved?: boolean, type?: string, assumptions?: string[] } = {}): string {
  let doc = planDoc({ n: 5, status: o.approved === true ? 'IN_PROGRESS' : 'PENDING', approved: o.approved ?? false, type: o.type ?? 'Feature' })
  for (const n of [2, 3, 4]) doc = doc.replace(`**Objective:** Do step ${n}.`, `**Objective:** Do step ${n}.\n\n**Depends on:** Task 1`)
  doc = doc.replace('**Objective:** Do step 5.', '**Objective:** Do step 5.\n\n**Depends on:** Task 2, Task 3, Task 4')
  if (o.assumptions !== undefined) doc = doc.replace('## Tasks', `## Assumptions\n${o.assumptions.map(a => `- ${a}`).join('\n')}\n\n## Tasks`)
  return doc
}

const SWARM_PLAN_BLOCK = [
  '## Swarm Plan',
  '| Wave | Tasks | Width |',
  '|---|---|---|',
  '| 1 | Task 1 | 1 |',
  '| 2 | Task 2, Task 3, Task 4 | 3 |',
  '| 3 | Task 5 | 1 |',
  '',
  'Critical path: Task 1 → Task 2 → Task 5 (3 of 5 tasks).',
  'Workers: up to 3 at the widest wave; the lead scales from 1 to 6.',
]

describe('the lead\'s binding', () => {
  test('a lead whose binding is gone is rebound from the board file; with two boards the registered plan decides, otherwise usage', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, approvedPlan())
    const pub = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    expect(pub.code).toBe(0)
    setSessionBoard('claude', 'lead-1', undefined)
    expect(sessionBoard('claude', 'lead-1')).toBeUndefined()
    expect(workNote('still here', {}, ctxAt(repo, NOW + 1), LEAD).code).toBe(0)
    expect(sessionBoard('claude', 'lead-1')).toEqual({ slug: 'rate-limit', path: String(pub.data['path']), role: 'lead', cursor: 0 })
    const plan2 = join(repo, 'docs', 'plan-build', '2026-11-07-cache.md')
    write(plan2, approvedPlan({ n: 1 }))
    expect((await workPublish({ planPath: plan2 }, ctxAt(repo, NOW + 2), LEAD)).code).toBe(0)
    setSessionBoard('claude', 'lead-1', undefined)
    const two = workNote('which one?', {}, ctxAt(repo, NOW + 3), LEAD)
    expect(two.data['error']).toBe('usage')
    expect(two.errors.join(' ')).toContain('cache')
    expect(two.errors.join(' ')).toContain('rate-limit')
    expect(sessionBoard('claude', 'lead-1')).toBeUndefined()
  }))
})

describe('work publish --dry-run', () => {
  test('prints the waves and, with --md, the exact Swarm Plan block; writes no board, binds no session, and takes an unapproved plan', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, wavePlan({ assumptions: ['Swarm: on', 'Swarm harnesses: claude, codex', 'Panes: herdr'] }))
    const r = await workPublish({ planPath: plan, dryRun: true, md: true }, ctxAt(repo, NOW), LEAD)
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ ok: true, dryRun: true, slug: 'rate-limit', swarm: 'on', harnesses: ['claude', 'codex'], panes: 'herdr' })
    expect(r.data['waves']).toEqual({
      waves: [{ wave: 1, tasks: [1] }, { wave: 2, tasks: [2, 3, 4] }, { wave: 3, tasks: [5] }], width: 3, criticalPath: [1, 2, 5],
      depsOf: { 1: [], 2: [1], 3: [1], 4: [1], 5: [2, 3, 4] },
    })
    const tasks = r.data['tasks'] as Array<{ n: number, title: string, deps: number[], files: string[], done: boolean, harness?: string }>
    expect(tasks.map(t => [t.n, t.deps, t.files, t.done])).toEqual([[1, [], ['src/s1.ts'], false], [2, [1], ['src/s2.ts'], false], [3, [1], ['src/s3.ts'], false], [4, [1], ['src/s4.ts'], false], [5, [2, 3, 4], ['src/s5.ts'], false]])
    expect(tasks[0]?.title).toBe('Step 1')
    expect(tasks.every(t => t.harness === undefined)).toBe(true)
    expect(r.lines[0]).toBe('5 tasks in 3 waves: width 3, critical path 3 (Task 1 → Task 2 → Task 5)')
    // The lead pastes everything after the summary line into the plan as the `## Swarm Plan` section.
    expect(r.lines.slice(1)).toEqual(SWARM_PLAN_BLOCK)
    const common = commonDirOf(repo) as string
    expect(existsSync(boardPath(common, 'rate-limit'))).toBe(false)
    expect(sessionBoard('claude', 'lead-1')).toBeUndefined()

    const plain = await workPublish({ planPath: plan, dryRun: true }, ctxAt(repo, NOW), LEAD)
    expect(plain.code).toBe(0)
    expect(plain.lines).toEqual([r.lines[0] as string])
    expect(existsSync(boardPath(common, 'rate-limit'))).toBe(false)
  }))

  test('a Build file and a plan without a Swarm line work too (swarm null, harnesses null, panes null); a ticked task is listed as done', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const build = join(repo, 'docs', 'goal-build', '2026-11-07-cache.md')
    write(build, planDoc({ type: 'Build', n: 2, done: 1 }))
    const r = await workPublish({ planPath: build, dryRun: true, md: true }, ctxAt(repo, NOW), LEAD)
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ ok: true, dryRun: true, slug: 'cache', swarm: null, harnesses: null, panes: null })
    expect((r.data['tasks'] as Array<{ n: number, done: boolean }>).map(t => [t.n, t.done])).toEqual([[1, true], [2, false]])
    expect(r.data['waves']).toMatchObject({ waves: [{ wave: 1, tasks: [1, 2] }], width: 2, criticalPath: [1] })
    expect(r.lines[0]).toBe('2 tasks in 1 wave: width 2, critical path 1 (Task 1)')
    expect(r.lines[1]).toBe('## Swarm Plan')
    expect(r.lines.at(-1)).toBe('Workers: up to 2 at the widest wave; the lead scales from 1 to 6.')
    expect(existsSync(boardPath(commonDirOf(repo) as string, 'cache'))).toBe(false)
    expect((await workPublish({ planPath: join(repo, 'docs', 'nope.md'), dryRun: true }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('not_found')
    expect((await workPublish({ dryRun: true }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('usage')
  }))

  test('the CLI: publish --dry-run --md prints the summary line and the block, --json the waves; nothing is written', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, wavePlan({ assumptions: ['Swarm: on'] }))
    const session = ['--session', 'lead-1', '--harness', 'claude']
    const text = memIO(false)
    expect(await runWork(['publish', plan, '--dry-run', '--md', ...session], text, ctxAt(repo, NOW))).toBe(0)
    expect(text.out()).toBe(['5 tasks in 3 waves: width 3, critical path 3 (Task 1 → Task 2 → Task 5)', ...SWARM_PLAN_BLOCK].join('\n') + '\n')
    const json = memIO(true)
    expect(await runWork(['publish', plan, '--dry-run', '--json', ...session], json, ctxAt(repo, NOW))).toBe(0)
    expect(json.json()).toMatchObject({ ok: true, dryRun: true, slug: 'rate-limit', swarm: 'on', harnesses: null, panes: null, waves: { width: 3, criticalPath: [1, 2, 5] } })
    expect(existsSync(boardPath(commonDirOf(repo) as string, 'rate-limit'))).toBe(false)
    expect(sessionBoard('claude', 'lead-1')).toBeUndefined()
    const bad = memIO(true)
    expect(await runWork(['status', '--md', ...session], bad, ctxAt(repo, NOW))).toBe(1)
    expect(bad.err()).toContain("--md does not apply to 'work status'")
  }))
})

describe('work publish', () => {
  test('stores the plan\'s Swarm harnesses and Panes lines on the board, warns about an unknown harness, and a second publish without the lines keeps them', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, approvedPlan({ n: 2, extra: '## Assumptions\n- Swarm: on\n- Swarm harnesses: claude, gemini, codex\n- Panes: herdr' }))
    const r = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    expect(r.code).toBe(0)
    expect(r.errors.join('\n')).toContain('gemini')
    const path = String(r.data['path'])
    expect(readBoard(path)).toMatchObject({ harnesses: ['claude', 'codex'], panes: 'herdr' })
    expect(r.data).toMatchObject({ harnesses: ['claude', 'codex'], panes: 'herdr' })
    // No multiplexer here: the lead is told how many terminals to open instead.
    expect(r.data['scale']).toMatchObject({ opened: [], closed: [] })
    expect(String((r.data['scale'] as { advice: string }).advice)).toBe('2 task(s) ready, 0 worker(s) waiting: open 2 terminal(s) in this repository and run `/buracle-join rate-limit` in each (`$buracle-join rate-limit` in Codex).')
    expect(r.lines).toContain(String((r.data['scale'] as { advice: string }).advice))
    write(plan, approvedPlan({ n: 2 }))
    const again = await workPublish({ planPath: plan }, ctxAt(repo, NOW + 1000), LEAD)
    expect(again.code).toBe(0)
    expect(readBoard(path)).toMatchObject({ harnesses: ['claude', 'codex'], panes: 'herdr' })
    const bare = join(repo, 'docs', 'plan-build', '2026-11-07-cache.md')
    write(bare, approvedPlan({ n: 1 }))
    const none = await workPublish({ planPath: bare }, ctxAt(repo, NOW + 2000), LEAD)
    expect(none.code).toBe(0)
    const b = readBoard(String(none.data['path']))
    expect([b?.harnesses, b?.panes, b?.standby]).toEqual([undefined, undefined, undefined])
  }))

  test('a plan with every task ticked publishes an all-merged board: exit 0, nothing open, every task merged', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ n: 2, done: 2, status: 'IN_PROGRESS', approved: true }))
    const r = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ ok: true, open: 0 })
    expect((r.data['tasks'] as Array<{ status: string }>).map(t => t.status)).toEqual(['merged', 'merged'])
    expect(readBoard(String(r.data['path']))?.tasks.every(t => t.status === 'merged')).toBe(true)
  }))

  test('writes the approved plan\'s unticked tasks with deps, constraints and context, binds the lead, and is idempotent', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    const extra = '## Context\n- Commands: tests `bun test` · types `bunx tsc --noEmit -p .`\n\n## Constraints\n- No semicolons.\n- Lease 300 s.'
    write(plan, approvedPlan({ extra }).replace('- Modify: `src/s3.ts`', '- Modify: `src/s1.ts`\n- Modify: `src/s3.ts`'))
    const r = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    expect(r.errors).toEqual([])
    expect(r.code).toBe(0)
    expect(r.data).toMatchObject({ ok: true, slug: 'rate-limit', base: 'main', lead: { harness: 'claude', session: 'lead-1' }, maxWorkers: 6, leaseSec: 300, changed: [], open: 3 })
    const tasks = r.data['tasks'] as Array<{ n: number, status: string, deps: number[] }>
    expect(tasks.map(t => [t.n, t.status, t.deps])).toEqual([[1, 'open', []], [2, 'open', []], [3, 'open', [1]]])
    const facts = await repoFacts(repo)
    const path = boardPath((facts as { commonDir: string }).commonDir, 'rate-limit')
    expect(r.data['path']).toBe(path)
    expect(commonDirOf(repo)).toBe((facts as { commonDir: string }).commonDir)
    const board = readBoard(path)
    expect(board?.constraints).toEqual(['- No semicolons.', '- Lease 300 s.'])
    expect(board?.context).toBe('- Commands: tests `bun test` · types `bunx tsc --noEmit -p .`')
    expect(board?.plan).toBe(plan)
    expect(sessionBoard('claude', 'lead-1')).toEqual({ slug: 'rate-limit', path, role: 'lead', cursor: 0 })
    expect(r.lines[1]).toContain('/buracle-join rate-limit')

    const again = await workPublish({ planPath: plan }, ctxAt(repo, NOW + 1000), LEAD)
    expect(again.code).toBe(0)
    expect(readBoard(path)?.events.filter(e => e.kind === 'published')).toHaveLength(2)
  }))

  test('refuses an unapproved plan, a missing plan, a directory outside a repository and a slug too long for lane worktrees', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, planDoc({ n: 2 }))
    expect((await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('not_approved')
    expect((await workPublish({ planPath: join(repo, 'docs', 'nope.md') }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('not_found')
    expect((await workPublish({}, ctxAt(repo, NOW), LEAD)).data['error']).toBe('usage')
    write(plan, approvedPlan())
    expect((await workPublish({ planPath: plan }, ctxAt(root, NOW), LEAD)).data['error']).toBe('no_repo')
    const long = join(repo, 'docs', 'plan-build', `2026-11-07-${'a'.repeat(62)}.md`)
    write(long, approvedPlan())
    const r = await workPublish({ planPath: long }, ctxAt(repo, NOW), LEAD)
    expect(r.data['error']).toBe('usage')
    expect(String(r.data['message'])).toContain('64')
    expect((await workPublish({ planPath: plan, leaseSec: 0 }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('usage')
    expect((await workPublish({ planPath: plan, maxWorkers: 0 }, ctxAt(repo, NOW), LEAD)).data['error']).toBe('usage')
    const lease = await workPublish({ planPath: plan, leaseSec: 1, maxWorkers: 2 }, ctxAt(repo, NOW), LEAD)
    expect(lease.data).toMatchObject({ leaseSec: 1, maxWorkers: 2 })
  }))

  test('a second publish keeps an active task\'s files and warns (exit 2) when the plan changed them; a plan with nothing open publishes an empty board', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, approvedPlan())
    const first = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    const path = String(first.data['path'])
    expect(updateBoard(path, NOW, b => claim(b, 1, { harness: 'codex', session: 'w1' }, NOW, 'tok')).ok).toBe(true)
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('- Modify: `src/s1.ts`', '- Modify: `src/s1.ts`\n- Modify: `src/s9.ts`'))
    const second = await workPublish({ planPath: plan }, ctxAt(repo, NOW + 5), LEAD)
    expect(second.code).toBe(2)
    expect(second.errors[0]).toContain('plan_changed_while_active')
    expect(second.errors[0]).toContain('Task 1')
    expect(second.data['changed']).toEqual([1])
    expect(readBoard(path)?.tasks[0]?.files.map(f => f.path)).toEqual(['src/s1.ts'])
    const done = join(repo, 'docs', 'plan-build', '2026-11-07-all-done.md')
    write(done, planDoc({ n: 2, done: 2, status: 'COMPLETE', approved: true }))
    const empty = await workPublish({ planPath: done }, ctxAt(repo, NOW), LEAD)
    expect(empty.code).toBe(0)
    expect(empty.data['open']).toBe(0)
    expect((empty.data['tasks'] as Array<{ status: string }>).map(t => t.status)).toEqual(['merged', 'merged'])
  }))
})

describe('work status', () => {
  test('shows every task with its state, sweeps expired leases, and finds the board by slug, by the session or as the only one', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, approvedPlan())
    const none = await workStatus(undefined, ctxAt(repo, NOW), undefined)
    expect(none.data['error']).toBe('no_board')
    const pub = await workPublish({ planPath: plan, leaseSec: 1 }, ctxAt(repo, NOW), LEAD)
    const path = String(pub.data['path'])
    updateBoard(path, NOW, b => claim(b, 1, { harness: 'codex', session: 'worker-codex-1' }, NOW, 'tok'))
    const live = await workStatus('rate-limit', ctxAt(repo, NOW + 500), undefined)
    expect(live.code).toBe(0)
    expect(live.lines[0]).toContain('1 claimed')
    expect(live.lines).toContain('Task 1 claimed by codex worker-codex… (lease 1 s): Step 1')
    expect(live.data['summary']).toMatchObject({ claimed: 1, open: 2, workers: 1, total: 3 })
    const stale = await workStatus(undefined, ctxAt(repo, NOW + 2000), LEAD)
    expect(stale.lines).toContain('Task 1 stale (was codex worker-codex…): Step 1')
    expect((stale.data['tasks'] as Array<{ status: string, worker?: unknown }>)[0]).toMatchObject({ status: 'stale' })
    expect(readBoard(path)?.tasks[0]?.status).toBe('stale')
    const only = await workStatus(undefined, ctxAt(repo, NOW + 3000), undefined)
    expect(only.data['slug']).toBe('rate-limit')
    const facts = await repoFacts(repo)
    if (facts === undefined) throw new Error('no repo facts')
    expect(resolveBoardPath('Not Valid', facts, undefined)).toMatchObject({ data: { error: 'usage' } })
    expect((await workStatus('other', ctxAt(repo, NOW), undefined)).data['error']).toBe('no_board')
  }))

  test('lists the standby workers on one line and in the JSON, and drops one that stopped refreshing its entry', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plan-build', '2026-11-07-rate-limit.md')
    write(plan, approvedPlan())
    const pub = await workPublish({ planPath: plan }, ctxAt(repo, NOW), LEAD)
    const path = String(pub.data['path'])
    const none = await workStatus('rate-limit', ctxAt(repo, NOW), undefined)
    expect(none.data['standby']).toEqual([])
    expect(none.lines.some(l => l.startsWith('Standby:'))).toBe(false)
    updateBoard(path, NOW, b => ({ ok: true, board: setStandby(setStandby(b, { harness: 'codex', session: 'worker-codex-1' }, NOW), { harness: 'omp', session: 'w2' }, NOW + 60_000) }))
    const st = await workStatus('rate-limit', ctxAt(repo, NOW + 120_000), undefined)
    expect(st.data['standby']).toEqual([
      { harness: 'codex', session: 'worker-codex-1', since: NOW, at: NOW, waitedSec: 120 },
      { harness: 'omp', session: 'w2', since: NOW + 60_000, at: NOW + 60_000, waitedSec: 60 },
    ])
    expect(st.lines).toContain('Standby: worker (codex worker-codex…, 120 s), worker (omp w2, 60 s)')
    // The first entry is older than STANDBY_STALE_MS by now: the status sweeps it.
    const later = await workStatus('rate-limit', ctxAt(repo, NOW + STANDBY_STALE_MS + 1000), undefined)
    expect((later.data['standby'] as Array<{ session: string }>).map(s => s.session)).toEqual(['w2'])
    expect(readBoard(path)?.standby?.map(s => s.session)).toEqual(['w2'])
  }))
})

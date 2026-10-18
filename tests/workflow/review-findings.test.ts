import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig } from '../../src/core/config'
import { validatePlan } from '../../src/core/plan/format'
import { stopGuardVerdict } from '../../src/core/plan/state'
import { userConfigFile } from '../../src/engine/paths'
import { evidenceBlockers, planApproveResult, planRegister, planSet, planVerify } from '../../src/workflow/plan'
import { analyzePlan, planSections, planTitle, sectionFilled } from '../../src/workflow/plan-file'
import { projectSync } from '../../src/workflow/project'
import { reviewScope } from '../../src/workflow/review-scope'
import { checkRoutingTable, lintRulesDir, loadRoutingData } from '../../src/workflow/rules'
import { loadState } from '../../src/workflow/session-store'
import { commitMessage, worktreeCreate, worktreeRoot, worktreeSync } from '../../src/workflow/worktree'
import { repoFacts } from '../../src/workflow/gitx'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { SESSION, ctxAt, evidenceSections, g, makeRepo, planDoc, write } from './fixture'

const S = SESSION

function sandbox(fn: (root: string) => Promise<void>): Promise<void> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1' }, () => fn(root)))
}

function verdict(cwd: string) {
  const st = loadState(S.harness, S.sessionId)
  const path = st.plan?.path
  const exists = path !== undefined && existsSync(path)
  const findings = exists && st.plan?.phase === 'plan' ? validatePlan(readFileSync(path, 'utf8')) : []
  return stopGuardVerdict(st, { harness: S.harness, sessionId: S.sessionId, cwd, now: Date.now(), hookActive: false, lastMessage: 'Done for now.' }, defaultConfig().plan, { exists, findings })
}

async function planRepo(root: string, doc: string): Promise<{ repo: string, plan: string }> {
  const repo = await makeRepo(root)
  const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
  write(plan, doc)
  return { repo, plan }
}

describe('WF-01: plan set phase done goes through verify', () => {
  test('an unverified IN_PROGRESS plan: exit 2, phase unchanged, and the stop guard still blocks', () => sandbox(async root => {
    const { repo, plan } = await planRepo(root, planDoc({ status: 'IN_PROGRESS', approved: true }))
    const ctx = ctxAt(repo)
    await planRegister(plan, 'implement', ctx, S)
    expect(verdict(repo).why).toBe('blocked')
    const r = await planSet('phase', 'done', ctx, S)
    expect(r.code).toBe(2)
    expect(r.data).toMatchObject({ refused: true, action: 'set phase done' })
    expect((r.data['reasons'] as string[]).some(x => x.includes('not COMPLETE'))).toBe(true)
    expect(loadState(S.harness, S.sessionId).plan).toMatchObject({ status: 'IN_PROGRESS', phase: 'implement' })
    expect(analyzePlan(readFileSync(plan, 'utf8')).phase).toBeUndefined()
    const v = verdict(repo)
    expect(v.decision.action).toBe('block')
    expect(v.why).toBe('blocked')
  }))

  test('an unapproved PENDING plan cannot jump to done either', () => sandbox(async root => {
    const { repo, plan } = await planRepo(root, planDoc())
    const ctx = ctxAt(repo)
    await planRegister(plan, 'plan', ctx, S)
    const r = await planSet('phase', 'done', ctx, S)
    expect(r.code).toBe(2)
    expect((r.data['reasons'] as string[]).some(x => x.includes('not approved'))).toBe(true)
    expect(loadState(S.harness, S.sessionId).plan?.phase).toBe('plan')
  }))

  test('on a COMPLETE plan with ticks and evidence it is the verify transition (VERIFIED, done)', () => sandbox(async root => {
    const { repo, plan } = await planRepo(root, planDoc({ status: 'COMPLETE', approved: true, done: 2, evidence: true }))
    const ctx = ctxAt(repo)
    await planRegister(plan, 'verify', ctx, S)
    expect((await planApproveResult(ctx, S)).code).toBe(0)
    const r = await planSet('phase', 'done', ctx, S)
    expect(r.code).toBe(0)
    expect(loadState(S.harness, S.sessionId).plan).toMatchObject({ status: 'VERIFIED', phase: 'done' })
    expect(analyzePlan(readFileSync(plan, 'utf8'))).toMatchObject({ status: 'VERIFIED', phase: 'done' })
    expect(verdict(repo).why).toBe('finished')
  }))

  test('register never binds phase done to an unverified plan', () => sandbox(async root => {
    const { repo, plan } = await planRepo(root, planDoc({ status: 'IN_PROGRESS', approved: true }))
    const ctx = ctxAt(repo)
    const explicit = await planRegister(plan, 'done', ctx, S)
    expect(explicit.code).toBe(1)
    expect(loadState(S.harness, S.sessionId).plan).toBeUndefined()
    write(plan, planDoc({ status: 'IN_PROGRESS', approved: true, extraFm: 'phase: done' }))
    const inferred = await planRegister(plan, undefined, ctx, S)
    expect(inferred.code).toBe(0)
    expect(loadState(S.harness, S.sessionId).plan?.phase).toBe('implement')
    expect(inferred.errors.some(e => e.includes('phase: done'))).toBe(true)
    expect(verdict(repo).why).toBe('blocked')
    write(plan, planDoc({ status: 'VERIFIED', approved: true, done: 2 }))
    expect((await planRegister(plan, 'done', ctx, S)).code).toBe(0)
  }))
})

describe('DOC-01: plan verify refuses for missing evidence', () => {
  test('Feature: ## Evidence and ## DoD Audit, plus ## E2E Results once a scenario is named', () => {
    const base = planDoc({ status: 'COMPLETE', approved: true, done: 2 })
    expect(evidenceBlockers(base, 'Feature').map(r => /'## ([^']+)'/.exec(r)?.[1])).toEqual(['Evidence', 'DoD Audit'])
    const filled = planDoc({ status: 'COMPLETE', approved: true, done: 2, evidence: true })
    expect(evidenceBlockers(filled, 'Feature')).toEqual([])
    const withScenario = filled + '\n## E2E Scenarios\n**SC-1: Burst** (covers Task 1)\n'
    expect(evidenceBlockers(withScenario, 'Feature').map(r => /'## ([^']+)'/.exec(r)?.[1])).toEqual(['E2E Results'])
    expect(evidenceBlockers(withScenario + '\n## E2E Results\n| Scenario | Result |\n|---|---|\n| SC-1 | pass |\n', 'Feature')).toEqual([])
  })

  test('Bugfix needs the RED proof; Build only ## Evidence; skeleton placeholders and a bare table header do not count', () => {
    const bug = planDoc({ type: 'Bugfix', status: 'COMPLETE', approved: true, done: 2 })
    expect(evidenceBlockers(bug, 'Bugfix').map(r => /'## ([^']+)'/.exec(r)?.[1])).toEqual(['Evidence', 'RED Evidence'])
    expect(evidenceBlockers(planDoc({ type: 'Bugfix', status: 'COMPLETE', approved: true, done: 2, evidence: true }), 'Bugfix')).toEqual([])
    const build = planDoc({ type: 'Build', status: 'COMPLETE', approved: true, done: 2 })
    expect(evidenceBlockers(build, 'Build').length).toBe(1)
    expect(evidenceBlockers(build + '\n## Evidence\n| Layer | Result |\n|---|---|\n| Tests | pass |\n', 'Build')).toEqual([])
    expect(evidenceBlockers('---\nstatus: SAVED\ntype: Plan\n---\n# x\n', 'Plan')).toEqual([])
    expect(sectionFilled(['<!-- one row per check -->', ''])).toBe(false)
    expect(sectionFilled(['| Check | Command | Result |', '|---|---|---|'])).toBe(false)
    expect(sectionFilled(['- `bun test`: 12 pass'])).toBe(true)
    expect(planSections('# T\n\n## Evidence\nrow\n```\n## not a heading\n```\n## Next\n').get('Evidence')).toEqual(['row', '```', '## not a heading', '```'])
  })

  test('verify on a COMPLETE, ticked plan without evidence: exit 2 naming the missing sections', () => sandbox(async root => {
    const { repo, plan } = await planRepo(root, planDoc({ status: 'COMPLETE', approved: true, done: 2 }))
    const ctx = ctxAt(repo)
    await planRegister(plan, 'verify', ctx, S)
    const r = await planVerify(ctx, S)
    expect(r.code).toBe(2)
    expect((r.data['reasons'] as string[]).filter(x => x.startsWith('missing evidence')).length).toBe(2)
    expect(loadState(S.harness, S.sessionId).plan?.status).toBe('COMPLETE')
    writeFileSync(plan, readFileSync(plan, 'utf8') + '\n' + evidenceSections('Feature').join('\n'))
    expect((await planApproveResult(ctx, S)).code).toBe(0)
    expect((await planVerify(ctx, S)).code).toBe(0)
  }))
})

describe('WF-02: worktree sync never stashes the plan file', () => {
  async function tracked(root: string): Promise<{ repo: string, plan: string, wt: string }> {
    const repo = await makeRepo(root)
    const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
    write(plan, planDoc())
    await g(repo, 'add', '-A')
    await g(repo, 'commit', '-q', '-m', 'docs: plan')
    const ctx = ctxAt(repo)
    await planRegister(plan, 'plan', ctx, S)
    for (const [f, v] of [['approved', 'true'], ['status', 'APPROVED'], ['phase', 'implement']] as const) expect((await planSet(f, v, ctx, S)).code).toBe(0)
    const wt = String((await worktreeCreate('rate-limit', {}, ctx, S)).data['path'])
    await planSet('status', 'IN_PROGRESS', ctx, S)
    write(join(wt, 'src', 'app.ts'), 'export const a = 2\n')
    await g(wt, 'commit', '-qam', 'task 1')
    writeFileSync(plan, readFileSync(plan, 'utf8').replace(/- \[ \] Task (\d) done/g, '- [x] Task $1 done') + '\n' + evidenceSections('Feature').join('\n'))
    expect((await planSet('status', 'COMPLETE', ctx, S)).code).toBe(0)
    expect((await planSet('phase', 'verify', ctx, S)).code).toBe(0)
    return { repo, plan, wt }
  }

  test('exit 2 (the user WIP conflicts): the plan keeps its state, the stash holds only the WIP, verify succeeds', () => sandbox(async root => {
    const { repo, plan } = await tracked(root)
    const before = readFileSync(plan, 'utf8')
    write(join(repo, 'src', 'app.ts'), 'export const a = 99 // user WIP\n')
    const r = await worktreeSync('rate-limit', ctxAt(repo), S)
    expect(r.code).toBe(2)
    expect(r.data).toMatchObject({ merged: true, planFiles: ['docs/plans/2026-10-08-rate-limit.md'] })
    expect(readFileSync(plan, 'utf8')).toBe(before)
    expect(await g(repo, 'stash', 'show', '--name-only', 'stash@{0}')).toBe('src/app.ts')
    expect(await g(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/app.ts')
    expect((await planApproveResult(ctxAt(repo), S)).code).toBe(0)
    expect((await planVerify(ctxAt(repo), S)).code).toBe(0)
  }))

  test('a staged plan file stays staged and stays out of the squash commit', () => sandbox(async root => {
    const { repo, plan } = await tracked(root)
    await g(repo, 'add', plan)
    writeFileSync(plan, readFileSync(plan, 'utf8') + '\n## Review Notes\n- unstaged note\n')
    const r = await worktreeSync('rate-limit', ctxAt(repo), S)
    expect(r.code).toBe(0)
    expect(await g(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('src/app.ts')
    expect(await g(repo, 'status', '--porcelain')).toBe('MM docs/plans/2026-10-08-rate-limit.md')
    expect(await g(repo, 'stash', 'list')).toBe('')
  }))

  test('the branch also changed the dirty registered plan: nothing merged, nothing stashed', () => sandbox(async root => {
    const { repo, plan, wt } = await tracked(root)
    const before = readFileSync(plan, 'utf8')
    write(join(wt, 'docs', 'plans', '2026-10-08-rate-limit.md'), planDoc({ title: 'Edited in the worktree' }))
    await g(wt, 'commit', '-qam', 'plan edit in the worktree')
    const head = await g(repo, 'rev-parse', 'HEAD')
    const r = await worktreeSync('rate-limit', ctxAt(repo), S)
    expect(r.code).toBe(1)
    expect(r.data['error']).toBe('plan_conflict')
    expect(await g(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(readFileSync(plan, 'utf8')).toBe(before)
    expect(await g(repo, 'stash', 'list')).toBe('')
  }))
})

describe('WF-03: project sync in a worktree keeps the other checkouts\' exclude entries', () => {
  test("main's untracked skill link stays excluded after a sync run inside a plan worktree", () => sandbox(async root => {
    const repo = await makeRepo(root)
    write(join(repo, 'AGENTS.md'), '# rules\n')
    write(join(repo, '.agents', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: a\n---\nbody\n')
    await g(repo, 'add', '-A')
    await g(repo, 'commit', '-q', '-m', 'skill alpha')
    const wt = String((await worktreeCreate('feat-x', {}, ctxAt(repo), undefined)).data['path'])
    write(join(repo, '.agents', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\ndescription: b\n---\nbody\n')
    await g(repo, 'add', '-A')
    await g(repo, 'commit', '-q', '-m', 'skill beta')
    expect((await projectSync('sync', ctxAt(repo), undefined)).code).toBe(0)
    expect(await g(repo, 'status', '--porcelain')).toBe('')
    const r = await projectSync('sync', ctxAt(wt), undefined)
    expect(r.code).toBe(0)
    expect((r.data['exclude'] as { removed: string[] }).removed).toEqual([])
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.claude/skills/beta')
    expect(await g(repo, 'status', '--porcelain')).toBe('')
    await g(repo, 'rm', '-rq', '.agents/skills/beta')
    await g(repo, 'commit', '-q', '-m', 'drop beta')
    const again = await projectSync('sync', ctxAt(repo), undefined)
    expect((again.data['exclude'] as { removed: string[] }).removed).toEqual(['/.claude/skills/beta'])
  }))
})

describe('WF-08: a title ending in # keeps it', () => {
  test("'# Add support for C#' reads back whole; a real closing sequence is still dropped", () => {
    expect(planTitle('# Add support for C#\n')).toBe('Add support for C#')
    expect(planTitle('# F# and C# #\n')).toBe('F# and C#')
    expect(planTitle('# Title ##\n')).toBe('Title')
    expect(analyzePlan(planDoc({ title: 'Add support for C#' })).title).toBe('Add support for C#')
    expect(commitMessage({ title: 'Add support for C#', type: 'Feature', prefix: 'plan-build', slug: 'c', branch: 'plan-build/c', base: 'main', commits: [] }).subject).toBe('feat: add support for C#')
  })
})

describe('WF-09: plan.worktreeDir with ~', () => {
  test('~/… expands to the home directory; no literal ~ directory appears in the repository', () => withSandbox(async ({ root, home }) => withEnv({ BURACLE_NO_MEMORY: '1' }, async () => {
    const repo = await makeRepo(root)
    write(userConfigFile(), 'plan:\n  worktreeDir: ~/worktrees\n')
    const facts = await repoFacts(repo)
    expect(worktreeRoot(facts!)).toBe(join(home, 'worktrees'))
    const r = await worktreeCreate('tilde-probe', {}, ctxAt(repo), undefined)
    expect(r.code).toBe(0)
    expect(String(r.data['path']).startsWith(join(home, 'worktrees'))).toBe(true)
    expect(existsSync(join(repo, '~'))).toBe(false)
    write(userConfigFile(), 'plan:\n  worktreeDir: ~other/wt\n')
    expect(worktreeRoot(facts!)).toBe(join(repo, '.worktrees'))
  })))
})

describe('WF-10: review-scope base selection', () => {
  test('on the default branch the warning says so and points to --base; --base reviews committed work', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const first = await g(repo, 'rev-parse', 'HEAD')
    write(join(repo, 'src', 'b.ts'), 'b\n')
    await g(repo, 'add', '-A')
    await g(repo, 'commit', '-q', '-m', 'second')
    const r = await reviewScope(undefined, ctxAt(repo), undefined)
    expect(String(r.data['warning'])).toContain('HEAD is the default branch (main)')
    expect(String(r.data['warning'])).toContain('--base')
    const based = await reviewScope(undefined, ctxAt(repo), undefined, { base: first })
    expect(based.data).toMatchObject({ mode: 'branch', base_ref: first, diff_range: `${first}...main`, ahead: 1 })
    expect(based.data['warning']).toBeUndefined()
    expect((await reviewScope(undefined, ctxAt(repo), undefined, { base: 'no-such-branch' })).code).toBe(1)
  }))

  test('a repository whose default branch is develop: committed feature work is found', () => sandbox(async root => {
    const dir = join(root, 'dev')
    mkdirSync(dir)
    await g(dir, 'init', '-q', '-b', 'develop')
    write(join(dir, 'x.txt'), 'x\n')
    await g(dir, 'add', '-A')
    await g(dir, 'commit', '-q', '-m', 'init')
    await g(dir, 'checkout', '-q', '-b', 'feature2')
    write(join(dir, 'x.txt'), 'y\n')
    await g(dir, 'commit', '-qam', 'f2')
    const r = await reviewScope(undefined, ctxAt(dir), undefined)
    expect(r.data).toMatchObject({ mode: 'branch', base_ref: 'develop', diff_range: 'develop...feature2', ahead: 1 })
    expect(r.data['warning']).toBeUndefined()
  }))

  test('--base also replaces the base of a plan worktree', () => sandbox(async root => {
    const repo = await makeRepo(root)
    const wt = String((await worktreeCreate('rate-limit', {}, ctxAt(repo), undefined)).data['path'])
    write(join(wt, 'src', 'x.ts'), 'x\n')
    await g(wt, 'add', '-A')
    await g(wt, 'commit', '-q', '-m', 'task')
    const first = await g(repo, 'rev-list', '--max-parents=0', 'HEAD')
    expect((await reviewScope('rate-limit', ctxAt(repo), undefined, { base: first })).data).toMatchObject({ mode: 'worktree', base_ref: first, diff_range: `${first}...plan-build/rate-limit` })
  }))
})

describe('DOC-02: rules lint checks the routing list', () => {
  test('unknown servers in the table and routed servers missing from it are errors; canonical is clean', () => {
    const data = { servers: new Set(['context7', 'web-search', 'codegraph']), tools: new Set(['rg']), routed: new Set(['web-search', 'codegraph']) }
    const table = (a: string, b: string) => `# Tool routing\n\n| Need | Use first | Fallback |\n|---|---|---|\n| Docs | \`context7\` | \`${a}\` |\n| Callers | \`${b}\` | \`rg\` plus reading |\n| Memory | \`memory_search\` | \`buracle mem search "<q>"\` |\n`
    expect(checkRoutingTable('t.md', table('web-search', 'codegraph'), data)).toEqual([])
    const bad = checkRoutingTable('t.md', table('bogus-search', 'nonexistent-graph'), data)
    expect(bad.map(f => f.code).sort()).toEqual(['routing-missing', 'routing-missing', 'routing-unknown', 'routing-unknown'])
    expect(checkRoutingTable('t.md', '# No table here\n', data)).toEqual([])
    const canonical = loadRoutingData(join(import.meta.dir, '..', '..', 'canonical', 'rules'))
    expect(canonical?.routed.has('web-search')).toBe(true)
  })

  test('a copy of canonical/rules with a drifted table fails lint', () => withSandbox(({ root }) => {
    const src = join(import.meta.dir, '..', '..', 'canonical', 'rules')
    const copy = join(root, 'rules-copy')
    mkdirSync(join(copy, 'always'), { recursive: true })
    for (const n of readdirSync(join(src, 'always'))) {
      const text = readFileSync(join(src, 'always', n), 'utf8')
      writeFileSync(join(copy, 'always', n), n === 'tooling.md' ? text.replaceAll('`web-search`', '`bogus-search`') : text)
    }
    const { findings } = lintRulesDir(copy, root)
    expect(findings.filter(f => f.code === 'routing-unknown').map(f => f.message)[0]).toContain('bogus-search')
    expect(findings.some(f => f.code === 'routing-missing' && f.message.includes('web-search'))).toBe(true)
    expect(lintRulesDir(src, root).findings.filter(f => f.code.startsWith('routing-'))).toEqual([])
  }))
})

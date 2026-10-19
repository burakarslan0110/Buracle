import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runPlan } from '../../src/cli/commands/plan'
import type { Harness } from '../../src/core/events'
import { tomlParse } from '../../src/engine/merge'
import { userConfigFile } from '../../src/engine/paths'
import { companionCancel, companionCollect, companionRun, companionStart, type CompanionDeps } from '../../src/workflow/companion'
import { codexArgv, codexMcpServers } from '../../src/workflow/companion-hosts'
import { jobFile, readJobAt, writeJobAt } from '../../src/workflow/companion-job'
import { planRegister, planSet } from '../../src/workflow/plan'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { loadState } from '../../src/workflow/session-store'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { SESSION, ctxAt, evidenceSections, g, makeRepo, memIO, planDoc, write } from './fixture'

const HARNESS_BINS: readonly Harness[] = ['claude', 'codex', 'opencode', 'omp']

const FAKE = `#!/bin/sh
name="$(basename "$0")"
d="$FAKE_DIR"
{
  printf 'ARGV'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'
  printf 'CWD %s\\n' "$(pwd -P)"
  printf 'ENV no_memory=%s runner=%s no_capture=%s claude_sid=%s buracle_sid=%s reviewer=%s\\n' "$BURACLE_NO_MEMORY" "$BURACLE_MEMORY_RUNNER" "$BURACLE_NO_CAPTURE" "\${CLAUDE_CODE_SESSION_ID-unset}" "\${BURACLE_SESSION_ID-unset}" "\${BURACLE_REVIEWER_AGENT-unset}"
} > "$d/$name.log"
cat > "$d/$name.stdin"
if [ -f .opencode/agents/buracle-companion.md ]; then cp .opencode/agents/buracle-companion.md "$d/$name.agent.md"; cp .opencode/opencode.json "$d/$name.config.json"; fi
mode="$(cat "$d/$name.mode" 2>/dev/null)"
case "$mode" in
  fail) echo "provider says no" >&2; exit 3 ;;
  hang) sleep 30 ;;
esac
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
if [ -n "$out" ]; then cat "$d/$name.answer" > "$out"; echo "codex: session finished"; else cat "$d/$name.answer"; fi
`

interface World { root: string, repo: string, fake: string, plan: string, s: ResolvedSession }

function fakeBins(root: string): string {
  const dir = join(root, 'fake')
  mkdirSync(join(dir, 'bin'), { recursive: true })
  for (const h of HARNESS_BINS) {
    writeFileSync(join(dir, 'bin', h), FAKE)
    chmodSync(join(dir, 'bin', h), 0o755)
  }
  return dir
}

function answer(w: World, h: Harness, text: string, mode?: 'fail' | 'hang'): void {
  writeFileSync(join(w.fake, `${h}.answer`), text)
  if (mode !== undefined) writeFileSync(join(w.fake, `${h}.mode`), mode)
}

function seen(w: World, h: Harness, part: 'log' | 'stdin' | 'agent.md' | 'config.json'): string {
  const f = join(w.fake, `${h}.${part}`)
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

function setting(value: string, extra = ''): void {
  write(userConfigFile(), `version: 1\nplan:\n  reviews:\n    companion: ${JSON.stringify(value)}\n${extra}`)
}

function only(w: World, list: readonly Harness[]): CompanionDeps['which'] {
  return bin => (list.includes(bin as Harness) ? join(w.fake, 'bin', bin) : null)
}

function decoy(): number {
  const p = Bun.spawn(['sleep', '120'], { env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore'], detached: true })
  p.unref()
  return p.pid
}

function inline(w: World, list: readonly Harness[] = HARNESS_BINS): CompanionDeps & { done: () => Promise<number> } {
  let pending: Promise<number> = Promise.resolve(0)
  let pid: number | undefined
  return {
    which: only(w, list),
    spawnRunner: file => { pid = decoy(); pending = companionRun(file, { pid }); return pid },
    done: async () => { const code = await pending; if (pid !== undefined) { try { process.kill(pid) } catch {  } } return code },
  }
}

function planReport(file: string): string {
  return JSON.stringify({
    verdict: 'needs_changes',
    summary: `${file}: the plan never tests the 429 body.`,
    findings: [{ severity: 'should_fix', category: 'missing_test', title: 'No test for the 429 response body', file, line: 14, evidence: 'Task 1 DoD names only the status code.', suggested_fix: 'Add a test that checks the Retry-After header and the JSON body.' }],
  })
}

function changesReport(file: string): string {
  return JSON.stringify({
    verdict: 'pass',
    summary: `${file}: the limiter works and is covered.`,
    findings: [],
    truths: [{ truth: 'Requests over the limit get 429', status: 'verified', evidence: 'src/limit.ts:1' }],
  })
}

async function world(root: string, type = 'Feature'): Promise<World> {
  const repo = await makeRepo(root)
  const fake = fakeBins(root)
  const plan = join(repo, 'docs', 'plans', '2026-10-08-rate-limit.md')
  write(plan, [planDoc({ type, status: 'COMPLETE', approved: true, n: 1, done: 1 }), ...evidenceSections(type)].join('\n'))
  await planRegister(plan, 'plan', ctxAt(repo), SESSION)
  return { root, repo: realpathSync(repo), fake, plan, s: SESSION }
}

function sandbox(fn: (root: string) => Promise<void>): Promise<void> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000', FAKE_DIR: join(root, 'fake'), PATH: `${join(root, 'fake', 'bin')}:${process.env['PATH'] ?? ''}` }, () => fn(root)))
}

describe.skipIf(process.platform === 'win32')('second opinion (plan.reviews.companion)', () => {
  test('off by default: start launches nothing, records nothing, and no gate warns about it', () => sandbox(async root => {
    const w = await world(root)
    const deps = inline(w)
    const r = await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, deps)
    expect(r.code).toBe(0)
    expect(r.data['state']).toBe('off')
    expect(existsSync(jobFile(w.s, 'plan'))).toBe(false)
    expect(loadState('claude', w.s.sessionId).reviews ?? []).toEqual([])
  }))

  test('auto: a Claude Code session gets Codex first, read-only, with the reviewer instructions and the native inputs; collect records the verdict', () => sandbox(async root => {
    const w = await world(root)
    setting('auto')
    answer(w, 'codex', planReport(w.plan))
    const deps = inline(w)
    const started = await companionStart({ role: 'plan', input: 'plan-build-review\nplan_file: /elsewhere.md\nuser_request: rate-limit the API, 100 per minute\nReturn only your JSON report.' }, ctxAt(w.repo), w.s, deps)
    expect(started.code).toBe(0)
    expect(started.data['state']).toBe('running')
    expect(started.lines[0]).toContain('plan-build-review on codex, then opencode')
    const running = loadState('claude', w.s.sessionId).reviews ?? []
    expect(running).toEqual([expect.objectContaining({ role: 'plan', state: 'running', companion: true, provider: 'codex', handle: expect.stringMatching(/^cmp-plan-[0-9a-f]{8}$/) })])
    expect(await deps.done()).toBe(0)

    const log = seen(w, 'codex', 'log')
    expect(log).toContain('[exec] [--ephemeral] [--skip-git-repo-check] [--sandbox] [read-only]')
    expect(log).toContain(`[-C] [${w.repo}]`)
    expect(log).toContain('ENV no_memory=1 runner=1 no_capture=1 claude_sid=unset buracle_sid=unset reviewer=plan-build-review')
    const prompt = seen(w, 'codex', 'stdin')
    expect(prompt).toContain('You are a second-opinion reviewer running on Codex. A Claude Code session asked for this review')
    expect(prompt).toContain(`plan_file: ${w.plan}`)
    expect(prompt).not.toContain('/elsewhere.md')
    expect(prompt).toContain('user_request: rate-limit the API, 100 per minute')
    expect(prompt).toContain('## Inputs')
    expect(prompt.match(/Return only your JSON report\./g)?.length).toBe(1)

    const collected = await companionCollect({ role: 'plan' }, ctxAt(w.repo), w.s, deps)
    expect(collected.code).toBe(0)
    expect(collected.data['state']).toBe('done')
    expect((collected.data['report'] as { verdict: string }).verdict).toBe('needs_changes')
    expect(collected.lines[0]).toBe('Second opinion from codex (plan-build-review): needs_changes, 1 finding(s).')
    expect(collected.lines.join('\n')).toContain('- [should_fix] missing_test: No test for the 429 response body')
    const rec = (loadState('claude', w.s.sessionId).reviews ?? []).find(r => r.companion === true)
    expect(rec).toMatchObject({ role: 'plan', state: 'collected', verdict: 'needs_changes', provider: 'codex', fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect((loadState('claude', w.s.sessionId).reviews ?? []).filter(r => r.companion !== true)).toEqual([])

    const again = await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, deps)
    expect(again.data['state']).toBe('done')
    expect(again.lines[0]).toContain('it runs once per plan and role')
  }))

  test('one retry on the next harness: Codex fails, OpenCode answers from a scratch project with a primary read-only agent and hard-deny policies', () => sandbox(async root => {
    const w = await world(root)
    setting('auto')
    answer(w, 'codex', '', 'fail')
    answer(w, 'opencode', `Reviewing...\n| Read ${w.plan}\nHere is my report:\n${planReport(w.plan)}\n`)
    const deps = inline(w)
    await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, deps)
    await deps.done()
    const job = readJobAt(jobFile(w.s, 'plan'))
    expect(job?.state).toBe('done')
    expect(job?.reportBy).toBe('opencode')
    expect(job?.attempts.map(a => [a.harness, a.error?.replace(/exit 3.*/, 'exit 3')])).toEqual([['codex', 'codex: exit 3'], ['opencode', undefined]])
    const log = seen(w, 'opencode', 'log')
    expect(log).toContain('ARGV [run] [--standalone] [--agent] [buracle-companion] [--title] [Buracle second opinion]')
    expect(log).toMatch(/CWD \S*\/buracle-runner-companion-[^/\s]+\n/)
    const scratch = /CWD (\S+)\n/.exec(log)?.[1] as string
    expect(existsSync(scratch)).toBe(false)
    const agent = seen(w, 'opencode', 'agent.md')
    expect(agent).toContain('mode: "primary"')
    expect(agent).toContain('{ action: "*", resource: "*", effect: "deny" }')
    expect(agent).toContain('{ action: "external_directory", resource: "*", effect: "allow" }')
    expect(agent).toContain(`{ action: "shell", resource: "git -C ${w.repo} diff *", effect: "allow" }`)
    expect(agent).not.toContain('git -C * diff')
    expect(agent).not.toContain('buracle review-scope')
    expect(agent.trimEnd().split('\n').filter(l => l.includes('effect')).at(-1)).toContain('{ action: "edit", resource: "*", effect: "deny" }')
    const policies = (JSON.parse(seen(w, 'opencode', 'config.json')) as { policies: Array<{ action: string, resource: string, effect: string }> }).policies
    expect(policies[0]).toEqual({ action: 'tool.use', resource: '*', effect: 'deny' })
    expect(policies.at(-1)).toEqual({ action: 'tool.use', resource: 'edit:*', effect: 'deny' })
    expect(policies).toContainEqual({ action: 'tool.use', resource: 'read:*', effect: 'allow' })
    expect(policies.some(p => p.resource.startsWith('shell:git push'))).toBe(false)
    expect(seen(w, 'opencode', 'stdin')).toContain(`Your working folder is an empty scratch folder; the repository is \`${w.repo}\``)
  }))

  test('changes: the diff and the changed files are inlined; omp runs with read tools only and no shell', () => sandbox(async root => {
    const w = await world(root)
    setting('omp')
    write(join(w.repo, 'src', 'limit.ts'), 'export const limit = 100\n')
    write(join(w.repo, 'src', 'app.ts'), 'export const a = 2\n')
    answer(w, 'omp', changesReport(w.plan))
    const deps = inline(w)
    const r = await companionStart({ role: 'changes', input: 'evidence: bun test -> 12 pass' }, ctxAt(w.repo), w.s, deps)
    expect(r.data['state']).toBe('running')
    await deps.done()
    const log = seen(w, 'omp', 'log')
    expect(log).toContain('[-p] [--no-session] [--no-title] [--no-skills]')
    expect(log).toContain('[--tools=read,grep,glob]')
    expect(log).not.toContain('bash')
    expect(log).toMatch(/\[--max-time=\d+\]/)
    const prompt = seen(w, 'omp', 'stdin')
    expect(prompt).toContain('You have no shell in this run, so the diff is included below')
    expect(prompt).toContain('changed_files: src/app.ts, src/limit.ts')
    expect(prompt).toContain(`worktree_path: ${w.repo}`)
    expect(prompt).toContain('-export const a = 1')
    expect(prompt).toContain('+export const limit = 100')
    expect(prompt).toContain('evidence: bun test -> 12 pass')
    expect(log).toContain('reviewer=changes-review')
    const c = await companionCollect({ role: 'changes' }, ctxAt(w.repo), w.s, deps)
    expect(c.data['state']).toBe('done')
    const rec = (loadState('claude', w.s.sessionId).reviews ?? []).find(x => x.companion === true)
    expect(rec).toMatchObject({ role: 'changes', verdict: 'pass', files: ['src/app.ts', 'src/limit.ts'] })
  }))

  test('a Codex session asking Claude Code: print mode in dontAsk with Read, read-only git and rg, and Buracle\'s review MCP tools', () => sandbox(async root => {
    const w = await world(root)
    const codexSession: ResolvedSession = { harness: 'codex', sessionId: 'codex-sess-1', source: '--session' }
    await planRegister(w.plan, 'plan', ctxAt(w.repo), codexSession)
    setting('auto')
    const fencedVerdict = { verdict: 'needs-attention', summary: 'The plan misses the retry path.', findings: [{ severity: 'high', title: 'No retry after a 429', body: 'Task 1 never says what a client does after 429.', file: w.plan, line_start: 12, line_end: 14, confidence: 0.8, recommendation: 'Add the Retry-After contract to Task 1.' }], next_steps: ['fix it'] }
    answer(w, 'claude', JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: `\`\`\`json\n${JSON.stringify(fencedVerdict)}\n\`\`\`` }))
    const deps = inline(w)
    await companionStart({ role: 'plan' }, ctxAt(w.repo), codexSession, deps)
    await deps.done()
    const log = seen(w, 'claude', 'log')
    expect(log).toContain('ARGV [-p] [--output-format] [json] [--no-session-persistence] [--setting-sources] [user] [--permission-mode] [dontAsk] [--tools] [Read,Bash]')
    expect(log).toContain('[--allowedTools] [Read,Bash(git status *),Bash(git diff *),')
    expect(log).toContain('Bash(rg *),mcp__plugin_buracle_codegraph__*,mcp__plugin_buracle_semble__*,mcp__plugin_buracle_context7__*]')
    expect(log).toContain('[--disallowedTools] [Write,Edit,NotebookEdit,Bash(git *--output*),Bash(rg *--pre*),Bash(rg *--hostname-bin*)]')
    expect(log).not.toContain('git -C')
    const job = readJobAt(jobFile(codexSession, 'plan'))
    expect(job?.state).toBe('done')
    expect(job?.repaired).toBe(true)
    expect(job?.report).toEqual({
      verdict: 'needs_changes',
      summary: `${w.plan}: The plan misses the retry path.`,
      findings: [{ severity: 'must_fix', category: 'risk', title: 'No retry after a 429', evidence: 'Task 1 never says what a client does after 429.', suggested_fix: 'Add the Retry-After contract to Task 1.', file: w.plan, line: 12 }],
    })
  }))

  test('no other harness on PATH: unavailable, recorded as incomplete, so the gate stays quiet; a later start may try again', () => sandbox(async root => {
    const w = await world(root, 'Feature')
    setting('auto')
    write(w.plan, planDoc())
    await planRegister(w.plan, 'plan', ctxAt(w.repo), w.s)
    const deps = inline(w, [])
    const r = await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, deps)
    expect(r.data['state']).toBe('unavailable')
    expect(r.lines[0]).toStartWith('No second opinion: no other harness can give a second opinion now: codex: its command is not on PATH; opencode: its command is not on PATH; omp: its command is not on PATH.')
    expect((loadState('claude', w.s.sessionId).reviews ?? []).find(x => x.companion === true)).toMatchObject({ state: 'collected', verdict: 'incomplete', note: expect.stringContaining('not on PATH') })
    const warn = await planSet('approved', 'true', ctxAt(w.repo), w.s)
    expect(warn.errors.some(e => e.includes('second opinion'))).toBe(false)
    answer(w, 'codex', planReport(w.plan))
    const later = inline(w, ['codex'])
    expect((await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, later)).data['state']).toBe('running')
    await later.done()
  }))

  test('the approval gate warns while the second opinion is on and missing, or running and not collected', () => sandbox(async root => {
    const w = await world(root, 'Feature')
    setting('codex')
    write(w.plan, planDoc())
    await planRegister(w.plan, 'plan', ctxAt(w.repo), w.s)
    const missing = await planSet('approved', 'true', ctxAt(w.repo), w.s)
    expect(missing.errors).toContainEqual(expect.stringContaining("plan.reviews.companion is on and no second opinion is recorded for plan-build-review: run 'buracle plan review companion start --role plan'"))
    write(w.plan, planDoc())
    await planRegister(w.plan, 'plan', ctxAt(w.repo), w.s)
    answer(w, 'codex', planReport(w.plan), 'hang')
    const deps = inline(w, ['codex'])
    await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, deps)
    for (let i = 0; i < 100 && readJobAt(jobFile(w.s, 'plan'))?.childPid === undefined; i++) await Bun.sleep(50)
    const running = await planSet('approved', 'true', ctxAt(w.repo), w.s)
    expect(running.errors).toContainEqual(expect.stringContaining('the second opinion plan-build-review second opinion on codex (job cmp-plan-'))
    const t0 = Date.now()
    const cancelled = await companionCancel({ role: 'plan' }, ctxAt(w.repo), w.s)
    expect(cancelled.data['state']).toBe('cancelled')
    await deps.done()
    expect(Date.now() - t0).toBeLessThan(8_000)
    expect(readJobAt(jobFile(w.s, 'plan'))?.state).toBe('cancelled')
    expect((loadState('claude', w.s.sessionId).reviews ?? []).find(x => x.companion === true)).toMatchObject({ state: 'collected', verdict: 'incomplete', note: 'cancelled' })
  }), 20_000)

  test('the time budget: a harness that does not answer is stopped and the run goes on without a second opinion', () => sandbox(async root => {
    const w = await world(root)
    setting('codex')
    answer(w, 'codex', planReport(w.plan), 'hang')
    const pid = decoy()
    const deps: CompanionDeps = { which: only(w, ['codex']), spawnRunner: () => pid }
    await companionStart({ role: 'plan', timeoutMin: '1' }, ctxAt(w.repo), w.s, deps)
    const file = jobFile(w.s, 'plan')
    const job = readJobAt(file)
    if (job === undefined) throw new Error('no job')
    writeJobAt(file, { ...job, deadline: Date.now() + 1500 })
    const t0 = Date.now()
    expect(await companionRun(file, { pid })).toBe(0)
    process.kill(pid)
    expect(Date.now() - t0).toBeLessThan(10_000)
    const done = readJobAt(file)
    expect(done?.state).toBe('failed')
    expect(done?.error).toContain('codex: no answer within 1 min')
    const c = await companionCollect({ role: 'plan' }, ctxAt(w.repo), w.s)
    expect(c.lines[0]).toBe('No second opinion for plan-build-review: codex: no answer within 1 min. Go on with plan-build-review alone and say so under ## Review Notes.')
  }), 20_000)

  test('a new plan replaces a second opinion still running for the old one: the old run is stopped and never writes into the new job', () => sandbox(async root => {
    const w = await world(root)
    setting('codex')
    answer(w, 'codex', planReport(w.plan), 'hang')
    const old = inline(w, ['codex'])
    await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, old)
    for (let i = 0; i < 100 && readJobAt(jobFile(w.s, 'plan'))?.childPid === undefined; i++) await Bun.sleep(50)
    const oldId = readJobAt(jobFile(w.s, 'plan'))?.id
    const next = join(w.repo, 'docs', 'plans', '2026-10-09-other.md')
    write(next, planDoc({ title: 'Another plan' }))
    await planRegister(next, 'plan', ctxAt(w.repo), w.s)
    answer(w, 'codex', planReport(next))
    writeFileSync(join(w.fake, 'codex.mode'), '')
    const fresh = inline(w, ['codex'])
    const t0 = Date.now()
    expect((await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, fresh)).data['state']).toBe('running')
    await old.done()
    expect(Date.now() - t0).toBeLessThan(8_000)
    await fresh.done()
    const job = readJobAt(jobFile(w.s, 'plan'))
    expect(job?.id).not.toBe(oldId)
    expect(job?.plan).toBe(next)
    expect(job?.state).toBe('done')
  }), 20_000)

  test('collect right after start: a runner that has not written its pid yet counts as starting for 30 s, then as gone', () => sandbox(async root => {
    const w = await world(root)
    setting('codex')
    const deps: CompanionDeps = { which: only(w, ['codex']), spawnRunner: () => 999_999_999 }
    await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, deps)
    const file = jobFile(w.s, 'plan')
    const { runnerPid: _gone, ...job } = readJobAt(file) as NonNullable<ReturnType<typeof readJobAt>>
    writeJobAt(file, { ...job, startedAt: Date.now() })
    expect((await companionCollect({ role: 'plan' }, ctxAt(w.repo), w.s)).data['state']).toBe('running')
    writeJobAt(file, { ...job, startedAt: Date.now() - 60_000 })
    const c = await companionCollect({ role: 'plan' }, ctxAt(w.repo), w.s)
    expect(c.data['state']).toBe('failed')
    expect(c.lines[0]).toContain('the review runner ended without a result')
  }))

  test('a report that is not valid twice fails the job with the reason', () => sandbox(async root => {
    const w = await world(root)
    setting('codex')
    answer(w, 'codex', 'I could not finish the review.')
    const deps = inline(w, ['codex'])
    await companionStart({ role: 'plan' }, ctxAt(w.repo), w.s, deps)
    await deps.done()
    const job = readJobAt(jobFile(w.s, 'plan'))
    expect(job?.state).toBe('failed')
    expect(job?.attempts.map(a => a.harness)).toEqual(['codex', 'codex'])
    expect(job?.error).toContain('the answer holds no JSON report')
  }))

  test('a bugfix without a plan reviews the diff against --goal; no plan record is written', () => sandbox(async root => {
    const repo = realpathSync(await makeRepo(root))
    const w: World = { root, repo, fake: fakeBins(root), plan: '', s: { harness: 'claude', sessionId: 'bugfix-1', source: '--session' } }
    setting('codex')
    write(join(repo, 'src', 'app.ts'), 'export const a = 3\n')
    answer(w, 'codex', JSON.stringify({ verdict: 'pass', summary: 'goal: the total is right again.', findings: [], truths: [{ truth: 'The total adds tax once', status: 'verified', evidence: 'src/app.ts:1' }] }))
    const deps = inline(w, ['codex'])
    expect((await companionStart({ role: 'plan', goal: 'x' }, ctxAt(repo), w.s, deps)).data['error']).toBe('no_plan')
    const r = await companionStart({ role: 'changes', goal: 'Given a cart, the total adds tax once' }, ctxAt(repo), w.s, deps)
    expect(r.data['state']).toBe('running')
    await deps.done()
    const prompt = seen(w, 'codex', 'stdin')
    expect(prompt).toContain('goal: Given a cart, the total adds tax once')
    expect(prompt).toContain('changed_files: src/app.ts')
    expect(prompt).not.toContain('## The diff')
    expect(prompt).not.toContain('+export const a = 3')
    expect(seen(w, 'codex', 'log')).toContain('reviewer=changes-review')
    expect(readJobAt(jobFile(w.s, 'changes'))?.state).toBe('done')
    const c = await companionCollect({ role: 'changes' }, ctxAt(repo), w.s, deps)
    expect(c.data['state']).toBe('done')
    expect(loadState('claude', w.s.sessionId).reviews ?? []).toEqual([])
  }))

  test('the real detached runner: start spawns `buracle plan review companion run`, collect --wait picks up its report', () => sandbox(async root => {
    const w = await world(root)
    setting('codex')
    answer(w, 'codex', planReport(w.plan))
    const io = { ...memIO(true), stdin: { isTTY: false, text: async () => 'plan-build-review\nuser_request: from stdin, verbatim\n' } }
    const base = memIO(true)
    const piped = { ...io, stdout: base.stdout, stderr: base.stderr }
    const code = await runPlan(['review', 'companion', 'start', '--role', 'plan', '--input', '-', '--session', w.s.sessionId, '--harness', 'claude', '--json'], piped, ctxAt(w.repo))
    expect(code).toBe(0)
    expect(base.json()['state']).toBe('running')
    const out = memIO(true)
    expect(await runPlan(['review', 'companion', 'collect', '--role', 'plan', '--wait', '60', '--session', w.s.sessionId, '--harness', 'claude', '--json'], out, ctxAt(w.repo))).toBe(0)
    expect(out.json()['state']).toBe('done')
    expect(seen(w, 'codex', 'log')).toContain('[--sandbox] [read-only]')
    expect(seen(w, 'codex', 'log')).toContain('reviewer=plan-build-review')
    expect(seen(w, 'codex', 'stdin')).toContain('user_request: from stdin, verbatim')
  }), 90_000)
})

describe('second opinion: the command line', () => {
  test('the CLI: unknown actions, --lane and companion-only flags on other review actions are refused', () => sandbox(async root => {
    const w = await world(root)
    const runIt = async (args: string[]) => { const io = memIO(false); const code = await runPlan([...args, '--session', w.s.sessionId, '--harness', 'claude'], io, ctxAt(w.repo)); return { code, err: io.err() } }
    expect((await runIt(['review', 'companion', 'launch', '--role', 'plan'])).err).toContain("plan review companion <start|collect|cancel>: unknown action 'launch'")
    expect((await runIt(['review', 'companion', 'start', '--role', 'plan', '--lane', 'x'])).err).toContain('a second opinion belongs to the lead')
    expect((await runIt(['review', 'done', '--role', 'plan', '--verdict', 'pass', '--on', 'codex'])).err).toContain("--on applies to 'plan review companion' only")
    expect((await runIt(['review', 'companion', 'collect', '--role', 'plan', '--wait', '9999'])).err).toContain('--wait must be a whole number of seconds from 0 to 600')
    expect((await runIt(['review', 'companion', 'start', '--role', 'plan', '--on', 'gemini'])).err).toContain("--on must be one of off, auto, claude, codex, opencode, omp (got 'gemini')")
    expect(await companionRun(join(root, 'elsewhere', 'job.json'))).toBe(2)
    await g(w.repo, 'status')
  }))
})

describe('second opinion: the Codex command line', () => {
  test('every MCP server of config.toml but codegraph, semble and context7 is switched off, whatever its key spelling; a config.toml that does not parse fails the attempt', () => {
    const config = [
      '[mcp_servers.github]', 'command = "gh"', '',
      '[mcp_servers."my.server"]', 'command = "x"', '',
      "[mcp_servers.'with space']", 'command = "x"', '',
      '[mcp_servers.context7]', 'command = "npx"', '',
      '[mcp_servers]', 'inline = { command = "x" }', 'codegraph = { command = "codegraph" }', '',
      '[mcp_servers."a=b"]', 'command = "x"', '',
    ].join('\n')
    expect(codexMcpServers(config)).toEqual(['github', 'my.server', 'with space', 'context7', 'inline', 'codegraph', 'a=b'])
    const argv = codexArgv('/r', '/o', config)
    expect(argv.at(-1)).toBe('-')
    const overrides = argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [a] : []))
    expect(overrides).toHaveLength(1)
    const [key, ...rest] = (overrides[0] as string).split('=')
    expect(key).toBe('mcp_servers')
    expect(tomlParse(`x = ${rest.join('=')}`)).toEqual({ x: { 'github': { enabled: false }, 'my.server': { enabled: false }, 'with space': { enabled: false }, 'inline': { enabled: false }, 'a=b': { enabled: false } } })
    expect(codexArgv('/r', '/o', '[mcp_servers.codegraph]\ncommand = "codegraph"\n')).not.toContain('-c')
    expect(codexArgv('/r', '/o', '')).not.toContain('-c')
    expect(() => codexArgv('/r', '/o', '[mcp_servers.github\ncommand = "gh"\n')).toThrow('config.toml')
  })
})

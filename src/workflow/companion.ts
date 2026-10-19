import { createHash, randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PreparedRun } from './companion-hosts'
import type { CompanionSetting } from '../core/config'
import { HARNESSES, type Harness } from '../core/events'
import {
  COMPANION_ATTEMPTS, COMPANION_DIFF_MAX, COMPANION_RETRY_MIN_MS, COMPANION_TIMEOUT_MAX_MIN, COMPANION_TIMEOUT_MIN, COMPANION_WAIT_MAX_SEC,
  acceptReview, chooseCompanion, companionInputs, companionPrompt, companionSetting, modelFamily, type CompanionCandidate,
} from '../core/plan/companion'
import { REVIEW_AGENT_OF, REVIEW_ROLES, companionOf, reviewCollected, reviewStarted, type ReviewRole, type ReviewVerdict } from '../core/plan/reviews'
import type { SessionState } from '../core/plan/state'
import type { ReviewAgent, ReviewReport } from '../core/policy/review'
import { loadCanonicalSync } from '../engine/canonical'
import { loadConfigSync } from '../engine/config'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { chooseHarnesses, latestModel } from '../memory/model'
import { sessionModel } from '../memory/runner'
import { cliArgv, moduleCheckout } from '../memory/spawn'
import {
  alive, childEnv, insideSessions, jobFile, killTree, readJob, readJobAt, readRequest, runChild, writeJobAt, writeRequest,
  type CompanionAnchor, type CompanionAttempt, type CompanionJob,
} from './companion-job'
import { git, repoFacts } from './gitx'
import { currentChangeSet, digestOf, planFingerprint, recordView } from './plan-review'
import { fail, ok, type CmdResult, type WorkflowCtx } from './result'
import { loadState, updateState, type ResolvedSession } from './session-store'

export interface CompanionDeps {
  which?: (bin: string) => string | null
  spawnRunner?: (jobPath: string) => number | undefined
  nowMs?: () => number
  sleep?: (ms: number) => Promise<void>
  pid?: number
}

const KILL_GRACE_MS = 30_000

const BIN: Readonly<Record<Harness, string>> = { claude: 'claude', codex: 'codex', opencode: 'opencode', omp: 'omp' }
const POLL_MS = 2_000

function onPath(bin: string): string | null {
  return Bun.which(bin, { PATH: process.env['PATH'] ?? '' })
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function roleOf(x: string | undefined): ReviewRole | CmdResult {
  if (x === undefined) return fail('usage', `--role is required: one of ${REVIEW_ROLES.join(', ')}`)
  const r = x.toLowerCase() as ReviewRole
  return REVIEW_ROLES.includes(r) ? r : fail('usage', `--role must be one of ${REVIEW_ROLES.join(', ')} (got '${x}')`)
}

function isResult(x: unknown): x is CmdResult {
  return x !== null && typeof x === 'object' && 'code' in x && 'lines' in x
}

function mins(ms: number): string {
  return `${Math.max(1, Math.round(ms / 60_000))} min`
}

const STARTING_GRACE_MS = 30_000

function runnerAlive(job: CompanionJob, clock: number): boolean {
  return job.runnerPid === undefined ? clock - job.startedAt < STARTING_GRACE_MS : alive(job.runnerPid)
}

export function jobView(j: CompanionJob): Record<string, unknown> {
  const v: Record<string, unknown> = { id: j.id, role: j.role, agent: j.agent, state: j.state, targets: j.targets, startedAt: j.startedAt, deadline: j.deadline, attempts: j.attempts }
  if (j.plan !== undefined) v['plan'] = j.plan
  if (j.reportBy !== undefined) v['harness'] = j.reportBy
  if (j.error !== undefined) v['error'] = j.error
  if (j.collectedAt !== undefined) v['collectedAt'] = j.collectedAt
  return v
}

function nativeOff(setting: ReturnType<typeof loadConfigSync>['config']['plan']['reviews'], role: ReviewRole, state: SessionState): boolean {
  const p = state.plan
  if (p === undefined) return false
  if (role === 'changes') return p.type !== 'Bugfix' && !(p.type === 'Build' ? (state.approvals?.switches?.changesReview ?? setting.changes) : setting.changes)
  return role === 'plan' ? !setting.plan : !setting.goal
}

function candidates(nowMs: number, enabled: Readonly<Record<Harness, { enabled: boolean }>>, which: (bin: string) => string | null): CompanionCandidate[] {
  let choice: ReturnType<typeof chooseHarnesses> = { picks: [], held: [] }
  try { choice = chooseHarnesses({ nowMs, checkCli: false }) } catch {  }
  return HARNESSES.map(h => {
    const pick = choice.picks.find(p => p.harness === h)
    const held = choice.held.find(x => x.harness === h && x.kind === 'window')
    const c: CompanionCandidate = { harness: h, enabled: enabled[h]?.enabled !== false, onPath: which(BIN[h]) !== null, recent: pick !== undefined || held !== undefined }
    if (held !== undefined) c.held = held.why.replace(new RegExp(`^${h}: `), '')
    if (pick?.used !== undefined) c.used = pick.used
    let fam: CompanionCandidate['family']
    try { fam = modelFamily(latestModel(h)) } catch { fam = undefined }
    if (fam !== undefined) c.family = fam
    return c
  })
}

function goalFrom(input: string | undefined): string | undefined {
  const m = /^\s*goal\s*:\s*(.+)$/m.exec(input ?? '')
  return m?.[1]?.trim() || undefined
}

async function diffOf(dir: string, base: string, files: readonly string[]): Promise<{ text: string, truncated: boolean }> {
  const tracked = await git(dir, ['diff', '--no-color', '--no-ext-diff', base, '--', ...files], { readOnly: true })
  let text = tracked.stdout
  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...files], { readOnly: true })
  for (const f of untracked.stdout.split('\0').filter(x => x !== '')) {
    if (text.length > COMPANION_DIFF_MAX) break
    const r = await git(dir, ['diff', '--no-color', '--no-index', '--', '/dev/null', f], { readOnly: true })
    text += r.stdout
  }
  return text.length > COMPANION_DIFF_MAX ? { text: text.slice(0, COMPANION_DIFF_MAX), truncated: true } : { text, truncated: false }
}

function defaultSpawnRunner(jobPath: string): number | undefined {
  try {
    const checkout = moduleCheckout() ?? paths.configuredRepoRoot()
    const proc = Bun.spawn([...cliArgv(), 'plan', 'review', 'companion', 'run', '--job', jobPath], {
      cwd: checkout !== undefined ? checkout : existsSync(paths.home()) ? paths.home() : '/',
      env: { ...childEnv() },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    proc.unref()
    return proc.pid
  } catch (e) {
    log('warn', 'companion: cannot start the review runner', { error: e })
    return undefined
  }
}

function record(s: ResolvedSession, job: CompanionJob, edit: (st: SessionState) => SessionState): void {
  if (job.plan === undefined) return
  try { updateState(s.harness, s.sessionId, st => (st.plan?.path === job.plan ? edit(st) : st)) } catch {  }
}

function recordCollected(s: ResolvedSession, job: CompanionJob, now: number): void {
  const verdict: ReviewVerdict = job.state === 'done' && job.report !== undefined ? job.report.verdict : 'incomplete'
  const note = job.state === 'done' ? undefined : job.error ?? job.state
  record(s, job, st => {
    const prev = companionOf(st, job.role)
    const provider = job.reportBy ?? job.targets[0]
    const base = prev?.handle === job.id ? st : reviewStarted(st, { role: job.role, handle: job.id, ...(provider !== undefined ? { provider } : {}), companion: true }, job.startedAt)
    return reviewCollected(base, { role: job.role, verdict, companion: true, ...job.anchor, ...(note !== undefined ? { note } : {}) }, now)
  })
}

export interface CompanionStartOptions { role?: string, on?: string, input?: string, goal?: string, slug?: string, timeoutMin?: string }

export async function companionStart(o: CompanionStartOptions, ctx: WorkflowCtx, s: ResolvedSession, deps: CompanionDeps = {}): Promise<CmdResult> {
  const role = roleOf(o.role)
  if (isResult(role)) return role
  const agent = REVIEW_AGENT_OF[role] as ReviewAgent
  const cfg = loadConfigSync().config
  let setting: CompanionSetting | undefined = cfg.plan.reviews.companion
  if (o.on !== undefined) {
    setting = companionSetting(o.on)
    if (setting === undefined) return fail('usage', `--on must be one of off, auto, ${HARNESSES.join(', ')} (got '${o.on}')`)
  }
  if (setting === 'off') return ok({ ok: true, state: 'off' }, [`Second opinions are off (plan.reviews.companion: off); nothing started. Go on with ${agent} alone.`])
  let timeoutMin = COMPANION_TIMEOUT_MIN
  if (o.timeoutMin !== undefined) {
    const n = Number(o.timeoutMin)
    if (!Number.isInteger(n) || n < 1 || n > COMPANION_TIMEOUT_MAX_MIN) return fail('usage', `--timeout-min must be a whole number from 1 to ${COMPANION_TIMEOUT_MAX_MIN} (got '${o.timeoutMin}')`)
    timeoutMin = n
  }
  const state = loadState(s.harness, s.sessionId)
  const p = state.plan
  const goal = o.goal?.trim() || goalFrom(o.input)
  if (p === undefined && (role !== 'changes' || goal === undefined)) {
    return fail('no_plan', `no plan is bound to this ${s.harness} session; a second opinion reviews the bound plan, or, for a bugfix without a plan, the diff with --role changes --goal "<expected behavior>"`)
  }
  if (o.on === undefined && nativeOff(cfg.plan.reviews, role, state)) {
    return ok({ ok: true, state: 'off' }, [`plan.reviews.${role} is off, so no second opinion runs for ${agent} either.`])
  }
  const now = ctx.now
  const clock = deps.nowMs?.() ?? Date.now()
  const subject = p?.path ?? `goal:${sha(goal ?? '')}`
  const file = jobFile(s, role)
  const prev = readJob(s, role)
  if (prev !== undefined && prev.subject !== subject && prev.state === 'running' && clock < prev.deadline + KILL_GRACE_MS) {
    killTree(prev.childPid)
    killTree(prev.runnerPid)
  }
  if (prev !== undefined && prev.subject === subject) {
    if (prev.state === 'running' && runnerAlive(prev, clock)) {
      return ok({ ok: true, state: 'running', job: jobView(prev) }, [`A second opinion for ${agent} is already running on ${prev.attempts.at(-1)?.harness ?? prev.targets[0]} (job ${prev.id}). Collect it with 'buracle plan review companion collect --role ${role}'.`])
    }
    if (prev.state === 'done' || prev.state === 'failed' || prev.state === 'cancelled') {
      return ok({ ok: true, state: prev.state, job: jobView(prev) }, [`A second opinion already ran for ${agent} on this ${p !== undefined ? 'plan' : 'fix'} (${prev.state}); it runs once per plan and role. 'buracle plan review companion collect --role ${role}' shows its result.`])
    }
  }

  let anchor: CompanionAnchor
  let repo: string
  const computed: Array<[string, string]> = []
  let diff: { text: string, truncated: boolean } | undefined
  if (role === 'changes') {
    const cs = await currentChangeSet(ctx, s, p?.path, o.slug)
    if (cs === undefined) return fail('no_anchor', 'could not read the diff for the second opinion (buracle review-scope fails here); fix that first')
    anchor = { fingerprint: digestOf(cs.dir, cs.files), base: cs.base, dir: cs.dir, files: cs.files }
    repo = cs.dir
    if (p !== undefined) computed.push(['plan_file', p.path])
    else computed.push(['goal', goal ?? ''])
    computed.push(['base_ref', cs.base], ['diff_range', cs.base], ['worktree_path', cs.dir], ['changed_files', cs.files.slice(0, 200).join(', ') + (cs.files.length > 200 ? ` and ${cs.files.length - 200} more` : '')])
    diff = await diffOf(cs.dir, cs.base, cs.files)
  } else {
    const fp = p !== undefined ? planFingerprint(p.path) : undefined
    if (p === undefined || fp === undefined) return fail('no_anchor', `could not read the plan file ${p?.path ?? ''}`)
    anchor = { fingerprint: fp }
    repo = (await repoFacts(dirname(p.path)))?.top ?? (await repoFacts(ctx.cwd))?.top ?? ctx.cwd
    computed.push(['plan_file', p.path])
  }

  const which = deps.which ?? onPath
  const callerFamily = modelFamily(sessionModel(s.harness, s.sessionId) ?? latestModel(s.harness))
  const choice = chooseCompanion(setting, s.harness, candidates(clock, cfg.harnesses, which), callerFamily)
  const id = `cmp-${role}-${randomBytes(4).toString('hex')}`
  const timeoutMs = timeoutMin * 60_000
  const job: CompanionJob = {
    v: 1, id, role, agent, caller: s.harness, session: s.sessionId, subject, repo, targets: choice.picks, timeoutMs,
    startedAt: clock, deadline: clock + timeoutMs, state: 'running', attempts: [], anchor, ...(p !== undefined ? { plan: p.path } : {}),
  }
  if (choice.picks.length === 0) {
    job.state = 'unavailable'
    job.error = `no other harness can give a second opinion now: ${choice.skipped.join('; ')}`
    writeJobAt(file, job)
    recordCollected(s, job, now)
    return ok({ ok: true, state: 'unavailable', job: jobView(job), reason: job.error }, [`No second opinion: ${job.error}. Go on with ${agent} alone and say so under ## Review Notes.`])
  }
  writeRequest(file, { inputs: companionInputs(o.input, computed), ...(diff !== undefined ? { diff } : {}) })
  writeJobAt(file, job)
  const pid = (deps.spawnRunner ?? defaultSpawnRunner)(file)
  if (pid === undefined) {
    job.state = 'failed'
    job.error = 'the review runner could not be started'
    writeJobAt(file, job)
    recordCollected(s, job, now)
    return ok({ ok: true, state: 'failed', job: jobView(job) }, [`No second opinion: ${job.error}. Go on with ${agent} alone and say so under ## Review Notes.`])
  }
  const latest = readJobAt(file) ?? job
  if (latest.state === 'running' && latest.runnerPid === undefined) writeJobAt(file, { ...latest, runnerPid: pid })
  record(s, job, st => reviewStarted(st, { role, handle: id, provider: choice.picks[0], companion: true }, now))
  const skipped = choice.skipped.length > 0 ? [`Not used: ${choice.skipped.join('; ')}.`] : []
  return ok({ ok: true, state: 'running', job: jobView(readJobAt(file) ?? job) }, [
    `Second opinion started: ${agent} on ${choice.picks.join(', then ')} (job ${id}), read-only, at most ${timeoutMin} min.`,
    ...skipped,
    `Keep working. Collect it with 'buracle plan review companion collect --role ${role} --wait 90' before you decide on the review; triage its findings like ${agent}'s.`,
  ])
}

function attemptError(r: { code: number, stdout: string, stderr: string, timedOut: boolean }, h: Harness, timeoutMs: number): string | undefined {
  if (r.timedOut) return `${h}: no answer within ${mins(timeoutMs)}`
  if (r.code === 127 && r.stdout === '') return `${h}: ${BIN[h]} could not be started (${r.stderr.trim().slice(0, 200) || 'not on PATH'})`
  if (r.code !== 0) return `${h}: exit ${r.code}${(r.stderr || r.stdout).trim() !== '' ? `: ${(r.stderr || r.stdout).replace(/\s+/g, ' ').trim().slice(-300)}` : ''}`
  return undefined
}

export async function companionRun(file: string, deps: CompanionDeps = {}): Promise<number> {
  const now = deps.nowMs ?? Date.now
  if (!insideSessions(file)) return 2
  const job = readJobAt(file)
  if (job === undefined || job.state !== 'running') return 0
  const update = (edit: Partial<CompanionJob>): boolean => {
    const cur = readJobAt(file)
    if (cur === undefined || cur.id !== job.id || cur.state !== 'running') return false
    writeJobAt(file, { ...cur, ...edit })
    return true
  }
  const finish = (edit: Partial<CompanionJob>): number => { update(edit); return 0 }
  if (!update({ runnerPid: deps.pid ?? process.pid })) return 0
  const req = readRequest(file)
  const doc = (() => { try { return loadCanonicalSync().agents.find(a => a.id === job.agent) } catch { return undefined } })()
  if (req === undefined || doc === undefined) return finish({ state: 'failed', error: req === undefined ? 'the review request is missing' : `the ${job.agent} instructions could not be loaded` })
  const { companionHost } = await import('./companion-hosts')
  const attempts: CompanionAttempt[] = []
  const subject = job.plan ?? 'goal'
  for (let i = 0; i < COMPANION_ATTEMPTS; i++) {
    const target = job.targets[i] ?? job.targets[0]
    const left = job.deadline - now()
    if (target === undefined || left <= 0 || (i > 0 && left < COMPANION_RETRY_MIN_MS)) break
    const host = companionHost(target)
    const prompt = companionPrompt({ role: job.role, body: doc.body, caller: job.caller, target, shell: host.shell, repo: job.repo, scratch: host.scratch, inputs: req.inputs, ...(req.diff !== undefined && !host.shell ? { diff: req.diff } : {}) })
    const outDir = dirname(file)
    try { writeFileSync(join(outDir, 'prompt.md'), prompt, { mode: 0o600 }) } catch {  }
    const attempt: CompanionAttempt = { harness: target, startedAt: now() }
    attempts.push(attempt)
    if (!update({ attempts: [...attempts] })) return 0
    let prep: PreparedRun
    try { prep = host.prepare({ prompt, repo: job.repo, outDir, timeoutMs: left, agent: doc }) } catch (e) {
      attempt.endedAt = now()
      attempt.error = `${target}: ${e instanceof Error ? e.message : String(e)}`
      continue
    }
    const r = await runChild(prep.argv, {
      cwd: prep.cwd, stdin: prep.stdin, env: childEnv(prep.cwd, job.agent), timeoutMs: left,
      onPid: pid => { if (!update({ childPid: pid })) killTree(pid) },
    })
    try { writeFileSync(join(outDir, `output-${i + 1}-${target}.txt`), `${r.stdout.slice(-200_000)}\n--- stderr ---\n${r.stderr.slice(-50_000)}`, { mode: 0o600 }) } catch {  }
    let error = attemptError(r, target, left)
    let accepted: { report: ReviewReport, repaired: boolean } | undefined
    if (error === undefined) {
      const answer = prep.read(r.stdout)
      if (!answer.ok) error = `${target}: ${answer.text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'the run reported an error'}`
      else {
        const a = acceptReview(answer.text, job.agent as ReviewAgent, subject)
        if (a.ok) accepted = { report: a.report, repaired: a.repaired }
        else error = `${target}: the report is not valid (${a.errors.slice(0, 3).join('; ')})`
      }
    }
    try { prep.cleanup() } catch {  }
    attempt.endedAt = now()
    if (accepted !== undefined) return finish({ state: 'done', attempts: [...attempts], report: accepted.report, reportBy: target, repaired: accepted.repaired })
    attempt.error = error
    if (!update({ attempts: [...attempts] })) return 0
    if (r.timedOut) break
  }
  return finish({ state: 'failed', attempts: [...attempts], error: attempts.map(a => a.error).filter((e): e is string => e !== undefined).join('; ') || 'no attempt could run in the time left' })
}

function findingLines(report: ReviewReport): string[] {
  const out: string[] = []
  for (const f of report.findings) {
    out.push(`- [${f.severity}] ${f.category}: ${f.title}${f.file !== undefined ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ''})` : ''}`)
    out.push(`  evidence: ${f.evidence.replace(/\s+/g, ' ').slice(0, 600)}`)
    out.push(`  fix: ${f.suggested_fix.replace(/\s+/g, ' ').slice(0, 400)}`)
  }
  for (const t of report.truths ?? []) out.push(`- truth (${t.status}): ${t.truth}`)
  return out
}

export async function companionCollect(o: { role?: string, wait?: string }, ctx: WorkflowCtx, s: ResolvedSession, deps: CompanionDeps = {}): Promise<CmdResult> {
  const role = roleOf(o.role)
  if (isResult(role)) return role
  let waitSec = 0
  if (o.wait !== undefined) {
    const n = Number(o.wait)
    if (!Number.isInteger(n) || n < 0 || n > COMPANION_WAIT_MAX_SEC) return fail('usage', `--wait must be a whole number of seconds from 0 to ${COMPANION_WAIT_MAX_SEC} (got '${o.wait}')`)
    waitSec = n
  }
  const file = jobFile(s, role)
  const agent = REVIEW_AGENT_OF[role]
  let job = readJob(s, role)
  if (job === undefined) return ok({ ok: true, state: 'none' }, [`No second opinion was started for ${agent} in this session.`])
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  const clock = deps.nowMs ?? Date.now
  const until = clock() + waitSec * 1000
  while (job.state === 'running' && runnerAlive(job, clock()) && clock() < until) {
    await sleep(Math.min(POLL_MS, Math.max(0, until - clock())))
    job = readJobAt(file) ?? job
  }
  if (job.state === 'running' && !runnerAlive(job, clock())) {
    job = { ...job, state: 'failed', error: job.error ?? 'the review runner ended without a result' }
    writeJobAt(file, job)
  }
  if (job.state === 'running') {
    const last = job.attempts.at(-1)
    return ok({ ok: true, state: 'running', job: jobView(job) }, [
      `The second opinion for ${agent} is still running${last !== undefined ? ` on ${last.harness} (attempt ${job.attempts.length})` : ''}: ${mins(clock() - job.startedAt)} of at most ${mins(job.timeoutMs)} used.`,
      `Keep working and collect it again with 'buracle plan review companion collect --role ${role} --wait 90'.`,
    ])
  }
  const now = ctx.now
  if (job.collectedAt === undefined) {
    job = { ...job, collectedAt: now }
    writeJobAt(file, job)
  }
  recordCollected(s, job, now)
  const st = loadState(s.harness, s.sessionId)
  const rec = companionOf(st, role)
  const data: Record<string, unknown> = { ok: true, state: job.state, job: jobView(job), ...(rec !== undefined ? { review: recordView(rec) } : {}) }
  if (job.state === 'done' && job.report !== undefined) {
    data['report'] = job.report
    const by = job.reportBy ?? job.targets[0] ?? 'another harness'
    return ok(data, [
      `Second opinion from ${by} (${agent}): ${job.report.verdict}, ${job.report.findings.length} finding(s)${job.repaired === true ? '; Buracle normalized the shape of its report' : ''}.`,
      job.report.summary,
      ...findingLines(job.report),
      `Triage these findings exactly like ${agent}'s and weigh them equally: check each against the code, fix must_fix, fix should_fix or record why not under ## Review Notes.`,
    ])
  }
  return ok(data, [`No second opinion for ${agent}: ${job.error ?? job.state}. Go on with ${agent} alone and say so under ## Review Notes.`])
}

export async function companionCancel(o: { role?: string }, ctx: WorkflowCtx, s: ResolvedSession, deps: CompanionDeps = {}): Promise<CmdResult> {
  const role = roleOf(o.role)
  if (isResult(role)) return role
  const file = jobFile(s, role)
  const job = readJob(s, role)
  const agent = REVIEW_AGENT_OF[role]
  if (job === undefined || job.state !== 'running') return ok({ ok: true, state: job?.state ?? 'none' }, [`No second opinion for ${agent} is running.`])
  if ((deps.nowMs ?? Date.now)() < job.deadline + KILL_GRACE_MS) {
    killTree(job.childPid)
    killTree(job.runnerPid)
  }
  const next: CompanionJob = { ...job, state: 'cancelled', error: 'cancelled', collectedAt: ctx.now }
  writeJobAt(file, next)
  recordCollected(s, next, ctx.now)
  return ok({ ok: true, state: 'cancelled', job: jobView(next) }, [`Cancelled the second opinion for ${agent} (job ${job.id}). Say so under ## Review Notes.`])
}

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { CommandIO } from '../router'
import { parseCommandArgs, strFlag, boolFlag, type FlagKind } from '../../workflow/args'
import { companionCancel, companionCollect, companionRun, companionStart } from '../../workflow/companion'
import {
  planApproveResult, planComplete, planInit, planPause, planRegister, planResume, planSet, planStatus, planUnregister, planValidate, planVerify,
} from '../../workflow/plan'
import { planAudit } from '../../workflow/plan-audit'
import { planCapture } from '../../workflow/plan-capture'
import { planPrepareNative } from '../../workflow/plan-native'
import { loadConfigSync } from '../../engine/config'
import { planNotes } from '../../workflow/plan-notes'
import { resolveLane, withLanes, type LaneTarget } from '../../workflow/plan-lanes'
import { planReview } from '../../workflow/plan-review'
import { emit, isResult, needSession, optionalSession, processCtx, usageError, warnCwdGone, type CmdResult, type WorkflowCtx } from '../../workflow/result'
import type { ResolvedSession } from '../../workflow/session-store'

export const name = 'plan'
export const summary = 'Plan contract and state machine (init, capture, validate, register, prepare-native, status, set, pause, resume, complete, approve-result, verify, review, audit, notes)'
export const usage = `Usage: buracle plan <subcommand> [args…] [--json]

  init --type feature|bugfix|build --title "<t>" [--slug <s>] [--dir <d>]
                          write docs/plans/YYYY-MM-DD-<slug>.md (build: docs/builds/…); prints {path, slug};
                          when a session resolves, the header also records its harness (harness: <h>)
  capture [--title "<t>"] [--file <path>] [--draft] [--harness <h>]
                          save a plan from a harness's own plan mode (the text on stdin, or --file)
                          as docs/plans/YYYY-MM-DD-<slug>.md: type Plan, status SAVED, approved
                          (--draft: approved false); never overwrites (-2, -3, …); prints {path};
                          the harness comes from --harness or the session
  validate <path> [--strict]
                          exit 0 ok · 1 errors · 2 warnings with --strict
  register <path> [--phase plan|implement|verify]
                          bind the plan to this session
  prepare-native <path> | --cancel
                          plan.nativePlanMode: bind the registered Feature plan (phase plan,
                          PENDING, not approved) to the harness's own plan mode, once: the plan
                          the user approves when the session leaves plan mode is written into
                          this file (H12), its frontmatter kept; refused when the file changed
                          in between, then saved beside it instead; --cancel drops the binding
  status                  {plan: {path, slug, type, status, phase, …} | null, status, phase,
                          tasks: {done, total}, interaction, session}
  set status <PENDING|APPROVED|IN_PROGRESS|COMPLETE|VERIFIED>
  set phase <plan|implement|verify|done>
  set approved <true|false>
  set iterations <n> | set rounds <n> | set worktree <true|false>
                          change the plan file's frontmatter and the session state together;
                          'set status COMPLETE' is 'complete', 'set status VERIFIED' and
                          'set phase done' are 'verify' (same checks, same refusals)
  pause [--kind discussion|decision|manual] [--reason "<r>"]
                          record a pause: the stop guard lets the turn end (idempotent); the
                          user's bare "continue" keeps a decision or manual pause, except a
                          decision pause whose reason starts with "runaway:", "build hand-back:"
                          or "model switch:" (the stop guard's limit question, a goal-build
                          hand-back, the plan.modelSwitch pause)
  resume                  clear any pause (no-op when nothing is paused)
  complete                status COMPLETE (every task ticked); refuses with the reason (exit 2)
  approve-result          record the user's explicit approval of the verified result (Feature
                          and Bugfix, status COMPLETE) and end the pause; plan.resultApproval
                          makes 'verify' wait for it
  verify                  status VERIFIED, phase done: needs status COMPLETE, approval, every task
                          ticked and the evidence sections (## Evidence; Feature also ## DoD Audit
                          and ## E2E Results when it has SC-n scenarios; Bugfix also ## RED
                          Evidence; Build also every acceptance criterion at pass and a filled
                          ## Unverified; Feature and Bugfix also the result approval while
                          plan.resultApproval is on); refuses with the reasons (exit 2)
                          'set approved true', 'set status APPROVED|IN_PROGRESS', 'set phase
                          implement|verify' and 'complete' also end a held decision pause
  review start --role plan|changes|goal [--handle <id>] [--provider <harness>]
                          record a reviewer launched in the background (plan-build-review,
                          changes-review, goal-build-review) and its agent handle; the
                          compaction and restore texts name it so it is collected, not relaunched
  review done --role <r> --verdict pass|needs_changes|incomplete
                          record the collected report after triage and anchor it: the plan text
                          (plan, goal) or the reviewed files (changes); 'set approved true',
                          'approve-result' and 'verify' then warn when it is stale or missing
  review status           the recorded reviews of the bound plan and whether each is still fresh
  review companion start --role <r> [--on auto|claude|codex|opencode|omp] [--input <file>|-]
                         [--goal "<expected behavior>"] [--slug <s>] [--timeout-min <n>]
                          a second opinion from another installed harness, in the background
                          (plan.reviews.companion picks it; off by default, --on overrides):
                          read-only, once per plan and role, at most --timeout-min minutes
                          (default 20, one retry on the next harness while time is left);
                          --input passes the native reviewer's labeled input lines; --goal
                          reviews a bugfix diff that has no plan (role changes)
  review companion collect --role <r> [--wait <seconds>]
                          wait up to --wait seconds (at most 600), then print the report or
                          why there is none, and record it with the plan's reviews
  review companion cancel --role <r>
                          stop a running second opinion
  unregister              remove the session binding (the plan file stays)
  audit [<path>] [--base <ref>] [--slug <s>]
                          compare the plan's Files lists with the diff review-scope picks (the
                          session's plan when no path is given): unimplemented (a Create, Modify or
                          Test path the diff misses), delete-pending, rename-mismatch, unplanned (a
                          changed path no task and no ## Deviations line names) and inventory-open
                          (an ## Inventory row whose task is missing or not ticked); findings of
                          unticked tasks are info. Exit 0 the diff matches · 2 warnings · 1 error
  notes [<path>] [--kind plan|code|all] [--slug <s>] [--done <id>[,<id>…]]
                          the open notes the user pinned in the review page (buracle mem ui
                          --page review): plan notes on a passage of the plan, build contract
                          or PRD (<path>, else the session's plan) and code notes on changed
                          lines of the diff review-scope picks (--slug as there); --done marks
                          the notes you applied. No notes is never an approval. Exit 0 · 1 error

Lanes: --lane <slug> on register, status, set, pause, resume, complete, approve-result, verify,
review, unregister and audit binds a whole workflow run in a lane worktree ('buracle worktree
create <slug> --lane', from any checkout of the repository) to a session of its own, the lead's
session id plus ".lane-<slug>", so it never replaces the lead's plan; plain 'status' lists them.

Session (register, prepare-native, status, set, pause, resume, complete, approve-result, verify, review, unregister; optional for init, capture, audit and notes): --session <id> wins
(harness from --harness or the environment). Otherwise the ids each harness sets: BURACLE_SESSION_ID
with BURACLE_HARNESS, CLAUDE_CODE_SESSION_ID, CODEX_SESSION_ID or CODEX_THREAD_ID (a Codex subagent
thread maps to its root session), OPENCODE_SESSION_ID, OMP_SESSION_ID. When several harnesses set
ids (one started from another's shell), the nearest harness process decides. No session: exit 2
(init only leaves out the harness line).

Exit codes: 0 ok · 1 error · 2 refused or user action needed.`

const SESSION: Record<string, FlagKind> = { session: 'string', harness: 'string' }
const BOUND: Record<string, FlagKind> = { ...SESSION, lane: 'string' }
const SPECS: Record<string, Record<string, FlagKind>> = {
  init: { type: 'string', title: 'string', slug: 'string', dir: 'string', ...SESSION },
  capture: { title: 'string', file: 'string', draft: 'bool', ...SESSION },
  validate: { strict: 'bool' },
  register: { phase: 'string', ...BOUND },
  'prepare-native': { cancel: 'bool', ...SESSION },
  status: BOUND,
  set: BOUND,
  pause: { kind: 'string', reason: 'string', ...BOUND },
  resume: BOUND,
  complete: BOUND,
  'approve-result': BOUND,
  verify: BOUND,
  review: { role: 'string', handle: 'string', provider: 'string', verdict: 'string', on: 'string', input: 'string', goal: 'string', slug: 'string', 'timeout-min': 'string', wait: 'string', job: 'string', ...BOUND },
  unregister: BOUND,
  audit: { base: 'string', slug: 'string', ...BOUND },
  notes: { kind: 'string', slug: 'string', done: 'string', ...SESSION },
}
const ALL: Record<string, FlagKind> = Object.assign({}, ...Object.values(SPECS)) as Record<string, FlagKind>
const COMPANION_FLAGS: readonly string[] = ['on', 'input', 'goal', 'slug', 'timeout-min', 'wait', 'job']

function optional(flags: Parameters<typeof strFlag>[0], keys: readonly string[]): Record<string, string> {
  const o: Record<string, string> = {}
  for (const k of keys) { const v = strFlag(flags, k); if (v !== undefined) o[k] = v }
  return o
}

export async function runPlan(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const parsed = parseCommandArgs(argv, ALL)
  const [sub, ...pos] = parsed.positional
  const json = io.flags.json
  const out = (r: CmdResult) => emit(io, json, `buracle plan${sub !== undefined ? ` ${sub}` : ''}`, r)
  if (sub === undefined) return out(usageError(usage, ['missing subcommand']))
  const spec = SPECS[sub]
  if (spec === undefined) return out(usageError(usage, [`unknown subcommand '${sub}'`]))
  const problems = [...parsed.errors]
  for (const f of Object.keys(parsed.flags)) if (spec[f] === undefined) problems.push(`--${f} does not apply to 'plan ${sub}'`)
  if (problems.length > 0) return out(usageError(usage, problems))
  const flags = parsed.flags

  const sflags: { session?: string, harness?: string } = {}
  const sid = strFlag(flags, 'session')
  const h = strFlag(flags, 'harness')
  if (sid !== undefined) sflags.session = sid
  if (h !== undefined) sflags.harness = h

  if (sub === 'init') {
    if (pos.length > 0) return out(usageError(usage, [`unexpected argument '${pos[0]}'`]))
    const o: { type?: string, title?: string, slug?: string, dir?: string } = {}
    for (const k of ['type', 'title', 'slug', 'dir'] as const) { const v = strFlag(flags, k); if (v !== undefined) o[k] = v }
    return out(await planInit(o, ctx, optionalSession(sflags, ctx.env)))
  }
  if (sub === 'capture') {
    if (pos.length > 0) return out(usageError(usage, [`unexpected argument '${pos[0]}'`]))
    const o: { title?: string, harness?: string, file?: string, draft?: boolean } = {}
    for (const k of ['title', 'harness', 'file'] as const) { const v = strFlag(flags, k); if (v !== undefined) o[k] = v }
    if (boolFlag(flags, 'draft')) o.draft = true
    return out(await planCapture(o, () => io.stdin.text(), ctx, optionalSession(sflags, ctx.env)))
  }
  if (sub === 'validate') {
    if (pos.length > 1) return out(usageError(usage, [`unexpected argument '${pos[1]}'`]))
    return out(planValidate(pos[0], boolFlag(flags, 'strict'), ctx))
  }
  if (sub === 'notes') {
    if (pos.length > 1) return out(usageError(usage, [`unexpected argument '${pos[1]}'`]))
    const o: { kind?: string, slug?: string, done?: string } = {}
    for (const k of ['kind', 'slug', 'done'] as const) { const v = strFlag(flags, k); if (v !== undefined) o[k] = v }
    return out(await planNotes(pos[0], o, ctx, optionalSession(sflags, ctx.env)))
  }
  const lane = strFlag(flags, 'lane')
  let laneLead: LaneTarget | undefined
  const laneSession = async (): Promise<ResolvedSession | CmdResult | undefined> => {
    if (lane === undefined) return undefined
    const t = await resolveLane(lane, ctx, optionalSession(sflags, ctx.env), { gone: sub === 'unregister' })
    if (isResult(t)) return t
    laneLead = t
    return t.session
  }
  if (sub === 'audit') {
    if (pos.length > 1) return out(usageError(usage, [`unexpected argument '${pos[1]}'`]))
    const o: { base?: string, slug?: string } = {}
    for (const k of ['base', 'slug'] as const) { const v = strFlag(flags, k); if (v !== undefined) o[k] = v }
    if (lane !== undefined) o.slug ??= lane
    const ls = await laneSession()
    if (isResult(ls)) return out(ls)
    return out(await planAudit(pos[0], o, ctx, ls ?? optionalSession(sflags, ctx.env)))
  }
  const companion = sub === 'review' && pos[0] === 'companion'
  if (sub === 'review' && !companion) {
    const stray = COMPANION_FLAGS.filter(f => flags[f] !== undefined)
    if (stray.length > 0) return out(usageError(usage, stray.map(f => `--${f} applies to 'plan review companion' only`)))
  }
  const maxPos = sub === 'register' || sub === 'prepare-native' ? 1 : sub === 'set' ? 2 : sub === 'review' ? (companion ? 2 : 1) : 0
  if (pos.length > maxPos) return out(usageError(usage, [`unexpected argument '${pos[maxPos]}'`]))
  if (sub === 'register' && pos[0] === undefined) return out(usageError(usage, ['missing <path>']))
  if (sub === 'prepare-native' && (pos[0] === undefined) === !boolFlag(flags, 'cancel')) return out(usageError(usage, [pos[0] === undefined ? 'missing <path> (or --cancel)' : '--cancel takes no <path>']))
  if (sub === 'set' && pos.length < 2) return out(usageError(usage, ['plan set <field> <value>: missing ' + (pos.length === 0 ? '<field>' : '<value>')]))
  if (sub === 'review' && pos[0] === undefined) return out(usageError(usage, ['plan review <start|done|status|companion>: missing action']))
  if (companion) {
    const action = pos[1]
    if (action === 'run') {
      const job = strFlag(flags, 'job')
      if (job === undefined) return out(usageError(usage, ['plan review companion run: missing --job <file>']))
      return companionRun(job)
    }
    if (action !== 'start' && action !== 'collect' && action !== 'cancel') return out(usageError(usage, [`plan review companion <start|collect|cancel>${action !== undefined ? `: unknown action '${action}'` : ': missing action'}`]))
    if (lane !== undefined) return out(usageError(usage, ['a second opinion belongs to the lead: run it without --lane, on the lead\'s plan']))
    const cs = needSession(sflags, ctx.env)
    if (isResult(cs)) return out(cs)
    const role = strFlag(flags, 'role')
    if (action === 'collect') return out(await companionCollect({ ...(role !== undefined ? { role } : {}), ...optional(flags, ['wait']) }, ctx, cs))
    if (action === 'cancel') return out(await companionCancel(role !== undefined ? { role } : {}, ctx, cs))
    const src = strFlag(flags, 'input')
    let input: string | undefined
    if (src !== undefined) {
      try { input = src === '-' ? await io.stdin.text() : readFileSync(isAbsolute(src) ? src : join(ctx.cwd, src), 'utf8') } catch (e) {
        return out(usageError(usage, [`--input: cannot read ${src} (${e instanceof Error ? e.message : String(e)})`]))
      }
    }
    const o = { ...(role !== undefined ? { role } : {}), ...optional(flags, ['on', 'goal', 'slug']), ...(input !== undefined ? { input } : {}) }
    const t = strFlag(flags, 'timeout-min')
    return out(await companionStart(t !== undefined ? { ...o, timeoutMin: t } : o, ctx, cs))
  }
  const ls = await laneSession()
  if (isResult(ls)) return out(ls)
  const s = ls ?? needSession(sflags, ctx.env)
  if (isResult(s)) return out(s)
  switch (sub) {
    case 'register': return out(await planRegister(pos[0], strFlag(flags, 'phase'), ctx, s))
    case 'prepare-native': return out(planPrepareNative(pos[0], { cancel: boolFlag(flags, 'cancel') }, loadConfigSync().config.plan, ctx, s))
    case 'status': return out(lane === undefined ? withLanes(planStatus(ctx, s), s) : planStatus(ctx, s))
    case 'review': {
      const o: { role?: string, handle?: string, provider?: string, verdict?: string, slug?: string } = {}
      for (const k of ['role', 'handle', 'provider', 'verdict'] as const) { const v = strFlag(flags, k); if (v !== undefined) o[k] = v }
      if (lane !== undefined) o.slug = lane
      return out(await planReview(pos[0], o, ctx, s, laneLead))
    }
    case 'set': return out(await planSet(pos[0], pos[1], ctx, s))
    case 'pause': return out(planPause(strFlag(flags, 'kind'), strFlag(flags, 'reason'), ctx, s))
    case 'resume': return out(planResume(ctx, s))
    case 'complete': return out(await planComplete(ctx, s))
    case 'approve-result': return out(await planApproveResult(ctx, s))
    case 'verify': return out(await planVerify(ctx, s))
    default: return out(await planUnregister(ctx, s, laneLead))
  }
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, 'buracle plan', ctx)
  return runPlan(argv, io, ctx)
}

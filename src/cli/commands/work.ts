import type { CommandIO } from '../router'
import { boolFlag, parseCommandArgs, strFlag, type FlagKind } from '../../workflow/args'
import { workAsk, workClose, workDone, workHeartbeat, workInbox, workJoin, workMerge, workNote, workPublish, workRelease, workReopen, workResume, workStatus, workWait } from '../../workflow/board'
import { workSpawn } from '../../workflow/board-panes'
import { emit, needSession, optionalSession, processCtx, usageError, warnCwdGone, type CmdResult, type WorkflowCtx } from '../../workflow/result'

export const name = 'work'
export const summary = 'The task board: publish a plan\'s tasks, join from another terminal, report, wait, merge (publish, status, join, heartbeat, ask, resume, done, release, note, inbox, wait, merge, reopen, close)'
export const usage = `Usage: buracle work <subcommand> [args…] [--json]

Lead (the session that registered the plan):
  publish [<plan path>] [--max-workers <n>] [--lease-sec <s>]
                     write the approved plan's unticked tasks to the board of this repository
                     (<git common dir>/buracle/board/<slug>.json). Idempotent: a second publish adds new tasks,
                     keeps every state and warns (exit 2, plan_changed_while_active) when an active task's files
                     or dependencies changed in the plan. Defaults: plan.board.maxWorkers (6), plan.board.leaseSec
                     (300; the flag accepts 1 or more, the config key 10 or more)
  spawn [--mux tmux|cmux|herdr|herdr-app] [--workers <n>] [--harness <h>[,<h>…]] [--dry-run]
                     open worker panes in the lead's terminal multiplexer: one per ready task by default (never more
                     than the free worker slots), each running a harness whose first prompt is /buracle-join <slug>.
                     --mux defaults to the multiplexer the lead runs in (tmux, then herdr, then cmux, then the Herdr
                     app); --mux tmux outside tmux opens a detached session buracle-<slug>. The lead keeps the top of
                     its area and the workers fill a grid of panes below it (one row up to four workers; cmux can only
                     halve a pane; the Herdr app places the panes in the lead's tab itself); a later spawn adds panes
                     next to the last worker pane. Here --harness is the workers' harness list, dealt out in turn
                     (default: the swarm harnesses of plan.board.harnesses that are installed); the lead's own session comes
                     from the environment or --session with BURACLE_HARNESS. --dry-run prints the panes it would open
                     (exit 0 even without a board or a multiplexer). The panes are recorded, so that merge and
                     close can close them; nothing else is ever closed. --dry-run also prints harnesses, the usable list
                     (on in plan.board.harnesses and installed). Error codes: no_mux, mux_mismatch, harness_off,
                     harness_missing, cmux_missing, mux_failed
  wait [--timeout <s>]
                     block until the board changes (a task claimed, done, waiting, stale, released, or a note for the
                     lead), at most --timeout seconds (default 90), then print the events since the last wait
  merge [--task <n>] [--manual]
                     squash-merge the next mergeable done task (lowest number whose dependencies are merged) into the
                     base branch and tick its box in the plan file; --task picks one; --manual records a task the lead
                     merged by hand. merge_conflict (exit 1) leaves the task done: resolve, then --manual
  reopen <n> [--reason <text>]
                     return a done, merged, waiting or claimed task to open; its worktree and report stay. A merged
                     task also gets its plan box opened again and the base merged into its lane worktree (a conflict
                     is undone and reported, exit 2)
  close [--force] [--keep-panes]
                     remove the merged tasks' lane worktrees, the panes that spawn opened and the board file; --force
                     while tasks are still open; --keep-panes leaves the panes open. merge also closes the panes of
                     workers that have nothing left to take, once no task is open

Any session in the repository:
  status [<slug>]    the board: every task with its state, worker, lease age, question and worktree
  join <slug> [--task <n>]
                     claim the first open task whose dependencies are merged and whose files do not overlap an
                     active task, create or reuse its lane worktree <slug>-t<n>, and print the task card
  heartbeat          renew the lease of this session's task (the hooks do this on every prompt and tool call)
  ask "<question>"   mark the task waiting for the user, leave a note for the lead and notify the terminal
  resume             claimed again after the user answered (the hooks do this on the next prompt, or at the tool
                     result that follows the question tool)
  done --verify "<evidence>"
                     report the task done with its branch, commits and verification evidence; the worktree must be
                     committed (worktree_dirty otherwise)
  release [--reason <text>]
                     give the task back (open); the worktree stays for the next worker. Without a task:
                     leave the board, so the session edits the repository again
  note "<text>" [--to lead|all|<session id>] [--kind report|question|nudge]
                     leave a note; workers write to the lead by default, the lead to everyone
  inbox              the notes for this session that no hook delivered yet (they are marked delivered)

Task states: open, claimed, waiting, done, merged, stale. A claimed task whose lease expires without a heartbeat
turns stale and keeps its worktree; the next join resumes from it. Error codes: no_repo, no_board, not_approved,
not_lead, lead_cannot_join, already_claimed, nothing_to_claim, max_workers, usage_low, task_not_open, deps_unmerged,
wrong_harness (the task is reserved for another harness), harness_off (plan.board.harnesses switches this harness off),
not_claimed_by_you, reassigned, worktree_dirty, merge_conflict, tasks_open. Exit codes: 0 ok · 1 error · 2 partial.
The session comes from --session <id> with --harness <h>, or from the harness environment (see 'buracle plan --help').`

const SESSION: Record<string, FlagKind> = { session: 'string', harness: 'string' }
const SPECS: Record<string, Record<string, FlagKind>> = {
  publish: { 'max-workers': 'string', 'lease-sec': 'string', ...SESSION },
  // spawn's --harness names the workers, not the lead's session (see the usage text).
  spawn: { mux: 'string', workers: 'string', harness: 'string', 'dry-run': 'bool', session: 'string' },
  status: SESSION,
  join: { task: 'string', ...SESSION },
  heartbeat: SESSION,
  release: { reason: 'string', ...SESSION },
  done: { verify: 'string', ...SESSION },
  ask: SESSION,
  resume: SESSION,
  note: { to: 'string', kind: 'string', ...SESSION },
  inbox: SESSION,
  wait: { timeout: 'string', ...SESSION },
  merge: { task: 'string', manual: 'bool', ...SESSION },
  reopen: { reason: 'string', ...SESSION },
  close: { force: 'bool', 'keep-panes': 'bool', ...SESSION },
}
const ALL: Record<string, FlagKind> = Object.assign({}, ...Object.values(SPECS)) as Record<string, FlagKind>
const POSITIONALS: Record<string, number> = { publish: 1, status: 1, join: 1, ask: 1, note: 1, reopen: 1 }

function intFlag(flags: Record<string, string | boolean>, name: string, problems: string[]): number | undefined {
  const v = strFlag(flags, name)
  if (v === undefined) return undefined
  if (!/^\d+$/.test(v)) { problems.push(`--${name} must be a whole number (got '${v}')`); return undefined }
  return Number(v)
}

export async function runWork(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const parsed = parseCommandArgs(argv, ALL)
  const [sub, ...pos] = parsed.positional
  const out = (r: CmdResult) => emit(io, io.flags.json, `buracle work${sub !== undefined ? ` ${sub}` : ''}`, r)
  if (sub === undefined) return out(usageError(usage, ['missing subcommand']))
  const spec = SPECS[sub]
  if (spec === undefined) return out(usageError(usage, [`unknown subcommand '${sub}'`]))
  const problems = [...parsed.errors]
  for (const f of Object.keys(parsed.flags)) if (spec[f] === undefined) problems.push(`--${f} does not apply to 'work ${sub}'`)
  const maxWorkers = intFlag(parsed.flags, 'max-workers', problems)
  const leaseSec = intFlag(parsed.flags, 'lease-sec', problems)
  const taskFlag = intFlag(parsed.flags, 'task', problems)
  const timeout = intFlag(parsed.flags, 'timeout', problems)
  const workers = intFlag(parsed.flags, 'workers', problems)
  const positionals = POSITIONALS[sub] ?? 0
  if (pos.length > positionals) problems.push(`unexpected argument '${pos[positionals]}'`)
  if (problems.length > 0) return out(usageError(usage, problems))
  const sflags: { session?: string, harness?: string } = {}
  const sid = strFlag(parsed.flags, 'session')
  const h = strFlag(parsed.flags, 'harness')
  if (sid !== undefined) sflags.session = sid
  if (h !== undefined && sub !== 'spawn') sflags.harness = h
  switch (sub) {
    case 'spawn': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      const o: Parameters<typeof workSpawn>[0] = { dryRun: boolFlag(parsed.flags, 'dry-run') }
      const mux = strFlag(parsed.flags, 'mux')
      if (mux !== undefined) o.mux = mux
      if (workers !== undefined) o.workers = workers
      if (h !== undefined) o.harness = h
      return out(await workSpawn(o, ctx, s))
    }
    case 'publish': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      const o: Parameters<typeof workPublish>[0] = {}
      if (pos[0] !== undefined) o.planPath = pos[0]
      if (maxWorkers !== undefined) o.maxWorkers = maxWorkers
      if (leaseSec !== undefined) o.leaseSec = leaseSec
      return out(await workPublish(o, ctx, s))
    }
    case 'join': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      return out(await workJoin(pos[0], taskFlag !== undefined ? { task: taskFlag } : {}, ctx, s))
    }
    case 'heartbeat': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      return out(workHeartbeat(ctx, s))
    }
    case 'release': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      const reason = strFlag(parsed.flags, 'reason')
      return out(await workRelease(reason !== undefined ? { reason } : {}, ctx, s))
    }
    case 'done': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      const verify = strFlag(parsed.flags, 'verify')
      return out(await workDone(verify !== undefined ? { verify } : {}, ctx, s))
    }
    case 'ask': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      return out(await workAsk(pos[0], ctx, s))
    }
    case 'resume': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      return out(await workResume(ctx, s))
    }
    case 'note': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      const o: { to?: string, kind?: string } = {}
      const to = strFlag(parsed.flags, 'to')
      const kind = strFlag(parsed.flags, 'kind')
      if (to !== undefined) o.to = to
      if (kind !== undefined) o.kind = kind
      return out(workNote(pos[0], o, ctx, s))
    }
    case 'inbox': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      return out(workInbox(ctx, s))
    }
    case 'wait': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      return out(await workWait(timeout !== undefined ? { timeoutSec: timeout } : {}, ctx, s))
    }
    case 'merge': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      return out(await workMerge({ ...(taskFlag !== undefined ? { task: taskFlag } : {}), manual: boolFlag(parsed.flags, 'manual') }, ctx, s))
    }
    case 'reopen': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      const reason = strFlag(parsed.flags, 'reason')
      return out(await workReopen(pos[0], reason !== undefined ? { reason } : {}, ctx, s))
    }
    case 'close': {
      const s = needSession(sflags, ctx.env)
      if ('code' in s) return out(s)
      return out(await workClose({ force: boolFlag(parsed.flags, 'force'), keepPanes: boolFlag(parsed.flags, 'keep-panes') }, ctx, s))
    }
    default: return out(await workStatus(pos[0], ctx, optionalSession(sflags, ctx.env)))
  }
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, 'buracle work', ctx)
  return runWork(argv, io, ctx)
}

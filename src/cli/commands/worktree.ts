import type { CommandIO } from '../router'
import { boolFlag, parseCommandArgs, strFlag, type FlagKind } from '../../workflow/args'
import { worktreeCleanup, worktreeCreate, worktreeDetect, worktreeDiff, worktreeStatus, worktreeSync } from '../../workflow/worktree'
import { worktreeBranch } from '../../workflow/worktree-branch'
import { emit, optionalSession, processCtx, usageError, warnCwdGone, type CmdResult, type WorkflowCtx } from '../../workflow/result'

export const name = 'worktree'
export const summary = 'Isolated worktrees and branches for plans (create, branch, detect, diff, sync, cleanup, status)'
export const usage = `Usage: buracle worktree <subcommand> [args…] [--json]

  create <slug> [--base <branch>] [--prefix plan-build|goal-build|bugfix] [--lane]
                     new worktree <worktreeDir>/<slug> (default .worktrees/) on branch <prefix>/<slug>
                     (default plan-build) from the base branch (default: the current branch); sets
                     worktree: true on this session's registered plan. Prints {path, branch}.
                     --lane: a parallel agent's worktree; it marks no plan, never counts as the
                     plan's worktree, and may start inside a plan worktree (from its branch), so
                     'sync <slug>' merges the lane into that branch
  branch <slug> [--base <ref>] [--prefix plan-build|goal-build|bugfix]
                     switch the current checkout to a new branch <prefix>/<slug> (the first free
                     name of <prefix>/<slug>, -2, -3, …) started from HEAD, or from --base; local
                     changes come along (git switch -c; with --base it refuses instead of
                     overwriting them). Records the base, so review-scope diffs the branch against
                     it. On the recorded branch: no-op; elsewhere, for this session's plan, it
                     switches back to the plan's branch. Prints {branch, base, baseCommit}
  detect             {inWorktree, path, branch, base} for the current directory
  diff <slug>        commits, files and stats of the worktree branch against its base
  sync <slug>        squash-merge the branch into its base with one conventional commit; local
                     changes in the base checkout are stashed and restored (plan files under
                     docs/plans and docs/builds, and the registered plan, are never stashed).
                     In phase verify, a sync of the plan's worktree ends a held merge decision.
                     Exit 0 merged · 1 nothing merged · 2 merged, but the stash was not restored
  cleanup <slug> [--force|--discard]
                     remove the worktree and its branch. After a sync that exited 0 or 2 no flag is
                     needed; --force deletes a branch whose commits landed another way; --discard
                     also deletes uncommitted and unmerged work (in phase verify, a discard of the
                     plan's worktree ends a held merge decision)
  status             every plan worktree of the repository (and which one is this session's)

The session (see 'buracle plan --help') is optional here: without one, create warns and marks no
plan. plan.worktreeDir may be absolute, '~/…' or relative to the main checkout.
Mutating subcommands take a repository-wide lock (BURACLE_LOCK_TIMEOUT_MS, default 60000).
History is never rewritten. Exit codes: 0 ok · 1 error · 2 partial or refused.`

const SESSION: Record<string, FlagKind> = { session: 'string', harness: 'string' }
const SPECS: Record<string, Record<string, FlagKind>> = {
  create: { base: 'string', prefix: 'string', lane: 'bool', ...SESSION },
  branch: { base: 'string', prefix: 'string', ...SESSION },
  detect: SESSION,
  diff: {},
  sync: SESSION,
  cleanup: { force: 'bool', discard: 'bool' },
  status: SESSION,
}
const ALL: Record<string, FlagKind> = Object.assign({}, ...Object.values(SPECS)) as Record<string, FlagKind>

export async function runWorktree(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const parsed = parseCommandArgs(argv, ALL)
  const [sub, ...pos] = parsed.positional
  const out = (r: CmdResult) => emit(io, io.flags.json, `buracle worktree${sub !== undefined ? ` ${sub}` : ''}`, r)
  if (sub === undefined) return out(usageError(usage, ['missing subcommand']))
  const spec = SPECS[sub]
  if (spec === undefined) return out(usageError(usage, [`unknown subcommand '${sub}'`]))
  const problems = [...parsed.errors]
  for (const f of Object.keys(parsed.flags)) if (spec[f] === undefined) problems.push(`--${f} does not apply to 'worktree ${sub}'`)
  const needsSlug = sub === 'create' || sub === 'branch' || sub === 'diff' || sub === 'sync' || sub === 'cleanup'
  if (needsSlug && pos[0] === undefined) problems.push('missing <slug>')
  if (pos.length > (needsSlug ? 1 : 0)) problems.push(`unexpected argument '${pos[needsSlug ? 1 : 0]}'`)
  if (sub === 'cleanup' && boolFlag(parsed.flags, 'force') && boolFlag(parsed.flags, 'discard')) problems.push('use either --force or --discard')
  if (problems.length > 0) return out(usageError(usage, problems))
  const sflags: { session?: string, harness?: string } = {}
  const sid = strFlag(parsed.flags, 'session')
  const h = strFlag(parsed.flags, 'harness')
  if (sid !== undefined) sflags.session = sid
  if (h !== undefined) sflags.harness = h
  const s = optionalSession(sflags, ctx.env)
  switch (sub) {
    case 'create': {
      const o: { base?: string, prefix?: string, lane?: boolean } = {}
      const base = strFlag(parsed.flags, 'base')
      const prefix = strFlag(parsed.flags, 'prefix')
      if (base !== undefined) o.base = base
      if (prefix !== undefined) o.prefix = prefix
      if (boolFlag(parsed.flags, 'lane')) o.lane = true
      return out(await worktreeCreate(pos[0], o, ctx, s))
    }
    case 'branch': {
      const o: { base?: string, prefix?: string } = {}
      const base = strFlag(parsed.flags, 'base')
      const prefix = strFlag(parsed.flags, 'prefix')
      if (base !== undefined) o.base = base
      if (prefix !== undefined) o.prefix = prefix
      return out(await worktreeBranch(pos[0], o, ctx, s))
    }
    case 'detect': return out(await worktreeDetect(ctx, s))
    case 'diff': return out(await worktreeDiff(pos[0], ctx))
    case 'sync': return out(await worktreeSync(pos[0], ctx, s))
    case 'cleanup': return out(await worktreeCleanup(pos[0], { force: boolFlag(parsed.flags, 'force'), discard: boolFlag(parsed.flags, 'discard') }, ctx, s))
    default: return out(await worktreeStatus(ctx, s))
  }
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, 'buracle worktree', ctx)
  return runWorktree(argv, io, ctx)
}

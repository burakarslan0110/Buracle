import type { CommandIO } from '../router'
import { parseCommandArgs, strFlag } from '../../workflow/args'
import { reviewScope } from '../../workflow/review-scope'
import { emit, optionalSession, processCtx, usageError, warnCwdGone, type WorkflowCtx } from '../../workflow/result'

export const name = 'review-scope'
export const summary = 'Print the diff range a review should read (base...HEAD)'
export const usage = `Usage: buracle review-scope [--slug <slug>] [--base <ref>] [--json]

Prints {mode, base_ref, diff_range, warning?} for the review of the current work:
  worktree      a Buracle plan worktree (--slug, the current directory, or this session's plan):
                diff_range <base>...<branch>; also worktree_path
  branch        committed work on a feature branch with a clean checkout: <default>...<branch>
  working-tree  uncommitted changes are part of the work: 'git diff <diff_range>' compares that
                commit with the working tree; untracked files are listed separately
The base is the worktree's base branch, else the base 'buracle worktree branch' recorded for the
current branch (or for --slug), else the closest merge-base among origin/HEAD's branch,
init.defaultBranch, main, master, origin/main, origin/master, develop and trunk. --base <ref>
replaces it (a branch, tag or commit; exit 1 when it does not exist). Use diff_range verbatim
(git diff <diff_range>). A warning means the range is probably wrong or empty: resolve it before
reviewing (on the default branch itself, pass --base).`

export async function runReviewScope(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const parsed = parseCommandArgs(argv, { slug: 'string', base: 'string', session: 'string', harness: 'string' })
  const problems = [...parsed.errors]
  if (parsed.positional.length > 0) problems.push(`unexpected argument '${parsed.positional[0]}'`)
  if (problems.length > 0) return emit(io, io.flags.json, 'buracle review-scope', usageError(usage, problems))
  const sflags: { session?: string, harness?: string } = {}
  const sid = strFlag(parsed.flags, 'session')
  const h = strFlag(parsed.flags, 'harness')
  if (sid !== undefined) sflags.session = sid
  if (h !== undefined) sflags.harness = h
  const base = strFlag(parsed.flags, 'base')
  const r = await reviewScope(strFlag(parsed.flags, 'slug'), ctx, optionalSession(sflags, ctx.env), base !== undefined ? { base } : {})
  return emit(io, io.flags.json, 'buracle review-scope', r)
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, 'buracle review-scope', ctx)
  return runReviewScope(argv, io, ctx)
}

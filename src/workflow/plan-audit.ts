import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { auditPlan, parseNameStatus, type AuditFinding, type DiffEntry } from '../core/plan/audit'
import { readPlanFile } from './plan-file'
import { reviewScope } from './review-scope'
import { loadState, type ResolvedSession } from './session-store'
import { git, gitError, porcelain, realish, repoFacts } from './gitx'
import { fail, ok, partial, type CmdResult, type WorkflowCtx } from './result'

function rel(root: string, p: string): string | undefined {
  const r = relative(root, p).split('\\').join('/')
  return r !== '' && !r.startsWith('..') && !isAbsolute(r) ? r : undefined
}

export async function planAudit(pathArg: string | undefined, o: { base?: string, slug?: string }, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  const bound = s !== undefined ? loadState(s.harness, s.sessionId).plan : undefined
  const path = pathArg !== undefined ? resolve(ctx.cwd, pathArg) : bound?.path
  if (path === undefined) return fail('usage', 'no plan: pass <path>, or register a plan in this session (buracle plan register <path>)')
  const r = readPlanFile(path)
  if (!r.ok) return fail(r.code === 'missing' ? 'plan_missing' : 'plan_unreadable', r.error, { path })
  const facts = await repoFacts(ctx.cwd)
  if (facts === undefined) return fail('not_a_repo', `not a git repository: ${ctx.cwd}`)
  const sameBinding = bound !== undefined && bound.path === path
  const scopeRes = await reviewScope(o.slug, ctx, sameBinding || pathArg === undefined ? s : undefined, o.base !== undefined ? { base: o.base } : {})
  if (scopeRes.code !== 0) return scopeRes
  const scope = scopeRes.data as { mode: string, base_ref: string, diff_range: string, branch?: string, worktree_path?: string, warning?: string, note?: string }
  const where = scope.mode === 'worktree' ? (scope.worktree_path ?? facts.mainRoot) : facts.top
  const ns = await git(where, ['diff', '--name-status', '-M', '-z', scope.diff_range], { readOnly: true })
  if (!ns.ok) return fail('git_failed', `git diff --name-status ${scope.diff_range} failed: ${gitError(ns)}`)
  const changes: DiffEntry[] = parseNameStatus(ns.stdout)
  if (scope.mode === 'working-tree') {
    const st = await porcelain(where)
    for (const u of st?.untracked ?? []) if (!changes.some(c => c.path === u)) changes.push({ status: 'A', path: u })
  }
  let exists: (p: string) => boolean
  const goneWorktree = scope.mode === 'worktree' && (scope.worktree_path === undefined || !existsSync(scope.worktree_path))
  const otherBranch = scope.mode === 'branch' && scope.branch !== facts.branch
  if ((goneWorktree || otherBranch) && scope.branch !== undefined) {
    const tree = await git(facts.mainRoot, ['ls-tree', '-r', '-z', '--name-only', scope.branch], { readOnly: true })
    const files = new Set(tree.ok ? tree.stdout.split('\0').filter(x => x !== '') : [])
    exists = p => files.has(p.replace(/\/+$/, '')) || (p.endsWith('/') && [...files].some(f => f.startsWith(p)))
  } else {
    exists = p => existsSync(join(where, p))
  }
  const real = realish(path)
  const ignore = [rel(facts.mainRoot, real), rel(facts.top, real), rel(where, real)].filter((x): x is string => x !== undefined)
  const findings: AuditFinding[] = auditPlan(r.text, changes, { exists, ignore })
  const warnings = findings.filter(f => f.level === 'warning').length
  const data: Record<string, unknown> = {
    ok: warnings === 0, plan: path, mode: scope.mode, base_ref: scope.base_ref, diff_range: scope.diff_range,
    ...(scope.worktree_path !== undefined ? { worktree_path: scope.worktree_path } : {}),
    changed: changes.length, warnings, findings,
    ...(scope.warning !== undefined ? { scope_warning: scope.warning } : {}),
  }
  const shown = rel(ctx.cwd, path) ?? path
  const lines = [
    ...findings.map(f => `${shown}: ${f.level} ${f.code}: ${f.message}`),
    `${shown}: ${changes.length} changed path(s) in ${scope.diff_range} (${scope.mode}); ${warnings === 0 ? 'the diff matches the plan' : `${warnings} warning(s)`}`,
  ]
  const notes = scope.warning !== undefined ? [`warning: review-scope: ${scope.warning}`] : []
  if (warnings > 0) return partial(data, lines, [`${warnings} plan-vs-diff warning(s)`, ...notes])
  return { ...ok(data, lines), errors: notes }
}

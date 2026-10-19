import { existsSync } from 'node:fs'
import type { ResolvedSession } from './session-store'
import { loadState } from './session-store'
import { git, mergeBase, porcelain, refExists, repoFacts, revCount, type RepoFacts } from './gitx'
import { defaultBranchNames, defaultBranches, metaForCheckout, metaForPlan, readMeta, resolveMeta, type WorktreeMeta } from './worktree'
import { branchRecordFor, branchRecordForSlug, type BranchRecord } from './worktree-branch'
import { fail, ok, type CmdResult, type WorkflowCtx } from './result'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export interface ReviewScope {
  mode: 'worktree' | 'branch' | 'working-tree'
  base_ref: string
  diff_range: string
  warning?: string
  base_branch?: string
  branch?: string
  worktree_path?: string
  slug?: string
  ahead?: number
  uncommitted?: { tracked: number, untracked: number }
  untracked?: string[]
  note?: string
}

async function worktreeScope(facts: RepoFacts, m: WorktreeMeta, baseOverride?: string): Promise<ReviewScope> {
  const base = baseOverride ?? m.base
  const scope: ReviewScope = { mode: 'worktree', base_ref: base, diff_range: `${base}...${m.branch}`, base_branch: base, branch: m.branch, slug: m.slug }
  if (existsSync(m.path)) scope.worktree_path = m.path
  const ahead = await revCount(facts.mainRoot, `${base}..${m.branch}`)
  if (ahead !== undefined) scope.ahead = ahead
  const warnings: string[] = []
  if (existsSync(m.path)) {
    const st = await porcelain(m.path)
    if (st !== undefined) {
      scope.uncommitted = { tracked: st.tracked.length, untracked: st.untracked.length }
      const n = st.tracked.length + st.untracked.length
      if (n > 0) warnings.push(`${n} uncommitted change(s) in the worktree ${m.path} are not in ${scope.diff_range}; commit them on ${m.branch} before reviewing`)
    }
  } else {
    scope.note = `the worktree directory ${m.path} no longer exists; the range covers the branch ${m.branch}`
  }
  if (ahead === 0) warnings.push(`${m.branch} has no commits beyond ${base}: the diff is empty${m.synced !== undefined ? ' (it was already squash-merged; review the squash commit instead)' : ''}`)
  if (warnings.length > 0) scope.warning = warnings.join('; ')
  return scope
}

interface Base { name: string, mb: string, ahead: number }

async function pickBase(cwd: string, current: string | undefined): Promise<Base | undefined> {
  let best: Base | undefined
  for (const name of await defaultBranches(cwd)) {
    if (name === current) continue
    const b = await baseFor(cwd, name)
    if (b !== undefined && (best === undefined || b.ahead < best.ahead)) best = b
  }
  return best
}

async function baseFor(cwd: string, name: string): Promise<Base | undefined> {
  const mb = await mergeBase(cwd, 'HEAD', name)
  if (mb === undefined) return undefined
  const ahead = await revCount(cwd, `${mb}..HEAD`)
  return ahead === undefined ? undefined : { name, mb, ahead }
}

async function nothingToReview(cwd: string, branch: string | undefined, base: Base | undefined, explicit: boolean): Promise<string> {
  const head = `HEAD${branch !== undefined ? ` (${branch})` : ''}`
  if (base !== undefined) return `nothing to review: no uncommitted changes and ${head} has no commits beyond ${base.name}${explicit ? '' : '; pass --base <ref> to compare with another branch or commit'}`
  const names = await defaultBranchNames(cwd)
  if (branch !== undefined && names.includes(branch)) {
    return `nothing to review: HEAD is the default branch (${branch}) and there are no uncommitted changes; to review committed work, pass --base <ref> (the branch or commit it should be compared with)`
  }
  return `nothing to review: no uncommitted changes, and no default branch to compare ${head} with was found (tried ${names.join(', ')}); pass --base <ref>`
}

async function checkoutScope(facts: RepoFacts, cwd: string, baseArg: string | undefined): Promise<ReviewScope> {
  const st = await porcelain(cwd)
  const tracked = st?.tracked.length ?? 0
  const untracked = st?.untracked ?? []
  const uncommitted = { tracked, untracked: untracked.length }
  const dirty = tracked + untracked.length > 0
  if (facts.head === undefined) {
    const scope: ReviewScope = { mode: 'working-tree', base_ref: EMPTY_TREE, diff_range: EMPTY_TREE, uncommitted, note: 'the repository has no commits yet; staged files appear in git diff --cached, untracked files only in git status' }
    if (untracked.length > 0) scope.untracked = untracked.slice(0, 200)
    scope.warning = 'the repository has no commits yet: commit a baseline before reviewing, or review the files directly'
    return scope
  }
  const branch = facts.branch
  const base = baseArg !== undefined ? await baseFor(cwd, baseArg) : await pickBase(cwd, branch)
  if (base !== undefined && base.ahead > 0) {
    if (!dirty) {
      return { mode: 'branch', base_ref: base.name, diff_range: `${base.name}...${branch ?? 'HEAD'}`, base_branch: base.name, ...(branch !== undefined ? { branch } : {}), ahead: base.ahead, uncommitted }
    }
    const scope: ReviewScope = {
      mode: 'working-tree', base_ref: base.mb, diff_range: base.mb, base_branch: base.name, ...(branch !== undefined ? { branch } : {}), ahead: base.ahead, uncommitted,
      note: `covers ${base.ahead} commit(s) since ${base.name} plus the uncommitted changes; untracked files are not in git diff (see untracked)`,
    }
    if (untracked.length > 0) scope.untracked = untracked.slice(0, 200)
    return scope
  }
  const scope: ReviewScope = { mode: 'working-tree', base_ref: 'HEAD', diff_range: 'HEAD', ...(branch !== undefined ? { branch } : {}), uncommitted }
  if (base !== undefined) scope.base_branch = base.name
  if (untracked.length > 0) scope.untracked = untracked.slice(0, 200)
  if (baseArg !== undefined && base === undefined) {
    scope.warning = `--base ${baseArg} shares no history with HEAD; the range covers only the uncommitted changes`
  } else if (!dirty) {
    scope.warning = await nothingToReview(cwd, branch, base, baseArg !== undefined)
  } else if (untracked.length > 0) {
    scope.note = 'untracked files are not in git diff; read them directly (see untracked)'
  }
  return scope
}

async function branchScope(facts: RepoFacts, cwd: string, rec: BranchRecord, baseArg: string | undefined): Promise<ReviewScope> {
  const base = baseArg ?? (await refExists(cwd, rec.base) ? rec.base : rec.baseCommit)
  const made = `${rec.branch} was created from ${rec.base} (buracle worktree branch)`
  if (facts.branch === rec.branch) {
    const scope = await checkoutScope(facts, cwd, base)
    return { ...scope, slug: rec.slug, note: [made, scope.note].filter(Boolean).join('; ') }
  }
  const mb = await mergeBase(cwd, base, rec.branch)
  const ahead = mb !== undefined ? await revCount(cwd, `${mb}..${rec.branch}`) : undefined
  const scope: ReviewScope = { mode: 'branch', base_ref: base, diff_range: `${base}...${rec.branch}`, base_branch: base, branch: rec.branch, slug: rec.slug, note: `${made}; HEAD is not on it, so uncommitted changes are not in the range` }
  if (ahead !== undefined) scope.ahead = ahead
  if (ahead === 0) scope.warning = `${rec.branch} has no commits beyond ${base}: the diff is empty`
  return scope
}

export type ScopeResolution = { scope: ReviewScope, facts: RepoFacts } | { error: string, message: string }

export async function resolveReviewScope(slug: string | undefined, cwd: string, s: ResolvedSession | undefined, o: { base?: string } = {}): Promise<ScopeResolution> {
  const facts = await repoFacts(cwd)
  if (facts === undefined) return { error: 'not_a_repo', message: `not a git repository: ${cwd}` }
  const baseArg = o.base?.trim()
  if (baseArg !== undefined) {
    if (baseArg === '' || baseArg.startsWith('-') || !(await refExists(cwd, baseArg))) {
      return { error: 'no_base', message: `--base '${o.base ?? ''}' is not a branch, tag or commit of this repository` }
    }
  }
  const ctx = { cwd }
  let scope: ReviewScope | undefined
  const notes: string[] = []
  if (slug !== undefined) {
    const rec = readMeta(facts.commonDir, slug) === undefined ? branchRecordForSlug(facts.commonDir, slug) : undefined
    const m = rec === undefined ? await resolveMeta(facts, slug) : undefined
    if (rec !== undefined && await refExists(facts.mainRoot, `refs/heads/${rec.branch}`)) scope = await branchScope(facts, ctx.cwd, rec, baseArg)
    else if (m !== undefined && (await git(facts.mainRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${m.branch}`], { readOnly: true })).ok) scope = await worktreeScope(facts, m, baseArg)
    else notes.push(`no plan worktree for '${slug}'; using the current checkout`)
  }
  if (scope === undefined && facts.linked) {
    const m = metaForCheckout(facts)
    if (m !== undefined) scope = await worktreeScope(facts, m, baseArg)
  }
  if (scope === undefined && slug === undefined && s !== undefined) {
    const st = loadState(s.harness, s.sessionId)
    if (st.plan !== undefined) {
      const planPath = st.plan.path
      const m = metaForPlan(facts.commonDir, planPath) ?? await resolveMeta(facts, st.plan.slug)
      if (m !== undefined && m.inferred !== true && m.lane !== true && existsSync(m.path)) scope = await worktreeScope(facts, m, baseArg)
    }
  }
  if (scope === undefined && facts.branch !== undefined) {
    const rec = branchRecordFor(facts.commonDir, facts.branch)
    if (rec !== undefined) scope = await branchScope(facts, ctx.cwd, rec, baseArg)
  }
  scope ??= await checkoutScope(facts, ctx.cwd, baseArg)
  if (notes.length > 0) scope.note = [scope.note, ...notes].filter(Boolean).join('; ')
  return { scope, facts }
}

export async function reviewScope(slug: string | undefined, ctx: WorkflowCtx, s: ResolvedSession | undefined, o: { base?: string } = {}): Promise<CmdResult> {
  const r = await resolveReviewScope(slug, ctx.cwd, s, o)
  if ('error' in r) return fail(r.error, r.message)
  const scope = r.scope
  const lines = [
    `mode: ${scope.mode}`,
    `base_ref: ${scope.base_ref}`,
    `diff_range: ${scope.diff_range}`,
    ...(scope.worktree_path !== undefined ? [`worktree_path: ${scope.worktree_path}`] : []),
    ...(scope.note !== undefined ? [`note: ${scope.note}`] : []),
    ...(scope.warning !== undefined ? [`warning: ${scope.warning}`] : []),
  ]
  return ok(scope as unknown as Record<string, unknown>, lines)
}

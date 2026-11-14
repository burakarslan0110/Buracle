import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isPlanFinished } from '../core/plan/state'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { isValidSessionId } from '../engine/paths'
import { isValidSlug } from './plan-file'
import { actOnMergeDecision, markPlanWorktree, planUnregister } from './plan'
import { laneLead, laneSessionId, loadState, type ResolvedSession } from './session-store'
import {
  acquireRepoLock, git, gitError, listWorktrees, porcelain, realish,
  refExists, repoFacts, updateExclude, type RepoFacts, type WorktreeEntry,
} from './gitx'
import { fail, ok, partial, type CmdResult, type WorkflowCtx } from './result'
import { indexNewWorktree } from './workspace-index'

export const PREFIXES = ['plan-build', 'goal-build', 'bugfix'] as const
export type Prefix = typeof PREFIXES[number]

export interface WorktreeMeta {
  v: 1
  slug: string
  prefix: string
  branch: string
  base: string
  path: string
  createdAt: number
  baseCommit?: string
  planPath?: string
  /**
   * Records of an older Buracle, never written any more: `lane`, `parent` and `owner` by
   * `worktree create --lane`, `synced` by `worktree sync`. They are still read, so a lane worktree
   * left on disk is not taken for a plan's worktree and its `plan --lane` binding is released on cleanup.
   */
  lane?: boolean
  parent?: string
  owner?: { harness: ResolvedSession['harness'], session: string }
  synced?: { at: number, commit?: string }
  inferred?: boolean
}

function metaDir(commonDir: string): string { return join(commonDir, 'buracle', 'worktrees') }
function metaPath(commonDir: string, slug: string): string { return join(metaDir(commonDir), `${slug}.json`) }

export function readMeta(commonDir: string, slug: string): WorktreeMeta | undefined {
  const r = readJsonSafeSync<WorktreeMeta>(metaPath(commonDir, slug))
  if (!r.ok || r.value === null || typeof r.value !== 'object' || r.value.v !== 1 || r.value.slug !== slug) return undefined
  return r.value
}

function writeMeta(commonDir: string, m: WorktreeMeta): void {
  ensureDirSync(metaDir(commonDir))
  const { inferred: _i, ...rest } = m
  atomicWriteSync(metaPath(commonDir, m.slug), JSON.stringify(rest, null, 2) + '\n')
}

function removeMeta(commonDir: string, slug: string): void {
  try { unlinkSync(metaPath(commonDir, slug)) } catch {  }
}

export function listMeta(commonDir: string): WorktreeMeta[] {
  let names: string[] = []
  try { names = readdirSync(metaDir(commonDir)).filter(n => n.endsWith('.json')).sort() } catch { return [] }
  return names.map(n => readMeta(commonDir, n.slice(0, -5))).filter((m): m is WorktreeMeta => m !== undefined)
}

export function metaForPlan(commonDir: string, planPath: string): WorktreeMeta | undefined {
  return listMeta(commonDir)
    .filter(m => m.planPath === planPath && m.lane !== true && existsSync(m.path))
    .sort((a, b) => b.createdAt - a.createdAt)[0]
}

/** Where plan worktrees are created, relative to the main checkout. */
export const WORKTREE_DIR = '.worktrees'

export function worktreeRoot(facts: RepoFacts): string {
  return join(facts.mainRoot, WORKTREE_DIR)
}

export const DEFAULT_BRANCH_NAMES: readonly string[] = ['main', 'master', 'origin/main', 'origin/master', 'develop', 'trunk']

export async function defaultBranchNames(cwd: string): Promise<string[]> {
  const names: string[] = []
  const oh = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { readOnly: true })
  if (oh.ok && oh.out.startsWith('origin/')) names.push(oh.out.slice(7), oh.out)
  const init = await git(cwd, ['config', '--get', 'init.defaultBranch'], { readOnly: true })
  if (init.ok && /^[A-Za-z0-9._/-]+$/.test(init.out)) names.push(init.out)
  names.push(...DEFAULT_BRANCH_NAMES)
  return [...new Set(names)]
}

export async function defaultBranches(cwd: string): Promise<string[]> {
  const out: string[] = []
  for (const n of await defaultBranchNames(cwd)) if (await refExists(cwd, n)) out.push(n)
  return out
}

export async function resolveMeta(facts: RepoFacts, slug: string, entries?: WorktreeEntry[]): Promise<WorktreeMeta | undefined> {
  const m = readMeta(facts.commonDir, slug)
  if (m !== undefined) return m
  const list = entries ?? await listWorktrees(facts.mainRoot)
  const expected = realish(join(worktreeRoot(facts), slug))
  const e = list.find(x => x.path === expected) ?? list.find(x => x.branch !== undefined && PREFIXES.some(p => x.branch === `${p}/${slug}`))
  let branch = e?.branch
  if (branch === undefined) {
    for (const p of PREFIXES) if (await refExists(facts.mainRoot, `refs/heads/${p}/${slug}`)) { branch = `${p}/${slug}`; break }
  }
  if (branch === undefined) return undefined
  const prefix = branch.split('/')[0] ?? 'plan-build'
  const base = (await defaultBranches(facts.mainRoot)).find(b => !b.includes('/')) ?? 'main'
  return { v: 1, slug, prefix, branch, base, path: e?.path ?? expected, createdAt: 0, inferred: true }
}

function sessionPlanFor(prefix: Prefix, s: ResolvedSession | undefined): { own?: string, foreign?: string } {
  if (s === undefined) return {}
  const st = loadState(s.harness, s.sessionId)
  if (st.plan === undefined) return {}
  if (prefix !== 'bugfix' || (st.plan.type === 'Bugfix' && !isPlanFinished(st))) return { own: st.plan.path }
  return { foreign: st.plan.path }
}

function checkSlug(slug: string | undefined): CmdResult | undefined {
  if (slug === undefined) return fail('usage', 'missing <slug>')
  if (!isValidSlug(slug)) return fail('usage', `invalid slug '${slug}': use kebab-case ASCII (a-z, 0-9, '-'), at most 64 characters`)
  return undefined
}

async function needRepo(cwd: string): Promise<RepoFacts | CmdResult> {
  const f = await repoFacts(cwd)
  return f ?? fail('not_a_repo', `not a git repository: ${cwd}`)
}

function isFacts(x: RepoFacts | CmdResult): x is RepoFacts {
  return 'commonDir' in x
}

function excludeEntryFor(facts: RepoFacts, root: string): string | undefined {
  const rel = relative(facts.mainRoot, root)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return `/${rel.split('\\').join('/')}/`
}

export async function worktreeCreate(slugArg: string | undefined, o: { base?: string, prefix?: string }, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  const bad = checkSlug(slugArg)
  if (bad) return bad
  const slug = slugArg as string
  const prefix = (o.prefix ?? 'plan-build') as Prefix
  if (!PREFIXES.includes(prefix)) return fail('usage', `--prefix must be one of ${PREFIXES.join(', ')} (got '${o.prefix}')`)
  const fr = await needRepo(ctx.cwd)
  if (!isFacts(fr)) return fr
  const facts = fr
  if (facts.head === undefined) return fail('no_commits', 'the repository has no commits yet; commit once before creating a worktree')
  let lock
  try {
    lock = await acquireRepoLock(facts.commonDir, `worktree create ${slug}`)
  } catch (e) {
    return fail('locked', e instanceof Error ? e.message : String(e))
  }
  const sessionPlan = sessionPlanFor(prefix, s)
  let result: CmdResult
  try {
    result = await createLocked(facts, slug, prefix, o.base, ctx, sessionPlan.own)
  } finally {
    lock.release()
  }
  if (result.code !== 0) return result
  const plan = s !== undefined && sessionPlan.foreign === undefined ? await markPlanWorktree(true, ctx, s) : undefined
  const untouched = sessionPlan.foreign !== undefined ? [`a bugfix worktree belongs to no plan: the session's plan ${relativeOrAbs(facts.mainRoot, sessionPlan.foreign)} was left untouched`] : undefined
  const warnings = [...result.errors.map(e => e.replace(/^warning: /, '')), ...(untouched ?? planWarnings(plan, s))]
  if (result.data['created'] === true) {
    const local = await porcelain(ctx.cwd)
    if (local !== undefined && local.tracked.length > 0) warnings.push(`${local.tracked.length} uncommitted change(s) in ${facts.top} are not in the new worktree`)
    warnings.push(...await indexNewWorktree(String(result.data['path']), facts, ctx.now))
  }
  return ok({ ...result.data, ...planJson(plan) }, result.lines, warnings)
}

function laneJson(m: Pick<WorktreeMeta, 'lane' | 'parent'>): Record<string, unknown> {
  return m.lane === true ? { lane: true, ...(m.parent !== undefined ? { parent: m.parent } : {}) } : {}
}

async function createLocked(facts: RepoFacts, slug: string, prefix: Prefix, baseArg: string | undefined, ctx: WorkflowCtx, planPath: string | undefined): Promise<CmdResult> {
  const branch = `${prefix}/${slug}`
  const root = worktreeRoot(facts)
  const path = join(root, slug)
  const entries = await listWorktrees(facts.mainRoot)
  const existingMeta = readMeta(facts.commonDir, slug)
  const inside = facts.linked ? listMeta(facts.commonDir).find(x => realish(x.path) === facts.top) : undefined

  const atPath = entries.find(e => e.path === realish(path))
  if (atPath !== undefined) {
    if (atPath.branch !== branch && (existingMeta === undefined || atPath.branch !== existingMeta.branch)) {
      return fail('path_in_use', `${path} is already a worktree on ${atPath.branch ?? 'a detached HEAD'}, not ${branch}`, { path })
    }
    const m: WorktreeMeta = existingMeta ?? { v: 1, slug, prefix, branch: atPath.branch ?? branch, base: baseArg ?? (await defaultBranches(facts.mainRoot)).find(b => !b.includes('/')) ?? 'main', path: atPath.path, createdAt: ctx.now }
    if (existingMeta === undefined) writeMeta(facts.commonDir, m)
    return ok({ ok: true, created: false, path: m.path, branch: m.branch, base: m.base, slug }, [m.path, `Worktree already exists on ${m.branch} (base ${m.base}).`])
  }

  let base = baseArg
  if (base === undefined) {
    if (inside !== undefined) return fail('inside_worktree', `you are inside the plan worktree '${inside.slug}'; run this from the main checkout or pass --base <branch>`)
    base = facts.branch
    if (base === undefined) return fail('detached_head', 'HEAD is detached; pass --base <branch> to choose the branch the worktree starts from and merges back into')
  }
  base = base.replace(/^refs\/heads\//, '')
  if (!await refExists(facts.mainRoot, `refs/heads/${base}`)) return fail('no_base', `base branch '${base}' does not exist locally (it must be a local branch)`)
  if (base === branch) return fail('usage', `the base branch cannot be the worktree branch itself (${branch})`)
  const elsewhere = entries.find(e => e.branch === branch)
  if (elsewhere !== undefined) return fail('branch_checked_out', `branch ${branch} is already checked out at ${elsewhere.path}`)
  if (existsSync(path)) return fail('path_exists', `${path} already exists and is not a worktree of this repository; move it away or pick another slug`)

  const warnings: string[] = []
  const entry = excludeEntryFor(facts, root)
  if (entry !== undefined) {
    try { updateExclude(facts.commonDir, [entry]) } catch (e) { warnings.push(`could not add ${entry} to .git/info/exclude: ${e instanceof Error ? e.message : String(e)}`) }
  }
  const reuse = await refExists(facts.mainRoot, `refs/heads/${branch}`)
  const args = reuse ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base]
  const r = await git(facts.mainRoot, args)
  if (!r.ok) return fail('git_failed', `git worktree add failed: ${gitError(r)}`)
  if (reuse) warnings.push(`branch ${branch} already existed; the worktree continues it`)
  const baseCommit = (await git(facts.mainRoot, ['rev-parse', base], { readOnly: true })).out
  const created = realish(path)
  const m: WorktreeMeta = { v: 1, slug, prefix, branch, base, path: created, createdAt: ctx.now, ...(baseCommit !== '' ? { baseCommit } : {}) }
  if (planPath !== undefined) m.planPath = planPath
  writeMeta(facts.commonDir, m)
  return ok({ ok: true, created: true, path: created, branch, base, slug }, [created, `Created worktree on ${branch} from ${base}. Work inside it: cd ${created}`], warnings)
}

function planJson(plan: Awaited<ReturnType<typeof markPlanWorktree>>): Record<string, unknown> {
  if (plan === undefined) return { plan: null }
  if ('error' in plan) return { plan: { error: plan.error } }
  return { plan: { path: plan.path, worktree: true, changed: plan.changed } }
}

function planWarnings(plan: Awaited<ReturnType<typeof markPlanWorktree>>, s: ResolvedSession | undefined): string[] {
  if (s === undefined) return ['no harness session: worktree: true was not set on a plan']
  if (plan === undefined) return ['no plan is registered in this session: worktree: true was not set on a plan']
  if ('error' in plan) return [`could not set worktree: true on the plan: ${plan.error}`]
  return []
}

export async function worktreeDetect(ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  const facts = await repoFacts(ctx.cwd)
  if (facts === undefined) {
    return ok({ inWorktree: false, path: null, branch: null, base: null, slug: null, repo: null }, ['Not in a git repository.'])
  }
  const data: Record<string, unknown> = { inWorktree: false, path: null, branch: null, base: null, slug: null, repo: facts.mainRoot }
  const lines: string[] = []
  if (facts.linked) {
    const metas = listMeta(facts.commonDir)
    let m = metas.find(x => realish(x.path) === facts.top)
    if (m === undefined) {
      const rel = relative(worktreeRoot(facts), facts.top)
      if (rel !== '' && !rel.startsWith('..') && !rel.includes('/') && isValidSlug(rel)) m = await resolveMeta(facts, rel)
    }
    if (m !== undefined) {
      Object.assign(data, { inWorktree: true, path: facts.top, branch: facts.branch ?? m.branch, base: m.base, slug: m.slug, ...(m.inferred ? { inferred: true } : {}), ...laneJson(m) })
      lines.push(m.lane === true
        ? `In lane worktree '${m.slug}': ${facts.top} on ${facts.branch ?? m.branch} (base ${m.base}${m.parent !== undefined ? `, created in '${m.parent}'` : ''}).`
        : `In plan worktree '${m.slug}': ${facts.top} on ${facts.branch ?? m.branch} (base ${m.base}).`)
    } else {
      data['linked'] = { path: facts.top, branch: facts.branch ?? null }
      lines.push(`In a linked worktree that Buracle does not manage: ${facts.top}.`)
    }
  } else {
    lines.push(`Not in a plan worktree (main checkout ${facts.mainRoot}${facts.branch !== undefined ? ` on ${facts.branch}` : ''}).`)
  }
  if (s !== undefined) {
    const st = loadState(s.harness, s.sessionId)
    if (st.plan !== undefined) {
      const planPath = st.plan.path
      const m = metaForPlan(facts.commonDir, planPath) ?? await resolveMeta(facts, st.plan.slug)
      if (m !== undefined && m.lane !== true && existsSync(m.path)) {
        data['planWorktree'] = { slug: m.slug, path: m.path, branch: m.branch, base: m.base }
        if (data['inWorktree'] !== true) lines.push(`This session's plan has a worktree: ${m.path} (cd there to work).`)
      }
    }
  }
  return ok(data, lines)
}

async function describe(facts: RepoFacts, m: WorktreeMeta, entries: WorktreeEntry[]): Promise<Record<string, unknown>> {
  const entry = entries.find(e => e.path === realish(m.path))
  const out: Record<string, unknown> = { slug: m.slug, path: m.path, branch: m.branch, base: m.base, exists: entry !== undefined && existsSync(m.path) }
  const counts = await git(facts.mainRoot, ['rev-list', '--left-right', '--count', `${m.base}...${m.branch}`], { readOnly: true })
  const mm = /^(\d+)\s+(\d+)$/.exec(counts.out)
  if (counts.ok && mm) { out['behind'] = Number(mm[1]); out['ahead'] = Number(mm[2]) }
  if (out['exists'] === true) {
    const st = await porcelain(m.path)
    if (st !== undefined) out['dirty'] = st.tracked.length + st.untracked.length
  }
  if (m.planPath !== undefined) out['plan'] = m.planPath
  if (m.inferred) out['inferred'] = true
  Object.assign(out, laneJson(m))
  return out
}

export async function worktreeStatus(ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  const fr = await needRepo(ctx.cwd)
  if (!isFacts(fr)) return fr
  const facts = fr
  const entries = await listWorktrees(facts.mainRoot)
  const metas = listMeta(facts.commonDir)
  const root = realish(worktreeRoot(facts))
  for (const e of entries) {
    const rel = relative(root, e.path)
    if (rel === '' || rel.startsWith('..') || rel.includes('/') || !isValidSlug(rel) || metas.some(m => m.slug === rel)) continue
    const m = await resolveMeta(facts, rel, entries)
    if (m) metas.push(m)
  }
  const worktrees = await Promise.all(metas.map(m => describe(facts, m, entries)))
  let sessionInfo: Record<string, unknown> | undefined
  if (s !== undefined) {
    const st = loadState(s.harness, s.sessionId)
    const planSlug = st.plan?.slug
    const planPath = st.plan?.path
    const mine = planPath === undefined ? undefined : metaForPlan(facts.commonDir, planPath) ?? metas.find(m => m.slug === planSlug && m.lane !== true)
    sessionInfo = { harness: s.harness, id: s.sessionId, plan: planSlug ?? null, worktree: mine?.slug ?? null }
  }
  const lines = worktrees.length === 0 ? ['No plan worktrees.'] : worktrees.map(w => `${String(w['slug'])}: ${String(w['path'])} [${String(w['branch'])} → ${String(w['base'])}]${w['lane'] === true ? ' (lane)' : ''}${w['exists'] === false ? ' (missing)' : ''}${typeof w['ahead'] === 'number' ? ` ahead ${String(w['ahead'])}` : ''}${typeof w['dirty'] === 'number' && (w['dirty'] as number) > 0 ? `, ${String(w['dirty'])} uncommitted` : ''}`)
  if (sessionInfo !== undefined && sessionInfo['worktree'] !== null) lines.push(`This session's plan worktree: ${String(sessionInfo['worktree'])}`)
  return ok({ repo: facts.mainRoot, worktrees, ...(sessionInfo !== undefined ? { session: sessionInfo } : {}) }, lines)
}

export async function worktreeDiff(slugArg: string | undefined, ctx: WorkflowCtx): Promise<CmdResult> {
  const bad = checkSlug(slugArg)
  if (bad) return bad
  const slug = slugArg as string
  const fr = await needRepo(ctx.cwd)
  if (!isFacts(fr)) return fr
  const facts = fr
  const m = await resolveMeta(facts, slug)
  if (m === undefined) return fail('not_found', `no plan worktree or branch for '${slug}'`)
  if (!await refExists(facts.mainRoot, `refs/heads/${m.branch}`)) return fail('no_branch', `branch ${m.branch} does not exist`)
  const range = `${m.base}...${m.branch}`
  const log1 = await git(facts.mainRoot, ['log', '--format=%H%x09%s', `${m.base}..${m.branch}`], { readOnly: true })
  const commits = log1.ok && log1.out !== '' ? log1.out.split('\n').map(l => { const [sha, ...rest] = l.split('\t'); return { sha: sha ?? '', subject: rest.join('\t') } }) : []
  const ns = await git(facts.mainRoot, ['diff', '--name-status', '-M', range], { readOnly: true })
  const files = ns.ok && ns.out !== '' ? ns.out.split('\n').map(l => { const parts = l.split('\t'); return { status: parts[0] ?? '', path: parts[parts.length - 1] ?? '', ...(parts.length > 2 ? { from: parts[1] } : {}) } }) : []
  const ss = await git(facts.mainRoot, ['diff', '--shortstat', range], { readOnly: true })
  const stat = { files: Number(/(\d+) files? changed/.exec(ss.out)?.[1] ?? 0), insertions: Number(/(\d+) insertions?/.exec(ss.out)?.[1] ?? 0), deletions: Number(/(\d+) deletions?/.exec(ss.out)?.[1] ?? 0) }
  let uncommitted: { tracked: string[], untracked: string[] } | null = null
  if (existsSync(m.path)) {
    const st = await porcelain(m.path)
    if (st !== undefined) uncommitted = { tracked: st.tracked, untracked: st.untracked }
  }
  const warnings: string[] = []
  if (uncommitted !== null && uncommitted.tracked.length + uncommitted.untracked.length > 0) warnings.push(`${uncommitted.tracked.length + uncommitted.untracked.length} uncommitted change(s) in ${m.path} are not part of the diff; commit them first`)
  const lines = [
    `${m.branch} vs ${m.base} (${range}): ${commits.length} commit(s), ${stat.files} file(s), +${stat.insertions} -${stat.deletions}`,
    ...commits.slice(0, 30).map(c => `  ${c.sha.slice(0, 9)} ${c.subject}`),
    ...files.map(f => `  ${f.status}\t${f.path}`),
  ]
  return ok({ slug, path: m.path, branch: m.branch, base: m.base, diff_range: range, commits, files, stat, uncommitted }, lines, warnings)
}

function relativeOrAbs(root: string, p: string): string {
  const rel = relative(root, p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : p
}

async function containedIn(cwd: string, base: string, branch: string): Promise<boolean> {
  const anc = await git(cwd, ['merge-base', '--is-ancestor', branch, base], { readOnly: true })
  if (anc.ok) return true
  const mt = await git(cwd, ['merge-tree', '--write-tree', '--no-messages', base, branch], { readOnly: true })
  if (mt.code !== 0) return false
  const baseTree = await git(cwd, ['rev-parse', `${base}^{tree}`], { readOnly: true })
  return baseTree.ok && (mt.out.split('\n')[0] ?? '') === baseTree.out
}

async function releaseLane(m: WorktreeMeta, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<void> {
  const lead = laneLead(m.owner, s)
  if (lead === undefined) return
  const id = laneSessionId(lead.sessionId, m.slug)
  if (!isValidSessionId(id)) return
  try {
    await planUnregister(ctx, { harness: lead.harness, sessionId: id, source: `--lane ${m.slug}` }, { lane: m.slug, lead })
  } catch (e) {
    log('warn', 'worktree cleanup: the lane binding could not be released', { slug: m.slug, error: e })
  }
}

export async function worktreeCleanup(slugArg: string | undefined, o: { force: boolean, discard: boolean }, ctx: WorkflowCtx, s?: ResolvedSession): Promise<CmdResult> {
  const bad = checkSlug(slugArg)
  if (bad) return bad
  const slug = slugArg as string
  const fr = await needRepo(ctx.cwd)
  if (!isFacts(fr)) return fr
  const facts = fr
  const m = await resolveMeta(facts, slug)
  if (m === undefined) {
    removeMeta(facts.commonDir, slug)
    return ok({ ok: true, removed: { worktree: false, branch: false }, slug, repoRoot: facts.mainRoot }, [`Nothing to clean up for '${slug}'.`])
  }
  let lock
  try {
    lock = await acquireRepoLock(facts.commonDir, `worktree cleanup ${slug}`)
  } catch (e) {
    return fail('locked', e instanceof Error ? e.message : String(e))
  }
  try {
    const root = facts.mainRoot
    const entries = await listWorktrees(root)
    const entry = entries.find(e => e.path === realish(m.path))
    const present = entry !== undefined && existsSync(m.path)
    const branchExists = await refExists(root, `refs/heads/${m.branch}`)
    let dirtyFiles: string[] = []
    if (present) {
      const st = await porcelain(m.path)
      dirtyFiles = st === undefined ? ['(unreadable status)'] : [...st.tracked, ...st.untracked]
    }
    const reasons: string[] = []
    if (dirtyFiles.length > 0 && !o.discard) {
      reasons.push(`${m.path} has ${dirtyFiles.length} uncommitted change(s) (${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? ', …' : ''}): commit and merge them, or re-run with --discard to delete them${o.force ? ' (--force never deletes uncommitted work)' : ''}`)
    }
    let mode: '-d' | '-D' = '-d'
    let mergedHow = 'not needed'
    if (branchExists) {
      const ancestor = (await git(root, ['merge-base', '--is-ancestor', m.branch, m.base], { readOnly: true })).ok
      if (ancestor) { mode = '-d'; mergedHow = 'merged' }
      else if (await containedIn(root, m.base, m.branch)) { mode = '-D'; mergedHow = `its changes are already in ${m.base}` }
      else if (o.force || o.discard) { mode = '-D'; mergedHow = o.discard ? 'discarded' : 'forced' }
      else reasons.push(`branch ${m.branch} has commits that are not in ${m.base}: merge it into ${m.base} first, re-run with --force if they landed another way, or with --discard to delete them`)
    }
    if (reasons.length > 0) return partial({ ok: false, refused: true, slug, path: m.path, branch: m.branch, reasons }, [], [`refused: cleanup ${slug}`, ...reasons.map(r => `  - ${r}`)])

    const removed = { worktree: false, branch: false }
    if (entry !== undefined) {
      const r = present ? await git(root, ['worktree', 'remove', '--force', m.path]) : await git(root, ['worktree', 'prune'])
      if (!r.ok) return fail('git_failed', `git worktree remove failed: ${gitError(r)}`)
      removed.worktree = present
    }
    if (branchExists) {
      const holder = (await listWorktrees(root)).find(e => e.branch === m.branch)
      if (holder !== undefined) return fail('branch_checked_out', `branch ${m.branch} is checked out at ${holder.path}; switch that checkout away first`)
      const r = await git(root, ['branch', mode, m.branch])
      if (!r.ok) return fail('git_failed', `the worktree was removed, but deleting ${m.branch} failed: ${gitError(r)}`)
      removed.branch = true
    }
    removeMeta(facts.commonDir, slug)
    await git(root, ['worktree', 'prune'])
    if (m.lane === true) await releaseLane(m, ctx, s)
    const lines = [`Removed ${removed.worktree ? `worktree ${m.path}` : 'no worktree'} and ${removed.branch ? `branch ${m.branch} (${mergedHow})` : 'no branch'}.`, `Main checkout: ${root} (cd there if your shell was inside the worktree).`]
    const acted = o.discard ? actOnMergeDecision(s, m, ctx.now) : undefined
    const data = { ok: true, slug, path: m.path, branch: m.branch, removed, repoRoot: root, project_root: root }
    return acted === undefined ? ok(data, lines) : ok({ ...data, resumed: true }, [...lines, acted])
  } finally {
    lock.release()
  }
}

export function metaForCheckout(facts: RepoFacts): WorktreeMeta | undefined {
  return listMeta(facts.commonDir).find(x => realish(x.path) === facts.top)
}


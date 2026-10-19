import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { PlanType } from '../core/plan/format'
import { isPlanFinished } from '../core/plan/state'
import { loadConfigSync } from '../engine/config'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { expandHome, isValidSessionId } from '../engine/paths'
import { isValidSlug, readPlanFile, type PlanInfo } from './plan-file'
import { actOnMergeDecision, markPlanWorktree, planUnregister } from './plan'
import { laneLead, laneSessionId, loadState, type ResolvedSession } from './session-store'
import {
  acquireRepoLock, git, gitError, listWorktrees, mergeBase, operationInProgress, porcelain, realish,
  refExists, repoFacts, revCount, updateExclude, type RepoFacts, type WorktreeEntry,
} from './gitx'
import { fail, ok, partial, type CmdResult, type WorkflowCtx } from './result'
import { indexNewWorktree } from './workspace-index'

export const PREFIXES = ['plan-build', 'goal-build', 'bugfix'] as const
export type Prefix = typeof PREFIXES[number]

export interface SyncRecord {
  at: number
  commit?: string
  branchTip: string
  exit: 0 | 2
  noop?: boolean
  stash?: string
}

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
  lane?: boolean
  parent?: string
  owner?: { harness: ResolvedSession['harness'], session: string }
  synced?: SyncRecord
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

export function worktreeRoot(facts: RepoFacts): string {
  let dir = '.worktrees'
  try { dir = loadConfigSync().config.plan.worktreeDir.trim() || '.worktrees' } catch {  }
  dir = expandHome(dir)
  if (!isAbsolute(dir) && dir.startsWith('~')) {
    log('warn', "plan.worktreeDir starts with '~' but is not '~/…'; using .worktrees", { worktreeDir: dir })
    dir = '.worktrees'
  }
  return isAbsolute(dir) ? dir : join(facts.mainRoot, dir)
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

interface PlanRef { path: string, info: PlanInfo }

function findPlanFor(facts: RepoFacts, m: WorktreeMeta, s: ResolvedSession | undefined): PlanRef | undefined {
  const tryPath = (p: string | undefined): PlanRef | undefined => {
    if (p === undefined) return undefined
    const r = readPlanFile(p)
    return r.ok ? { path: p, info: r.info } : undefined
  }
  const fromMeta = tryPath(m.planPath)
  if (fromMeta) return fromMeta
  if (m.prefix === 'bugfix') return undefined
  if (s !== undefined) {
    const st = loadState(s.harness, s.sessionId)
    if (st.plan !== undefined && st.plan.slug === m.slug) {
      const p = tryPath(st.plan.path)
      if (p) return p
    }
  }
  for (const d of ['docs/plans', 'docs/builds']) {
    let names: string[] = []
    try { names = readdirSync(join(facts.mainRoot, d)) } catch { continue }
    const hit = names.filter(n => new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${m.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md$`).test(n)).sort().pop()
    const p = tryPath(hit !== undefined ? join(facts.mainRoot, d, hit) : undefined)
    if (p) return p
  }
  return undefined
}

export function commitMessage(o: { title?: string, type?: PlanType, prefix: string, slug: string, branch: string, base: string, commits: string[], planRel?: string, detail?: string }): { subject: string, body: string } {
  const kind = o.type === 'Bugfix' || (o.type === undefined && o.prefix === 'bugfix') ? 'fix' : 'feat'
  let text = (o.title ?? '').trim()
  text = text.replace(/^(?:feat|fix|chore|refactor|docs|test|perf|build|ci|style)(?:\([^)]*\))?!?:\s*/i, '').trim()
  if (text === '') text = o.slug.replace(/-/g, ' ')
  const first = text.split(/\s/)[0] ?? ''
  if (/^\p{Lu}\p{Ll}/u.test(first) && !/^\p{Lu}\p{Ll}*\p{Lu}/u.test(first)) {
    const c = text[0] as string
    text = (c === 'İ' || c === 'I' ? 'i' : c.toLowerCase()) + text.slice(1)
  }
  let subject = `${kind}: ${text}`.replace(/\s+/g, ' ')
  if (subject.length > 72) {
    const cut = subject.slice(0, 72)
    const sp = cut.lastIndexOf(' ')
    subject = (sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, '')
  }
  const lines = [`Squash-merge of ${o.branch} into ${o.base} (${o.commits.length} commit${o.commits.length === 1 ? '' : 's'}).`]
  if (o.planRel !== undefined) lines.push(`Plan: ${o.planRel}`)
  if (o.commits.length > 0) {
    lines.push('')
    for (const c of o.commits.slice(0, 40)) lines.push(`- ${c}`)
    if (o.commits.length > 40) lines.push(`- … and ${o.commits.length - 40} more`)
  }
  const detail = (o.detail ?? '').trim()
  if (detail !== '') lines.push('', detail)
  return { subject, body: lines.join('\n') }
}

async function planlessMessage(root: string, m: WorktreeMeta, count: number): Promise<{ title?: string, detail?: string }> {
  const r = await git(root, ['log', '--reverse', '--format=%B%x1e', `${m.base}..${m.branch}`], { readOnly: true })
  if (!r.ok) return {}
  const messages = r.out.split('\u001e').map(t => t.trim()).filter(t => t !== '')
  if (count === 1 && messages.length === 1) {
    const [first = '', ...rest] = (messages[0] as string).split('\n')
    const detail = rest.join('\n').trim()
    return first.trim() === '' ? {} : { title: first.trim(), ...(detail !== '' ? { detail } : {}) }
  }
  const causes = [...new Set(messages.flatMap(t => t.split('\n').slice(1).map(l => l.trim()).filter(l => /^Root cause:/.test(l))))]
  return causes.length > 0 ? { detail: causes.join('\n') } : {}
}

function sessionPlanFor(prefix: Prefix, lane: boolean, s: ResolvedSession | undefined): { own?: string, foreign?: string } {
  if (lane || s === undefined) return {}
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

export async function worktreeCreate(slugArg: string | undefined, o: { base?: string, prefix?: string, lane?: boolean }, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  const bad = checkSlug(slugArg)
  if (bad) return bad
  const slug = slugArg as string
  const lane = o.lane === true
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
  const sessionPlan = sessionPlanFor(prefix, lane, s)
  let result: CmdResult
  try {
    result = await createLocked(facts, slug, prefix, o.base, lane, ctx, sessionPlan.own, lane && s !== undefined ? { harness: s.harness, session: s.sessionId } : undefined)
  } finally {
    lock.release()
  }
  if (result.code !== 0) return result
  const plan = !lane && s !== undefined && sessionPlan.foreign === undefined ? await markPlanWorktree(true, ctx, s) : undefined
  const untouched = sessionPlan.foreign !== undefined ? [`a bugfix worktree belongs to no plan: the session's plan ${relativeOrAbs(facts.mainRoot, sessionPlan.foreign)} was left untouched`] : undefined
  const warnings = [...result.errors.map(e => e.replace(/^warning: /, '')), ...(lane ? [] : untouched ?? planWarnings(plan, s))]
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

async function createLocked(facts: RepoFacts, slug: string, prefix: Prefix, baseArg: string | undefined, lane: boolean, ctx: WorkflowCtx, planPath: string | undefined, owner?: WorktreeMeta['owner']): Promise<CmdResult> {
  const branch = `${prefix}/${slug}`
  const root = worktreeRoot(facts)
  const path = join(root, slug)
  const entries = await listWorktrees(facts.mainRoot)
  const existingMeta = readMeta(facts.commonDir, slug)
  const inside = facts.linked ? listMeta(facts.commonDir).find(x => realish(x.path) === facts.top) : undefined
  const laneFields: Pick<WorktreeMeta, 'lane' | 'parent' | 'owner'> = lane ? { lane: true, ...(inside !== undefined ? { parent: inside.slug } : {}), ...(owner !== undefined ? { owner } : {}) } : {}

  const atPath = entries.find(e => e.path === realish(path))
  if (atPath !== undefined) {
    if (atPath.branch !== branch && (existingMeta === undefined || atPath.branch !== existingMeta.branch)) {
      return fail('path_in_use', `${path} is already a worktree on ${atPath.branch ?? 'a detached HEAD'}, not ${branch}`, { path })
    }
    const here = lane && facts.branch !== undefined && facts.branch !== (atPath.branch ?? branch) ? facts.branch : undefined
    const m: WorktreeMeta = existingMeta ?? { v: 1, slug, prefix, branch: atPath.branch ?? branch, base: baseArg ?? here ?? (await defaultBranches(facts.mainRoot)).find(b => !b.includes('/')) ?? 'main', path: atPath.path, createdAt: ctx.now, ...laneFields }
    if (existingMeta === undefined) writeMeta(facts.commonDir, m)
    return ok({ ok: true, created: false, path: m.path, branch: m.branch, base: m.base, slug, ...laneJson(m) }, [m.path, `Worktree already exists on ${m.branch} (base ${m.base}).`])
  }

  let base = baseArg
  if (base === undefined) {
    if (inside !== undefined && !lane) return fail('inside_worktree', `you are inside the plan worktree '${inside.slug}'; run this from the main checkout or pass --base <branch>`)
    base = facts.branch
    if (base === undefined) return fail('detached_head', 'HEAD is detached; pass --base <branch> to choose the branch the worktree starts from and merges back into')
  }
  base = base.replace(/^refs\/heads\//, '')
  if (!await refExists(facts.mainRoot, `refs/heads/${base}`)) return fail('no_base', `base branch '${base}' does not exist locally (it must be a local branch so 'worktree sync' can merge into it)`)
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
  const m: WorktreeMeta = { v: 1, slug, prefix, branch, base, path: created, createdAt: ctx.now, ...(baseCommit !== '' ? { baseCommit } : {}), ...laneFields }
  if (planPath !== undefined) m.planPath = planPath
  writeMeta(facts.commonDir, m)
  return ok({ ok: true, created: true, path: created, branch, base, slug, ...laneJson(m) }, [created, `Created ${lane ? 'lane ' : ''}worktree on ${branch} from ${base}. Work inside it: cd ${created}`], warnings)
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
  if (m.synced !== undefined) out['synced'] = m.synced
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
  const lines = worktrees.length === 0 ? ['No plan worktrees.'] : worktrees.map(w => `${String(w['slug'])}: ${String(w['path'])} [${String(w['branch'])} → ${String(w['base'])}]${w['lane'] === true ? ' (lane)' : ''}${w['exists'] === false ? ' (missing)' : ''}${typeof w['ahead'] === 'number' ? ` ahead ${String(w['ahead'])}` : ''}${typeof w['dirty'] === 'number' && (w['dirty'] as number) > 0 ? `, ${String(w['dirty'])} uncommitted` : ''}${w['synced'] !== undefined ? ', synced' : ''}`)
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
  if (uncommitted !== null && uncommitted.tracked.length + uncommitted.untracked.length > 0) warnings.push(`${uncommitted.tracked.length + uncommitted.untracked.length} uncommitted change(s) in ${m.path} are not part of the diff; commit them before syncing`)
  const lines = [
    `${m.branch} vs ${m.base} (${range}): ${commits.length} commit(s), ${stat.files} file(s), +${stat.insertions} -${stat.deletions}`,
    ...commits.slice(0, 30).map(c => `  ${c.sha.slice(0, 9)} ${c.subject}`),
    ...files.map(f => `  ${f.status}\t${f.path}`),
  ]
  return ok({ slug, path: m.path, branch: m.branch, base: m.base, diff_range: range, commits, files, stat, uncommitted, ...(m.synced !== undefined ? { synced: m.synced } : {}) }, lines, warnings)
}

async function stashRef(cwd: string, sha: string): Promise<string | undefined> {
  const r = await git(cwd, ['stash', 'list', '--format=%H'], { readOnly: true })
  if (!r.ok) return undefined
  const i = r.out.split('\n').indexOf(sha)
  return i >= 0 ? `stash@{${i}}` : undefined
}

async function namesBetween(cwd: string, a: string, b: string): Promise<string[]> {
  const r = await git(cwd, ['diff', '--name-only', '--no-renames', a, b], { readOnly: true })
  return r.ok && r.out !== '' ? r.out.split('\n') : []
}

async function undoPartialPop(cwd: string, stash: string): Promise<void> {
  const paths = [...new Set([...await namesBetween(cwd, `${stash}^1`, stash), ...await namesBetween(cwd, `${stash}^1`, `${stash}^2`)])]
  if (paths.length === 0) return
  await git(cwd, ['reset', '-q', '--', ...paths])
  const inHead = await git(cwd, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...paths], { readOnly: true })
  const tracked = new Set(inHead.ok && inHead.out !== '' ? inHead.out.split('\n') : [])
  const restore = paths.filter(p => tracked.has(p))
  if (restore.length > 0) await git(cwd, ['checkout', '-q', 'HEAD', '--', ...restore])
  for (const p of paths.filter(x => !tracked.has(x))) {
    const abs = join(cwd, p)
    if (!existsSync(abs)) continue
    const disk = await git(cwd, ['hash-object', '--', p], { readOnly: true })
    const inStash = await git(cwd, ['rev-parse', '--verify', '--quiet', `${stash}:${p}`], { readOnly: true })
    if (disk.ok && inStash.ok && disk.out === inStash.out) {
      try { unlinkSync(abs) } catch {  }
    }
  }
}

const PLAN_DIR_FILE = /^docs\/(?:plans|builds)\/[^/]+\.md$/

async function planFilesKeptOut(facts: RepoFacts, where: string, m: WorktreeMeta, tracked: readonly string[], planPath: string | undefined): Promise<{ paths: string[] } | { conflict: string }> {
  const planRel = planPath !== undefined ? relative(where, realish(planPath)).split('\\').join('/') : undefined
  const isPlan = (p: string) => p === planRel || PLAN_DIR_FILE.test(p)
  const candidates = tracked.filter(isPlan)
  if (candidates.length === 0) return { paths: [] }
  const touched = new Set(await namesBetween(facts.mainRoot, await mergeBase(facts.mainRoot, m.base, m.branch) ?? m.base, m.branch))
  if (planRel !== undefined && candidates.includes(planRel) && touched.has(planRel)) return { conflict: planRel }
  return { paths: candidates.filter(p => !touched.has(p)) }
}

async function unstageKeeping(where: string, paths: readonly string[]): Promise<(() => Promise<void>) | undefined> {
  if (paths.length === 0) return undefined
  const staged = await git(where, ['diff', '--cached', '--name-only', '--no-renames', '--', ...paths.map(p => `:(top,literal)${p}`)], { readOnly: true })
  const names = staged.ok && staged.out !== '' ? staged.out.split('\n') : []
  if (names.length === 0) return undefined
  const entries: Array<{ path: string, entry?: { mode: string, sha: string } }> = []
  for (const p of names) {
    const ls = await git(where, ['ls-files', '-s', '--', `:(top,literal)${p}`], { readOnly: true })
    const mm = /^(\d+) ([0-9a-f]+) 0\t/.exec(ls.out)
    entries.push(mm ? { path: p, entry: { mode: mm[1] as string, sha: mm[2] as string } } : { path: p })
  }
  await git(where, ['reset', '-q', '--', ...names.map(p => `:(top,literal)${p}`)])
  return async () => {
    for (const e of entries) {
      const r = e.entry !== undefined
        ? await git(where, ['update-index', '--add', '--cacheinfo', `${e.entry.mode},${e.entry.sha},${e.path}`])
        : await git(where, ['update-index', '--force-remove', '--', e.path])
      if (!r.ok) log('warn', 'could not restore the staged state of a plan file', { path: e.path, error: gitError(r) })
    }
  }
}

interface RestoreResult { ok: boolean, ref?: string, conflicts?: string[], error?: string, indexLost?: boolean }

async function restoreStash(cwd: string, stash: string, headNow: string): Promise<RestoreResult> {
  const ref = await stashRef(cwd, stash)
  if (ref === undefined) return { ok: false, error: `the stash ${stash.slice(0, 12)} is no longer in 'git stash list'` }
  const dry = await git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${stash}^1`, headNow, stash], { readOnly: true })
  if (dry.code === 1) {
    const conflicts = dry.out.split('\n').slice(1).filter(l => l.trim() !== '')
    return { ok: false, ref, conflicts }
  }
  const withIndex = await git(cwd, ['stash', 'pop', '--index', '-q', ref])
  if (withIndex.ok) return { ok: true, ref }
  await undoPartialPop(cwd, stash)
  const plain = await git(cwd, ['stash', 'pop', '-q', ref])
  if (plain.ok) return { ok: true, ref, indexLost: true }
  await undoPartialPop(cwd, stash)
  return { ok: false, ref, error: gitError(plain) }
}

export async function worktreeSync(slugArg: string | undefined, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  const seen: { meta?: WorktreeMeta } = {}
  const r = await squashSync(slugArg, ctx, s, seen)
  if (r.code === 1 || seen.meta === undefined) return r
  const acted = actOnMergeDecision(s, seen.meta, ctx.now)
  return acted === undefined ? r : { ...r, data: { ...r.data, resumed: true }, lines: [...r.lines, acted] }
}

async function squashSync(slugArg: string | undefined, ctx: WorkflowCtx, s: ResolvedSession | undefined, seen: { meta?: WorktreeMeta }): Promise<CmdResult> {
  const bad = checkSlug(slugArg)
  if (bad) return bad
  const slug = slugArg as string
  const fr = await needRepo(ctx.cwd)
  if (!isFacts(fr)) return fr
  const facts = fr
  const m = await resolveMeta(facts, slug)
  if (m === undefined) return fail('not_found', `no plan worktree or branch for '${slug}'`)
  seen.meta = m
  let lock
  try {
    lock = await acquireRepoLock(facts.commonDir, `worktree sync ${slug}`)
  } catch (e) {
    return fail('locked', e instanceof Error ? e.message : String(e))
  }
  let temp: string | undefined
  let restorePlanIndex: (() => Promise<void>) | undefined
  try {
    const entries = await listWorktrees(facts.mainRoot)
    const wt = entries.find(e => e.path === realish(m.path))
    if (wt !== undefined && existsSync(m.path)) {
      if (wt.branch !== m.branch) return fail('wrong_branch', `${m.path} is on ${wt.branch ?? 'a detached HEAD'}, expected ${m.branch}`)
      const st = await porcelain(m.path)
      if (st === undefined) return fail('git_failed', `cannot read the status of ${m.path}`)
      const n = st.tracked.length + st.untracked.length
      if (n > 0) return fail('worktree_dirty', `nothing merged: ${n} uncommitted change(s) in ${m.path} (${[...st.tracked, ...st.untracked].slice(0, 5).join(', ')}${n > 5 ? ', …' : ''}); commit them on ${m.branch} first`, { path: m.path })
    }
    if (!await refExists(facts.mainRoot, `refs/heads/${m.branch}`)) return fail('no_branch', `branch ${m.branch} does not exist`)
    if (!await refExists(facts.mainRoot, `refs/heads/${m.base}`)) return fail('no_base', `base branch ${m.base} does not exist`)
    const branchTip = (await git(facts.mainRoot, ['rev-parse', m.branch], { readOnly: true })).out
    if (m.synced !== undefined && m.synced.branchTip === branchTip) {
      const lines = [`Already merged: ${m.branch} was squash-merged into ${m.base}${m.synced.commit !== undefined ? ` as ${m.synced.commit.slice(0, 9)}` : ''}.`]
      const warn = m.synced.stash !== undefined ? [`your earlier local changes are still in the stash (${m.synced.stash.slice(0, 12)}); restore them with 'git stash pop' when ready`] : []
      return ok({ ok: true, merged: true, already: true, slug, branch: m.branch, base: m.base, commit: m.synced.commit ?? null, synced: m.synced }, lines, warn)
    }
    const ahead = await revCount(facts.mainRoot, `${m.base}..${m.branch}`)
    const commitsLog = await git(facts.mainRoot, ['log', '--reverse', '--format=%s', `${m.base}..${m.branch}`], { readOnly: true })
    const commitSubjects = commitsLog.ok && commitsLog.out !== '' ? commitsLog.out.split('\n') : []
    const record = (rec: SyncRecord) => writeMeta(facts.commonDir, { ...m, synced: rec })
    if (ahead === 0) {
      record({ at: ctx.now, branchTip, exit: 0, noop: true })
      return ok({ ok: true, merged: false, noop: true, slug, branch: m.branch, base: m.base, commit: null }, [`Nothing to merge: ${m.branch} has no commits beyond ${m.base}.`])
    }

    const baseEntry = entries.find(e => e.branch === m.base && !e.bare)
    let where: string
    if (baseEntry !== undefined) {
      where = baseEntry.path
    } else {
      temp = mkdtempSync(join(tmpdir(), `buracle-sync-${slug}-`))
      const add = await git(facts.mainRoot, ['worktree', 'add', '-q', temp, m.base])
      if (!add.ok) return fail('git_failed', `nothing merged: could not check out ${m.base} in a temporary worktree: ${gitError(add)}`)
      where = realish(temp)
    }
    const gd = await git(where, ['rev-parse', '--absolute-git-dir'], { readOnly: true })
    const busy = gd.ok ? operationInProgress(gd.out) : undefined
    if (busy !== undefined) return fail('busy', `nothing merged: ${busy} is in progress in ${where}; finish or abort it first`, { checkout: where })
    const local = await porcelain(where)
    if (local === undefined) return fail('git_failed', `cannot read the status of ${where}`)
    if (local.conflicted.length > 0) return fail('conflicts', `nothing merged: ${where} has unresolved conflicts (${local.conflicted.join(', ')})`, { checkout: where })
    const preHead = (await git(where, ['rev-parse', 'HEAD'], { readOnly: true })).out

    const plan = findPlanFor(facts, m, s)
    const kept = await planFilesKeptOut(facts, where, m, local.tracked, plan?.path)
    if ('conflict' in kept) {
      return fail('plan_conflict', `nothing merged: ${m.branch} changes the plan file ${kept.conflict}, which also has uncommitted changes in ${where}. Keep plan edits in the registered plan file only: drop the plan change from the branch (git -C ${m.path} checkout ${m.base} -- ${kept.conflict}, then commit) and sync again`, { checkout: where, plan: kept.conflict })
    }
    restorePlanIndex = await unstageKeeping(where, kept.paths)
    const toStash = local.tracked.filter(p => !kept.paths.includes(p))

    let stash: string | undefined
    if (toStash.length > 0) {
      const before = await git(where, ['rev-parse', '-q', '--verify', 'refs/stash'], { readOnly: true })
      const args = ['stash', 'push', '-q', '-m', `buracle: local changes before squash-merging ${m.branch}`]
      if (kept.paths.length > 0) args.push('--', ':/', ...kept.paths.map(p => `:(top,exclude,literal)${p}`))
      const push = await git(where, args)
      if (!push.ok) return fail('stash_failed', `nothing merged: could not stash the local changes in ${where}: ${gitError(push)}`, { checkout: where })
      const after = await git(where, ['rev-parse', '-q', '--verify', 'refs/stash'], { readOnly: true })
      if (after.ok && after.out !== '' && after.out !== before.out) stash = after.out
    }

    const dropSquashMsg = (): void => {
      if (!gd.ok) return
      try { unlinkSync(join(gd.out, 'SQUASH_MSG')) } catch {  }
    }
    const giveBack = async (): Promise<RestoreResult | undefined> => (stash === undefined ? undefined : restoreStash(where, stash, (await git(where, ['rev-parse', 'HEAD'], { readOnly: true })).out))
    const stashNote = (r: RestoreResult | undefined): string => (r === undefined || r.ok ? '' : `; your local changes stay in ${r.ref ?? 'the stash'} (${(stash ?? '').slice(0, 12)}): restore them with 'git stash pop'`)

    const merge = await git(where, ['-c', 'merge.ff=true', '-c', 'merge.autoStash=false', 'merge', '--squash', m.branch])
    if (!merge.ok) {
      const conflicted = (await porcelain(where))?.conflicted ?? []
      await git(where, ['reset', '-q', '--merge'])
      dropSquashMsg()
      const back = await giveBack()
      return fail('merge_failed', `nothing merged: ${conflicted.length > 0 ? `conflicts in ${conflicted.join(', ')}` : gitError(merge)}. If ${m.base} moved on, merge it into the worktree branch (git -C ${m.path} merge ${m.base}), resolve, commit and sync again${stashNote(back)}`, { conflicts: conflicted, checkout: where })
    }
    const staged = await git(where, ['diff', '--cached', '--quiet'], { readOnly: true })
    if (staged.code === 0) {
      dropSquashMsg()
      const back = await giveBack()
      record({ at: ctx.now, branchTip, exit: back === undefined || back.ok ? 0 : 2, noop: true, ...(back !== undefined && !back.ok && stash !== undefined ? { stash } : {}) })
      if (back !== undefined && !back.ok) return partial({ ok: true, merged: false, noop: true, slug, branch: m.branch, base: m.base, stash: { restored: false, ref: back.ref ?? null, sha: stash ?? null } }, [], [`nothing to merge (the changes of ${m.branch} are already in ${m.base})${stashNote(back)}`])
      return ok({ ok: true, merged: false, noop: true, slug, branch: m.branch, base: m.base, commit: null }, [`Nothing to merge: the changes of ${m.branch} are already in ${m.base}.`])
    }

    const planless = plan === undefined ? await planlessMessage(facts.mainRoot, m, commitSubjects.length) : {}
    const msg = commitMessage({
      prefix: m.prefix, slug, branch: m.branch, base: m.base, commits: commitSubjects,
      ...(plan?.info.title !== undefined ? { title: plan.info.title } : planless.title !== undefined ? { title: planless.title } : {}),
      ...(plan?.info.type !== undefined ? { type: plan.info.type } : {}),
      ...(plan !== undefined ? { planRel: relativeOrAbs(facts.mainRoot, plan.path) } : {}),
      ...(planless.detail !== undefined ? { detail: planless.detail } : {}),
    })
    const commit = await git(where, ['commit', '-q', '-m', msg.subject, '-m', msg.body])
    if (!commit.ok) {
      await git(where, ['reset', '-q', '--merge'])
      dropSquashMsg()
      const back = await giveBack()
      return fail('commit_failed', `nothing merged: git commit failed: ${gitError(commit)}${stashNote(back)}`, { checkout: where })
    }
    const newHead = (await git(where, ['rev-parse', 'HEAD'], { readOnly: true })).out
    const back = stash !== undefined ? await restoreStash(where, stash, newHead) : undefined
    const exit: 0 | 2 = back === undefined || back.ok ? 0 : 2
    record({ at: ctx.now, commit: newHead, branchTip, exit, ...(exit === 2 && stash !== undefined ? { stash } : {}) })
    const data: Record<string, unknown> = {
      ok: true, merged: true, slug, branch: m.branch, base: m.base, commit: newHead, subject: msg.subject, checkout: where,
      commits: commitSubjects.length, preHead,
      stash: stash === undefined ? null : { restored: exit === 0, sha: stash, ref: back?.ref ?? null, ...(back?.conflicts !== undefined ? { conflicts: back.conflicts } : {}), ...(back?.indexLost ? { indexRestored: false } : {}) },
      ...(kept.paths.length > 0 ? { planFiles: kept.paths } : {}),
    }
    const lines = [`Squash-merged ${m.branch} into ${m.base} as ${newHead.slice(0, 9)}: ${msg.subject}`]
    if (exit === 2) {
      const why = back?.conflicts !== undefined && back.conflicts.length > 0 ? `they conflict with the merged files (${back.conflicts.join(', ')})` : (back?.error ?? 'git stash pop failed')
      const plans = kept.paths.length === 0 ? '' : kept.paths.length === 1
        ? ` The plan file ${kept.paths[0]} was not stashed and keeps its state.`
        : ` The plan files ${kept.paths.join(', ')} were not stashed and keep their state.`
      return partial({ ...data, warning: 'stash_not_restored' }, lines, [`merged, but your local changes in ${where} were not restored: ${why}. They are safe in ${back?.ref ?? 'the stash'} (${(stash ?? '').slice(0, 12)}); restore them with 'git stash pop' and resolve the conflicts. Do not drop the stash.${plans}`])
    }
    if (stash !== undefined) lines.push(back?.indexLost ? 'Local changes restored (the staged/unstaged split was not kept).' : 'Local changes restored.')
    return ok(data, lines)
  } finally {
    if (restorePlanIndex !== undefined) await restorePlanIndex()
    if (temp !== undefined) {
      const rm = await git(facts.mainRoot, ['worktree', 'remove', '--force', temp])
      if (!rm.ok) {
        log('warn', 'could not remove the temporary sync worktree', { temp, error: gitError(rm) })
        try { rmSync(temp, { recursive: true, force: true }) } catch {  }
        await git(facts.mainRoot, ['worktree', 'prune'])
      }
    }
    lock.release()
  }
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
      reasons.push(`${m.path} has ${dirtyFiles.length} uncommitted change(s) (${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? ', …' : ''}): commit and sync them, or re-run with --discard to delete them${o.force ? ' (--force never deletes uncommitted work)' : ''}`)
    }
    let mode: '-d' | '-D' = '-d'
    let mergedHow = 'not needed'
    if (branchExists) {
      const tip = (await git(root, ['rev-parse', m.branch], { readOnly: true })).out
      const synced = m.synced !== undefined && m.synced.branchTip === tip
      const ancestor = (await git(root, ['merge-base', '--is-ancestor', m.branch, m.base], { readOnly: true })).ok
      if (ancestor) { mode = '-d'; mergedHow = 'merged' }
      else if (synced) { mode = '-D'; mergedHow = `squash-merged by 'worktree sync' (exit ${m.synced?.exit})` }
      else if (await containedIn(root, m.base, m.branch)) { mode = '-D'; mergedHow = `its changes are already in ${m.base}` }
      else if (o.force || o.discard) { mode = '-D'; mergedHow = o.discard ? 'discarded' : 'forced' }
      else reasons.push(`branch ${m.branch} has commits that are not in ${m.base}: run 'buracle worktree sync ${slug}' first, re-run with --force if they landed another way, or with --discard to delete them`)
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


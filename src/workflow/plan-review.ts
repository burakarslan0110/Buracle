import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { BuracleConfig } from '../core/config'
import type { SessionState } from '../core/plan/state'
import {
  REVIEW_AGENT_OF, REVIEW_FILES_MAX, REVIEW_ROLES, REVIEW_VERDICTS, companionOf, fileListText, laneReviewCleared, laneReviewStarted, planReviews, reviewCollected, reviewFreshness,
  reviewLabel, reviewOf, reviewStarted, reviewSubjectText, type ReviewRecord, type ReviewRole, type ReviewVerdict,
} from '../core/plan/reviews'
import { loadConfigSync } from '../engine/config'
import { realPath } from '../engine/fsx'
import { git, mergeBase, porcelain, repoFacts } from './gitx'
import { readPlanFile } from './plan-file'
import { reviewScope } from './review-scope'
import type { ResolvedSession } from './session-store'
import { loadState, updateState } from './session-store'
import { fail, ok, sessionJson, type CmdResult, type WorkflowCtx } from './result'

function sha(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function fileDigest(path: string): string {
  try { return sha(readFileSync(path)) } catch { return '-' }
}

export function planFingerprint(planPath: string): string | undefined {
  const r = readPlanFile(planPath)
  return r.ok ? sha(reviewSubjectText(r.text)) : undefined
}

interface ChangeSet { base: string, dir: string, files: string[] }

function real(p: string): string {
  try { return realPath(p) } catch { return p }
}

function inside(rel: string): boolean {
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

async function changedFiles(dir: string, base: string, planPath: string | undefined): Promise<string[] | undefined> {
  const diff = await git(dir, ['diff', '--name-only', '-z', base], { readOnly: true })
  if (!diff.ok) return undefined
  const st = await porcelain(dir)
  const facts = await repoFacts(dir)
  const skip = new Set<string>()
  for (const root of planPath !== undefined ? [dir, facts?.mainRoot] : []) {
    if (root === undefined || planPath === undefined) continue
    for (const rel of [relative(root, planPath), relative(real(root), real(planPath))]) {
      if (inside(rel)) skip.add(rel.split('\\').join('/'))
    }
  }
  const all = new Set([...diff.stdout.split('\0').filter(f => f !== ''), ...(st?.untracked ?? [])])
  return [...all].filter(f => !skip.has(f)).sort().slice(0, REVIEW_FILES_MAX)
}

export function digestOf(dir: string, files: readonly string[]): string {
  return sha(fileListText(files.map(f => [f, fileDigest(join(dir, f))] as const)))
}

export async function currentChangeSet(ctx: WorkflowCtx, s: ResolvedSession, planPath: string | undefined, slug?: string): Promise<ChangeSet | undefined> {
  const scope = await reviewScope(slug, ctx, s)
  if (scope.code !== 0) return undefined
  const facts = await repoFacts(ctx.cwd)
  const wt = typeof scope.data['worktree_path'] === 'string' ? scope.data['worktree_path'] : undefined
  const dir = wt ?? facts?.top
  const baseRef = typeof scope.data['base_ref'] === 'string' ? scope.data['base_ref'] : undefined
  if (dir === undefined || baseRef === undefined) return undefined
  const base = await mergeBase(dir, 'HEAD', baseRef) ?? baseRef
  const files = await changedFiles(dir, base, planPath)
  return files === undefined ? undefined : { base, dir, files }
}

function anchorRole(role: ReviewRole): 'plan' | 'changes' {
  return role === 'changes' ? 'changes' : 'plan'
}

export interface Staleness { role: ReviewRole, state: 'fresh' | 'stale' | 'missing', detail?: string }

export async function reviewStaleness(rec: ReviewRecord | undefined, role: ReviewRole, planPath: string, ctx: WorkflowCtx): Promise<Staleness> {
  if (rec === undefined || rec.state !== 'collected') return { role, state: 'missing' }
  if (anchorRole(role) === 'plan') return { role, state: reviewFreshness(rec, planFingerprint(planPath)) }
  if (rec.files === undefined || rec.dir === undefined) return { role, state: reviewFreshness(rec, undefined) }
  const sameDir = existsSync(rec.dir)
  const facts = sameDir ? undefined : await repoFacts(ctx.cwd)
  const dir = sameDir ? rec.dir : facts?.top
  if (dir === undefined) return { role, state: 'fresh' }
  const state = reviewFreshness(rec, digestOf(dir, rec.files))
  if (state === 'stale') return { role, state, detail: 'a reviewed file changed after the review was collected' }
  if (sameDir && rec.base !== undefined) {
    const now = await changedFiles(rec.dir, rec.base, planPath)
    const added = (now ?? []).filter(f => !(rec.files as string[]).includes(f))
    if (added.length > 0) return { role, state: 'stale', detail: `files changed since the review that it did not see: ${added.slice(0, 5).join(', ')}${added.length > 5 ? ` and ${added.length - 5} more` : ''}` }
  }
  return { role, state }
}

function reviewsOn(): BuracleConfig['plan']['reviews'] {
  try { return loadConfigSync().config.plan.reviews } catch { return { plan: true, changes: true, goal: true, companion: 'off' } }
}

function companionWarning(state: SessionState, role: ReviewRole): string | undefined {
  const rec = companionOf(state, role)
  const agent = REVIEW_AGENT_OF[role]
  if (rec === undefined) return `plan.reviews.companion is on and no second opinion is recorded for ${agent}: run 'buracle plan review companion start --role ${role}' (it says when no other harness can run it), or say in the report why it did not run`
  if (rec.state === 'running') return `the second opinion ${reviewLabel(rec)} is not collected yet: run 'buracle plan review companion collect --role ${role} --wait 90' and triage its findings, or 'buracle plan review companion cancel --role ${role}' and say why in the report`
  return undefined
}

function warnText(s: Staleness, plan: { type: string }): string | undefined {
  const agent = REVIEW_AGENT_OF[s.role]
  if (s.state === 'stale') {
    const what = s.role === 'changes' ? 'the code' : 'the plan'
    return `${what} changed after ${agent} was collected${s.detail !== undefined ? ` (${s.detail})` : ''}: re-run ${agent} on the current ${s.role === 'changes' ? 'diff' : 'file'} when the change adds behavior, a task, an API or a code path, then record it with 'buracle plan review done --role ${s.role} --verdict <verdict>'`
  }
  if (s.state === 'missing') return `no collected ${agent} is recorded for this ${plan.type === 'Build' ? 'run' : 'plan'}: after triaging its report, run 'buracle plan review done --role ${s.role} --verdict <verdict>' (or say in the report why it did not run)`
  return undefined
}

export async function reviewWarnings(gate: 'approve' | 'result', state: SessionState, ctx: WorkflowCtx): Promise<string[]> {
  const p = state.plan
  if (p === undefined) return []
  const on = reviewsOn()
  const roles: ReviewRole[] = []
  if (gate === 'approve') {
    if (p.type === 'Build' && on.goal) roles.push('goal')
    if ((p.type === 'Feature' || p.type === 'Bugfix') && on.plan) roles.push('plan')
  } else if (p.type === 'Bugfix' || (p.type === 'Feature' && on.changes) || (p.type === 'Build' && (state.approvals?.switches?.changesReview ?? on.changes))) {
    roles.push('changes')
  }
  const out: string[] = []
  for (const role of roles) {
    try {
      const w = warnText(await reviewStaleness(reviewOf(state, role), role, p.path, ctx), p)
      if (w !== undefined) out.push(w)
    } catch {  }
  }
  if (on.companion !== 'off') {
    for (const role of roles) {
      const w = companionWarning(state, role)
      if (w !== undefined) out.push(w)
    }
  }
  return out
}

function roleOf(x: string | undefined): ReviewRole | CmdResult {
  if (x === undefined) return fail('usage', `--role is required: one of ${REVIEW_ROLES.join(', ')}`)
  const r = x.toLowerCase() as ReviewRole
  return REVIEW_ROLES.includes(r) ? r : fail('usage', `--role must be one of ${REVIEW_ROLES.join(', ')} (got '${x}')`)
}

function isResultLike(x: unknown): x is CmdResult {
  return x !== null && typeof x === 'object' && 'code' in x && 'lines' in x
}

export function recordView(r: ReviewRecord): Record<string, unknown> {
  const v: Record<string, unknown> = { role: r.role, agent: REVIEW_AGENT_OF[r.role], state: r.state, startedAt: r.startedAt }
  if (r.companion === true) v['companion'] = true
  for (const k of ['handle', 'provider', 'collectedAt', 'verdict', 'note'] as const) if (r[k] !== undefined) v[k] = r[k]
  if (r.files !== undefined) v['files'] = r.files.length
  return v
}

export function reviewsView(state: SessionState): Array<Record<string, unknown>> {
  return planReviews(state).map(recordView)
}

export interface LaneOwner { lane: string, lead: ResolvedSession }

function mirror(owner: LaneOwner | undefined, edit: (st: SessionState, lane: string) => SessionState): void {
  if (owner === undefined) return
  try { updateState(owner.lead.harness, owner.lead.sessionId, st => edit(st, owner.lane)) } catch {  }
}

export function clearLaneReviews(owner: LaneOwner | undefined): void {
  mirror(owner, (st, lane) => laneReviewCleared(st, lane))
}

export async function planReview(action: string | undefined, o: { role?: string, handle?: string, provider?: string, verdict?: string, slug?: string }, ctx: WorkflowCtx, s: ResolvedSession, owner?: LaneOwner): Promise<CmdResult> {
  if (action !== 'start' && action !== 'done' && action !== 'status') return fail('usage', `buracle plan review <start|done|status>${action !== undefined ? `: unknown action '${action}'` : ''}`)
  const state = loadState(s.harness, s.sessionId)
  const p = state.plan
  if (p === undefined) return fail('no_plan', `no plan is registered in this ${s.harness} session (${s.sessionId}); run 'buracle plan register <path>' first`, { session: sessionJson(s) })
  if (action === 'status') {
    const rows: Array<Record<string, unknown>> = []
    const lines: string[] = []
    for (const r of planReviews(state)) {
      const fresh = r.state === 'collected' ? (await reviewStaleness(r, r.role, p.path, ctx)).state : 'running'
      rows.push({ ...recordView(r), freshness: fresh })
      lines.push(`${reviewLabel(r)}: ${r.state === 'running' ? 'running, not collected' : `collected (${r.verdict ?? 'no verdict'}), ${fresh}`}`)
    }
    if (rows.length === 0) lines.push('No review is recorded for this plan.')
    return ok({ ok: true, plan: p.path, reviews: rows }, lines)
  }
  const role = roleOf(o.role)
  if (isResultLike(role)) return role
  if (action === 'start') {
    const how = { ...(o.handle !== undefined ? { handle: o.handle } : {}), ...(o.provider !== undefined ? { provider: o.provider } : {}) }
    const next = updateState(s.harness, s.sessionId, st => (st.plan?.path === p.path ? reviewStarted(st, { role, ...how }, ctx.now) : st))
    mirror(owner, (st, lane) => laneReviewStarted(st, { lane, role, ...how }, ctx.now))
    const rec = reviewOf(next, role)
    return ok({ ok: true, review: rec !== undefined ? recordView(rec) : null }, [
      `Recorded: ${rec !== undefined ? reviewLabel(rec) : REVIEW_AGENT_OF[role]} is running.`,
      `After a compaction, collect its report instead of launching it again; after triage run 'buracle plan review done --role ${role} --verdict <verdict>'.`,
    ])
  }
  const verdict = (o.verdict ?? '').toLowerCase() as ReviewVerdict
  if (!REVIEW_VERDICTS.includes(verdict)) return fail('usage', `--verdict must be one of ${REVIEW_VERDICTS.join(', ')}${o.verdict !== undefined ? ` (got '${o.verdict}')` : ''}`)
  let anchor: { fingerprint: string, base?: string, dir?: string, files?: string[] } | undefined
  if (anchorRole(role) === 'plan') {
    const fp = planFingerprint(p.path)
    if (fp !== undefined) anchor = { fingerprint: fp }
  } else {
    const cs = await currentChangeSet(ctx, s, p.path, o.slug)
    if (cs !== undefined) anchor = { fingerprint: digestOf(cs.dir, cs.files), base: cs.base, dir: cs.dir, files: cs.files }
  }
  if (anchor === undefined) return fail('no_anchor', role === 'changes' ? 'could not read the diff to anchor the review (buracle review-scope fails here); fix that first' : `could not read the plan file ${p.path}`)
  const a = anchor
  const next = updateState(s.harness, s.sessionId, st => (st.plan?.path === p.path ? reviewCollected(st, { role, verdict, ...a }, ctx.now) : st))
  mirror(owner, (st, lane) => laneReviewCleared(st, lane, role))
  const rec = reviewOf(next, role)
  return ok({ ok: true, review: rec !== undefined ? recordView(rec) : null }, [
    `Recorded: ${REVIEW_AGENT_OF[role]} collected (${verdict})${a.files !== undefined ? ` over ${a.files.length} changed file(s)` : ''}.`,
    role === 'changes'
      ? "A later change to the reviewed files makes 'buracle plan approve-result' and 'buracle plan verify' warn that this review is stale."
      : "A later change to the plan text makes 'buracle plan set approved true' warn that this review is stale.",
  ])
}

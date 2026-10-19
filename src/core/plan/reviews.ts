import type { SessionState } from './state'
import { parseFrontmatter } from '../frontmatter'

export type ReviewRole = 'plan' | 'changes' | 'goal'
export type ReviewVerdict = 'pass' | 'needs_changes' | 'incomplete'

export interface ReviewRecord {
  role: ReviewRole
  plan: string
  state: 'running' | 'collected'
  startedAt: number
  handle?: string
  provider?: string
  collectedAt?: number
  verdict?: ReviewVerdict
  fingerprint?: string
  base?: string
  dir?: string
  files?: string[]
  companion?: true
  note?: string
}

export const REVIEW_ROLES: readonly ReviewRole[] = ['plan', 'changes', 'goal']
export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['pass', 'needs_changes', 'incomplete']
export const REVIEW_AGENT_OF: Readonly<Record<ReviewRole, string>> = { plan: 'plan-build-review', changes: 'changes-review', goal: 'goal-build-review' }
export const REVIEW_FILES_MAX = 2000
const REVIEWS_MAX = 12
const LABEL_MAX = 120

function clean(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined
  const t = x.replace(/\s+/g, ' ').trim()
  return t === '' ? undefined : t.slice(0, LABEL_MAX)
}

function isRecord(x: unknown): x is ReviewRecord {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  return REVIEW_ROLES.includes(r['role'] as ReviewRole) && typeof r['plan'] === 'string' && (r['state'] === 'running' || r['state'] === 'collected') && typeof r['startedAt'] === 'number'
}

export function reviewRecords(state: SessionState): ReviewRecord[] {
  const list = (state as { reviews?: unknown })?.reviews
  return Array.isArray(list) ? list.filter(isRecord) : []
}

export function planReviews(state: SessionState): ReviewRecord[] {
  const p = state?.plan
  return p === undefined ? [] : reviewRecords(state).filter(r => r.plan === p.path)
}

export function reviewOf(state: SessionState, role: ReviewRole): ReviewRecord | undefined {
  return planReviews(state).find(r => r.role === role && r.companion !== true)
}

export function companionOf(state: SessionState, role: ReviewRole): ReviewRecord | undefined {
  return planReviews(state).find(r => r.role === role && r.companion === true)
}

function sameSlot(a: ReviewRecord, b: ReviewRecord): boolean {
  return a.plan === b.plan && a.role === b.role && (a.companion === true) === (b.companion === true)
}

function withRecord(state: SessionState, rec: ReviewRecord): SessionState {
  const kept = reviewRecords(state).filter(r => !sameSlot(r, rec))
  return { ...state, reviews: [...kept, rec].slice(-REVIEWS_MAX) }
}

export function reviewStarted(state: SessionState, o: { role: ReviewRole, handle?: string, provider?: string, companion?: boolean }, now: number): SessionState {
  const p = state?.plan
  if (p === undefined || !REVIEW_ROLES.includes(o.role)) return state
  const rec: ReviewRecord = { role: o.role, plan: p.path, state: 'running', startedAt: now }
  const handle = clean(o.handle)
  const provider = clean(o.provider)
  if (handle !== undefined) rec.handle = handle
  if (provider !== undefined) rec.provider = provider
  if (o.companion === true) rec.companion = true
  return withRecord(state, rec)
}

export interface ReviewAnchor { fingerprint: string, base?: string, dir?: string, files?: readonly string[] }

export function reviewCollected(state: SessionState, o: { role: ReviewRole, verdict: ReviewVerdict, companion?: boolean, note?: string } & ReviewAnchor, now: number): SessionState {
  const p = state?.plan
  if (p === undefined || !REVIEW_ROLES.includes(o.role) || !REVIEW_VERDICTS.includes(o.verdict)) return state
  const prev = o.companion === true ? companionOf(state, o.role) : reviewOf(state, o.role)
  const rec: ReviewRecord = { role: o.role, plan: p.path, state: 'collected', startedAt: prev?.startedAt ?? now, collectedAt: now, verdict: o.verdict, fingerprint: o.fingerprint }
  if (prev?.handle !== undefined) rec.handle = prev.handle
  if (prev?.provider !== undefined) rec.provider = prev.provider
  if (o.base !== undefined) rec.base = o.base
  if (o.dir !== undefined) rec.dir = o.dir
  if (o.files !== undefined) rec.files = [...o.files].slice(0, REVIEW_FILES_MAX)
  if (o.companion === true) rec.companion = true
  const note = clean(o.note)
  if (note !== undefined) rec.note = note
  return withRecord(state, rec)
}

export function reviewsInFlight(state: SessionState): ReviewRecord[] {
  return planReviews(state).filter(r => r.state === 'running')
}

function handleText(r: { handle?: string, provider?: string }): string {
  const how = [r.handle !== undefined ? `handle ${r.handle}` : undefined, r.provider].filter((x): x is string => x !== undefined)
  return how.length > 0 ? ` (${how.join(', ')})` : ''
}

export function reviewLabel(r: ReviewRecord): string {
  if (r.companion === true) return `${REVIEW_AGENT_OF[r.role]} second opinion${r.provider !== undefined ? ` on ${r.provider}` : ''}${r.handle !== undefined ? ` (job ${r.handle})` : ''}`
  return `${REVIEW_AGENT_OF[r.role]}${handleText(r)}`
}

export interface LaneReview { lane: string, role: ReviewRole, startedAt: number, handle?: string, provider?: string }

function isLaneReview(x: unknown): x is LaneReview {
  if (x === null || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  return typeof r['lane'] === 'string' && r['lane'] !== '' && REVIEW_ROLES.includes(r['role'] as ReviewRole) && typeof r['startedAt'] === 'number'
}

export function laneReviewsInFlight(state: SessionState): LaneReview[] {
  const list = (state as { laneReviews?: unknown })?.laneReviews
  return Array.isArray(list) ? list.filter(isLaneReview) : []
}

function withLaneReviews(state: SessionState, list: LaneReview[]): SessionState {
  const out: SessionState = { ...state }
  if (list.length > 0) out.laneReviews = list.slice(-REVIEWS_MAX)
  else delete out.laneReviews
  return out
}

export function laneReviewStarted(state: SessionState, o: { lane: string, role: ReviewRole, handle?: string, provider?: string }, now: number): SessionState {
  const lane = clean(o.lane)
  if (state === null || typeof state !== 'object' || lane === undefined || !REVIEW_ROLES.includes(o.role)) return state
  const rec: LaneReview = { lane, role: o.role, startedAt: now }
  const handle = clean(o.handle)
  const provider = clean(o.provider)
  if (handle !== undefined) rec.handle = handle
  if (provider !== undefined) rec.provider = provider
  return withLaneReviews(state, [...laneReviewsInFlight(state).filter(r => !(r.lane === lane && r.role === o.role)), rec])
}

export function laneReviewCleared(state: SessionState, lane: string, role?: ReviewRole): SessionState {
  if (state === null || typeof state !== 'object') return state
  const before = laneReviewsInFlight(state)
  const after = before.filter(r => !(r.lane === lane && (role === undefined || r.role === role)))
  return after.length === before.length ? state : withLaneReviews(state, after)
}

export function laneReviewLabel(r: LaneReview): string {
  return `${REVIEW_AGENT_OF[r.role]} for lane ${r.lane}${handleText(r)}`
}

export function reviewSubjectText(planText: string): string {
  const body = parseFrontmatter(typeof planText === 'string' ? planText : '').body
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/^(\s*[-*]\s*)\[[xX ]\](\s+Task\s+\d+\s+done\b)/, '$1[ ]$2').replace(/\s+$/, ''))
    .join('\n')
    .trim()
}

export function fileListText(files: ReadonlyArray<readonly [path: string, digest: string]>): string {
  return [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([p, d]) => `${p}\u0000${d}`).join('\n')
}

export type ReviewFreshness = 'fresh' | 'stale' | 'missing'

export function reviewFreshness(rec: ReviewRecord | undefined, current: string | undefined): ReviewFreshness {
  if (rec === undefined || rec.state !== 'collected' || rec.fingerprint === undefined) return 'missing'
  return current === undefined || current === rec.fingerprint ? 'fresh' : 'stale'
}

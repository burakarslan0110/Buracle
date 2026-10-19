import type { SessionState } from '../core/plan/state'
import { isPlanFinished } from '../core/plan/state'
import { isValidSessionId } from '../engine/paths'
import { repoFacts } from './gitx'
import { isValidSlug } from './plan-file'
import type { ResolvedSession } from './session-store'
import { laneLead, laneSessionId, laneSessions, loadState } from './session-store'
import { readMeta } from './worktree'
import { fail, ok, type CmdResult, type WorkflowCtx } from './result'

export interface LaneTarget { session: ResolvedSession, lane: string, lead: ResolvedSession }

export async function resolveLane(lane: string, ctx: WorkflowCtx, s: ResolvedSession | undefined, o: { gone?: boolean } = {}): Promise<LaneTarget | CmdResult> {
  if (!isValidSlug(lane)) return fail('usage', `--lane must be the slug of a lane worktree: kebab-case ASCII (a-z, 0-9, '-'), at most 64 characters (got '${lane}')`)
  const facts = await repoFacts(ctx.cwd)
  if (facts === undefined) return fail('no_lane', `--lane ${lane} needs a git repository with the lane worktree '${lane}'; ${ctx.cwd} is not inside one`)
  const meta = readMeta(facts.commonDir, lane)
  const left = o.gone === true && meta === undefined && s !== undefined && laneSessions(s.harness, s.sessionId).some(l => l.lane === lane)
  if (!left && (meta === undefined || meta.lane !== true)) {
    return fail('no_lane', `there is no lane worktree '${lane}' in this repository: the lead creates it first with 'buracle worktree create ${lane} --lane', and the lane works inside it`)
  }
  const base = laneLead(meta?.owner, s)
  if (base === undefined) return fail('no_session', `the lane worktree '${lane}' records no lead session and none was found here; pass --session <lead session id> with --harness <h>`)
  const id = laneSessionId(base.sessionId, lane)
  if (!isValidSessionId(id)) return fail('usage', `the lane session id ${id} is too long; use a shorter lane slug`)
  return { session: { harness: base.harness, sessionId: id, source: `--lane ${lane}` }, lane, lead: base }
}

export interface LaneView { lane: string, session: string, plan: string, type: string, status: string, phase: string, interaction: string }

function interactionText(st: SessionState): string {
  const i = st.interaction
  return i?.state === 'paused' ? `paused (${i.kind ?? 'discussion'})${i.reason !== undefined ? `: ${i.reason}` : ''}` : 'running'
}

export function laneViews(s: ResolvedSession): LaneView[] {
  const out: LaneView[] = []
  for (const l of laneSessions(s.harness, s.sessionId)) {
    const st = loadState(s.harness, l.sessionId)
    const p = st.plan
    if (p === undefined) continue
    out.push({ lane: l.lane, session: l.sessionId, plan: p.path, type: p.type, status: p.status, phase: isPlanFinished(st) ? 'done' : p.phase, interaction: interactionText(st) })
  }
  return out
}

export function withLanes(r: CmdResult, s: ResolvedSession): CmdResult {
  if (r.code !== 0) return r
  const lanes = laneViews(s)
  if (lanes.length === 0) return r
  const lines = lanes.map(l => `Lane ${l.lane}: ${l.plan} (${l.type}, ${l.status}, phase ${l.phase}; ${l.interaction})`)
  return ok({ ...r.data, lanes }, [...r.lines, ...lines], r.errors.map(e => e.replace(/^warning: /, '')))
}

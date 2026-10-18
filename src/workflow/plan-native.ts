import { isAbsolute, relative, resolve } from 'node:path'
import type { BuracleConfig } from '../core/config'
import { validatePlan } from '../core/plan/format'
import { NATIVE_PLAN_ENTER, nativeBinding, nativeConflictNote, nativeFilledNote, nativePlanText, withNativeBinding, withoutNativeBinding, type NativeBinding } from '../core/plan/native'
import { reviewFreshness, reviewOf, reviewSubjectText } from '../core/plan/reviews'
import { isPlanFinished, resumePlan, type SessionState } from '../core/plan/state'
import { atomicWriteSync, sha256 } from '../engine/fsx'
import { isValidSessionId } from '../engine/paths'
import { capturePlanFile, type PlanCaptureInput } from './plan-capture'
import { readPlanFile, updateFrontmatterText } from './plan-file'
import { fail, ok, partial, sessionJson, type CmdResult, type WorkflowCtx } from './result'
import type { ResolvedSession } from './session-store'
import { loadState, updateState } from './session-store'

export interface SessionPlanCapture { path: string, note?: string, native?: 'filled' | 'conflict' }

function shown(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

function refusedNative(path: string | undefined, reasons: string[], ctx: WorkflowCtx): CmdResult {
  return partial({ ok: false, refused: true, action: 'prepare-native', ...(path !== undefined ? { path } : {}), reasons }, [], [`refused: plan prepare-native${path !== undefined ? ` ${shown(path, ctx.cwd)}` : ''}`, ...reasons.map(r => `  - ${r}`)])
}

export function planPrepareNative(pathArg: string | undefined, o: { cancel?: boolean }, plan: BuracleConfig['plan'], ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  if (o.cancel === true) {
    const before = loadState(s.harness, s.sessionId).native
    if (before !== undefined) updateState(s.harness, s.sessionId, st => withoutNativeBinding(st))
    return ok({ ok: true, cancelled: before !== undefined, session: sessionJson(s) }, [before !== undefined ? `Dropped the plan-mode binding of ${shown(before.path, ctx.cwd)}; plan-build continues with its own approval gate.` : 'No plan-mode binding is recorded; nothing to drop.'])
  }
  if (pathArg === undefined) return fail('usage', 'missing <path>: buracle plan prepare-native <path> | --cancel')
  const path = resolve(ctx.cwd, pathArg)
  const reasons: string[] = []
  if (plan.nativePlanMode !== 'on') reasons.push("plan.nativePlanMode is off: plan here with plan-build's own approval gate ('buracle config set plan.nativePlanMode on' turns it on)")
  if (plan.planApproval === false) reasons.push('plan.planApproval is off: leaving a plan mode waits for the user, so a self-approved plan is written outside plan mode')
  const state = loadState(s.harness, s.sessionId)
  const b = state.plan
  if (b === undefined) return fail('no_plan', `no plan is registered in this ${s.harness} session (${s.sessionId}); run 'buracle plan register <path> --phase plan' first`, { session: sessionJson(s) })
  if (b.path !== path) return refusedNative(path, [...reasons, `the session's plan is ${shown(b.path, ctx.cwd)}, not ${shown(path, ctx.cwd)}: prepare the registered plan`], ctx)
  if (b.type !== 'Feature') reasons.push(`a ${b.type} plan keeps its own approval gate: only a Feature plan is planned in plan mode (a bugfix writes its reproducing test while it plans)`)
  if (b.phase !== 'plan' || isPlanFinished(state)) reasons.push(`the plan is in phase ${b.phase} (status ${b.status}); only a plan in its plan phase is prepared`)
  const r = readPlanFile(path)
  if (!r.ok) return fail(r.code === 'missing' ? 'plan_missing' : 'plan_unreadable', `${r.error}; re-register the plan or run 'buracle plan unregister'`, { path })
  if (!r.info.hasFrontmatter) reasons.push('the plan file has no frontmatter; create it with buracle plan init')
  if (r.info.approved === true || state.approvals?.planApprovedAt !== undefined) reasons.push('the plan is already approved')
  if (r.info.status !== 'PENDING') reasons.push(`the plan file is ${r.info.status ?? 'without a status'}, not PENDING`)
  if (reasons.length > 0) return refusedNative(path, reasons, ctx)
  const binding: NativeBinding = { path, sha: sha256(r.text), at: ctx.now }
  updateState(s.harness, s.sessionId, st => (st.plan?.path === path ? withNativeBinding(st, binding) : st))
  const enter = NATIVE_PLAN_ENTER[s.harness]
  return ok({ ok: true, path, harness: s.harness, enter, session: sessionJson(s) }, [
    `Prepared ${shown(path, ctx.cwd)} for plan mode (single use): the plan the user approves when leaving plan mode is written into this file; if the file changes before then, Buracle leaves it as it is and saves the plan beside it.`,
    `Next: ${enter}.`,
  ])
}

function staleReview(state: SessionState, text: string): boolean {
  const rec = reviewOf(state, 'plan')
  return rec !== undefined && rec.state === 'collected' && reviewFreshness(rec, sha256(reviewSubjectText(text))) === 'stale'
}

async function conflict(i: PlanCaptureInput, b: NativeBinding): Promise<SessionPlanCapture | undefined> {
  const saved = await capturePlanFile(i)
  const note = nativeConflictNote(shown(b.path, i.cwd), saved !== undefined ? shown(saved.path, i.cwd) : undefined, i.harness)
  return saved !== undefined ? { path: saved.path, note, native: 'conflict' } : { path: b.path, note, native: 'conflict' }
}

function writeMerged(b: NativeBinding, plan: string, approved: boolean): string | undefined {
  try {
    const r = readPlanFile(b.path)
    const merged = r.ok && sha256(r.text) === b.sha && r.info.approved !== true ? nativePlanText(r.text, plan) : undefined
    if (merged === undefined) return undefined
    const text = approved ? updateFrontmatterText(merged, { approved: true }) : merged
    atomicWriteSync(b.path, text)
    return text
  } catch {
    return undefined
  }
}

async function fillNative(i: PlanCaptureInput, sid: string, state: SessionState, b: NativeBinding): Promise<SessionPlanCapture | undefined> {
  updateState(i.harness, sid, st => withoutNativeBinding(st))
  const approved = i.approved !== false
  const text = writeMerged(b, i.plan, approved)
  if (text === undefined) return conflict(i, b)
  if (approved) {
    updateState(i.harness, sid, st => {
      if (st.plan?.path !== b.path) return st
      const next: SessionState = { ...st, approvals: { ...(st.approvals ?? {}), planApprovedAt: st.approvals?.planApprovedAt ?? i.now } }
      return next.interaction?.state === 'paused' && next.interaction.kind === 'decision' ? resumePlan(next, i.now) : next
    })
  }
  const errors = validatePlan(text).filter(f => f.level === 'error').length
  const note = nativeFilledNote({ path: shown(b.path, i.cwd), harness: i.harness, approved, errors, staleReview: staleReview(state, text) })
  return { path: b.path, note, native: 'filled' }
}

export async function captureSessionPlan(i: PlanCaptureInput & { sid?: string }): Promise<SessionPlanCapture | undefined> {
  const { sid, ...input } = i
  if (sid !== undefined && isValidSessionId(sid) && input.plan.trim() !== '') {
    const state = loadState(input.harness, sid)
    const b = nativeBinding(state)
    if (b !== undefined) return fillNative(input, sid, state, b)
    const stale = state.native
    if (stale !== undefined) {
      updateState(input.harness, sid, st => withoutNativeBinding(st))
      if (stale.path === state.plan?.path) return conflict(input, stale)
    }
  }
  const saved = await capturePlanFile(input)
  return saved !== undefined ? { path: saved.path } : undefined
}

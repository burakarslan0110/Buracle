import type { SessionState } from './state'
import { AUTO_PAUSE_REASON, applyIntent, approveResult, isPlanFinished, resultReviewable } from './state'
import { CONTROL_GUIDANCE, controlGuidance, isResultApproval, isResultReview, pausedReply } from '../policy/intents'

export type PromptControl = 'pause' | 'resume' | 'stop' | null

export interface PromptInteraction { next: SessionState, guidance?: string, autoPaused?: boolean, resultApproved?: boolean }

function running(s: SessionState): boolean {
  return s.plan !== undefined && !isPlanFinished(s) && s.interaction?.state !== 'paused'
}

export function promptInteraction(state: SessionState, control: PromptControl, text: string, opts: { autoPause: boolean, now: number }): PromptInteraction {
  const hasPlan = state.plan !== undefined
  const before = state.interaction
  if (!hasPlan) {
    const guidance = control !== null ? controlGuidance(control, { hasPlan: false }) : undefined
    return guidance !== undefined ? { next: state, guidance } : { next: state }
  }
  if (control !== 'pause' && control !== 'stop' && resultReviewable(state) && isResultReview(before) && isResultApproval(text)) {
    return { next: approveResult(state, opts.now), guidance: CONTROL_GUIDANCE.resultApproved, resultApproved: true }
  }
  if (control !== null) {
    const next = applyIntent(state, control, opts.now)
    const guidance = controlGuidance(control, before !== undefined ? { hasPlan, interaction: before } : { hasPlan })
    return guidance !== undefined ? { next, guidance } : { next }
  }
  if (before?.state === 'paused' && !isPlanFinished(state)) {
    const guidance = pausedReply(before, text)
    return guidance !== undefined ? { next: state, guidance } : { next: state }
  }
  if (!opts.autoPause || !running(state)) return { next: state }
  const paused = applyIntent(state, 'pause', opts.now)
  if (paused === state || paused.interaction?.state !== 'paused') return { next: state }
  return { next: { ...paused, interaction: { ...paused.interaction, reason: AUTO_PAUSE_REASON } }, guidance: CONTROL_GUIDANCE.autoPause, autoPaused: true }
}

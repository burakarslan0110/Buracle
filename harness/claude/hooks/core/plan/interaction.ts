import type { SessionState } from './state'
import { applyIntent, approveResult, isPlanFinished, resultReviewable } from './state'
import { CONTROL_GUIDANCE, controlGuidance, isResultApproval, isResultReview, pausedReply } from '../policy/intents'

export type PromptControl = 'pause' | 'resume' | 'stop' | null

export interface PromptInteraction { next: SessionState, guidance?: string, resultApproved?: boolean }

export function promptInteraction(state: SessionState, control: PromptControl, text: string, opts: { now: number }): PromptInteraction {
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
  return { next: state }
}

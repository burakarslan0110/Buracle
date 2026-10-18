import { looksLikePlan } from '../../../core/plan/capture'

export const OPENCODE_PLAN_AGENT = 'plan'

export interface PlanDraftState { agent?: string, planText?: string }

export function notePlanText(s: PlanDraftState, text: string): void {
  if (s.agent === OPENCODE_PLAN_AGENT && text.trim() !== '') s.planText = text
}

export function draftOnSwitch(s: PlanDraftState, agent: string | undefined): string | undefined {
  if (typeof agent !== 'string' || agent === '') return undefined
  const previous = s.agent
  s.agent = agent
  if (previous !== OPENCODE_PLAN_AGENT || agent === OPENCODE_PLAN_AGENT) return undefined
  const text = s.planText
  s.planText = undefined
  return text !== undefined && looksLikePlan(text) ? text : undefined
}

export function draftNote(shown: string): string {
  return `Buracle: the plan from OpenCode's plan agent was saved as a draft to ${shown} (H12; OpenCode has no approval step, so it is not marked approved).`
}

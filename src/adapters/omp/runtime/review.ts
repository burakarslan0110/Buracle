import { validateReviewJson } from '../../../core/policy/review'

export const REVIEW_AGENT = /^(?:buracle:)?(plan-build-review|changes-review|goal-build-review)$/

export function reviewAgentOf(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined
  return REVIEW_AGENT.exec(name.trim())?.[1]
}

export function yieldReport(input: Record<string, unknown>): string | undefined {
  if (input['error'] !== undefined && input['data'] === undefined) return undefined
  const data = input['data']
  if (data === undefined || data === null) return undefined
  if (typeof data === 'string') return data
  try { return JSON.stringify(data) } catch { return undefined }
}

export function reviewProblems(agent: string, report: string, subject: readonly string[] = []): string[] {
  const r = validateReviewJson(report, { agent, subject })
  return r.ok ? [] : (r.errors.length > 0 ? r.errors : ['the report is not one valid review JSON object'])
}

export function reviewYieldReason(agent: string, problems: readonly string[]): string {
  return `your report as ${agent} is not valid review JSON (${problems.slice(0, 6).join('; ')}). ` +
    'Call yield again with exactly one JSON object that follows the output schema in your instructions, with no text or code fence around it.'
}

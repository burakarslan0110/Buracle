import { validateReviewJson } from '../../../core/policy/review'

export const REVIEW_AGENTS: readonly string[] = ['plan-build-review', 'changes-review', 'goal-build-review']

export interface SubagentReport { agent: string; sessionID?: string; text: string }

function obj(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined
}

export function subagentReport(input: unknown, result: { output?: unknown; content?: unknown }): SubagentReport | undefined {
  const agent = obj(input)?.['agent']
  if (typeof agent !== 'string' || !REVIEW_AGENTS.includes(agent)) return undefined
  const out = obj(result.output)
  if (out !== undefined && out['status'] !== undefined && out['status'] !== 'completed') return undefined
  let text = typeof out?.['output'] === 'string' ? out['output'] : undefined
  let sessionID = typeof out?.['sessionID'] === 'string' ? out['sessionID'] : undefined
  if (text === undefined) {
    const content = typeof result.content === 'string' ? result.content
      : Array.isArray(result.content) ? result.content.map(c => (typeof obj(c)?.['text'] === 'string' ? obj(c)?.['text'] as string : '')).join('\n') : ''
    const m = /<subagent sessionID="([^"]+)" state="completed">\n([\s\S]*)\n<\/subagent>\s*$/.exec(content)
    if (m === null) return undefined
    sessionID ??= m[1]
    text = m[2] ?? ''
  }
  const report: SubagentReport = { agent, text }
  if (sessionID !== undefined) report.sessionID = sessionID
  return report
}

export function reviewProblems(report: SubagentReport, subject: readonly string[] = []): string[] {
  const checked = validateReviewJson(report.text, { agent: report.agent, subject })
  if (checked.ok) return []
  return checked.errors.length > 0 ? checked.errors.slice(0, 6) : ['the message is not one valid review JSON object']
}

export function reviewNote(report: SubagentReport, problems: readonly string[], first: boolean): string {
  const what = `Buracle H19 (review.gate): the ${report.agent} report is not valid review JSON (${problems.join('; ')}).`
  if (!first) return `${what} It failed twice; check its findings yourself before relying on them.`
  const how = report.sessionID !== undefined ? `with the subagent tool (agent ${report.agent}, sessionID ${report.sessionID})` : `with the subagent tool (agent ${report.agent})`
  return `${what} Continue the reviewer once ${how} and ask it to answer again with exactly one JSON object that follows the output schema in its instructions, with no text or code fence around it.`
}

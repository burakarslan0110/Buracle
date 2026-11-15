import { validateReviewJson } from '../../../core/policy/review'

export const REVIEW_AGENTS: readonly string[] = ['plan-build-review', 'changes-review', 'goal-build-review']

export interface SubagentReport { agent: string; sessionID?: string; text: string }

function obj(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined
}

// OpenCode 2.3.0 added the description attribute; it is the task's own text, written without escaping.
const SUBAGENT_MESSAGE = /<subagent sessionID="([^"]+)" state="completed"(?: description="[^\n]*")?>\n([\s\S]*)\n<\/subagent>\s*$/

function textOf(content: unknown): string {
  return typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(c => (typeof obj(c)?.['text'] === 'string' ? obj(c)?.['text'] as string : '')).join('\n') : ''
}

/**
 * OpenCode 2.3.0 and later run every subagent in the background: the tool result only says it started, and the
 * report reaches the parent as a `<subagent>` user message whose metadata names the agent. This adds the H19 note
 * to each invalid review report among `messages`, the same note on every call, and returns the agents it noted.
 */
export function noteReviewMessages(messages: unknown, subject: readonly string[] = []): string[] {
  const noted: string[] = []
  const seen = new Set<string>()
  for (const m of Array.isArray(messages) ? messages : []) {
    const msg = obj(m)
    const meta = obj(msg?.['metadata'])
    if (msg === undefined || msg['role'] !== 'user' || meta?.['source'] !== 'subagent' || meta['state'] !== 'completed') continue
    const agent = meta['agent']
    const content = msg['content']
    if (typeof agent !== 'string' || !REVIEW_AGENTS.includes(agent) || !Array.isArray(content)) continue
    const found = SUBAGENT_MESSAGE.exec(textOf(content))
    if (found === null) continue
    const sessionID = typeof meta['childID'] === 'string' ? meta['childID'] : found[1] as string
    const report: SubagentReport = { agent, sessionID, text: found[2] ?? '' }
    const problems = reviewProblems(report, subject)
    if (problems.length === 0) continue
    const first = !seen.has(sessionID)
    seen.add(sessionID)
    msg['content'] = [...content, { type: 'text', text: reviewNote(report, problems, first) }]
    noted.push(agent)
  }
  return noted
}

export function subagentReport(input: unknown, result: { output?: unknown; content?: unknown }): SubagentReport | undefined {
  const agent = obj(input)?.['agent']
  if (typeof agent !== 'string' || !REVIEW_AGENTS.includes(agent)) return undefined
  const out = obj(result.output)
  if (out !== undefined && out['status'] !== undefined && out['status'] !== 'completed') return undefined
  let text = typeof out?.['output'] === 'string' ? out['output'] : undefined
  let sessionID = typeof out?.['sessionID'] === 'string' ? out['sessionID'] : undefined
  if (text === undefined) {
    const m = SUBAGENT_MESSAGE.exec(textOf(result.content))
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
  const what = `Buracle H19: the ${report.agent} report is not valid review JSON (${problems.join('; ')}).`
  if (!first) return `${what} It failed twice; check its findings yourself before relying on them.`
  const how = report.sessionID !== undefined ? `with the subagent tool (agent ${report.agent}, sessionID ${report.sessionID})` : `with the subagent tool (agent ${report.agent})`
  return `${what} Continue the reviewer once ${how} and ask it to answer again with exactly one JSON object that follows the output schema in its instructions, with no text or code fence around it.`
}

import { flowDef } from '../../../core/flow/catalog'

export function workflowCommandLead(id: string): string {
  return `Run Buracle's \`${id}\` workflow for the request below; the user asked for it explicitly.`
}

export function workflowCommandBody(id: string): string {
  return [
    workflowCommandLead(id),
    `First read \`skill://${id}\` and follow that skill step by step (its references and scripts resolve under \`skill://${id}/\`). If the skill cannot be read, say so and stop instead of improvising the procedure.`,
    '',
    'Request: $ARGUMENTS',
    '',
  ].join('\n')
}

export interface WorkflowStart {
  workflow: string
  args: string
  via: 'command' | 'skill'
}

export function workflowOfInput(text: string, commands: readonly string[]): WorkflowStart | undefined {
  const m = /^\/(skill:)?([a-z][a-z0-9-]{0,39})(?=\s|$)([\s\S]*)$/.exec(typeof text === 'string' ? text.trim() : '')
  if (m === null) return undefined
  const id = m[2] as string
  const via = m[1] !== undefined ? 'skill' : 'command'
  if (flowDef(id) === undefined || (via === 'command' && !commands.includes(id))) return undefined
  return { workflow: id, args: (m[3] ?? '').trim(), via }
}

export function workflowOfExpanded(prompt: string): { workflow: string, args: string } | undefined {
  const t = typeof prompt === 'string' ? prompt.trimStart() : ''
  const m = /^Run Buracle's `([a-z][a-z0-9-]{0,39})` workflow for the request below;/.exec(t)
  const id = m?.[1]
  if (id === undefined || flowDef(id) === undefined) return undefined
  const request = /\nRequest: ([^\n]*)/.exec(t)?.[1] ?? ''
  return { workflow: id, args: request.trim() }
}

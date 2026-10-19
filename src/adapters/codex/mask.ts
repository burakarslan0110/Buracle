import { classifyTool } from '../../core/events'
import type { AdapterContext } from '../registry'
import { maskNotice, masksToolKind, maskToolOutput } from '../shared/tool-output-mask'
import { json, NOTHING, rec, str, type HookOutcome, type Payload } from './hook-io'

export function responseText(response: unknown): string {
  if (typeof response === 'string') return response
  const r = rec(response)
  const content = Array.isArray(r['content']) ? r['content'] : []
  if (content.length > 0) {
    return content.map(c => {
      const part = rec(c)
      return part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : `[${typeof part['type'] === 'string' ? part['type'] : 'non-text'} content not shown]`
    }).join('\n')
  }
  try { return JSON.stringify(response, null, 2) ?? '' } catch { return String(response) }
}

export function maskOutcome(p: Payload, ctx: AdapterContext): HookOutcome {
  try {
    if (!ctx.config.guards.redact) return NOTHING
    const tool = str(p['tool_name']) ?? ''
    const kind = classifyTool('codex', tool, rec(p['tool_input']), '').kind
    if (!masksToolKind(kind) || p['tool_response'] === undefined) return NOTHING
    const r = maskToolOutput(p['tool_response'])
    if (r.count === 0) return NOTHING
    const what = r.count === 1 ? '1 secret value' : `${r.count} secret values`
    const reason = `Buracle (guards.redact): ${what} in this tool output were masked before you read it. The call itself ran and was not blocked; this is its output with the secrets replaced:\n\n${responseText(r.value)}`
    return json({ decision: 'block', reason, systemMessage: maskNotice(r.count) })
  } catch {
    return NOTHING
  }
}

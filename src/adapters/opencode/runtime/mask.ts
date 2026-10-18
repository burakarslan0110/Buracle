import type { ToolKind } from '../../../core/events'
import { masksToolKind, maskToolOutput } from '../../shared/tool-output-mask'
import type { ToolResultShape } from './types'

const MCP_OUTPUT_TOOLS: ReadonlySet<string> = new Set(['execute', 'read_mcp_resource'])

export function masksOpencodeTool(tool: string, kind: ToolKind): boolean {
  return masksToolKind(kind) || MCP_OUTPUT_TOOLS.has(tool)
}

export function maskedResult(result: ToolResultShape): { result: ToolResultShape, count: number } | undefined {
  let count = 0
  const out: ToolResultShape = { ...result }
  if (out.output !== undefined) {
    const r = maskToolOutput(out.output)
    if (r.count > 0) { count += r.count; out.output = r.value }
  }
  const cur = out.content
  if (typeof cur === 'string') {
    const r = maskToolOutput(cur)
    if (r.count > 0 && typeof r.value === 'string') { count += r.count; out.content = r.value }
  } else if (Array.isArray(cur)) {
    out.content = cur.map(part => {
      const text = (part as { text?: unknown }).text
      if (part.type !== 'text' || typeof text !== 'string') return part
      const r = maskToolOutput(text)
      if (r.count === 0 || typeof r.value !== 'string') return part
      count += r.count
      return { ...part, text: r.value }
    })
  }
  return count > 0 ? { result: out, count } : undefined
}

export function maskedError(error: unknown, depth = 0): number {
  if (error === null || typeof error !== 'object' || depth > 3) return 0
  let count = 0
  const message = (error as { message?: unknown }).message
  const r = typeof message === 'string' ? maskToolOutput(message) : undefined
  if (r !== undefined && r.count > 0 && typeof r.value === 'string') {
    try {
      Object.assign(error, { message: r.value })
      count += r.count
    } catch {  }
  }
  return count + maskedError((error as { error?: unknown }).error, depth + 1)
}

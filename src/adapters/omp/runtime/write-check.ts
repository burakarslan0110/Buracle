import type { ToolCall } from '../../../core/events'
import type { WriteContent } from '../../../core/policy/write-guard'
import { guardedContents, ompChanges } from '../../shared/write-content'

export function ompWriteContents(toolName: string, input: Record<string, unknown>, paths: readonly string[], cwd: string, home: string, realpath?: (p: string) => string | undefined): Record<string, WriteContent> {
  try {
    return guardedContents(ompChanges(toolName, input, paths, cwd, home), paths, home, realpath !== undefined ? { realpath } : {})
  } catch {
    return {}
  }
}

function deviceArgs(input: Record<string, unknown>): Record<string, unknown> {
  const content = input['content']
  if (typeof content !== 'string') return {}
  let v: unknown
  try { v = JSON.parse(content) } catch { return {} }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
  const { i: _intent, ...args } = v as Record<string, unknown>
  return args
}

/**
 * A write to an `xd://` device is the call of the tool the device names, with the written JSON as its arguments:
 * the guards and the routing judge that call, not the write that carries it.
 */
export function deviceCall(call: ToolCall): ToolCall {
  const target = typeof call.input['path'] === 'string' ? /^xd:\/\/([^/?#\s]+)/i.exec(call.input['path'].trim())?.[1] : undefined
  return target === undefined ? call : { ...call, tool: target, input: deviceArgs(call.input) }
}

import type { WriteContent } from '../../../core/policy/write-guard'
import { parseMcpName } from '../../../core/events'
import { mcpWritePaths } from '../../../core/policy/mcp-paths'
import { guardedContents, ompChanges } from '../../shared/write-content'

export function ompWriteContents(toolName: string, input: Record<string, unknown>, paths: readonly string[], cwd: string, home: string, realpath?: (p: string) => string | undefined): Record<string, WriteContent> {
  try {
    return guardedContents(ompChanges(toolName, input, paths, cwd, home), paths, home, realpath !== undefined ? { realpath } : {})
  } catch {
    return {}
  }
}

function deviceArgs(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const content = input['content']
  if (typeof content !== 'string') return undefined
  let v: unknown
  try { v = JSON.parse(content) } catch { return undefined }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const { i: _intent, ...args } = v as Record<string, unknown>
  return args
}

export function ompMcpWritePaths(toolName: string, input: Record<string, unknown>, mcp: { server: string, tool: string } | undefined, device: boolean): string[] {
  try {
    let name = toolName
    let args: Record<string, unknown> | undefined = input
    if (device) {
      const target = typeof input['path'] === 'string' ? /^xd:\/\/([^/?#\s]+)/i.exec(input['path'].trim())?.[1] : undefined
      if (target === undefined) return []
      name = target
      args = deviceArgs(input)
    }
    if (args === undefined || !name.startsWith('mcp__')) return []
    const parts = mcp ?? parseMcpName('omp', name)
    return parts === undefined ? [] : mcpWritePaths(name, args, parts)
  } catch {
    return []
  }
}

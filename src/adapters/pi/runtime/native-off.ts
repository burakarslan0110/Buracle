import { join } from 'node:path'
import * as paths from '../../../engine/paths'
import { readCapped } from '../../shared/native-off'

function disabledIn(doc: unknown): string[] {
  const servers = doc !== null && typeof doc === 'object' ? (doc as { mcpServers?: unknown }).mcpServers : undefined
  if (servers === null || typeof servers !== 'object') return []
  return Object.entries(servers as Record<string, unknown>)
    .filter(([, v]) => v !== null && typeof v === 'object' && (v as { enabled?: unknown }).enabled === false)
    .map(([id]) => id)
}

/** The MCP servers Pi's own files turn off (`enabled: false`): the user's `mcp.json` and the project's `.pi/mcp.json`. */
export function piOffServers(project: string): string[] {
  const files = [join(paths.piAgentDir(), 'mcp.json'), join(project, '.pi', 'mcp.json')]
  return [...new Set(files.flatMap(f => disabledIn(readCapped(f))))]
}

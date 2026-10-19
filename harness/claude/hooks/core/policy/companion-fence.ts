import type { Harness } from '../events'
import { mcpServerToken } from '../events'
import { REVIEW_AGENT_TYPE, readOnlyShellProblem } from './readonly-shell'
import { CLAUDE_PLUGIN_NAME, harnessMcpToolName } from './routing'

export const REVIEWER_AGENT_ENV = 'BURACLE_REVIEWER_AGENT'
export const COMPANION_MCP_SERVERS: readonly string[] = ['codegraph', 'semble', 'context7']
export const COMPANION_OMP_TOOLS: readonly string[] = ['read', 'grep', 'glob']
export const COMPANION_MCP_TOOLS: Readonly<Record<string, readonly string[]>> = {
  codegraph: ['codegraph_explore', 'codegraph_search', 'codegraph_node', 'codegraph_callers', 'codegraph_callees', 'codegraph_impact', 'codegraph_files', 'codegraph_status'],
  semble: ['search', 'find_related'],
  context7: ['resolve-library-id', 'query-docs'],
}

const CLAUDE_EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
const CLAUDE_SHELL_TOOLS: readonly string[] = ['Bash', 'Monitor', 'PowerShell']
const CLAUDE_MCP = new RegExp(`^mcp__(?:plugin_${CLAUDE_PLUGIN_NAME}_)?(?:${COMPANION_MCP_SERVERS.join('|')})__.`)
const OMP_MCP: ReadonlySet<string> = new Set(COMPANION_MCP_SERVERS.flatMap(s => (COMPANION_MCP_TOOLS[s] ?? []).flatMap(t => [
  harnessMcpToolName('omp', s, t),
  `mcp__${mcpServerToken('omp', s)}_${mcpServerToken('omp', t)}`,
])))
const OMP_DEVICE = /^xd:\/\//i

export function companionAgent(value: string | undefined): string | undefined {
  return typeof value === 'string' && REVIEW_AGENT_TYPE.test(value) ? value : undefined
}

function notAllowedMcp(tool: string): string {
  return `\`${tool}\` is not a codegraph, semble or context7 tool`
}

function claudeProblem(tool: string, input: Record<string, unknown>): string | undefined {
  if (CLAUDE_EDIT_TOOLS.includes(tool)) return `\`${tool}\` changes files`
  if (CLAUDE_SHELL_TOOLS.includes(tool)) {
    const command = input['command']
    return typeof command === 'string' ? readOnlyShellProblem(command) : undefined
  }
  if (tool.startsWith('mcp__')) return CLAUDE_MCP.test(tool) ? undefined : notAllowedMcp(tool)
  return undefined
}

function ompProblem(tool: string, input: Record<string, unknown>): string | undefined {
  if (COMPANION_OMP_TOOLS.includes(tool) || OMP_MCP.has(tool)) return undefined
  if (tool === 'write') {
    const p = typeof input['path'] === 'string' ? input['path'].trim() : ''
    if (!OMP_DEVICE.test(p)) return '`write` changes files'
    return OMP_MCP.has(p.slice('xd://'.length)) ? undefined : notAllowedMcp(p)
  }
  return tool.startsWith('mcp__') ? notAllowedMcp(tool) : `\`${tool}\` is not one of its read tools (${COMPANION_OMP_TOOLS.join(', ')})`
}

export function companionToolProblem(harness: Harness, tool: string, input: Record<string, unknown>): string | undefined {
  if (harness === 'claude') return claudeProblem(tool, input)
  if (harness === 'omp') return ompProblem(tool, input)
  return undefined
}

export function companionToolDenial(harness: Harness, agent: string, tool: string, input: Record<string, unknown>): string | undefined {
  const problem = companionToolProblem(harness, tool, input)
  if (problem === undefined) return undefined
  return `Buracle: this run is a read-only second opinion (${agent}) and ${problem}. Read files, search, see the change with git diff, log or show, and use codegraph, semble or context7; change nothing and write no memory.`
}

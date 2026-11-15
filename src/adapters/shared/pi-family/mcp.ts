import type { McpServerSpec } from '../../../core/catalog'
import { envRef, expandMcpCommand, mcpEnvFor } from '../../../core/catalog'
import type { Harness } from '../../../core/events'

// An MCP server entry for the `mcpServers` table of Oh My Pi's `.mcp.json` and Pi's `mcp.json`: the two clients read
// the same shape. They differ in the unit of `timeout` (Oh My Pi: milliseconds, Pi: seconds).

export const MCP_BURACLE_SHIM = '{buracle}'
export const MCP_SHIM_SCRIPT = 'exec "${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" "$@"'

export function mcpShimArgv(args: readonly string[]): { command: string, args: string[] } {
  return { command: '/bin/sh', args: ['-c', MCP_SHIM_SCRIPT, 'buracle', ...args] }
}

/**
 * `viaShim` entries (Buracle's own MCP launcher) also get `launcherEnv`: Pi and Oh My Pi both call themselves `pi` in
 * the MCP handshake, so the harness a server runs for is told by this marker instead (`BURACLE_HARNESS`).
 */
export function familyMcpEntry(id: string, spec: McpServerSpec, harness: Harness, timeoutPerSecond: number, launcherEnv: Readonly<Record<string, string>> = {}): Record<string, unknown> {
  const timeout = spec.tool_timeout_sec !== undefined ? { timeout: spec.tool_timeout_sec * timeoutPerSecond } : {}
  if (spec.transport === 'http') return { type: 'http', url: spec.url ?? '', ...timeout }
  const expanded = expandMcpCommand(spec, { buracle: MCP_BURACLE_SHIM, id })
  const viaShim = expanded.command === MCP_BURACLE_SHIM
  const { command, args } = viaShim ? mcpShimArgv(expanded.args) : expanded
  const entry: Record<string, unknown> = { type: 'stdio', command }
  if (args.length > 0) entry['args'] = args
  const env = { ...mcpEnvFor(spec, harness), ...(viaShim ? launcherEnv : {}) }
  const keys = Object.keys(env)
  if (keys.length > 0) {
    const out: Record<string, string> = {}
    for (const k of keys) { const v = env[k] as string; const ref = envRef(v); out[k] = ref !== undefined ? `\${${ref}}` : v }
    entry['env'] = out
  }
  return { ...entry, ...timeout }
}

import type { CanonicalBundle, HookBinding, McpServerSpec } from '../../core/catalog'
import { catalogMcp, expandMcpCommand, mcpEnvFor } from '../../core/catalog'

export const OWNER = 'agy'

/** The one named hook of hooks.json that Buracle Stack owns; the user's own hooks are other names and stay. */
export const HOOK_NAME = 'buracle'

/** The one command every hook runs; the event is its only argument, so the entries survive Buracle Stack updates. */
export const HOOK_COMMAND_PREFIX = '"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" hook agy '

/**
 * The `statusLine` block of AGY's settings.json (docs: antigravity.google/docs/cli/statusline): the CLI runs the command
 * with `sh -c` on its own state changes, pipes the session JSON to it and shows the output. One line, the layout of statusline.yaml.
 */
export const STATUS_LINE_COMMAND = '"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" statusline agy --style full'
export const STATUS_LINE_VALUE = { type: 'command', command: STATUS_LINE_COMMAND } as const

export function isBuracleStatusLine(command: unknown): boolean {
  return typeof command === 'string' && /(?:^|["'\s/])buracle["']?\s+statusline\s+agy(?:\s|$)/.test(command.trim())
}

/** The events AGY CLI has that a binding may name (PostInvocation is the one no binding uses). */
export const AGY_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'Stop'] as const
const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse'])

export function isBuracleCommand(command: unknown): boolean {
  return typeof command === 'string' && /(?:^|["'\s/])buracle["']?\s+hook\s+agy(?:\s|$)/.test(command.trim())
}

interface Raw { event: string, matcher?: string, timeoutMs: number }

function raw(b: HookBinding, out: Raw[]): void {
  if (typeof b.matcher !== 'string' && b.matcher !== undefined) throw new Error(`hooks.yaml: an agy command hook matcher must be a string (${b.event})`)
  out.push({ event: b.event, ...(b.matcher !== undefined ? { matcher: b.matcher } : {}), timeoutMs: b.timeoutMs ?? 10_000 })
  for (const a of b.also ?? []) raw(a, out)
}

/**
 * The value of the `buracle` hook in hooks.json, from the agy bindings of `hooks.yaml`: one handler per event, whose
 * timeout (seconds) is the longest of its bindings. A tool event is grouped with a matcher that is the union of the
 * bindings' matchers, or `*` when one binding has none. The hooks are synchronous: AGY has no async hook.
 */
export function agyHooks(c: Pick<CanonicalBundle, 'hooks'>, prefix: string = HOOK_COMMAND_PREFIX): Record<string, unknown[]> {
  const rows: Raw[] = []
  for (const h of c.hooks.hooks) {
    const b = h.bindings.agy
    if (b !== undefined && !('unsupported' in b)) raw(b, rows)
  }
  const out: Record<string, unknown[]> = {}
  for (const event of AGY_HOOK_EVENTS) {
    const mine = rows.filter(r => r.event === event)
    if (mine.length === 0) continue
    const handler = { type: 'command', command: `${prefix}${event}`, timeout: Math.ceil(Math.max(...mine.map(r => r.timeoutMs)) / 1000) }
    if (!TOOL_EVENTS.has(event)) { out[event] = [handler]; continue }
    const alts = mine.some(r => r.matcher === undefined) ? [] : [...new Set(mine.flatMap(r => (r.matcher as string).split('|').map(x => x.trim()).filter(x => x !== '')))]
    out[event] = [{ matcher: alts.length > 0 ? alts.join('|') : '*', hooks: [handler] }]
  }
  return out
}

/**
 * One `mcpServers` entry of mcp_config.json. A stdio server goes through `buracle` (an absolute path) where it is a
 * package; a remote one names its `url` (the key `agy mcp add` writes is the older `serverUrl`, which AGY still reads).
 * AGY documents no environment forwarding, so a `${ENV:NAME}` value is left out.
 */
export function agyMcpEntry(id: string, spec: McpServerSpec, buracle: string): Record<string, unknown> {
  if (spec.transport === 'http') return { url: spec.url ?? '' }
  const { command, args } = expandMcpCommand(spec, { buracle, id })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(mcpEnvFor(spec, 'agy'))) if (!v.includes('${')) env[k] = v
  return { command, ...(args.length > 0 ? { args } : {}), ...(Object.keys(env).length > 0 ? { env } : {}) }
}

export function agyMcpServers(c: Pick<CanonicalBundle, 'mcp'>, buracle: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const m of catalogMcp(c.mcp, 'agy')) {
    const spec = c.mcp.servers[m.id]
    if (spec !== undefined) out[m.id] = agyMcpEntry(m.id, spec, buracle)
  }
  return out
}

/** The files `harness/agy/` shows: what Buracle Stack owns in hooks.json and in mcp_config.json (`{buracle}` stands for the shim's path). */
export function hooksFragment(c: Pick<CanonicalBundle, 'hooks'>): string {
  return JSON.stringify({ [HOOK_NAME]: agyHooks(c) }, null, 2) + '\n'
}

/** What Buracle Stack owns in AGY's settings.json (`~/.gemini/antigravity-cli/settings.json`). */
export function settingsFragment(): string {
  return JSON.stringify({ statusLine: STATUS_LINE_VALUE }, null, 2) + '\n'
}

export function mcpFragment(c: Pick<CanonicalBundle, 'mcp'>, buracle: string): string {
  return JSON.stringify({ mcpServers: agyMcpServers(c, buracle) }, null, 2) + '\n'
}

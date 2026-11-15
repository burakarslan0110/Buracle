import type { CanonicalBundle, HookBinding, McpServerSpec } from '../../core/catalog'
import { catalogMcp, envRef, expandMcpCommand, mcpEnvFor } from '../../core/catalog'
import type { BuracleConfig } from '../../core/config'

export const OWNER = 'qwen'

/** The one command every hook runs; the event is its only argument, so the entries survive Buracle updates. */
export const HOOK_COMMAND_PREFIX = '"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" hook qwen '

/** The events the Qwen adapter answers; a `hooks.yaml` qwen binding on any other event is left out. */
export const QWEN_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PreCompact', 'PostCompact', 'Stop', 'SubagentStart', 'SessionEnd',
] as const
export type QwenHookEvent = (typeof QWEN_HOOK_EVENTS)[number]

/** The events a `hooks.yaml` qwen binding names that the adapter does not register yet, with the reason (the parity test reads this). */
export const QWEN_UNSERVED: Readonly<Record<string, string>> = {
  UserPromptExpansion: 'flow tracking (H25) is outside the four pillars (skills, hooks, MCP, Brain); Qwen Code 1.0.0-preview.1 does not know the event either',
  SubagentStop: 'the review gate (H19) judges the review agents, which Buracle does not install for Qwen Code yet',
}

/** The events whose hooks take a matcher (tool names, a session's source, a subagent type); the others run for every call. */
const MATCHED = new Set<string>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

export interface QwenHookGroup {
  matcher?: string
  hooks: Array<{ type: 'command', command: string, name: string, timeout: number, async?: true }>
}

/** Two groups of one event may share a matcher (a sync and an async one), so the name tells entries apart. */
export const HOOK_GROUP_IDENTITY: readonly string[] = ['matcher', 'hooks.0.name']

export function isBuracleCommand(command: unknown): boolean {
  return typeof command === 'string' && /(?:^|["'\s/])buracle["']?\s+hook\s+qwen(?:\s|$)/.test(command.trim())
}

interface Raw { event: string, matcher?: string, timeoutMs: number, async: boolean }

function raw(b: HookBinding, out: Raw[]): void {
  if (typeof b.matcher !== 'string' && b.matcher !== undefined) throw new Error(`hooks.yaml: a qwen command hook matcher must be a string (${b.event})`)
  out.push({ event: b.event, ...(b.matcher !== undefined ? { matcher: b.matcher } : {}), timeoutMs: b.timeoutMs ?? 10_000, async: b.async === true })
  for (const a of b.also ?? []) raw(a, out)
}

const alternatives = (m: string): string[] => (m.includes('(') ? [m] : m.split('|').map(x => x.trim()).filter(x => x !== ''))

/**
 * The `hooks` object of Qwen's settings.json, from the qwen bindings of `hooks.yaml`: one group per event (and per
 * sync or async), whose matcher is the union of the bindings' matchers, and whose command is the same constant call.
 * Timeouts are milliseconds: Qwen Code before 0.26 reads the number as milliseconds and later releases read a value of
 * 1000 or more as milliseconds, so one spelling works on every supported release.
 */
export function qwenHooks(c: Pick<CanonicalBundle, 'hooks'>, prefix: string = HOOK_COMMAND_PREFIX): Record<string, QwenHookGroup[]> {
  const rows: Raw[] = []
  for (const h of c.hooks.hooks) {
    const b = h.bindings.qwen
    if (b !== undefined && !('unsupported' in b)) raw(b, rows)
  }
  const out: Record<string, QwenHookGroup[]> = {}
  for (const event of QWEN_HOOK_EVENTS) {
    for (const async of [false, true]) {
      const mine = rows.filter(r => r.event === event && r.async === async)
      if (mine.length === 0) continue
      const timeout = Math.max(...mine.map(r => r.timeoutMs))
      const alts = mine.some(r => r.matcher === undefined) ? [] : [...new Set(mine.flatMap(r => alternatives(r.matcher as string)))]
      const hook: QwenHookGroup['hooks'][number] = { type: 'command', command: `${prefix}${event}`, name: `buracle-${event}${async ? '-async' : ''}`, timeout, ...(async ? { async: true as const } : {}) }
      ;(out[event] ??= []).push({ ...(MATCHED.has(event) && alts.length > 0 ? { matcher: `^(?:${alts.join('|')})$` } : {}), hooks: [hook] })
    }
  }
  return out
}

/** One `mcpServers` entry; the stdio command goes through `buracle` (an absolute path) where the server is a package. */
export function qwenMcpEntry(id: string, spec: McpServerSpec, buracle: string): Record<string, unknown> {
  const timeout = spec.tool_timeout_sec !== undefined ? { timeout: spec.tool_timeout_sec * 1000 } : {}
  // The stable line (0.26 to 0.27) reads `httpUrl`; 1.0.0-preview.1 writes and lists `url` with `type: 'http'`. Both spellings name one server.
  if (spec.transport === 'http') return { httpUrl: spec.url ?? '', url: spec.url ?? '', type: 'http', ...timeout }
  const { command, args } = expandMcpCommand(spec, { buracle, id })
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(mcpEnvFor(spec, 'qwen'))) { const ref = envRef(v); env[k] = ref !== undefined ? `\${${ref}}` : v }
  return { command, ...(args.length > 0 ? { args } : {}), ...(Object.keys(env).length > 0 ? { env } : {}), ...timeout }
}

export function qwenMcpServers(c: Pick<CanonicalBundle, 'mcp'>, buracle: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const m of catalogMcp(c.mcp, 'qwen')) {
    const spec = c.mcp.servers[m.id]
    if (spec !== undefined) out[m.id] = qwenMcpEntry(m.id, spec, buracle)
  }
  return out
}

/** The servers Buracle ships that the user turned off for Qwen (`mcp.off.qwen`): Qwen's own deny list keeps them from connecting. */
export function qwenExcluded(c: Pick<CanonicalBundle, 'mcp'>, cfg: Pick<BuracleConfig, 'mcp'>): string[] {
  const ids = new Set(catalogMcp(c.mcp, 'qwen').map(m => m.id))
  return cfg.mcp.off.qwen.filter(id => ids.has(id)).sort()
}

/** What Buracle owns in settings.json, as the file `harness/qwen/settings.fragment.json` shows it (`{buracle}` stands for the shim's path). */
export function settingsFragment(c: Pick<CanonicalBundle, 'hooks' | 'mcp'>, buracle: string): string {
  return JSON.stringify({ hooks: qwenHooks(c), mcpServers: qwenMcpServers(c, buracle) }, null, 2) + '\n'
}

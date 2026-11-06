/**
 * Reads each harness's own "server off" settings for the routing (R17): the files only; the rules are the
 * pure functions of src/core/policy/mcp-off.ts. A missing, unreadable, malformed or oversized file counts
 * as no off server, and nothing here reports to the agent.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { claudeNativeOff, codexNativeOff, ompNativeOff, opencodeNativeOff, parseJsoncLoose, type ClaudeOffInput } from '../../core/policy/mcp-off'
import * as paths from '../../engine/paths'

/** A settings file larger than this counts as no off server. */
export const NATIVE_OFF_MAX_BYTES = 4 * 1024 * 1024

type Parse = (text: string) => unknown

const cache = new Map<string, { key: string, value: unknown }>()

/** The parsed file, or undefined; kept per path until its mtime or size changes (the long-lived runtimes call this often). */
export function readCapped(file: string, parse: Parse = JSON.parse): unknown {
  let key: string
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > NATIVE_OFF_MAX_BYTES) return undefined
    key = `${st.mtimeMs}:${st.size}`
  } catch {
    return undefined
  }
  const hit = cache.get(file)
  if (hit !== undefined && hit.key === key) return hit.value
  let value: unknown
  try { value = parse(readFileSync(file, 'utf8')) } catch { value = undefined }
  cache.set(file, { key, value })
  return value
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/** The Buracle servers of the Claude plugin with the command lines Claude Code compares a `serverCommand` with. */
export function claudePluginServers(pluginRoot: string): ClaudeOffInput['servers'] {
  const doc = readCapped(join(pluginRoot, '.mcp.json'))
  const servers = isObj(doc) && isObj(doc['mcpServers']) ? doc['mcpServers'] : {}
  const out: Record<string, { commands: string[][], url?: string }> = {}
  for (const [id, raw] of Object.entries(servers)) {
    if (!isObj(raw)) continue
    if (typeof raw['url'] === 'string') { out[id] = { commands: [], url: raw['url'] }; continue }
    if (typeof raw['command'] !== 'string') continue
    const written = [raw['command'], ...(Array.isArray(raw['args']) ? raw['args'].filter((a): a is string => typeof a === 'string') : [])]
    const expanded = written.map(a => a.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot))
    out[id] = { commands: [written, expanded] }
  }
  return out
}

/** Claude Code: `deniedMcpServers` in the user, project, local and managed settings, and the `/mcp` toggle of `project`. */
export function claudeOffServers(project: string, pluginRoot: string): string[] {
  const settings = [
    join(paths.claudeDir(), 'settings.json'),
    join(project, '.claude', 'settings.json'),
    join(project, '.claude', 'settings.local.json'),
    paths.claudeManagedSettingsFile(),
  ].map(f => readCapped(f))
  return claudeNativeOff({ settings, state: readCapped(paths.claudeJson()), project, servers: claudePluginServers(pluginRoot) })
}

/** Codex: `enabled = false` in the user's config.toml. */
export function codexOffServers(): string[] {
  return codexNativeOff(readCapped(join(paths.codexHome(), 'config.toml'), text => Bun.TOML.parse(text)))
}

/** OpenCode: `disabled: true` in the global and the project config (JSON or JSONC). */
export function opencodeOffServers(project: string): string[] {
  const dirs = [paths.opencodeConfigDir(), project]
  const files = dirs.flatMap(d => ['opencode.json', 'opencode.jsonc'].map(n => join(d, n)))
  return opencodeNativeOff(files.map(f => readCapped(f, parseJsoncLoose)))
}

/** Oh My Pi: `disabledServers` in the user's agent MCP file and the project's. */
export function ompOffServers(project: string): string[] {
  return ompNativeOff([join(paths.ompAgentDir(), 'mcp.json'), join(project, '.omp', 'mcp.json')].map(f => readCapped(f)))
}

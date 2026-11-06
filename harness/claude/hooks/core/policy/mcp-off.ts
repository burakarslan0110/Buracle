import type { Harness } from '../events'
import type { McpHealth } from './routing'

/**
 * The MCP servers that are off for a harness. Pure: the adapters pass the configuration and, later, the
 * contents of the harness's own settings; nothing here reads a file.
 */

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function ids(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v !== '') : []
}

/** Buracle's own off list for the harness: `mcp.off.<harness>` of the configuration. */
export function offServersFor(config: { mcp?: unknown }, harness: Harness): string[] {
  const mcp = config.mcp
  if (!isObj(mcp) || !isObj(mcp['off'])) return []
  return ids(mcp['off'][harness])
}

function union(lists: readonly string[][]): string[] {
  return [...new Set(lists.flat())]
}

function sameArgv(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i])
}

const PLUGIN_PREFIX = 'plugin:buracle:'
const serverOfName = (name: string): string => (name.startsWith(PLUGIN_PREFIX) ? name.slice(PLUGIN_PREFIX.length) : name)

export interface ClaudeOffInput {
  /** The parsed settings files that may hold `deniedMcpServers`: user, project, local and managed. */
  settings: readonly unknown[]
  /** The parsed user state file (`.claude.json`), whose `projects[<folder>].disabledMcpServers` the `/mcp` toggle writes. */
  state: unknown
  /** The folder of the session: the key of `projects` in the state file. */
  project: string
  /** Each Buracle server of the plugin: its command lines (as written and expanded) and, for a remote one, its URL. */
  servers: Readonly<Record<string, { commands: readonly (readonly string[])[], url?: string }>>
}

/**
 * The Buracle servers Claude Code itself keeps off: a `deniedMcpServers` entry that names one (`serverName`
 * as `<id>` or `plugin:buracle:<id>`, `serverCommand` equal to its command line, `serverUrl` equal to its
 * URL), or the `/mcp` toggle of the session's project (either name form).
 */
export function claudeNativeOff(input: ClaudeOffInput): string[] {
  const known = Object.keys(input.servers)
  const off = new Set<string>()
  for (const doc of input.settings) {
    if (!isObj(doc) || !Array.isArray(doc['deniedMcpServers'])) continue
    for (const entry of doc['deniedMcpServers']) {
      if (!isObj(entry)) continue
      const name = entry['serverName']
      if (typeof name === 'string' && known.includes(serverOfName(name))) off.add(serverOfName(name))
      for (const id of known) {
        const s = input.servers[id] as ClaudeOffInput['servers'][string]
        if (entry['serverCommand'] !== undefined && s.commands.some(c => sameArgv(entry['serverCommand'], c))) off.add(id)
        if (typeof entry['serverUrl'] === 'string' && s.url !== undefined && entry['serverUrl'] === s.url) off.add(id)
      }
    }
  }
  const projects = isObj(input.state) && isObj(input.state['projects']) ? input.state['projects'] : undefined
  const here = projects !== undefined && isObj(projects[input.project]) ? projects[input.project] as Record<string, unknown> : undefined
  for (const name of ids(here?.['disabledMcpServers'])) if (known.includes(serverOfName(name))) off.add(serverOfName(name))
  return [...off]
}

/** Codex: `enabled = false` in the server's `[mcp_servers.<id>]` table of config.toml. */
export function codexNativeOff(config: unknown): string[] {
  if (!isObj(config) || !isObj(config['mcp_servers'])) return []
  return Object.entries(config['mcp_servers']).flatMap(([id, t]) => (isObj(t) && t['enabled'] === false ? [id] : []))
}

/** OpenCode v2: `disabled: true` under `mcp.servers.<id>`, or the older `mcp.<id>.enabled: false`, in any of its config files. */
export function opencodeNativeOff(configs: readonly unknown[]): string[] {
  return union(configs.map(c => {
    const mcp = isObj(c) && isObj(c['mcp']) ? c['mcp'] : undefined
    if (mcp === undefined) return []
    const servers = isObj(mcp['servers']) ? Object.entries(mcp['servers']).flatMap(([id, s]) => (isObj(s) && s['disabled'] === true ? [id] : [])) : []
    const older = Object.entries(mcp).flatMap(([id, s]) => (id !== 'servers' && id !== 'timeout' && isObj(s) && s['enabled'] === false ? [id] : []))
    return [...servers, ...older]
  }))
}

/** Oh My Pi: the `disabledServers` denylist of its MCP files. */
export function ompNativeOff(docs: readonly unknown[]): string[] {
  return union(docs.map(d => (isObj(d) ? ids(d['disabledServers']) : [])))
}

/**
 * JSON with comments and trailing commas (OpenCode's .jsonc), parsed without a dependency: comments outside
 * strings and commas before a closing bracket are removed first. Undefined for text that still is no JSON.
 */
export function parseJsoncLoose(text: string): unknown {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i] as string
    if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
    } else {
      out += ch
      i++
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as unknown
  } catch {
    return undefined
  }
}

/** The servers that are off in every harness they ship to: nothing should start them, health probes included. */
export function offEverywhere(catalog: { servers: Readonly<Record<string, { harnesses: readonly Harness[] }>> }, config: { mcp?: unknown }): string[] {
  return Object.keys(catalog.servers).sort().filter(id => {
    const hs = catalog.servers[id]?.harnesses ?? []
    return hs.length > 0 && hs.every(h => offServersFor(config, h).includes(id))
  })
}

/** The health with every server in `off` marked `off`: routing then treats it as unavailable, for good. */
export function withOffServers(health: McpHealth, off: readonly string[]): McpHealth {
  if (off.length === 0) return health
  const out: McpHealth = { ...health }
  for (const id of off) out[id] = 'off'
  return out
}

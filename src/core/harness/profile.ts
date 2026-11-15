// What a harness is, as data: one `HarnessProfile` per host (./claude, ./codex, ./opencode, ./omp), and the
// lookups every other module derives from it. A new harness is a profile here plus its adapter.

export type ToolKind = 'bash' | 'edit' | 'write' | 'patch' | 'read' | 'search' | 'web_search' | 'web_fetch'
                     | 'ask_user' | 'plan_exit' | 'plan_enter' | 'todo' | 'agent' | 'mcp' | 'eval' | 'other'

// The seven events every harness maps its native hooks onto.
export type CanonicalEvent = 'sessionStart' | 'prompt' | 'preTool' | 'postTool' | 'stop' | 'preCompact' | 'sessionEnd'

export const CANONICAL_EVENTS: readonly CanonicalEvent[] = ['sessionStart', 'prompt', 'preTool', 'postTool', 'stop', 'preCompact', 'sessionEnd']

/** How a host spells one part (a server or a tool) of an MCP tool name; `fallback` stands in for a part that comes out empty. */
export type McpTokenRule = (part: string, fallback: string) => string

export const wordDashToken: McpTokenRule = part => part.replace(/[^A-Za-z0-9_-]/g, '_')
export const wordToken: McpTokenRule = part => part.replace(/[^A-Za-z0-9_]/g, '_')
export const lowerWordToken: McpTokenRule = (part, fallback) => {
  const t = part.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return t.length > 0 ? t : fallback
}

export interface McpDialect {
  /** What every MCP tool name starts with (`mcp__`), or '' where the host has no prefix. */
  prefix: string
  /** What stands between the server and the tool. */
  separator: string
  token: McpTokenRule
  /** Where a plugin's servers carry `<marker><plugin>_` before the server: the marker, and the plugin Buracle's servers come from. */
  plugin?: { marker: string, name: string }
  /** The separator also occurs inside a server token, so with a list of known servers only those are recognised. */
  ambiguous?: boolean
  /** The host drops a tool name's leading `<server>_`. */
  dropServerPrefix?: boolean
  /** The name shape in words, for the capability card. */
  syntax: string
  /** The capability card's footnote for servers whose tools the host may hide. */
  hiddenNote: string
}

/** A folder of the host that holds Buracle's guards: writes to its `entries` are denied (`''` is the whole folder). */
export interface ProtectedDir { key: string, under: string, entries: readonly string[] }

export interface HarnessProfile {
  id: string
  /** The product name ("Claude Code"). */
  label: string
  /** The name on the status bar. */
  shortLabel: string
  /** The name memory records carry. */
  noteName: string
  /** The command on PATH. */
  bin: string
  /** How a running host is told from its process: the base name, a path shape, a variable holding its pid. */
  proc: { base: RegExp, path?: RegExp, pidEnv?: string }
  /** `command`: hooks are processes reading stdin; `inprocess`: a plugin or extension inside the host. */
  runtime: 'command' | 'inprocess'
  /** The suffix of the command hooks' spool file, where an in-process writer of the same host has the plain one. */
  spoolSuffix?: string
  /** How long the checks after an edit may run. */
  editBudgetMs: number
  configDir: {
    /** The key of this folder in `SelfPaths` and in `src/engine/paths.ts`. */
    key: string
    /** The variable that relocates it, and the folder under its value when the variable names a parent. */
    env: string
    envSubdir?: string
    /** The default, under the home folder. */
    under: string
  }
  /** Variables that make the host start from another setup. */
  relocationEnv: readonly string[]
  /** Variables that carry the host's session id, in the order they are read. */
  sessionEnv: readonly string[]
  protectedDirs: readonly ProtectedDir[]
  /** The denial text for a write into `protectedDirs`. */
  selfText: { what: string, remedy: string }
  skills: {
    /** Lists the user's `~/.agents/skills` (where Buracle installs the one copy of its skills), the user's `~/.claude/skills` and a project's `.claude/skills` itself. */
    readsAgentsDir: boolean
    /** For a host that does not read `~/.agents/skills` and gets the skills no other way: the folder of its config dir that holds one link per skill to the installed copy. */
    linkDir?: string
    readsClaudeUserDir: boolean
    readsClaudeProjectDir: boolean
    /** What the user types to start a skill: `/<id>`, `/<namespace>:<id>`, `$<id>`, `@<id>`, and whether the host reports it in a `<command-name>` tag. */
    invoke: { slash: boolean, namespace?: string, dollar: boolean, at: boolean, commandTag: boolean }
    /** How a user-invocable skill and a protocol are written in rendered prose. */
    mention(id: string, invocable: boolean): string
    /** The prefix of a Buracle agent's name. */
    agentPrefix: string
    /** The capability card's line on starting and loading skills. */
    howto: string
    /** How the model loads one skill; `file` is the skill file where the host knows it. */
    load(id: string, explicit: boolean, file: string | undefined): string
    /** The same for a list of candidates. */
    candidateHow: string
  }
  plan: {
    /** How the model gets into the host's plan mode. */
    enter: string
    /** The host's read-only mode and how the user leaves it. */
    readOnly: { name: string, leave: string }
    /** Leaving plan mode is an approval the hooks can see. */
    approval: boolean
  }
  mcp: McpDialect
  /** Client names an MCP `initialize` carries: substrings, and names that must match whole. */
  mcpClient: { includes: readonly string[], exact?: readonly string[] }
  events: {
    /** Canonical event → the native events it is read from; null where the host has none (then `HOST_LIMITS` says why). */
    map: Readonly<Record<CanonicalEvent, readonly string[] | null>>
    /** Every native event a binding in `canonical/hooks.yaml` may name. */
    native: readonly string[]
  }
  tools: {
    /** Native tool name → kind. */
    kinds: Readonly<Record<string, ToolKind>>
    /** The names prose uses for the ask, todo and subagent tools. */
    names: { ask_user: string, todo: string, spawn_agent: string }
    /** What prose says where the host has no todo tool worth naming. */
    todoProse?: string
    /** A path of this scheme (`xd`) is a device, not a file: a write to one is an MCP call. */
    deviceScheme?: string
    /** The read tool also fetches http(s) URLs. */
    readFetchesUrls?: boolean
    /** The edit tool also takes an apply_patch text in `input`. */
    editTakesPatch?: boolean
    /** Shell tools whose command is a string only; without one the call is no shell call. */
    stringCommandOnly?: readonly string[]
  }
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

export function toolKindOf(p: Pick<HarnessProfile, 'tools'>, tool: string): ToolKind | undefined {
  return own(p.tools.kinds, tool)
}

/** The native names of the host's shell tools. */
export function shellTools(p: Pick<HarnessProfile, 'tools'>): string[] {
  return Object.keys(p.tools.kinds).filter(t => p.tools.kinds[t] === 'bash' || p.tools.kinds[t] === 'eval')
}

export function mcpToken(d: McpDialect, server: string): string {
  return d.token(server, 'server')
}

function mcpHead(d: McpDialect, server: string): string {
  return `${d.prefix}${d.plugin !== undefined ? `${d.plugin.marker}${d.plugin.name}_` : ''}${mcpToken(d, server)}${d.separator}`
}

/** The name the host gives a tool of one of Buracle's MCP servers. */
export function mcpToolName(d: McpDialect, server: string, tool: string): string {
  const s = mcpToken(d, server)
  let t = d.token(tool, 'tool')
  if (d.dropServerPrefix === true && t.startsWith(`${s}_`) && t.length > s.length + 1) t = t.slice(s.length + 1)
  return `${mcpHead(d, server)}${t}`
}

/** A pattern matching every tool of one of Buracle's MCP servers. */
export function mcpToolPattern(d: McpDialect, server: string): string {
  return `${mcpHead(d, server)}*`
}

export function parseMcpToolName(d: McpDialect, name: string, knownServers?: readonly string[]): { server: string, tool: string } | undefined {
  if (!name.startsWith(d.prefix)) return undefined
  const rest = name.slice(d.prefix.length)
  const sep = d.separator
  const marker = d.plugin?.marker
  if (knownServers && knownServers.length > 0) {
    let best: { server: string, tool: string, len: number } | undefined
    for (const s of knownServers) {
      const tok = mcpToken(d, s)
      const direct = `${tok}${sep}`
      if (rest.startsWith(direct) && rest.length > direct.length) {
        if (!best || tok.length > best.len) best = { server: s, tool: rest.slice(direct.length), len: tok.length }
      }
      if (marker !== undefined && rest.startsWith(marker)) {
        const inside = `_${tok}${sep}`
        const at = rest.indexOf(inside, marker.length)
        if (at > marker.length && rest.length > at + inside.length) {
          if (!best || tok.length > best.len) best = { server: s, tool: rest.slice(at + inside.length), len: tok.length }
        }
      }
    }
    if (best) return { server: best.server, tool: best.tool }
    if (d.ambiguous === true) return undefined
  }
  const at = rest.indexOf(sep)
  if (at <= 0 || at + sep.length >= rest.length) return undefined
  let server = rest.slice(0, at)
  const tool = rest.slice(at + sep.length)
  if (marker !== undefined && server.startsWith(marker)) {
    const inner = server.slice(marker.length)
    const us = inner.indexOf('_')
    if (us > 0 && us + 1 < inner.length) server = inner.slice(us + 1)
  }
  return { server, tool }
}

function absolute(v: string | undefined): string | undefined {
  return typeof v === 'string' && v.trim() !== '' && v.trim().startsWith('/') ? v.trim() : undefined
}

// An absolute folder plus a relative path, normalized (`.`, `..` and doubled slashes resolved).
function joined(dir: string, rel: string): string {
  const out: string[] = []
  for (const seg of `${dir}/${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

/** The host's config folder in this environment: the relocating variable when it is an absolute path, else the default under HOME. */
export function configDirOf(p: Pick<HarnessProfile, 'configDir'>, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const moved = absolute(env[p.configDir.env])
  if (moved !== undefined) return p.configDir.envSubdir !== undefined ? joined(moved, p.configDir.envSubdir) : moved
  const home = absolute(env['HOME'])
  return home !== undefined ? joined(home, p.configDir.under) : undefined
}

/** Which host a process is, from its command path and, where the host names its pid in a variable, that variable. */
export function processMatches(p: Pick<HarnessProfile, 'proc'>, comm: string, pid?: number, env: Readonly<Record<string, string | undefined>> = {}): boolean {
  if (pid !== undefined && p.proc.pidEnv !== undefined && env[p.proc.pidEnv] === String(pid)) return true
  const c = comm.trim()
  if (p.proc.path !== undefined && p.proc.path.test(c)) return true
  return p.proc.base.test((c.split('/').pop() ?? '').replace(/^-/, ''))
}

export function mcpClientMatches(p: Pick<HarnessProfile, 'mcpClient'>, clientName: string): boolean {
  const n = clientName.toLowerCase()
  return p.mcpClient.includes.some(s => n.includes(s)) || (p.mcpClient.exact ?? []).includes(n)
}

/** What the profile holds for a host that lacks nothing: no canonical event is null. */
export function missingEvents(p: Pick<HarnessProfile, 'events'>): CanonicalEvent[] {
  return CANONICAL_EVENTS.filter(e => p.events.map[e] === null)
}

export interface HarnessSet<Id extends string> {
  ids: readonly Id[]
  is(x: unknown): x is Id
  of(id: Id): HarnessProfile
  /** One value per harness, read from its profile. */
  table<T>(pick: (p: HarnessProfile) => T): Readonly<Record<Id, T>>
  /** The harnesses whose profile passes. */
  where(test: (p: HarnessProfile) => boolean): Id[]
}

/** The lookups over a set of profiles; the key order is the order of the harnesses everywhere. */
export function defineHarnesses<Id extends string>(profiles: Readonly<Record<Id, HarnessProfile>>): HarnessSet<Id> {
  const ids = Object.keys(profiles) as Id[]
  for (const id of ids) if (profiles[id].id !== id) throw new Error(`harness profile ${JSON.stringify(profiles[id].id)} is registered as ${JSON.stringify(id)}`)
  return {
    ids,
    is: (x): x is Id => typeof x === 'string' && (ids as readonly string[]).includes(x),
    of: id => profiles[id],
    table: pick => Object.fromEntries(ids.map(id => [id, pick(profiles[id])])) as Record<Id, ReturnType<typeof pick>>,
    where: test => ids.filter(id => test(profiles[id])),
  }
}

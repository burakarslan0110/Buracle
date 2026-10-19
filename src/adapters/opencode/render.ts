import type { AgentDoc, CanonicalBundle, McpServerSpec, RuleDoc } from '../../core/catalog'
import { catalogMcp, catalogSkills, envRef, expandMcpCommand, mcpEnvFor } from '../../core/catalog'
import type { HookId } from '../../core/events'
import { HOOK_IDS } from '../../core/events'
import { pathRuleIndex } from '../../core/policy/path-rules'
import { harnessMcpToolName } from '../../core/policy/routing'
import { sha256 } from '../../engine/fsx'
import { stableStringify } from '../../engine/merge'
import {
  CLI_SCHEMA_URL, CONFIG_SCHEMA_URL, GLOBAL_PERMISSIONS, MCP_STARTUP_TIMEOUT_MS, READONLY_SHELL_ALLOW,
  READONLY_SHELL_DENY, TESTED_WITH,
} from './constants'
import type { BakedData, BakedHook } from './runtime/baked'
import { DEFAULT_HOOK_FAILURE } from './runtime/baked'

export type PermissionRule = { action: string, resource: string, effect: 'allow' | 'deny' | 'ask' }

export function expandPlaceholders(text: string): string {
  const LIT = '\u0000LITERAL\u0000'
  return text
    .replace(/\\\{\{/g, LIT)
    .replace(/\{\{ask_user\}\}/g, 'the `question` tool')
    .replace(/\{\{todo\}\}/g, 'a short checklist in your messages (OpenCode v2 has no todo tool)')
    .replace(/\{\{spawn_agent\}\}/g, 'the `subagent` tool')
    .replace(/\{\{skill:([a-z0-9][a-z0-9._-]*)\}\}/g, (_m, id: string) => `the \`${id}\` skill (load it with the \`skill\` tool)`)
    .replace(/\{\{agent:([a-z0-9][a-z0-9._-]*)\}\}/g, (_m, id: string) => `the \`${id}\` subagent`)
    .split(LIT).join('{{')
}

export function selectHarnessBlocks(text: string): string {
  return text.replace(/<!-- harness:([a-z]+) -->\n?([\s\S]*?)<!-- \/harness -->\n?/g, (_m, h: string, inner: string) => (h === 'opencode' ? inner : ''))
}

export function renderText(text: string): string {
  return expandPlaceholders(selectHarnessBlocks(text.replace(/\r\n/g, '\n')))
}

function trimBlock(s: string): string {
  return s.replace(/^\s*\n/, '').replace(/\s+$/, '')
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function ruleGlobs(rule: RuleDoc): string[] {
  const p = rule.frontmatter['paths']
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
}

function ruleTitle(rule: RuleDoc): string {
  return /^#\s+(.+?)\s*$/m.exec(rule.body)?.[1] ?? rule.id
}

export function agentsBlock(canonical: CanonicalBundle, pathRulesDir: string): string {
  const always = canonical.rules.filter(r => r.scope === 'always').sort(byId)
  const pathRules = canonical.rules.filter(r => r.scope === 'paths').sort(byId)
  const out: string[] = [
    '<!-- Managed by Buracle (`buracle install`). Edit canonical/rules in the Buracle repository instead of this block. -->',
  ]
  for (const r of always) out.push('', trimBlock(renderText(r.body)))
  if (pathRules.length > 0) {
    out.push('', '# Path-scoped rules', '', 'Before you create or change a file that matches one of these patterns, read the rule file listed for it (once per session):', '')
    for (const r of pathRules) {
      const shown = ruleGlobs(r).map(g => `\`${g}\``).join(', ')
      out.push(`- ${ruleTitle(r)}: \`${pathRulesDir}/${r.id}.md\` (${shown})`)
    }
  }
  return out.join('\n') + '\n'
}

function yamlScalar(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

function frontmatter(entries: Array<[string, unknown]>): string {
  const lines = ['---']
  for (const [k, v] of entries) {
    if (v === undefined) continue
    if (Array.isArray(v)) {
      lines.push(`${k}:`)
      for (const item of v) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const inner = Object.entries(item as Record<string, unknown>).map(([ik, iv]) => `${ik}: ${yamlScalar(iv)}`).join(', ')
          lines.push(`  - { ${inner} }`)
        } else lines.push(`  - ${yamlScalar(item)}`)
      }
    } else lines.push(`${k}: ${yamlScalar(v)}`)
  }
  lines.push('---')
  return lines.join('\n')
}

function oneLine(s: unknown): string | undefined {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : undefined
}

export function agentPermissions(agent: AgentDoc): PermissionRule[] {
  const access = agent.frontmatter['access']
  if (access !== 'read-only') return []
  const tools = Array.isArray(agent.frontmatter['tools']) ? agent.frontmatter['tools'].filter((t): t is string => typeof t === 'string') : []
  const rules: PermissionRule[] = [{ action: '*', resource: '*', effect: 'deny' }]
  if (tools.includes('read')) {
    rules.push(
      { action: 'read', resource: '*', effect: 'allow' },
      { action: 'read', resource: '*.env', effect: 'deny' },
      { action: 'read', resource: '*.env.*', effect: 'deny' },
      { action: 'read', resource: '*.env.example', effect: 'allow' },
    )
  }
  if (tools.includes('search')) rules.push({ action: 'glob', resource: '*', effect: 'allow' }, { action: 'grep', resource: '*', effect: 'allow' })
  if (tools.includes('read') || tools.includes('search')) rules.push({ action: 'external_directory', resource: '*', effect: 'ask' })
  if (tools.includes('bash-readonly')) {
    for (const p of READONLY_SHELL_ALLOW) rules.push({ action: 'shell', resource: p, effect: 'allow' })
    for (const p of READONLY_SHELL_DENY) rules.push({ action: 'shell', resource: p, effect: 'deny' })
  }
  for (const t of tools) {
    const m = /^mcp:([a-z0-9][a-z0-9-]*)$/.exec(t)
    if (m?.[1] !== undefined) rules.push({ action: `${m[1].replace(/[^a-zA-Z0-9_-]/g, '_')}_*`, resource: '*', effect: 'allow' })
  }
  rules.push({ action: 'edit', resource: '*', effect: 'deny' })
  return rules
}

function agentModel(agent: AgentDoc): string | undefined {
  const m = agent.frontmatter['model']
  const v = typeof m === 'string' ? m : m !== null && typeof m === 'object' ? (m as Record<string, unknown>)['opencode'] : undefined
  return typeof v === 'string' && v !== '' && v !== 'inherit' && v.includes('/') ? v : undefined
}

export function renderAgent(agent: AgentDoc): string {
  const fm = frontmatter([
    ['description', oneLine(agent.frontmatter['description']) ?? agent.id],
    ['mode', 'subagent'],
    ['model', agentModel(agent)],
    ['permissions', agentPermissions(agent)],
  ])
  return `${fm}\n\n${trimBlock(renderText(agent.body))}\n`
}

function isPackageServer(spec: McpServerSpec): boolean {
  return spec.transport === 'stdio' && spec.package !== undefined && spec.package.registry !== 'none'
}

export const OPENCODE_MCP_EXECUTION_TIMEOUT_MS = 12 * 60 * 60 * 1000

export function mcpServerEntry(spec: McpServerSpec, shim: string, id?: string): Record<string, unknown> {
  const ms = spec.tool_timeout_sec !== undefined ? spec.tool_timeout_sec * 1000 : 0
  const execution = ms > 0 && (spec.tool_timeout_hard === true || ms > OPENCODE_MCP_EXECUTION_TIMEOUT_MS) ? { execution: ms } : undefined
  if (spec.transport === 'http') {
    const out: Record<string, unknown> = { type: 'remote', url: spec.url ?? '', oauth: false }
    if (spec.critical) out['codemode'] = false
    if (execution !== undefined) out['timeout'] = execution
    return out
  }
  const { command, args } = expandMcpCommand(spec, id !== undefined ? { buracle: shim, id } : { buracle: shim })
  const out: Record<string, unknown> = { type: 'local', command: [command, ...args] }
  const env = mcpEnvFor(spec, 'opencode')
  const keys = Object.keys(env)
  if (keys.length > 0) {
    const environment: Record<string, string> = {}
    for (const k of keys) {
      const v = env[k] as string
      const ref = envRef(v)
      environment[k] = ref !== undefined ? `{env:${ref}}` : v
    }
    out['environment'] = environment
  }
  if (spec.critical) out['codemode'] = false
  if (isPackageServer(spec)) out['timeout'] = { startup: MCP_STARTUP_TIMEOUT_MS, ...execution }
  else if (execution !== undefined) out['timeout'] = execution
  return out
}

export function opencodeServers(canonical: CanonicalBundle, shim: string): Array<[string, Record<string, unknown>]> {
  return Object.keys(canonical.mcp.servers).sort().flatMap((id): Array<[string, Record<string, unknown>]> => {
    const spec = canonical.mcp.servers[id]
    if (spec === undefined || !spec.harnesses.includes('opencode')) return []
    return [[id, mcpServerEntry(spec, shim, id)]]
  })
}

export function mcpDenyRules(canonical: CanonicalBundle): PermissionRule[] {
  return Object.keys(canonical.mcp.servers).sort().flatMap(id => {
    const spec = canonical.mcp.servers[id]
    if (spec === undefined || !spec.harnesses.includes('opencode')) return []
    return (spec.disabled_tools ?? []).map((tool): PermissionRule => ({ action: harnessMcpToolName('opencode', id, tool), resource: '*', effect: 'deny' }))
  })
}

export function configPermissions(canonical: CanonicalBundle): PermissionRule[] {
  return [...GLOBAL_PERMISSIONS.map(r => ({ ...r })), ...mcpDenyRules(canonical)]
}

export function configSet(canonical: CanonicalBundle, shim: string): Record<string, unknown> {
  const set: Record<string, unknown> = {
    '$schema': CONFIG_SCHEMA_URL,
    share: 'disabled',
    permissions: configPermissions(canonical),
  }
  for (const [id, entry] of opencodeServers(canonical, shim)) set[`mcp.servers.${id}`] = entry
  return set
}

export function configFragmentText(canonical: CanonicalBundle, shim: string): string {
  const servers: Record<string, unknown> = {}
  for (const [id, entry] of opencodeServers(canonical, shim)) servers[id] = entry
  const doc = { $schema: CONFIG_SCHEMA_URL, share: 'disabled', permissions: configPermissions(canonical), mcp: { servers } }
  return [
    '// Buracle keys for ~/.config/opencode/opencode.jsonc (OpenCode v2). `buracle install` merges them key by key',
    '// (mcp.servers.<id>, permissions, share, $schema) and keeps every other key and comment of the user.',
    '// {env:HOME}/.buracle/bin/buracle is replaced with the absolute shim path at install time.',
    JSON.stringify(doc, null, 2),
  ].join('\n') + '\n'
}

export function cliSet(pluginDir: string, opts: { bypass?: boolean } = {}): Record<string, unknown> {
  const set: Record<string, unknown> = { '$schema': CLI_SCHEMA_URL, plugins: [pluginDir] }
  if (opts.bypass === true) set['session.permissions'] = 'autoaccept'
  return set
}

export function cliFragmentText(): string {
  return [
    '// Buracle keys for ~/.config/opencode/cli.json (OpenCode v2 TUI settings), merged by `buracle install`.',
    '// `plugins` gets one entry at install time: the absolute path of <config dir>/plugins/buracle, which',
    '// enables the Buracle status line without disabling the built-in footer. It is left out when the user',
    '// already keeps their own `plugins` list.',
    JSON.stringify({ $schema: CLI_SCHEMA_URL }, null, 2),
  ].join('\n') + '\n'
}

function bakedHooks(canonical: CanonicalBundle): BakedHook[] {
  const out: BakedHook[] = []
  for (const id of HOOK_IDS) {
    const spec = canonical.hooks.hooks.find(h => h.id === id)
    if (spec !== undefined) out.push({ id, blocking: spec.blocking, failure: spec.failure })
    else if (DEFAULT_HOOK_FAILURE[id] !== undefined) out.push({ id: id as HookId, blocking: 'none', failure: DEFAULT_HOOK_FAILURE[id] as 'open' | 'closed' })
  }
  return out
}

export function contentHash(canonical: CanonicalBundle): string {
  return sha256(stableStringify({
    config: canonical.config,
    mcp: canonical.mcp,
    plugins: canonical.plugins.opencode,
    hooks: canonical.hooks,
    routing: canonical.routing,
    statusline: canonical.statusline.opencode ?? null,
    rules: canonical.rules.map(r => ({ id: r.id, scope: r.scope, fm: r.frontmatter, body: r.body })),
    skills: canonical.skills.map(s => ({ id: s.id, fm: s.frontmatter })),
    agents: canonical.agents.map(a => ({ id: a.id, fm: a.frontmatter, body: a.body })),
  }))
}

export function bakedData(canonical: CanonicalBundle, opts: { withLayout: boolean, version?: string }): BakedData {
  const baked: BakedData = {
    v: 1,
    contentHash: contentHash(canonical),
    testedWith: TESTED_WITH,
    defaults: canonical.config,
    routing: canonical.routing,
    mcp: catalogMcp(canonical.mcp, 'opencode'),
    mcpIds: Object.keys(canonical.mcp.servers).sort(),
    skills: catalogSkills(canonical.skills),
    plugins: canonical.plugins.opencode.plugins.filter(p => p.enabled).map(p => p.id).sort(),
    hooks: bakedHooks(canonical),
    pathRules: pathRuleIndex(canonical.rules),
  }
  const layout = canonical.statusline.opencode
  if (opts.withLayout && layout !== undefined) baked.layout = layout
  if (opts.version !== undefined) baked.version = opts.version
  if ((canonical.notices ?? []).length > 0) baked.notices = (canonical.notices ?? []).map(n => ({ ...n }))
  return baked
}

import type { McpCatalog, StatuslineCatalog } from '../../core/catalog'
import { envRef, expandMcpCommand, mcpEnvFor } from '../../core/catalog'
import { compactPrompt } from '../../core/compact'
import type { BuracleConfig } from '../../core/config'
import { resolveEffort } from '../../core/effort'
import { tomlKey, tomlValue } from '../../engine/merge'

export type McpTable = Record<string, unknown>

export const PACKAGE_STARTUP_TIMEOUT_SEC = 30

export const CODEX_ENUMS = {
  approval_policy: ['untrusted', 'on-request', 'on-failure', 'never'],
  sandbox_mode: ['read-only', 'workspace-write', 'danger-full-access'],
  web_search: ['disabled', 'cached', 'indexed', 'live'],
  omit_tools_from: ['direct', 'deferred', 'code_mode'],
  default_tools_approval_mode: ['auto', 'prompt', 'writes', 'approve'],
  reasoning_effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
} as const satisfies Record<string, readonly string[]>

export type CodexEnumKey = keyof typeof CODEX_ENUMS

export function codexEnumProblem(key: CodexEnumKey, value: unknown): string | undefined {
  const allowed: readonly string[] = CODEX_ENUMS[key]
  const items = Array.isArray(value) ? value : [value]
  if (Array.isArray(value) && value.length === 0) return `${key}: an empty list`
  for (const v of items) {
    if (typeof v !== 'string' || !allowed.includes(v)) return `${key}: ${JSON.stringify(v)} is not one of ${allowed.join(', ')} (Codex would refuse to start)`
  }
  return undefined
}

export const CRITICAL_OMIT_TOOLS_FROM: readonly string[] = ['deferred', 'code_mode']

export const BYPASS_TOOLS_APPROVAL_MODE = 'approve'

export interface McpTableOptions {
  approve?: boolean
}

export function codexMcpTables(mcp: McpCatalog, buracle: string, warnings: string[] = [], opts: McpTableOptions = {}): Record<string, McpTable> {
  const out: Record<string, McpTable> = {}
  for (const id of Object.keys(mcp.servers).sort()) {
    const spec = mcp.servers[id]
    if (!spec || !spec.harnesses.includes('codex')) continue
    let table: McpTable
    if (spec.transport === 'http') {
      if (!spec.url) { warnings.push(`mcp.yaml: ${id}: http server without url; skipped for Codex`); continue }
      table = { url: spec.url }
    } else {
      const { command, args } = expandMcpCommand(spec, { buracle, id })
      table = { command }
      if (args.length > 0) table['args'] = args
      const env: Record<string, string> = {}
      const envVars: string[] = []
      const vars = mcpEnvFor(spec, 'codex')
      for (const k of Object.keys(vars)) {
        const v = vars[k] as string
        const ref = envRef(v)
        if (ref === undefined) env[k] = v
        else if (ref === k) envVars.push(k)
        else warnings.push(`mcp.yaml: ${id}: env ${k} forwards \${ENV:${ref}}; Codex can only forward a variable under its own name, so it is not passed`)
      }
      if (Object.keys(env).length > 0) table['env'] = env
      if (envVars.length > 0) table['env_vars'] = envVars
      if (spec.package && (spec.package.registry === 'npm' || spec.package.registry === 'pypi')) table['startup_timeout_sec'] = PACKAGE_STARTUP_TIMEOUT_SEC
    }
    if (spec.tool_timeout_sec !== undefined) table['tool_timeout_sec'] = spec.tool_timeout_sec
    if (spec.critical) table['omit_tools_from'] = [...CRITICAL_OMIT_TOOLS_FROM]
    if (opts.approve === true) table['default_tools_approval_mode'] = BYPASS_TOOLS_APPROVAL_MODE
    out[`mcp_servers.${id}`] = table
  }
  return out
}

export function routingRootKeys(cfg: Pick<BuracleConfig, 'routing'>): Record<string, unknown> {
  const keys: Record<string, unknown> = { mcp_optional_startup_grace_ms: 0 }
  if (cfg.routing.strictness === 'enforce') keys['web_search'] = 'disabled'
  return keys
}

export const SUBAGENT_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh']

export function subagentEffort(level: string): string {
  if (SUBAGENT_EFFORTS.includes(level)) return level
  return level === 'none' || level === 'minimal' ? 'low' : 'xhigh'
}

export function effortKeys(cfg: Pick<BuracleConfig, 'effort'>): Record<string, string> | undefined {
  const r = resolveEffort('codex', cfg.effort.codex)
  if (!('level' in r)) return undefined
  return { model_reasoning_effort: r.level, plan_mode_reasoning_effort: r.level, 'agents.default_subagent_reasoning_effort': subagentEffort(r.level) }
}

export const GRANULAR_FLAGS = ['sandbox_approval', 'rules', 'skill_approval', 'request_permissions', 'mcp_elicitations'] as const

export const BYPASS_APPROVAL_POLICY: Readonly<{ granular: Readonly<Record<typeof GRANULAR_FLAGS[number], boolean>> }> = {
  granular: { sandbox_approval: false, rules: true, skill_approval: false, request_permissions: false, mcp_elicitations: false },
}

export const BYPASS_KEYS: Readonly<Record<string, unknown>> = { approval_policy: BYPASS_APPROVAL_POLICY, sandbox_mode: 'danger-full-access' }

export function approvalPolicyProblem(value: unknown): string | undefined {
  if (typeof value === 'string') return codexEnumProblem('approval_policy', value)
  const g = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)['granular'] : undefined
  if (g === null || typeof g !== 'object' || Array.isArray(g) || Object.keys(value as object).length !== 1) return `approval_policy: ${JSON.stringify(value)} is neither one of ${CODEX_ENUMS.approval_policy.join(', ')} nor { granular = { ... } } (Codex would refuse to start)`
  const flags = g as Record<string, unknown>
  const bad = Object.keys(flags).find(k => !(GRANULAR_FLAGS as readonly string[]).includes(k) || typeof flags[k] !== 'boolean')
  return bad !== undefined ? `approval_policy.granular.${bad}: not one of the boolean flags ${GRANULAR_FLAGS.join(', ')} (Codex would refuse to start)` : undefined
}

export const TEAMS_KEYS = ['agents.enabled'] as const

export function teamsKeys(cfg: Pick<BuracleConfig, 'agents'>): Record<string, boolean> | undefined {
  return cfg.agents.teams ? { 'agents.enabled': true } : undefined
}

export const MEMORY_KEYS: Readonly<Record<string, boolean>> = { 'features.memories': false }

export function compactKeys(): Record<string, string> {
  return { compact_prompt: compactPrompt() }
}

export function codexValueProblems(input: { mcpTables: Record<string, McpTable>, rootKeys: Record<string, unknown>, effort?: Record<string, string>, bypass?: Readonly<Record<string, unknown>> }): string[] {
  const out: string[] = []
  const check = (where: string, key: CodexEnumKey, v: unknown) => { const p = codexEnumProblem(key, v); if (p !== undefined) out.push(`${where}: ${p}`) }
  for (const [name, t] of Object.entries(input.mcpTables)) {
    if (t['omit_tools_from'] !== undefined) check(name, 'omit_tools_from', t['omit_tools_from'])
    if (t['default_tools_approval_mode'] !== undefined) check(name, 'default_tools_approval_mode', t['default_tools_approval_mode'])
  }
  if (input.rootKeys['web_search'] !== undefined) check('config.toml', 'web_search', input.rootKeys['web_search'])
  const grace = input.rootKeys['mcp_optional_startup_grace_ms']
  if (grace !== undefined && !(typeof grace === 'number' && Number.isInteger(grace) && grace >= 0)) out.push(`config.toml: mcp_optional_startup_grace_ms must be a whole number of milliseconds (got ${JSON.stringify(grace)})`)
  for (const [k, v] of Object.entries(input.effort ?? {})) check(k, 'reasoning_effort', v)
  const sub = input.effort?.['agents.default_subagent_reasoning_effort']
  if (sub !== undefined && !SUBAGENT_EFFORTS.includes(sub)) out.push(`agents.default_subagent_reasoning_effort: ${JSON.stringify(sub)} is not supported by every model (spawn_agent would fail)`)
  if (input.bypass !== undefined) {
    const policy = approvalPolicyProblem(input.bypass['approval_policy'])
    if (policy !== undefined) out.push(`config.toml: ${policy}`)
    check('config.toml', 'sandbox_mode', input.bypass['sandbox_mode'])
  }
  return out
}

export const STATUS_LINE_ITEMS: readonly string[] = [
  'model', 'model-name', 'model-with-reasoning', 'reasoning', 'current-dir', 'project-name', 'project', 'project-root',
  'hostname', 'git-branch', 'pull-request-number', 'branch-changes', 'run-state', 'status', 'permissions',
  'approval-mode', 'approval', 'context-remaining', 'context-used', 'context-usage', 'five-hour-limit', 'weekly-limit',
  'codex-version', 'context-window-size', 'used-tokens', 'total-input-tokens', 'total-output-tokens', 'thread-credits',
  'estimated-thread-cost', 'thread-id', 'session-id', 'fast-mode', 'daybreak', 'raw-output', 'thread-name', 'thread-title',
  'workspace-headline', 'task-progress',
]

export const TERMINAL_TITLE_ITEMS: readonly string[] = [
  'app-name', 'project-name', 'project', 'current-dir', 'activity', 'spinner', 'run-state', 'status', 'thread-name',
  'thread-title', 'thread', 'git-branch', 'context-remaining', 'context-used', 'context-usage', 'five-hour-limit',
  'weekly-limit', 'codex-version', 'used-tokens', 'total-input-tokens', 'total-output-tokens', 'thread-credits',
  'estimated-thread-cost', 'thread-id', 'session-id', 'fast-mode', 'daybreak', 'model', 'model-name',
  'model-with-reasoning', 'reasoning', 'task-progress',
]

export const DEFAULT_STATUS_LINE = ['model-with-reasoning', 'context-used', 'five-hour-limit', 'weekly-limit', 'git-branch', 'branch-changes', 'task-progress', 'run-state']
export const DEFAULT_TERMINAL_TITLE = ['activity', 'project-name', 'git-branch', 'context-used', 'five-hour-limit', 'weekly-limit']

export interface CodexTui { status_line: string[], terminal_title: string[] }

function itemList(x: unknown, allowed: readonly string[], what: string, warnings: string[]): string[] | undefined {
  if (!Array.isArray(x)) return undefined
  const out: string[] = []
  for (const item of x) {
    if (typeof item !== 'string' || !allowed.includes(item)) { warnings.push(`statusline.yaml: codex.native.${what}: unknown Codex item ${JSON.stringify(item)} dropped`); continue }
    if (!out.includes(item)) out.push(item)
  }
  return out
}

export function codexTui(statusline: StatuslineCatalog, warnings: string[] = []): CodexTui {
  const codex = statusline.codex as unknown as Record<string, unknown> | undefined
  const native = codex && typeof codex === 'object' ? codex['native'] as Record<string, unknown> | undefined : undefined
  const statusLine = native ? itemList(native['status_line'], STATUS_LINE_ITEMS, 'status_line', warnings) : undefined
  const title = native ? itemList(native['terminal_title'], TERMINAL_TITLE_ITEMS, 'terminal_title', warnings) : undefined
  if (statusLine === undefined) warnings.push('statusline.yaml: no codex.native.status_line; using the built-in default')
  if (title === undefined) warnings.push('statusline.yaml: no codex.native.terminal_title; using the built-in default')
  return { status_line: statusLine ?? [...DEFAULT_STATUS_LINE], terminal_title: title ?? [...DEFAULT_TERMINAL_TITLE] }
}

export const UPDATE_PLAN_TABLE = 'tools.update_plan'
export function updatePlanTable(): Record<string, unknown> {
  return { enabled: true }
}

export function renderTomlTables(tables: ReadonlyArray<readonly [string, Record<string, unknown>]>): string {
  const parts: string[] = []
  for (const [name, values] of tables) {
    const header = name.split('.').map(tomlKey).join('.')
    const body = Object.entries(values).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)
    parts.push([`[${header}]`, ...body].join('\n'))
  }
  return parts.join('\n\n') + '\n'
}

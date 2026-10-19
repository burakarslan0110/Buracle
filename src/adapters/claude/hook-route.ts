import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogSkill } from '../../core/catalog'
import { catalogMcp, catalogSkills } from '../../core/catalog'
import type { BuracleConfig } from '../../core/config'
import { CM_SERVER_ID } from '../../core/context-mode'
import type { ToolCall } from '../../core/events'
import type { McpHealth, RoutingPolicy } from '../../core/policy/routing'
import { capabilityCard, mcpHealthOf, withDisabledServers } from '../../core/policy/routing'
import type { CompiledTriggers, PromptRoute } from '../../core/policy/skill-router'
import { compileTriggers, routePrompt, routeText } from '../../core/policy/skill-router'
import type { ReminderContext, ReminderResult, UsageLedger, WorkspaceFacts } from '../../core/policy/usage'
import { ledgerAudited, reminders, rootCheckText, rootProblem as coreRootProblem, sessionMcpHealth, turnAudit } from '../../core/policy/usage'
import type { WorkspaceInfo } from '../../core/workspace'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import { loadLedger, updateLedger } from '../../workflow/ledger'
import { canonicalDir, codegraphIndexPresent, exclusionContext } from '../../workflow/workspace'
import type { AdapterContext } from '../registry'
import { projectDeps as readProjectDeps } from '../shared/project-deps'
import { HARNESS_REL } from './constants'

const H = 'claude' as const

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function routingPolicy(ctx: AdapterContext): RoutingPolicy {
  const strictness = ctx.config.routing.strictness
  try {
    const cats = ctx.canonical.routing.categories
    return { strictness, categories: Array.isArray(cats) ? cats : [] }
  } catch (e) {
    log('warn', 'claude hook: the canonical routing policy is unavailable', { error: e })
    return { strictness, categories: [] }
  }
}

export function readHealth(nowMs: number = Date.now()): McpHealth {
  const r = readJsonSafeSync<unknown>(paths.healthFile())
  return r.ok ? mcpHealthOf(r.value, nowMs) : {}
}

export function liveHealth(health: McpHealth, cfg: BuracleConfig): McpHealth {
  return cfg.contextMode.enabled ? health : withDisabledServers(health, [CM_SERVER_ID])
}

export function sessionHealth(sid: string, nowMs: number, cfg: BuracleConfig): McpHealth {
  return liveHealth(sessionMcpHealth(readHealth(nowMs), loadLedger(H, sid)), cfg)
}

export function capabilityCardText(ctx: AdapterContext, health: McpHealth = readHealth()): string {
  const live = liveHealth(health, ctx.config)
  const mcp = catalogMcp(ctx.canonical.mcp, H).filter(m => live[m.id] !== 'down')
  const plugins = ctx.canonical.plugins.claude.plugins.filter(x => x.enabled).map(x => x.id)
  const lsp = ctx.canonical.tools.tools.flatMap(t => (t.lsp !== undefined ? [t.lsp.id] : []))
  const policy: RoutingPolicy = { ...ctx.canonical.routing, strictness: ctx.config.routing.strictness }
  return capabilityCard({ policy, mcp, skills: catalogSkills(ctx.canonical.skills), plugins, harness: H, lsp })
}

export function pluginRoot(repoRoot: string, env: (name: string) => string | undefined): string {
  const r = env('CLAUDE_PLUGIN_ROOT')?.trim()
  return r !== undefined && r !== '' ? r : join(repoRoot, HARNESS_REL)
}

export function pluginServers(root: string): string[] | undefined {
  const r = readJsonSafeSync<unknown>(join(root, '.mcp.json'))
  if (!r.ok || !isObj(r.value) || !isObj(r.value['mcpServers'])) return undefined
  return Object.keys(r.value['mcpServers']).sort()
}

export function availableServers(root: string, health: McpHealth, ctx: AdapterContext): string[] {
  const installed = pluginServers(root) ?? catalogMcp(ctx.canonical.mcp, H).map(m => m.id)
  return installed.filter(id => health[id] !== 'down')
}

export function workspacePath(sid: string): string {
  return join(paths.sessionDir(H, sid), 'workspace.json')
}

function isIndexState(x: unknown): boolean {
  return isObj(x) && typeof x['state'] === 'string'
}

export function readWorkspace(sid: string): WorkspaceInfo | undefined {
  const r = readJsonSafeSync<unknown>(workspacePath(sid))
  if (!r.ok || !isObj(r.value)) return undefined
  const v = r.value
  const index = v['index']
  if (typeof v['cwd'] !== 'string' || !Array.isArray(v['children']) || !isObj(index) || !isIndexState(index['codegraph']) || !isIndexState(index['semble'])) return undefined
  return v as unknown as WorkspaceInfo
}

export function saveWorkspace(sid: string, info: WorkspaceInfo): void {
  ensureDirSync(paths.sessionDir(H, sid))
  atomicWriteSync(workspacePath(sid), JSON.stringify(info) + '\n')
}

function rootFacts(info: WorkspaceInfo | undefined, cfg: BuracleConfig): WorkspaceFacts {
  const exclusion = exclusionContext(paths.oldVaultRoot(), cfg.index.exclude)
  const facts: WorkspaceFacts = { home: paths.home(), caseInsensitive: exclusion.caseInsensitive, exclusion, realpath: canonicalDir }
  if (info !== undefined) {
    facts.cwd = info.cwd
    if (info.children.length > 0) facts.children = [...info.children]
    if (info.root !== undefined) facts.root = info.root
  }
  return facts
}

export function workspaceFacts(info: WorkspaceInfo | undefined, cfg: BuracleConfig): WorkspaceFacts {
  const facts: WorkspaceFacts = { ...rootFacts(info, cfg), codegraphIndexed: false }
  if (info?.root !== undefined) facts.codegraphIndexed = cfg.index.codegraph && codegraphIndexPresent(info.root)
  return facts
}

export function rootProblem(value: string, info: WorkspaceInfo | undefined, cfg: BuracleConfig): string | undefined {
  return coreRootProblem(value, rootFacts(info, cfg))
}

export function rootCheck(call: ToolCall, info: WorkspaceInfo | undefined, cfg: BuracleConfig): { deny?: string, context?: string } {
  const server = call.mcp?.server
  if (call.kind !== 'mcp' || (server !== 'semble' && server !== 'codegraph') || cfg.routing.strictness === 'off') return {}
  const key = server === 'semble' ? 'repo' : 'projectPath'
  const value = call.input[key]
  if (typeof value !== 'string') return {}
  const facts = rootFacts(info, cfg)
  const why = coreRootProblem(value, facts)
  if (why === undefined) return {}
  const text = rootCheckText(server, key, value, why, facts)
  return cfg.routing.strictness === 'enforce' ? { deny: text } : { context: `Buracle: ${text}` }
}

export function projectDeps(root: string | undefined): string[] | undefined {
  if (root === undefined) return undefined
  const deps = readProjectDeps(root)
  return deps.length > 0 ? deps : undefined
}

export interface RouterData { compiled: CompiledTriggers; policy: RoutingPolicy }

export function routerData(ctx: AdapterContext): RouterData {
  const strictness = ctx.config.routing.strictness
  const policy: RoutingPolicy = { ...ctx.canonical.routing, strictness, ...(strictness === 'off' ? { categories: [] } : {}) }
  const skills: CatalogSkill[] = catalogSkills(ctx.canonical.skills)
  return { compiled: compileTriggers(skills, policy), policy }
}

export interface PromptRouting {
  route: PromptRoute
  text?: string
}

export function promptRouting(prompt: string, data: RouterData, o: { ledger: UsageLedger, available: readonly string[], deps?: readonly string[], skills: 'router' | 'off', pluginRoot: string }): PromptRouting {
  const opts: Parameters<typeof routePrompt>[2] = { harness: H, loaded: Object.keys(o.ledger.skills), available: o.available }
  if (o.deps !== undefined) opts.deps = o.deps
  let route = routePrompt(prompt, data.compiled, opts)
  if (o.skills === 'off') route = { ...route, load: [], candidates: [] }
  const text = routeText(route, H, data.policy, { triggers: data.compiled, skillFile: id => join(o.pluginRoot, 'skills', id, 'SKILL.md') })
  return text !== undefined ? { route, text } : { route }
}

export function memoryOnlyRouting(signals: { recall: boolean, write: boolean }, available: readonly string[], strictness: RoutingPolicy['strictness']): PromptRouting {
  const route: PromptRoute = { invoked: [], load: [], candidates: [], categories: [], memory: { recall: signals.recall, write: signals.write } }
  if ((signals.recall || signals.write) && !available.includes('buracle-memory')) route.memory.cli = true
  const text = routeText(route, H, { strictness, categories: [] })
  return text !== undefined ? { route, text } : { route }
}

export function usageReminders(sid: string, call: ToolCall, rctx: ReminderContext): Pick<ReminderResult, 'context' | 'deny'> {
  let result: ReminderResult | undefined
  updateLedger(H, sid, l => {
    result = reminders(l, call, rctx)
    return result.next
  })
  const out: Pick<ReminderResult, 'context' | 'deny'> = {}
  if (result?.context !== undefined) out.context = result.context
  if (result?.deny !== undefined) out.deny = result.deny
  return out
}

export function auditTurn(sid: string): string | undefined {
  const verdict = turnAudit(loadLedger(H, sid))
  if (verdict.action !== 'block') return undefined
  let reason: string | undefined
  updateLedger(H, sid, l => {
    const again = turnAudit(l)
    if (again.action !== 'block') return l
    reason = again.reason
    return ledgerAudited(l, again)
  })
  return reason
}

export function permissionPath(sid: string): string {
  return join(paths.sessionDir(H, sid), 'permission.json')
}

export function permissionNotice(sid: string, mode: unknown, cfg: BuracleConfig, now: number): string | undefined {
  if (typeof mode !== 'string' || mode === '' || existsSync(permissionPath(sid))) return undefined
  ensureDirSync(paths.sessionDir(H, sid))
  atomicWriteSync(permissionPath(sid), JSON.stringify({ mode, at: now }) + '\n')
  if (!cfg.permissions.bypass || mode === 'bypassPermissions' || mode === 'plan') return undefined
  const restore = cfg.permissions.enforce
    ? 'run `buracle install` to write bypassPermissions back (permissions.enforce), then start a new session'
    : 'permissions.enforce is off, so Buracle keeps that value; set it back yourself or run `buracle config set permissions.enforce true` and `buracle install`'
  return `Buracle: this session runs in the "${mode}" permission mode, not bypassPermissions (permissions.bypass is on). Claude Code's one-time "make auto mode your default" prompt, /config or its /doctor skill can change ~/.claude/settings.json; ${restore}.`
}

export function lastSessionMode(): { mode: string, at: number, sid: string } | undefined {
  let best: { mode: string, at: number, sid: string } | undefined
  let names: string[]
  try { names = readdirSync(paths.sessionsDir(H)) } catch { return undefined }
  for (const sid of names) {
    if (!paths.isValidSessionId(sid)) continue
    const r = readJsonSafeSync<unknown>(permissionPath(sid))
    if (!r.ok || !isObj(r.value)) continue
    const { mode, at } = r.value
    if (typeof mode === 'string' && typeof at === 'number' && (best === undefined || at > best.at)) best = { mode, at, sid }
  }
  return best
}

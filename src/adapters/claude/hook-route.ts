import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogSkill } from '../../core/catalog'
import { catalogMcp, catalogSkills } from '../../core/catalog'
import type { BuracleConfig } from '../../core/config'
import type { McpHealth, RoutingPolicy } from '../../core/policy/routing'
import { capabilityCard, mcpUnavailable } from '../../core/policy/routing'
import type { CompiledTriggers, PromptRoute } from '../../core/policy/skill-router'
import { compileTriggers, routePrompt, routeText } from '../../core/policy/skill-router'
import type { UsageLedger } from '../../core/policy/usage'
import type { WorkspaceInfo } from '../../core/workspace'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import * as paths from '../../engine/paths'
import type { AdapterContext } from '../registry'
import { projectDeps as readProjectDeps } from '../shared/project-deps'
import { mcpHealth, readMcpHealth, readWorkspace as readSessionWorkspace, routingPolicy, saveWorkspace as saveSessionWorkspace } from '../shared/pipeline/index'
import { HARNESS_REL } from './constants'
import { H, isObj } from './hook-io'

export const readHealth = (nowMs: number = Date.now()): McpHealth => readMcpHealth({ paths }, nowMs)

export function capabilityCardText(ctx: AdapterContext, health: McpHealth = mcpHealth(ctx, H, Date.now())): string {
  const mcp = catalogMcp(ctx.canonical.mcp, H).filter(m => !mcpUnavailable(health[m.id]))
  const lsp = ctx.canonical.tools.tools.flatMap(t => (t.lsp !== undefined ? [t.lsp.id] : []))
  return capabilityCard({ policy: routingPolicy(ctx), mcp, skills: catalogSkills(ctx.canonical.skills), plugins: [], harness: H, lsp })
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
  return installed.filter(id => !mcpUnavailable(health[id]))
}

export const readWorkspace = (sid: string): WorkspaceInfo | undefined => readSessionWorkspace({ paths }, H, sid)
export const saveWorkspace = (sid: string, info: WorkspaceInfo): void => { saveSessionWorkspace({ paths }, H, sid, info) }

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

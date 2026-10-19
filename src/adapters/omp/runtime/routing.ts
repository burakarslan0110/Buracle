import type { CatalogMcp, CatalogSkill } from '../../../core/catalog'
import type { BuracleConfig } from '../../../core/config'
import { CM_SERVER_ID } from '../../../core/context-mode'
import type { ToolCall } from '../../../core/events'
import { cmCall } from '../../../core/policy/sandbox'
import type { McpHealth, RoutingPolicy } from '../../../core/policy/routing'
import type { CompiledTriggers, PromptRoute } from '../../../core/policy/skill-router'
import { compileTriggers, ROUTE_CAPS, routePrompt, routeText } from '../../../core/policy/skill-router'
import type { UsageLedger, WorkspaceFacts } from '../../../core/policy/usage'
import { ledgerMcpResult, rootCheckText, rootProblem as coreRootProblem, sessionMcpHealth } from '../../../core/policy/usage'
import type { WorkspaceInfo } from '../../../core/workspace'
import { projectDeps } from '../../shared/project-deps'

const H = 'omp' as const

export function mergeRoutes(routes: readonly PromptRoute[], compiled: CompiledTriggers): PromptRoute {
  const [first] = routes
  if (first !== undefined && routes.length === 1) return first
  const explicit = (id: string): boolean => compiled.skills.some(s => s.id === id && s.explicit)
  const union = (ids: readonly string[]): string[] => [...new Set(ids)]
  const invoked = union(routes.flatMap(r => r.invoked))
  const asks = union(routes.flatMap(r => r.load)).filter(id => !invoked.includes(id))
  const load = asks.slice(0, ROUTE_CAPS.load)
  const candidates = [...invoked, ...load].some(explicit) ? [] : union([...asks.slice(ROUTE_CAPS.load), ...routes.flatMap(r => r.candidates)])
    .filter(id => !explicit(id) && !invoked.includes(id) && !load.includes(id)).slice(0, ROUTE_CAPS.candidates)
  const categories = union(routes.flatMap(r => r.categories)).slice(0, ROUTE_CAPS.categories)
  const memory: PromptRoute['memory'] = { recall: routes.some(r => r.memory.recall), write: routes.some(r => r.memory.write) }
  if ((memory.recall || memory.write) && routes.some(r => r.memory.cli === true)) memory.cli = true
  const merged: PromptRoute = { invoked, load, candidates, categories, memory }
  const libs = union(routes.flatMap(r => r.libs ?? []))
  if (libs.length > 0 && categories.some(id => compiled.categories.some(c => c.id === id && c.deps !== undefined))) merged.libs = libs.slice(0, 3)
  return merged
}

export function availableServers(mcp: readonly CatalogMcp[], health: McpHealth): string[] {
  return mcp.map(s => s.id).filter(id => health[id] !== 'down')
}

export function isDeviceWrite(toolName: string, input: Record<string, unknown>): boolean {
  const p = input['path']
  return toolName === 'write' && typeof p === 'string' && /^xd:\/\//i.test(p.trim())
}

export interface LedgerAccess { load(sid: string): UsageLedger; update(sid: string, fn: (l: UsageLedger) => UsageLedger): UsageLedger }

export function sessionHealth(health: McpHealth, ledger: LedgerAccess, lsid: string | undefined): McpHealth {
  return lsid === undefined ? health : sessionMcpHealth(health, ledger.load(lsid))
}

export function recordMcpResult(ledger: LedgerAccess, lsid: string, server: string, ok: boolean, tool?: string): void {
  if (ok && ledger.load(lsid).mcpErrors?.[server] === undefined) return
  ledger.update(lsid, l => ledgerMcpResult(l, server, ok, tool))
}

export interface RouterData { compiled: CompiledTriggers; policy: RoutingPolicy }

export function routerData(skills: readonly CatalogSkill[], routing: RoutingPolicy, strictness: RoutingPolicy['strictness']): RouterData {
  const policy: RoutingPolicy = { ...routing, strictness }
  return { compiled: compileTriggers(skills, policy), policy }
}

export interface PromptRouting {
  route: PromptRoute
  text?: string
}

export function promptRouting(prompt: string, data: RouterData, o: { loaded: readonly string[], available: readonly string[], deps?: readonly string[], skills: 'router' | 'off', strictness: RoutingPolicy['strictness'] }): PromptRouting {
  const opts: Parameters<typeof routePrompt>[2] = { harness: H, loaded: o.loaded, available: o.available }
  if (o.deps !== undefined) opts.deps = o.deps
  let route = routePrompt(prompt, data.compiled, opts)
  if (o.skills === 'off') route = { ...route, load: [], candidates: [] }
  if (o.strictness === 'off' && route.categories.length > 0) {
    const { libs: _libs, ...rest } = route
    route = { ...rest, categories: [] }
  }
  const text = routeText(route, H, data.policy, { triggers: data.compiled })
  return text !== undefined ? { route, text } : { route }
}

export interface WorkspaceEnv {
  home: string
  excluded: readonly string[]
  caseInsensitive: boolean
  codegraphIndexed(root: string): boolean
}

export function workspaceFacts(info: WorkspaceInfo | undefined, cfg: Pick<BuracleConfig, 'index'>, env: WorkspaceEnv): WorkspaceFacts {
  const facts: WorkspaceFacts = { home: env.home, excluded: [...env.excluded], caseInsensitive: env.caseInsensitive, codegraphIndexed: false }
  if (info?.root !== undefined) {
    facts.root = info.root
    facts.codegraphIndexed = cfg.index.codegraph && env.codegraphIndexed(info.root)
  }
  return facts
}

export interface RootEnv {
  home: string
  caseInsensitive: boolean
  canonical(path: string): string
  excluded(dir: string): string | undefined
}

function rootFacts(info: WorkspaceInfo | undefined, env: RootEnv): WorkspaceFacts {
  const facts: WorkspaceFacts = { home: env.home, caseInsensitive: env.caseInsensitive, realpath: env.canonical, excludedReason: env.excluded }
  if (info !== undefined) {
    facts.cwd = info.cwd
    if (info.children.length > 0) facts.children = [...info.children]
    if (info.root !== undefined) facts.root = info.root
  }
  return facts
}

export function rootProblem(value: string, info: WorkspaceInfo | undefined, env: RootEnv): string | undefined {
  return coreRootProblem(value, rootFacts(info, env))
}

function rootArgument(call: ToolCall): { server: string, key: string } | undefined {
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  if (server === 'semble') return { server, key: 'repo' }
  if (server === 'codegraph') return { server, key: 'projectPath' }
  return cmCall(call)?.tool === 'ctx_index' ? { server: CM_SERVER_ID, key: 'path' } : undefined
}

export function rootCheck(call: ToolCall, info: WorkspaceInfo | undefined, strictness: RoutingPolicy['strictness'], env: RootEnv): { deny?: string, context?: string } {
  const arg = strictness === 'off' ? undefined : rootArgument(call)
  if (arg === undefined) return {}
  const value = call.input[arg.key]
  if (typeof value !== 'string') return {}
  const facts = rootFacts(info, env)
  const why = coreRootProblem(value, facts)
  if (why === undefined) return {}
  const text = rootCheckText(arg.server, arg.key, value, why, facts)
  return strictness === 'enforce' ? { deny: text } : { context: `Buracle: ${text}` }
}

export function createDepsReader(): (root: string | undefined) => string[] | undefined {
  return root => {
    if (root === undefined || root === '') return undefined
    const deps = projectDeps(root)
    return deps.length > 0 ? deps : undefined
  }
}

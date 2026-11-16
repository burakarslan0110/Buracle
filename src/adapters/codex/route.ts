import type * as CoreNs from '../../core/index'
import type { Harness } from '../../core/events'
import type { BuracleConfig } from '../../core/config'
import type { McpHealth, RoutingPolicy } from '../../core/policy/routing'
import type { PathRuleSource } from '../../core/policy/path-rules'
import type { PromptRoute } from '../../core/policy/skill-router'
import type { UsageLedger } from '../../core/policy/usage'
import type { WorkspaceInfo } from '../../core/workspace'
import { flowViewFor, recordFlowStart } from '../../workflow/flow'
import type { AdapterContext } from '../registry'
import { pathRuleSource } from '../shared/path-rules'
import { readWorkspace, saveWorkspace, workspaceFile as sharedWorkspaceFile } from '../shared/pipeline/index'

export { fitParts, readMcpHealth } from '../shared/pipeline/index'

type CoreFns = typeof CoreNs
const H: Harness = 'codex'

export const workspaceFile = (ctx: Pick<AdapterContext, 'paths'>, sid: string): string => sharedWorkspaceFile(ctx, H, sid)
export const loadWorkspaceInfo = (ctx: Pick<AdapterContext, 'paths'>, sid: string): WorkspaceInfo | undefined => readWorkspace(ctx, H, sid)
export const saveWorkspaceInfo = (ctx: Pick<AdapterContext, 'paths'>, sid: string, info: WorkspaceInfo): void => { saveWorkspace(ctx, H, sid, info) }

export function knownServers(ctx: Pick<AdapterContext, 'canonical'>): string[] {
  try { return Object.keys(ctx.canonical.mcp.servers) } catch { return [] }
}

export function availableServers(ctx: Pick<AdapterContext, 'canonical'>, core: CoreFns, health: McpHealth): string[] {
  return core.catalogMcp(ctx.canonical.mcp, H).filter(m => !core.mcpUnavailable(health[m.id])).map(m => m.id)
}

export function routeUserPrompt(prompt: string, o: { ctx: Pick<AdapterContext, 'canonical' | 'config'>, core: CoreFns, policy: RoutingPolicy, ledger: UsageLedger, available: readonly string[], deps: readonly string[] }): { route: PromptRoute, text?: string } {
  const compiled = o.core.compileTriggers(o.core.catalogSkills(o.ctx.canonical.skills), o.policy)
  let route = o.core.routePrompt(prompt, compiled, { harness: H, loaded: Object.keys(o.ledger.skills), available: o.available, deps: o.deps })
  if (o.ctx.config.routing.strictness === 'off') {
    route = { ...route, categories: [] }
    delete route.libs
  }
  const text = o.core.routeText(route, H, o.policy, { triggers: compiled })
  return text !== undefined ? { route, text } : { route }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function invocationTitle(prompt: string, id: string): string {
  const rest = prompt.replace(new RegExp(`(^|\\s)\\$${escapeRe(id)}(?![\\w-])`), '$1')
  return (rest.split('\n').map(l => l.trim()).find(l => l !== '') ?? '').slice(0, 200)
}

export function workflowStart(route: PromptRoute, prompt: string, core: CoreFns): { workflow: string, title?: string } | undefined {
  const id = route.invoked.find(x => core.flowDef(x) !== undefined)
  if (id === undefined) return undefined
  const title = invocationTitle(prompt, id)
  return title !== '' ? { workflow: id, title } : { workflow: id }
}

export function recordWorkflowStart(sid: string, start: { workflow: string, title?: string }, now: number): boolean {
  return recordFlowStart(H, sid, { ...start, source: 'prompt' }, now)
}

export function resumeNotice(sid: string, now: number, cfg: Pick<BuracleConfig, 'workflow'>, core: CoreFns): { user: string, model: string } | undefined {
  if (!cfg.workflow.band) return undefined
  const view = flowViewFor(H, sid, now)
  const suggestion = core.resumeSuggestion(view)
  if (suggestion === undefined) return undefined
  const summary = core.bandSummary(view)
  return {
    user: `Buracle Stack: this session has an unfinished workflow run (${summary}). To go on, say: ${suggestion}`,
    model: `Buracle Stack: this session has an unfinished workflow run: ${summary}. Continue it only when the user asks.`,
  }
}

export function codexPathRules(ctx: Pick<AdapterContext, 'canonical' | 'paths'>, core: CoreFns): PathRuleSource | undefined {
  try { return pathRuleSource(core.pathRuleIndex(ctx.canonical.rules), ctx.paths.pathRulesDir(), { home: ctx.paths.home() }) } catch { return undefined }
}

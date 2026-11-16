import { join } from 'node:path'
import { catalogMcp, catalogSkills } from '../../core/catalog'
import type { Harness } from '../../core/events'
import { capabilityCard, mcpUnavailable, type McpHealth, type RoutingPolicy } from '../../core/policy/routing'
import { compileTriggers, routePrompt, routeText, type CompiledTriggers, type PromptRoute } from '../../core/policy/skill-router'
import type { UsageLedger } from '../../core/policy/usage'
import type { AdapterContext } from '../registry'
import { mcpHealth, routingPolicy } from './pipeline/index'

// What a command-hook adapter needs for the capability card (H15) and the prompt routing note (H22): the same
// text on every harness, with the harness's own skill and MCP names.

export function capabilityCardText(ctx: AdapterContext, h: Harness, health: McpHealth = mcpHealth(ctx, h, Date.now())): string {
  const mcp = catalogMcp(ctx.canonical.mcp, h).filter(m => !mcpUnavailable(health[m.id]))
  const lsp = ctx.canonical.tools.tools.flatMap(t => (t.lsp !== undefined ? [t.lsp.id] : []))
  return capabilityCard({ policy: routingPolicy(ctx), mcp, plugins: [], harness: h, lsp })
}

/** The Buracle Stack MCP servers of the harness that are not known to be down. */
export function availableServers(ctx: AdapterContext, h: Harness, health: McpHealth): string[] {
  return catalogMcp(ctx.canonical.mcp, h).map(m => m.id).filter(id => !mcpUnavailable(health[id]))
}

export interface PromptRouting { route: PromptRoute, text?: string }

/** The skills and MCP categories a prompt asks for, and the note that tells the model; `skillsDir` is where the harness reads the skills from. */
export function promptRouting(ctx: AdapterContext, h: Harness, prompt: string, o: { ledger: UsageLedger, available: readonly string[], deps?: readonly string[], skillsDir: string }): PromptRouting {
  const strictness = ctx.config.routing.strictness
  const policy: RoutingPolicy = { ...ctx.canonical.routing, strictness, ...(strictness === 'off' ? { categories: [] } : {}) }
  const compiled: CompiledTriggers = compileTriggers(catalogSkills(ctx.canonical.skills), policy)
  const opts: Parameters<typeof routePrompt>[2] = { harness: h, loaded: Object.keys(o.ledger.skills), available: o.available }
  if (o.deps !== undefined) opts.deps = o.deps
  const route = routePrompt(prompt, compiled, opts)
  const text = routeText(route, h, policy, { triggers: compiled, skillFile: id => join(o.skillsDir, id, 'SKILL.md') })
  return text !== undefined ? { route, text } : { route }
}

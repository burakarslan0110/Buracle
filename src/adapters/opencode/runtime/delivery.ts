import { readOnlyStartNotice } from '../../../core/plan/plan-mode'
import type { RoutingPolicy } from '../../../core/policy/routing'
import type { CompiledTriggers, PromptRoute } from '../../../core/policy/skill-router'
import { ROUTE_CAPS, routeText } from '../../../core/policy/skill-router'

export interface PendingPrompt {
  id: string
  delivery: 'steer' | 'queue'
  route?: PromptRoute
  attach: string[]
  guidance?: string
  text?: string
  notice?: string
  workflows?: string[]
  delivered?: boolean
}

export const MAX_PENDING_PROMPTS = 16

export function addPending(queue: PendingPrompt[], p: PendingPrompt): void {
  const i = queue.findIndex(q => q.id === p.id)
  if (i >= 0) queue.splice(i, 1)
  queue.push(p)
  if (queue.length > MAX_PENDING_PROMPTS) queue.splice(0, queue.length - MAX_PENDING_PROMPTS)
}

function messageIds(messages: unknown): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(messages)) return ids
  for (const m of messages) {
    const id = m !== null && typeof m === 'object' ? (m as { id?: unknown }).id : undefined
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  return ids
}

export function takeDelivered(queue: PendingPrompt[], messages: unknown): PendingPrompt[] {
  if (queue.length === 0) return []
  const ids = messageIds(messages)
  const taken: PendingPrompt[] = []
  const rest: PendingPrompt[] = []
  for (const p of queue) (p.delivered === true || ids.has(p.id) || (ids.size === 0 && p.delivery === 'steer') ? taken : rest).push(p)
  if (taken.length > 0) queue.splice(0, queue.length, ...rest)
  return taken
}

export function inboxUpdate(queue: PendingPrompt[], type: string, id: string, delivery?: unknown): void {
  const i = queue.findIndex(q => q.id === id)
  const p = queue[i]
  if (p === undefined) return
  if (type === 'session.inbox.cancelled') queue.splice(i, 1)
  else if (type === 'session.inbox.delivered') p.delivered = true
  else if (type === 'session.inbox.delivery.changed' && (delivery === 'steer' || delivery === 'queue')) p.delivery = delivery
}

export function mergeRoutes(routes: readonly PromptRoute[], compiled: CompiledTriggers): PromptRoute | undefined {
  const [first] = routes
  if (first === undefined || routes.length === 1) return first
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

export function deliveredPrompts(taken: readonly PendingPrompt[], compiled: CompiledTriggers, policy: RoutingPolicy, readOnly = false): { route?: PromptRoute, parts: string[] } {
  const [only] = taken
  const routes = taken.flatMap(p => (p.route !== undefined ? [p.route] : []))
  const route = mergeRoutes(routes, compiled)
  let text = only?.text
  if (taken.length > 1) {
    const attach = [...new Set(taken.flatMap(p => p.attach))]
    text = route !== undefined ? routeText({ ...route, load: [...attach, ...route.load] }, 'opencode', policy, { triggers: compiled, attached: attach }) : undefined
  }
  const parts: string[] = []
  const planMode = readOnly ? taken.flatMap(p => p.workflows ?? []).map(w => readOnlyStartNotice(w, 'opencode')).find(n => n !== undefined) : undefined
  for (const t of [planMode, ...taken.map(p => p.guidance), text, ...taken.map(p => p.notice)]) if (t !== undefined && t.trim() !== '' && !parts.includes(t)) parts.push(t)
  return route !== undefined ? { route, parts } : { parts }
}

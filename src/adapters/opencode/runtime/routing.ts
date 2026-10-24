import type { BuracleConfig } from '../../../core/config'
import type { StopDecision, ToolCall } from '../../../core/events'
import { flowDef } from '../../../core/flow/catalog'
import { promptSignals } from '../../../core/memory/signals'
import type { SpoolEntry } from '../../../core/memory/spool'
import type { McpHealth, RoutingPolicy } from '../../../core/policy/routing'
import type { CompiledTriggers, PromptRoute } from '../../../core/policy/skill-router'
import { compileTriggers, PROMPT_CONTEXT_MAX_CHARS, routePrompt, routeText } from '../../../core/policy/skill-router'
import type { ReminderContext, UsageLedger } from '../../../core/policy/usage'
import { ledgerAudited, ledgerCall, ledgerMcpResult, ledgerPrompt, reminders, sessionMcpHealth, turnAudit } from '../../../core/policy/usage'
import { loadLedger, updateLedger } from '../../../workflow/ledger'
import type { BakedData } from './baked'

const HARNESS = 'opencode' as const

export const COMMAND_MARK = 'buracle.command'
export const COMMAND_ARGS = 'buracle.args'

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function withinBudget(parts: ReadonlyArray<string | undefined>, max = PROMPT_CONTEXT_MAX_CHARS): string[] {
  const out: string[] = []
  let used = 0
  for (const p of parts) {
    if (p === undefined || p.trim() === '') continue
    const size = p.length + (out.length > 0 ? 1 : 0)
    if (out.length > 0 && used + size > max) continue
    out.push(p)
    used += size
  }
  return out
}

export function availableServers(baked: Pick<BakedData, 'mcp'>, health: McpHealth): string[] {
  return baked.mcp.map(m => m.id).filter(id => health[id] !== 'down').sort()
}

const compiledCache = new WeakMap<BakedData, CompiledTriggers>()

export function compiledTriggers(baked: BakedData): CompiledTriggers {
  let c = compiledCache.get(baked)
  if (c === undefined) {
    c = compileTriggers(baked.skills, baked.routing)
    compiledCache.set(baked, c)
  }
  return c
}

export function attachedSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) return []
  const out: string[] = []
  for (const s of skills) {
    const id = s !== null && typeof s === 'object' ? (s as { id?: unknown }).id : undefined
    if (typeof id === 'string' && SKILL_ID.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

export function commandOfPrompt(metadata: Record<string, unknown> | undefined, text: string): { command: string, args: string } | undefined {
  const id = metadata?.[COMMAND_MARK]
  if (typeof id === 'string' && SKILL_ID.test(id)) {
    const args = metadata?.[COMMAND_ARGS]
    return { command: id, args: typeof args === 'string' ? args : '' }
  }
  const m = /(?:^|\n\n)\(?Run this with the Buracle ([a-z0-9][a-z0-9-]*) workflow: [^\n]*$/.exec(text)
  if (m?.[1] === undefined) return undefined
  return { command: m[1], args: text.slice(0, m.index).trim() }
}

export interface PromptRouteInput {
  text: string
  command?: string
  attached: readonly string[]
  loaded: readonly string[]
  available: readonly string[]
  deps?: readonly string[]
  known: ReadonlySet<string> | undefined
}

export interface PromptRouteResult {
  attach: string[]
  text?: string
  route: PromptRoute
  workflows: string[]
}

export function routeInputText(text: string, command: string | undefined): string {
  return command !== undefined ? `/${command}${text.trim() !== '' ? ` ${text.trim()}` : ''}` : text
}

function uniq(xs: readonly string[]): string[] {
  return [...new Set(xs)]
}

export function routeUserPrompt(input: PromptRouteInput, baked: BakedData, cfg: Pick<BuracleConfig, 'routing'>): PromptRouteResult {
  const compiled = compiledTriggers(baked)
  const policy: RoutingPolicy = { ...baked.routing, strictness: cfg.routing.strictness }
  const opts = { harness: HARNESS, loaded: input.loaded, available: input.available, ...(input.deps !== undefined ? { deps: input.deps } : {}) }
  let route = routePrompt(routeInputText(input.text, input.command), compiled, opts)
  const command = input.command
  if (command !== undefined && !input.attached.includes(command)) {
    route = { ...route, invoked: route.invoked.filter(id => id !== command), load: [command] }
  }
  if (cfg.routing.skills === 'off') route = { ...route, load: command !== undefined ? route.load.filter(id => id === command) : [], candidates: [] }
  const invoked = uniq([...route.invoked, ...input.attached])
  const attach = route.load.filter(id => input.known?.has(id) === true && !invoked.includes(id))
  const stored: PromptRoute = { ...route, invoked: uniq([...invoked, ...attach]), load: route.load.filter(id => !attach.includes(id)) }
  const text = routeText({ ...stored, load: [...attach, ...stored.load] }, HARNESS, policy, { triggers: compiled, attached: attach })
  const started = uniq([...(command !== undefined ? [command] : []), ...stored.invoked, ...stored.load])
  const out: PromptRouteResult = { attach, route: stored, workflows: started.filter(id => flowDef(id) !== undefined) }
  if (text !== undefined) out.text = text
  return out
}

export function runTitle(words: string): string | undefined {
  const line = words.split('\n').map(l => l.trim()).find(l => l !== '')
  return line !== undefined && line !== '' ? line : undefined
}

export function promptSignalEntries(text: string, now: number): SpoolEntry[] {
  try { return promptSignals(text).map(signal => ({ ts: now, ev: 'prompt-signal' as const, signal })) } catch { return [] }
}

export interface LedgerStore {
  load(sid: string): UsageLedger
  update(sid: string, fn: (l: UsageLedger) => UsageLedger): UsageLedger
}

export function fileLedgerStore(): LedgerStore {
  return {
    load: sid => loadLedger(HARNESS, sid),
    update: (sid, fn) => updateLedger(HARNESS, sid, fn, { timeoutMs: 250 }),
  }
}

export function ledgerUserPrompt(store: LedgerStore, sid: string, route: PromptRoute, now: number): void {
  try { store.update(sid, l => ledgerPrompt(l, route, now)) } catch {  }
}

export function loadedSkills(store: LedgerStore, sid: string): string[] {
  try { return Object.keys(store.load(sid).skills) } catch { return [] }
}

export interface CallVerdict { deny?: string; context?: string }

export function evaluateCall(store: LedgerStore, sid: string, call: ToolCall, ctx: ReminderContext): CallVerdict {
  const verdict: CallVerdict = {}
  try {
    store.update(sid, l => {
      const r = reminders(l, call, ctx)
      if (r.deny !== undefined) verdict.deny = r.deny.reason
      if (r.context !== undefined) verdict.context = r.context
      return r.next
    })
  } catch {  }
  return verdict
}

export function recordCall(store: LedgerStore, sid: string, call: ToolCall): void {
  try { store.update(sid, l => ledgerCall(l, call)) } catch {  }
}

export function sessionHealth(store: LedgerStore, sid: string, health: McpHealth): McpHealth {
  try { return sessionMcpHealth(health, store.load(sid)) } catch { return health }
}

export function recordMcpResult(store: LedgerStore, sid: string, server: string, ok: boolean): void {
  try {
    if (ok && store.load(sid).mcpErrors?.[server] === undefined) return
    store.update(sid, l => ledgerMcpResult(l, server, ok))
  } catch {  }
}

export function auditTurn(store: LedgerStore, sid: string): StopDecision {
  try {
    const d = turnAudit(store.load(sid))
    if (d.action === 'block') store.update(sid, l => ledgerAudited(l, d))
    return d
  } catch {
    return { action: 'allow' }
  }
}

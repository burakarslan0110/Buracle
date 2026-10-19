import { join } from 'node:path'
import type * as CoreNs from '../../core/index'
import type { Harness, ToolCall } from '../../core/events'
import type { BuracleConfig } from '../../core/config'
import { CM_SERVER_ID } from '../../core/context-mode'
import type { ProfileSignal } from '../../core/memory/profile'
import type { McpHealth, RoutingPolicy } from '../../core/policy/routing'
import { mcpHealthOf } from '../../core/policy/routing'
import type { PathRuleSource } from '../../core/policy/path-rules'
import type { PromptRoute } from '../../core/policy/skill-router'
import type { ReminderResult, UsageLedger, WorkspaceFacts } from '../../core/policy/usage'
import type { WorkspaceInfo } from '../../core/workspace'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import { flowViewFor, recordFlowStart } from '../../workflow/flow'
import { loadLedger, updateLedger } from '../../workflow/ledger'
import { canonicalDir, codegraphIndexPresent, exclusionContext } from '../../workflow/workspace'
import type { AdapterContext } from '../registry'
import { pathRuleSource } from '../shared/path-rules'

type CoreFns = typeof CoreNs
const H: Harness = 'codex'

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function workspaceFile(ctx: Pick<AdapterContext, 'paths'>, sid: string): string {
  return join(ctx.paths.sessionDir(H, sid), 'workspace.json')
}

function isWorkspaceInfo(x: unknown): x is WorkspaceInfo {
  return isObj(x) && typeof x['cwd'] === 'string' && Array.isArray(x['children']) && isObj(x['index'])
    && isObj(x['index']['codegraph']) && isObj(x['index']['semble'])
}

export function loadWorkspaceInfo(ctx: Pick<AdapterContext, 'paths'>, sid: string): WorkspaceInfo | undefined {
  const r = readJsonSafeSync<unknown>(workspaceFile(ctx, sid))
  return r.ok && isWorkspaceInfo(r.value) ? r.value : undefined
}

export function saveWorkspaceInfo(ctx: Pick<AdapterContext, 'paths'>, sid: string, info: WorkspaceInfo): void {
  ensureDirSync(ctx.paths.sessionDir(H, sid))
  atomicWriteSync(workspaceFile(ctx, sid), JSON.stringify(info) + '\n')
}

export function workspaceNoticeFor(ctx: Pick<AdapterContext, 'paths' | 'config'>, sid: string, core: CoreFns, refresh: (info: WorkspaceInfo) => WorkspaceInfo): string | undefined {
  const prev = loadWorkspaceInfo(ctx, sid)
  if (prev === undefined) return undefined
  const next = refresh(prev)
  if (JSON.stringify(next) !== JSON.stringify(prev)) saveWorkspaceInfo(ctx, sid, next)
  return core.workspaceNotice(prev, next)
}

export function readMcpHealth(ctx: Pick<AdapterContext, 'paths'>, nowMs: number = Date.now()): McpHealth {
  const r = readJsonSafeSync<unknown>(ctx.paths.healthFile())
  return r.ok ? mcpHealthOf(r.value, nowMs) : {}
}

export function routingPolicy(ctx: Pick<AdapterContext, 'canonical' | 'config'>): RoutingPolicy {
  return { ...ctx.canonical.routing, strictness: ctx.config.routing.strictness }
}

export function knownServers(ctx: Pick<AdapterContext, 'canonical'>): string[] {
  try { return Object.keys(ctx.canonical.mcp.servers) } catch { return [] }
}

export function fitParts(parts: readonly string[], max: number): string[] {
  const out: string[] = []
  let size = 0
  for (const raw of parts) {
    const part = raw.trim()
    if (part === '') continue
    const add = part.length + (out.length > 0 ? 2 : 0)
    if (out.length > 0 && size + add > max) continue
    out.push(part)
    size += add
  }
  return out
}

export function availableServers(ctx: Pick<AdapterContext, 'canonical'>, core: CoreFns, health: McpHealth): string[] {
  return core.catalogMcp(ctx.canonical.mcp, H).filter(m => health[m.id] !== 'down').map(m => m.id)
}

export function liveHealth(ctx: Pick<AdapterContext, 'config'>, core: CoreFns, health: McpHealth): McpHealth {
  return ctx.config.contextMode?.enabled === false ? core.withDisabledServers(health, [CM_SERVER_ID]) : health
}

export function sessionHealth(ctx: Pick<AdapterContext, 'paths' | 'config'>, core: CoreFns, sid: string, nowMs: number): McpHealth {
  return liveHealth(ctx, core, core.sessionMcpHealth(readMcpHealth(ctx, nowMs), loadLedger(H, sid)))
}

export function recordMcpResult(core: CoreFns, sid: string, server: string, ok: boolean, tool?: string): void {
  if (ok && loadLedger(H, sid).mcpErrors?.[server] === undefined) return
  updateLedger(H, sid, l => core.ledgerMcpResult(l, server, ok, tool))
}

export function workspaceFacts(ctx: Pick<AdapterContext, 'paths' | 'config'>, info: WorkspaceInfo | undefined): WorkspaceFacts {
  const exclusion = exclusionContext(ctx.paths.oldVaultRoot(), ctx.config.index.exclude)
  const facts: WorkspaceFacts = { home: ctx.paths.home(), caseInsensitive: exclusion.caseInsensitive, exclusion, realpath: canonicalDir, codegraphIndexed: false }
  if (info !== undefined) {
    facts.cwd = info.cwd
    if (info.children.length > 0) facts.children = [...info.children]
  }
  if (info?.root !== undefined) {
    facts.root = info.root
    facts.codegraphIndexed = ctx.config.index.codegraph && codegraphIndexPresent(info.root)
  }
  return facts
}

export interface RoutedPrompt { route: PromptRoute; text?: string }

export function routeUserPrompt(prompt: string, o: { ctx: Pick<AdapterContext, 'canonical' | 'config'>, core: CoreFns, policy: RoutingPolicy, ledger: UsageLedger, available: readonly string[], deps: readonly string[] }): RoutedPrompt {
  const compiled = o.core.compileTriggers(o.core.catalogSkills(o.ctx.canonical.skills), o.policy)
  let route = o.core.routePrompt(prompt, compiled, { harness: H, loaded: Object.keys(o.ledger.skills), available: o.available, deps: o.deps })
  if (o.ctx.config.routing.skills === 'off') route = { ...route, load: [], candidates: [] }
  if (o.ctx.config.routing.strictness === 'off') {
    route = { ...route, categories: [] }
    delete route.libs
  }
  const text = o.core.routeText(route, H, o.policy, { triggers: compiled })
  return text !== undefined ? { route, text } : { route }
}

export function recordPrompt(sid: string, route: PromptRoute, now: number, core: CoreFns): void {
  updateLedger(H, sid, l => core.ledgerPrompt(l, route, now))
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
  const view = flowViewFor(H, sid, now, cfg.workflow.foldAfterSec)
  const suggestion = core.resumeSuggestion(view)
  if (suggestion === undefined) return undefined
  const summary = core.bandSummary(view)
  return {
    user: `Buracle: this session has an unfinished workflow run (${summary}). To go on, say: ${suggestion}`,
    model: `Buracle: this session has an unfinished workflow run: ${summary}. Continue it only when the user asks.`,
  }
}

export function promptSignals(prompt: string, invoked: readonly string[], core: CoreFns): ProfileSignal[] {
  const out = core.profileSignalsFromPrompt(prompt)
  for (const id of invoked) {
    const s = core.profileUsageSignal(core.flowDef(id) !== undefined ? 'workflow' : 'skill', id)
    if (s !== undefined && !out.some(o => o.key === s.key)) out.push(s)
  }
  return out
}

export interface UsageVerdict {
  deny?: string
  context?: string
  loaded?: string
}

export function codexPathRules(ctx: Pick<AdapterContext, 'canonical' | 'paths'>, core: CoreFns): PathRuleSource | undefined {
  try { return pathRuleSource(core.pathRuleIndex(ctx.canonical.rules), ctx.paths.pathRulesDir(), { home: ctx.paths.home() }) } catch { return undefined }
}

export function usageReminders(call: ToolCall, sid: string, o: { ctx: Pick<AdapterContext, 'config'>, core: CoreFns, policy: RoutingPolicy, available: readonly string[], facts: WorkspaceFacts, deps: readonly string[], edits?: ReadonlyArray<{ file: string, removed: string, added: string }>, pathRules?: PathRuleSource }): UsageVerdict {
  let result: ReminderResult | undefined
  let loaded: string | undefined
  updateLedger(H, sid, l => {
    const r = o.core.reminders(l, call, {
      strictness: o.ctx.config.routing.strictness, reminders: o.ctx.config.routing.reminders, available: o.available,
      policy: o.policy, facts: o.facts, deps: o.deps, ...(o.edits !== undefined ? { edits: o.edits } : {}),
      ...(o.pathRules !== undefined ? { pathRules: o.pathRules } : {}),
    })
    result = r
    const skill = r.deny === undefined ? o.core.skillOf(call, H) : undefined
    if (skill !== undefined && l.skills[skill] === undefined) loaded = skill
    return r.next
  })
  const out: UsageVerdict = {}
  if (result?.deny !== undefined) out.deny = result.deny.reason
  if (result?.context !== undefined) out.context = result.context
  if (loaded !== undefined) out.loaded = loaded
  return out
}

export function stopAudit(sid: string, core: CoreFns): string | undefined {
  if (core.turnAudit(loadLedger(H, sid)).action !== 'block') return undefined
  let reason: string | undefined
  updateLedger(H, sid, l => {
    const d = core.turnAudit(l)
    if (d.action !== 'block') return l
    reason = d.reason
    return core.ledgerAudited(l, d)
  })
  return reason
}

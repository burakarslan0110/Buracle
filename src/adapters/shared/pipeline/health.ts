import type { Harness } from '../../../core/events'
import { offServersFor, withOffServers } from '../../../core/policy/mcp-off'
import { mcpHealthOf, type McpHealth, type RoutingPolicy } from '../../../core/policy/routing'
import { sessionMcpHealth, type WorkspaceFacts } from '../../../core/policy/usage'
import type { WorkspaceInfo } from '../../../core/workspace'
import { readJsonSafeSync } from '../../../engine/fsx'
import { loadLedger } from '../../../workflow/ledger'
import { canonicalDir, codegraphIndexPresent, exclusionContext } from '../../../workflow/workspace'
import type { AdapterContext } from '../../registry'

export function routingPolicy(ctx: Pick<AdapterContext, 'canonical' | 'config'>): RoutingPolicy {
  return { ...ctx.canonical.routing, strictness: ctx.config.routing.strictness }
}

/** health.json: which MCP servers are up. */
export function readMcpHealth(ctx: Pick<AdapterContext, 'paths'>, nowMs: number = Date.now()): McpHealth {
  const r = readJsonSafeSync<unknown>(ctx.paths.healthFile())
  return r.ok ? mcpHealthOf(r.value, nowMs) : {}
}

/**
 * health.json with the servers that are off folded in (which nothing turns back on): Buracle's `mcp.off.<harness>`
 * and, in `nativeOff`, the harness's own settings. With `sid`, the session's own failures count too. An adapter
 * reads its native settings only for the calls whose route depends on them (web search and fetch, the capability
 * card, the routing note).
 */
export function mcpHealth(ctx: Pick<AdapterContext, 'paths' | 'config'>, h: Harness, nowMs: number, o: { sid?: string, nativeOff?: readonly string[] } = {}): McpHealth {
  const base = readMcpHealth(ctx, nowMs)
  const health = o.sid !== undefined ? sessionMcpHealth(base, loadLedger(h, o.sid)) : base
  return withOffServers(health, [...new Set([...offServersFor(ctx.config, h), ...(o.nativeOff ?? [])])])
}

/** What the root check and the reminders know about the session's workspace. */
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

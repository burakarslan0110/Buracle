import type { McpCatalog, McpServerSpec, ToolSpec } from '../../core/catalog'
import { isPackageServer } from '../../core/catalog'
import * as paths from '../paths'
import { packageKey, type ToolchainState } from '../toolchain/state'
import { liveContext, loadBundle } from './context'
import { opsDeps } from './deps'
import { checkTools, toolHealth } from './doctor'
import { probeServers, writeHealth, type HealthFile } from './mcp'
import { UPDATE_KINDS, writeUpdatesCache, type UpdatesCache } from './updates-cache'
import { checkUpdates, type UpdateEnv } from './updates'

// What the dashboard re-verifies while it is open, so that what it shows was true a short while ago and
// not whenever a command last ran: an MCP server's handshake, a tool's version check, the update check.
export const FRESH_MS = 6 * 3_600_000

export function isFresh(iso: string | undefined, nowMs: number, ttlMs: number = FRESH_MS): boolean {
  const at = iso === undefined ? Number.NaN : Date.parse(iso)
  const age = nowMs - at
  return Number.isFinite(age) && age >= 0 && age < ttlMs
}

// The handshake runs the server the way a harness does. A package that is not in the toolchain would be
// fetched by the package runner for it: a check never downloads, so such a server waits for `buracle install`.
export function canProbe(spec: McpServerSpec, toolchain: Pick<ToolchainState, 'packages'>, shimExists: boolean): boolean {
  if (spec.transport === 'http') return typeof spec.url === 'string'
  if (isPackageServer(spec) && spec.package !== undefined && spec.package.registry !== 'none') {
    return shimExists && toolchain.packages[packageKey(spec.package.registry, spec.package.name)] !== undefined
  }
  return spec.command?.includes('{buracle}') === true ? shimExists : true
}

export function staleServers(catalog: McpCatalog, health: HealthFile | undefined, toolchain: Pick<ToolchainState, 'packages'>, shimExists: boolean, nowMs: number, force: boolean): string[] {
  return Object.keys(catalog.servers).sort().filter(id => {
    const spec = catalog.servers[id]
    if (spec === undefined || !canProbe(spec, toolchain, shimExists)) return false
    const e = health?.mcp[id]
    return force || !(e?.status === 'ok' && isFresh(e.checked_at, nowMs))
  })
}

export function staleTools(tools: readonly ToolSpec[], health: HealthFile | undefined, nowMs: number, force: boolean): ToolSpec[] {
  return tools.filter(t => {
    const e = health?.tools?.[t.name]
    return force || !(e?.status === 'ok' && isFresh(e.checked_at, nowMs))
  })
}

export function updatesStale(cache: Pick<UpdatesCache, 'checked_at'> | undefined, nowMs: number, force: boolean): boolean {
  return force || cache === undefined || !isFresh(cache.checked_at, nowMs)
}

// Each method records its result where `doctor` and `update` record theirs; the caller reads it back.
export interface Verifier {
  mcp(id: string, catalog: McpCatalog): Promise<void>
  tool(tool: ToolSpec): Promise<void>
  updates(): Promise<void>
}

const MCP_TIMEOUT_MS = 30_000

export function liveVerifier(): Verifier {
  const nowIso = () => new Date(opsDeps.now()).toISOString()
  return {
    async mcp(id, catalog) {
      const entries = await probeServers(catalog, { ids: [id], timeoutMs: MCP_TIMEOUT_MS, fetcher: opsDeps.fetch, buracle: paths.shimPath() }, nowIso)
      writeHealth({ mcp: entries }, nowIso())
    },
    async tool(tool) {
      const results = await checkTools([tool])
      writeHealth({ tools: toolHealth(results, nowIso()) }, nowIso())
    },
    async updates() {
      const repoRoot = paths.isFrozenRuntime() ? paths.checkoutRoot() : paths.repoRoot()
      if (repoRoot === undefined) return
      const live = liveContext(repoRoot)
      const loaded = loadBundle(repoRoot)
      const env: UpdateEnv = { repoRoot, config: live.config, adapters: await opsDeps.adapters(), nowMs: opsDeps.now(), ctx: live.ctx }
      if ('bundle' in loaded) env.bundle = loaded.bundle
      const full = await checkUpdates(UPDATE_KINDS, env)
      writeUpdatesCache({ checked_at: new Date(env.nowMs).toISOString(), kinds: [...UPDATE_KINDS], items: full.items, held: full.held, errors: full.errors })
    },
  }
}

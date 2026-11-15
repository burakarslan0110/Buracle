import { join } from 'node:path'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { LIST_IDENTITY_HASH, readLedger } from '../../engine/txn'
import type { AdapterContext } from '../registry'
import { HOOK_GROUP_IDENTITY, OWNER, qwenExcluded, qwenHooks, qwenMcpServers, QWEN_HOOK_EVENTS } from './settings'

export const settingsPath = (ctx: Pick<AdapterContext, 'paths'>): string => join(ctx.paths.qwenHome(), 'settings.json')

/**
 * What the install writes into Qwen's settings.json, and nothing else (the skills are read from ~/.agents/skills):
 * the Buracle hook groups, one `mcpServers` entry per shipped server and the user's `mcp.off.qwen` as `mcp.excluded`.
 * The file is read as JSON with comments, as Qwen Code reads it; the user's own hooks, servers and keys stay.
 */
export async function qwenInstallPlan(ctx: AdapterContext): Promise<Plan> {
  const path = settingsPath(ctx)
  const groups = qwenHooks(ctx.canonical)
  const ops: Op[] = QWEN_HOOK_EVENTS.map((event): Op => ({
    kind: 'json-list-merge', path, pointer: `hooks.${event}`, items: groups[event] ?? [], identity: HOOK_GROUP_IDENTITY, owner: OWNER, format: 'jsonc',
  }))
  const servers = qwenMcpServers(ctx.canonical, ctx.buracleBin)
  const set: Record<string, unknown> = {}
  for (const [id, entry] of Object.entries(servers)) set[`mcpServers.${id}`] = entry
  if (Object.keys(set).length > 0) ops.push({ kind: 'jsonc-merge', path, set, owner: OWNER })
  ops.push({ kind: 'json-list-merge', path, pointer: 'mcp.excluded', items: qwenExcluded(ctx.canonical, ctx.config), identity: LIST_IDENTITY_HASH, owner: OWNER, format: 'jsonc' })
  return { id: 'qwen', harness: 'qwen', ops }
}

/** Everything the ledger records as Buracle's in Qwen's folder goes; a key or file the user changed is kept by the engine. */
export async function qwenUninstallPlan(_ctx: AdapterContext, opts: { ledger?: Ledger } = {}): Promise<Plan> {
  let ledger = opts.ledger
  if (ledger === undefined) {
    try { ledger = await readLedger() } catch { ledger = undefined }
  }
  const keys = Object.entries(ledger ?? {}).filter(([, e]) => e.owner === OWNER).map(([k]) => k).sort()
  return { id: 'qwen-uninstall', harness: 'qwen', ops: keys.map((path): Op => ({ kind: 'remove', path, owner: OWNER })) }
}

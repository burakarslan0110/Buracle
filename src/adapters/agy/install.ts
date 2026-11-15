import { join } from 'node:path'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { readLedger } from '../../engine/txn'
import type { AdapterContext } from '../registry'
import { agyHooks, agyMcpServers, HOOK_NAME, OWNER } from './config'

export const hooksPath = (ctx: Pick<AdapterContext, 'paths'>): string => join(ctx.paths.harnessConfigDir('agy'), 'hooks.json')
export const mcpConfigPath = (ctx: Pick<AdapterContext, 'paths'>): string => join(ctx.paths.harnessConfigDir('agy'), 'mcp_config.json')

/**
 * What the install writes into AGY's folder: the `buracle` hook of hooks.json and one `mcpServers` entry per shipped
 * server in mcp_config.json (a server the user turned off in `mcp.off.agy` is written with `disabled: true`, the
 * flag `agy mcp disable` sets). The skills are links the shared install makes in `skills/`; the user's own hooks and
 * servers are other keys and stay. Buracle is not packaged as an `agy plugin`.
 */
export async function agyInstallPlan(ctx: AdapterContext): Promise<Plan> {
  const ops: Op[] = [{ kind: 'jsonc-merge', path: hooksPath(ctx), set: { [HOOK_NAME]: agyHooks(ctx.canonical) }, owner: OWNER }]
  const set: Record<string, unknown> = {}
  const off = new Set(ctx.config.mcp.off.agy)
  for (const [id, entry] of Object.entries(agyMcpServers(ctx.canonical, ctx.buracleBin))) set[`mcpServers.${id}`] = off.has(id) ? { ...entry, disabled: true } : entry
  if (Object.keys(set).length > 0) ops.push({ kind: 'jsonc-merge', path: mcpConfigPath(ctx), set, owner: OWNER })
  return { id: 'agy', harness: 'agy', ops }
}

/** Everything the ledger records as Buracle's in AGY's folder goes; a key or file the user changed is kept by the engine. */
export async function agyUninstallPlan(_ctx: AdapterContext, opts: { ledger?: Ledger } = {}): Promise<Plan> {
  let ledger = opts.ledger
  if (ledger === undefined) {
    try { ledger = await readLedger() } catch { ledger = undefined }
  }
  const keys = Object.entries(ledger ?? {}).filter(([, e]) => e.owner === OWNER).map(([k]) => k).sort()
  return { id: 'agy-uninstall', harness: 'agy', ops: keys.map((path): Op => ({ kind: 'remove', path, owner: OWNER })) }
}

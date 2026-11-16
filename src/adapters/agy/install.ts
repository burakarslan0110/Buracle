import { dirname, join } from 'node:path'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { readLedger } from '../../engine/txn'
import type { AdapterContext } from '../registry'
import { agyHooks, agyMcpServers, HOOK_NAME, OWNER, STATUS_LINE_VALUE } from './config'
import { agyPluginFiles, packageVersion, PLUGIN_DIR } from './plugin'

export const hooksPath = (ctx: Pick<AdapterContext, 'paths'>): string => join(ctx.paths.harnessConfigDir('agy'), 'hooks.json')
export const mcpConfigPath = (ctx: Pick<AdapterContext, 'paths'>): string => join(ctx.paths.harnessConfigDir('agy'), 'mcp_config.json')

/** The folder of Buracle Stack's plugin (rules and review agents) in the customization root. */
export const pluginPath = (ctx: Pick<AdapterContext, 'paths'>): string => join(ctx.paths.harnessConfigDir('agy'), PLUGIN_DIR)

/** The CLI's own settings file sits beside the customization root (`~/.gemini/antigravity-cli/settings.json`; the root is `~/.gemini/config`). */
export const settingsPath = (ctx: Pick<AdapterContext, 'paths'>): string => join(dirname(ctx.paths.harnessConfigDir('agy')), 'antigravity-cli', 'settings.json')

/**
 * What the install writes into AGY's folder: the `buracle` hook of hooks.json and one `mcpServers` entry per shipped
 * server in mcp_config.json (a server the user turned off in `mcp.off.agy` is written with `disabled: true`, the
 * flag `agy mcp disable` sets), the status line, and the `buracle` plugin folder (the always-on rules, the path rules
 * and the review agents). The skills are links the shared install makes in `skills/`; the user's own hooks and servers
 * are other keys and stay.
 */
export async function agyInstallPlan(ctx: AdapterContext): Promise<Plan> {
  const ops: Op[] = [{ kind: 'jsonc-merge', path: hooksPath(ctx), set: { [HOOK_NAME]: agyHooks(ctx.canonical) }, owner: OWNER }]
  const set: Record<string, unknown> = {}
  const off = new Set(ctx.config.mcp.off.agy)
  for (const [id, entry] of Object.entries(agyMcpServers(ctx.canonical, ctx.buracleBin))) set[`mcpServers.${id}`] = off.has(id) ? { ...entry, disabled: true } : entry
  if (Object.keys(set).length > 0) ops.push({ kind: 'jsonc-merge', path: mcpConfigPath(ctx), set, owner: OWNER })
  // The status line is an extra: a `statusLine` the user set stays (soft).
  ops.push({ kind: 'jsonc-merge', path: settingsPath(ctx), set: { statusLine: { ...STATUS_LINE_VALUE } }, owner: OWNER, soft: ['statusLine'] })
  // Rules and review agents: the files of the `buracle` plugin. A file the user changed is kept by the engine.
  for (const f of agyPluginFiles(ctx.canonical, packageVersion(ctx.repoRoot))) ops.push({ kind: 'file', path: join(pluginPath(ctx), f.path), content: f.content, owner: OWNER })
  return { id: 'agy', harness: 'agy', ops }
}

/** Everything the ledger records as Buracle Stack's in AGY's folder goes; a key or file the user changed is kept by the engine. */
export async function agyUninstallPlan(_ctx: AdapterContext, opts: { ledger?: Ledger } = {}): Promise<Plan> {
  let ledger = opts.ledger
  if (ledger === undefined) {
    try { ledger = await readLedger() } catch { ledger = undefined }
  }
  const keys = Object.entries(ledger ?? {}).filter(([, e]) => e.owner === OWNER).map(([k]) => k).sort()
  return { id: 'agy-uninstall', harness: 'agy', ops: keys.map((path): Op => ({ kind: 'remove', path, owner: OWNER })) }
}

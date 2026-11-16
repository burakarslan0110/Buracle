import { join } from 'node:path'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { LIST_IDENTITY_HASH, readLedger } from '../../engine/txn'
import type { AdapterContext } from '../registry'
import { qwenContentFiles, qwenMemoryBlock, QWEN_BLOCK_ID } from './content'
import { HOOK_GROUP_IDENTITY, OWNER, qwenExcluded, qwenHooks, qwenMcpServers, qwenTipPhrases, QWEN_HOOK_EVENTS, STATUS_LINE_VALUE } from './settings'

export const settingsPath = (ctx: Pick<AdapterContext, 'paths'>): string => join(ctx.paths.qwenHome(), 'settings.json')

/**
 * What the install writes into Qwen's folder (the skills are read from ~/.agents/skills). In settings.json: the Buracle Stack hook groups, one `mcpServers` entry per shipped server and the user's `mcp.off.qwen` as `mcp.excluded`.
 * The file is read as JSON with comments, as Qwen Code reads it; the user's own hooks, servers and keys stay. Besides it: a
 * managed block in QWEN.md (the always-loaded rules and the commands), the path rules in rules/buracle/, the review agents in
 * agents/ and the custom commands in commands/.
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
  // The status line and the tips are extras, so a value the user set stays (soft); the tips join the user's own phrases.
  ops.push({ kind: 'jsonc-merge', path, set: { 'ui.statusLine': { ...STATUS_LINE_VALUE } }, owner: OWNER, soft: ['ui.statusLine'] })
  const tips = qwenTipPhrases(ctx.canonical)
  if (tips.length > 0) ops.push({ kind: 'json-list-merge', path, pointer: 'ui.customWittyPhrases', items: tips, identity: LIST_IDENTITY_HASH, owner: OWNER, format: 'jsonc' })
  ops.push({ kind: 'json-list-merge', path, pointer: 'mcp.excluded', items: qwenExcluded(ctx.canonical, ctx.config), identity: LIST_IDENTITY_HASH, owner: OWNER, format: 'jsonc' })
  ops.push({ kind: 'md-block', path: join(ctx.paths.qwenHome(), 'QWEN.md'), id: QWEN_BLOCK_ID, content: qwenMemoryBlock(ctx.canonical), owner: OWNER })
  for (const f of qwenContentFiles(ctx.canonical)) ops.push({ kind: 'file', path: join(ctx.paths.qwenHome(), f.path), content: f.content, owner: OWNER })
  return { id: 'qwen', harness: 'qwen', ops }
}

/** Everything the ledger records as Buracle Stack's in Qwen's folder goes; a key or file the user changed is kept by the engine. */
export async function qwenUninstallPlan(_ctx: AdapterContext, opts: { ledger?: Ledger } = {}): Promise<Plan> {
  let ledger = opts.ledger
  if (ledger === undefined) {
    try { ledger = await readLedger() } catch { ledger = undefined }
  }
  const keys = Object.entries(ledger ?? {}).filter(([, e]) => e.owner === OWNER).map(([k]) => k).sort()
  return { id: 'qwen-uninstall', harness: 'qwen', ops: keys.map((path): Op => ({ kind: 'remove', path, owner: OWNER })) }
}

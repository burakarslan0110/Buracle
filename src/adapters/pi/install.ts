import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { readLedger } from '../../engine/txn'
import type { AdapterContext } from '../registry'
import { agentDirConflict } from '../shared/agent-dir'
import { EXTENSION_PATH, piMcpServers } from './build'
import { OWNER } from './generated'

export function piMcpFile(agentDir: string): string {
  return join(agentDir, 'mcp.json')
}

export function piExtensionFile(agentDir: string): string {
  return join(agentDir, EXTENSION_PATH)
}

/** The `mcpServers.<id>` keys of Pi's `mcp.json` this install owns. */
export function piMcpSet(ctx: Pick<AdapterContext, 'canonical' | 'config'>): Record<string, unknown> {
  const off = ctx.config?.mcp.off.pi ?? []
  return Object.fromEntries(Object.entries(piMcpServers(ctx.canonical, off)).map(([id, entry]) => [`mcpServers.${id}`, entry]))
}

/**
 * The extension is copied into the agent folder (Pi loads `extensions/*.js` there) and the MCP servers are merged key
 * by key into `mcp.json`, so a server or file the user changed stays as it is. When Pi and Oh My Pi share the folder
 * and Oh My Pi keeps it, nothing is written.
 */
export async function installPlan(ctx: AdapterContext): Promise<Plan> {
  const agentDir = ctx.paths.piAgentDir()
  const built = join(ctx.repoRoot, 'harness', 'pi', EXTENSION_PATH)
  if (!existsSync(built)) throw new Error(`pi: ${built} is not built; run \`buracle build\` first`)
  const conflict = await agentDirConflict(ctx.paths)
  if (conflict?.skipped === 'pi') return { id: 'pi', harness: 'pi', ops: [] }
  const ops: Op[] = [
    { kind: 'file', path: piExtensionFile(agentDir), content: readFileSync(built, 'utf8'), owner: OWNER },
    { kind: 'json-merge', path: piMcpFile(agentDir), set: piMcpSet(ctx), owner: OWNER },
  ]
  return { id: 'pi', harness: 'pi', ops }
}

export async function uninstallPlan(ctx: AdapterContext, opts: { ledger?: Ledger } = {}): Promise<Plan> {
  const agentDir = ctx.paths.piAgentDir()
  let ledger: Ledger | undefined = opts.ledger
  if (ledger === undefined) {
    try { ledger = await readLedger() } catch { ledger = undefined }
  }
  const keys = new Set<string>()
  if (ledger !== undefined) {
    for (const [key, entry] of Object.entries(ledger)) if (entry.owner === OWNER) keys.add(key)
  } else {
    keys.add(piExtensionFile(agentDir))
    for (const key of Object.keys(piMcpSet(ctx))) keys.add(`${piMcpFile(agentDir)}#${key}`)
  }
  return { id: 'pi-uninstall', harness: 'pi', ops: [...keys].sort().map((path): Op => ({ kind: 'remove', path, owner: OWNER })) }
}

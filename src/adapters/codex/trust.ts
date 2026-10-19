import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { ledgerKey } from '../../engine/txn'
import { valueHash } from '../../engine/merge'
import type { AdapterContext } from '../registry'
import { BYPASS_KEYS } from './config'
import { OWNER } from './generate'
import { findBuracleHandlers } from './hooks-config'
import { realPath } from '../../engine/fsx'

export { BYPASS_KEYS }

export function bypassOp(configPath: string, opts: { enforce?: boolean } = {}): Op {
  const keys = { ...BYPASS_KEYS }
  return opts.enforce === true
    ? { kind: 'toml-tables', path: configPath, tables: {}, keys, owner: OWNER, enforce: Object.keys(keys) }
    : { kind: 'toml-tables', path: configPath, tables: {}, keys, owner: OWNER }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function bypassUnitBlocked(configText: string | undefined, ledger: Ledger | undefined, configPath: string): string | undefined {
  let parsed: Record<string, unknown> = {}
  if (configText !== undefined) {
    try { parsed = Bun.TOML.parse(configText) as Record<string, unknown> } catch { return undefined }
  }
  for (const [key, want] of Object.entries(BYPASS_KEYS)) {
    const cur = isObj(parsed) ? parsed[key] : undefined
    const entry = ledger?.[ledgerKey(configPath, key)]
    const buracles = entry !== undefined && entry.owner === OWNER && entry.adopted !== true
    if (cur === undefined) {
      if (buracles) return `${key} was removed from ${configPath} after Buracle set it`
      continue
    }
    if (valueHash(cur) === valueHash(want)) continue
    if (buracles && entry.sha256 === valueHash(cur)) continue
    return `${key} = ${JSON.stringify(cur)} in ${configPath} is the user's`
  }
  return undefined
}

function quoted(seg: string): string {
  return `"${seg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function trustTables(hooksText: string, sourcePaths: readonly string[]): Record<string, Record<string, unknown>> {
  let parsed: unknown
  try { parsed = JSON.parse(hooksText) } catch { return {} }
  const tables: Record<string, Record<string, unknown>> = {}
  for (const src of [...new Set(sourcePaths)]) {
    for (const h of findBuracleHandlers(parsed, src)) {
      if (h.hash === undefined) continue
      tables[`hooks.state.${quoted(h.key)}`] = { trusted_hash: h.hash }
    }
  }
  return tables
}

function real(p: string): string {
  try { return realPath(p) } catch { return p }
}

export function codexTrustPlan(ctx: Pick<AdapterContext, 'paths' | 'config'>): Plan | undefined {
  if (!ctx.config.permissions.bypass) return undefined
  const home = ctx.paths.codexHome()
  const hooksPath = join(home, 'hooks.json')
  let text: string
  try { text = readFileSync(hooksPath, 'utf8') } catch { return undefined }
  const tables = trustTables(text, [hooksPath, real(hooksPath)])
  const names = Object.keys(tables).sort()
  if (names.length === 0) return undefined
  const configPath = join(home, 'config.toml')
  const enforce = ctx.config.permissions.enforce === true
  const ops: Op[] = names.map(name => ({
    kind: 'toml-tables', path: configPath, tables: { [name]: tables[name] as Record<string, unknown> }, owner: OWNER, ignore: { [name]: ['enabled'] },
    ...(enforce ? { enforce: [name] } : {}),
  }))
  return { id: 'codex-trust', harness: 'codex', ops }
}

import { tipsFor } from '../shared/tip-text'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalBundle, CatalogMcp } from '../../core/catalog'
import { catalogMcp, catalogSkills } from '../../core/catalog'
import { MIN_VERSIONS } from '../../engine/update/min-versions'
import type { StatusLayout } from '../../core/status/model'
import type { PiGenerated } from './runtime/types'

export const PI_MIN_VERSION = MIN_VERSIONS.pi
export const OWNER = 'pi'

/** The canonical servers that ship to Pi. */
export function piMcpServerIds(canonical: CanonicalBundle): string[] {
  return Object.keys(canonical.mcp.servers).sort().filter(id => canonical.mcp.servers[id]?.harnesses.includes('pi') === true)
}

export function buracleVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** The footer entries and the layout they render by, from the `native.setStatus` of the pi entry of statusline.yaml. */
export function piStatusData(layout: StatusLayout | undefined): PiGenerated['status'] {
  const keys = layout?.native?.setStatus
  if (layout === undefined || keys === undefined || typeof keys !== 'object') return undefined
  const setStatus: Record<string, string[]> = {}
  for (const key of Object.keys(keys).sort()) {
    const ids = keys[key]
    if (/^[A-Za-z0-9._-]+$/.test(key) && Array.isArray(ids)) setStatus[key] = ids.filter((i): i is string => typeof i === 'string')
  }
  if (Object.keys(setStatus).length === 0) return undefined
  return { layout: { rows: layout.rows, thresholds: layout.thresholds, emoji: layout.emoji === true }, setStatus }
}

export function piGeneratedData(canonical: CanonicalBundle, version: string): PiGenerated {
  const ids = new Set(piMcpServerIds(canonical))
  const mcp: CatalogMcp[] = catalogMcp(canonical.mcp, 'pi').filter(s => ids.has(s.id))
  const out: PiGenerated = {
    v: 1, buracleVersion: version, config: canonical.config, routing: canonical.routing, mcp,
    mcpIds: Object.keys(canonical.mcp.servers).sort(), skills: catalogSkills(canonical.skills),
  }
  const tips = tipsFor(canonical, 'pi')
  if (tips.length > 0) out.tips = tips
  const status = piStatusData(canonical.statusline.pi)
  if (status !== undefined) out.status = status
  if ((canonical.notices ?? []).length > 0) out.notices = (canonical.notices ?? []).map(n => ({ ...n }))
  return out
}

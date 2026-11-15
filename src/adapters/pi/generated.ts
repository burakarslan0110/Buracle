import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalBundle, CatalogMcp } from '../../core/catalog'
import { catalogMcp, catalogSkills } from '../../core/catalog'
import { MIN_VERSIONS } from '../../engine/update/min-versions'
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

export function piGeneratedData(canonical: CanonicalBundle, version: string): PiGenerated {
  const ids = new Set(piMcpServerIds(canonical))
  const mcp: CatalogMcp[] = catalogMcp(canonical.mcp, 'pi').filter(s => ids.has(s.id))
  const out: PiGenerated = {
    v: 1, buracleVersion: version, config: canonical.config, routing: canonical.routing, mcp,
    mcpIds: Object.keys(canonical.mcp.servers).sort(), skills: catalogSkills(canonical.skills),
  }
  if ((canonical.notices ?? []).length > 0) out.notices = (canonical.notices ?? []).map(n => ({ ...n }))
  return out
}

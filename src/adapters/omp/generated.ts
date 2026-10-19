import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalBundle, CatalogMcp } from '../../core/catalog'
import { catalogMcp, catalogSkills } from '../../core/catalog'
import type { BuracleConfig } from '../../core/config'
import { resolveEffort } from '../../core/effort'
import { TESTED_WITH } from '../../engine/update/tested-with'
import { OMP_BUILTIN_COMMANDS, OMP_UTILITY_COMMANDS } from './runtime/commands'
import type { OmpGenerated } from './runtime/types'
import { ompStatusData } from './statusline'

export const PACKAGE_NAME = 'buracle-omp'
export const OMP_TESTED_WITH = TESTED_WITH.omp.tested
export const OMP_MIN_VERSION = TESTED_WITH.omp.min
export const BUN_MIN_VERSION = '1.3.14'
export const OWNER = 'omp'

export function ompMcpServerIds(canonical: CanonicalBundle): string[] {
  return Object.keys(canonical.mcp.servers).sort().filter(id => {
    const s = canonical.mcp.servers[id]
    return s !== undefined && s.harnesses.includes('omp') && !s.routing.includes('browser')
  })
}

export const OMP_BUILTIN_LSP: ReadonlySet<string> = new Set(['gopls', 'jdtls', 'pyright', 'rust-analyzer', 'typescript'])

export function ompLspServers(canonical: CanonicalBundle): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  const tools = [...canonical.tools.tools].filter(t => t.lsp !== undefined && !OMP_BUILTIN_LSP.has(t.lsp.id)).sort((a, b) => ((a.lsp?.id ?? '') < (b.lsp?.id ?? '') ? -1 : 1))
  for (const t of tools) {
    const s = t.lsp
    if (s === undefined) continue
    const languages = [...new Set(Object.values(s.extensions))]
    out[s.id] = {
      command: s.bin ?? (t.bins ?? [t.name])[0] ?? t.name,
      args: [...(s.args ?? [])],
      fileTypes: Object.keys(s.extensions).sort(),
      rootMarkers: [...new Set([...(s.root_markers ?? []), '.git'])],
      ...(languages.length === 1 ? { languageId: languages[0] } : {}),
      ...(s.startup_timeout_ms !== undefined ? { warmupTimeoutMs: s.startup_timeout_ms } : {}),
    }
  }
  return out
}

export function ompCommandSkills(canonical: CanonicalBundle): string[] {
  return catalogSkills(canonical.skills)
    .filter(s => s.userInvocable && !OMP_BUILTIN_COMMANDS.has(s.id) && !OMP_UTILITY_COMMANDS.includes(s.id))
    .map(s => s.id)
}

export const OMP_THINKING_LEVELS: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']

export function ompThinkingLevel(config: Pick<BuracleConfig, 'effort'> | undefined): { level: string } | { keep: true } | { invalid: string } {
  const raw = config?.effort?.omp
  const r = resolveEffort('omp', typeof raw === 'string' ? raw : 'auto')
  if ('off' in r) return { keep: true }
  if ('invalid' in r) return { invalid: r.invalid }
  if (!OMP_THINKING_LEVELS.includes(r.level)) {
    return { invalid: `omp does not keep '${r.level}' as defaultThinkingLevel (it accepts ${OMP_THINKING_LEVELS.join(', ')}); set effort.omp to one of those, or keep` }
  }
  return { level: r.level }
}

export function buracleVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function ompGeneratedData(canonical: CanonicalBundle, version: string): OmpGenerated {
  const ids = new Set(ompMcpServerIds(canonical))
  const mcp: CatalogMcp[] = catalogMcp(canonical.mcp, 'omp').filter(s => ids.has(s.id))
  const out: OmpGenerated = {
    v: 1,
    buracleVersion: version,
    testedWith: OMP_TESTED_WITH,
    minOmp: OMP_MIN_VERSION,
    config: canonical.config,
    routing: canonical.routing,
    mcp,
    mcpIds: Object.keys(canonical.mcp.servers).sort(),
    skills: catalogSkills(canonical.skills),
    plugins: canonical.plugins.omp.plugins.filter(p => p.enabled).map(p => p.id).sort(),
    commands: ompCommandSkills(canonical),
    status: ompStatusData(canonical.statusline.omp),
  }
  if ((canonical.notices ?? []).length > 0) out.notices = (canonical.notices ?? []).map(n => ({ ...n }))
  return out
}

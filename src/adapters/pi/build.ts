import type { CanonicalBundle, McpServerSpec } from '../../core/catalog'
import type { AdapterContext } from '../registry'
import { familyMcpEntry } from '../shared/pi-family/mcp'
import { stableJson } from '../omp/render'
import { bundleExtension } from './bundle'
import { buracleVersion, PI_MIN_VERSION, piGeneratedData, piMcpServerIds } from './generated'

export interface BuildFile { path: string, content: string, mode?: number }

export const EXTENSION_PATH = 'extensions/buracle.js'

/** Pi's `timeout` is in seconds. */
export function piMcpEntry(id: string, spec: McpServerSpec): Record<string, unknown> {
  return familyMcpEntry(id, spec, 'pi', 1, { BURACLE_HARNESS: 'pi' })
}

/** The `mcpServers` Buracle puts in Pi's `mcp.json`; a server that is off for Pi (`mcp.off.pi`) stays listed with `enabled: false`. */
export function piMcpServers(canonical: CanonicalBundle, off: readonly string[] = []): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {}
  for (const id of piMcpServerIds(canonical)) {
    const spec = canonical.mcp.servers[id]
    if (spec !== undefined) servers[id] = { ...piMcpEntry(id, spec), ...(off.includes(id) ? { enabled: false } : {}) }
  }
  return servers
}

function readme(canonical: CanonicalBundle): string {
  const servers = piMcpServerIds(canonical).map(id => `\`${id}\``).join(', ')
  return [
    '# buracle-pi',
    '',
    "Buracle's files for Pi. `buracle build` **generates** this directory from `canonical/` and `src/adapters/pi/`; do not edit it by hand.",
    '',
    `- \`${EXTENSION_PATH}\`: the extension, one file (src/core plus the Pi runtime). \`buracle install pi\` copies it to \`<agent dir>/${EXTENSION_PATH}\`. It runs the tool guards, consent, routing, the stop guard, prompt routing, the session context and the memory capture through the shared hook pipeline.`,
    `- \`mcp.json\`: the MCP servers \`buracle install pi\` merges into Pi's own \`mcp.json\`: ${servers}.`,
    '',
    `Needs Pi ${PI_MIN_VERSION} or newer. Skills are not in this folder: Pi reads \`~/.agents/skills\` itself. \`buracle doctor pi\` checks the version, the extension and the MCP entries.`,
    '',
  ].join('\n')
}

export async function buildPi(ctx: AdapterContext): Promise<BuildFile[]> {
  const canonical = ctx.canonical
  const version = buracleVersion(ctx.repoRoot)
  return [
    { path: EXTENSION_PATH, content: await bundleExtension(ctx.repoRoot, piGeneratedData(canonical, version)) },
    { path: 'mcp.json', content: stableJson({ mcpServers: piMcpServers(canonical) }) + '\n' },
    { path: 'README.md', content: readme(canonical) },
  ]
}

import type { CanonicalBundle, McpServerSpec } from '../../core/catalog'
import type { AdapterContext } from '../registry'
import { renderMarkdown } from '../shared/render'
import { pathRulesPointer } from '../shared/rules'
import { familyMcpEntry } from '../shared/pi-family/mcp'
import { stableJson } from '../omp/render'
import { bundleExtension } from './bundle'
import { PI_BRAIN_COMMAND, PI_REMEMBER_COMMAND } from './runtime/commands'
import { buracleVersion, PI_MIN_VERSION, piGeneratedData, piMcpServerIds } from './generated'

export interface BuildFile { path: string, content: string, mode?: number }

export const EXTENSION_PATH = 'extensions/buracle.js'

/** Pi's `timeout` is in seconds. */
export function piMcpEntry(id: string, spec: McpServerSpec): Record<string, unknown> {
  return familyMcpEntry(id, spec, 'pi', 1, { BURACLE_HARNESS: 'pi' })
}

/** The `mcpServers` Buracle Stack puts in Pi's `mcp.json`; a server that is off for Pi (`mcp.off.pi`) stays listed with `enabled: false`. */
export function piMcpServers(canonical: CanonicalBundle, off: readonly string[] = []): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {}
  for (const id of piMcpServerIds(canonical)) {
    const spec = canonical.mcp.servers[id]
    if (spec !== undefined) servers[id] = { ...piMcpEntry(id, spec), ...(off.includes(id) ? { enabled: false } : {}) }
  }
  return servers
}

export const AGENTS_BLOCK_ID = 'pi'

/**
 * The block Buracle Stack keeps in `<agent dir>/AGENTS.md`, which Pi loads as user instructions (docs/configuration.md): the
 * always-loaded rules, the two commands of the extension and, for the path rules (Pi cannot scope a rule to paths), the
 * line that says the first edit of a matching file hands the rule over.
 */
export function piAgentsBlock(canonical: Pick<CanonicalBundle, 'rules' | 'skills' | 'agents'>, pathRulesDir: string, warnings: string[] = []): string {
  const refs = { skills: canonical.skills.map(s => s.id), agents: canonical.agents.map(a => a.id) }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const parts = ['_Managed by Buracle Stack (`buracle install`). The source is `canonical/rules/` in the Buracle Stack repo; edits inside this block stop future updates of it._']
  for (const r of canonical.rules.filter(r => r.scope === 'always').sort(byId)) parts.push(renderMarkdown(r.body, 'pi', { ...refs, file: r.file }, warnings).trim())
  parts.push(`Pi commands from Buracle Stack: \`/${PI_REMEMBER_COMMAND} <text>\` saves a memory note and \`/${PI_BRAIN_COMMAND} [review]\` opens the Buracle Stack Console.`)
  const pointer = pathRulesPointer(canonical.rules.filter(r => r.scope === 'paths').sort(byId).map(r => r.id), pathRulesDir)
  if (pointer !== undefined) parts.push(pointer)
  return parts.join('\n\n') + '\n'
}

function readme(canonical: CanonicalBundle): string {
  const servers = piMcpServerIds(canonical).map(id => `\`${id}\``).join(', ')
  return [
    '# buracle-pi',
    '',
    "Buracle Stack's files for Pi. `buracle build` **generates** this directory from `canonical/` and `src/adapters/pi/`; do not edit it by hand.",
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

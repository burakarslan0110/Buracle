import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentDoc, CanonicalBundle, RuleDoc, SkillDoc } from '../../core/catalog'
import { resolveAgents } from '../shared/agents'
import { renderMarkdown } from '../shared/render'
import { pathGlobs } from '../shared/rules'
import { oneLine } from '../shared/skills'

/**
 * Rules and review agents reach AGY CLI as one plugin of its global customization root,
 * `<config>/plugins/buracle/` (`agy plugin list` shows it with its agents and rules). A plugin is the one place the
 * program documents for both: `rules/` takes Markdown rules, `agents/<name>.md` takes custom agents. Disabling or
 * removing the folder takes all of it out at once.
 */
export const PLUGIN_DIR = 'plugins/buracle'
export interface PluginFile { path: string, content: string }

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)

/** `plugin.json` accepts only name, displayName, description, version and a few more; unknown keys are dropped. */
export function pluginManifest(version: string): PluginFile {
  const manifest = {
    name: 'buracle',
    displayName: 'Buracle',
    version,
    description: 'Buracle: always-on rules, path rules and review agents. Written by `buracle install`; edits are overwritten.',
  }
  return { path: 'plugin.json', content: JSON.stringify(manifest, null, 2) + '\n' }
}

/** The version of the checkout, so the manifest names what wrote it. */
export function packageVersion(repoRoot: string): string {
  try {
    const v = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' && v !== '' ? v : '0.0.0'
  } catch { return '0.0.0' }
}

function slashForms(skills: readonly SkillDoc[]): string[] {
  return skills
    .filter(s => s.frontmatter['invocation'] === 'explicit' && s.frontmatter['user-invocable'] !== false)
    .map(s => s.id).sort().map(id => `\`/${id}\``)
}

/**
 * AGY runs a skill with `/<id>`, which is a model turn: its custom commands are skills. The utility commands of the
 * in-process hosts (`/brain`, `/remember`, `/aside`, `/buracle-status`) have no such form, so the rules name their CLI twins.
 */
export function agyCommandsSection(skills: readonly SkillDoc[]): string {
  const forms = slashForms(skills)
  return [
    '# Buracle commands in AGY CLI',
    '',
    `A workflow or a skill starts with \`/<id>\`${forms.length > 0 ? ` (${forms.join(', ')})` : ''}. AGY has no custom command that runs without a model turn, so when the user asks for one of these, run it yourself:`,
    '- `/remember <text>`: `buracle mem remember -- "<text>"`; a typed memory follows the `memory` skill.',
    '- `/brain`: `buracle mem ui --open`; `/brain review`: `buracle mem ui --open --page review`.',
    '- `/buracle-status`: `buracle plan status --json` and `buracle mem status`.',
    '- `/aside <question>`: answer it briefly and read-only, then go back to the task.',
  ].join('\n')
}

/** The always-loaded rules as the plugin's one `rules/AGENTS.md` (plain Markdown with no frontmatter, always on). */
export function agyAlwaysRules(c: Pick<CanonicalBundle, 'rules' | 'skills' | 'agents'>, warnings: string[] = []): PluginFile {
  const refs = { skills: c.skills.map(s => s.id), agents: c.agents.map(a => a.id) }
  const always = c.rules.filter(r => r.scope === 'always').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const parts = ['_Managed by Buracle (`buracle install`). The source is `canonical/rules/` in the Buracle repo; edits here are overwritten._']
  for (const r of always) parts.push(renderMarkdown(r.body, 'agy', { ...refs, file: r.file }, warnings).trim())
  parts.push(agyCommandsSection(c.skills))
  return { path: 'rules/AGENTS.md', content: parts.join('\n\n') + '\n' }
}

/**
 * A path rule is a rule file with `trigger: glob`; `globs` is one comma-separated string matched against file paths
 * (the format the program's own migration guide writes). AGY applies it when a matching file is in play, so Buracle's
 * first-edit hint is not needed here.
 */
export function agyPathRule(rule: RuleDoc, refs: { skills?: readonly string[], agents?: readonly string[] }, warnings: string[] = []): PluginFile {
  const globs = pathGlobs(rule)
  const title = /^#\s+(.+)$/m.exec(rule.body)?.[1]?.trim() ?? rule.id
  const fm = ['---', 'trigger: glob', `globs: ${JSON.stringify(globs.join(', '))}`, `description: ${JSON.stringify(`Buracle path rule: ${title}`)}`, '---', ''].join('\n')
  const body = renderMarkdown(rule.body, 'agy', { ...refs, file: rule.file }, warnings).trim()
  return { path: `rules/buracle-${rule.id}.md`, content: fm + body + '\n' }
}

// The native tool names of an agent's `tools` list, as the program's migration guide maps Claude Code's grants onto them.
const AGENT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  read: ['read_file'],
  search: ['read_file'],
  bash: ['run_command', 'manage_task'],
  'bash-readonly': ['run_command', 'manage_task'],
  edit: ['edit_file'],
  write: ['write_file'],
  web: ['search_web'],
  'web-search': ['search_web'],
}
const WRITE_TOOLS = new Set(['edit_file', 'write_file'])

export function agyAgentTools(agent: AgentDoc): string[] {
  const raw = agent.frontmatter['tools']
  const abstract = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : []
  const readOnly = agent.frontmatter['access'] !== 'read-write'
  const out: string[] = []
  for (const t of abstract) {
    for (const name of AGENT_TOOLS[t] ?? []) {
      if (readOnly && WRITE_TOOLS.has(name)) continue
      if (!out.includes(name)) out.push(name)
    }
  }
  if (!out.includes('read_file')) out.unshift('read_file')
  return out
}

/** An agent that lists `mcp:<server>` tools gets the MCP servers of its parent (`inheritMcp`). */
const wantsMcp = (agent: AgentDoc): boolean => Array.isArray(agent.frontmatter['tools']) && (agent.frontmatter['tools'] as unknown[]).some(t => typeof t === 'string' && t.startsWith('mcp:'))

export function agyAgent(agent: AgentDoc, refs: { skills?: readonly string[], agents?: readonly string[] }, warnings: string[] = []): PluginFile {
  const name = asString(agent.frontmatter['name']) ?? agent.id
  const description = oneLine(asString(agent.frontmatter['description']) ?? name)
  if (asString(agent.frontmatter['description']) === undefined) warnings.push(`agents/${agent.id}.md: description is empty`)
  const fm = [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    'subagent: true',
    'mainAgent: false',
    `tools: [${agyAgentTools(agent).join(', ')}]`,
    ...(wantsMcp(agent) ? ['inheritMcp: true'] : []),
    '---',
    '',
  ].join('\n')
  const body = renderMarkdown(agent.body, 'agy', { ...refs, file: agent.file }, warnings).trim()
  return { path: `agents/${agent.id}.md`, content: fm + body + '\n' }
}

/** The agent a second-opinion run starts with (`agy -p … --agent buracle-companion`). */
export const AGY_COMPANION_AGENT = 'buracle-companion'

/**
 * The second-opinion agent: a main agent whose only tool is `read_file` (no shell, no edit, no write, no web) and which
 * inherits no MCP servers, so a run that selects it can look at the repository and nothing else.
 */
export function agyCompanionAgent(): PluginFile {
  const fm = [
    '---',
    `name: ${JSON.stringify(AGY_COMPANION_AGENT)}`,
    `description: ${JSON.stringify("Buracle's read-only second-opinion reviewer: reads the repository and answers with one review report.")}`,
    'subagent: false',
    'mainAgent: true',
    'tools: [read_file]',
    'inheritMcp: false',
    '---',
    '',
  ].join('\n')
  const body = "You are Buracle's second-opinion reviewer. Follow the review instructions in the message. You are read-only: never edit, create or delete a file, and run no command."
  return { path: `agents/${AGY_COMPANION_AGENT}.md`, content: fm + body + '\n' }
}

/** Every file of the plugin, relative to its folder, in a stable order. */
export function agyPluginFiles(canonical: CanonicalBundle, version: string, warnings: string[] = []): PluginFile[] {
  const refs = { skills: canonical.skills.map(s => s.id), agents: canonical.agents.map(a => a.id) }
  const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const files: PluginFile[] = [pluginManifest(version), agyAlwaysRules(canonical, warnings)]
  for (const r of canonical.rules.filter(x => x.scope === 'paths').sort(byId)) files.push(agyPathRule(r, refs, warnings))
  for (const a of resolveAgents(canonical).sort(byId)) files.push(agyAgent(a, refs, warnings))
  files.push(agyCompanionAgent())
  return files
}

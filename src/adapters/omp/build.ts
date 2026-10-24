import type { AgentDoc, CanonicalBundle, McpServerSpec, RuleDoc, SkillDoc } from '../../core/catalog'
import { envRef, expandMcpCommand, mcpEnvFor } from '../../core/catalog'
import type { AdapterContext } from '../registry'
import { bundleExtension } from './bundle'
import { buracleVersion, ompCommandSkills, ompGeneratedData, ompMcpServerIds, OMP_MIN_VERSION, OMP_TESTED_WITH, PACKAGE_NAME } from './generated'
import { firstHeading, frontmatter, oneLine, renderForOmp, withFinalNewline } from './render'
import { OMP_ASIDE_COMMAND, OMP_PING_COMMAND, OMP_STATUS_ALIAS, OMP_STATUS_COMMAND, PING_ANSWER } from './runtime/commands'
import { FLOW_WIDGET_KEY } from './runtime/flow-widget'
import { workflowCommandBody } from './runtime/flow-track'

export interface BuildFile { path: string; content: string; mode?: number }

export const MCP_SCHEMA_URL = 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json'
export const MCP_BURACLE_SHIM = '{buracle}'
export const MCP_SHIM_SCRIPT = 'exec "${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" "$@"'
export function mcpShimArgv(args: readonly string[]): { command: string, args: string[] } {
  return { command: '/bin/sh', args: ['-c', MCP_SHIM_SCRIPT, 'buracle', ...args] }
}
export const EXTENSION_PATH = 'extensions/buracle.js'

export function isOmpFileGlob(token: string): boolean {
  const t = token.trim()
  if (t === '' || /[\\^$+|()]/.test(t) || !/[?*[\]{}]/.test(t)) return false
  return t.includes('/') || /^\*\.[^\s/]+$/.test(t)
}

function ruleGlobs(rule: RuleDoc): string[] {
  const raw = rule.frontmatter['paths']
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  return list.filter((g): g is string => typeof g === 'string' && g.trim() !== '').map(g => g.trim())
}

export function renderRule(rule: RuleDoc): BuildFile {
  const body = withFinalNewline(renderForOmp(rule.body).trim())
  const title = firstHeading(rule.body) ?? rule.id
  if (rule.scope === 'always') {
    const fm = frontmatter([
      ['description', `Buracle always-on rule: ${title}`],
      ['alwaysApply', true],
    ])
    return { path: `rules/buracle-${rule.id}.md`, content: fm + body }
  }
  const globs = ruleGlobs(rule)
  const shorthand = globs.filter(isOmpFileGlob)
  const explicit = globs.filter(g => !isOmpFileGlob(g) && !g.includes(')'))
  const scope = explicit.flatMap(g => [`tool:edit(${g})`, `tool:write(${g})`])
  const fm = frontmatter([
    ['description', `Buracle path rule: ${title} (injected when editing or writing matching files)`],
    ['condition', [...shorthand, ...(scope.length > 0 && shorthand.length === 0 ? ['.*'] : [])]],
    ['scope', scope.length > 0 ? scope : undefined],
  ])
  return { path: `rules/buracle-${rule.id}.md`, content: fm + body }
}

const AGENT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  read: ['read'],
  search: ['grep', 'glob', 'find', 'ast_grep'],
  'bash-readonly': ['bash'],
  bash: ['bash'],
  edit: ['edit'],
  write: ['write'],
  web: ['web_search'],
  'web-search': ['web_search'],
}
const WRITE_TOOLS = new Set(['edit', 'write'])

export function ompAgentTools(agent: AgentDoc): string[] {
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
  if (!out.includes('read')) out.unshift('read')
  return out
}

function agentModel(agent: AgentDoc): string | undefined {
  const m = agent.frontmatter['model']
  const v = m !== null && typeof m === 'object' ? (m as Record<string, unknown>)['omp'] : m
  return typeof v === 'string' && v !== '' && v !== 'inherit' ? v : undefined
}

export function renderAgent(agent: AgentDoc): BuildFile {
  const name = typeof agent.frontmatter['name'] === 'string' ? agent.frontmatter['name'] : agent.id
  const description = oneLine(typeof agent.frontmatter['description'] === 'string' ? agent.frontmatter['description'] : name)
  const fm = frontmatter([
    ['name', name],
    ['description', description],
    ['tools', ompAgentTools(agent)],
    ['model', agentModel(agent)],
    ['blocking', true],
  ])
  return { path: `agents/${agent.id}.md`, content: fm + withFinalNewline(renderForOmp(agent.body).trim()) }
}

function str(skill: SkillDoc, key: string): string | undefined {
  const v = skill.frontmatter[key]
  return typeof v === 'string' && v.trim() !== '' ? oneLine(v) : undefined
}

export function renderCommand(skill: SkillDoc): BuildFile {
  const id = skill.id
  const summary = str(skill, 'short-description') ?? str(skill, 'description') ?? `Buracle ${id} workflow`
  const fm = frontmatter([
    ['description', `Buracle ${id}: ${summary}`],
    ['argument-hint', str(skill, 'argument-hint')],
  ])
  return { path: `commands/${id}.md`, content: fm + workflowCommandBody(id) }
}

export function mcpEntry(id: string, spec: McpServerSpec, shim?: string): Record<string, unknown> {
  const timeout = spec.tool_timeout_sec !== undefined ? { timeout: spec.tool_timeout_sec * 1000 } : {}
  if (spec.transport === 'http') return { type: 'http', url: spec.url ?? '', ...timeout }
  const expanded = expandMcpCommand(spec, { buracle: MCP_BURACLE_SHIM, id })
  const viaShim = expanded.command === MCP_BURACLE_SHIM
  const { command, args } = viaShim ? (shim !== undefined ? { command: shim, args: expanded.args } : mcpShimArgv(expanded.args)) : expanded
  const entry: Record<string, unknown> = { type: 'stdio', command }
  if (args.length > 0) entry['args'] = args
  const env = mcpEnvFor(spec, 'omp')
  const keys = Object.keys(env)
  if (keys.length > 0) {
    const out: Record<string, string> = {}
    for (const k of keys) { const v = env[k] as string; const ref = envRef(v); out[k] = ref !== undefined ? `\${${ref}}` : v }
    entry['env'] = out
  }
  return { ...entry, ...timeout }
}

export function renderMcp(canonical: CanonicalBundle): BuildFile {
  const servers: Record<string, unknown> = {}
  for (const id of ompMcpServerIds(canonical)) {
    const spec = canonical.mcp.servers[id]
    if (spec !== undefined) servers[id] = mcpEntry(id, spec)
  }
  return { path: '.mcp.json', content: JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers: servers }, null, 2) + '\n' }
}

export function renderPackageJson(version: string): BuildFile {
  const description = 'Buracle adapter for Oh My Pi: guards, status, memory glue, rules, workflow commands, review agents and MCP servers. Generated by `buracle build`; do not edit.'
  const pkg = {
    name: PACKAGE_NAME,
    version,
    private: true,
    type: 'module',
    description,
    omp: { description: 'Buracle: tool guards, strict routing, stop guard, memory and status', extensions: [`./${EXTENSION_PATH}`] },
  }
  return { path: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' }
}

export function renderReadme(canonical: CanonicalBundle): BuildFile {
  const rules = canonical.rules.map(r => `buracle-${r.id}.md`).sort()
  const commands = ompCommandSkills(canonical).map(c => `/${c}`)
  const agents = canonical.agents.map(a => a.id).sort()
  const servers = ompMcpServerIds(canonical)
  const list = (xs: string[]) => xs.map(x => `\`${x}\``).join(', ')
  const lines = [
    '# buracle-omp',
    '',
    "Buracle's plugin package for Oh My Pi (omp). `buracle build` **generates** this directory from `canonical/`",
    'and `src/adapters/omp/`; do not edit it by hand. Change the sources and run `buracle build`;',
    '`buracle build --check` confirms that nothing drifted.',
    '',
    '## Install',
    '',
    '`buracle install omp` does the following, as one transaction that can be rolled back:',
    '',
    '- `omp plugin link <repo>/harness/omp`: the package is linked as `~/.omp/plugins/node_modules/buracle-omp`.',
    '  The link follows the checkout, so `git pull` and `buracle build` need no reinstall: run `/reload-plugins`',
    '  for rules, commands, agents and MCP servers, and restart omp for the extension code.',
    '- `~/.omp/agent/config.yml`: only these keys are written; every other setting stays as you have it.',
    '  - `statusLine`: preset `custom`, the segment lists and `showHookStatus`.',
    "  - `tools.approvalMode: yolo` with `permissions.bypass` (`write` without it): omp runs tools without asking,",
    "    while the extension's guards still deny dangerous calls (H01, H02) and hold hard-to-undo ones for your",
    '    consent (H20). While `permissions.enforce` is on, a changed value is written back on the next install',
    '    or sync (with a warning; uninstall restores the value it replaced), and `buracle doctor omp` reports it.',
    '  - `tools.xdev: false`: MCP tools are top-level tools the model sees, not `xd://` devices it must look up.',
    '  - `defaultThinkingLevel` from config `effort.omp` (`auto` writes `xhigh`, `keep` writes nothing). A level',
    '    you set yourself is kept. A `:level` suffix on `modelRoles.default` overrides it (`buracle doctor omp` says so).',
    '  - `memory.backend: off` and `enabledProviders: []`.',
    '- `~/.omp/agent/AGENTS.md`: a short managed block that points to the plugin (the rules ship in the plugin).',
    '',
    "Skills are not in this package: omp reads the shared neutral render in `~/.agents/skills` itself.",
    '',
    '## Contents',
    '',
    `- \`${EXTENSION_PATH}\`: the extension, one file (src/core plus the omp runtime). It runs the tool guards (H01,`,
    '  H02, H03 with the semble and codegraph root check, H09, H20), the usage ledger with its reminders and',
    '  deny-once gates (H24), file checks (H04), the context warning (H05), the compaction note and restore',
    '  (H06, H07), the stop guard and the turn-end routing check (H08, H11, H23), intents and the prompt router',
    '  (H10, H22), the memory index, capability card and workspace lines (H13, H15, H21), session capture and the',
    '  finalizer (H14), maintenance (H16), the profile guard (H17), telemetry and the status texts (H18:',
    '  `buracle.budget`, `buracle.mem`, and the status band below the editor), the review-report check of the',
    '  review agents (H19), workflow tracking (H25) and profile signals (H26). When a handler fails, the tool call',
    '  is allowed and the error goes to the log; only the H01 and H02 guards fail closed.',
    `- The running workflow shows above the editor (widget \`${FLOW_WIDGET_KEY}\`, \`workflow.band\`): its phases, progress`,
    '  and current step.',
    `- Extension commands (no model turn): \`/${OMP_STATUS_COMMAND} [status|memory|plan|flow]\` (alias \`/${OMP_STATUS_ALIAS}\`),`,
    '  `/remember <text>` (a note in the memory inbox), `/brain` (starts and opens the memory web UI) and',
    `  \`/${OMP_PING_COMMAND}\` (answers \`${PING_ANSWER}\`); \`/${OMP_ASIDE_COMMAND} <question>\` asks a read-only side question (one side`,
    '  turn of the model, never added to the session, like omp\'s own `/btw`).',
    `- \`rules/\`: always-on rules, and path rules injected when matching files are edited (TTSR): ${list(rules)}.`,
    `- \`commands/\`: one workflow command per user-invocable skill: ${list(commands)}.`,
    `- \`agents/\`: read-only review agents ${list(agents)}.`,
    `- \`.mcp.json\`: pinned MCP servers ${list(servers)}. \`chrome-devtools\` is left out because omp drops browser MCP servers while its built-in browser is on.`,
    '',
    '## Version',
    '',
    `Verified with omp ${OMP_TESTED_WITH}; needs at least ${OMP_MIN_VERSION}. \`buracle doctor omp\` checks the version, the link and the settings.`,
    '',
  ]
  return { path: 'README.md', content: lines.join('\n') }
}

export async function buildOmp(ctx: AdapterContext): Promise<BuildFile[]> {
  const canonical = ctx.canonical
  const version = buracleVersion(ctx.repoRoot)
  const files: BuildFile[] = [
    renderPackageJson(version),
    renderReadme(canonical),
    renderMcp(canonical),
    { path: EXTENSION_PATH, content: await bundleExtension(ctx.repoRoot, ompGeneratedData(canonical, version)) },
  ]
  for (const rule of canonical.rules) files.push(renderRule(rule))
  for (const agent of canonical.agents) files.push(renderAgent(agent))
  const skills = new Map(canonical.skills.map(s => [s.id, s]))
  for (const id of ompCommandSkills(canonical)) {
    const skill = skills.get(id)
    if (skill !== undefined) files.push(renderCommand(skill))
  }
  const seen = new Set<string>()
  for (const f of files) {
    if (seen.has(f.path)) throw new Error(`omp build: duplicate output path ${f.path}`)
    seen.add(f.path)
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

import type { AgentDoc, CanonicalBundle } from '../../core/catalog'
import { COMPANION_MCP_TOOLS } from '../../core/policy/companion-fence'
import { harnessMcpPattern, harnessMcpToolName } from '../../core/policy/routing'
import { mdBlockMarkers } from '../../engine/merge'
import { resolveAgents } from '../shared/agents'
import { renderMarkdown } from '../shared/render'
import { pathRuleFiles } from '../shared/rules'
import { oneLine } from '../shared/skills'

export const QWEN_BLOCK_ID = 'buracle'

/** The shim every command and hook runs; Qwen Code starts a shell command through `/bin/sh`, which expands this. */
const SHIM = '"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle"'

type Refs = { skills: readonly string[], agents: readonly string[] }
type Source = Pick<CanonicalBundle, 'rules' | 'skills' | 'agents'>

const refsOf = (c: Pick<CanonicalBundle, 'skills' | 'agents'>): Refs => ({ skills: c.skills.map(s => s.id), agents: c.agents.map(a => a.id) })
const byId = <T extends { id: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

export interface QwenFile { path: string, content: string }

/** The custom commands Buracle Stack adds (`~/.qwen/commands/<name>.md`); the workflows are the skills, which Qwen Code starts as `/<id>` itself. */
export const QWEN_COMMANDS: ReadonlyArray<{ name: string, description: string, body: string }> = [
  {
    name: 'brain',
    description: 'Open the Buracle Stack memory UI (`/brain review` opens the review page)',
    body: `Open the Buracle Stack memory UI for the user. Arguments: {{args}}\n\nWith no argument run \`${SHIM} mem ui --open\`; with \`review\` run \`${SHIM} mem ui --open --page review\`. Run it with the shell tool, then say in one line what opened.\n`,
  },
  {
    name: 'remember',
    description: 'Save a note to the Buracle Stack memory',
    body: `Save this to the Buracle Stack memory: {{args}}\n\nRun \`${SHIM} mem remember -- "<the text>"\` with the shell tool, quoting the text safely. A typed memory (a decision, a gotcha, a preference) follows the \`memory\` skill. With no text, ask the user what to remember.\n`,
  },
  {
    name: 'buracle-status',
    description: 'Show the Buracle Stack plan, workflow and memory status',
    body: `Show the Buracle Stack status. Arguments: {{args}}\n\nRun \`${SHIM} plan status --json\` and \`${SHIM} mem status\` with the shell tool and summarize both in a few lines: the plan and workflow run first, then the memory. Narrow the answer to the argument when it names one of status, memory, plan or flow.\n`,
  },
]

export function qwenCommandFiles(): QwenFile[] {
  return QWEN_COMMANDS.map(c => ({ path: `commands/${c.name}.md`, content: `---\ndescription: ${JSON.stringify(c.description)}\n---\n${c.body}` }))
}

function commandsSection(): string {
  return [
    '# Buracle Stack commands in Qwen Code',
    '',
    'A workflow or a skill starts with `/<id>`. Buracle Stack adds these custom commands:',
    '- `/remember <text>`: saves a note to the memory (`buracle mem remember -- "<text>"`).',
    '- `/brain`: opens the memory UI; `/brain review` opens its review page.',
    '- `/buracle-status`: the plan, workflow and memory status.',
    "- `/aside <question>`: Qwen Code's own `/btw`.",
  ].join('\n')
}

/**
 * The block of ~/.qwen/QWEN.md: the always-loaded rules and the commands. The path rules are not in it: Qwen Code
 * scopes a rule file to paths itself (`paths:` in ~/.qwen/rules/), see `qwenPathRuleFiles`.
 */
export function qwenMemoryBlock(c: Source, warnings: string[] = []): string {
  const refs = refsOf(c)
  const parts = [
    '_Managed by Buracle Stack (`buracle install`). The source is `canonical/rules/` in the Buracle Stack repo; edits inside this block stop future updates of it._',
    ...byId(c.rules.filter(r => r.scope === 'always')).map(r => renderMarkdown(r.body, 'qwen', { ...refs, file: r.file }, warnings).trim()),
    commandsSection(),
  ]
  return parts.join('\n\n') + '\n'
}

export function qwenMemoryBlockWithMarkers(content: string): string {
  const m = mdBlockMarkers(QWEN_BLOCK_ID)
  return `${m.start}\n${content.replace(/\n+$/, '')}\n${m.end}\n`
}

/** `~/.qwen/rules/buracle/<id>.md`: a rule with `paths:` stays out of the prompt until a tool call touches a matching file. */
export function qwenPathRuleFiles(c: Source, warnings: string[] = []): QwenFile[] {
  return pathRuleFiles(c, warnings).map(r => ({ path: `rules/buracle/${r.file}`, content: r.content }))
}

const FILE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  read: ['read_file'],
  search: ['grep_search', 'glob', 'list_directory'],
  bash: ['run_shell_command'],
  'bash-readonly': ['run_shell_command'],
  edit: ['edit'],
  write: ['write_file', 'edit', 'notebook_edit'],
  web_fetch: ['web_fetch'],
  web_search: ['web_search'],
  web: ['web_fetch', 'web_search'],
}
const WRITE_TOOLS = new Set(['edit', 'write_file', 'notebook_edit'])

/** The `tools` allowlist of a Qwen agent: its MCP tools have to be named one by one, and a read-only agent gets no write tool. */
export function qwenAgentTools(agent: AgentDoc): string[] {
  const raw = agent.frontmatter['tools']
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []
  const readOnly = agent.frontmatter['access'] !== 'read-write'
  const out: string[] = []
  const add = (n: string) => { if (!out.includes(n)) out.push(n) }
  for (const item of list) {
    const t = String(item).trim()
    if (t.startsWith('mcp:')) {
      const server = t.slice(4)
      const tools = COMPANION_MCP_TOOLS[server]
      if (tools === undefined) add(harnessMcpPattern('qwen', server))
      else for (const tool of tools) add(harnessMcpToolName('qwen', server, tool))
      continue
    }
    for (const n of FILE_TOOLS[t] ?? []) if (!(readOnly && WRITE_TOOLS.has(n))) add(n)
  }
  if (!out.includes('read_file')) out.unshift('read_file')
  return out
}

function agentModel(agent: AgentDoc): string | undefined {
  const m = agent.frontmatter['model']
  const v = m !== null && typeof m === 'object' ? (m as Record<string, unknown>)['qwen'] : undefined
  return typeof v === 'string' && v.trim() !== '' && v !== 'inherit' ? v : undefined
}

export function qwenAgentFile(agent: AgentDoc, refs: Refs, warnings: string[] = []): string {
  const description = oneLine(typeof agent.frontmatter['description'] === 'string' ? agent.frontmatter['description'] : agent.id)
  const model = agentModel(agent)
  const head = [
    '---',
    `name: ${agent.id}`,
    `description: ${JSON.stringify(description)}`,
    'tools:',
    ...qwenAgentTools(agent).map(t => `  - ${t}`),
    ...(model !== undefined ? [`model: ${JSON.stringify(model)}`] : []),
    '---',
    '',
  ]
  return head.join('\n') + renderMarkdown(agent.body, 'qwen', { ...refs, file: agent.file }, warnings).trim() + '\n'
}

/** `~/.qwen/agents/<id>.md`: the review agents, which the Agent tool starts by name. */
export function qwenAgentFiles(c: Pick<CanonicalBundle, 'agents' | 'skills'> & { root?: string }, warnings: string[] = []): QwenFile[] {
  const refs = refsOf(c)
  return byId(resolveAgents(c)).map(a => ({ path: `agents/${a.id}.md`, content: qwenAgentFile(a, refs, warnings) }))
}

export function reviewAgentIds(agents: readonly AgentDoc[]): string[] {
  return agents.filter(a => a.frontmatter['output'] === 'json').map(a => a.id).sort()
}

/** Everything the install writes besides settings.json, with paths relative to the Qwen folder (the build writes the same files). */
export function qwenContentFiles(c: CanonicalBundle, warnings: string[] = []): QwenFile[] {
  return [...qwenAgentFiles(c, warnings), ...qwenCommandFiles(), ...qwenPathRuleFiles(c, warnings)].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

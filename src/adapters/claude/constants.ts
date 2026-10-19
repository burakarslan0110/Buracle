import { TESTED_WITH as HARNESS_VERSIONS } from '../../engine/update/tested-with'

export const PLUGIN_NAME = 'buracle'
export const MARKETPLACE_NAME = 'buracle'
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`
export const OWNER_NAME = 'burakarslan0110'

export const TESTED_WITH = HARNESS_VERSIONS.claude.tested
export const MIN_CLAUDE = HARNESS_VERSIONS.claude.min

export const HARNESS_REL = 'harness/claude'
export const TEMPLATE_REL = 'src/adapters/claude/template'
export const CORE_REL = 'src/core'

export const OWNER = 'claude'

export const CLASSIC_HOOKS: ReadonlyArray<{ event: string, matcher?: string, timeout: number, async?: boolean }> = [
  { event: 'SessionStart', timeout: 10 },
  { event: 'UserPromptExpansion', timeout: 5 },
  { event: 'UserPromptSubmit', timeout: 10 },
  { event: 'PreToolUse', matcher: 'Bash|Monitor|Edit|Write|MultiEdit|NotebookEdit|WebSearch|WebFetch|AskUserQuestion|Grep|Glob|Skill|mcp__.*', timeout: 10 },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit|ExitPlanMode|AskUserQuestion', timeout: 30 },
  { event: 'PostToolUse', matcher: 'TodoWrite|TaskCreate|TaskUpdate|Bash|Monitor|WebSearch|WebFetch|mcp__.*|Read|Skill', timeout: 5, async: true },
  { event: 'PreCompact', timeout: 15 },
  { event: 'PostCompact', timeout: 5 },
  { event: 'Stop', timeout: 15 },
  { event: 'SubagentStart', timeout: 5 },
  { event: 'SubagentStop', timeout: 10 },
  { event: 'SessionEnd', timeout: 3 },
]

export const SHELL_TOOLS: readonly string[] = ['Bash', 'Monitor', 'PowerShell']

export const CLAUDE_MANAGED_MARKETPLACES: readonly string[] = ['claude-plugins-official']

export const EFFORT_MODELS: readonly string[] = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']

export const READ_ONLY_DISALLOWED: readonly string[] = ['Write', 'Edit', 'NotebookEdit']

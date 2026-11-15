import { CLAUDE_CLASSIC_EVENTS, CLAUDE_ENGINE_EVENTS } from './native-events'
import { wordDashToken, type HarnessProfile } from './profile'

/** The name of Buracle's Claude Code plugin; its MCP tools carry it. */
export const CLAUDE_PLUGIN_NAME = 'buracle'

export const claudeProfile: HarnessProfile = {
  id: 'claude',
  label: 'Claude Code',
  shortLabel: 'CC',
  noteName: 'claude-code',
  bin: 'claude',
  proc: { base: /^claude$/, path: /\/claude\/versions\/[^/]+$/, pidEnv: 'CLAUDE_PID' },
  runtime: 'command',
  statusLineCommand: true,
  spoolSuffix: 'classic',
  editBudgetMs: 28_000,
  configDir: { key: 'claudeDir', env: 'CLAUDE_CONFIG_DIR', under: '.claude' },
  relocationEnv: ['CLAUDE_CONFIG_DIR'],
  sessionEnv: ['CLAUDE_CODE_SESSION_ID'],
  protectedDirs: [{ key: 'claudeDir', under: '.claude', entries: ['settings.json', 'settings.local.json', 'plugins/'] }],
  selfText: { what: "Claude Code's own configuration, which registers Buracle's guard hooks", remedy: "ask the user to make this change themselves, or use Claude Code's own commands (`claude plugin …`, `claude mcp …`, `/config`)" },
  skills: {
    readsAgentsDir: false,
    readsClaudeUserDir: true,
    readsClaudeProjectDir: true,
    invoke: { slash: true, namespace: 'buracle', dollar: false, at: false, commandTag: true },
    mention: (id, invocable) => invocable ? `/${id}` : `/buracle:${id}`,
    agentPrefix: 'buracle:',
    howto: 'the user starts a workflow with /<id>; you load the others with the Skill tool as buracle:<id>',
    load: (id, explicit, file) => explicit ? `read ${file ?? `skills/${id}/SKILL.md in the Buracle plugin`}` : `Skill tool, buracle:${id}`,
    candidateHow: 'Skill tool, buracle:<id>',
  },
  plan: {
    enter: 'call the EnterPlanMode tool (load it with tool search when it is deferred)',
    readOnly: { name: "Claude Code's plan mode", leave: 'leave plan mode (Shift+Tab)' },
    approval: true,
  },
  mcp: {
    prefix: 'mcp__',
    separator: '__',
    token: wordDashToken,
    plugin: { marker: 'plugin_', name: CLAUDE_PLUGIN_NAME },
    syntax: `mcp__plugin_${CLAUDE_PLUGIN_NAME}_<server>__<tool>`,
    hiddenNote: '* = may be deferred: find its tools with tool search before assuming they are missing',
  },
  mcpClient: { includes: ['claude'] },
  events: {
    map: {
      sessionStart: ['classic.SessionStart', 'classic.SubagentStart'],
      prompt: ['classic.UserPromptSubmit'],
      preTool: ['tool.call', 'tool.check', 'classic.PreToolUse'],
      postTool: ['classic.PostToolUse', 'classic.PostToolUseFailure'],
      stop: ['classic.Stop', 'classic.SubagentStop'],
      preCompact: ['classic.PreCompact'],
      sessionEnd: ['classic.SessionEnd'],
    },
    native: [...CLAUDE_ENGINE_EVENTS, ...CLAUDE_CLASSIC_EVENTS.map(e => `classic.${e}`)],
  },
  tools: {
    kinds: {
      Bash: 'bash', Monitor: 'bash', PowerShell: 'bash',
      Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
      Write: 'write',
      Read: 'read', NotebookRead: 'read',
      Glob: 'search', Grep: 'search', LS: 'search',
      WebSearch: 'web_search',
      WebFetch: 'web_fetch',
      AskUserQuestion: 'ask_user',
      ExitPlanMode: 'plan_exit',
      EnterPlanMode: 'plan_enter',
      TodoWrite: 'todo', TaskCreate: 'todo', TaskUpdate: 'todo', TaskList: 'todo', TaskGet: 'todo',
      Agent: 'agent', Task: 'agent',
    },
    names: { ask_user: 'AskUserQuestion', todo: 'TodoWrite', spawn_agent: 'Agent' },
    stringCommandOnly: ['Monitor'],
  },
}

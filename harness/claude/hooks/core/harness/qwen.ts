import { QWEN_EVENTS } from './native-events'
import { collapsedWordDashToken, type HarnessProfile } from './profile'

// Qwen Code speaks Claude Code's command-hook dialect (docs/users/features/hooks.md of QwenLM/qwen-code), with its own tool ids.
// Buracle registers its hooks and MCP servers in ~/.qwen/settings.json (`hooks`, `mcpServers`), not as a Qwen plugin.
export const qwenProfile: HarnessProfile = {
  id: 'qwen',
  label: 'Qwen Code',
  shortLabel: 'Qwen',
  noteName: 'qwen',
  bin: 'qwen',
  // The installed program is `~/.qwen/bin/qwen/qwen-<version>`, which `qwen` on PATH links to.
  proc: { base: /^qwen(?:-[\w.-]+)?$/, path: /\/\.qwen\/bin\/qwen\/qwen-[^/]+$/ },
  runtime: 'command',
  companionPending: true,
  editBudgetMs: 28_000,
  configDir: { key: 'qwenHome', env: 'QWEN_HOME', under: '.qwen' },
  relocationEnv: ['QWEN_HOME'],
  sessionEnv: [],
  protectedDirs: [{ key: 'qwenHome', under: '.qwen', entries: ['settings.json', 'hookApprovals.json', 'plugins/', 'extensions/'] }],
  selfText: { what: "Qwen Code's own configuration, which registers Buracle's guard hooks", remedy: "ask the user to make this change themselves, or use Qwen Code's own commands (`qwen mcp …`, `/hooks`)" },
  skills: {
    readsAgentsDir: true,
    readsClaudeUserDir: false,
    readsClaudeProjectDir: false,
    invoke: { slash: true, dollar: false, at: false, commandTag: false },
    mention: id => `/${id}`,
    agentPrefix: '',
    howto: 'the user starts a workflow with /<id>; you load one with the skill tool',
    load: id => `skill tool, ${id}`,
    candidateHow: 'skill tool, <id>',
  },
  plan: {
    enter: 'call the EnterPlanMode tool',
    readOnly: { name: "Qwen Code's plan mode", leave: 'leave plan mode (Shift+Tab)' },
    approval: true,
  },
  mcp: {
    prefix: 'mcp__',
    separator: '__',
    token: collapsedWordDashToken,
    syntax: 'mcp__<server>__<tool>, with characters other than letters, digits, _ and - written as _',
    hiddenNote: '* = may be deferred: find its tools with the tool_search tool before assuming they are missing',
  },
  mcpClient: { includes: ['qwen'] },
  events: {
    map: {
      sessionStart: ['SessionStart', 'SubagentStart'],
      prompt: ['UserPromptSubmit'],
      preTool: ['PreToolUse'],
      postTool: ['PostToolUse', 'PostToolUseFailure'],
      stop: ['Stop', 'SubagentStop'],
      preCompact: ['PreCompact'],
      sessionEnd: ['SessionEnd'],
    },
    native: QWEN_EVENTS,
  },
  tools: {
    // The stable line (tool-names.ts of v0.14.0 to v0.27.4, the minimum 0.26.1 among them) names every tool in snake_case;
    // the 1.0.0-preview.1 program still carries the Claude-style names for the ask, plan and todo tools (its own prompt
    // text says "use AskUserQuestion"), so both spellings are classified and prose uses the stable names.
    kinds: {
      run_shell_command: 'bash', monitor: 'bash',
      edit: 'edit', notebook_edit: 'edit',
      write_file: 'write',
      read_file: 'read', read_many_files: 'read',
      glob: 'search', grep_search: 'search', list_directory: 'search',
      web_search: 'web_search',
      web_fetch: 'web_fetch',
      AskUserQuestion: 'ask_user', ask_user_question: 'ask_user',
      ExitPlanMode: 'plan_exit', exit_plan_mode: 'plan_exit',
      EnterPlanMode: 'plan_enter', enter_plan_mode: 'plan_enter',
      TodoWrite: 'todo', todo_write: 'todo',
      agent: 'agent', Agent: 'agent', task: 'agent',
    },
    names: { ask_user: 'ask_user_question', todo: 'todo_write', spawn_agent: 'agent' },
  },
}

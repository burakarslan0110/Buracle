import { AGY_EVENTS } from './native-events'
import { lowerWordToken, type HarnessProfile } from './profile'

// AGY CLI (the `agy` program, Antigravity): command hooks read from `hooks.json` in its customization root. The shapes
// are those of the hooks reference embedded in the program (v1.5.9).
export const agyProfile: HarnessProfile = {
  id: 'agy',
  label: 'AGY CLI',
  shortLabel: 'AGY',
  noteName: 'agy',
  bin: 'agy',
  proc: { base: /^agy$/ },
  runtime: 'command',
  companionPending: true,
  noStdinPrint: true,
  editBudgetMs: 28_000,
  // The global customization root, found under HOME: `ANTIGRAVITY_CONFIG_REL_DIR` is named in the program, but with it set
  // `agy mcp add` still wrote `<HOME>/.gemini/config/mcp_config.json` (1.5.9), so it counts as a relocation variable to
  // guard and nothing more; tests and probes relocate the folder with HOME.
  configDir: { key: 'agyDir', under: '.gemini/config' },
  relocationEnv: ['ANTIGRAVITY_CONFIG_REL_DIR'],
  sessionEnv: ['ANTIGRAVITY_CONVERSATION_ID'],
  protectedDirs: [{ key: 'agyDir', under: '.gemini/config', entries: ['hooks.json', 'mcp_config.json', 'config.json', 'plugins/'] }],
  selfText: { what: "AGY CLI's own configuration, which registers Buracle's guard hooks", remedy: "ask the user to make this change themselves, or use AGY's own commands (`agy mcp …`, `agy plugin …`, `/hooks`)" },
  skills: {
    // AGY reads skills from <config>/skills only (the ~/.agents/skills folder is read per workspace, not globally): the
    // install links every skill of the one copy into that folder.
    readsAgentsDir: false,
    linkDir: 'skills',
    readsClaudeUserDir: false,
    readsClaudeProjectDir: false,
    invoke: { slash: true, dollar: false, at: false, commandTag: false },
    mention: id => `/${id}`,
    agentPrefix: '',
    howto: 'the user starts a workflow with /<id>; you load one by reading its SKILL.md',
    load: (id, _explicit, file) => `read ${file ?? `skills/${id}/SKILL.md`}`,
    candidateHow: 'read skills/<id>/SKILL.md',
  },
  plan: {
    enter: 'ask the user to switch to plan mode (`--mode plan`), then to say "continue", and end the turn',
    readOnly: { name: "AGY's plan mode", leave: 'leave plan mode' },
    approval: false,
  },
  // Unverified: the embedded MCP reference does not say how a tool is named in a hook payload or in the model's tool list
  // (the hooks reference derives a name from the step type, which for an MCP call would be `mcp_tool`). The adapter treats
  // any `mcp…` name it cannot place as an MCP call, so the MCP write guard still reads its arguments.
  mcp: {
    prefix: 'mcp_',
    separator: '_',
    token: lowerWordToken,
    ambiguous: true,
    syntax: 'mcp_<server>_<tool> (to be confirmed against a real session)',
    hiddenNote: '* = may be hidden: find its tools before assuming they are missing',
  },
  mcpClient: { includes: ['antigravity', 'agy'] },
  events: {
    map: {
      sessionStart: ['SessionStart'],
      prompt: ['PreInvocation'],
      preTool: ['PreToolUse'],
      postTool: ['PostToolUse'],
      stop: ['Stop'],
      preCompact: null,
      sessionEnd: null,
    },
    native: AGY_EVENTS,
  },
  tools: {
    kinds: {
      run_command: 'bash', send_command_input: 'bash',
      replace_file_content: 'edit', multi_replace_file_content: 'edit', notebook_edit: 'edit',
      write_to_file: 'write',
      view_file: 'read', view_file_outline: 'read',
      list_dir: 'search', grep_search: 'search', find_by_name: 'search', codebase_search: 'search',
      search_web: 'web_search',
      read_url_content: 'web_fetch',
      ask_user: 'ask_user',
      invoke_subagent: 'agent',
    },
    names: { ask_user: 'ask_user', todo: 'task_boundary', spawn_agent: 'invoke_subagent' },
    todoProse: 'keep the list in your reply',
  },
}

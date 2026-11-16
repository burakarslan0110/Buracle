import { PI_EVENTS } from './native-events'
import { wordToken, type HarnessProfile } from './profile'

// Pi (the `pi` program, @earendil-works/pi-coding-agent): its hooks are an in-process extension, like omp's. It shares
// PI_CODING_AGENT_DIR with omp, whose default folder is another one (see `agentDirConflict` in src/adapters/shared/agent-dir.ts).
export const piProfile: HarnessProfile = {
  id: 'pi',
  label: 'Pi',
  shortLabel: 'Pi',
  noteName: 'pi',
  bin: 'pi',
  proc: { base: /^pi$/ },
  runtime: 'inprocess',
  editBudgetMs: 20_000,
  configDir: { key: 'piAgentDir', env: 'PI_CODING_AGENT_DIR', under: '.pi/agent' },
  relocationEnv: ['PI_CODING_AGENT_DIR'],
  sessionEnv: ['PI_SESSION_ID'],
  protectedDirs: [{ key: 'piAgentDir', under: '.pi/agent', entries: ['settings.json', 'mcp.json', 'extensions/'] }],
  selfText: { what: "Pi's own configuration, which loads Buracle Stack's guard extension", remedy: "ask the user to make this change themselves, or use Pi's own commands (`pi install …`, `pi remove …`, `pi mcp …`, `/mcp`)" },
  skills: {
    readsAgentsDir: true,
    readsClaudeUserDir: false,
    readsClaudeProjectDir: false,
    invoke: { slash: true, namespace: 'skill', dollar: false, at: false, commandTag: false },
    mention: id => `/skill:${id}`,
    agentPrefix: '',
    howto: 'the user starts a workflow with /skill:<id>; you load one by reading its SKILL.md',
    load: (id, _explicit, file) => `read ${file ?? `~/.agents/skills/${id}/SKILL.md`}`,
    candidateHow: 'read ~/.agents/skills/<id>/SKILL.md',
  },
  plan: {
    enter: 'ask the user to turn on a plan mode, then to say "continue", and end the turn (Pi has no built-in plan mode)',
    readOnly: { name: "Pi's plan mode", leave: 'leave plan mode' },
    approval: false,
  },
  mcp: {
    prefix: 'mcp__',
    separator: '__',
    token: wordToken,
    syntax: 'mcp__<server>__<tool>, with characters other than letters, digits and _ written as _',
    hiddenNote: '* = may be hidden by tool exposure settings: find its tools with tool search before assuming they are missing',
  },
  // Pi's MCP client calls itself `pi`, the name omp's client uses too: the host is told apart by other means.
  mcpClient: { includes: ['pi-coding'], exact: ['pi'] },
  events: {
    map: {
      sessionStart: ['session_start'],
      prompt: ['input', 'before_agent_start'],
      preTool: ['tool_call'],
      postTool: ['tool_result'],
      stop: ['agent_before_settle'],
      preCompact: ['session_before_compact'],
      sessionEnd: ['session_shutdown'],
    },
    native: PI_EVENTS,
  },
  tools: {
    kinds: {
      bash: 'bash', codemode: 'eval',
      edit: 'edit',
      write: 'write',
      read: 'read',
      grep: 'search', find: 'search', ls: 'search',
    },
    // Pi ships no question, todo or subagent tool: an extension may add one, and these are the names prose uses then.
    names: { ask_user: 'ask_user', todo: 'todo', spawn_agent: 'subagent' },
    todoProse: 'keep the list in your reply (Pi has no todo tool)',
  },
}

import type { CanonicalEvent, Harness } from '../../core/events'
import { compareVersions } from '../../engine/update/versions'

export type HostLimitKind = 'limit' | 'partial' | 'native'

export type HostProbe =
  | { kind: 'binary-names'; pattern: string; closedBy: string; expect: readonly string[] }
  | { kind: 'binary-list'; pattern: string; closedBy: string; expect: readonly string[] }
  | { kind: 'binary-run'; pattern: string; closedBy: string; expect: readonly string[] }
  | { kind: 'binary-schema'; title: string; closedBy: string; expect: readonly string[] }

export interface HostLimit {
  id: string
  harness: Harness
  feature: string
  /** The canonical event the host has no native event for: its profile maps that event to null (src/core/harness/), and this record says why and what Buracle does instead. */
  event?: CanonicalEvent
  kind: HostLimitKind
  checkedOn: string
  reason: string
  fallback: string
  probe?: HostProbe
  recheck?: string
}

const OPENCODE_TRIGGERS = String.raw`\.trigger\("([a-z]+)","([a-zA-Z.]+)"`
const OPENCODE_SLASH = String.raw`slash:\{name:"([a-z][a-z0-9-]*)"`
const OPENCODE_CORE_TRIGGERS = ['permission.evaluate', 'tool.execute.after', 'tool.execute.before']
// The plugin detail Codex reports (its serde field run): `shareUrl`, `description`, the manifest parts, `scheduledTasks`.
// 0.162.1 had `marketplaceNamemarketplacePathsummary` right before `shareUrl`; 0.166.0 moved them, so the run is read from `shareUrl` on.
const CODEX_PLUGIN_DETAIL = String.raw`shareUrldescription([a-zA-Z]+?)scheduledTasks`
const CODEX_PLUGIN_PARTS = ['skills', 'onboardingSkill', 'hooks', 'apps', 'appTemplates', 'mcpServers']
// The `[tui]` key run of the Codex config, read from `right_click_paste` up to the `theme` or `pet` key. A new
// `status_line_command` or `status_line_script` key splits off as `_command` or `_script` after the known `status_line`.
const CODEX_TUI_KEYS = String.raw`right_click_paste(status_line[a-z_]*?)(?:theme|pet)`
const CODEX_TUI_STATUS_KEYS = ['status_line', 'status_line_use_colors', 'terminal_title']
// The hook event enum of Codex (HookEventsToml), read up to `Interrupt`. A failure event next to PostToolUse would split off as a `Failure` or `Error` fragment.
const CODEX_HOOK_EVENTS = String.raw`HookEventsToml((?:[A-Z][a-z]+)+?Interrupt)`
const CODEX_HOOK_EVENT_NAMES = ['PreModelRequest', 'PostModelRequest', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt']
const CODEX_HOOKS_DOC = 'https://developers.openai.com/codex/hooks'
const CHECKED = 'checked 2026-11-04'
const OPENCODE_PLUGIN_HOOKS = `the plugin hooks of the OpenCode v2.0.32 plugin docs (prompt, context, compaction, generate, title, model.request, http.request, http.response, experimental.ws.*, retry, tool execute.before and execute.after, shell create.before, permission evaluate); session.idle and session.status are observe-only events in packages/core/src/plugin/plan.ts; ${CHECKED}`

export const HOST_LIMITS: readonly HostLimit[] = [
  {
    id: 'codex.consent-dialog', harness: 'codex', feature: 'consentDialog', kind: 'partial', checkedOn: '0.162.1',
    reason: 'a hook cannot ask the user itself, so H20 uses Codex\'s own approval prompt, which approves one run; `codex exec`, `--yolo` and `-a never` sessions never show it', fallback: 'in those sessions the H20 denial tells the agent what to ask; the next prompt carries the answer',
    recheck: `whether Codex's approve-for-the-session choice covers a command an execpolicy prompt rule matched: codex-rs/protocol/src/approvals.rs default_available_decisions (ApprovedForSession only for network approvals), the PreToolUse section of ${CODEX_HOOKS_DOC} (permissionDecision "ask" is parsed but not supported yet) and its PermissionRequest section (allow, deny or defer only); ${CHECKED}`,
  },
  {
    id: 'codex.background-wait', harness: 'codex', feature: 'backgroundWait', kind: 'limit', checkedOn: '0.166.0',
    reason: 'the Stop payload carries no task data and nothing wakes a Codex turn when a background command ends', fallback: 'the stop guard holds the turn as usual',
    probe: { kind: 'binary-schema', title: String.raw`^stop\.command\.input$`, closedBy: 'task|background|job|running', expect: ['last_assistant_message', 'stop_hook_active', 'turn_id'] },
    recheck: `codex-rs/hooks/src/schema.rs StopCommandInput (session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode, stop_hook_active, last_assistant_message: no task data); ${CHECKED}`,
  },
  {
    id: 'codex.quiet-stop-feedback', harness: 'codex', feature: 'quietStopFeedback', kind: 'limit', checkedOn: '0.166.0',
    reason: 'a Stop hook continues a turn only with `decision: block`, whose reason becomes a new prompt', fallback: 'the stop guard\'s reason goes in that prompt',
    probe: { kind: 'binary-schema', title: String.raw`^stop\.command\.output$`, closedBy: '^(?:hookSpecificOutput|additionalContext)$', expect: ['decision', 'reason', 'systemMessage'] },
    recheck: `codex-rs/hooks/src/schema.rs StopCommandOutputWire (continue, stopReason, suppressOutput, systemMessage, a block decision with its reason; no additionalContext); ${CHECKED}`,
  },
  {
    id: 'codex.commands-without-turn', harness: 'codex', feature: 'commandsWithoutTurn', kind: 'limit', checkedOn: '0.166.0',
    reason: 'Codex has no custom slash commands: a plugin\'s `commands` are migrated into skills, which run inside a turn, and a plugin otherwise carries skills, MCP servers, apps and hooks', fallback: '`$memory`, the CLI twins (`buracle mem ...`, `buracle plan status`) and Codex\'s own `/side`',
    probe: { kind: 'binary-run', pattern: CODEX_PLUGIN_DETAIL, closedBy: '[cC]ommands', expect: CODEX_PLUGIN_PARTS },
    recheck: `codex-rs/core-plugins/src/manifest.rs (name, version, description, keywords, skills, mcpServers, apps, hooks, interface, extensions) and loader.rs, which migrates a legacy commands section into skills; ${CHECKED}`,
  },
  {
    id: 'codex.live-exec-mask', harness: 'codex', feature: 'liveExecMask', kind: 'limit', checkedOn: '0.162.1',
    reason: 'the `write_stdin` polls of a running exec session never reach a hook; the final output arrives with the command\'s PostToolUse and is masked', fallback: 'the masking of every completed shell and MCP result',
    recheck: `the Tool coverage table of ${CODEX_HOOKS_DOC} (write_stdin polls skip PreToolUse and may deliver the original command's PostToolUse); ${CHECKED}`,
  },
  {
    id: 'codex.failed-mcp-mask', harness: 'codex', feature: 'failedMcpMask', kind: 'limit', checkedOn: '0.166.0',
    reason: 'Codex runs PostToolUse only for a call that succeeded (`core/src/tools/registry.rs` passes no payload otherwise), so the output of a failed MCP call reaches the model unmasked', fallback: 'the masking of every successful shell and MCP result',
    probe: { kind: 'binary-run', pattern: CODEX_HOOK_EVENTS, closedBy: '[fF]ail|[eE]rror', expect: CODEX_HOOK_EVENT_NAMES },
    recheck: `codex-rs/core/src/tools/registry.rs (post_tool_use_payload = if success { … } else { None }) and the PostToolUse section of ${CODEX_HOOKS_DOC} (a non-zero exit fires PostToolUse for Bash only); the probe sees a failure hook event, not a change of that success check; ${CHECKED}`,
  },
  {
    id: 'codex.live-panes', harness: 'codex', feature: 'livePanes', kind: 'limit', checkedOn: '0.166.0',
    reason: 'Codex gives hooks no pane, widget or dialog', fallback: '`buracle mem status`, `buracle plan status` and the one-line workflow notices (`workflow.codexNotices`)',
    probe: { kind: 'binary-schema', title: String.raw`\.command\.output$`, closedBy: '[pP]ane|[wW]idget|[dD]ialog|[sS]tatus_?[lL]ine', expect: ['additionalContext', 'hookSpecificOutput', 'systemMessage'] },
    recheck: `the hook output schemas in codex-rs/hooks/src/schema.rs (the common output has only systemMessage) and ${CODEX_HOOKS_DOC}; ${CHECKED}`,
  },
  {
    id: 'codex.custom-status-line', harness: 'codex', feature: 'customStatusLine', kind: 'limit', checkedOn: '0.166.0',
    reason: 'the Codex footer shows only its own items (`tui.status_line` takes item ids, no command; openai/codex#17827)', fallback: 'Buracle picks the native items',
    probe: { kind: 'binary-run', pattern: CODEX_TUI_KEYS, closedBy: String.raw`(?:^_|status_line_)(?:command|script)`, expect: CODEX_TUI_STATUS_KEYS },
    recheck: `codex-rs/tui/src/bottom_pane/status_line_setup.rs (a fixed StatusLineItem enum, no command or script) and https://github.com/openai/codex/issues/17827 (open); ${CHECKED}`,
  },
  {
    id: 'codex.summary-keep-list', harness: 'codex', feature: 'summaryKeepList', kind: 'partial', checkedOn: '0.162.1',
    reason: '`compact_prompt` steers only local compaction; the OpenAI, Azure and Bedrock providers compact on the server and ignore it', fallback: 'the handoff memory and the H07 restore carry the state over',
    recheck: `codex-rs/core/src/tasks/compact.rs (remote compaction ignores compact_prompt); ${CHECKED}`,
  },
  {
    id: 'opencode.consent-dialog', harness: 'opencode', feature: 'consentDialog', kind: 'partial', checkedOn: '2.0.30',
    reason: 'the dialog needs the TUI plugin that shows the session; the web and desktop clients, the server API and `opencode run` load no TUI plugins', fallback: 'without that TUI the denial tells the agent to ask with the `question` tool, whose allow answer records the grant',
    recheck: `https://github.com/anomalyco/opencode/blob/v2.0.28/services/www/src/docs/content/build/plugins/index.mdx: permission.evaluate may answer allow, ask or deny with a message the permission prompt shows, and permission.asked and permission.replied report the user's answer, so a connected client could show the consent question itself (opencode run auto-rejects asks in packages/cli/src/run/noninteractive.ts); the open design point is the "always" answer, which writes a durable project-scoped allow rule; ${CHECKED}`,
  },
  {
    id: 'opencode.approved-plan-capture', harness: 'opencode', feature: 'approvedPlanCapture', kind: 'limit', checkedOn: '2.0.30',
    reason: 'the plan agent has no approval tool or event', fallback: 'a draft plan (`approved: false`) when the session leaves the plan agent',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`^(?:session|agent)\.plan`, expect: OPENCODE_CORE_TRIGGERS },
    recheck: `packages/core/src/plugin/plan.ts subscribes only session.created and session.agent.selected (v2.0.30, no approval event); ${CHECKED}`,
  },
  {
    id: 'opencode.native-plan-approval', harness: 'opencode', feature: 'nativePlanApproval', kind: 'limit', checkedOn: '2.0.30',
    reason: 'leaving the plan agent is no approval: OpenCode has no approval tool or event for it', fallback: 'H12 fills the prepared plan as a draft (`approved: false`) and plan-build asks the user to approve it',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`^(?:session|agent)\.plan`, expect: OPENCODE_CORE_TRIGGERS },
    recheck: `packages/core/src/plugin/plan.ts subscribes only session.created and session.agent.selected (v2.0.30, no approval event); ${CHECKED}`,
  },
  {
    id: 'opencode.goal-command', harness: 'opencode', feature: 'goalCommand', kind: 'limit', checkedOn: '2.0.30',
    reason: 'OpenCode has no native goal command', fallback: 'the goal-build brief states the condition in its first sentence',
    probe: { kind: 'binary-names', pattern: OPENCODE_SLASH, closedBy: '^goal$', expect: ['compact', 'help', 'new'] },
    recheck: `packages/core/src/plugin/command.ts registers /init, /review and the MCP prompts only (v2.0.30); ${CHECKED}`,
  },
  {
    id: 'opencode.quiet-stop-feedback', harness: 'opencode', feature: 'quietStopFeedback', kind: 'limit', checkedOn: '2.0.30',
    reason: 'no plugin hook runs before a session stops', fallback: 'the stop guard re-prompts after `session.execution.succeeded`, with caps',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`^session\.(?:stop|idle|end|execution)`, expect: OPENCODE_CORE_TRIGGERS },
    recheck: OPENCODE_PLUGIN_HOOKS,
  },
  {
    id: 'opencode.stop-veto', harness: 'opencode', feature: 'stopVeto', kind: 'limit', checkedOn: '2.0.30',
    reason: 'no plugin hook can hold a session that is about to stop (the 2.0.30 trigger points are tool.execute, permission.evaluate, shell.create.before and session prompt, title, retry, model.request, http and experimental.ws)', fallback: 'a capped re-prompt after `session.execution.succeeded`',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`^session\.(?:stop|idle|end|execution)`, expect: OPENCODE_CORE_TRIGGERS },
    recheck: OPENCODE_PLUGIN_HOOKS,
  },
  {
    id: 'opencode.subagent-stop-hold', harness: 'opencode', feature: 'subagentStopHold', kind: 'limit', checkedOn: '2.3.0',
    reason: 'no subagent-stop hook; a reviewer\'s final message is seen only in the parent: as the `<subagent>` message in its `session.context` (2.3.0 and later run every subagent in the background), before that in the `tool.execute.after` of the `subagent` tool', fallback: 'an invalid review report gets a note asking the agent to continue that reviewer once',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`subagent|agent\.(?:stop|end)`, expect: OPENCODE_CORE_TRIGGERS },
    recheck: OPENCODE_PLUGIN_HOOKS,
  },
  {
    id: 'opencode.rate-windows', harness: 'opencode', feature: 'rateWindows', kind: 'partial', checkedOn: '2.0.30',
    reason: 'OpenCode has no quota API: the windows come from provider response headers over HTTP and from the Codex backend\'s `codex.rate_limits` websocket events; API-key accounts send none', fallback: 'the 5h and 7d segments stay empty until a response carries them',
    recheck: `packages/server/src/handlers/usage.ts is absent at v2.0.30 (no quota API); the windows come from the http.response and experimental.ws.receive hooks; ${CHECKED}`,
  },
  {
    id: 'claude.project-rule-list', harness: 'claude', feature: 'projectRuleList', kind: 'native', checkedOn: '2.1.302',
    reason: 'Claude Code loads `.claude/rules` itself', fallback: 'nothing needed',
  },
  {
    id: 'claude.claude-only-skill-list', harness: 'claude', feature: 'claudeOnlySkillList', kind: 'native', checkedOn: '2.1.302',
    reason: 'Claude Code reads `.claude/skills` itself', fallback: 'nothing needed',
  },
  {
    id: 'opencode.claude-only-skill-list', harness: 'opencode', feature: 'claudeOnlySkillList', kind: 'native', checkedOn: '2.0.30',
    reason: 'OpenCode reads `.claude/skills` itself', fallback: 'nothing needed',
  },
  {
    id: 'omp.claude-only-skill-list', harness: 'omp', feature: 'claudeOnlySkillList', kind: 'native', checkedOn: '18.10.1',
    reason: 'Oh My Pi reads `.claude/skills` itself (`skills.enableClaudeProject`)', fallback: 'nothing needed',
  },
  {
    id: 'omp.companion-shell', harness: 'omp', feature: 'companionShell', kind: 'limit', checkedOn: '18.10.1',
    reason: 'a second opinion runs as a print-mode main session, which is no reviewer, so omp itself does not hold its bash tool to read-only commands; `--tools` can only leave bash out',
    fallback: 'the second opinion runs with read, grep and glob only (Buracle\'s extension blocks every other tool, MCP tools and `xd://` devices included), and Buracle puts the diff and the changed files into its prompt',
    recheck: `whether a --config <file> overlay (docs/settings.md) with tools.approvalMode write (docs/approval-mode.md) and bash.patterns allow rules for the read-only git and rg commands (docs/tools/bash.md) lets bash join the read tools: per https://github.com/can1357/oh-my-pi/blob/v18.10.1/docs/bash-tool-runtime.md an allow rule grants a simple command the write tier, while redirections, substitutions, globbing and chains keep the exec tier (bash.allowCompoundCommands opts flat && chains in), bash.patterns do not bind eval (pair them with tools.approval.eval), and a prompt without a UI is refused in print mode. Probe on a real omp: with that overlay, in print mode, \`git status > /tmp/x\` and \`rg x $(pwd)\` must be refused and \`git status\` allowed; ${CHECKED}`,
  },
  {
    id: 'agy.no-compaction-event', harness: 'agy', feature: 'preCompact', event: 'preCompact', kind: 'limit', checkedOn: '1.5.9',
    reason: 'the hook events of AGY CLI are SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation and Stop: nothing runs before or after a conversation is compacted', fallback: 'H06 and H07 are not bound; H13 injects the memory context at SessionStart and H05 watches the context size before each model call',
    recheck: `the hooks reference embedded in the agy 1.5.9 program (Lifecycle Hooks, Supported Event Types), published at https://antigravity.google/docs; checked 2026-11-15`,
  },
  {
    id: 'agy.commands-without-turn', harness: 'agy', feature: 'commandsWithoutTurn', kind: 'limit', checkedOn: '1.5.9',
    reason: 'AGY CLI has no custom command that runs without a model turn: a custom slash command is a skill, and the `agy plugin` manifest has no commands entry', fallback: 'every workflow skill is a `/<id>` command; the always-on rules name the CLI twins of `/remember`, `/brain`, `/buracle-status` and `/aside`',
    recheck: `the migration guide embedded in the agy 1.5.9 program (slash commands become skills) and the plugin structure of its Plugins reference (plugin.json, mcp_config.json, hooks.json, rules, skills, agents), published at https://antigravity.google/docs; checked 2026-11-15`,
  },
  {
    id: 'agy.no-subagent-result', harness: 'agy', feature: 'subagentResult', kind: 'limit', checkedOn: '1.5.9',
    reason: 'the PostToolUse payload of AGY CLI has the call (`toolCall.name`, `toolCall.args`), `stepIdx` and `error`, but not the result, so a review agent\'s report never reaches a hook (H19 has no AGY binding)', fallback: 'the review steps of plan-build, bugfix and goal-build validate the report themselves, and the agents\' instructions define its fields',
    recheck: `the hooks reference embedded in the agy 1.5.9 program (PostToolUse Contract: Input), published at https://antigravity.google/docs; checked 2026-11-15`,
  },
  {
    id: 'agy.no-session-end', harness: 'agy', feature: 'sessionEnd', event: 'sessionEnd', kind: 'limit', checkedOn: '1.5.9',
    reason: 'AGY CLI has no event for the end of a conversation; Stop fires whenever the execution loop ends, which is the end of a turn', fallback: 'H14 captures at every Stop, so a conversation is never lost; which Stop counts as its end is decided by the AGY adapter',
    recheck: `the hooks reference embedded in the agy 1.5.9 program (Stop contract: terminationReason, fullyIdle), published at https://antigravity.google/docs; checked 2026-11-15`,
  },
  {
    id: 'pi.no-subagents', harness: 'pi', feature: 'reviewAgents', kind: 'limit', checkedOn: '1.5.2',
    reason: 'Pi has no subagent tool and no agent files; only an example extension in its package spawns sub-agents (docs/extensions.md)', fallback: 'no review agents are installed, H19 is not bound, and the review steps run in the main session; the second opinion (`pi -p`) still gives an outside read',
    recheck: 'the built-in tool list of `pi --help` (read, bash, edit, write, grep, find, ls) and docs/extensions.md of the pi-coding-agent 1.5.2 package; checked 2026-11-15',
  },
  {
    id: 'pi.no-path-rules', harness: 'pi', feature: 'pathRules', kind: 'limit', checkedOn: '1.5.2',
    reason: 'Pi loads AGENTS.md and CLAUDE.md context files and no rule scoped to file paths (docs/configuration.md)', fallback: 'the AGENTS.md block names the path rules and H03 hands the matching rule over at the first edit of a file',
    recheck: 'the Context files section of docs/configuration.md of the pi-coding-agent 1.5.2 package; checked 2026-11-15',
  },
]

/** The record of a canonical event a host lacks; every null in a profile's event map has one. */
export function missingEventLimit(h: Harness, event: CanonicalEvent): HostLimit | undefined {
  return HOST_LIMITS.find(l => l.harness === h && l.event === event)
}

export function hostLimitsOf(h: Harness, kinds: readonly HostLimitKind[] = ['limit', 'partial']): HostLimit[] {
  return HOST_LIMITS.filter(l => l.harness === h && kinds.includes(l.kind))
}

const EMBEDDED_SCHEMA = /\{\n {2}"\$schema": "http:\/\/json-schema\.org[^]*?\n {2}"title": "([a-z.-]+)",\n {2}"type": "object"\n\}/g

export function splitRun(run: string, words: readonly string[]): string[] {
  const known = [...words].sort((a, b) => b.length - a.length)
  const out: string[] = []
  let rest = ''
  for (let i = 0; i < run.length;) {
    const w = known.find(k => run.startsWith(k, i))
    if (w === undefined) { rest += run[i]; i++; continue }
    if (rest !== '') { out.push(rest); rest = '' }
    out.push(w)
    i += w.length
  }
  if (rest !== '') out.push(rest)
  return out
}

function schemaProperties(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) { for (const n of node) schemaProperties(n, out); return }
  if (node === null || typeof node !== 'object') return
  for (const [k, v] of Object.entries(node)) {
    if (k === 'properties' && v !== null && typeof v === 'object' && !Array.isArray(v)) for (const p of Object.keys(v)) out.add(p)
    schemaProperties(v, out)
  }
}

export function probeNames(text: string, probe: HostProbe): string[] {
  const names = new Set<string>()
  if (probe.kind === 'binary-schema') {
    const title = new RegExp(probe.title)
    for (const m of text.matchAll(EMBEDDED_SCHEMA)) {
      if (!title.test(m[1] ?? '')) continue
      try { schemaProperties(JSON.parse(m[0]), names) } catch { continue }
    }
    return [...names].sort()
  }
  for (const m of text.matchAll(new RegExp(probe.pattern, 'g'))) {
    if (probe.kind === 'binary-names') {
      names.add(m.slice(1).filter((g): g is string => g !== undefined).join('.'))
    } else if (probe.kind === 'binary-run') {
      for (const name of splitRun(m[1] ?? '', probe.expect)) names.add(name)
    } else {
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.trim().replace(/^"|"$/g, '')
        if (name !== '') names.add(name)
      }
    }
  }
  return [...names].sort()
}

export function probeMisses(text: string, probe: HostProbe): string[] {
  const found = new Set(probeNames(text, probe))
  return probe.expect.filter(n => !found.has(n))
}

export function probeClosers(text: string, probe: HostProbe): string[] {
  const re = new RegExp(probe.closedBy)
  return probeNames(text, probe).filter(n => re.test(n))
}

export interface HostLimitRow { level: 'ok'; check: string; detail: string }

const README_POINTER = 'See the Host limits table in README.md.'

/**
 * The doctor rows for a harness's host limits: a summary row first (`<h>.limits`), then one `ok` row per limit or
 * partial record with its reason and Buracle's fallback. None warns: a newer host version is no problem by itself.
 */
export function hostLimitRows(h: Harness): HostLimitRow[] {
  const limits = hostLimitsOf(h)
  if (limits.length === 0) return []
  const checkedOn = limits.map(l => l.checkedOn).sort(compareVersions).at(-1) ?? ''
  const ids = limits.map(l => l.id.replace(`${h}.`, '')).join(', ')
  const summary: HostLimitRow = { level: 'ok', check: `${h}.limits`, detail: `${limits.length} host limits recorded, last checked on ${checkedOn} (${ids}); each follows with its fallback` }
  return [summary, ...limits.map((l): HostLimitRow => ({ level: 'ok', check: l.id, detail: `${l.reason}. Fallback: ${l.fallback}. ${README_POINTER}` }))]
}

import type { Harness } from '../../core/events'
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
  kind: HostLimitKind
  checkedOn: string
  reason: string
  fallback: string
  probe?: HostProbe
  recheck?: string
}

const OPENCODE_TRIGGERS = String.raw`\.trigger\("([a-z]+)","([a-zA-Z.]+)"`
const OPENCODE_TOOL_SET = String.raw`new Set\(\["shell","glob","read",([^\]]*)\]\)`
const OPENCODE_SLASH = String.raw`slash:\{name:"([a-z][a-z0-9-]*)"`
const OPENCODE_CORE_TRIGGERS = ['permission.evaluate', 'tool.execute.after', 'tool.execute.before']
const CODEX_PLUGIN_DETAIL = String.raw`summaryshareUrldescription([a-zA-Z]+?)scheduledTasks`
const CODEX_PLUGIN_PARTS = ['skills', 'onboardingSkill', 'hooks', 'apps', 'appTemplates', 'mcpServers']
const CODEX_HOOKS_DOC = 'the Tool coverage table of https://developers.openai.com/codex/hooks'

export const HOST_LIMITS: readonly HostLimit[] = [
  {
    id: 'codex.consent-dialog', harness: 'codex', feature: 'consentDialog', kind: 'partial', checkedOn: '0.162.1',
    reason: 'a hook cannot ask the user itself, so H20 uses Codex\'s own approval prompt, which approves one run; `codex exec`, `--yolo` and `-a never` sessions never show it', fallback: 'in those sessions the H20 denial tells the agent what to ask; the next prompt carries the answer',
    recheck: 'whether Codex\'s approve-for-the-session choice covers a command an execpolicy prompt rule matched (with_cached_approval in the Codex source)',
  },
  {
    id: 'codex.background-wait', harness: 'codex', feature: 'backgroundWait', kind: 'limit', checkedOn: '0.162.1',
    reason: 'the Stop payload carries no task data and nothing wakes a Codex turn when a background command ends', fallback: 'the stop guard holds the turn as usual',
    probe: { kind: 'binary-schema', title: String.raw`^stop\.command\.input$`, closedBy: 'task|background|job|running', expect: ['last_assistant_message', 'stop_hook_active', 'turn_id'] },
  },
  {
    id: 'codex.quiet-stop-feedback', harness: 'codex', feature: 'quietStopFeedback', kind: 'limit', checkedOn: '0.162.1',
    reason: 'a Stop hook continues a turn only with `decision: block`, whose reason becomes a new prompt', fallback: 'the stop guard\'s reason goes in that prompt',
    probe: { kind: 'binary-schema', title: String.raw`^stop\.command\.output$`, closedBy: '^(?:hookSpecificOutput|additionalContext)$', expect: ['decision', 'reason', 'systemMessage'] },
  },
  {
    id: 'codex.shell-read-nudge', harness: 'codex', feature: 'shellReadNudge', kind: 'limit', checkedOn: '0.162.1',
    reason: 'Codex has no file-read tool to point a shell read to', fallback: 'the shell read stays allowed; the edit note names `apply_patch`',
    recheck: 'the tool list of a Codex session (a read tool next to `apply_patch`)',
  },
  {
    id: 'codex.commands-without-turn', harness: 'codex', feature: 'commandsWithoutTurn', kind: 'limit', checkedOn: '0.162.1',
    reason: 'Codex has no custom slash commands: a plugin\'s `commands` are migrated into skills, which run inside a turn, and a plugin otherwise carries skills, MCP servers, apps and hooks', fallback: '`$memory`, the CLI twins (`buracle mem ...`, `buracle plan status`) and Codex\'s own `/side`',
    probe: { kind: 'binary-run', pattern: CODEX_PLUGIN_DETAIL, closedBy: '[cC]ommands', expect: CODEX_PLUGIN_PARTS },
  },
  {
    id: 'codex.live-exec-mask', harness: 'codex', feature: 'liveExecMask', kind: 'limit', checkedOn: '0.162.1',
    reason: 'the `write_stdin` polls of a running exec session never reach a hook; the final output arrives with the command\'s PostToolUse and is masked', fallback: 'the masking of every completed shell and MCP result',
    recheck: CODEX_HOOKS_DOC,
  },
  {
    id: 'codex.failed-mcp-mask', harness: 'codex', feature: 'failedMcpMask', kind: 'limit', checkedOn: '0.162.1',
    reason: 'Codex runs PostToolUse only for a call that succeeded (`core/src/tools/registry.rs` passes no payload otherwise), so the output of a failed MCP call reaches the model unmasked', fallback: 'the masking of every successful shell and MCP result',
    recheck: 'the `success` check before `run_post_tool_use_hooks` in the Codex source, and the hooks doc\'s PostToolUse section',
  },
  {
    id: 'codex.live-panes', harness: 'codex', feature: 'livePanes', kind: 'limit', checkedOn: '0.162.1',
    reason: 'Codex gives hooks no pane, widget or dialog', fallback: '`buracle mem status`, `buracle plan status` and the tmux status line',
    probe: { kind: 'binary-schema', title: String.raw`\.command\.output$`, closedBy: '[pP]ane|[wW]idget|[dD]ialog|[sS]tatus_?[lL]ine', expect: ['additionalContext', 'hookSpecificOutput', 'systemMessage'] },
  },
  {
    id: 'codex.custom-status-line', harness: 'codex', feature: 'customStatusLine', kind: 'limit', checkedOn: '0.162.1',
    reason: 'the Codex footer shows only its own items (`tui.status_line` takes item ids, no command; openai/codex#17827)', fallback: 'Buracle picks the native items and shows its own bar through tmux (`buracle statusline codex`)',
    recheck: 'the `[tui]` keys of the Codex config reference (a status line command or script)',
  },
  {
    id: 'codex.summary-keep-list', harness: 'codex', feature: 'summaryKeepList', kind: 'partial', checkedOn: '0.162.1',
    reason: '`compact_prompt` steers only local compaction; the OpenAI, Azure and Bedrock providers compact on the server and ignore it', fallback: 'the handoff memory and the H07 restore carry the state over',
    recheck: 'the compaction path of the Codex source for remote providers',
  },
  {
    id: 'opencode.consent-dialog', harness: 'opencode', feature: 'consentDialog', kind: 'partial', checkedOn: '2.0.30',
    reason: 'the dialog needs the TUI plugin that shows the session; the web and desktop clients, the server API and `opencode run` load no TUI plugins', fallback: 'without that TUI the denial tells the agent to ask with the `question` tool, whose allow answer records the grant',
    recheck: 'whether `permission.evaluate` can return `ask` with a plugin-defined question',
  },
  {
    id: 'opencode.approved-plan-capture', harness: 'opencode', feature: 'approvedPlanCapture', kind: 'limit', checkedOn: '2.0.30',
    reason: 'the plan agent has no approval tool or event', fallback: 'a draft plan (`approved: false`) when the session leaves the plan agent',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`^(?:session|agent)\.plan`, expect: OPENCODE_CORE_TRIGGERS },
  },
  {
    id: 'opencode.native-plan-approval', harness: 'opencode', feature: 'nativePlanApproval', kind: 'limit', checkedOn: '2.0.30',
    reason: 'leaving the plan agent is no approval: OpenCode has no approval tool or event for it', fallback: 'H12 fills the prepared plan as a draft (`approved: false`) and plan-build asks the user to approve it',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`^(?:session|agent)\.plan`, expect: OPENCODE_CORE_TRIGGERS },
  },
  {
    id: 'opencode.todo-handoff', harness: 'opencode', feature: 'todoHandoff', kind: 'limit', checkedOn: '2.0.30',
    reason: 'OpenCode 2.x has no todo tool (the v1 `todowrite` is dropped by the v2 migration)', fallback: 'the handoff memory carries the plan and its open tasks, without todos',
    probe: { kind: 'binary-list', pattern: OPENCODE_TOOL_SET, closedBy: 'todo', expect: ['edit', 'grep', 'write'] },
  },
  {
    id: 'opencode.goal-command', harness: 'opencode', feature: 'goalCommand', kind: 'limit', checkedOn: '2.0.30',
    reason: 'OpenCode has no native goal command', fallback: 'the goal-build brief states the condition in its first sentence',
    probe: { kind: 'binary-names', pattern: OPENCODE_SLASH, closedBy: '^goal$', expect: ['compact', 'help', 'new'] },
  },
  {
    id: 'opencode.quiet-stop-feedback', harness: 'opencode', feature: 'quietStopFeedback', kind: 'limit', checkedOn: '2.0.30',
    reason: 'no plugin hook runs before a session stops', fallback: 'the stop guard re-prompts after `session.execution.succeeded`, with caps',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`^session\.(?:stop|idle|end|execution)`, expect: OPENCODE_CORE_TRIGGERS },
  },
  {
    id: 'opencode.stop-veto', harness: 'opencode', feature: 'stopVeto', kind: 'limit', checkedOn: '2.0.30',
    reason: 'no plugin hook can hold a session that is about to stop (the 2.0.30 trigger points are tool.execute, permission.evaluate, shell.create.before and session prompt, title, retry, model.request, http and experimental.ws)', fallback: 'a capped re-prompt after `session.execution.succeeded`',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`^session\.(?:stop|idle|end|execution)`, expect: OPENCODE_CORE_TRIGGERS },
  },
  {
    id: 'opencode.subagent-stop-hold', harness: 'opencode', feature: 'subagentStopHold', kind: 'limit', checkedOn: '2.0.30',
    reason: 'no subagent-stop hook; a reviewer\'s final message is seen only in the parent\'s `tool.execute.after` of the `subagent` tool', fallback: 'an invalid review report gets a note asking the agent to continue that reviewer once',
    probe: { kind: 'binary-names', pattern: OPENCODE_TRIGGERS, closedBy: String.raw`subagent|agent\.(?:stop|end)`, expect: OPENCODE_CORE_TRIGGERS },
  },
  {
    id: 'opencode.rate-windows', harness: 'opencode', feature: 'rateWindows', kind: 'partial', checkedOn: '2.0.30',
    reason: 'OpenCode has no quota API: the windows come from provider response headers over HTTP and from the Codex backend\'s `codex.rate_limits` websocket events; API-key accounts send none', fallback: 'the 5h and 7d segments stay empty until a response carries them',
    recheck: 'the `session.hook` trigger points (`http.response`, `experimental.ws.receive`) of the new OpenCode',
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
    recheck: 'whether a `--config` overlay with `bash.patterns` (allow the read-only git and rg commands, deny the rest) also stops redirections and command substitutions in print mode, so bash can join the read tools',
  },
]

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

export interface HostLimitRow { level: 'ok' | 'warn'; check: string; detail: string }

export function hostLimitsRow(h: Harness, version: string | undefined, smokeTest: string): HostLimitRow | undefined {
  const limits = hostLimitsOf(h)
  if (limits.length === 0) return undefined
  const checkedOn = limits.map(l => l.checkedOn).sort(compareVersions).at(-1) ?? ''
  const ids = limits.map(l => l.id.replace(`${h}.`, '')).join(', ')
  const check = `${h}.limits`
  if (version !== undefined && checkedOn !== '' && compareVersions(version, checkedOn) > 0) {
    return { level: 'warn', check, detail: `${version} is newer than ${checkedOn}, where Buracle recorded ${limits.length} host limits (${ids}); from the Buracle checkout, \`bun test ${smokeTest} -t "host limits"\` says whether this version closes one` }
  }
  return { level: 'ok', check, detail: `${limits.length} host limits recorded on ${checkedOn} (${ids}); DESIGN §4.5 lists each with Buracle's fallback` }
}

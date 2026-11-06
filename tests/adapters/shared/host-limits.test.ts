import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOST_LIMITS, hostLimitRows, hostLimitsOf, probeClosers, probeMisses, probeNames, splitRun } from '../../../src/adapters/shared/host-limits'

const REPO = join(import.meta.dir, '..', '..', '..')

const probe = (id: string) => {
  const p = HOST_LIMITS.find(l => l.id === id)?.probe
  if (p === undefined) throw new Error(`no probe for ${id}`)
  return p
}

const schema = (title: string, properties: Record<string, unknown>, definitions: Record<string, unknown> = {}) =>
  `{\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "definitions": ${JSON.stringify(definitions)},\n  "properties": ${JSON.stringify(properties)},\n  "title": "${title}",\n  "type": "object"\n}`

// The plugin detail field run of Codex 0.166.0 (0.162.1 still had `marketplaceNamemarketplacePathsummary` before `shareUrl`).
const CODEX_PLUGIN_DETAIL = 'displayOrderisManagedcurrentHashtrustStatusshareUrldescriptionskillsonboardingSkillhooksappsappTemplatesmcpServersscheduledTaskslocalrefNamenpmpackageversionshortDescriptioninterfaceremotePluginId'
// The `[tui]` config key run of Codex 0.166.0; one copy ends in `pet` instead of `theme`.
const CODEX_TUI_KEYS = 'mouse_scroll_speedcopy_on_selectcopy_on_select_clear_selectionright_click_pastestatus_linestatus_line_use_colorsterminal_titlethemepetpet_anchorsession_picker_view'
// The hook event enum of Codex 0.166.0 (HookEventsToml); shorter copies in the binary leave out PostModelRequest, UserPromptSubmit and Stop.
const CODEX_HOOK_EVENTS = 'struct HooksTomlHookEventsTomlPreModelRequestPostModelRequestPreToolUsePermissionRequestPostToolUsePreCompactPostCompactSessionStartSessionEndUserPromptSubmitSubagentStartSubagentStopStopInterruptcommandWindowstimeout'

/** For every limit and partial record: the test that proves its fallback works (most are cells of the parity test). */
const FALLBACK_TESTS: Readonly<Record<string, { file: string, title: string }>> = {
  'codex.consent-dialog': { file: 'tests/adapters/parity.test.ts', title: 'the immediate consent question on all four: the Claude mod, Codex\'s own approval prompt (an execpolicy prompt rule), the OpenCode TUI and the omp TUI' },
  'codex.background-wait': { file: 'tests/adapters/codex/hook.test.ts', title: 'block → {decision:"block", reason} only; the verdict runs under the state lock and `next` is persisted' },
  'codex.quiet-stop-feedback': { file: 'tests/adapters/codex/hook.test.ts', title: 'block → {decision:"block", reason} only; the verdict runs under the state lock and `next` is persisted' },
  'codex.shell-read-nudge': { file: 'tests/adapters/parity.test.ts', title: 'H03 shell nudges: a shell file write points to the edit tools on all four; a shell file print to the read tool where one exists (Codex has none)' },
  'codex.commands-without-turn': { file: 'tests/adapters/parity.test.ts', title: 'codex cannot register commands: its AGENTS block names the equivalents ($memory, the CLI twins, native /side)' },
  'codex.live-exec-mask': { file: 'tests/adapters/parity.test.ts', title: 'codex: a synchronous PostToolUse group of shell and MCP results runs the mask handler' },
  'codex.failed-mcp-mask': { file: 'tests/adapters/parity.test.ts', title: 'codex: a synchronous PostToolUse group of shell and MCP results runs the mask handler' },
  'codex.live-panes': { file: 'tests/usage/cli-statusline.test.ts', title: 'codex tmux: the running workflow of the Codex session goes into the one line (Codex has no band above the prompt)' },
  'codex.custom-status-line': { file: 'tests/core/status/layout.test.ts', title: 'codex: native footer and terminal title ids exist in codex 0.161.0' },
  'codex.summary-keep-list': { file: 'tests/adapters/parity.test.ts', title: 'workflow switches and review records (w3): H19 binds reports to the bound plans, H06/H07 carry the running reviewers, and the model-switch step names each harness\'s own command' },
  'opencode.consent-dialog': { file: 'tests/adapters/parity.test.ts', title: 'the immediate consent question on all four: the Claude mod, Codex\'s own approval prompt (an execpolicy prompt rule), the OpenCode TUI and the omp TUI' },
  'opencode.approved-plan-capture': { file: 'tests/adapters/parity.test.ts', title: 'H12 saves an approved native plan on Claude Code, Codex and omp; OpenCode has no approval step, so it saves a draft (approved: false)' },
  'opencode.native-plan-approval': { file: 'tests/adapters/parity.test.ts', title: 'native plan mode (w4): every H12 path fills a prepared plan-build plan, each harness has its way into plan mode, and leaving plan mode approves the plan everywhere but OpenCode' },
  'opencode.todo-handoff': { file: 'tests/adapters/opencode/plugin.test.ts', title: 'compaction saves a handoff and steers the summary; compaction.ended spools it and restores the plan' },
  'opencode.goal-command': { file: 'tests/adapters/parity.test.ts', title: 'goal-build\'s portable brief opens with the native /goal command on Claude Code, Codex and omp; OpenCode has none' },
  'opencode.quiet-stop-feedback': { file: 'tests/adapters/opencode/plugin.test.ts', title: 'an unfinished plan is continued with the core reason, once per stop, until the chain cap and its one escalation' },
  'opencode.stop-veto': { file: 'tests/adapters/opencode/plugin.test.ts', title: 'an unfinished plan is continued with the core reason, once per stop, until the chain cap and its one escalation' },
  'opencode.subagent-stop-hold': { file: 'tests/adapters/opencode/routing.test.ts', title: 'an invalid report asks the orchestrator to continue that reviewer once; a second one only warns; a valid one adds nothing' },
  'opencode.rate-windows': { file: 'tests/adapters/parity.test.ts', title: '5-hour and weekly usage windows on all four; OpenCode reads them from provider responses (the server plugin bundle\'s http.response hook)' },
  'omp.companion-shell': { file: 'tests/adapters/parity.test.ts', title: 'second opinion (plan.reviews.companion): every host can run it read-only; omp runs it without a shell, with the diff in its prompt' },
}

describe('host limits (PARITY-10)', () => {
  test('the OpenCode trigger probe reads the minified trigger calls and flags a stop or subagent hook', () => {
    const today = 'yield*e.trigger("session","http.response",{...y});e.trigger("tool","execute.after",x);e.trigger("tool","execute.before",x);e.trigger("permission","evaluate",p)'
    expect(probeNames(today, probe('opencode.stop-veto'))).toEqual(['permission.evaluate', 'session.http.response', 'tool.execute.after', 'tool.execute.before'])
    expect(probeMisses(today, probe('opencode.stop-veto'))).toEqual([])
    expect(probeClosers(today, probe('opencode.stop-veto'))).toEqual([])
    const newer = `${today};e.trigger("session","stop",{...y});e.trigger("session","subagent.stop",z)`
    expect(probeClosers(newer, probe('opencode.stop-veto'))).toEqual(['session.stop'])
    expect(probeClosers(newer, probe('opencode.subagent-stop-hold'))).toEqual(['session.subagent.stop'])
    expect(probeMisses('e.trigger("session","prompt",y)', probe('opencode.stop-veto'))).toEqual(['permission.evaluate', 'tool.execute.after', 'tool.execute.before'])
  })

  test('the list probes read the TUI\'s tool set and slash commands', () => {
    expect(probeClosers('PPt=new Set(["shell","glob","read","grep","edit","write"]);', probe('opencode.todo-handoff'))).toEqual([])
    expect(probeMisses('PPt=new Set(["shell","glob","read","grep","edit","write"]);', probe('opencode.todo-handoff'))).toEqual([])
    expect(probeClosers('PPt=new Set(["shell","glob","read","grep","todo","edit"]);', probe('opencode.todo-handoff'))).toEqual(['todo'])
    expect(probeClosers('slash:{name:"btw",arguments:!0} slash:{name:"goal"}', probe('opencode.goal-command'))).toEqual(['goal'])
  })

  test('the Codex plugin probe splits the field run of the plugin detail Codex reports, so it must find skills, hooks and MCP servers and flags any commands part', () => {
    const p = probe('codex.commands-without-turn')
    expect(probeNames(CODEX_PLUGIN_DETAIL, p)).toEqual(['appTemplates', 'apps', 'hooks', 'mcpServers', 'onboardingSkill', 'skills'])
    expect(probeNames(CODEX_PLUGIN_DETAIL, p)).toEqual(expect.arrayContaining(['skills', 'hooks', 'mcpServers']))
    expect(probeMisses(CODEX_PLUGIN_DETAIL, p)).toEqual([])
    expect(probeClosers(CODEX_PLUGIN_DETAIL, p)).toEqual([])
    expect(probeMisses('ignoring hooks: x ignoring mcpServers: y', p)).toEqual(['skills', 'onboardingSkill', 'hooks', 'apps', 'appTemplates', 'mcpServers'])
    expect(probeClosers(CODEX_PLUGIN_DETAIL.replace('hooksapps', 'hookscommandsapps'), p)).toEqual(['commands'])
    expect(probeClosers(CODEX_PLUGIN_DETAIL.replace('hooksapps', 'hooksslashCommandspromptsapps'), p)).toEqual(['slashCommandsprompts'])
    expect(splitRun('skillsfoohooks', ['skills', 'hooks'])).toEqual(['skills', 'foo', 'hooks'])
  })

  test('the Codex schema probes read the hook schemas embedded in the binary, by title, with the properties of their definitions', () => {
    const stopIn = schema('stop.command.input', { cwd: {}, last_assistant_message: {}, stop_hook_active: {}, turn_id: {} })
    const stopOut = schema('stop.command.output', { continue: {}, decision: {}, reason: {}, systemMessage: {} }, { BlockDecisionWire: { enum: ['block'] } })
    const preOut = schema('pre-tool-use.command.output', { hookSpecificOutput: {}, systemMessage: {} }, { PreToolUseHookSpecificOutputWire: { properties: { additionalContext: {}, permissionDecision: {} } } })
    const bin = `\u0000${stopIn}garbage${stopOut}\u0001${preOut}`
    expect(probeNames(bin, probe('codex.background-wait'))).toEqual(['cwd', 'last_assistant_message', 'stop_hook_active', 'turn_id'])
    expect(probeClosers(bin, probe('codex.background-wait'))).toEqual([])
    expect(probeNames(bin, probe('codex.quiet-stop-feedback'))).toEqual(['continue', 'decision', 'reason', 'systemMessage'])
    expect(probeMisses(bin, probe('codex.quiet-stop-feedback'))).toEqual([])
    expect(probeClosers(bin, probe('codex.quiet-stop-feedback'))).toEqual([])
    expect(probeNames(bin, probe('codex.live-panes'))).toEqual(['additionalContext', 'continue', 'decision', 'hookSpecificOutput', 'permissionDecision', 'reason', 'systemMessage'])
    expect(probeClosers(bin, probe('codex.live-panes'))).toEqual([])
    const newer = bin.replace('"stop_hook_active":{}', '"stop_hook_active":{},"background_tasks":{}').replace('"decision":{},"reason"', '"decision":{},"hookSpecificOutput":{},"reason"')
    expect(probeClosers(newer, probe('codex.background-wait'))).toEqual(['background_tasks'])
    expect(probeClosers(newer, probe('codex.quiet-stop-feedback'))).toEqual(['hookSpecificOutput'])
    expect(probeClosers(`${bin}${schema('notify.command.output', { statusLine: {} })}`, probe('codex.live-panes'))).toEqual(['statusLine'])
    expect(probeMisses('no schema here', probe('codex.background-wait'))).toEqual(['last_assistant_message', 'stop_hook_active', 'turn_id'])
  })

  test('the Codex status-line probe reads the [tui] key run and flags a status_line_command or status_line_script key', () => {
    const p = probe('codex.custom-status-line')
    expect(probeNames(CODEX_TUI_KEYS, p)).toEqual(['status_line', 'status_line_use_colors', 'terminal_title'])
    expect(probeMisses(CODEX_TUI_KEYS, p)).toEqual([])
    expect(probeClosers(CODEX_TUI_KEYS, p)).toEqual([])
    expect(probeNames(CODEX_TUI_KEYS.replace('terminal_titlethemepet', 'terminal_titlepet'), p)).toEqual(['status_line', 'status_line_use_colors', 'terminal_title'])
    expect(probeClosers(CODEX_TUI_KEYS.replace('status_linestatus_line_use_colors', 'status_linestatus_line_commandstatus_line_use_colors'), p)).toEqual(['_command'])
    expect(probeClosers(CODEX_TUI_KEYS.replace('terminal_titletheme', 'terminal_titlestatus_line_scripttheme'), p)).toEqual(['_script'])
    expect(probeMisses('codex.status_line and status_line_setup are no key run', p)).toEqual(['status_line', 'status_line_use_colors', 'terminal_title'])
  })

  test('the Codex hook-event probe reads the HookEventsToml enum and flags a failure event next to PostToolUse', () => {
    const p = probe('codex.failed-mcp-mask')
    expect(probeNames(CODEX_HOOK_EVENTS, p)).toEqual(['Interrupt', 'PermissionRequest', 'PostCompact', 'PostModelRequest', 'PostToolUse', 'PreCompact', 'PreModelRequest', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit'])
    expect(probeMisses(CODEX_HOOK_EVENTS, p)).toEqual([])
    expect(probeClosers(CODEX_HOOK_EVENTS, p)).toEqual([])
    const shorter = 'HookEventsTomlPreModelRequestPreToolUsePermissionRequestPostToolUsePreCompactPostCompactSessionStartSessionEndSubagentStartSubagentStopInterruptwritable_roots'
    expect(probeMisses(`${shorter}\u0000${CODEX_HOOK_EVENTS}`, p)).toEqual([])
    expect(probeMisses(shorter, p)).toEqual(['PostModelRequest', 'UserPromptSubmit', 'Stop'])
    expect(probeClosers(CODEX_HOOK_EVENTS.replace('PostToolUsePreCompact', 'PostToolUsePostToolUseFailurePreCompact'), p)).toEqual(['Failure'])
    expect(probeClosers(CODEX_HOOK_EVENTS.replace('SubagentStopStop', 'SubagentStopStopToolError'), p)).toEqual(['ToolError'])
  })

  test('every probe says what it must find on the version it was recorded on', () => {
    for (const l of HOST_LIMITS) if (l.probe !== undefined) expect({ id: l.id, expects: l.probe.expect.length > 0 }).toEqual({ id: l.id, expects: true })
  })

  test('every limit and partial record says where it was re-checked (a URL or a source file) and on which day', () => {
    for (const l of HOST_LIMITS.filter(l => l.kind !== 'native')) {
      const r = l.recheck ?? ''
      expect({ id: l.id, dated: /\b20\d\d-\d\d-\d\d\b/.test(r), sourced: /https?:\/\/\S+|\b[\w/-]+\.(?:rs|ts|md|mdx)\b/.test(r) }).toEqual({ id: l.id, dated: true, sourced: true })
    }
    expect(HOST_LIMITS.filter(l => l.kind !== 'native')).toHaveLength(20)
  })

  test('every limit and partial record names the test that proves its fallback, and that file holds the test', () => {
    const records = HOST_LIMITS.filter(l => l.kind !== 'native').map(l => l.id)
    expect(records.filter(id => FALLBACK_TESTS[id] === undefined)).toEqual([])
    expect(Object.keys(FALLBACK_TESTS).filter(id => !records.includes(id))).toEqual([])
    const texts = new Map<string, string>()
    for (const [id, { file, title }] of Object.entries(FALLBACK_TESTS)) {
      const text = texts.get(file) ?? readFileSync(join(REPO, file), 'utf8').replaceAll("\\'", "'")
      texts.set(file, text)
      expect({ id, file, found: text.includes(title) }).toEqual({ id, file, found: true })
    }
  })

  test('doctor rows: the summary row, then one ok row per limit with its fallback and the README pointer; no row warns; nothing for a harness without limits', () => {
    expect(hostLimitsOf('codex').map(l => l.id)).toEqual(expect.arrayContaining(['codex.live-exec-mask', 'codex.failed-mcp-mask', 'codex.custom-status-line']))
    const codex = hostLimitRows('codex')
    expect(codex[0]).toMatchObject({ level: 'ok', check: 'codex.limits' })
    expect(codex.slice(1).map(r => r.check)).toEqual(hostLimitsOf('codex').map(l => l.id))
    for (const r of codex.slice(1)) {
      expect({ check: r.check, level: r.level }).toEqual({ check: r.check, level: 'ok' })
      expect({ check: r.check, shape: /^.+\. Fallback: .+\. See the Host limits table in README\.md\.$/.test(r.detail) }).toEqual({ check: r.check, shape: true })
    }
    expect(codex.find(r => r.check === 'codex.commands-without-turn')?.detail).toContain('. Fallback: `$memory`, the CLI twins')
    expect(codex.filter(r => r.detail.includes('DESIGN'))).toEqual([])
    const opencode = hostLimitRows('opencode')
    expect([opencode[0]?.level, opencode[0]?.check]).toEqual(['ok', 'opencode.limits'])
    expect(opencode[0]?.detail).not.toMatch(/newer than/i)
    expect(opencode.map(r => r.level)).toEqual(opencode.map(() => 'ok'))
    expect(hostLimitRows('omp').map(r => r.check)).toEqual(['omp.limits', 'omp.companion-shell'])
    expect(hostLimitRows('claude')).toEqual([])
  })
})

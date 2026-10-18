import { describe, expect, test } from 'bun:test'
import type { Harness } from '../../../src/core/events'
import { HOST_LIMITS, hostLimitsOf, hostLimitsRow, probeClosers, probeMisses, probeNames, splitRun } from '../../../src/adapters/shared/host-limits'
import { compareVersions } from '../../../src/engine/update/versions'
import { TESTED_WITH } from '../../../src/engine/update/tested-with'

const probe = (id: string) => {
  const p = HOST_LIMITS.find(l => l.id === id)?.probe
  if (p === undefined) throw new Error(`no probe for ${id}`)
  return p
}

const schema = (title: string, properties: Record<string, unknown>, definitions: Record<string, unknown> = {}) =>
  `{\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "definitions": ${JSON.stringify(definitions)},\n  "properties": ${JSON.stringify(properties)},\n  "title": "${title}",\n  "type": "object"\n}`

const CODEX_PLUGIN_DETAIL = 'currentHashtrustStatusmarketplaceNamemarketplacePathsummaryshareUrldescriptionskillsonboardingSkillhooksappsappTemplatesmcpServersscheduledTaskslocalpathgiturl'

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

  test('every probe says what it must find on the version it was recorded on', () => {
    for (const l of HOST_LIMITS) if (l.probe !== undefined) expect({ id: l.id, expects: l.probe.expect.length > 0 }).toEqual({ id: l.id, expects: true })
  })

  test('the record moves with TESTED_WITH: a tested version newer than every checkedOn of a harness fails here before users see a re-probe warning', () => {
    for (const h of ['claude', 'codex', 'opencode', 'omp'] satisfies Harness[]) {
      const checked = HOST_LIMITS.filter(l => l.harness === h).map(l => l.checkedOn).sort(compareVersions).at(-1)
      if (checked === undefined) continue
      expect({ harness: h, recordBehindTested: compareVersions(TESTED_WITH[h].tested, checked) > 0 }).toEqual({ harness: h, recordBehindTested: false })
      expect(hostLimitsRow(h, TESTED_WITH[h].tested, 't.ts')?.level ?? 'ok').toBe('ok')
    }
  })

  test('doctor: listed as ok on the version they were recorded on, a warning to re-probe on a newer one; nothing for a harness without limits', () => {
    expect(hostLimitsOf('codex').map(l => l.id)).toEqual(expect.arrayContaining(['codex.live-exec-mask', 'codex.failed-mcp-mask', 'codex.custom-status-line']))
    expect(hostLimitsRow('codex', '0.162.1', 't.ts')).toMatchObject({ level: 'ok', check: 'codex.limits' })
    expect(hostLimitsRow('codex', undefined, 't.ts')?.level).toBe('ok')
    expect(hostLimitsRow('opencode', '2.1.0', 'tests/adapters/opencode/smoke.test.ts')?.detail).toContain('2.1.0 is newer than 2.0.30, where Buracle recorded')
    expect(hostLimitsRow('omp', '18.10.1', 't.ts')).toMatchObject({ level: 'ok', check: 'omp.limits', detail: expect.stringContaining('(companion-shell)') })
    expect(hostLimitsRow('claude', '9.0.0', 't.ts')).toBeUndefined()
  })
})

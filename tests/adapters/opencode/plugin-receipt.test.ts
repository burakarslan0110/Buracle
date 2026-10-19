import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { boardFile, NoticeReader, postNotice } from '../../../src/adapters/opencode/runtime/notice-board'
import { status, type UtilityHost } from '../../../src/adapters/opencode/runtime/tui-commands'
import { TuiNotices } from '../../../src/adapters/opencode/runtime/tui-notices'
import type { SessionHttpResponseEvent, ToolExecuteAfter, TuiToastVariant } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { BandView } from '../../../src/core/flow/band'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import { collectOpencode } from '../../../src/usage/opencode'
import { readTelemetry } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'
import { rateLimitHeaders } from './fake-provider'

const SID = 'ses_receipt01'
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

async function runtime(dir: string, clock: { now: number }) {
  const f = fakeServerContext(dir)
  const notified: string[] = []
  const deps: PluginDeps = {
    baked: testBaked(), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: (title, message) => { notified.push(`${title}: ${message}`) },
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd), now: () => clock.now,
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  await rt.handleEvent({ type: 'session.created', data: { sessionID: SID, location: { directory: dir } } })
  return { f, rt, notified }
}

async function prompt(rt: BuracleRuntime, text: string): Promise<void> {
  await rt.onPrompt({ sessionID: SID, messageID: `msg_${text.length}`, prompt: { text }, delivery: 'steer' })
}

async function endTurn(rt: BuracleRuntime, text: string): Promise<void> {
  await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
  await rt.handleEvent({ type: 'session.text.ended', data: { sessionID: SID, text } })
  await rt.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: SID } })
  await rt.idle()
}

function done(tool: string, input: Record<string, unknown>, output: unknown, id: string): ToolExecuteAfter {
  return { tool, sessionID: SID, agent: 'build', messageID: 'msg_1', id, input, status: 'completed', result: { output } }
}

function board(): string[] {
  const items: Array<{ text: string }> = existsSync(boardFile(SID)) ? (JSON.parse(readFileSync(boardFile(SID), 'utf8')) as { items: Array<{ text: string }> }).items : []
  return items.map(i => i.text)
}

describe('OpenCode turn receipt, loop alarms and the long-turn notification (PARITY-3)', () => {
  test('an unverified edit is posted for the TUI at the end of the turn; a passing check after it is not', () => withSandbox(async ({ root }) => {
    const clock = { now: NOW }
    const { rt, notified } = await runtime(root, clock)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2\n')
    await prompt(rt, 'change a')
    await rt.onToolAfter(done('edit', { filePath: join(root, 'src', 'a.ts'), oldString: 'export const a = 1', newString: 'export const a = 2' }, { diff: '' }, 'c1'))
    await endTurn(rt, 'It works now.')
    expect(board()).toEqual(['Buracle · 1 file (+1 −1) · ⚠ success claimed without evidence: no test or check ran after the change'])
    await prompt(rt, 'again')
    await rt.onToolAfter(done('edit', { filePath: join(root, 'src', 'a.ts'), oldString: 'export const a = 2', newString: 'export const a = 3' }, { diff: '' }, 'c2'))
    await rt.onToolAfter(done('shell', { command: 'bun test' }, { output: '3 pass', exit: 0 }, 'c3'))
    await endTurn(rt, 'Tests pass.')
    expect(board()).toHaveLength(1)
    expect(notified).toEqual([])
  }))

  test('the third identical failing command posts a loop alarm right away; a subagent\'s commands never count', () => withSandbox(async ({ root }) => {
    const { f, rt } = await runtime(root, { now: NOW })
    await prompt(rt, 'fix it')
    f.parents['ses_child01'] = SID
    await rt.handleEvent({ type: 'session.created', data: { sessionID: 'ses_child01', parentID: SID, location: { directory: root } } })
    for (const id of ['s1', 's2', 's3']) await rt.onToolAfter({ ...done('shell', { command: 'bun test' }, { output: '1 fail', exit: 1 }, id), sessionID: 'ses_child01' })
    for (const id of ['f1', 'f2']) await rt.onToolAfter(done('shell', { command: 'bun test' }, { output: '1 fail', exit: 1 }, id))
    expect(board()).toEqual([])
    await rt.onToolAfter(done('shell', { command: 'bun test' }, { output: '1 fail', exit: 1 }, 'f3'))
    expect(board()).toEqual(['Buracle: the same command failed 3 times in a row: `bun test` (do not run it again as is; read the output and change your hypothesis)'])
  }))

  test('a turn longer than workflow.notifyAfterSec sends one desktop notification', () => withSandbox(async ({ root }) => {
    const clock = { now: NOW }
    const { rt, notified } = await runtime(root, clock)
    await prompt(rt, 'long work')
    clock.now = NOW + 4 * 60_000
    await endTurn(rt, 'Here is the summary.')
    expect(notified).toEqual(['Buracle: Turn finished after 4 min'])
    clock.now += 5 * 60_000
    await endTurn(rt, 'A stop-guard continuation ended.')
    expect(notified).toHaveLength(1)
  }))

  test('a turn that fails is reported with its notification; an interrupted one is reported without it; neither reads an old answer as a success claim', () => withSandbox(async ({ root }) => {
    const clock = { now: NOW }
    const { rt, notified } = await runtime(root, clock)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2\n')
    await rt.handleEvent({ type: 'session.text.ended', data: { sessionID: SID, text: 'All done, it works.' } })
    await prompt(rt, 'change a')
    await rt.onToolAfter(done('edit', { filePath: join(root, 'src', 'a.ts'), oldString: 'export const a = 1', newString: 'export const a = 2' }, { diff: '' }, 'c1'))
    clock.now = NOW + 4 * 60_000
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.failed', data: { sessionID: SID } })
    await rt.idle()
    expect(board()).toEqual(['Buracle · 1 file (+1 −1) · ⚠ unverified change'])
    expect(notified).toEqual(['Buracle: Turn finished after 4 min'])
    await prompt(rt, 'change it again')
    await rt.onToolAfter(done('edit', { filePath: join(root, 'src', 'a.ts'), oldString: 'export const a = 2', newString: 'export const a = 3' }, { diff: '' }, 'c2'))
    clock.now += 4 * 60_000
    await rt.handleEvent({ type: 'session.execution.started', data: { sessionID: SID } })
    await rt.handleEvent({ type: 'session.execution.interrupted', data: { sessionID: SID } })
    await rt.idle()
    expect(board()).toEqual(['Buracle · 1 file (+1 −1) · ⚠ unverified change', 'Buracle · 1 file (+1 −1) · ⚠ unverified change'])
    expect(notified).toHaveLength(1)
  }))
})

describe('OpenCode masks secrets in a failed tool call too', () => {
  test('the error the host hands back to the model after tool.execute.after is masked in place, its cause as well', () => withSandbox(async ({ root }) => {
    const { rt } = await runtime(root, { now: NOW })
    const secret = 'AKIA' + 'IOSFODNN7EXAMPLE'
    const cause = new Error(`upstream said: key ${secret}`)
    const error = Object.assign(new Error(`MCP error: aws_access_key_id=${secret}`), { error: cause })
    const failed: ToolExecuteAfter = { tool: 'execute', sessionID: SID, agent: 'build', messageID: 'msg_1', id: 'm1', input: { code: 'x' }, status: 'error', error }
    await rt.onToolAfter(failed)
    expect(failed.status === 'error' ? failed.error : undefined).toBe(error)
    expect(error.message).not.toContain(secret)
    expect(cause.message).not.toContain(secret)
    expect(error.message).toContain('MCP error:')
  }))
})

describe('OpenCode 5-hour and weekly windows from provider responses (PARITY-5)', () => {
  test('http.response: the headers become the session telemetry\'s windows without the body being read; `buracle usage` reports them', () => withSandbox(async ({ root }) => {
    const clock = { now: Date.now() }
    const { f } = await runtime(root, clock)
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({ pull() { pulled++ } })
    const response = new Response(body, { headers: rateLimitHeaders(clock.now) })
    const event: SessionHttpResponseEvent = { sessionID: SID, kind: 'primary', response }
    await f.trigger('session.http.response', event)
    expect(response.bodyUsed).toBe(false)
    expect(body.locked).toBe(false)
    expect(pulled).toBeLessThanOrEqual(1)
    const until = Date.now() + 2_000
    while (readTelemetry('opencode', SID)?.windows === undefined && Date.now() < until) await Bun.sleep(5)
    expect(readTelemetry('opencode', SID)?.windows?.map(w => `${w.label} ${w.pct}`)).toEqual(['5h 42', '7d 18'])
    const usage = await collectOpencode({ nowMs: clock.now, pricing: {} })
    expect(usage.windows.map(w => w.label)).toEqual(['5h', '7d'])
  }))

  test('the Codex backend\'s websocket rate-limit event fills the windows too; other frames and API-key responses leave them empty', () => withSandbox(async ({ root }) => {
    const clock = { now: Date.now() }
    const { f } = await runtime(root, clock)
    await f.trigger('session.http.response', { sessionID: SID, response: new Response('{}', { headers: { 'x-ratelimit-remaining-requests': '99' } }) })
    await f.trigger('session.experimental.ws.receive', { sessionID: SID, frame: '{"type":"response.output_text.delta","delta":"hi"}' })
    await Bun.sleep(20)
    expect(readTelemetry('opencode', SID)?.windows).toBeUndefined()
    const reset = Math.floor(clock.now / 1000) + 3_600
    const frame = JSON.stringify({ type: 'codex.rate_limits', rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, reset_at: reset }, secondary: { used_percent: 40, window_minutes: 10080, reset_at: reset + 86_400 } } })
    await f.trigger('session.experimental.ws.receive', { sessionID: SID, frame: new TextEncoder().encode(frame) })
    const until = Date.now() + 2_000
    while (readTelemetry('opencode', SID)?.windows === undefined && Date.now() < until) await Bun.sleep(5)
    expect(readTelemetry('opencode', SID)?.windows?.map(w => `${w.label} ${w.pct}`)).toEqual(['5h 12.5', '7d 40'])
  }))
})

describe('the OpenCode TUI side: notices, the resume hint and the live panes (PARITY-3, PARITY-M1)', () => {
  test('the TUI shows each posted notice once, and a fresh TUI shows only recent ones', () => withSandbox(async () => {
    const toasts: Array<{ message: string, variant: TuiToastVariant }> = []
    let now = NOW
    const hidden: BandView = { visible: false, breadcrumb: [], status: 'running', phases: [], agents: [] }
    const notices = new TuiNotices({ now: () => now, toast: (message, variant) => { toasts.push({ message, variant }) }, band: () => hidden, bandOn: () => true, busy: () => false })
    postNotice(SID, 'old notice', 'warning', NOW - 60_000)
    postNotice(SID, 'Buracle · 1 file (+1 −1) · ⚠ unverified change', 'warning', NOW)
    expect(notices.poll(SID)).toBe(1)
    expect(notices.poll(SID)).toBe(0)
    now += 1_000
    postNotice(SID, 'Buracle: loop alarm', 'warning', now)
    notices.poll(SID)
    expect(toasts.map(t => t.message)).toEqual(['Buracle · 1 file (+1 −1) · ⚠ unverified change', 'Buracle: loop alarm'])
    expect(new NoticeReader().take(SID, now + 120_000)).toEqual([])
  }))

  test('opening a session with an unfinished run suggests continuing it once; a busy or finished one gets nothing, and workflow.band false turns the hint off as on Claude Code and Codex', () => {
    const toasts: string[] = []
    const paused: BandView = { visible: true, workflow: 'plan-build', breadcrumb: ['plan-build'], status: 'paused', phases: [{ id: 'build', label: 'Build', short: 'Build', state: 'current' }], agents: [], title: 'Add login' }
    const done: BandView = { ...paused, status: 'done' }
    let bandOn = true
    const notices = new TuiNotices({ now: () => NOW, toast: m => { toasts.push(m) }, band: sid => (sid === 'ses_done' ? done : paused), bandOn: () => bandOn, busy: sid => sid === 'ses_busy' })
    expect(notices.sessionShown(SID)).toBe(true)
    expect(notices.sessionShown(SID)).toBe(false)
    expect(notices.sessionShown('ses_busy')).toBe(false)
    expect(notices.sessionShown('ses_done')).toBe(false)
    bandOn = false
    expect(notices.sessionShown('ses_other')).toBe(false)
    expect(toasts).toEqual(['This session has an unfinished workflow run (plan-build (Add login): phase Build, paused). To go on, say: continue the plan-build run (Build): Add login'])
  })

  test('/buracle-status memory and plan open a live pane when the TUI can show one; otherwise the one-shot dialog', () => withSandbox(async () => {
    const hidden: BandView = { visible: false, breadcrumb: [], status: 'running', phases: [], agents: [] }
    const panes: Array<{ title: string, lines: () => string[] }> = []
    const alerts: string[] = []
    const base: UtilityHost = {
      cli: () => ['/shim'], run: async () => ({ code: 0, stdout: '', stderr: '' }), cfg: () => testBaked().defaults, sessionID: () => SID,
      toast: () => undefined, alert: async title => { alerts.push(title) }, band: () => hidden,
      about: () => ({ testedWith: '2.0.30', workflows: [] }), slashCommand: () => undefined,
    }
    await status({ ...base, pane: (title, lines) => { panes.push({ title, lines }); return true } }, 'memory')
    await status({ ...base, pane: (title, lines) => { panes.push({ title, lines }); return true } }, 'plan')
    expect(panes.map(p => p.title)).toEqual(['Buracle memory', 'Buracle plan'])
    expect(panes[0]?.lines()[0]).toBe('No memory status yet.')
    expect(panes[1]?.lines()[0]).toBe('No plan is bound to this session.')
    expect(alerts).toEqual([])
    await status({ ...base, pane: () => false }, 'plan')
    await status(base, 'memory')
    expect(alerts).toEqual(['Buracle plan', 'Buracle memory'])
  }))
})

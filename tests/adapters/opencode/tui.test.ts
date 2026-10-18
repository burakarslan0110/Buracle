import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bandLines, BandFeeder, estimatedWidth } from '../../../src/adapters/opencode/runtime/band'
import { workflowCommandDescription, workflowPromptText } from '../../../src/adapters/opencode/runtime/commands'
import { projectDeps } from '../../../src/adapters/opencode/runtime/deps'
import { applyEffort, effortLevel } from '../../../src/adapters/opencode/runtime/effort'
import { reviewProblems, subagentReport } from '../../../src/adapters/opencode/runtime/review'
import { commandOfPrompt, COMMAND_ARGS, COMMAND_MARK, routeUserPrompt, withinBudget } from '../../../src/adapters/opencode/runtime/routing'
import type { CliResult, UtilityHost } from '../../../src/adapters/opencode/runtime/tui-commands'
import { aside, brain, ping, remember, status, statusLines, utilityCommands, utilityNames } from '../../../src/adapters/opencode/runtime/tui-commands'
import type { BandView } from '../../../src/core/flow/band'
import { flowPath } from '../../../src/workflow/flow'
import { withSandbox } from '../../helpers/sandbox'
import { fakeModelEditor, testBaked } from './helpers'

function writeFlowRecord(sid: string, stack: unknown[]): void {
  mkdirSync(join(flowPath('opencode', sid), '..'), { recursive: true })
  writeFileSync(flowPath('opencode', sid), JSON.stringify({ v: 1, stack, updatedAt: Date.now() }))
}

describe('the workflow band (band.ts)', () => {
  test('the slot width before it is measured: the main column (terminal minus padding, minus the sidebar above 120 columns)', () => {
    expect([70, 100, 140, 200].map(estimatedWidth)).toEqual([66, 96, 94, 154])
    expect(estimatedWidth(Number.NaN)).toBe(0)
  })

  test('a running workflow becomes rows fitted to the width; an ended one folds after foldAfterSec', () => withSandbox(async () => {
    let now = 1_000_000
    const feeder = new BandFeeder(() => now)
    const sid = 'ses_band01'
    writeFlowRecord(sid, [{ workflow: 'bugfix', title: 'login fails with SSO', source: 'command', startedAt: now - 90_000, phase: { id: 'red', since: now - 30_000 } }])
    const view = feeder.view(sid, 8)
    expect(view).toMatchObject({ visible: true, workflow: 'bugfix', status: 'running', title: 'login fails with SSO' })
    expect(view.phases.find(p => p.state === 'current')?.id).toBe('red')
    for (const width of [154, 66, 40]) {
      const rows = bandLines(view, width)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.length).toBeLessThanOrEqual(3)
      for (const row of rows) expect(row.reduce((n, s) => n + [...s.text].length, 0)).toBeLessThanOrEqual(width)
    }
    expect(bandLines(view, 20)).toEqual([])
    writeFlowRecord(sid, [{ workflow: 'bugfix', title: 'login fails with SSO', source: 'command', startedAt: now - 90_000, ended: { outcome: 'done', at: now } }])
    expect(feeder.view(sid, 8)).toMatchObject({ visible: true, status: 'done' })
    now += 9_000
    expect(feeder.view(sid, 8).visible).toBe(false)
  }))

  test('no session, an invalid id or no record: nothing to draw', () => withSandbox(async () => {
    const feeder = new BandFeeder()
    expect(feeder.view(undefined, 8).visible).toBe(false)
    expect(feeder.view('../x', 8).visible).toBe(false)
    expect(feeder.view('ses_none', 8).visible).toBe(false)
  }))
})

interface Recorded {
  toasts: Array<{ message: string, variant: string }>
  alerts: Array<{ title: string, message: string }>
  runs: string[][]
  btw: string[]
}

function host(over: Partial<UtilityHost> & { result?: CliResult } = {}): UtilityHost & Recorded {
  const rec: Recorded = { toasts: [], alerts: [], runs: [], btw: [] }
  const hidden: BandView = { visible: false, breadcrumb: [], status: 'running', phases: [], agents: [] }
  return {
    ...rec,
    cli: () => ['/shim'],
    run: async argv => { rec.runs.push(argv); return over.result ?? { code: 0, stdout: '', stderr: '' } },
    cfg: () => testBaked().defaults,
    sessionID: () => 'ses_tui01',
    toast: (message, variant) => { rec.toasts.push({ message, variant }) },
    alert: async (title, message) => { rec.alerts.push({ title, message }) },
    band: () => hidden,
    about: () => ({ opencode: '2.0.24', testedWith: '2.0.24', workflows: ['goal-build', 'plan-build'] }),
    slashCommand: name => (name === 'btw' ? (input: string) => { rec.btw.push(input) } : undefined),
    ...over,
  }
}

describe('the utility commands (tui-commands.ts): no model turn, output as a toast or a dialog', () => {
  test('/remember passes the text after `--` (a note that starts like a flag stays text) and reports the result', async () => {
    const h = host({ result: { code: 0, stdout: 'saved as a capture: person/capture-force-is-never-ok-on-main (the next harness files it)\n', stderr: '' } })
    await remember(h, '--force is never ok on main')
    expect(h.runs).toEqual([['/shim', 'mem', 'remember', '--', '--force is never ok on main']])
    expect(h.toasts).toEqual([{ message: 'Remembered: person/capture-force-is-never-ok-on-main', variant: 'success' }])
    const failed = host({ result: { code: 2, stdout: '', stderr: 'CortexDB is not installed\n' } })
    await remember(failed, 'x')
    expect(failed.toasts).toEqual([{ message: 'Not saved (exit code 2): CortexDB is not installed', variant: 'error' }])
  })

  test('/remember without text or without the CLI says what to do', async () => {
    const h = host()
    await remember(h, '   ', 'buracle-remember')
    expect(h.toasts).toEqual([{ message: 'Usage: /buracle-remember <text>', variant: 'warning' }])
    const none = host({ cli: () => undefined })
    await remember(none, 'x')
    expect(none.toasts[0]?.message).toContain('run `buracle install` first')
    expect(none.runs).toEqual([])
  })

  test('/brain opens the memory web UI (or says it is off)', async () => {
    const h = host({ result: { code: 0, stdout: JSON.stringify({ url: 'http://localhost:41777' }), stderr: '' } })
    await brain(h)
    expect(h.runs).toEqual([['/shim', 'mem', 'ui', '--open', '--json']])
    expect(h.toasts).toEqual([{ message: 'Memory UI: http://localhost:41777', variant: 'success' }])
    const r = host({ result: { code: 0, stdout: JSON.stringify({ url: 'http://localhost:41777', page: 'http://localhost:41777/review' }), stderr: '' } })
    await brain(r, ' review ')
    await brain(r, 'graph')
    expect(r.runs).toEqual([['/shim', 'mem', 'ui', '--open', '--page', 'review', '--json']])
    expect(r.toasts).toEqual([{ message: 'Review page: http://localhost:41777/review', variant: 'success' }, { message: 'Usage: /brain [review]', variant: 'warning' }])
  })

  test('/buracle-status shows the session\'s state in a dialog: status, flow, plan, memory; anything else gets the usage', () => withSandbox(async () => {
    const running: BandView = { visible: true, workflow: 'plan-build', breadcrumb: ['plan-build'], status: 'running', phases: [{ id: 'plan', label: 'Plan', short: 'Plan', state: 'current' }], agents: [], title: 'Rate limit' }
    const h = host({ band: () => running })
    await status(h, '')
    expect(h.alerts[0]?.title).toBe('Buracle status')
    expect(h.alerts[0]?.message).toContain('Buracle on OpenCode 2.0.24 (tested with 2.0.24)')
    expect(h.alerts[0]?.message).toContain('default effort: xhigh (effort.opencode auto)')
    expect(h.alerts[0]?.message).toContain('workflows: /goal-build /plan-build')
    await status(h, 'flow')
    expect(h.alerts[1]).toMatchObject({ title: 'Buracle workflow' })
    expect(h.alerts[1]?.message).toContain('plan-build · Rate limit · running')
    await status(h, 'plan')
    expect(h.alerts[2]?.message).toContain('No plan is bound to this session.')
    await status(h, 'memory')
    expect(h.alerts[3]?.message).toContain('No memory status yet.')
    await status(h, 'nonsense')
    expect(h.toasts).toEqual([{ message: 'Usage: /buracle-status [status|memory|plan|flow]', variant: 'warning' }])
    expect(statusLines(h).every(l => !/[çğıöşüÇĞİÖŞÜ]/.test(l))).toBe(true)
  }))

  test('/aside hands the question to OpenCode\'s /btw (a side answer that never joins the session); without a question /btw asks for one', async () => {
    const h = host()
    await aside(h, '  why is the build slow?  ')
    await aside(h, undefined)
    expect(h.btw).toEqual(['why is the build slow?', ''])
    expect(h.toasts).toEqual([])
    expect(h.runs).toEqual([])
    const none = host({ slashCommand: () => undefined })
    await aside(none, 'x', 'buracle-aside')
    expect(none.toasts).toEqual([{ message: "/buracle-aside hands the question to OpenCode's /btw, which this OpenCode does not offer to plugins: type /btw <question>.", variant: 'warning' }])
  })

  test('/buracle-ping answers pong, without the CLI or a model turn', () => {
    const h = host()
    ping(h)
    expect(h.toasts).toEqual([{ message: 'pong', variant: 'success' }])
    expect(h.runs).toEqual([])
  })

  test('names: remember, brain and aside move to buracle-* and the /buracle alias is left out while another command has the name; every command takes arguments', async () => {
    expect(utilityNames(new Set())).toEqual({ remember: 'remember', brain: 'brain', aside: 'aside', status: 'buracle-status', statusAliases: ['buracle'], ping: 'buracle-ping' })
    expect(utilityNames(new Set(['remember', 'brain', 'aside', 'buracle']))).toEqual({
      remember: 'buracle-remember', brain: 'buracle-brain', aside: 'buracle-aside', status: 'buracle-status', statusAliases: [], ping: 'buracle-ping',
    })
    const h = host({ run: async () => { throw new Error('spawn failed') } })
    const cmds = utilityCommands(h, utilityNames(new Set()))
    expect(cmds.map(c => [c.id, c.slash])).toEqual([
      ['buracle.remember', { name: 'remember', arguments: true }],
      ['buracle.brain', { name: 'brain', arguments: true }],
      ['buracle.aside', { name: 'aside', arguments: true }],
      ['buracle.status', { name: 'buracle-status', aliases: ['buracle'], arguments: true }],
      ['buracle.ping', { name: 'buracle-ping', arguments: true }],
    ])
    expect(utilityCommands(h, utilityNames(new Set(['buracle']))).find(c => c.id === 'buracle.status')?.slash).toEqual({ name: 'buracle-status', arguments: true })
    await cmds[0]?.run('note')
    expect(h.toasts).toEqual([{ message: '/remember failed: spawn failed', variant: 'error' }])
    const broken = host({ slashCommand: () => () => { throw new Error('dispatch failed') } })
    await utilityCommands(broken, utilityNames(new Set())).find(c => c.id === 'buracle.aside')?.run('q')
    expect(broken.toasts).toEqual([{ message: '/aside failed: dispatch failed', variant: 'error' }])
    const fresh = host()
    const own = utilityCommands(fresh, utilityNames(new Set()))
    await own.find(c => c.id === 'buracle.ping')?.run('')
    await own.find(c => c.id === 'buracle.aside')?.run(' q ')
    expect({ toasts: fresh.toasts, btw: fresh.btw, runs: fresh.runs }).toEqual({ toasts: [{ message: 'pong', variant: 'success' }], btw: ['q'], runs: [] })
  })
})

describe('pure helpers of the server plugin', () => {
  test('a workflow command\'s prompt is recognized by its metadata, and by its closing note when the host drops metadata', () => {
    const text = workflowPromptText('plan-build', 'add rate limiting\nper user', true)
    expect(text).toBe('add rate limiting\nper user\n\n(Run this with the Buracle plan-build workflow: its skill is attached above; follow it.)')
    expect(commandOfPrompt({ [COMMAND_MARK]: 'plan-build', [COMMAND_ARGS]: 'add rate limiting\nper user' }, text)).toEqual({ command: 'plan-build', args: 'add rate limiting\nper user' })
    expect(commandOfPrompt(undefined, text)).toEqual({ command: 'plan-build', args: 'add rate limiting\nper user' })
    expect(commandOfPrompt(undefined, workflowPromptText('bugfix', '', false))).toEqual({ command: 'bugfix', args: '' })
    expect(commandOfPrompt(undefined, 'please run this with the plan-build workflow')).toBeUndefined()
    expect(workflowCommandDescription({ id: 'x', short: '  Plan,  build ', description: 'Long. More.' })).toBe('Plan, build')
    expect(workflowCommandDescription({ id: 'x', description: 'First sentence here. Second.' })).toBe('First sentence here.')
  })

  test('routing.skills off: no skill loads or candidates, the memory line stays; a workflow command still loads its own skill', () => {
    const baked = testBaked()
    const cfg = { routing: { ...baked.defaults.routing, skills: 'off' as const } }
    const base = { attached: [], loaded: [], available: ['buracle-memory'], known: new Set(['research', 'plan-build']) }
    const r = routeUserPrompt({ ...base, text: 'use the research skill; what did we decide last time?' }, baked, cfg)
    expect(r.attach).toEqual([])
    expect(r.text).toContain('Earlier work: search memory first')
    expect(r.text).not.toContain('research')
    const c = routeUserPrompt({ ...base, text: 'add rate limiting', command: 'plan-build' }, baked, cfg)
    expect(c.attach).toEqual(['plan-build'])
    expect(c.workflows).toEqual(['plan-build'])
  })

  test('project dependencies come from the root\'s manifests and are read again only when one changes', () => withSandbox(async ({ root }) => {
    expect(projectDeps(undefined)).toEqual([])
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { zod: '^4.0.0' }, devDependencies: { typescript: '6.0.3' } }))
    expect(projectDeps(root)).toEqual(['typescript', 'zod'])
    writeFileSync(join(root, 'requirements.txt'), 'requests==2.32.0\n')
    expect(projectDeps(root)).toEqual(['requests', 'typescript', 'zod'])
    writeFileSync(join(root, 'package.json'), '{ not json')
    expect(projectDeps(root)).toEqual(['requests'])
  }))

  test('an npm workspace contributes its members\' dependencies, as on every other harness', () => withSandbox(async ({ root }) => {
    mkdirSync(join(root, 'packages', 'app'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'], devDependencies: { turbo: '2', typescript: '6' } }))
    writeFileSync(join(root, 'packages', 'app', 'package.json'), JSON.stringify({ dependencies: { 'lodash-es': '4', zod: '4' } }))
    expect(projectDeps(root)).toEqual(['lodash-es', 'turbo', 'typescript', 'zod'])
  }))

  test('the per-prompt budget keeps the first part and drops what overflows', () => {
    expect(withinBudget(['a'.repeat(10), undefined, '', 'b'.repeat(5)], 20)).toEqual(['a'.repeat(10), 'b'.repeat(5)])
    expect(withinBudget(['a'.repeat(30), 'b'], 20)).toEqual(['a'.repeat(30)])
  })

  test('effort.opencode: auto is xhigh, keep and invalid values write nothing; the overlay of that variant becomes the default', () => {
    const cfg = (opencode: string) => ({ effort: { claude: 'auto', codex: 'auto', opencode, omp: 'auto' } })
    expect(effortLevel(cfg('auto'))).toBe('xhigh')
    expect(effortLevel(cfg('max'))).toBe('max')
    expect(effortLevel(cfg('keep'))).toBeUndefined()
    expect(effortLevel(cfg('ultra'))).toBeUndefined()
    const editor = fakeModelEditor([
      { id: 'a', providerID: 'p', settings: { effort: 'low', other: 1 }, headers: { x: '1' }, variants: [{ id: 'max', settings: { effort: 'max' }, headers: { y: '2' } }] },
      { id: 'b', providerID: 'p' },
    ])
    expect(applyEffort(editor, 'max')).toEqual(['p/a'])
    expect(editor.models[0]).toMatchObject({ settings: { effort: 'max', other: 1 }, headers: { x: '1', y: '2' } })
  })

  test('H19 reads the reviewer\'s report from the result (output first, the <subagent> text as a fallback)', () => {
    expect(subagentReport({ agent: 'build' }, { output: { output: 'x' } })).toBeUndefined()
    expect(subagentReport({ agent: 'changes-review' }, { output: { status: 'running', output: 'x' } })).toBeUndefined()
    expect(subagentReport({ agent: 'changes-review' }, { content: [{ type: 'text', text: '<subagent sessionID="ses_9" state="completed">\nnot json\n</subagent>' }] }))
      .toEqual({ agent: 'changes-review', sessionID: 'ses_9', text: 'not json' })
    expect(reviewProblems({ agent: 'changes-review', text: 'not json' })).toEqual(['the final message is not valid JSON'])
  })
})

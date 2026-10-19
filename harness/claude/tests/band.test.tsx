import type { On, SessionStartInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const HOME = '/home/tester'
const BURACLE_HOME = `${HOME}/.buracle`
const CWD = `${HOME}/work/app`
const SID = 'sess-band'
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0)
const DIR = `${BURACLE_HOME}/sessions/claude/${SID}`
const RUNTIME = `${BURACLE_HOME}/state/runtime-config.json`
const STATE = `${DIR}/state.json`
const FLOW = `${DIR}/flow.json`
const PLAN = `${CWD}/docs/plans/2026-10-09-rate-limit.md`
const SESSION: SessionStartInput = { cwd: CWD, surface: 'terminal', isInteractive: true }
const BAND = { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} }
const SURFACES = ['terminal', 'desktop'] as const

interface World {
  files: Map<string, string>
  opened: string[]
  notified: string[]
  suggested: string[]
  agents: Array<{ id: string, type: string, description: string, status: 'running' | 'completed' }>
  clock: ReturnType<typeof mock.clock>
  flow: () => { stack: Array<{ workflow: string, source: string, title?: string }> }
}

function worldOf(on: On, files: Record<string, string> = {}, config: Record<string, unknown> = {}): World {
  const world: World = {
    files: new Map(Object.entries({ [RUNTIME]: JSON.stringify({ v: 1, config, resolved: { buracleHome: BURACLE_HOME, vault: `${HOME}/vault`, shim: `${BURACLE_HOME}/bin/buracle` } }), ...files })),
    opened: [], notified: [], suggested: [], agents: [],
    clock: mock.clock(on, { now: NOW }),
    flow: () => JSON.parse(world.files.get(FLOW) ?? '{"stack":[]}') as { stack: Array<{ workflow: string, source: string, title?: string }> },
  }
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.read', ($, e) => {
    const text = world.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', ($, e) => { world.files.set(e.path, e.text); return { value: undefined } })
  on('fs.exists', ($, e) => ({ value: world.files.has(e.path) }))
  on('fs.stat', ($, e) => {
    const text = world.files.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: { kind: 'file' as const, size: text.length, mtimeMs: text.length, isLink: false } }
  })
  on('session.id', () => ({ value: SID }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.notice', () => ({ value: undefined }))
  on('ui.open', ($, e) => { world.opened.push(e.id); return { value: { isPlaced: true as const } } })
  on('ui.notify', ($, e) => { world.notified.push(e.text); return { value: { isSent: true as const, channel: 'terminal_bell' } } })
  on('prompt.suggest', ($, e) => { world.suggested.push(e.text); return { isShown: true } })
  on('agent.list', () => ({ value: world.agents }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.call', ($, e) => {
    if (e.tool === 'TodoWrite') return { result: { oldTodos: [], newTodos: (e as unknown as { todos: unknown[] }).todos } as never }
    if (e.tool === 'Agent') return { result: { agentId: 'agent-7', content: [], totalToolUseCount: 0, totalDurationMs: 0 } as never }
    return { result: { stdout: 'ok', stderr: '', interrupted: false } as never }
  })
  return world
}

function planState(phase: string, status = 'IN_PROGRESS'): string {
  return JSON.stringify({ v: 1, plan: { path: PLAN, slug: 'rate-limit', status, type: 'Feature', phase, registeredAt: NOW - 600_000 }, guard: { blocksForPlan: 0, blocksInChain: 0 }, approvals: { planApprovedAt: NOW - 500_000 } })
}

function planText(done: number, total: number): string {
  const tasks: string[] = []
  for (let i = 1; i <= total; i++) tasks.push(`### Task ${i}: Step ${i}`, '', `**Objective:** Step ${i}.`, '', `- [${i <= done ? 'x' : ' '}] Task ${i} done`, '')
  return ['---', 'created: 2026-10-09', 'status: IN_PROGRESS', 'approved: true', 'worktree: false', 'type: Feature', '---', '# Rate limit', '', '## Tasks', '', ...tasks].join('\n')
}

function flow(workflow: string, phase?: string, endedAt?: number): string {
  const entry: Record<string, unknown> = { workflow, source: 'command', startedAt: NOW - 12 * 60_000 }
  if (phase !== undefined) entry['phase'] = { id: phase, since: NOW - 60_000 }
  if (endedAt !== undefined) entry['ended'] = { outcome: 'done', at: endedAt }
  return JSON.stringify({ v: 1, stack: [entry], updatedAt: NOW })
}

function command(name: string, args = '') {
  return { command: name, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
}

const SPEC = { [STATE]: planState('implement'), [PLAN]: planText(3, 7), [FLOW]: flow('plan-build', 'implement') }

for (const surface of SURFACES) {
  describe(`workflow band on ${surface}`, () => {
    test('plan-build: the phases with the plan\'s progress, redrawn when a flow command moves it', async ($, on) => {
      const world = worldOf(on, SPEC)
      await $.session.start(SESSION)
      const ui = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: BAND })
      expect((await ui.find({ key: 'band-crumb' }))?.text).toBe('plan-build')
      expect((await ui.find({ key: 'band-progress' }))?.text).toContain('3/7')
      expect((await ui.find({ key: 'band-phase-implement' }))?.text).toBe('● Implement')
      expect((await ui.find({ key: 'band-status' }))?.text).toBe('running')
      expect((await ui.find({ key: 'band-current' }))?.text).toBe('▸ Task 4: Step 4')
      world.files.set(FLOW, flow('plan-build', 'verify'))
      await $.tool.call({ tool: 'Bash', command: 'buracle flow phase verify' })
      expect((await ui.find({ key: 'band-phase-verify' }))?.text).toBe('● Verify')
      expect((await ui.find({ key: 'band-phase-implement' }))?.text).toBe('✓ Implement')
    })

    test('yields to a survey, to an agent\'s transcript, and to workflow.band: false', async ($, on) => {
      worldOf(on, SPEC)
      await $.session.start(SESSION)
      const survey = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
      expect(await survey.find({ key: 'band' })).toBeUndefined()
      const agent = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'agent-1' } } })
      expect(await agent.find({ key: 'band' })).toBeUndefined()
    })

    test('workflow.band: false draws nothing', async ($, on) => {
      worldOf(on, SPEC, { workflow: { band: false } })
      await $.session.start(SESSION)
      const ui = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ key: 'band' })).toBeUndefined()
    })

    test('a narrow band is one row', async ($, on) => {
      worldOf(on, SPEC)
      await $.session.start(SESSION)
      const ui = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 40 } })
      expect(await ui.find({ key: 'band-row-0' })).toBeDefined()
      expect(await ui.find({ key: 'band-row-1' })).toBeUndefined()
      expect((await ui.find({ key: 'band-progress' }))?.text).toBe(' 3/7')
    })

    test('a /buracle:bugfix command shows the fix phases at once and records the start', async ($, on) => {
      const world = worldOf(on)
      await $.session.start(SESSION)
      const ui = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ key: 'band' })).toBeUndefined()
      await $.command.run(command('buracle:bugfix', 'totals off by one'))
      expect((await ui.find({ key: 'band-phase-investigate' }))?.text).toBe('○ Investigate')
      expect((await ui.find({ key: 'band-status' }))?.text).toBe('starting')
      expect(world.flow().stack).toEqual([expect.objectContaining({ workflow: 'bugfix', source: 'command', title: 'totals off by one' })])
    })

    test('a typed /buracle:research prompt records the start too', async ($, on) => {
      const world = worldOf(on)
      await $.session.start(SESSION)
      await $.turn.start({ text: '/buracle:research queue libraries', turnId: 't1' })
      expect(world.flow().stack).toEqual([expect.objectContaining({ workflow: 'research', source: 'prompt', title: 'queue libraries' })])
    })

    test('the todo in progress is the current step', async ($, on) => {
      worldOf(on, { [FLOW]: flow('bugfix', 'red') })
      await $.session.start(SESSION)
      const ui = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: BAND })
      await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Write the failing test', status: 'in_progress', activeForm: 'Writing the failing test' }] } as never)
      expect((await ui.find({ key: 'band-current' }))?.text).toBe('▸ Writing the failing test')
    })

    test('a review agent running in the background shows until its turn ends', async ($, on) => {
      const world = worldOf(on, SPEC)
      world.agents.push({ id: 'agent-7', type: 'buracle:plan-build-review', description: 'review', status: 'running' })
      await $.session.start(SESSION)
      const ui = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: BAND })
      await $.tool.call({ tool: 'Agent', description: 'review', prompt: 'review the plan', subagent_type: 'buracle:plan-build-review' } as never)
      expect((await ui.find({ key: 'band-agents' }))?.text).toContain('plan-build-review')
      await $.turn.complete({ agentId: 'agent-7', answer: 'ok', durationMs: 1000, turnId: 't2', reason: 'answer', isAborted: false } as never)
      expect(await ui.find({ key: 'band-agents' })).toBeUndefined()
    })

    test('an ended run shows done, then folds after workflow.foldAfterSec', async ($, on) => {
      const world = worldOf(on, SPEC)
      await $.session.start(SESSION)
      const ui = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: BAND })
      world.files.set(FLOW, flow('plan-build', 'verify', NOW))
      await $.tool.call({ tool: 'Bash', command: 'buracle flow end' })
      expect((await ui.find({ key: 'band-status' }))?.text).toBe('done')
      await world.clock.advance(7_000)
      expect(await ui.find({ key: 'band' })).toBeDefined()
      await world.clock.advance(1_000)
      expect(await ui.find({ key: 'band' })).toBeUndefined()
    })

    test('details opens the plan pane; hide keeps the band away until another run starts', async ($, on) => {
      const world = worldOf(on, SPEC)
      await $.session.start(SESSION)
      const ui = await $.ui.mount({ plugin: 'buracle', surface, component: 'AbovePrompt', props: BAND })
      await ui.press({ key: 'band-details' })
      expect(world.opened).toEqual(['buracle-plan'])
      await ui.press({ key: 'band-hide' })
      expect(await ui.find({ key: 'band' })).toBeUndefined()
      await world.clock.advance(60_000)
      await $.command.run(command('buracle:inspect', 'slow startup'))
      expect((await ui.find({ key: 'band-crumb' }))?.text).toBe('inspect')
    })
  })
}

describe('turn ends and session starts', () => {
  test('a session holding an unfinished run suggests continuing it', async ($, on) => {
    const world = worldOf(on, SPEC)
    await $.session.start(SESSION)
    expect(world.suggested).toEqual(['continue the plan-build run (Implement 3/7): Rate limit'])
  })

  test('a long turn ends with a native notification naming the run', async ($, on) => {
    const world = worldOf(on, SPEC)
    await $.session.start(SESSION)
    await $.turn.complete({ answer: 'Working on it.', durationMs: 200_000, turnId: 't1', reason: 'answer', isAborted: false } as never)
    expect(world.notified).toEqual(['Turn finished after 3 min: plan-build (Rate limit): phase Implement, 3/7 tasks; now: Task 4: Step 4'])
    await $.turn.complete({ answer: 'Short.', durationMs: 30_000, turnId: 't2', reason: 'answer', isAborted: false } as never)
    expect(world.notified).toHaveLength(1)
  })

  test('an edit-only turn suggests running the checks', async ($, on) => {
    const world = worldOf(on)
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/a.ts`, old_string: 'a', new_string: 'b' } as never)
    await $.turn.complete({ answer: 'Changed it.', durationMs: 1000, turnId: 't1', reason: 'answer', isAborted: false } as never)
    await world.clock.advance(1_500)
    expect(world.suggested).toEqual(['run the checks for the files changed in the last turn (tests, typecheck, lint) and show the results'])
  })
})

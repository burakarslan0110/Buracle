import { describe, expect, test } from 'bun:test'
import { createPiExtras, skillWorkflowOf, TIP_PREFIX, type PiExtrasHost } from '../../../src/adapters/pi/runtime/extras'
import { defaultDeps } from '../../../src/adapters/pi/runtime/deps'
import { piStatusData } from '../../../src/adapters/pi/generated'
import type { PiContext } from '../../../src/adapters/pi/runtime/types'
import { defaultConfig } from '../../../src/core/config'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { join } from 'node:path'
import { withSandbox } from '../../helpers/sandbox'
import { fakeCtx, SID } from './fakes'

interface Calls { widgets: Array<{ key: string, lines: string[] | undefined, placement?: string }>, status: Array<{ key: string, text: string | undefined }>, working: Array<string | undefined> }

function uiCtx(mode: PiContext['mode'] = 'tui'): { ctx: PiContext, calls: Calls } {
  const calls: Calls = { widgets: [], status: [], working: [] }
  const base = fakeCtx({ cwd: '/tmp', mode })
  const ctx: PiContext = {
    ...base,
    ui: {
      notify: () => {},
      setWidget: (key, lines, options) => { calls.widgets.push({ key, lines, ...(options?.placement !== undefined ? { placement: options.placement } : {}) }) },
      setStatus: (key, text) => { calls.status.push({ key, text }) },
      setWorkingMessage: message => { calls.working.push(message) },
    },
  }
  return { ctx, calls }
}

const canonical = loadCanonicalSync(join(import.meta.dir, '..', '..', '..', 'canonical'))

function host(over: Partial<PiExtrasHost> = {}, depsOver: Partial<PiExtrasHost['deps']> = {}): PiExtrasHost {
  const d = defaultDeps()
  return {
    data: { tips: [{ id: 'a', text: 'first tip' }, { id: 'b', text: 'second tip' }] },
    deps: { now: () => 1_791_400_000_000, flow: d.flow!, columns: () => 100, ...depsOver },
    live: () => ({ config: defaultConfig(), vault: '', shim: '', source: 'defaults' }),
    guarded: (_what, fn) => fn(),
    slug: () => 'demo',
    ...over,
  }
}

describe('pi extras: workflow detection', () => {
  test('only /skill:<workflow id> starts a workflow', () => {
    expect(skillWorkflowOf('/skill:plan-build add a thing')).toBe('plan-build')
    expect(skillWorkflowOf('  /skill:bugfix')).toBe('bugfix')
    expect(skillWorkflowOf('/plan-build x')).toBeUndefined()
    expect(skillWorkflowOf('/skill:not-a-workflow')).toBeUndefined()
    expect(skillWorkflowOf('hello /skill:plan-build')).toBeUndefined()
  })
})

describe('pi extras: the workflow band', () => {
  test('a workflow start draws the band above the editor; the same lines are not drawn twice', () => withSandbox(async () => {
    const { ctx, calls } = uiCtx()
    const extras = createPiExtras(host())
    expect(extras.flowStart(SID, '/skill:plan-build add a thing')).toBe('plan-build')
    extras.refreshFlow(SID, ctx)
    extras.refreshFlow(SID, ctx)
    expect(calls.widgets).toHaveLength(1)
    expect(calls.widgets[0]?.key).toBe('buracle.flow')
    expect(calls.widgets[0]?.placement).toBe('aboveEditor')
    expect(calls.widgets[0]?.lines?.join('\n')).toContain('plan-build')
  }))

  test('no workflow, no widget content; print mode and a host without setWidget draw nothing', () => withSandbox(async () => {
    const quiet = uiCtx()
    createPiExtras(host()).refreshFlow(SID, quiet.ctx)
    expect(quiet.calls.widgets.every(w => w.lines === undefined)).toBe(true)
    const print = uiCtx('print')
    const extras = createPiExtras(host())
    extras.flowStart(SID, '/skill:bugfix')
    extras.refreshFlow(SID, print.ctx)
    expect(print.calls.widgets).toEqual([])
    const noWidget = fakeCtx({ cwd: '/tmp' })
    expect(() => extras.refreshFlow(SID, noWidget)).not.toThrow()
  }))

  test('workflow.band off clears the band', () => withSandbox(async () => {
    const { ctx, calls } = uiCtx()
    const cfg = defaultConfig()
    cfg.workflow.band = false
    const extras = createPiExtras(host({ live: () => ({ config: cfg, vault: '', shim: '', source: 'defaults' }) }))
    extras.flowStart(SID, '/skill:bugfix')
    extras.refreshFlow(SID, ctx)
    expect(calls.widgets.every(w => w.lines === undefined)).toBe(true)
  }))
})

describe('pi extras: footer status', () => {
  test('piStatusData reads native.setStatus of the pi entry of statusline.yaml', () => {
    const data = piStatusData(canonical.statusline.pi)
    expect(data?.setStatus).toEqual({ buracle: ['mem'] })
  })

  test('renders the Buracle segments into one footer entry and skips an unchanged text', async () => {
    const { ctx, calls } = uiCtx()
    const extras = createPiExtras(host(
      { data: { status: { layout: { rows: [['mem', 'hooks']], thresholds: { ctxWarn: 75, ctxCrit: 90 }, emoji: false }, setStatus: { buracle: ['hooks'] } } } },
      { hooksHealth: async () => ({ failures: 3, failClosed: 0 }) },
    ))
    await extras.refreshStatus(SID, ctx)
    await extras.refreshStatus(SID, ctx)
    expect(calls.status).toHaveLength(1)
    expect(calls.status[0]?.key).toBe('buracle')
    expect(calls.status[0]?.text).toContain('3')
  })
})

describe('pi extras: tips', () => {
  test('each run shows the next tip as the working message and agent end restores the default', () => {
    const { ctx, calls } = uiCtx()
    const extras = createPiExtras(host())
    extras.tipStart(ctx)
    extras.tipEnd(ctx)
    extras.tipStart(ctx)
    expect(calls.working).toEqual([`${TIP_PREFIX}first tip`, undefined, `${TIP_PREFIX}second tip`])
  })

  test('no tips, or no terminal UI, shows nothing', () => {
    const none = uiCtx()
    createPiExtras(host({ data: {} })).tipStart(none.ctx)
    expect(none.calls.working).toEqual([])
    const print = uiCtx('print')
    createPiExtras(host()).tipStart(print.ctx)
    expect(print.calls.working).toEqual([])
  })
})

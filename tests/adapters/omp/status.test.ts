import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LiveConfig } from '../../../src/adapters/omp/runtime/config'
import { defaultDeps, type ExtensionDeps } from '../../../src/adapters/omp/runtime/extension'
import { createStatusTexts, WIDGET_KEY } from '../../../src/adapters/omp/runtime/status'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import { barLines } from '../../../src/core/status/bar'
import { renderPlain, renderPlainLines, rows } from '../../../src/core/status/render'
import type { IndexState, WorkspaceInfo } from '../../../src/core/workspace'
import { recordFlowStart } from '../../../src/workflow/flow'
import { saveState } from '../../../src/workflow/session-store'
import { withSandbox, type Sandbox } from '../../helpers/sandbox'
import { fakeCtx, planState, testDeps, testGenerated, type FakeCtx } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'
const T0 = 1_791_400_000_000
const OMP_ROWS = [['month', 'mem', 'index', 'git', 'flow', 'plan', 'upd', 'hooks']]

interface Rig {
  ctx: FakeCtx
  cwd: string
  reads: string[]
  reported: string[]
  setNow(ms: number): void
  setIndex(codegraph: IndexState['state'], semble: IndexState['state']): void
  refresh(): Promise<void>
  band(): string[] | undefined
}

function rig(sb: Sandbox, cfg: () => BuracleConfig, overrides: Partial<ExtensionDeps> = {}): Rig {
  const cwd = join(sb.root, 'work')
  mkdirSync(cwd, { recursive: true })
  let now = T0
  let index: WorkspaceInfo['index'] = { codegraph: { state: 'ready' }, semble: { state: 'building' } }
  const reads: string[] = []
  const reported: string[] = []
  const deps: ExtensionDeps = {
    ...defaultDeps(),
    ...testDeps({
      now: () => now,
      status: { rows, renderPlain },
      workspaceInfo: async dir => { reads.push(dir); return { cwd: dir, root: dir, children: [], index } },
      ...overrides,
    }).deps,
  }
  const bands = new Map<string, string | undefined>()
  const live = (): LiveConfig => ({ config: cfg(), vault: join(sb.root, 'vault'), shim: join(sb.root, 'shim'), source: 'defaults' })
  const texts = createStatusTexts({
    data: testGenerated({ status: { layout: { rows: OMP_ROWS, thresholds: { ctxWarn: 75, ctxCrit: 90 }, emoji: false }, setStatus: { 'buracle.budget': ['month'], 'buracle.mem': ['mem'] } } }),
    deps,
    live,
    guarded: (what, fn) => { try { return fn() } catch { reported.push(what); return undefined } },
    slug: () => undefined,
    band: { get: sid => bands.get(sid), set: (sid, text) => { bands.set(sid, text) } },
  })
  const ctx = fakeCtx({ cwd, sid: SID })
  return {
    ctx, cwd, reads, reported,
    setNow: ms => { now = ms },
    setIndex: (codegraph, semble) => { index = { codegraph: { state: codegraph } as IndexState, semble: { state: semble } as IndexState } },
    refresh: () => texts.refresh(ctx),
    band: () => {
      const last = ctx.uiCalls.filter(c => c.method === 'setWidget' && c.args[0] === WIDGET_KEY).at(-1)
      return last?.args[1] as string[] | undefined
    },
  }
}

function withStyle(cfg: BuracleConfig, style: BuracleConfig['statusline']['style'], band = cfg.workflow.band): BuracleConfig {
  return { ...cfg, statusline: { ...cfg.statusline, style }, workflow: { ...cfg.workflow, band } }
}

describe('omp status band: the index segment', () => {
  test('full style: the project\'s code index state (worst of codegraph and semble), read again only after 30 s', () => withSandbox(async sb => {
    const cfg = withStyle(defaultConfig(), 'full')
    const r = rig(sb, () => cfg)
    saveState('omp', SID, planState())
    await r.refresh()
    expect(r.band()?.join('\n')).toContain('idx building')
    expect(r.reads).toEqual([r.cwd])

    r.setIndex('ready', 'ready')
    r.setNow(T0 + 10_000)
    await r.refresh()
    expect(r.reads).toHaveLength(1)
    expect(r.band()?.join('\n')).toContain('idx building')

    r.setNow(T0 + 31_000)
    await r.refresh()
    expect(r.reads).toHaveLength(2)
    expect(r.band()?.join('\n')).toContain('idx ready')
  }))

  test('buracle style: the footer line carries the index state, with or without a plan', () => withSandbox(async sb => {
    const info = { product: { name: 'Buracle', version: '9.9.9' }, harness: { label: 'OMP', version: '18.8.3' } }
    const r = rig(sb, () => defaultConfig(), { bar: { lines: barLines, render: renderPlainLines, info: async () => info } })
    await r.refresh()
    expect(r.band()?.at(-1)).toContain('idx building')
  }))

  test('a workspace that cannot be read leaves the segment out; the band still renders', () => withSandbox(async sb => {
    const r = rig(sb, () => withStyle(defaultConfig(), 'full'), { workspaceInfo: async () => { throw new Error('no git') } })
    saveState('omp', SID, planState())
    await r.refresh()
    const band = r.band()?.join('\n') ?? ''
    expect(band).toContain('demo')
    expect(band).not.toContain('idx')
  }))
})

describe('omp status band: the Buracle bar footer', () => {
  const INFO = { product: { name: 'Buracle', version: '9.9.9' }, harness: { label: 'OMP', version: '18.8.3' } }

  test('buracle style: the footer names Buracle and the harness, never the retired `cm` segment', () => withSandbox(async sb => {
    const cfg = defaultConfig()
    const rigged = rig(sb, () => cfg, { bar: { lines: barLines, render: renderPlainLines, info: async () => INFO } })
    await rigged.refresh()
    expect(rigged.band()?.at(-1)).toContain('Buracle 9.9.9')
    expect(rigged.band()?.join('\n') ?? '').not.toContain('cm ')
  }))
})

describe('omp status band: the flow segment', () => {
  test('full style: a running workflow shows below the editor only while the band above it is off', () => withSandbox(async sb => {
    let cfg = withStyle(defaultConfig(), 'full')
    const r = rig(sb, () => cfg)
    recordFlowStart('omp', SID, { workflow: 'bugfix', title: 'login bug', source: 'command' }, T0 - 60_000)
    await r.refresh()
    expect(r.band()).toBeUndefined()

    cfg = withStyle(cfg, 'full', false)
    await r.refresh()
    const band = r.band()?.join('\n') ?? ''
    expect(band).toContain('bugfix')
    expect(band).toContain('idx building')
  }))

  test('buracle style: the workflow line appears between the bar lines only while the band is off', () => withSandbox(async sb => {
    let cfg = defaultConfig()
    const info = { product: { name: 'Buracle', version: '9.9.9' }, harness: { label: 'OMP', version: '18.8.3' } }
    const r = rig(sb, () => cfg, { bar: { lines: barLines, render: renderPlainLines, info: async () => info } })
    recordFlowStart('omp', SID, { workflow: 'bugfix', title: 'login bug', source: 'command' }, T0 - 60_000)
    await r.refresh()
    const on = r.band() ?? []
    expect(on.join('\n')).not.toContain('bugfix')

    cfg = withStyle(cfg, 'buracle', false)
    await r.refresh()
    const off = r.band() ?? []
    expect(off).toHaveLength(on.length + 1)
    expect(off.join('\n')).toContain('bugfix')
  }))
})

describe('omp status: Buracle\'s hook health (O3)', () => {
  test('the buracle.hooks status text and the Buracle bar footer show failing hooks; the key is cleared while all is well', () => withSandbox(async sb => {
    const cwd = join(sb.root, 'work')
    mkdirSync(cwd, { recursive: true })
    let health = { failures: 0, failClosed: 0 }
    const info = { product: { name: 'Buracle', version: '9.9.9' }, harness: { label: 'OMP', version: '18.8.3' } }
    const deps: ExtensionDeps = { ...defaultDeps(), ...testDeps({ now: () => T0, status: { rows, renderPlain }, bar: { lines: barLines, render: renderPlainLines, info: async () => info } }).deps }
    const bands = new Map<string, string | undefined>()
    const texts = createStatusTexts({
      data: testGenerated({ status: { layout: { rows: OMP_ROWS, thresholds: { ctxWarn: 75, ctxCrit: 90 }, emoji: false }, setStatus: { 'buracle.budget': ['month'], 'buracle.hooks': ['hooks'], 'buracle.mem': ['mem'] } } }),
      deps,
      live: () => ({ config: defaultConfig(), vault: join(sb.root, 'vault'), shim: join(sb.root, 'shim'), source: 'defaults' }),
      guarded: (_what, fn) => { try { return fn() } catch { return undefined } },
      slug: () => undefined,
      band: { get: sid => bands.get(sid), set: (sid, text) => { bands.set(sid, text) } },
      hooks: async () => health,
    })
    const ctx = fakeCtx({ cwd, sid: SID })
    const lastStatus = () => ctx.uiCalls.filter(c => c.method === 'setStatus' && c.args[0] === 'buracle.hooks').at(-1)?.args[1]
    await texts.refresh(ctx)
    expect(lastStatus()).toBeUndefined()
    expect(bands.get(SID)).not.toContain('hooks')
    health = { failures: 2, failClosed: 1 }
    await texts.refresh(ctx)
    expect(lastStatus()).toBe('hooks ✗2 (1 denied)')
    expect(bands.get(SID)?.split('\n').at(-1)).toContain('hooks ✗2 (1 denied)')
  }))
})

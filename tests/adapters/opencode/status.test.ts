import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { barSegments, contextUsage, layoutFor, StatusFeeder, statusSegments, usageRefreshArgv } from '../../../src/adapters/opencode/runtime/status'
import type { TuiSessionMessage } from '../../../src/adapters/opencode/runtime/types'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import * as paths from '../../../src/engine/paths'
import { writeUsageEntries } from '../../../src/usage/cache'
import { monthKeyOf } from '../../../src/usage/month'
import { recordFlowStart } from '../../../src/workflow/flow'
import { saveState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { canonical } from './helpers'

const tokens = (input: number) => ({ input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } })

describe('opencode TUI status model', () => {
  test('contextUsage uses the last assistant step after the last completed compaction', () => {
    const models = [{ id: 'm', providerID: 'p', limit: { context: 1000 } }]
    const msgs: TuiSessionMessage[] = [
      { id: 'a1', type: 'assistant', tokens: tokens(900), model: { providerID: 'p', id: 'm' } },
      { id: 'c1', type: 'compaction', status: 'completed' },
      { id: 'u1', type: 'user' },
      { id: 'a2', type: 'assistant', tokens: tokens(190), model: { providerID: 'p', id: 'm' } },
      { id: 'a3', type: 'assistant' },
    ]
    expect(contextUsage(msgs, models)).toEqual({ tokens: 200, window: 1000, pct: 20 })
    expect(contextUsage(msgs.slice(0, 3), models)).toBeUndefined()
    expect(contextUsage(msgs, undefined)).toEqual({ tokens: 200 })
    expect(contextUsage(msgs, models, 'a2')).toBeUndefined()
  })

  test('the feeder combines live data with the usage, memory, plan and update caches', () => withSandbox(async ({ root }) => {
    const now = Date.now()
    writeUsageEntries([{
      harness: 'opencode', computed_at: new Date(now).toISOString(), month_key: monthKeyOf(now),
      windows: [{ label: '5h', pct: 42, windowMinutes: 300, resetsAt: new Date(now + 3_600_000).toISOString() }],
      month: { start: new Date(now).toISOString(), tokens: 1_234_567, usd: 12.5, byModel: {} },
    }], now)
    const memDir = join(paths.memoryStateDir(), 'status')
    mkdirSync(memDir, { recursive: true })
    writeFileSync(join(memDir, '_global.json'), JSON.stringify({ v: 2, computed_at: new Date(now).toISOString(), health: 'ok', reasons: [], counts: { project: 3, person: 2 }, regions: {}, upkeep: 0, captures: 1, store: { engine: 'cortexdb', version: '2.124.0', ok: true }, distill: { pending: 0 }, redactions_24h: 0 }))
    const planFile = join(root, 'plan.md')
    writeFileSync(planFile, '---\nstatus: IN_PROGRESS\n---\n# Auth fix\n\n## Tasks\n\n### Task 1: A\n- [x] Task 1 done\n\n### Task 2: B\n- [ ] Task 2 done\n')
    saveState('opencode', 'ses_tui2', { v: 1, plan: { path: planFile, slug: 'auth-fix', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1 }, guard: { blocksForPlan: 0, blocksInChain: 0 } })
    writeFileSync(paths.updatesFile(), JSON.stringify({ count: 2 }))

    const feeder = new StatusFeeder({ spawnRefresh: false })
    expect(await feeder.refresh(root, 'ses_tui2')).toBe(true)
    const bar = feeder.bar({ cwd: root, sessionID: 'ses_tui2', model: { providerID: 'p', modelID: 'big', variant: 'max' }, ctx: { tokens: 370_000, window: 1_000_000, pct: 37 }, costUsd: 0.5 })
    expect(bar).toMatchObject({ harness: 'opencode', model: 'big', effort: 'max', ctx: { pct: 37, tokens: 370_000, window: 1_000_000 }, cost: { usd: 0.5 }, updates: 2 })
    expect(bar.windows.map(w => w.label)).toEqual(['5h'])
    expect(bar.month).toMatchObject({ tokens: 1_234_567, usd: 12.5, estimate: true })
    expect(bar.mem?.counts.project).toBe(3)
    expect(bar.plan).toEqual({ title: 'Auth fix', phase: 'implement', done: 1, total: 2 })
    expect(bar.dir).toBeDefined()

    const layout = layoutFor(canonical().statusline.opencode, canonical().config.statusline)
    const segs = statusSegments(bar, layout, 200, now)
    const ids = segs.map(s => s.id)
    expect(ids).toContain('ctx')
    expect(segs.map(s => s.text).join(' ')).toContain('37%')
    const narrow = statusSegments(bar, layout, 40, now)
    expect(narrow.length).toBeLessThan(segs.length)
    expect(narrow.map(s => s.id)).toContain('ctx')
  }))
})

describe('opencode TUI status: code indexes and the running workflow', () => {
  const with_ = (cfg: BuracleConfig, over: { band?: boolean, semble?: boolean }): BuracleConfig => ({
    ...cfg,
    workflow: { ...cfg.workflow, ...(over.band !== undefined ? { band: over.band } : {}) },
    index: { ...cfg.index, ...(over.semble !== undefined ? { semble: over.semble } : {}) },
  })

  test('the index segment shows the project\'s code indexes, read again about every 30 s; outside a project there is none', () => withSandbox(async ({ root, home }) => {
    let now = 1_791_400_000_000
    let cfg = defaultConfig()
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(proj, 'package.json'), '{}\n')
    const feeder = new StatusFeeder({ spawnRefresh: false, now: () => now, config: () => cfg })
    expect(await feeder.refresh(proj, undefined)).toBe(true)
    expect(feeder.bar({ cwd: proj }).index).toBe('none')

    mkdirSync(join(proj, '.codegraph'), { recursive: true })
    writeFileSync(join(proj, '.codegraph', 'codegraph.db'), '')
    cfg = with_(cfg, { semble: false })
    now += 10_000
    await feeder.refresh(proj, undefined)
    expect(feeder.bar({ cwd: proj }).index).toBe('none')
    now += 21_000
    await feeder.refresh(proj, undefined)
    const bar = feeder.bar({ cwd: proj })
    expect(bar.index).toBe('ready')
    const layout = layoutFor(canonical().statusline.opencode, { ...cfg.statusline, style: 'full' })
    expect(statusSegments(bar, layout, 200, now).find(s => s.id === 'index')?.text).toBe('idx ready')
    expect(barSegments(bar, layoutFor(canonical().statusline.opencode, cfg.statusline), {}, 200, now).map(s => s.text).join('')).toContain('idx ready')

    await feeder.refresh(home, undefined)
    expect(feeder.bar({ cwd: home }).index).toBeUndefined()
  }))

  test('the flow segment shows the running workflow only while the band above the prompt is off', () => withSandbox(async ({ root }) => {
    const now = 1_791_400_000_000
    let cfg = defaultConfig()
    const feeder = new StatusFeeder({ spawnRefresh: false, now: () => now, config: () => cfg })
    recordFlowStart('opencode', 'ses_flow1', { workflow: 'bugfix', title: 'login bug', source: 'command' }, now - 60_000)
    expect(feeder.bar({ cwd: root, sessionID: 'ses_flow1' }).flow).toBeUndefined()

    cfg = with_(cfg, { band: false })
    const bar = feeder.bar({ cwd: root, sessionID: 'ses_flow1' })
    expect(bar.flow).toMatchObject({ visible: true, workflow: 'bugfix', breadcrumb: ['bugfix'] })
    const full = statusSegments(bar, layoutFor(canonical().statusline.opencode, { ...cfg.statusline, style: 'full' }), 200, now)
    expect(full.find(s => s.id === 'flow')?.text).toContain('bugfix')
    expect(barSegments(bar, layoutFor(canonical().statusline.opencode, cfg.statusline), {}, 200, now).filter(s => s.id === 'flow').map(s => s.text).join('')).toContain('bugfix')
    expect(feeder.bar({ cwd: root }).flow).toBeUndefined()
    expect(feeder.bar({ cwd: root, sessionID: 'ses_other' }).flow).toBeUndefined()
  }))

  test('without a config getter the feeder reads the live config from runtime-config.json', () => withSandbox(async ({ root }) => {
    const now = 1_791_400_000_000
    recordFlowStart('opencode', 'ses_flow2', { workflow: 'plan-build', source: 'command' }, now - 1_000)
    const feeder = new StatusFeeder({ spawnRefresh: false, now: () => now })
    expect(feeder.bar({ cwd: root, sessionID: 'ses_flow2' }).flow).toBeUndefined()
    mkdirSync(paths.stateDir(), { recursive: true })
    writeFileSync(paths.runtimeConfigFile(), JSON.stringify({ v: 1, config: with_(defaultConfig(), { band: false }) }))
    expect(feeder.bar({ cwd: root, sessionID: 'ses_flow2' }).flow).toMatchObject({ visible: true, workflow: 'plan-build' })
  }))
})

describe('opencode TUI status: no Context Mode segment', () => {
  test('the rows and the Buracle bar line carry no `cm` segment', () => withSandbox(async ({ root }) => {
    const now = 1_791_400_000_000
    const cfg = defaultConfig()
    const loc = join(root, 'loc')
    mkdirSync(loc, { recursive: true })
    const feeder = new StatusFeeder({ spawnRefresh: false, now: () => now, config: () => cfg })
    await feeder.refresh(loc, undefined)
    const bar = feeder.bar({ cwd: loc })
    const full = statusSegments(bar, layoutFor(canonical().statusline.opencode, { ...cfg.statusline, style: 'full' }), 300, now)
    expect(full.find(s => s.id === 'cm')).toBeUndefined()
    expect(barSegments(bar, layoutFor(canonical().statusline.opencode, cfg.statusline), {}, 300, now).map(s => s.text).join('')).not.toContain('cm ')
  }))
})

describe('opencode TUI usage refresh', () => {
  test('the background refresh runs the shim, else bun with the checkout CLI found through paths.repoRoot()', () => withSandbox(async () => {
    const tail = ['usage', 'refresh', '--harness', 'opencode', '--background']
    const bun = Bun.which('bun')
    const viaRepo = usageRefreshArgv()
    if (bun !== null) expect(viaRepo).toEqual([bun, join(paths.repoRoot(), 'src', 'cli', 'main.ts'), ...tail])
    mkdirSync(paths.binDir(), { recursive: true })
    writeFileSync(paths.shimPath(), '#!/bin/sh\n')
    expect(usageRefreshArgv()).toEqual([paths.shimPath(), ...tail])
  }))
})

describe('opencode TUI status: Buracle\'s hook health (O3)', () => {
  test('hook failures from the log reach the bar, the Buracle bar footer line and the segment rows; read again after the TTL', () => withSandbox(async ({ root, buracleHome }) => {
    let now = 1_791_400_000_000
    const cfg = defaultConfig()
    const feeder = new StatusFeeder({ spawnRefresh: false, now: () => now, config: () => cfg })
    await feeder.refresh(root, undefined)
    expect(feeder.bar({ cwd: root }).hooks).toEqual({ failures: 0, failClosed: 0 })
    const logs = join(buracleHome, 'logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'buracle.log'), JSON.stringify({ ts: new Date(now).toISOString(), level: 'error', pid: 1, msg: 'hook runtime failed', data: { harness: 'claude', event: 'PreToolUse', result: 'fail-closed' } }) + '\n')
    now += 61_000
    await feeder.refresh(root, undefined)
    const bar = feeder.bar({ cwd: root })
    expect(bar.hooks).toEqual({ failures: 1, failClosed: 1 })
    expect(barSegments(bar, layoutFor(canonical().statusline.opencode, cfg.statusline), {}, 200, now).find(s => s.id === 'hooks')?.text).toBe('hooks ✗1 (1 denied)')
    expect(statusSegments(bar, layoutFor(canonical().statusline.opencode, { ...cfg.statusline, style: 'full' }), 200, now).find(s => s.id === 'hooks')?.text).toBe('hooks ✗1 (1 denied)')
  }))
})

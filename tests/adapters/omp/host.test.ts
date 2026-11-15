import { describe, expect, test } from 'bun:test'
import { adapterContext, memoryFns, pipelineCore, uiHooks } from '../../../src/adapters/shared/pi-family/host'
import { deviceCall } from '../../../src/adapters/omp/runtime/write-check'
import { defaultConfig } from '../../../src/core/config'
import type { ToolCall } from '../../../src/core/events'
import { fakeMemory, planState, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'

describe('omp host: what the extension hands the shared pipeline', () => {
  test('the adapter context carries the baked routing and notices, the live config, and the live vault and home', () => {
    const config = defaultConfig()
    const data = testGenerated({ notices: [{ id: 'n', since: '0.1.0', message: 'A notice.' }] })
    const ctx = adapterContext(data, { config, vault: '/v', shim: '/s', repoRoot: '/repo', source: 'runtime-config' }, () => '/h')
    expect({ repoRoot: ctx.repoRoot, bin: ctx.buracleBin, vault: ctx.paths.oldVaultRoot(), home: ctx.paths.home() }).toEqual({ repoRoot: '/repo', bin: '/s', vault: '/v', home: '/h' })
    expect(ctx.config).toBe(config)
    expect(ctx.canonical.routing).toBe(data.routing)
    expect(ctx.canonical.notices).toEqual(data.notices ?? [])
    expect(adapterContext(testGenerated(), { config, vault: '/v', shim: '/s', source: 'defaults' }, () => '/h').repoRoot).toBe('')
  })

  test('the pipeline core calls the injected functions; a switched-off stop guard and switched-off routing never reach them', () => {
    const called: string[] = []
    const base = testDeps().deps
    const core = pipelineCore({
      policy: { ...base.policy!, detectIntent: () => 'pause', routeTool: () => { called.push('routeTool'); return { action: 'deny', reason: 'x', hook: 'H03' } } },
      plan: { ...base.plan!, stopGuardVerdict: s => { called.push('stopGuardVerdict'); return { decision: { action: 'block', reason: 'x', hook: 'H08' }, next: s, why: 'blocked' } } },
      compact: base.compact!,
    })
    const call: ToolCall = { harness: 'omp', sessionId: SID, cwd: '/w', tool: 'web_search', kind: 'web_search', input: {}, paths: [] }
    expect(core.detectSignals('dur')).toEqual({ control: 'pause', recall: false, write: false })
    expect(core.routeTool(call, { strictness: 'off', categories: [] }, {})).toEqual({ action: 'allow' })
    expect(core.routeTool(call, { strictness: 'enforce', categories: [] }, {}).action).toBe('deny')
    const plan = defaultConfig().plan
    const input = { harness: 'omp' as const, sessionId: SID, cwd: '/w', now: 1 }
    expect(core.stopGuardVerdict(planState(), input, { ...plan, stopGuard: false }, undefined)).toEqual({ decision: { action: 'allow' }, next: planState(), why: 'disabled' })
    expect(core.stopGuardVerdict(planState(), input, { ...plan, stopGuard: true }, undefined).decision.action).toBe('block')
    expect(called).toEqual(['routeTool', 'stopGuardVerdict'])
  })

  test('the memory entry points and the UI hooks go to the bridge, which names the harness itself', async () => {
    const memory = fakeMemory('MEMORY')
    const fns = memoryFns(memory.bridge)
    await fns.appendSpool?.('omp', SID, [{ ts: 1, ev: 'prompt' }])
    await fns.sessionStart?.('omp', SID, '/w')
    await fns.promptSeen?.('omp', SID)
    await fns.spawnFinalizer?.('omp', SID)
    expect(await fns.contextText?.({ cwd: '/w' })).toBe('MEMORY')
    expect(await fns.writeHandoff?.({ harness: 'omp', sessionId: SID, cwd: '/w', slug: 's', markdown: '# H\n', branch: 'main' })).toEqual({ id: 'handoff-s', path: 'handoff-s', rel: 'handoff-s' })
    expect(await memoryFns(fakeMemory().bridge).contextText?.({ cwd: '/w' })).toBe('')
    const ui = uiHooks(memory.bridge)
    await ui.started('omp', SID, 1)
    await ui.seen('omp', SID, 2)
    await ui.ended('omp', SID)
    expect(memory.calls).toEqual({
      spool: [{ sid: SID, entries: [{ ts: 1, ev: 'prompt' }] }], started: [{ sid: SID, cwd: '/w' }], finalized: [SID], contexts: ['/w'],
      handoffs: [{ sid: SID, cwd: '/w', slug: 's', markdown: '# H\n', branch: 'main' }], prompts: [SID], ui: [`started ${SID}`, `seen ${SID}`, `ended ${SID}`],
    })
  })

  test('a write to an xd:// device is judged as the call of the tool the device names', () => {
    const write = (input: Record<string, unknown>): ToolCall => ({ harness: 'omp', sessionId: SID, cwd: '/w', tool: 'write', kind: 'mcp', input, paths: [], mcp: { server: 'fs', tool: 'write_file' } })
    expect(deviceCall(write({ path: 'xd://mcp__fs_write_file', content: '{"i":"save it","path":"/w/.env","text":"A=1"}' }))).toMatchObject({ tool: 'mcp__fs_write_file', input: { path: '/w/.env', text: 'A=1' }, mcp: { server: 'fs', tool: 'write_file' } })
    expect(deviceCall(write({ path: 'xd://mcp__fs_write_file', content: 'not json' })).input).toEqual({})
    const plain = write({ path: 'src/a.ts', content: 'x' })
    expect(deviceCall(plain)).toBe(plain)
  })
})

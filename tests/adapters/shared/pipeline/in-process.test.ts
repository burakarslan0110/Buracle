import { describe, expect, test } from 'bun:test'
import type { BashGuardOptions } from '../../../../src/core/policy/bash-guard'
import type { PromptRoute } from '../../../../src/core/policy/skill-router'
import {
  CONTEXT_BUDGET_BYTES, MEMORY_CLIP_NOTE, mcpHealth, preTool, prompt, sessionStart, usageVerdict, type PreToolPorts,
} from '../../../../src/adapters/shared/pipeline/index'
import { loadLedger } from '../../../../src/workflow/ledger'
import { withEnv, withSandbox } from '../../../helpers/sandbox'
import { call, fakeDeps, H, NOW, SID, type FakeOptions } from './helpers'

// What a harness that runs the pipeline inside its own process (OpenCode's plugin) needs beyond the command hooks.

function preToolDeps(o: FakeOptions = {}, ports: Partial<PreToolPorts> = {}) {
  return {
    ...fakeDeps({ ...o, core: { checkBash: () => ({}), checkWrite: () => ({}), routeTool: () => ({ action: 'allow' as const }), reminders: l => ({ next: l }), ...o.core } }),
    writeTargets: () => undefined,
    nativeOff: () => [],
    usage: (c: ReturnType<typeof call>) => ({ call: c, ledgerId: SID, available: [] }),
    ...ports,
  }
}

const ROUTE: PromptRoute = { invoked: [], load: ['tdd'], candidates: [], categories: [] }

describe('pipeline: a harness in its own process', () => {
  test('the usage reminders can run at an earlier event; preTool then applies their verdict without counting the call again', () => withSandbox(async () => {
    let counted = 0
    const core = { reminders: ((l: { turn: number }) => { counted++; return { next: { ...l, turn: l.turn + 1 }, context: 'load the skill' } }) as never }
    const d = preToolDeps({ core })
    const verdict = await usageVerdict({ call: call() }, d, mcpHealth(d.ctx, H, NOW))
    expect(verdict).toEqual({ context: 'load the skill' })
    expect(await preTool({ call: call(), now: NOW, subagent: false, usage: verdict }, d)).toEqual({ action: 'allow', context: ['load the skill'] })
    expect(await preTool({ call: call(), now: NOW, subagent: false, usage: { deny: 'Buracle Stack: read the path rule first' } }, d)).toEqual({ action: 'deny', hook: 'H03', reason: 'Buracle Stack H03: read the path rule first' })
    expect({ counted, turn: loadLedger(H, SID).turn }).toEqual({ counted: 1, turn: 1 })
  }))

  test('a deferred prompt route is not written to the ledger: the harness records it when it delivers the prompt', () => withSandbox(async () => {
    const ports = { readOnly: () => false, contextWarning: () => undefined }
    const input = { harness: H, sessionId: SID, cwd: '/work/app', text: 'Add a parser', now: NOW }
    const later = await prompt(input, { ...fakeDeps(), ...ports, routePrompt: async () => ({ route: ROUTE, text: 'load the tdd skill', deferred: true }) })
    expect(later.context).toEqual(['load the tdd skill'])
    expect(loadLedger(H, SID).prompt).toBeUndefined()
    await prompt(input, { ...fakeDeps(), ...ports, routePrompt: async () => ({ route: ROUTE, text: 'load the tdd skill' }) })
    expect(loadLedger(H, SID).prompt?.route.load).toEqual(['tdd'])
  }))

  test('the release notices follow the version the harness names, where it runs a built copy', () => withSandbox(() => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    const notice = { id: 'in-process-notice', since: '9.9.0', message: 'Hello from a newer build.' }
    const ports = { capabilityCard: () => 'Capability card', sessionMaint: () => {} }
    const input = { harness: H, sessionId: SID, cwd: '/work/app', source: 'startup', now: NOW }
    const o = { canonical: { notices: [notice] } as never }
    expect((await sessionStart(input, { ...fakeDeps(o), ...ports, version: () => undefined })).notice).toBeUndefined()
    expect((await sessionStart(input, { ...fakeDeps(o), ...ports })).notice).toBeUndefined()
    expect((await sessionStart(input, { ...fakeDeps(o), ...ports, version: () => '9.9.0' })).notice?.user).toContain('Hello from a newer build.')
  })))

  test('the bash guard gets the Buracle Stack repository the command runs in, and fails closed when it cannot be found', () => withSandbox(async () => {
    const seen: Array<string | undefined> = []
    const core = { checkBash: (_c: string, o?: BashGuardOptions) => { seen.push(o?.buracleRepo); return {} } }
    await preTool({ call: call(), now: NOW, subagent: false, usage: false }, preToolDeps({ core }, {}))
    await preTool({ call: call(), now: NOW, subagent: false, usage: false }, { ...preToolDeps({ core }), buracleRepo: async () => '/work/buracle' })
    expect(seen).toEqual([undefined, '/work/buracle'])
    const failing = { ...preToolDeps({ core }), buracleRepo: async () => { throw new Error('no git') } }
    expect(await preTool({ call: call(), now: NOW, subagent: false, usage: false }, failing)).toMatchObject({ action: 'deny', hook: 'H01' })
  }))

  test('a memory index that does not fit is clipped with a pointer to memory_search', () => withSandbox(async () => {
    const memory = { contextText: async () => 'line of memory\n'.repeat(2000) }
    const r = await sessionStart({ harness: H, sessionId: SID, cwd: '/work/app', source: 'resume', now: NOW }, {
      ...fakeDeps({ memory }), capabilityCard: () => 'Capability card',
    })
    expect(MEMORY_CLIP_NOTE).toBe('\n… (truncated; use memory_search)')
    expect(r.context[0]).toEndWith(`line of memory${MEMORY_CLIP_NOTE}`)
    expect(new TextEncoder().encode(r.context.join('\n\n')).length).toBeLessThanOrEqual(CONTEXT_BUDGET_BYTES)
  }))
})

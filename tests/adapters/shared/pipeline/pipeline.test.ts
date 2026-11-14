import { describe, expect, test } from 'bun:test'
import { CANONICAL_EVENTS, type StopInput } from '../../../../src/core/events'
import type { PromptRoute } from '../../../../src/core/policy/skill-router'
import type { StopGuardResult } from '../../../../src/core/plan/state'
import * as pipeline from '../../../../src/adapters/shared/pipeline/index'
import {
  postTool, preCompact, preTool, prompt, sessionEnd, sessionStart, stop,
  type PostToolPorts, type PreCompactPorts, type PreToolPorts, type PromptPorts, type SessionStartPorts, type StopPorts,
} from '../../../../src/adapters/shared/pipeline/index'
import { loadLedger } from '../../../../src/workflow/ledger'
import { loadState, updateState } from '../../../../src/workflow/session-store'
import { withSandbox } from '../../../helpers/sandbox'
import { call, fakeDeps, H, NOW, planState, SID, type FakeOptions } from './helpers'

function preToolDeps(o: FakeOptions = {}, ports: Partial<PreToolPorts> = {}) {
  return {
    ...fakeDeps({ ...o, core: { checkBash: () => ({}), checkWrite: () => ({}), routeTool: () => ({ action: 'allow' as const }), reminders: l => ({ next: l }), ...o.core } }),
    bashOptions: (cwd: string) => ({ cwd, home: '/home/u', vault: '/home/u/vault', protect: [] }) as unknown as ReturnType<PreToolPorts['bashOptions']>,
    laneDenial: () => undefined,
    writeTargets: () => ({ paths: [], contents: () => ({}) }),
    writeGuardContext: async (cwd: string) => ({ cwd, home: '/home/u', vault: '/home/u/vault', protect: [] }),
    routingPolicy: () => ({ strictness: 'nudge' as const, categories: [] }),
    mcpHealth: () => () => ({}),
    usage: (c: ReturnType<typeof call>) => ({ call: c, ledgerId: SID, context: { strictness: 'nudge' as const, available: [] } }),
    ...ports,
  }
}

const ALL = { bash: true, write: true, mcpWrite: true, question: true, route: true, usage: true }

describe('pipeline: the seven canonical events', () => {
  test('each canonical event has a function', () => {
    const fns = pipeline as unknown as Record<string, unknown>
    expect([...CANONICAL_EVENTS]).toEqual(['sessionStart', 'prompt', 'preTool', 'postTool', 'stop', 'preCompact', 'sessionEnd'])
    for (const event of CANONICAL_EVENTS) expect({ event, fn: typeof fns[event] }).toEqual({ event, fn: 'function' })
  })
})

describe('pipeline preTool', () => {
  test('allows a call and returns the route, usage and early-edit context in that order', () => withSandbox(async () => {
    let committed = 0
    const d = preToolDeps({ core: { routeTool: () => ({ action: 'allow', context: ['prefer rg'] }), reminders: l => ({ next: { ...l, turn: l.turn + 1 }, context: 'load the skill' }) } }, {
      earlyEdit: () => ({ note: 'the plan is not approved yet', commit: () => { committed++ } }),
    })
    const r = await preTool({ call: call(), now: NOW, subagent: false, checks: ALL }, d)
    expect(r).toEqual({ action: 'allow', context: ['prefer rg', 'load the skill', 'the plan is not approved yet'], parts: { route: ['prefer rg'], usage: 'load the skill', early: 'the plan is not approved yet' } })
    expect(committed).toBe(1)
    expect(loadLedger(H, SID).turn).toBe(1)
    expect(d.rec.failed).toEqual([])
  }))

  test('the bash guard denies with its hook id before any later step runs', () => withSandbox(async () => {
    const ran: string[] = []
    const d = preToolDeps({ core: { checkBash: () => ({ deny: 'rm -rf / is blocked' }), routeTool: () => { ran.push('route'); return { action: 'allow' } } } })
    expect(await preTool({ call: call({ command: 'rm -rf /' }), now: NOW, subagent: false, checks: ALL }, d)).toEqual({ action: 'deny', hook: 'H01', source: 'bash', reason: 'rm -rf / is blocked' })
    expect(ran).toEqual([])
  }))

  test('a guard that throws denies and hands the error to the adapter (fail closed)', () => withSandbox(async () => {
    const boom = new Error('boom')
    const bash = await preTool({ call: call(), now: NOW, subagent: false, checks: ALL }, preToolDeps({ core: { checkBash: () => { throw boom } } }))
    expect(bash).toEqual({ action: 'deny', hook: 'H01', source: 'bash', reason: '', error: boom })
    const write = await preTool({ call: call({ tool: 'Write', kind: 'write', paths: ['/work/app/a.ts'] }), now: NOW, subagent: false, checks: { write: true } }, preToolDeps({ core: { checkWrite: () => { throw boom } } }, {
      writeTargets: c => ({ paths: c.paths, contents: () => ({}) }),
    }))
    expect(write).toEqual({ action: 'deny', hook: 'H02', source: 'write', reason: '', error: boom })
  }))

  test('the lane guard runs for a subagent only, and the write guards name their source', () => withSandbox(async () => {
    const lane = { laneDenial: () => 'another lane owns this state' }
    expect((await preTool({ call: call(), now: NOW, subagent: false, checks: ALL }, preToolDeps({}, lane))).action).toBe('allow')
    expect(await preTool({ call: call(), now: NOW, subagent: true, checks: ALL }, preToolDeps({}, lane))).toEqual({ action: 'deny', hook: 'H01', source: 'lane', reason: 'another lane owns this state' })
    const denyWrite = { core: { checkWrite: () => ({ deny: 'a protected file' }) } }
    const edit = call({ tool: 'Write', kind: 'write', paths: ['/home/u/.ssh/id'] })
    expect(await preTool({ call: edit, now: NOW, subagent: false, checks: { write: true } }, preToolDeps(denyWrite, { writeTargets: c => ({ paths: c.paths, contents: () => ({}) }) })))
      .toEqual({ action: 'deny', hook: 'H02', source: 'write', reason: 'a protected file' })
    expect(await preTool({ call: call({ tool: 'mcp__fs__write_file', kind: 'mcp', mcp: { server: 'fs', tool: 'write_file' }, input: { path: '/home/u/.ssh/id' } }), now: NOW, subagent: false, checks: { mcpWrite: true } }, preToolDeps(denyWrite)))
      .toMatchObject({ action: 'deny', hook: 'H02', source: 'mcpWrite' })
  }))

  test('the consent gate denies with H20, or holds the command when the harness can ask itself', () => withSandbox(async () => {
    const core = { consentVerdict: ((_c: string, s: unknown) => ({ allow: false, reason: 'git push needs consent', next: s })) as never }
    expect(await preTool({ call: call({ command: 'git push' }), now: NOW, subagent: false, checks: ALL }, preToolDeps({ core })))
      .toEqual({ action: 'deny', hook: 'H20', source: 'consent', reason: 'git push needs consent' })
    const held = await preTool({ call: call({ command: 'git push' }), now: NOW, subagent: false, checks: ALL }, preToolDeps({ core }, { holdConsent: async () => true }))
    expect(held).toMatchObject({ action: 'allow', held: { command: 'git push', reason: 'git push needs consent' } })
  }))

  test('routing and the usage gate deny with their hook; guards-only stops after the guards', () => withSandbox(async () => {
    expect(await preTool({ call: call(), now: NOW, subagent: false, checks: ALL }, preToolDeps({ core: { routeTool: () => ({ action: 'deny', reason: 'use the search server', hook: 'H03' }) } })))
      .toEqual({ action: 'deny', hook: 'H03', source: 'route', reason: 'use the search server' })
    expect(await preTool({ call: call(), now: NOW, subagent: false, checks: ALL }, preToolDeps({ core: { reminders: l => ({ next: l, deny: { reason: 'Buracle: load plan-build first', key: 'k' } }) } })))
      .toEqual({ action: 'deny', hook: 'H03', source: 'usage', reason: 'load plan-build first' })
    expect(await preTool({ call: call(), now: NOW, subagent: false, checks: ALL }, preToolDeps({}, { rootCheck: () => ({ deny: 'the root is your home folder' }) })))
      .toEqual({ action: 'deny', hook: 'H03', source: 'root', reason: 'the root is your home folder' })
    const quiet = await preTool({ call: call(), now: NOW, subagent: false, guardsOnly: true, checks: ALL }, preToolDeps({ core: { routeTool: () => ({ action: 'deny', reason: 'x', hook: 'H03' }) } }))
    expect(quiet).toEqual({ action: 'allow', context: [], parts: { route: [] } })
  }))

  test('a failing step falls back and the call goes on', () => withSandbox(async () => {
    const d = preToolDeps({ core: { routeTool: () => { throw new Error('no policy') } } })
    expect((await preTool({ call: call(), now: NOW, subagent: false, checks: ALL }, d)).action).toBe('allow')
    expect(d.rec.failed).toEqual(['H03 routing'])
  }))
})

const ROUTE: PromptRoute = { invoked: ['plan-build'], load: ['tdd'], candidates: [], categories: [], memory: { recall: false, write: false } }

function promptDeps(o: FakeOptions = {}, ports: Partial<PromptPorts> = {}) {
  return {
    ...fakeDeps(o),
    reviewNotes: () => 'two review notes wait',
    routePrompt: async () => ({ route: ROUTE, text: 'load the tdd skill' }),
    readOnlyStart: (invoked: readonly string[]) => `read-only: ${invoked.join(',')}`,
    contextWarning: () => 'the context window is 80% full',
    ...ports,
  }
}

describe('pipeline prompt', () => {
  test('a user prompt gets its parts in order, reaches the ledger and the spool, and touches the session', () => withSandbox(async () => {
    const routed: string[][] = []
    const d = promptDeps({}, { promptRouted: route => { routed.push(route.invoked) } })
    const r = await prompt({ harness: H, sessionId: SID, cwd: '/work/app', text: 'Add a parser for the config file', now: NOW }, d)
    expect(r.continuation).toBe(false)
    expect(r.user).toBe(true)
    expect(r.parts).toEqual({ notes: 'two review notes wait', route: 'load the tdd skill', planMode: 'read-only: plan-build,tdd', warning: 'the context window is 80% full' })
    expect(r.context).toEqual(['two review notes wait', 'read-only: plan-build,tdd', 'load the tdd skill', 'the context window is 80% full'])
    expect(routed).toEqual([['plan-build']])
    expect(loadLedger(H, SID).prompt?.route.load).toEqual(['tdd'])
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'prompt', excerpt: 'Add a parser for the config file' }])
    expect(d.rec.memory).toEqual([`seen:${SID}`])
    expect(d.rec.ui).toEqual(['seen'])
    expect(d.rec.points).toEqual(['prompt.user', 'prompt.granted', 'prompt.routed', 'prompt.record'])
    expect(d.rec.failed).toEqual([])
  }))

  test('the stop guard\'s own continuation is not routed, spooled or recorded', () => withSandbox(async () => {
    const d = promptDeps({ core: { isGuardContinuation: () => true } }, { routePrompt: async () => { throw new Error('not for a continuation') } })
    const r = await prompt({ harness: H, sessionId: SID, cwd: '/work/app', text: 'continue', now: NOW }, d)
    expect({ continuation: r.continuation, user: r.user, context: r.context }).toEqual({ continuation: true, user: false, context: ['the context window is 80% full'] })
    expect(d.rec.spool).toEqual([])
    expect(d.rec.memory).toEqual([])
    expect(d.rec.ui).toEqual(['seen'])
    expect(d.rec.failed).toEqual([])
  }))

  test('text the user did not write is spooled without an excerpt and not routed; capture off skips the session record', () => withSandbox(async () => {
    const d = promptDeps({ captureOff: true })
    const r = await prompt({ harness: H, sessionId: SID, cwd: '/work/app', text: '<task-notification>done</task-notification>', userText: false, now: NOW }, d)
    expect({ user: r.user, parts: r.parts }).toEqual({ user: false, parts: { warning: 'the context window is 80% full' } })
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'prompt' }])
    expect(d.rec.memory).toEqual([])
  }))
})

const STOP_GUARD: StopPorts['stopGuard'] = { gate: false, write: 'always', auditOnFailure: false }

function stopDeps(o: FakeOptions = {}, ports: Partial<StopPorts> = {}) {
  return { ...fakeDeps(o), readPlan: () => undefined, stopGuard: STOP_GUARD, ...ports }
}

const stopInput = (over: Partial<StopInput> = {}): StopInput => ({ harness: H, sessionId: SID, cwd: '/work/app', now: NOW, ...over })

describe('pipeline stop', () => {
  test('allows a stop without a plan and says why', () => withSandbox(async () => {
    const d = stopDeps()
    expect(await stop(stopInput(), d)).toEqual({ decision: { action: 'allow' }, why: 'no-plan' })
    expect(d.rec.points).toEqual(['stop.guard'])
  }))

  test('the stop guard blocks, saves the state it returns and never sees the subagent flag', () => withSandbox(async () => {
    updateState(H, SID, () => planState())
    const seen: StopInput[] = []
    const verdict = (s: ReturnType<typeof planState>, input: StopInput): StopGuardResult => {
      seen.push(input)
      return { decision: { action: 'block', reason: 'two steps are open', hook: 'H11' }, next: { ...s, guard: { blocksForPlan: 1, blocksInChain: 1 } }, why: 'blocked' }
    }
    const r = await stop(stopInput({ subagent: false, lastMessage: 'done' }), stopDeps({ core: { stopGuardVerdict: verdict as never } }, { stopInput: input => { input.readOnly = true } }))
    expect(r).toEqual({ decision: { action: 'block', reason: 'two steps are open', hook: 'H11' }, blockedBy: 'guard' })
    expect(seen).toEqual([{ harness: H, sessionId: SID, cwd: '/work/app', now: NOW, lastMessage: 'done', readOnly: true }])
    expect(loadState(H, SID).guard.blocksInChain).toBe(1)
  }))

  test('a stop the guard lets through gets the harness notice, then the turn audit may block it (H23)', () => withSandbox(async () => {
    updateState(H, SID, () => planState())
    const finished = (s: ReturnType<typeof planState>): StopGuardResult => ({ decision: { action: 'allow' }, next: s, why: 'finished' })
    const audit = { turnAudit: () => ({ action: 'block' as const, reason: 'the routed skill was never loaded', hook: 'H23' as const }), ledgerAudited: (l: ReturnType<typeof loadLedger>) => l }
    const r = await stop(stopInput(), stopDeps({ core: { stopGuardVerdict: finished as never, ...audit } }, { stopNotice: result => `stopped: ${result.why}` }))
    expect(r).toEqual({ decision: { action: 'block', reason: 'the routed skill was never loaded', hook: 'H23' }, blockedBy: 'audit', why: 'finished', notice: 'stopped: finished' })
    const sub = await stop(stopInput({ subagent: true }), stopDeps({ core: { stopGuardVerdict: finished as never, ...audit } }))
    expect(sub).toEqual({ decision: { action: 'allow' }, why: 'finished' })
  }))

  test('the harness decides what a failed guard and the config gate mean', () => withSandbox(async () => {
    updateState(H, SID, () => planState())
    const core = { stopGuardVerdict: (() => { throw new Error('boom') }) as never }
    const ends = stopDeps({ core })
    expect(await stop(stopInput(), ends)).toEqual({ decision: { action: 'allow' }, failed: true })
    expect(ends.rec.failed).toEqual(['stop guard'])
    expect(await stop(stopInput(), stopDeps({ core }, { stopGuard: { gate: false, write: 'changed', auditOnFailure: true } }))).toEqual({ decision: { action: 'allow' }, failed: true })
    const off = fakeDeps().ctx.config
    const gated = await stop(stopInput(), stopDeps({ core, config: { ...off, plan: { ...off.plan, stopGuard: false } } }, { stopGuard: { gate: true, write: 'changed', auditOnFailure: true } }))
    expect(gated).toEqual({ decision: { action: 'allow' }, why: 'disabled' })
  }))
})

describe('pipeline sessionStart, postTool, preCompact and sessionEnd', () => {
  test('sessionStart runs the harness order, with its own steps in between, and leaves room for the memory index', () => withSandbox(async () => {
    const ran: string[] = []
    const ports: SessionStartPorts = {
      sessionStartOrder: ['record', () => { ran.push('own') }, 'ledger', 'ui', 'card', 'restore', 'notices', 'profile', 'memory', 'maint'],
      capabilityCard: () => { ran.push('card'); return 'Capability card' },
      restore: () => 'restored',
      noticesOff: () => false,
      startupNotices: () => ({ model: 'tell the user', user: 'a notice' }),
      runtimeConfigFile: () => '/nonexistent/runtime-config.json',
      profileEnv: () => ({}),
      sessionMaint: () => { ran.push('maint') },
    }
    const d = fakeDeps({ memory: { contextText: async o => `index within ${o.maxBytes}` } })
    const r = await sessionStart({ harness: H, sessionId: SID, cwd: '/work/app', source: 'startup', model: 'm', now: NOW }, { ...d, ...ports })
    expect(ran).toEqual(['own', 'card', 'maint'])
    expect(r.parts.restore).toBe('')
    expect(r.parts.notice).toEqual({ model: 'tell the user', user: 'a notice' })
    expect(r.parts.memory).toBe(`index within ${r.parts.room}`)
    expect(r.context).toEqual(['tell the user', r.parts.memory, 'Capability card'])
    expect(d.rec.memory).toEqual([`start:${SID}`])
    expect(d.rec.ui).toEqual(['started'])
    const compact = await sessionStart({ harness: H, sessionId: SID, cwd: '/work/app', source: 'compact', now: NOW }, { ...fakeDeps({ memoryOff: true }), ...ports })
    expect(compact.context).toEqual(['restored', 'Capability card'])
  }))

  test('postTool spools the entries, records the answer and the MCP result where the harness asks', () => withSandbox(async () => {
    const order: string[] = []
    const ports: PostToolPorts = { fileCheckDeps: () => ({ now: () => NOW, run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) }), answerReceipt: () => { order.push('receipt') }, editBudgetMs: 1_000 }
    const d = fakeDeps({ core: { ledgerMcpResult: (l, server, ok) => { order.push(`mcp:${server}:${ok}`); return l } } })
    const r = await postTool({ harness: H, sessionId: SID, cwd: '/work/app', now: NOW, subagent: false, answered: true, entries: [{ ts: NOW, ev: 'tool', tool: 'Bash', kind: 'bash' }], mcp: { server: () => 'docs', ok: false } }, { ...d, ...ports, spool: async (_s, e) => { order.push(`spool:${e.length}`) } })
    expect(r).toEqual({ context: [], fileNotes: [] })
    expect(order).toEqual(['receipt', 'spool:1', 'mcp:docs:false'])
    expect(d.rec.ui).toEqual(['seen'])
  }))

  test('preCompact records the compaction, writes the handoff and points the record at it', () => withSandbox(async () => {
    const records: Array<[string | undefined, string[]]> = []
    const ports: PreCompactPorts = {
      openTodos: () => ['Add the tests'],
      saveCompactRecord: (handoff, todo) => { records.push([handoff, todo]) },
      handoffNote: o => ({ slug: `${o.project}-${o.branch}`, markdown: o.todo.join('\n') }),
    }
    const d = fakeDeps()
    expect(await preCompact({ harness: H, sessionId: SID, cwd: '/work/app', trigger: 'auto', now: NOW }, { ...d, ...ports })).toEqual({ todo: ['Add the tests'], handoff: 'handoff-app' })
    expect(records).toEqual([[undefined, ['Add the tests']], ['handoff-app', ['Add the tests']]])
    expect(d.rec.handoffs).toEqual([{ harness: H, sessionId: SID, cwd: '/work/app', project: 'app', branch: 'main', slug: 'app-main', markdown: 'Add the tests', trigger: 'auto', now: NOW }])
    const off = fakeDeps({ memoryOff: true })
    expect(await preCompact({ harness: H, sessionId: SID, cwd: '/work/app', now: NOW }, { ...off, ...ports })).toEqual({ todo: ['Add the tests'] })
    expect(off.rec.handoffs).toEqual([])
  }))

  test('sessionEnd closes the UI record and starts the finalizer unless capture is off', () => withSandbox(async () => {
    const d = fakeDeps()
    expect(await sessionEnd({ harness: H, sessionId: SID, now: NOW }, d)).toEqual({ finalized: true })
    expect(d.rec).toMatchObject({ ui: ['ended'], memory: [`finalize:${SID}`] })
    const off = fakeDeps({ captureOff: true })
    expect(await sessionEnd({ harness: H, sessionId: SID, now: NOW }, off)).toEqual({ finalized: false })
    expect(off.rec).toMatchObject({ ui: ['ended'], memory: [] })
    const missing: string[] = []
    const none = fakeDeps({ memory: { spawnFinalizer: undefined as never } })
    expect(await sessionEnd({ harness: H, sessionId: SID, now: NOW }, { ...none, noFinalizer: sid => { missing.push(sid) } })).toEqual({ finalized: false })
    expect(missing).toEqual([SID])
  }))
})

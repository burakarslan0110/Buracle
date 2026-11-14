import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { CANONICAL_EVENTS, type StopInput } from '../../../../src/core/events'
import type { PromptRoute } from '../../../../src/core/policy/skill-router'
import type { StopGuardResult } from '../../../../src/core/plan/state'
import type { ReminderContext } from '../../../../src/core/policy/usage'
import type { WriteGuardContext } from '../../../../src/core/policy/write-guard'
import type { WorkspaceInfo } from '../../../../src/core/workspace'
import * as paths from '../../../../src/engine/paths'
import * as pipeline from '../../../../src/adapters/shared/pipeline/index'
import {
  clipBytes, contextJson, CONTEXT_BUDGET_BYTES, denyReason, fitParts, guardFailed, postTool, preCompact, preTool, prompt, readWorkspace, saveWorkspace,
  sessionEnd, sessionStart, stop, workspaceStart,
  type CompactRecord, type PostToolPorts, type PreToolInput, type PreToolPorts, type PromptPorts, type SessionStartPorts, type StopPorts,
} from '../../../../src/adapters/shared/pipeline/index'
import { loadLedger } from '../../../../src/workflow/ledger'
import { loadState, updateState } from '../../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../../helpers/sandbox'
import { call, fakeDeps, H, NOW, plan, planState, SID, type FakeOptions } from './helpers'

function preToolDeps(o: FakeOptions = {}, ports: Partial<PreToolPorts> = {}) {
  return {
    ...fakeDeps({ ...o, core: { checkBash: () => ({}), checkWrite: () => ({}), routeTool: () => ({ action: 'allow' as const }), reminders: l => ({ next: l }), ...o.core } }),
    writeTargets: () => undefined,
    nativeOff: () => [],
    usage: (c: ReturnType<typeof call>) => ({ call: c, ledgerId: SID, available: ['semble'] }),
    ...ports,
  }
}

const pre = (over: Partial<PreToolInput> = {}): PreToolInput => ({ call: call(), now: NOW, subagent: false, usage: true, ...over })
const WRITE = call({ tool: 'Write', kind: 'write', paths: ['/home/u/.ssh/id'] })
const targets = { writeTargets: (c: ReturnType<typeof call>) => ({ paths: c.paths, contents: () => ({}) }) }

describe('pipeline: the seven canonical events', () => {
  test('each canonical event has a function', () => {
    const fns = pipeline as unknown as Record<string, unknown>
    expect([...CANONICAL_EVENTS]).toEqual(['sessionStart', 'prompt', 'preTool', 'postTool', 'stop', 'preCompact', 'sessionEnd'])
    for (const event of CANONICAL_EVENTS) expect({ event, fn: typeof fns[event] }).toEqual({ event, fn: 'function' })
  })
})

describe('pipeline: the shared output helpers', () => {
  test('every denial has one shape, and a guard that could not run says so', () => {
    expect(denyReason('H01', 'rm -rf / is blocked')).toBe('Buracle H01: rm -rf / is blocked')
    expect(denyReason('H03', 'Buracle: load plan-build first')).toBe('Buracle H03: load plan-build first')
    expect(guardFailed('H01', new Error('boom\nstack'))).toStartWith('Buracle H01: the bash guard could not check this command (boom), so the call is blocked')
    expect(guardFailed('H02', 'x')).toStartWith('Buracle H02: the write guard could not check the files of this edit (x)')
  })

  test('clipBytes cuts at a line end within the byte budget; fitParts keeps whole parts in order', () => {
    expect(clipBytes('short', 100)).toBe('short')
    const clipped = clipBytes(`${'ç'.repeat(40)}\n${'b'.repeat(200)}`, 120)
    expect(new TextEncoder().encode(clipped).length).toBeLessThanOrEqual(120)
    expect(clipped).toBe(`${'ç'.repeat(40)}\n… (truncated)`)
    expect(fitParts(['a'.repeat(10), ' ', 'b'.repeat(20), 'c'.repeat(5)], 25)).toEqual(['a'.repeat(10), 'c'.repeat(5)])
    expect(fitParts(['a'.repeat(30), 'b'], 25)).toEqual(['a'.repeat(30)])
  })

  test('contextJson joins the parts, clips them to the context budget and leaves out what is empty', () => {
    expect(contextJson('PreToolUse', ['', '  '])).toBeUndefined()
    expect(contextJson('PreToolUse', [' one ', '', 'two'], ' note ')).toEqual({ systemMessage: 'note', hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'one\n\ntwo' } })
    const big = contextJson('SessionStart', ['x'.repeat(CONTEXT_BUDGET_BYTES * 2)])?.['hookSpecificOutput'] as { additionalContext: string }
    expect(new TextEncoder().encode(big.additionalContext).length).toBeLessThanOrEqual(CONTEXT_BUDGET_BYTES)
  })
})

describe('pipeline preTool', () => {
  test('allows a call and returns the route, usage and early-edit context in that order', () => withSandbox(async () => {
    updateState(H, SID, () => ({ ...planState(), plan: { ...plan, status: 'PENDING' as const, phase: 'plan' as const } }))
    let seen: ReminderContext | undefined
    const d = preToolDeps({ core: { routeTool: () => ({ action: 'allow', context: ['prefer rg'] }), reminders: (l, _c, ctx) => { seen = ctx; return { next: { ...l, turn: l.turn + 1 }, context: 'load the skill' } } } })
    const r = await preTool(pre({ call: call({ tool: 'apply_patch', kind: 'patch', paths: ['/work/app/src/a.ts'] }), edits: ['/work/app/src/a.ts'] }), d)
    expect(r).toMatchObject({ action: 'allow', context: ['prefer rg', 'load the skill', expect.stringContaining('is still in its plan phase')] })
    expect(loadState(H, SID).guard.earlyEditNoted).toBe(true)
    expect(loadLedger(H, SID).turn).toBe(1)
    expect(seen).toMatchObject({ strictness: d.ctx.config.routing.strictness, available: ['semble'], policy: { categories: [] }, facts: { home: paths.home(), codegraphIndexed: false } })
    expect(d.rec.failed).toEqual([])
  }))

  test('the call\'s kind picks the steps: a question is checked, and usage runs only where the harness counts the call', () => withSandbox(async () => {
    const ran: string[] = []
    const core = { checkBash: () => { ran.push('bash'); return {} }, checkQuestion: () => { ran.push('question'); return { context: 'ask once' } }, reminders: ((l: unknown) => { ran.push('usage'); return { next: l } }) as never }
    const asked = await preTool(pre({ call: call({ tool: 'request_user_input', kind: 'ask_user' }), usage: false }), preToolDeps({ core }))
    expect(asked).toEqual({ action: 'allow', context: ['ask once'] })
    expect(ran).toEqual(['question'])
    await preTool(pre(), preToolDeps({ core }))
    expect(ran).toEqual(['question', 'bash', 'usage'])
  }))

  test('the bash guard denies with its hook id before any later step runs', () => withSandbox(async () => {
    const ran: string[] = []
    const d = preToolDeps({ core: { checkBash: () => ({ deny: 'rm -rf / is blocked' }), routeTool: () => { ran.push('route'); return { action: 'allow' } } } })
    expect(await preTool(pre({ call: call({ command: 'rm -rf /' }) }), d)).toEqual({ action: 'deny', hook: 'H01', reason: 'Buracle H01: rm -rf / is blocked' })
    expect(ran).toEqual([])
    expect(await preTool(pre(), preToolDeps({}, { shellDenial: async () => 'Buracle: plan-build-review is a read-only reviewer' }))).toEqual({ action: 'deny', hook: 'H01', reason: 'Buracle H01: plan-build-review is a read-only reviewer' })
  }))

  test('a guard that throws denies in the guard-failed words (fail closed)', () => withSandbox(async () => {
    const boom = new Error('boom')
    expect(await preTool(pre(), preToolDeps({ core: { checkBash: () => { throw boom } } }))).toEqual({ action: 'deny', hook: 'H01', reason: guardFailed('H01', boom) })
    expect(await preTool(pre({ call: WRITE }), preToolDeps({ core: { checkWrite: () => { throw boom } } }, targets))).toEqual({ action: 'deny', hook: 'H02', reason: guardFailed('H02', boom) })
    expect(await preTool(pre({ call: WRITE }), preToolDeps({}, { writeTargets: () => { throw boom } }))).toEqual({ action: 'deny', hook: 'H02', reason: guardFailed('H02', boom) })
  }))

  test('the lane guard runs for a subagent only and keeps its own words; the write guards deny file and MCP writes', () => withSandbox(async () => {
    const lane = { core: { laneStateDenial: () => 'Buracle lane guard: another lane owns this state' } }
    expect((await preTool(pre(), preToolDeps(lane))).action).toBe('allow')
    expect(await preTool(pre({ subagent: true }), preToolDeps(lane))).toEqual({ action: 'deny', hook: 'H01', reason: 'Buracle lane guard: another lane owns this state' })
    const denyWrite = { core: { checkWrite: () => ({ deny: 'a protected file' }) } }
    expect(await preTool(pre({ call: WRITE }), preToolDeps(denyWrite, targets))).toEqual({ action: 'deny', hook: 'H02', reason: 'Buracle H02: a protected file' })
    expect((await preTool(pre({ call: WRITE }), preToolDeps(denyWrite))).action).toBe('allow')
    expect(await preTool(pre({ call: WRITE }), preToolDeps({}, { writeTargets: () => ({ deny: 'the patch cannot be followed' }) }))).toEqual({ action: 'deny', hook: 'H02', reason: 'Buracle H02: the patch cannot be followed' })
    const mcp = call({ tool: 'mcp__fs__write_file', kind: 'mcp', mcp: { server: 'fs', tool: 'write_file' }, input: { path: '/home/u/.ssh/id' } })
    expect(await preTool(pre({ call: mcp }), preToolDeps(denyWrite))).toEqual({ action: 'deny', hook: 'H02', reason: 'Buracle H02: a protected file' })
  }))

  test('the write guard gets the harness\'s resolver and checkout through the dependency object', () => withSandbox(async () => {
    const seen: unknown[] = []
    const d = { ...preToolDeps({ core: { checkWrite: (p, c: WriteGuardContext) => { seen.push(p, c.buracleRepo, c.realpath?.('/x')); return {} } } }, targets), realpath: () => '/real', buracleRepo: async () => '/repo' }
    await preTool(pre({ call: WRITE }), d)
    expect(seen).toEqual([['/home/u/.ssh/id'], '/repo', '/real'])
  }))

  test('the consent gate denies with H20, or holds the command when the harness can ask itself', () => withSandbox(async () => {
    const core = { consentVerdict: ((_c: string, s: unknown) => ({ allow: false, reason: 'git push needs consent', next: s })) as never }
    expect(await preTool(pre({ call: call({ command: 'git push' }) }), preToolDeps({ core }))).toEqual({ action: 'deny', hook: 'H20', reason: 'Buracle H20: git push needs consent' })
    const held = await preTool(pre({ call: call({ command: 'git push' }) }), preToolDeps({ core }, { holdConsent: async () => true }))
    expect(held).toMatchObject({ action: 'allow', held: { command: 'git push', reason: 'git push needs consent' } })
  }))

  test('routing and the usage gate deny with their hook; guards-only stops after the guards', () => withSandbox(async () => {
    expect(await preTool(pre(), preToolDeps({ core: { routeTool: () => ({ action: 'deny', reason: 'use the search server', hook: 'H03' }) } })))
      .toEqual({ action: 'deny', hook: 'H03', reason: 'Buracle H03: use the search server' })
    expect(await preTool(pre(), preToolDeps({ core: { reminders: l => ({ next: l, deny: { reason: 'Buracle: load plan-build first', key: 'k' } }) } })))
      .toEqual({ action: 'deny', hook: 'H03', reason: 'Buracle H03: load plan-build first' })
    const quiet = await preTool(pre({ guardsOnly: true }), preToolDeps({ core: { routeTool: () => ({ action: 'deny', reason: 'x', hook: 'H03' }) } }))
    expect(quiet).toEqual({ action: 'allow', context: [] })
  }))

  test('the harness\'s own off servers are read for web calls only', () => withSandbox(async () => {
    const asked: string[] = []
    const core = { routeTool: ((c: ReturnType<typeof call>, _p: unknown, health: Record<string, unknown>) => { asked.push(`${c.kind}:${Object.keys(health).join(',')}`); return { action: 'allow' } }) as never }
    const ports = { nativeOff: () => ['web-search'] }
    await preTool(pre(), preToolDeps({ core }, ports))
    await preTool(pre({ call: call({ tool: 'WebSearch', kind: 'web_search' }) }), preToolDeps({ core }, ports))
    expect(asked).toEqual(['bash:', 'web_search:web-search'])
  }))

  test('a failing step falls back and the call goes on', () => withSandbox(async () => {
    const d = preToolDeps({ core: { routeTool: () => { throw new Error('no policy') } } })
    expect((await preTool(pre(), d)).action).toBe('allow')
    expect(d.rec.failed).toEqual(['H03 routing'])
  }))
})

const ROUTE: PromptRoute = { invoked: ['plan-build'], load: ['tdd'], candidates: [], categories: [], memory: { recall: false, write: false } }

function promptDeps(o: FakeOptions = {}, ports: Partial<PromptPorts> = {}) {
  return {
    ...fakeDeps(o),
    routePrompt: async () => ({ route: ROUTE, text: 'load the tdd skill' }),
    readOnly: () => true,
    contextWarning: () => 'the context window is 80% full',
    ...ports,
  }
}

describe('pipeline prompt', () => {
  test('a user prompt gets its parts in order, reaches the ledger and the spool, and touches the session', () => withSandbox(async () => {
    const routed: string[][] = []
    const d = promptDeps({}, { promptRouted: route => { routed.push(route.invoked) }, granted: async () => 'the approved plan was saved' })
    const r = await prompt({ harness: H, sessionId: SID, cwd: '/work/app', text: 'Add a parser for the config file', now: NOW }, d)
    expect({ continuation: r.continuation, user: r.user }).toEqual({ continuation: false, user: true })
    expect(r.context).toEqual(['the approved plan was saved', expect.stringContaining('was started while the session is in'), 'load the tdd skill', 'the context window is 80% full'])
    expect(routed).toEqual([['plan-build']])
    expect(loadLedger(H, SID).prompt?.route.load).toEqual(['tdd'])
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'prompt', excerpt: 'Add a parser for the config file' }])
    expect(d.rec.memory).toEqual([`seen:${SID}`])
    expect(d.rec.ui).toEqual(['seen'])
    expect(d.rec.failed).toEqual([])
  }))

  test('the read-only note needs a file-writing workflow and a read-only session; a typed workflow counts', () => withSandbox(async () => {
    const input = { harness: H, sessionId: SID, cwd: '/work/app', text: 'Add a parser', now: NOW }
    const plain = { ...ROUTE, invoked: [], load: ['tdd'] }
    let asked = 0
    const none = await prompt(input, promptDeps({}, { routePrompt: async () => ({ route: plain }), readOnly: () => { asked++; return true } }))
    expect(none.context).toEqual(['the context window is 80% full'])
    expect(asked).toBe(0)
    const typed = await prompt(input, promptDeps({}, { routePrompt: async () => ({ route: plain }), typedWorkflow: 'plan-build' }))
    expect(typed.context[0]).toContain('was started while the session is in')
    const writable = await prompt(input, promptDeps({}, { readOnly: () => false }))
    expect(writable.context).toEqual(['load the tdd skill', 'the context window is 80% full'])
  }))

  test('the workspace notice refreshes the saved workspace when the harness can', () => withSandbox(async () => {
    const info = { cwd: '/work/app', children: [], index: { codegraph: { state: 'ready' }, semble: { state: 'ready' } } } as unknown as WorkspaceInfo
    const d = promptDeps({ workspace: { refreshWorkspace: w => ({ ...w, root: '/work/app' }) }, core: { workspaceNotice: (_a, b) => `root is now ${b.root}` } })
    saveWorkspace(d.ctx, H, SID, info)
    const r = await prompt({ harness: H, sessionId: SID, cwd: '/work/app', text: 'continue', now: NOW }, { ...d, routePrompt: async () => undefined })
    expect(r.context).toEqual(['root is now /work/app', 'the context window is 80% full'])
    expect(readWorkspace(d.ctx, H, SID)?.root).toBe('/work/app')
  }))

  test('the stop guard\'s own continuation is not routed, spooled or recorded', () => withSandbox(async () => {
    const d = promptDeps({ core: { isGuardContinuation: () => true } }, { routePrompt: async () => { throw new Error('not for a continuation') } })
    const r = await prompt({ harness: H, sessionId: SID, cwd: '/work/app', text: 'continue', now: NOW }, d)
    expect(r).toEqual({ continuation: true, user: false, context: ['the context window is 80% full'] })
    expect(d.rec.spool).toEqual([])
    expect(d.rec.memory).toEqual([])
    expect(d.rec.ui).toEqual(['seen'])
    expect(d.rec.failed).toEqual([])
  }))

  test('text the user did not write is spooled without an excerpt and not routed; capture off skips the spool and the session record', () => withSandbox(async () => {
    const d = promptDeps()
    const r = await prompt({ harness: H, sessionId: SID, cwd: '/work/app', text: '<task-notification>done</task-notification>', userText: false, now: NOW }, d)
    expect({ user: r.user, context: r.context }).toEqual({ user: false, context: ['the context window is 80% full'] })
    expect(d.rec.spool).toEqual([{ ts: NOW, ev: 'prompt' }])
    const off = promptDeps({ env: { BURACLE_NO_CAPTURE: '1' } })
    await prompt({ harness: H, sessionId: SID, cwd: '/work/app', text: 'Add a parser', now: NOW }, off)
    expect(off.rec).toMatchObject({ spool: [], memory: [] })
  }))
})

function stopDeps(o: FakeOptions = {}, ports: Partial<StopPorts> = {}) {
  return { ...fakeDeps(o), readOnly: () => false, ...ports }
}

const stopInput = (over: Partial<StopInput> = {}): StopInput => ({ harness: H, sessionId: SID, cwd: '/work/app', now: NOW, ...over })

describe('pipeline stop', () => {
  test('allows a stop without a plan and says why, without asking the harness for its mode', () => withSandbox(async () => {
    expect(await stop(stopInput(), stopDeps({}, { readOnly: () => { throw new Error('no plan, no question') } }))).toEqual({ decision: { action: 'allow' }, why: 'no-plan' })
  }))

  test('the stop guard blocks, saves the state it returns, learns the read-only mode and never sees the subagent flag', () => withSandbox(async () => {
    updateState(H, SID, () => planState())
    const seen: StopInput[] = []
    const verdict = (s: ReturnType<typeof planState>, input: StopInput): StopGuardResult => {
      seen.push(input)
      return { decision: { action: 'block', reason: 'two steps are open', hook: 'H11' }, next: { ...s, guard: { blocksForPlan: 1, blocksInChain: 1 } }, why: 'blocked' }
    }
    const r = await stop(stopInput({ subagent: false, lastMessage: 'done' }), stopDeps({ core: { stopGuardVerdict: verdict as never } }, { readOnly: () => true }))
    expect(r).toEqual({ decision: { action: 'block', reason: 'two steps are open', hook: 'H11' }, blockedBy: 'guard' })
    expect(seen).toEqual([{ harness: H, sessionId: SID, cwd: '/work/app', now: NOW, lastMessage: 'done', readOnly: true }])
    expect(loadState(H, SID).guard.blocksInChain).toBe(1)
  }))

  test('the guard reads the plan file from the session folder and validates it in the plan phase', () => withSandbox(async ({ root }) => {
    updateState(H, SID, () => ({ ...planState(), plan: { ...plan, phase: 'plan' as const } }))
    mkdirSync(`${root}/docs/plans`, { recursive: true })
    writeFileSync(`${root}/docs/plans/p.md`, '# Plan\n')
    const docs: unknown[] = []
    const core = { validatePlan: () => [], stopGuardVerdict: ((s: unknown, _i: unknown, _c: unknown, doc: unknown) => { docs.push(doc); return { decision: { action: 'allow' }, next: s, why: 'finished' } }) as never }
    await stop(stopInput({ cwd: root }), stopDeps({ core }))
    await stop(stopInput({ cwd: `${root}/elsewhere` }), stopDeps({ core }))
    expect(docs).toEqual([{ exists: true, findings: [], text: '# Plan\n' }, { exists: false, findings: [] }])
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

  test('a guard that fails lets the stop through and says so; a disabled guard answers from the core', () => withSandbox(async () => {
    updateState(H, SID, () => planState())
    const failing = stopDeps({ core: { stopGuardVerdict: (() => { throw new Error('boom') }) as never } })
    expect(await stop(stopInput(), failing)).toEqual({ decision: { action: 'allow' }, failed: true })
    expect(failing.rec.failed).toEqual(['stop guard'])
    const cfg = fakeDeps().ctx.config
    expect(await stop(stopInput(), stopDeps({ config: { ...cfg, plan: { ...cfg.plan, stopGuard: false } } }))).toEqual({ decision: { action: 'allow' }, why: 'disabled' })
  }))
})

function startPorts(record: CompactRecord = { recent: false }, over: Partial<SessionStartPorts> = {}): SessionStartPorts {
  return { capabilityCard: () => 'Capability card', compact: { read: () => record }, sessionMaint: () => {}, ...over }
}

const NOTICE = { id: 'pipeline-notice', since: '0.0.1', message: 'Hello from the pipeline test.' }

describe('pipeline sessionStart', () => {
  test('a startup runs every step once and leaves room for the memory index before the capability card', () => withSandbox(async () => {
    const ran: string[] = []
    let asked = 0
    const d = fakeDeps({ memory: { contextText: async o => { asked = o.maxBytes ?? 0; return ' the memory index ' } } })
    const r = await sessionStart({ harness: H, sessionId: SID, cwd: '/work/app', source: 'startup', model: 'm', now: NOW }, {
      ...d, ...startPorts(undefined, { capabilityCard: () => { ran.push('card'); return 'Capability card' }, sessionMaint: (_n, keep) => { ran.push(`maint:${keep.join()}`) }, extraContext: ['resume the run'] }),
    })
    expect(ran).toEqual(['card', `maint:${SID}`])
    expect(r).toEqual({ context: ['resume the run', 'the memory index', 'Capability card'] })
    expect(asked).toBe(CONTEXT_BUDGET_BYTES - new TextEncoder().encode('resume the run\n\nCapability card').length - 64)
    expect(d.rec.memory).toEqual([`start:${SID}`])
    expect(d.rec.ui).toEqual(['started'])
    expect(d.rec.failed).toEqual([])
  }))

  test('the one-time notices and the profile warning come back for the harness to place; the model gets the warning only where the harness asks', () => withSandbox(() => withEnv({ BURACLE_NO_NOTICES: undefined }, async () => {
    mkdirSync(paths.stateDir(), { recursive: true })
    writeFileSync(paths.runtimeConfigFile(), JSON.stringify({ v: 1, resolved: { codexHome: '/work/profile-a' } }))
    const o: FakeOptions = { env: { CODEX_HOME: '/work/profile-b' }, canonical: { notices: [NOTICE] } as never }
    const input = { harness: H, sessionId: SID, cwd: '/work/app', source: 'startup', now: NOW }
    const user = await sessionStart(input, { ...fakeDeps(o), ...startPorts() })
    expect(user.profile).toContain('/work/profile-a')
    expect(user.notice?.user).toContain('Hello from the pipeline test.')
    expect(user.context.join('\n')).not.toContain('/work/profile-a')
    const model = await sessionStart({ ...input, sessionId: `${SID}-2` }, { ...fakeDeps(o), ...startPorts(undefined, { profileNote: f => `tell the user: ${f}` }) })
    expect(model.context[0]).toStartWith('tell the user: Buracle was installed for Codex into /work/profile-a')
    expect(model.notice).toBeUndefined()
    const off = await sessionStart({ ...input, sessionId: `${SID}-3` }, { ...fakeDeps({ ...o, env: { BURACLE_NO_NOTICES: '1' }, canonical: { notices: [{ ...NOTICE, id: 'pipeline-notice-2' }] } as never }), ...startPorts() })
    expect(off).toEqual({ context: ['Capability card'] })
  })))

  test('after a compaction the restore uses the session\'s own record, else the newest handoff another session left', () => withSandbox(async () => {
    const input = { harness: H, sessionId: SID, cwd: '/work/app', source: 'compact', now: NOW }
    const core = { restoreContext: ((_s: unknown, handoff?: string, todo?: string[]) => `restored ${handoff ?? todo?.join('+') ?? 'nothing'}`) as never }
    const memory = { latestHandoff: async () => ({ id: 'handoff-latest', path: '', rel: '', title: '' }) }
    const restored = async (record: CompactRecord, o: FakeOptions = {}) => (await sessionStart(input, { ...fakeDeps({ core, memory, ...o }), ...startPorts(record) })).context[0]
    expect(await restored({ recent: true, handoff: 'handoff-own', todo: ['ignored'] })).toBe('restored handoff-own')
    expect(await restored({ recent: true, todo: ['Add the tests', 'Ship it'] })).toBe('restored Add the tests+Ship it')
    expect(await restored({ recent: true })).toBe('restored nothing')
    expect(await restored({ recent: false })).toBe('restored handoff-latest')
    expect(await restored({ recent: false }, { env: { BURACLE_NO_MEMORY: '1' } })).toBe('restored nothing')
    const d = fakeDeps({ core, memory })
    await sessionStart(input, { ...d, ...startPorts() })
    expect(d.rec).toMatchObject({ memory: [], ui: ['seen'] })
  }))

  test('the workspace note saves the session\'s workspace; a subagent in the same folder reads it back', () => withSandbox(async ({ root }) => {
    const info = { cwd: paths.home(), children: [], root, index: { codegraph: { state: 'ready' }, semble: { state: 'ready' } } } as unknown as WorkspaceInfo
    const lookups: string[] = []
    const d = fakeDeps({
      core: { workspaceContext: i => `workspace ${i.root}` },
      workspace: { prepareWorkspace: async () => { lookups.push('prepare'); return info }, workspaceInfo: async () => { lookups.push('info'); return undefined }, refreshWorkspace: i => { lookups.push('refresh'); return i } },
    })
    expect(await workspaceStart({ sessionId: SID, cwd: info.cwd, now: NOW }, d)).toBe(`workspace ${root}`)
    expect(readWorkspace(d.ctx, H, SID)?.root).toBe(root)
    expect(await workspaceStart({ sessionId: SID, cwd: info.cwd, subagent: true, now: NOW }, d)).toBe(`workspace ${root}`)
    expect(await workspaceStart({ sessionId: SID, cwd: `${root}/other`, subagent: true, now: NOW }, d)).toBe('')
    expect(lookups).toEqual(['prepare', 'refresh', 'info'])
  }))
})

describe('pipeline postTool, preCompact and sessionEnd', () => {
  test('postTool records the answer, spools the entries, then records the MCP result', () => withSandbox(async () => {
    const order: string[] = []
    const ports: PostToolPorts = { fileChecks: { now: () => NOW, run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) }, editBudgetMs: 1_000 }
    const d = fakeDeps({
      core: { answerReceipt: s => { order.push('receipt'); return s }, ledgerMcpResult: (l, server, ok) => { order.push(`mcp:${server}:${ok}`); return l } },
      memory: { appendSpool: (_h, _s, e) => { order.push(`spool:${e.length}`) } },
    })
    const r = await postTool({ sessionId: SID, cwd: '/work/app', now: NOW, subagent: false, answered: true, entries: [{ ts: NOW, ev: 'tool', tool: 'Bash', kind: 'bash' }], mcp: { server: () => 'docs', ok: false } }, { ...d, ...ports })
    expect(r).toEqual({ context: [], fileNotes: [] })
    expect(order).toEqual(['receipt', 'spool:1', 'mcp:docs:false'])
    expect(d.rec.ui).toEqual(['seen'])
    const sub = fakeDeps()
    await postTool({ sessionId: SID, cwd: '/work/app', now: NOW, subagent: true, entries: [] }, { ...sub, ...ports })
    expect(sub.rec).toMatchObject({ ui: [], spool: [] })
  }))

  test('preCompact records the compaction, writes the handoff with the open todos and points the record at it', () => withSandbox(async () => {
    const records: Array<[string | undefined, string[]]> = []
    const ports = { openTodos: () => ['Add the tests'], compact: { save: (handoff: string | undefined, todo: string[]) => { records.push([handoff, todo]) } } }
    const core = { handoffNote: ((o: { project: string, branch?: string, todo?: string[] }) => ({ slug: `${o.project}-${o.branch}`, markdown: (o.todo ?? []).join('\n') })) as never }
    const d = fakeDeps({ core })
    expect(await preCompact({ harness: H, sessionId: SID, cwd: '/work/app', trigger: 'auto', now: NOW }, { ...d, ...ports })).toEqual({ todo: ['Add the tests'], handoff: 'handoff-app' })
    expect(records).toEqual([[undefined, ['Add the tests']], ['handoff-app', ['Add the tests']]])
    expect(d.rec.handoffs).toEqual([{ harness: H, sessionId: SID, cwd: '/work/app', project: 'app', branch: 'main', slug: 'app-main', markdown: 'Add the tests', trigger: 'auto', now: NOW }])
    const off = fakeDeps({ core, env: { BURACLE_NO_MEMORY: '1' } })
    expect(await preCompact({ harness: H, sessionId: SID, cwd: '/work/app', now: NOW }, { ...off, ...ports })).toEqual({ todo: ['Add the tests'] })
    expect(off.rec.handoffs).toEqual([])
    expect(records[2]).toEqual([undefined, ['Add the tests']])
  }))

  test('sessionEnd closes the UI record and starts the finalizer unless capture is off', () => withSandbox(async () => {
    const d = fakeDeps()
    expect(await sessionEnd({ harness: H, sessionId: SID, now: NOW }, d)).toEqual({ finalized: true })
    expect(d.rec).toMatchObject({ ui: ['ended'], memory: [`finalize:${SID}`] })
    const off = fakeDeps({ env: { BURACLE_NO_CAPTURE: '1' } })
    expect(await sessionEnd({ harness: H, sessionId: SID, now: NOW }, off)).toEqual({ finalized: false })
    expect(off.rec).toMatchObject({ ui: ['ended'], memory: [] })
    const missing: string[] = []
    const none = fakeDeps({ memory: { spawnFinalizer: undefined as never } })
    expect(await sessionEnd({ harness: H, sessionId: SID, now: NOW }, { ...none, noFinalizer: sid => { missing.push(sid) } })).toEqual({ finalized: false })
    expect(missing).toEqual([SID])
  }))
})

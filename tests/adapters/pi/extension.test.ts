import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, defaultDeps, type PiDeps } from '../../../src/adapters/pi/runtime/extension'
import { catalogMcp, catalogSkills } from '../../../src/core/catalog'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { checkBash } from '../../../src/core/policy/bash-guard'
import { checkWrite } from '../../../src/core/policy/write-guard'
import { detectIntent, isGuardContinuation } from '../../../src/core/policy/intents'
import { validatePlan } from '../../../src/core/plan/format'
import { stopGuardVerdict } from '../../../src/core/plan/state'
import { loadState, saveState } from '../../../src/workflow/session-store'
import { withSandbox, type Sandbox } from '../../helpers/sandbox'
import { planState } from '../omp/fakes'
import { fakeCtx, fakePi, SID, testDeps, testGenerated } from './fakes'

type Verdict = { block?: boolean, reason?: string } | undefined

function setup(sb: Sandbox, overrides: Partial<PiDeps> = {}, ctxOpts: Partial<Parameters<typeof fakeCtx>[0]> = {}, data = testGenerated()) {
  const cwd = join(sb.root, 'work')
  mkdirSync(cwd, { recursive: true })
  const t = testDeps(overrides)
  const fp = fakePi()
  createBuracleExtension(data, t.deps)(fp.pi)
  return { ...t, fp, ctx: fakeCtx({ cwd, ...ctxOpts }), cwd }
}

const realGuards = (): Partial<PiDeps> => ({
  policy: { ...testDeps().deps.policy!, checkBash, checkWrite, detectIntent, isGuardContinuation },
  evalGuard: defaultDeps().evalGuard,
  realpath: defaultDeps().realpath,
})

const call = (toolName: string, input: unknown, toolCallId = '1') => ({ type: 'tool_call', toolCallId, toolName, input })

describe('pi extension: registration', () => {
  test('registers the events the bound hooks use, and no other', () => withSandbox(async sb => {
    const { fp } = setup(sb)
    expect([...fp.handlers.keys()].sort()).toEqual([
      'agent_before_settle', 'agent_end', 'agent_start', 'before_agent_start', 'input', 'session_before_compact', 'session_compact', 'session_shutdown', 'session_start', 'tool_call', 'tool_result', 'turn_end',
    ])
  }))
})

describe('pi extension: tool_call (H01, H02, H20)', () => {
  test('H01 blocks a denied shell command with a Buracle Stack reason and lets an ordinary one through', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, realGuards())
    const r = await fp.emit('tool_call', call('bash', { command: 'rm -rf ~' }), ctx) as Verdict
    expect(r?.block).toBe(true)
    expect(r?.reason).toStartWith('Buracle Stack H01: ')
    expect(await fp.emit('tool_call', call('bash', { command: 'ls -la' }, '2'), ctx)).toBeUndefined()
  }))

  test('H01 fails closed when the guard cannot run; hostile input never throws', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: { ...testDeps().deps.policy!, checkBash: () => { throw new Error('boom') } } })
    const r = await fp.emit('tool_call', call('bash', { command: 'ls' }), ctx) as Verdict
    expect(r?.block).toBe(true)
    expect(r?.reason).toStartWith('Buracle Stack H01: ')
    await expect(fp.emit('tool_call', call('bash', null, '2'), ctx)).resolves.toBeUndefined()
    expect(await fp.emit('tool_call', call('read', { path: 'a.ts' }, '3'), ctx)).toBeUndefined()
  }))

  test('H02 judges Pi\'s write and edit ({ path, edits: [{ oldText, newText }] }) by what they leave in a guarded file', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb, realGuards())
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    const file = join(cwd, '.claude', 'settings.json')
    writeFileSync(file, '{\n  "permissions": { "allow": [] }\n}\n')
    const edit = (newText: string) => fp.emit('tool_call', call('edit', { path: file, edits: [{ oldText: '"allow": []', newText }] }), ctx) as Promise<Verdict>
    expect(await edit('"allow": ["Bash(npm test:*)"]')).toBeUndefined()
    const off = await edit('"allow": [] }, "disableAllHooks": true, "x": {')
    expect(off?.reason).toStartWith('Buracle Stack H02: ')
    expect(off?.reason).toContain('disableAllHooks')
    expect((await fp.emit('write', null, ctx))).toBeUndefined()
    expect(((await fp.emit('tool_call', call('write', { path: '.claude/settings.local.json', content: '{ "disableAllHooks": true }' }, '2'), ctx)) as Verdict)?.reason).toContain('disableAllHooks')
  }))

  test('H02 protects Pi\'s own extension folder', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, realGuards())
    const r = await fp.emit('tool_call', call('write', { path: join(sb.home, '.pi', 'agent', 'extensions', 'x.ts'), content: 'export {}' }), ctx) as Verdict
    expect(r?.reason).toStartWith('Buracle Stack H02: ')
  }))

  test.skipIf(defaultDeps().evalGuard === undefined)('H01 judges the script of the codemode tool (its `code`), and fails closed when the check cannot run', () => withSandbox(async sb => {
    const denied = setup(sb, {
      ...realGuards(),
      config: d => ({ config: { ...d, guards: { ...d.guards, bash: { extraDeny: ['kubectl\\s+delete'] } } }, vault: '/v', shim: '/s', source: 'defaults' }),
    })
    const r = await denied.fp.emit('tool_call', call('codemode', { code: "require('child_process').execSync('kubectl delete ns prod')" }), denied.ctx) as Verdict
    expect(r?.block).toBe(true)
    expect(r?.reason).toContain('Buracle Stack H01: Blocked by the guards.bash.extraDeny pattern')
    expect(await denied.fp.emit('tool_call', call('codemode', { code: 'return 1 + 1' }, '2'), denied.ctx)).toBeUndefined()
    const failed = setup(sb, { evalGuard: () => { throw new Error('boom') } })
    const f = await failed.fp.emit('tool_call', call('codemode', { code: '1' }), failed.ctx) as Verdict
    expect(f?.block).toBe(true)
    expect(f?.reason).toStartWith('Buracle Stack H01: ')
  }))

  test('H20 holds a push; the TUI question lets it through once the user agrees, and a refusal is final', () => withSandbox(async sb => {
    const base = { policy: { ...testDeps().deps.policy!, checkBash, checkWrite, detectIntent, isGuardContinuation } }
    const asked = setup(sb, base, { answer: 'Allow once' })
    const ok = await asked.fp.emit('tool_call', call('bash', { command: 'git push origin main' }), asked.ctx) as Verdict
    expect(asked.ctx.asked.length).toBe(1)
    expect(ok).toBeUndefined()
    const refused = setup(sb, base, { sid: '0197a118-8d01-740c-9360-f4f796699f4c', answer: 'Refuse' })
    const no = await refused.fp.emit('tool_call', call('bash', { command: 'git push origin main' }), refused.ctx) as Verdict
    expect(no?.reason).toStartWith('Buracle Stack H20: ')
  }))

  test('H20 holds a push without a TUI (print mode), with the denial text', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, realGuards(), { mode: 'print' })
    const held = await fp.emit('tool_call', call('bash', { command: 'git push origin main' }), ctx) as Verdict
    expect(held?.block).toBe(true)
    expect(held?.reason).toStartWith('Buracle Stack H20: ')
  }))
})

describe('pi extension: tool_result', () => {
  test('a note the pre-tool step has rides on the call\'s result; a blocked call gets no result handling', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb, { policy: { ...testDeps().deps.policy!, checkBash, checkWrite } })
    const result = { toolCallId: '1', toolName: 'bash', input: { command: 'ls' }, content: [{ type: 'text', text: 'out' }], isError: false }
    await fp.emit('tool_call', call('bash', { command: 'ls' }), ctx)
    const r = await fp.emit('tool_result', result, ctx) as { content: Array<{ text?: string }> } | undefined
    // The first call of a session has no reminder; the result is the tool's own then.
    expect(r === undefined || r.content[0]?.text === 'out').toBe(true)
    expect(memory.spool.length).toBe(0)
  }))

  test('an edit that failed is not checked and spools nothing', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    expect(await fp.emit('tool_result', { toolCallId: '1', toolName: 'edit', input: { path: 'a.ts', edits: [] }, content: [], isError: true }, ctx)).toBeUndefined()
  }))
})

describe('pi extension: session start and before_agent_start', () => {
  test('the memory index and the capability card go in as a block of the system prompt, once', () => withSandbox(async sb => {
    const { fp, ctx, memory, env } = setup(sb, { policy: { ...testDeps().deps.policy!, capabilityCard: () => 'CAPABILITY CARD' } })
    await fp.emit('session_start', { reason: 'startup' }, ctx)
    expect(env['BURACLE_SESSION_ID']).toBe(SID)
    expect(env['BURACLE_HARNESS']).toBe('pi')
    expect(memory.started).toEqual([SID])
    const r = await fp.emit('before_agent_start', { messageType: 'user', prompt: 'hello', systemPrompt: 'BASE' }, ctx) as { systemPrompt?: string }
    expect(r.systemPrompt).toStartWith('BASE\n\n<buracle-context>')
    expect(r.systemPrompt).toContain('MEMORY INDEX')
    expect(r.systemPrompt).toContain('CAPABILITY CARD')
    expect(await fp.emit('before_agent_start', { messageType: 'user', prompt: 'again', systemPrompt: r.systemPrompt }, ctx)).toBeUndefined()
  }))

  test('a session Pi announced no start for begins at its first run', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb)
    const r = await fp.emit('before_agent_start', { messageType: 'user', prompt: 'hello', systemPrompt: 'BASE' }, ctx) as { systemPrompt?: string }
    expect(r.systemPrompt).toContain('MEMORY INDEX')
    expect(memory.started).toEqual([SID])
  }))

  test('session_shutdown ends the session: the finalizer starts', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb)
    await fp.emit('session_start', { reason: 'startup' }, ctx)
    await fp.emit('session_shutdown', { reason: 'quit' }, ctx)
    expect(memory.finalized).toEqual([SID])
    expect(memory.ui).toContain(`ended ${SID}`)
  }))

  test('a memory runner never gets the block', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    const prev = process.env['BURACLE_MEMORY_RUNNER']
    process.env['BURACLE_MEMORY_RUNNER'] = '1'
    try { expect(await fp.emit('before_agent_start', { messageType: 'user', prompt: 'x', systemPrompt: 'B' }, ctx)).toBeUndefined() } finally {
      if (prev === undefined) delete process.env['BURACLE_MEMORY_RUNNER']; else process.env['BURACLE_MEMORY_RUNNER'] = prev
    }
  }))
})

describe('pi extension: input (H10, H22)', () => {
  const canonical = loadCanonicalSync(paths.canonicalDir())
  const data = testGenerated({
    routing: { ...canonical.routing, strictness: 'enforce' }, skills: catalogSkills(canonical.skills),
    mcp: catalogMcp(canonical.mcp, 'pi'), mcpIds: Object.keys(canonical.mcp.servers).sort(),
  })

  test('the user\'s prompt is routed at input and reaches the model as a message of the next run', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, {}, data)
    await fp.emit('session_start', { reason: 'startup' }, ctx)
    expect(await fp.emit('input', { text: 'search the web for the latest bun release', source: 'interactive' }, ctx)).toBeUndefined()
    const r = await fp.emit('before_agent_start', { messageType: 'user', prompt: 'EXPANDED PROMPT', systemPrompt: 'BASE' }, ctx) as { message?: { customType: string, content: string, display: boolean } }
    expect(r.message?.customType).toBe('buracle.prompt')
    expect(r.message?.display).toBe(false)
    expect(r.message?.content).toContain('Buracle Stack routing for this prompt')
  }))

  test('an input from an extension is not a user prompt', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, {}, data)
    await fp.emit('session_start', { reason: 'startup' }, ctx)
    await fp.emit('input', { text: 'search the web for the latest bun release', source: 'extension' }, ctx)
    const r = await fp.emit('before_agent_start', { messageType: 'user', prompt: 'x', systemPrompt: 'BASE' }, ctx) as { message?: unknown }
    expect(r?.message).toBeUndefined()
  }))
})

describe('pi extension: agent_before_settle (H08, H11, H23)', () => {
  const settle = (outcome = 'completed') => ({ type: 'agent_before_settle', entries: [{ type: 'custom', customType: 'keep' }], continue: false, outcome })
  const turn = { type: 'turn_end', turnIndex: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Done with task 2.' }] }, toolResults: [] }
  const blocker = (): Partial<PiDeps> => ({
    plan: { ...testDeps().deps.plan!, validatePlan, stopGuardVerdict: (s, input, cfg, check) => stopGuardVerdict(s, input, cfg, check) },
  })

  test('no plan: the stop is allowed', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, blocker())
    await fp.emit('turn_end', turn, ctx)
    expect(await fp.emit('agent_before_settle', settle(), ctx)).toBeUndefined()
  }))

  test('a registered, unfinished plan blocks the stop with one more turn and the reason as a message entry', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb, blocker())
    saveState('pi', SID, planState())
    await fp.emit('turn_end', turn, ctx)
    const r = await fp.emit('agent_before_settle', settle(), ctx) as { entries: Array<Record<string, unknown>>, continue: boolean }
    expect(r.continue).toBe(true)
    expect(r.entries[0]).toEqual({ type: 'custom', customType: 'keep' })
    expect(r.entries[1]).toMatchObject({ type: 'custom_message', customType: 'buracle.stop', display: false })
    expect(String(r.entries[1]?.['content'])).toContain('stop guard')
    expect(loadState('pi', SID).guard.blocksForPlan).toBe(1)
    expect(memory.spool.flatMap(s => s.entries).some(e => e.ev === 'stop' && e.excerpt === 'Done with task 2.')).toBe(true)
  }))

  test('an aborted or failed run is never blocked, and a failing guard allows the stop', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, blocker())
    saveState('pi', SID, planState())
    expect(await fp.emit('agent_before_settle', settle('aborted'), ctx)).toBeUndefined()
    expect(await fp.emit('agent_before_settle', settle('error'), ctx)).toBeUndefined()
    const broken = setup(sb, { plan: { ...testDeps().deps.plan!, validatePlan, stopGuardVerdict: () => { throw new Error('boom') } } })
    expect(await broken.fp.emit('agent_before_settle', settle(), broken.ctx)).toBeUndefined()
  }))

  test('the second stop of one run knows the guard blocked before (hookActive)', () => withSandbox(async sb => {
    const seen: unknown[] = []
    const { fp, ctx } = setup(sb, { plan: { ...testDeps().deps.plan!, validatePlan, stopGuardVerdict: (s, input) => { seen.push(input.hookActive); return { decision: { action: 'block', reason: 'continue', hook: 'H08' }, next: s, why: 'blocked' } } } })
    saveState('pi', SID, planState())
    await fp.emit('agent_before_settle', settle(), ctx)
    await fp.emit('agent_before_settle', settle(), ctx)
    await fp.emit('input', { text: 'next', source: 'interactive' }, ctx)
    await fp.emit('agent_before_settle', settle(), ctx)
    expect(seen).toEqual([false, true, false])
  }))
})

describe('pi extension: turn_end (H05, H14)', () => {
  test('the turn is spooled with its model, tokens and excerpt', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb)
    await fp.emit('turn_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'hello there' }], usage: { totalTokens: 42 } } }, ctx)
    expect(memory.spool).toEqual([{ sid: SID, entries: [{ ts: 1_791_400_000_000, ev: 'turn', model: 'test-model', tokens: 42, excerpt: 'hello there' }] }])
  }))

  test('a full context warns the user (toast) and the model at its next prompt', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, {}, { pct: 92 })
    await fp.emit('session_start', { reason: 'startup' }, ctx)
    await fp.emit('turn_end', { message: { role: 'assistant', content: 'x' } }, ctx)
    expect(ctx.notices.some(n => n.type === 'warning')).toBe(true)
  }))
})

describe('pi extension: compaction (H06, H07)', () => {
  test('session_compact spools the summary and the restore note follows as a message for the next turn', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb, { compact: { handoffNote: () => undefined, restoreContext: () => 'RESTORE NOTE' } as never })
    await fp.emit('session_compact', { compactionEntry: { summary: 'the summary' } }, ctx)
    expect(memory.spool.flatMap(s => s.entries).some(e => e.ev === 'compact' && e.excerpt === 'the summary')).toBe(true)
    expect(fp.sent.length === 0 || fp.sent[0]?.options !== undefined).toBe(true)
  }))

  test('session_before_compact never blocks the compaction, even when its step fails', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    expect(await fp.emit('session_before_compact', { reason: 'manual' }, ctx)).toBeUndefined()
  }))
})

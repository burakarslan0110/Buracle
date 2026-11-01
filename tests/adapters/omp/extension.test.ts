import { describe, expect, test } from 'bun:test'
import { barLines } from '../../../src/core/status/bar'
import { renderPlainLines } from '../../../src/core/status/render'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, defaultDeps, STATUS_KEYS, stopReason, WIDGET_KEY, type ExtensionDeps } from '../../../src/adapters/omp/runtime/extension'
import { createMemoryBridge } from '../../../src/adapters/omp/runtime/memory'
import { PROMPT_MESSAGE_TYPE } from '../../../src/adapters/omp/runtime/prompt'
import { AUTO_PAUSE_REASON } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { withDeadline } from '../../../src/adapters/omp/runtime/util'
import { checkBash } from '../../../src/core/policy/bash-guard'
import { detectIntent, isGuardContinuation } from '../../../src/core/policy/intents'
import { bashNudge, routeTool } from '../../../src/core/policy/routing'
import { checkWrite } from '../../../src/core/policy/write-guard'
import { validatePlan } from '../../../src/core/plan/format'
import { applyIntent, stopGuardVerdict, type SessionState } from '../../../src/core/plan/state'
import * as paths from '../../../src/engine/paths'
import { monthKeyOf } from '../../../src/usage/month'
import { loadState, readTelemetry, saveState } from '../../../src/workflow/session-store'
import { fakeExe } from '../../helpers/fake-exe'
import { withSandbox, type Sandbox } from '../../helpers/sandbox'
import { testWhenImplemented } from '../../helpers/not-implemented'
import { sandboxSelfPaths } from '../shared/self-paths-fixture'
import { fakeCtx, fakeMemory, fakePi, planState, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'

function setup(sb: Sandbox, overrides: Partial<ExtensionDeps> = {}, ctxOpts: Partial<Parameters<typeof fakeCtx>[0]> = {}) {
  const cwd = join(sb.root, 'work')
  mkdirSync(cwd, { recursive: true })
  const t = testDeps(overrides)
  const fp = fakePi({ thinking: 'high' })
  createBuracleExtension(testGenerated(), t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID, ...ctxOpts })
  return { ...t, fp, ctx, cwd }
}

describe('omp extension: registration', () => {
  test('registers every hook event and the utility commands (PLAN §2.3)', () => withSandbox(async sb => {
    const { fp } = setup(sb)
    for (const ev of ['tool_call', 'tool_result', 'input', 'before_agent_start', 'turn_end', 'session_stop', 'session.compacting', 'session_compact', 'session_start', 'session_switch', 'session_branch', 'session_shutdown']) {
      expect(fp.handlers.get(ev)?.length ?? 0).toBe(1)
    }
    expect([...fp.commands.keys()].sort()).toEqual(['aside', 'brain', 'buracle', 'buracle-ping', 'buracle-status', 'remember'])
    expect(fp.labels).toEqual(['Buracle'])
  }))
})

describe('omp extension: tool_call (H01/H02/H03/H09)', () => {
  test('H01/H02 fail closed when their guard throws; H03/H09 fail open (hooks.yaml failure policy)', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: {
      checkBash: () => { throw new Error('boom') },
      checkWrite: () => { throw new Error('boom') },
      routeTool: () => { throw new TypeError('bad') },
      capabilityCard: () => '',
      checkQuestion: () => { throw new Error('boom') },
      detectIntent: () => null,
      isGuardContinuation: () => false,
    } })
    const bash = await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: 'ls' } }, ctx) as { block?: boolean, reason?: string }
    expect(bash.block).toBe(true)
    expect(bash.reason).toStartWith('Buracle H01: the guard could not evaluate this call (boom)')
    const write = await fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'write', input: { path: 'a.ts', content: 'x' } }, ctx) as { block?: boolean, reason?: string }
    expect(write.reason).toStartWith('Buracle H02: the guard could not evaluate this call')
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '3', toolName: 'ask', input: { questions: [] } }, ctx)).toBeUndefined()
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '4', toolName: 'web_search', input: { query: 'x' } }, ctx)).toBeUndefined()
  }))

  test('a broken config reader does not switch the guards off; hostile input never throws', () => withSandbox(async sb => {
    const seen: unknown[] = []
    const { fp, ctx, cwd } = setup(sb, {
      config: () => { throw new Error('config broke') },
      policy: { ...testDeps().deps.policy!, checkBash: (_cmd, cfg) => { seen.push(cfg); return { deny: 'no' } }, routeTool: () => ({ action: 'allow' }) },
    })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'bash', input: null }, ctx)).toBeUndefined()
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'edit', input: { edits: 'nope' } }, ctx)).toBeUndefined()
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '3', toolName: 'bash', input: { command: 'rm -rf /' } }, ctx)).toEqual({ block: true, reason: 'Buracle H01: no' })
    expect(seen).toEqual([{ ...testGenerated().config.guards.bash, home: sb.home, selfPaths: sandboxSelfPaths(sb), cwd, vault: join(sb.home, 'Documents', 'Buracle'), protect: [] }])
  }))

  test('H01 blocks a denied shell command with a Buracle reason', () => withSandbox(async sb => {
    const seen: string[] = []
    const { fp, ctx } = setup(sb, { policy: { ...testDeps().deps.policy!, checkBash: (cmd: string) => { seen.push(cmd); return cmd.includes('push --force') ? { deny: 'force push to the default branch' } : {} }, routeTool: () => ({ action: 'allow' }) } })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: 'git push --force origin main' } }, ctx))
      .toEqual({ block: true, reason: 'Buracle H01: force push to the default branch' })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'bash', input: { command: 'ls -la' } }, ctx)).toBeUndefined()
    expect(seen).toEqual(['git push --force origin main', 'ls -la'])
  }))

  test('H20 holds a push for the user\'s say-so; their own words in the next input let it through', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: { ...testDeps().deps.policy!, checkBash: () => ({}), routeTool: () => ({ action: 'allow' }), detectIntent: () => null, isGuardContinuation: () => false } })
    const held = await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: 'git push origin main' } }, ctx) as { block?: boolean, reason?: string }
    expect(held.block).toBe(true)
    expect(held.reason).toStartWith('Buracle H20: ')
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'bash', input: { command: 'git status' } }, ctx)).toBeUndefined()
    await fp.emit('input', { type: 'input', text: 'evet, pushla' }, ctx)
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '3', toolName: 'bash', input: { command: 'git push origin main' } }, ctx)).toBeUndefined()
  }))

  test('H02 sees absolute paths and the protect context; blocks protected writes', () => withSandbox(async sb => {
    let got: unknown
    const { fp, ctx, cwd } = setup(sb, { policy: { ...testDeps().deps.policy!, checkWrite: (paths: string[], c: unknown) => { got = { paths, c }; return paths.some(p => /[\\/]\.env$/.test(p)) ? { deny: 'secrets file' } : {} }, routeTool: () => ({ action: 'allow' }) } })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'write', input: { path: '.env', content: 'A=1' } }, ctx))
      .toEqual({ block: true, reason: 'Buracle H02: secrets file' })
    expect(got).toEqual({ paths: [join(cwd, '.env')], c: { cwd, home: sb.home, vault: join(sb.home, 'Documents', 'Buracle'), protect: [], selfPaths: sandboxSelfPaths(sb), parsers: { jsonc: expect.any(Function), toml: expect.any(Function), yaml: expect.any(Function) } } })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'edit', input: { path: 'src/a.ts', edits: [] } }, ctx)).toBeUndefined()
  }))

  test('H02 passes buracleRepo inside a Buracle checkout (CONTRACTS §5.2), with the configured repo as a hint', () => withSandbox(async sb => {
    const contexts: unknown[] = []
    const asked: unknown[] = []
    const live = (d: Parameters<ExtensionDeps['config']>[0]) => ({ config: d, vault: '/v', shim: '/s', repoRoot: '/configured/buracle', source: 'runtime-config' as const })
    const { fp, ctx, cwd } = setup(sb, {
      config: live,
      buracleRepo: (dir, configured) => { asked.push({ dir, configured }); return '/repo/buracle' },
      policy: { ...testDeps().deps.policy!, checkWrite: (_p: string[], c: unknown) => { contexts.push(c); return {} }, routeTool: () => ({ action: 'allow' }) },
    })
    await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'write', input: { path: 'harness/next/x.md', content: 'x' } }, ctx)
    expect(asked).toEqual([{ dir: cwd, configured: '/configured/buracle' }])
    expect(contexts).toEqual([{ cwd, home: sb.home, vault: '/v', protect: [], selfPaths: sandboxSelfPaths(sb), buracleRepo: '/repo/buracle', parsers: { jsonc: expect.any(Function), toml: expect.any(Function), yaml: expect.any(Function) } }])
  }))

  test('H02 with the real guard and repo lookup: all of harness/** is protected in a Buracle checkout only', () => withSandbox(async sb => {
    const repo = join(sb.root, 'buracle-clone')
    mkdirSync(join(repo, '.git'), { recursive: true })
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'buracle' }))
    const policy = { ...testDeps().deps.policy!, checkWrite, routeTool: () => ({ action: 'allow' as const }) }
    const { buracleRepo } = defaultDeps()
    const inRepo = setup(sb, { policy, buracleRepo }, { cwd: repo })
    const r = await inRepo.fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'write', input: { path: 'harness/next/x.md', content: 'x' } }, inRepo.ctx) as { block?: boolean, reason?: string }
    expect(r.block).toBe(true)
    expect(r.reason).toContain('buracle build')
    const other = join(sb.root, 'elsewhere')
    mkdirSync(join(other, '.git'), { recursive: true })
    const outside = setup(sb, { policy, buracleRepo }, { cwd: other })
    expect(await outside.fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'write', input: { path: 'harness/next/x.md', content: 'x' } }, outside.ctx)).toBeUndefined()
  }))

  test('SEC-04: omp `eval` cells go through core checkEval (I5) with the write context; denied cells are blocked', () => withSandbox(async sb => {
    const seen: Array<{ code: string, language: string, ctx: Record<string, unknown> }> = []
    const { fp, ctx, cwd } = setup(sb, {
      evalGuard: (code, language, c) => { seen.push({ code, language, ctx: c as unknown as Record<string, unknown> }); return /rmtree|writeFileSync\('\.env'/.test(code) ? { deny: 'the cell deletes or overwrites protected files' } : {} },
      policy: { ...testDeps().deps.policy!, routeTool: () => ({ action: 'allow' }) },
    })
    const py = await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'eval', input: { language: 'py', code: "import shutil,os; shutil.rmtree(os.path.expanduser('~/Documents'))" } }, ctx)
    expect(py).toEqual({ block: true, reason: 'Buracle H01: the cell deletes or overwrites protected files' })
    const js = await fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'eval', input: { code: "require('fs').writeFileSync('.env','X=1')" } }, ctx)
    expect(js).toEqual({ block: true, reason: 'Buracle H01: the cell deletes or overwrites protected files' })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '3', toolName: 'eval', input: { language: 'js', code: '1 + 1' } }, ctx)).toBeUndefined()
    expect(seen.map(x => x.language)).toEqual(['py', 'js', 'js'])
    expect(seen[0]?.ctx).toMatchObject({ cwd, home: sb.home, protect: [] })
  }))

  test('SEC-04: eval fails closed when the eval guard is missing or throws', () => withSandbox(async sb => {
    for (const evalGuard of [undefined, () => { throw new Error('boom') }]) {
      const { fp, ctx } = setup(sb, { evalGuard, policy: { ...testDeps().deps.policy!, routeTool: () => ({ action: 'allow' }) } })
      const r = await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'eval', input: { language: 'py', code: 'print(1)' } }, ctx) as { block?: boolean, reason?: string }
      expect(r.block).toBe(true)
      expect(r.reason).toStartWith('Buracle H01: the guard could not evaluate this call')
    }
  }))

  test.skipIf(defaultDeps().evalGuard === undefined)('SEC-04 with the real core checkEval: the reviewed cells are blocked, harmless ones run', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { evalGuard: defaultDeps().evalGuard, policy: { ...testDeps().deps.policy!, routeTool: () => ({ action: 'allow' }) } })
    const call = (input: Record<string, unknown>) => fp.emit('tool_call', { type: 'tool_call', toolCallId: 'x', toolName: 'eval', input }, ctx) as Promise<{ block?: boolean } | undefined>
    const env = await call({ language: 'js', code: "require('fs').writeFileSync('.env', 'X=1')" }) as { block?: boolean, reason?: string } | undefined
    expect(env?.block).toBe(true)
    expect(env?.reason).toStartWith('Buracle H02:')
    const rm = await call({ language: 'py', code: "import shutil, os; shutil.rmtree(os.path.expanduser('~/Documents'))" }) as { block?: boolean, reason?: string } | undefined
    expect(rm?.block).toBe(true)
    expect(rm?.reason).toStartWith('Buracle H01:')
    expect(await call({ language: 'py', code: 'print(1 + 1)' })).toBeUndefined()
  }))

  test('SEC-11: H02 gets the symlink resolver (I4); the production resolver follows a project link into ~/.ssh', () => withSandbox(async sb => {
    let got: Record<string, unknown> | undefined
    const { realpath } = defaultDeps()
    const { fp, ctx, cwd } = setup(sb, { realpath, policy: { ...testDeps().deps.policy!, checkWrite: (_p: string[], c: unknown) => { got = c as Record<string, unknown>; return {} }, routeTool: () => ({ action: 'allow' }) } })
    mkdirSync(join(sb.home, '.ssh'), { recursive: true })
    writeFileSync(join(sb.home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA user\n')
    symlinkSync(join(sb.home, '.ssh', 'authorized_keys'), join(cwd, 'notes.txt'))
    await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'write', input: { path: 'notes.txt', content: 'x' } }, ctx)
    const resolve = got?.['realpath'] as ((p: string) => string | undefined) | undefined
    expect(typeof resolve).toBe('function')
    expect(resolve?.(join(cwd, 'notes.txt'))).toBe(join(sb.home, '.ssh', 'authorized_keys'))
  }))

  test('H03 denies or adds routing context; the shell nudge comes from routeTool only', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: { ...testDeps().deps.policy!, checkBash: () => ({}),
      routeTool: call => (call.kind === 'web_search' ? { action: 'deny', reason: 'use the web-search MCP', hook: 'H03' }
        : call.kind === 'read' ? { action: 'allow', context: ['prefer semble for intent search'] }
          : call.kind === 'bash' && call.command?.startsWith('grep -r') ? { action: 'allow', context: ['use rg or semble instead of grep -r'] }
            : { action: 'allow' }) } })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'web_search', input: { query: 'x' } }, ctx)).toEqual({ block: true, reason: 'Buracle H03: use the web-search MCP' })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'read', input: { path: 'a.ts' } }, ctx)).toEqual({ additionalContext: 'prefer semble for intent search' })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '3', toolName: 'bash', input: { command: 'grep -r foo .' } }, ctx)).toEqual({ additionalContext: 'use rg or semble instead of grep -r' })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '4', toolName: 'bash', input: { command: 'ls' } }, ctx)).toBeUndefined()
  }))

  test('repeated routing hints are delivered once', () => withSandbox(async sb => {
    const hint = 'use rg instead of grep -r'
    const { fp, ctx } = setup(sb, { policy: { ...testDeps().deps.policy!, checkBash: () => ({}), routeTool: () => ({ action: 'allow', context: [hint, ' ', hint] }) } })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: 'grep -r x .' } }, ctx)).toEqual({ additionalContext: hint })
  }))

  test('with the real routing policy the shell nudge appears exactly once', () => withSandbox(async sb => {
    const policy = { ...testDeps().deps.policy!, checkBash: () => ({}), routeTool }
    const { fp, ctx } = setup(sb, { policy })
    const r = await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: 'grep -r foo .' } }, ctx) as { additionalContext: string }
    const nudge = bashNudge('grep -r foo .') as string
    expect(nudge.length).toBeGreaterThan(0)
    expect(r.additionalContext).toBe(nudge)
  }))

  test('H03 is skipped entirely when routing strictness is off', () => withSandbox(async sb => {
    let routed = 0
    const live = (d: Parameters<ExtensionDeps['config']>[0]) => ({ config: { ...d, routing: { ...d.routing, strictness: 'off' as const } }, vault: '/v', shim: '/s', source: 'defaults' as const })
    const { fp, ctx } = setup(sb, { config: live, policy: { ...testDeps().deps.policy!, routeTool: () => { routed++; return { action: 'deny', reason: 'x', hook: 'H03' } } } })
    expect(await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'web_search', input: {} }, ctx)).toBeUndefined()
    expect(routed).toBe(0)
  }))

  test('MCP device calls are classified with the canonical server ids', () => withSandbox(async sb => {
    const calls: unknown[] = []
    const { fp, ctx } = setup(sb, { policy: { ...testDeps().deps.policy!, routeTool: call => { calls.push(call.mcp); return { action: 'allow' } } } })
    await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'write', input: { path: 'xd://mcp__web_search_search', content: '{}' } }, ctx)
    await fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'mcp__buracle_memory_memory_search', input: {} }, ctx)
    expect(calls).toEqual([{ server: 'web-search', tool: 'search' }, { server: 'buracle-memory', tool: 'memory_search' }])
  }))

  test('H09 runs for the main agent only and uses the session state', () => withSandbox(async sb => {
    const states: unknown[] = []
    const policy = { ...testDeps().deps.policy!, routeTool: () => ({ action: 'allow' as const }), checkQuestion: (s: unknown) => { states.push(s); return { deny: 'keep working; the plan is approved' } } }
    const main = setup(sb, { policy })
    saveState('omp', SID, planState())
    expect(await main.fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'ask', input: { questions: [{ question: 'Devam edeyim mi?' }] } }, main.ctx))
      .toEqual({ block: true, reason: 'Buracle H09: keep working; the plan is approved' })
    expect(states).toEqual([planState()])
    const sub = setup(sb, { policy }, { kind: 'sub' })
    expect(await sub.fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'ask', input: {} }, sub.ctx)).toBeUndefined()
  }))

  test('withDeadline answers with the fallback when work hangs', async () => {
    const hang = new Promise<string>(() => undefined)
    expect(await withDeadline(hang, 20, 'fallback')).toBe('fallback')
    expect(await withDeadline(Promise.resolve('fast'), 1000, 'fallback')).toBe('fast')
  })
})

describe('omp extension: tool_result (H04 + spool)', () => {
  test('runs checkers for written files and returns their notes as additionalContext', () => withSandbox(async sb => {
    const plansSeen: unknown[] = []
    const { fp, ctx, cwd, runs } = setup(sb, {
      checkers: {
        checkersFor: (path, facts) => { plansSeen.push({ path, facts }); return [{ argv: ['ruff', 'check', path], cwd: facts.cwd, timeoutMs: 1000, parser: 'ruff' }] },
        findingsOf: (_plan, result) => (result === null ? 'ruff could not run' : `ruff: exit ${result.code}`),
        tddHint: path => (path.endsWith('app.py') ? 'no test file next to app.py' : undefined),
        charsetFindings: text => (text.includes('​') ? ['zero-width space added'] : []),
        lengthNote: n => (n > 2 ? `${n} lines` : undefined),
      },
      run: async argv => { runs.push(argv); return { code: 1, stdout: 'E501', stderr: '', timedOut: false } },
    })
    writeFileSync(join(cwd, 'ruff.toml'), '')
    writeFileSync(join(cwd, 'app.py'), 'a = 1\nb = 2\nc = 3\n')
    const r = await fp.emit('tool_result', { type: 'tool_result', toolCallId: '1', toolName: 'write', input: { path: 'app.py', content: 'a = 1​\n' }, content: [], isError: false }, ctx)
    expect(r).toEqual({ additionalContext: 'ruff: exit 1\n\nno test file next to app.py\n\nzero-width space added\n\n3 lines' })
    expect(runs).toEqual([['ruff', 'check', join(cwd, 'app.py')]])
    expect(plansSeen).toEqual([{ path: join(cwd, 'app.py'), facts: { hasRuffConfig: true, hasEslintConfig: false, isGoModule: false, cwd } }])
  }))

  test('no checks for failed tools, reads or disabled checkers; checker errors fail open', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb)
    writeFileSync(join(cwd, 'a.ts'), 'x\n')
    expect(await fp.emit('tool_result', { type: 'tool_result', toolCallId: '1', toolName: 'write', input: { path: 'a.ts', content: 'x' }, content: [], isError: true }, ctx)).toBeUndefined()
    expect(await fp.emit('tool_result', { type: 'tool_result', toolCallId: '2', toolName: 'read', input: { path: 'a.ts' }, content: [], isError: false }, ctx)).toBeUndefined()
    expect(await fp.emit('tool_result', { type: 'tool_result', toolCallId: '3', toolName: 'write', input: { path: 'a.ts', content: 'x' }, content: [], isError: false }, ctx)).toBeUndefined()
  }))

  test('spools tool metadata: bash command and exit code, edited paths; subagents report into the main session', () => withSandbox(async sb => {
    const { fp, ctx, cwd, memory } = setup(sb)
    await fp.emit('tool_result', { type: 'tool_result', toolCallId: '1', toolName: 'bash', input: { command: 'bun test' }, content: [], isError: true, details: { exitCode: 2, wallTimeMs: 1500 } }, ctx)
    await fp.emit('tool_result', { type: 'tool_result', toolCallId: '2', toolName: 'edit', input: { path: 'src/x.ts', edits: [] }, content: [], isError: false }, ctx)
    await fp.emit('tool_result', { type: 'tool_result', toolCallId: '3', toolName: 'read', input: { path: 'src/x.ts' }, content: [], isError: false }, ctx)
    await Bun.sleep(0)
    expect(memory.spool).toEqual([
      { sid: SID, entries: [{ ts: 1_791_400_000_000, ev: 'tool', tool: 'bash', kind: 'bash', cmd: 'bun test', exit: 2, ms: 1500 }] },
      { sid: SID, entries: [{ ts: 1_791_400_000_000, ev: 'tool', tool: 'edit', kind: 'edit', paths: [join(cwd, 'src/x.ts')] }] },
    ])
    const prev = { sid: process.env['BURACLE_SESSION_ID'], h: process.env['BURACLE_HARNESS'] }
    process.env['BURACLE_SESSION_ID'] = 'main-session-1'
    process.env['BURACLE_HARNESS'] = 'omp'
    try {
      const sub = setup(sb, {}, { kind: 'sub', sid: 'sub-session-9' })
      await sub.fp.emit('tool_result', { type: 'tool_result', toolCallId: '4', toolName: 'write', input: { path: 'b.ts', content: '' }, content: [], isError: false }, sub.ctx)
      await Bun.sleep(0)
      expect(sub.memory.spool.map(s => s.sid)).toEqual(['main-session-1'])
    } finally {
      if (prev.sid === undefined) delete process.env['BURACLE_SESSION_ID']; else process.env['BURACLE_SESSION_ID'] = prev.sid
      if (prev.h === undefined) delete process.env['BURACLE_HARNESS']; else process.env['BURACLE_HARNESS'] = prev.h
    }
  }))
})

describe('omp extension: input (H10) and before_agent_start (H13/H15)', () => {
  test('pause/resume intents update the session state; shell input, no-turn commands and subagents are not prompts', () => withSandbox(async sb => {
    const intents: string[] = []
    const seen: string[] = []
    const { fp, ctx, memory } = setup(sb, {
      policy: { ...testDeps().deps.policy!, detectIntent: t => { seen.push(t); return t === 'dur' ? 'pause' : t === 'devam' ? 'resume' : null } },
      plan: { ...testDeps().deps.plan!, promptInteraction: (s, control, _text, o) => { if (control !== null) intents.push(control); return control === null ? { next: s } : { next: { ...s, interaction: { state: control === 'pause' ? 'paused' : 'running', since: o.now } } } } },
    })
    saveState('omp', SID, planState())
    expect(await fp.emit('input', { type: 'input', text: 'dur', source: 'interactive' }, ctx)).toBeUndefined()
    expect(loadState('omp', SID).interaction).toEqual({ state: 'paused', since: 1_791_400_000_000 })
    for (const text of ['!dur', '/remember dur', '/model dur']) await fp.emit('input', { type: 'input', text, source: 'interactive' }, ctx)
    await fp.emit('input', { type: 'input', text: '/plan-build dur', source: 'interactive' }, ctx)
    await fp.emit('input', { type: 'input', text: 'devam', source: 'interactive' }, ctx)
    expect(intents).toEqual(['pause', 'resume'])
    expect(seen).toEqual(['dur', '/plan-build dur', 'devam'])
    expect(detectIntent('/plan-build dur')).toBe('pause')
    await Bun.sleep(0)
    expect(memory.spool.map(s => s.entries[0]?.ev)).toEqual(['prompt', 'prompt', 'prompt', 'prompt', 'prompt', 'prompt'])
    const sub = setup(sb, {}, { kind: 'sub' })
    expect(await sub.fp.emit('input', { type: 'input', text: 'dur', source: 'interactive' }, sub.ctx)).toBeUndefined()
  }))

  test('H10: Buracle\'s own stop-guard texts are no user prompts (no spool, no intent, no chain reset)', () => withSandbox(async sb => {
    const intents: unknown[] = []
    const { fp, ctx, memory } = setup(sb, { policy: { ...testDeps().deps.policy!, isGuardContinuation, detectIntent: t => { intents.push(t); return null } } })
    await fp.emit('input', { type: 'input', text: 'Stop hook feedback: Buracle stop guard: the plan is not VERIFIED', source: 'interactive' }, ctx)
    await Bun.sleep(0)
    expect(intents).toEqual([])
    expect(memory.spool).toEqual([])
  }))

  test('H10 autoPause: with plan.autoPause a user message pauses a running plan (kind discussion); "devam" resumes', () => withSandbox(async sb => {
    const live = (d: Parameters<ExtensionDeps['config']>[0]) => ({ config: { ...d, plan: { ...d.plan, autoPause: true } }, vault: '/v', shim: '/s', source: 'runtime-config' as const })
    const { fp, ctx } = setup(sb, { config: live, policy: { ...testDeps().deps.policy!, isGuardContinuation, detectIntent }, plan: { ...testDeps().deps.plan!, applyIntent } })
    saveState('omp', SID, planState())
    await fp.emit('input', { type: 'input', text: 'please also cover the parser edge case', source: 'interactive' }, ctx)
    expect(loadState('omp', SID).interaction).toMatchObject({ state: 'paused', kind: 'discussion', reason: AUTO_PAUSE_REASON })
    await fp.emit('input', { type: 'input', text: 'devam', source: 'interactive' }, ctx)
    expect(loadState('omp', SID).interaction?.state).toBe('running')
    await fp.emit('input', { type: 'input', text: '!ls -la', source: 'interactive' }, ctx)
    await fp.emit('input', { type: 'input', text: '/buracle-status', source: 'interactive' }, ctx)
    expect(loadState('omp', SID).interaction?.state).toBe('running')
    await fp.emit('input', { type: 'input', text: '/plan-build next', source: 'interactive' }, ctx)
    expect(loadState('omp', SID).interaction).toMatchObject({ state: 'paused', kind: 'discussion' })
    const other = setup(sb, { config: live, policy: { ...testDeps().deps.policy!, isGuardContinuation, detectIntent } }, { sid: '01a118a8-8d01-740c-9360-bbbbbbbbbbbb' })
    await other.fp.emit('input', { type: 'input', text: 'hello', source: 'interactive' }, other.ctx)
    expect(existsSync(join(sb.buracleHome, 'sessions', 'omp', '01a118a8-8d01-740c-9360-bbbbbbbbbbbb', 'state.json'))).toBe(false)
  }))

  test('H10: without autoPause an ordinary message leaves the plan running', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: { ...testDeps().deps.policy!, isGuardContinuation, detectIntent } })
    saveState('omp', SID, planState())
    await fp.emit('input', { type: 'input', text: 'please also cover the parser edge case', source: 'interactive' }, ctx)
    expect(loadState('omp', SID).interaction).toBeUndefined()
  }))

  test('BURACLE_NO_CAPTURE: a session that starts with capture off gets no stub note, spool or finalizer', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb, { captureEnabled: () => false })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await fp.emit('input', { type: 'input', text: 'hello', source: 'interactive' }, ctx)
    await fp.emit('tool_result', { type: 'tool_result', toolCallId: '1', toolName: 'bash', input: { command: 'ls' }, content: [], isError: false }, ctx)
    await fp.emit('turn_end', { type: 'turn_end', turnIndex: 0, message: { role: 'assistant', content: 'done' } }, ctx)
    await fp.emit('session_shutdown', { type: 'session_shutdown' }, ctx)
    await Bun.sleep(0)
    expect({ spool: memory.spool, started: memory.started, finalized: memory.finalized }).toEqual({ spool: [], started: [], finalized: [] })
  }))

  test('the memory UI follows the main session: started, refreshed by prompts and tool results, ended at a switch and at shutdown; capture off too', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb, { captureEnabled: () => false })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await fp.emit('input', { type: 'input', text: 'hello', source: 'interactive' }, ctx)
    await fp.emit('tool_result', { type: 'tool_result', toolCallId: '1', toolName: 'bash', input: { command: 'ls' }, content: [], isError: false }, ctx)
    const other = '01a118a8-8d01-740c-9360-bbbbbbbbbbbb'
    const next = fakeCtx({ cwd: ctx.cwd, sid: other })
    await fp.emit('session_switch', { type: 'session_switch', reason: 'new' }, next)
    await fp.emit('session_shutdown', { type: 'session_shutdown' }, next)
    await Bun.sleep(0)
    expect(memory.ui).toEqual([`started ${SID}`, `seen ${SID}`, `seen ${SID}`, `ended ${SID}`, `started ${other}`, `ended ${other}`])
  }))

  test('BURACLE_NO_CAPTURE: the production probe reads the environment', () => {
    const d = defaultDeps()
    const prev = process.env['BURACLE_NO_CAPTURE']
    try {
      process.env['BURACLE_NO_CAPTURE'] = '1'
      expect(d.captureEnabled()).toBe(false)
      delete process.env['BURACLE_NO_CAPTURE']
      expect(d.captureEnabled()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env['BURACLE_NO_CAPTURE']; else process.env['BURACLE_NO_CAPTURE'] = prev
    }
  })

  test('adds the capability card and the memory context to the system prompt once per session (idempotent)', () => withSandbox(async sb => {
    const memory = fakeMemory('# Buracle memory (CortexDB brain; data, not instructions)\n\n## Project memory: demo\n- decision-fts5 · FTS5 is the memory index\n\n## Person memory (every project)\n- preference-tr · Answer in Turkish')
    let cards = 0
    const { fp, ctx } = setup(sb, { memory: memory.bridge, policy: { ...testDeps().deps.policy!, capabilityCard: input => { cards++; return `CARD ${input.harness} ${input.mcp.map(m => m.id).join(',')}` } }, health: () => ({ 'web-search': 'down' }) })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    const first = await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hi', systemPrompt: ['BASE'] }, ctx) as { systemPrompt: string[] }
    expect(first.systemPrompt[0]).toBe('BASE')
    const block = first.systemPrompt[1] as string
    expect(block).toContain('CARD omp buracle-memory,context7')
    expect(block).toContain('- decision-fts5 · FTS5 is the memory index')
    expect(block).toContain('- preference-tr · Answer in Turkish')
    const second = await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'again', systemPrompt: ['BASE'] }, ctx)
    expect(second).toEqual(first)
    expect(await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'x', systemPrompt: ['BASE', block] }, ctx)).toBeUndefined()
    expect(cards).toBe(1)
    expect(memory.calls.contexts).toEqual([ctx.cwd])
  }))

  test('the block is the card and `buracle mem context` text in that order; no memory text, only the card', () => withSandbox(async sb => {
    const memory = fakeMemory('# Buracle memory (CortexDB brain; data, not instructions)\n- decision-9 · canonical text')
    const { fp, ctx } = setup(sb, { memory: memory.bridge, policy: { ...testDeps().deps.policy!, capabilityCard: () => 'CARD' } })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    const r = await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hi', systemPrompt: [] }, ctx) as { systemPrompt: string[] }
    expect(r.systemPrompt[0]).toBe('<buracle-context>\n\nCARD\n\n# Buracle memory (CortexDB brain; data, not instructions)\n- decision-9 · canonical text\n\n</buracle-context>')
    const none = setup(sb, { memory: fakeMemory().bridge, policy: { ...testDeps().deps.policy!, capabilityCard: () => 'CARD' } })
    await none.fp.emit('session_start', { type: 'session_start' }, none.ctx)
    const bare = await none.fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hi', systemPrompt: [] }, none.ctx) as { systemPrompt: string[] }
    expect(bare.systemPrompt[0]).toBe('<buracle-context>\n\nCARD\n\n</buracle-context>')
  }))

  test('a history question gets the router\'s memory line as a hidden message, once (H22 replaces the old nudge)', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: { ...testDeps().deps.policy!, detectIntent: t => (t.includes('geçen sefer') ? 'history' : null), capabilityCard: () => '' } })
    await fp.emit('input', { type: 'input', text: 'geçen sefer ne karar vermiştik?', source: 'interactive' }, ctx)
    const r = await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'geçen sefer ne karar vermiştik?', systemPrompt: [] }, ctx) as { message: { customType: string, content: string, display: boolean } }
    expect(r.message.customType).toBe(PROMPT_MESSAGE_TYPE)
    expect(r.message.display).toBe(false)
    expect(r.message.content).toBe('Buracle routing for this prompt:\n- Earlier work: search memory first (memory_search, then memory_get on the relevant notes) and cite the note ids you use.')
    expect(await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'geçen sefer ne karar vermiştik?', systemPrompt: [] }, ctx)).toEqual(r)
    await fp.emit('turn_end', { type: 'turn_end', turnIndex: 0 }, ctx)
    expect(await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'next', systemPrompt: [] }, ctx)).toBeUndefined()
  }))

  test('fails open when card and memory index both fail; subagents get nothing', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { projectSlug: async () => { throw new Error('git missing') } })
    expect(await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hi', systemPrompt: ['BASE'] }, ctx)).toBeUndefined()
    const sub = setup(sb, { policy: { ...testDeps().deps.policy!, capabilityCard: () => 'CARD' } }, { kind: 'sub' })
    expect(await sub.fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hi', systemPrompt: [] }, sub.ctx)).toBeUndefined()
  }))
})

describe('omp extension: session_stop (H08/H11)', () => {
  const stopEvent = { type: 'session_stop', turn_id: 3, session_id: SID, stop_hook_active: false, last_assistant_message: { role: 'assistant', content: [{ type: 'text', text: 'Done with task 2.' }] } }
  const realPlan = { ...testDeps().deps.plan!, stopGuardVerdict, validatePlan, applyIntent }

  test('no registered plan → no verdict and no state write', () => withSandbox(async sb => {
    let called = 0
    const { fp, ctx } = setup(sb, { plan: { ...testDeps().deps.plan!, stopGuardVerdict: (s) => { called++; return { decision: { action: 'allow' }, next: s, why: 'no-plan' } } } })
    expect(await fp.emit('session_stop', stopEvent, ctx)).toBeUndefined()
    expect(called).toBe(0)
    expect(existsSync(join(sb.buracleHome, 'sessions', 'omp', SID, 'state.json'))).toBe(false)
  }))

  test('one stopGuardVerdict inside updateState: input, plan check and the stored next state', () => withSandbox(async sb => {
    const calls: unknown[] = []
    const { fp, ctx, memory } = setup(sb, { plan: { ...testDeps().deps.plan!, validatePlan: () => [], stopGuardVerdict: (s, input, _cfg, check) => {
      calls.push({ input, check })
      return { decision: { action: 'block', reason: 'plan demo is IN_PROGRESS; continue with task 3', hook: 'H08' }, next: { ...s, guard: { blocksForPlan: s.guard.blocksForPlan + 1, blocksInChain: s.guard.blocksInChain + 1 } }, why: 'blocked' }
    } } })
    saveState('omp', SID, planState())
    expect(await fp.emit('session_stop', stopEvent, ctx)).toEqual({ decision: 'block', reason: 'Buracle H08: plan demo is IN_PROGRESS; continue with task 3' })
    expect(loadState('omp', SID).guard).toEqual({ blocksForPlan: 1, blocksInChain: 1 })
    expect(calls).toEqual([{ input: { harness: 'omp', sessionId: SID, cwd: ctx.cwd, hookActive: false, now: 1_791_400_000_000, lastMessage: 'Done with task 2.' }, check: { exists: false, findings: [] } }])
    await Bun.sleep(0)
    expect(memory.spool).toEqual([{ sid: SID, entries: [{ ts: 1_791_400_000_000, ev: 'stop', excerpt: 'Done with task 2.' }] }])
  }))

  test('fails open: a throwing stop verdict allows the stop and leaves the state untouched', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    saveState('omp', SID, planState())
    expect(await fp.emit('session_stop', stopEvent, ctx)).toBeUndefined()
    expect(loadState('omp', SID)).toEqual(planState())
  }))

  test('stopGuard off, subagents and invalid ids never block', () => withSandbox(async sb => {
    const blocker = { ...testDeps().deps.plan!, stopGuardVerdict: (s: SessionState) => ({ decision: { action: 'block' as const, reason: 'x', hook: 'H08' as const }, next: s, why: 'blocked' as const }) }
    saveState('omp', SID, planState())
    const off = setup(sb, { plan: blocker, config: d => ({ config: { ...d, plan: { ...d.plan, stopGuard: false } }, vault: '/v', shim: '/s', source: 'defaults' }) })
    expect(await off.fp.emit('session_stop', stopEvent, off.ctx)).toBeUndefined()
    const sub = setup(sb, { plan: blocker }, { kind: 'sub' })
    expect(await sub.fp.emit('session_stop', stopEvent, sub.ctx)).toBeUndefined()
    const bad = setup(sb, { plan: blocker }, { sid: '../escape' })
    expect(await bad.fp.emit('session_stop', { ...stopEvent, session_id: '../escape' }, bad.ctx)).toBeUndefined()
  }))

  test('real core: H11 blocks while planning with the core reason verbatim and shares the counters; the chain cap releases', () => withSandbox(async sb => {
    const { fp, ctx, cwd } = setup(sb, { plan: realPlan })
    saveState('omp', SID, planState({ phase: 'plan', status: 'PENDING' }))
    const first = await fp.emit('session_stop', stopEvent, ctx) as { decision: string, reason: string }
    expect(first.decision).toBe('block')
    expect(first.reason).toStartWith('Buracle plan check:')
    expect(isGuardContinuation(first.reason)).toBe(true)
    expect(loadState('omp', SID).guard).toMatchObject({ blocksForPlan: 1, blocksInChain: 1 })
    mkdirSync(join(cwd, 'docs', 'plans'), { recursive: true })
    writeFileSync(join(cwd, 'docs', 'plans', '2026-10-08-demo.md'), '# Demo\n')
    const continued = { ...stopEvent, stop_hook_active: true }
    const second = await fp.emit('session_stop', continued, ctx) as { reason: string }
    expect(second.reason).toStartWith('Buracle plan check:')
    expect(second.reason).toContain('error')
    for (let i = 0; i < 3; i++) await fp.emit('session_stop', continued, ctx)
    expect(loadState('omp', SID).guard.blocksInChain).toBe(5)
    expect(await fp.emit('session_stop', continued, ctx)).toBeUndefined()
    expect(loadState('omp', SID).guard.blocksInChain).toBe(0)
    const notices = ctx.uiCalls.filter(c => c.method === 'notify')
    expect(notices.length).toBe(1)
    expect(String(notices[0]?.args[0])).toContain('docs/plans/2026-10-08-demo.md')
    expect(notices[0]?.args[1]).toBe('warning')
    await fp.emit('input', { type: 'input', text: 'please continue', source: 'interactive' }, ctx)
    expect((await fp.emit('session_stop', stopEvent, ctx) as { decision: string }).decision).toBe('block')
  }))

  test('real core: H08 blocks an approved plan in implementation; a pause releases it', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { plan: realPlan })
    saveState('omp', SID, planState())
    const r = await fp.emit('session_stop', stopEvent, ctx) as { reason: string }
    expect(r.reason).toStartWith('Buracle stop guard:')
    saveState('omp', SID, planState({ phase: 'plan' }, { interaction: { state: 'paused', kind: 'decision', since: 1 } }))
    expect(await fp.emit('session_stop', stopEvent, ctx)).toBeUndefined()
  }))

  test('stopReason keeps a Buracle guard text verbatim and prefixes anything else', () => {
    expect(stopReason('H08', 'Buracle stop guard: keep going')).toBe('Buracle stop guard: keep going')
    expect(stopReason('H11', 'fix the plan')).toBe('Buracle H11: fix the plan')
  })
})

describe('omp extension: compaction (H06/H07)', () => {
  test('session.compacting returns plan context, writes the handoff memory and preserves its id; session_compact restores', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb, { compact: {
      compactInstructions: (_b, s) => `Keep plan ${s.plan?.slug} state`,
      handoffNote: input => ({ slug: `handoff-${input.project}-${input.branch}`, markdown: `# Handoff ${input.sessionId}\n` }),
      restoreContext: (s, handoff) => `Resume plan ${s.plan?.slug}; handoff at ${handoff}`,
    } })
    saveState('omp', SID, planState())
    const r = await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx) as { context: string[], preserveData: { buracle: Record<string, unknown> } }
    const id = 'handoff-handoff-demo-main'
    expect(r).toEqual({ context: ['Keep plan demo state'], preserveData: { buracle: { v: 1, sessionId: SID, plan: 'docs/plans/2026-10-08-demo.md', handoff: id } } })
    expect(memory.handoffs).toEqual([{ sid: SID, cwd: ctx.cwd, slug: 'handoff-demo-main', markdown: `# Handoff ${SID}\n`, branch: 'main' }])
    await fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 'We built X.', preserveData: r.preserveData }, fromExtension: false }, ctx)
    expect(fp.sent).toEqual([{ message: { customType: 'buracle.compact-restore', content: `Resume plan demo; handoff at ${id}`, display: false }, options: { deliverAs: 'nextTurn' } }])
    await Bun.sleep(0)
    expect(memory.spool.at(-1)).toEqual({ sid: SID, entries: [{ ts: 1_791_400_000_000, ev: 'compact', excerpt: 'We built X.' }] })
  }))

  test('no plan: no compaction context; a memory that stores nothing means no handoff id', () => withSandbox(async sb => {
    const bridge = { ...fakeMemory().bridge, writeHandoff: async () => undefined }
    const { fp, ctx } = setup(sb, { memory: bridge, compact: { compactInstructions: () => 'x', handoffNote: () => ({ slug: 'h', markdown: '' }), restoreContext: () => 'y' } })
    expect(await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx)).toBeUndefined()
    saveState('omp', SID, planState())
    const r = await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx) as { preserveData: { buracle: Record<string, unknown> } }
    expect(r.preserveData.buracle['handoff']).toBeUndefined()
  }))
})

describe('omp extension: session lifecycle, status and telemetry (H05/H14/H16/H18)', () => {
  test('session_start exports the session for tool shells, starts memory capture, writes telemetry and starts the 30 s status timer', () => withSandbox(async sb => {
    const { fp, ctx, env, memory } = setup(sb, {}, { pct: 37.4, model: 'claude-opus-5-5', provider: 'anthropic' })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    expect(env).toEqual({ BURACLE_SESSION_ID: SID, BURACLE_HARNESS: 'omp' })
    await Bun.sleep(0)
    expect(memory.started).toEqual([{ sid: SID, cwd: ctx.cwd }])
    expect(memory.contexts).toEqual([ctx.cwd])
    expect(readTelemetry('omp', SID)).toMatchObject({ v: 1, harness: 'omp', sessionId: SID, model: 'claude-opus-5-5', modelId: 'anthropic/claude-opus-5-5', effort: 'high', ctx: { pct: 37, tokens: 74800, window: 200_000 } })
    expect(ctx.intervals.map(i => i.ms)).toEqual([30_000])
    expect(ctx.timeouts.length).toBe(1)
    await Bun.sleep(5)
    expect(ctx.uiCalls.filter(c => c.method === 'setStatus').map(c => c.args)).toEqual([[STATUS_KEYS.month, undefined], [STATUS_KEYS.mem, undefined]])
  }))

  test('status keys render their canonical segments; the band appears while a plan is registered', () => withSandbox(async sb => {
    const memStatus = { v: 3, computed_at: '2026-10-08T00:00:00Z', health: 'ok', reasons: [], counts: { project: 3, person: 1 }, regions: {}, captures: 1, store: { engine: 'cortexdb', version: '2.124.0', ok: true }, redactions_24h: 0 } as const
    let gitCalls = 0
    const { fp, ctx, cwd } = setup(sb, {
      usage: () => ({ harness: 'omp', computed_at: '2026-10-08T00:00:00Z', windows: [], month_key: monthKeyOf(1_791_400_000_000), month: { start: '2026-10-01', tokens: 3_400_000, usd: 12.5, byModel: {} } }),
      memoryStatus: () => ({ ...memStatus, reasons: [] }),
      gitState: async () => { gitCalls++; return { branch: 'main', ahead: 1, behind: 0, staged: 0, unstaged: 2, untracked: 0, stash: 0, conflicts: 0 } },
      plan: { ...testDeps().deps.plan!, parsePlan: () => ({ header: { created: '2026-10-08', status: 'IN_PROGRESS', approved: true, worktree: false, type: 'Feature' }, title: 'Demo', sections: [], tasks: [{ n: 1, title: 'a', done: true, files: [] }, { n: 2, title: 'b', done: false, files: [] }] }) },
    })
    mkdirSync(join(cwd, 'docs', 'plans'), { recursive: true })
    writeFileSync(join(cwd, 'docs', 'plans', '2026-10-08-demo.md'), '# Demo\n')
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await Bun.sleep(5)
    expect(ctx.uiCalls).toContainEqual({ method: 'setStatus', args: [STATUS_KEYS.month, 'month=3400000/$12.5'] })
    expect(ctx.uiCalls).toContainEqual({ method: 'setStatus', args: [STATUS_KEYS.mem, 'mem=ok'] })
    const statusBand = (calls: typeof ctx.uiCalls) => calls.filter(c => c.method === 'setWidget' && c.args[0] === WIDGET_KEY)
    expect(statusBand(ctx.uiCalls)).toEqual([])
    saveState('omp', SID, planState())
    ctx.intervals[0]?.fn()
    await Bun.sleep(5)
    expect(statusBand(ctx.uiCalls)).toEqual([{ method: 'setWidget', args: [WIDGET_KEY, ['month=3400000/$12.5 | mem=ok | git=main | plan=demo[implement]1/2'], { placement: 'belowEditor' }] }])
    expect(gitCalls).toBe(1)
    const before = ctx.uiCalls.length
    ctx.intervals[0]?.fn()
    await Bun.sleep(5)
    expect(ctx.uiCalls.slice(before).filter(c => c.method === 'setWidget')).toEqual([])
  }))

  test('month: only the current month counts, month_pct shows; a stale or missing entry triggers one throttled background refresh', () => withSandbox(async sb => {
    const NOW = 1_791_400_000_000
    const thisMonth = monthKeyOf(NOW)
    let entry: Record<string, unknown> | undefined = { harness: 'omp', computed_at: new Date(NOW - 60_000).toISOString(), windows: [], month_key: thisMonth, month_pct: 42, month: { start: `${thisMonth}-01`, tokens: 1000, byModel: {} } }
    const { fp, ctx, usageRefreshes } = setup(sb, { usage: () => entry as never })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await Bun.sleep(5)
    expect(ctx.uiCalls).toContainEqual({ method: 'setStatus', args: [STATUS_KEYS.month, 'month=1000 42%'] })
    expect(usageRefreshes.count).toBe(0)
    entry = { ...entry, month_key: '1999-01' }
    ctx.intervals[0]?.fn()
    await Bun.sleep(5)
    expect(ctx.uiCalls.at(-2)).toEqual({ method: 'setStatus', args: [STATUS_KEYS.month, undefined] })
    expect(usageRefreshes.count).toBe(1)
    entry = undefined
    ctx.intervals[0]?.fn()
    await Bun.sleep(5)
    expect(usageRefreshes.count).toBe(1)
  }))

  test('H21: the main session start prepares the workspace (memory UI, code indexes)', () => withSandbox(async sb => {
    const prepared: string[] = []
    const { fp, ctx } = setup(sb, { prepareWorkspace: async cwd => { prepared.push(cwd); return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } } } })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await Bun.sleep(5)
    expect(prepared).toEqual([ctx.cwd])
  }))

  test('style buracle: the Buracle bar is the band below the editor, with or without a plan', () => withSandbox(async sb => {
    const info = { product: { name: 'Buracle', version: '9.9.9' }, harness: { label: 'OMP', version: '18.8.3' }, memoryUrl: 'http://127.0.0.1:41777' }
    const { fp, ctx } = setup(sb, { bar: { lines: barLines, render: renderPlainLines, info: async () => info } })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await Bun.sleep(5)
    const widget = ctx.uiCalls.filter(c => c.method === 'setWidget' && c.args[0] === WIDGET_KEY).at(-1)
    expect(widget?.args[0]).toBe(WIDGET_KEY)
    const lines = widget?.args[1] as string[]
    expect(lines.at(-1)).toBe('Buracle 9.9.9 · OMP 18.8.3 · Buracle Brain: localhost:41777')
    expect(widget?.args[2]).toEqual({ placement: 'belowEditor' })
  }))

  test('an entry of this month older than the cache TTL still shows and starts a refresh; the band shows pending updates', () => withSandbox(async sb => {
    const NOW = 1_791_400_000_000
    const entry = { harness: 'omp' as const, computed_at: new Date(NOW - 10 * 60_000).toISOString(), windows: [], month_key: monthKeyOf(NOW), month: { start: 'x', tokens: 7, byModel: {} } }
    const generated = testGenerated({ status: { layout: { rows: [['month', 'upd']], thresholds: { ctxWarn: 75, ctxCrit: 90 }, emoji: false }, setStatus: { 'buracle.budget': ['month'] } } })
    const t = testDeps({ usage: () => entry, updates: () => 3 })
    const fp = fakePi()
    createBuracleExtension(generated, t.deps)(fp.pi)
    const cwd = join(sb.root, 'work')
    mkdirSync(cwd, { recursive: true })
    const ctx = fakeCtx({ cwd, sid: SID })
    saveState('omp', SID, planState())
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await Bun.sleep(5)
    expect(ctx.uiCalls).toContainEqual({ method: 'setStatus', args: ['buracle.budget', 'month=7'] })
    expect(ctx.uiCalls).toContainEqual({ method: 'setWidget', args: [WIDGET_KEY, ['month=7 | upd=3'], { placement: 'belowEditor' }] })
    expect(t.usageRefreshes.count).toBe(1)
  }))

  test('production usage deps: the shared usage.json reader and spawnUsageRefresh with the CLI argv', () => withSandbox(async () => {
    const d = defaultDeps()
    expect(d.usage()).toBeUndefined()
    const NOW = Date.now()
    mkdirSync(paths.stateDir(), { recursive: true })
    const omp = { harness: 'omp', computed_at: new Date(NOW).toISOString(), windows: [], month_key: monthKeyOf(NOW), month: { start: 'x', tokens: 5, byModel: {} } }
    writeFileSync(paths.usageFile(), JSON.stringify({ v: 1, updated_at: 'x', harnesses: { omp, codex: { ...omp, harness: 'codex' } } }))
    expect(d.usage()).toEqual(omp as never)
    expect(fakeExe(join(paths.binDir(), 'buracle'), '')).toBe(paths.shimPath())
    d.refreshUsage()
    expect(existsSync(join(paths.stateDir(), 'usage.spawn.omp'))).toBe(true)
  }))

  test('no UI work outside the TUI and nothing at all for subagents', () => withSandbox(async sb => {
    const rpc = setup(sb, {}, { mode: 'rpc' })
    await rpc.fp.emit('session_start', { type: 'session_start' }, rpc.ctx)
    expect(rpc.ctx.uiCalls).toEqual([])
    expect(rpc.ctx.intervals).toEqual([])
    expect(rpc.env['BURACLE_SESSION_ID']).toBe(SID)
    const sub = setup(sb, {}, { kind: 'sub' })
    await sub.fp.emit('session_start', { type: 'session_start' }, sub.ctx)
    expect(sub.env).toEqual({})
    expect(sub.memory.started).toEqual([])
  }))

  test('turn_end writes telemetry and spools the assistant excerpt; shutdown and switches finalize', () => withSandbox(async sb => {
    const { fp, ctx, memory } = setup(sb, {}, { pct: 50 })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await fp.emit('turn_end', { type: 'turn_end', turnIndex: 1, message: { role: 'assistant', model: 'gpt-5.5', usage: { totalTokens: 1234 }, content: [{ type: 'text', text: 'Implemented the parser.' }] } }, ctx)
    await Bun.sleep(0)
    expect(memory.spool.at(-1)).toEqual({ sid: SID, entries: [{ ts: 1_791_400_000_000, ev: 'turn', model: 'gpt-5.5', tokens: 1234, excerpt: 'Implemented the parser.' }] })
    expect(readTelemetry('omp', SID)?.ctx?.pct).toBe(50)
    await fp.emit('session_shutdown', { type: 'session_shutdown' }, ctx)
    expect(memory.finalized).toEqual([SID])
    const next = fakeCtx({ cwd: ctx.cwd, sid: '01a118a8-8d01-740c-9360-aaaaaaaaaaaa' })
    await fp.emit('session_switch', { type: 'session_switch', reason: 'new' }, next)
    await Bun.sleep(0)
    expect(memory.finalized).toEqual([SID, SID])
    expect(memory.started.map(s => s.sid)).toEqual([SID, '01a118a8-8d01-740c-9360-aaaaaaaaaaaa'])
  }))

  test('session start, a prompt and a compaction spawn no process: the record is started and touched in-process and only the end of the session starts the finalizer, directly', () => withSandbox(async sb => {
    const spawned: Array<[string[], Record<string, string> | undefined]> = []
    const started: string[] = []
    const touched: string[] = []
    const bridge = createMemoryBridge({
      cli: () => ['/b/buracle'], append: () => undefined,
      spawnDetached: (argv, env) => { spawned.push([argv, env]); return true },
      recordStart: async sid => { started.push(sid) }, touch: sid => { touched.push(sid) },
      run: async () => ({ code: 1, stdout: '', stderr: '', timedOut: false }),
    })
    const { fp, ctx, runs } = setup(sb, { memory: bridge })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    await fp.emit('input', { type: 'input', text: 'From now on always use bun for scripts.', source: 'interactive' }, ctx)
    await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }, ctx)
    await fp.emit('session_compact', { type: 'session_compact', compactionEntry: { summary: 'The parser is done.' }, fromExtension: false }, ctx)
    await Bun.sleep(0)
    expect(started).toEqual([SID])
    expect(touched).toEqual([SID])
    expect(spawned).toEqual([])
    expect(runs).toEqual([])
    await fp.emit('session_shutdown', { type: 'session_shutdown' }, ctx)
    expect(spawned).toEqual([[['/b/buracle', 'mem', 'finalize', '--harness', 'omp', '--session', SID], { BURACLE_FINALIZER: '1' }]])
  }))

  test('H16 maintenance prunes idle omp session state but keeps the live one', () => withSandbox(async sb => {
    let pruned: { keep: string[] } | undefined
    const { fp, ctx } = setup(sb, { prune: (keep) => { pruned = { keep: [...keep] }; return [] } })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    ctx.timeouts[0]?.fn()
    expect(pruned).toEqual({ keep: [SID] })
  }))
})

describe('omp extension: commands', () => {
  test('/buracle notifies a status summary', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    saveState('omp', SID, planState({}, { interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'which DB?' } }))
    await fp.commands.get('buracle')!.handler('', ctx)
    const note = ctx.uiCalls.find(c => c.method === 'notify')
    expect(String(note?.args[0])).toContain(`session ${SID}`)
    expect(String(note?.args[0])).toContain('plan demo · implement · IN_PROGRESS')
    expect(String(note?.args[0])).toContain('paused (decision): which DB?')
    expect(String(note?.args[0])).toContain('/plan-build /goal-build')
  }))

  test('/remember runs `buracle mem remember -- <text>` without a model turn', () => withSandbox(async sb => {
    const { fp, ctx, runs } = setup(sb)
    await fp.commands.get('remember')!.handler('  FTS5 karar notu  ', ctx)
    expect(runs).toEqual([['buracle', 'mem', 'remember', '--json', '--', 'FTS5 karar notu']])
    expect(ctx.uiCalls.at(-1)).toEqual({ method: 'notify', args: ['Remembered', 'info'] })
    await fp.commands.get('remember')!.handler('--force is not an option here', ctx)
    expect(runs.at(-1)).toEqual(['buracle', 'mem', 'remember', '--json', '--', '--force is not an option here'])
    await fp.commands.get('remember')!.handler('   ', ctx)
    expect(ctx.uiCalls.at(-1)).toEqual({ method: 'notify', args: ['Usage: /remember <text>', 'warning'] })
    const none = setup(sb, { cli: () => undefined })
    await none.fp.commands.get('remember')!.handler('x', none.ctx)
    expect(none.ctx.uiCalls.at(-1)).toEqual({ method: 'notify', args: ['The buracle CLI was not found; run `buracle install`', 'error'] })
  }))

  test('/buracle-ping answers pong without a model call, a CLI run or a message', () => withSandbox(async sb => {
    const { fp, ctx, runs } = setup(sb)
    let sideTurns = 0
    ctx.runEphemeralTurn = async () => { sideTurns++; return { replyText: 'x' } }
    await fp.commands.get('buracle-ping')!.handler('', ctx)
    await fp.commands.get('buracle-ping')!.handler('anything', ctx)
    expect(ctx.uiCalls).toEqual([{ method: 'notify', args: ['buracle: pong', 'info'] }, { method: 'notify', args: ['buracle: pong', 'info'] }])
    expect({ sideTurns, runs, sent: fp.sent }).toEqual({ sideTurns: 0, runs: [], sent: [] })
  }))

  test('/aside asks one tool-less side turn and shows its answer; nothing reaches the session', () => withSandbox(async sb => {
    const { fp, ctx, runs } = setup(sb)
    const asked: Array<{ promptText: string, tools?: false, signal?: AbortSignal }> = []
    ctx.runEphemeralTurn = async (o) => { asked.push(o); return { replyText: '  4\n' } }
    await fp.commands.get('aside')!.handler('  what is 2+2  ', ctx)
    expect(asked.map(a => ({ promptText: a.promptText, tools: a.tools }))).toEqual([{ promptText: 'Answer briefly, from this conversation alone, without changing anything: what is 2+2', tools: false }])
    expect(asked[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(ctx.uiCalls).toEqual([{ method: 'notify', args: ['aside: 4', 'info'] }])
    expect({ runs, sent: fp.sent }).toEqual({ runs: [], sent: [] })
  }))

  test('/aside: the usage, a model that refuses `tools: false`, an empty answer, a failure and an omp without side turns', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    const last = () => ctx.uiCalls.at(-1)
    await fp.commands.get('aside')!.handler('   ', ctx)
    expect(last()).toEqual({ method: 'notify', args: ['Usage: /aside <question>', 'warning'] })
    const tools: Array<false | undefined> = []
    ctx.runEphemeralTurn = async (o) => {
      tools.push(o.tools)
      if (o.tools === false) throw new Error('Model a/b (x) does not support tools: false for ephemeral turns because its transport requires native tools.')
      return { replyText: 'yes' }
    }
    await fp.commands.get('aside')!.handler('ok?', ctx)
    expect(tools).toEqual([false, undefined])
    expect(last()).toEqual({ method: 'notify', args: ['aside: yes', 'info'] })
    ctx.runEphemeralTurn = async () => ({ replyText: '   ' })
    await fp.commands.get('aside')!.handler('ok?', ctx)
    expect(last()).toEqual({ method: 'notify', args: ['aside: no answer', 'warning'] })
    let calls = 0
    ctx.runEphemeralTurn = async () => { calls++; throw new Error('No active model on session') }
    await fp.commands.get('aside')!.handler('ok?', ctx)
    expect(calls).toBe(1)
    expect(last()).toEqual({ method: 'notify', args: ['aside: No active model on session', 'error'] })
    delete ctx.runEphemeralTurn
    await fp.commands.get('aside')!.handler('ok?', ctx)
    expect(last()).toEqual({ method: 'notify', args: ['aside: this omp has no side-turn API (omp 18.3 or later); use /btw <question>', 'warning'] })
    expect(fp.sent).toEqual([])
  }))
})

describe('omp extension: fail-safe under a fully broken environment', () => {
  test('every handler returns normally when every dependency throws (H01/H02 then fail closed)', () => withSandbox(async sb => {
    const boom = () => { throw new Error('broken') }
    const broken: Partial<ExtensionDeps> = {
      config: boom, health: boom, memSegment: boom, usage: boom, updates: boom, memoryStatus: boom, readText: boom, listDir: boom, isFile: boom, prune: boom, setEnv: boom, home: boom,
      state: { load: boom, update: boom, telemetry: boom },
      projectSlug: async () => boom(), branch: async () => boom(), run: async () => boom(),
      memory: { appendSpool: async () => boom(), sessionStart: async () => boom(), spawnFinalizer: async () => boom(), contextText: async () => boom(), writeHandoff: async () => boom() },
      captureEnabled: boom, buracleRepo: boom, refreshUsage: boom,
      cli: boom,
    }
    const { fp, ctx } = setup(sb, broken)
    const events: Array<[string, unknown]> = [
      ['session_start', { type: 'session_start' }],
      ['tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: 'rm -rf /' } }],
      ['tool_result', { type: 'tool_result', toolCallId: '1', toolName: 'write', input: { path: 'a', content: 'x' }, content: [], isError: false }],
      ['input', { type: 'input', text: 'dur', source: 'interactive' }],
      ['before_agent_start', { type: 'before_agent_start', prompt: 'x', systemPrompt: [] }],
      ['turn_end', { type: 'turn_end', turnIndex: 0 }],
      ['session_stop', { type: 'session_stop', turn_id: 1, session_id: SID, stop_hook_active: false }],
      ['session.compacting', { type: 'session.compacting', sessionId: SID, messages: [] }],
      ['session_compact', { type: 'session_compact' }],
      ['session_shutdown', { type: 'session_shutdown' }],
    ]
    for (const [ev, payload] of events) {
      const r = await fp.emit(ev, payload, ctx)
      if (ev === 'tool_call') expect((r as { block?: boolean }).block).toBe(true)
      if (ev === 'session_stop') expect(r).toBeUndefined()
    }
    await fp.commands.get('buracle')!.handler('', ctx)
    await fp.commands.get('remember')!.handler('x', ctx)
  }))
})

describe('omp extension: real core policy (integration)', () => {
  testWhenImplemented('H01 with the real bash guard blocks `rm -rf /`', () => checkBash('ls', { extraDeny: [] }), () => withSandbox(async sb => {
    const cwd = join(sb.root, 'work')
    mkdirSync(cwd, { recursive: true })
    const fp = fakePi()
    createBuracleExtension(testGenerated(), { memory: testDeps().deps.memory! })(fp.pi)
    const ctx = fakeCtx({ cwd, sid: SID })
    const r = await fp.emit('tool_call', { type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: 'rm -rf /' } }, ctx) as { block?: boolean, reason?: string }
    expect(r.block).toBe(true)
    expect(r.reason).toStartWith('Buracle H01: ')
    const allowed = await fp.emit('tool_call', { type: 'tool_call', toolCallId: '2', toolName: 'bash', input: { command: 'ls -la' } }, ctx) as { block?: boolean } | undefined
    expect(allowed?.block).toBeUndefined()
  }))
})

describe('omp extension: H28 project assets', () => {
  test('session_start and session_stop start the link run; before_agent_start lists the unindexed path rules; an edit of a rule gets its index line', () => withSandbox(async sb => {
    const { makeRepo, write } = await import('../../workflow/fixture')
    const repo = await makeRepo(sb.root, 'proj')
    write(join(repo, 'AGENTS.md'), '# Demo\n\n## Scoped rules\n\n')
    write(join(repo, '.claude', 'rules', 'web.md'), '---\npaths: ["src/**/*.tsx"]\n---\n')
    const linked: string[] = []
    const base = defaultDeps().projectAssets
    const { fp, ctx } = setup(sb, {
      policy: { ...testDeps().deps.policy!, capabilityCard: () => 'CARD', isGuardContinuation: () => false },
      memory: fakeMemory().bridge,
      prepareWorkspace: async cwd => ({ cwd, root: repo, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }),
      projectAssets: { ...base, link: root => { linked.push(String(root)); return true } },
      plan: { ...testDeps().deps.plan!, stopGuardVerdict },
    }, { cwd: repo })
    await fp.emit('session_start', { type: 'session_start' }, ctx)
    const r = await fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'hi', systemPrompt: [] }, ctx) as { systemPrompt: string[] }
    expect(r.systemPrompt[0]).toContain('- `.claude/rules/web.md` \u2014 `src/**/*.tsx`')
    expect(linked).toEqual([repo])
    const edit = await fp.emit('tool_result', { type: 'tool_result', toolCallId: '1', toolName: 'write', input: { path: join(repo, '.claude', 'rules', 'web.md'), content: '---\npaths: ["src/**/*.tsx"]\n---\n' }, content: [], isError: false }, ctx) as { additionalContext?: string } | undefined
    expect(edit?.additionalContext).toContain('.claude/rules/web.md is not in AGENTS.md')
    await fp.emit('session_stop', { type: 'session_stop', turn_id: 1, session_id: SID, stop_hook_active: false }, ctx)
    expect(linked).toEqual([repo, repo])
  }))
})

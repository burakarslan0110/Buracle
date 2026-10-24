import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FALLBACK_SPOOL_SUFFIX, GUARD_FAILED, WRITE_GUARD_FAILED, claudeHook, defaultHookDeps, handoffRecordPath, readHealth, reviewNote, runawayNotice,
  type HookCore, type HookDeps,
} from '../../../src/adapters/claude/hook'
import type { AdapterContext } from '../../../src/adapters/registry'
import { hookBundle } from '../../../src/cli/hook-data'
import type { BuracleConfig } from '../../../src/core/config'
import { defaultConfig } from '../../../src/core/config'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { STOP_GUARD_ESCAPE } from '../../../src/core/plan/state'
import * as paths from '../../../src/engine/paths'
import { run } from '../../../src/engine/proc'
import { freshState, saveState, statePath } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { sandboxSelfPaths } from '../shared/self-paths-fixture'

const FIX = join(import.meta.dir, 'fixtures', 'hooks')
const SID = 'sess-hook-1'
const NOW = 1_800_000_000_000
const QUIET = { stdout: '', exitCode: 0 }

function fixture(name: string, patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...(JSON.parse(readFileSync(join(FIX, name), 'utf8')) as Record<string, unknown>), ...patch })
}

function routingOnly(): CanonicalBundle {
  const routing = hookBundle(paths.repoRoot(), () => { throw new Error('the classic hooks must not load the canonical bundle') }).routing
  return new Proxy({}, {
    get: (_t, key) => {
      if (key === 'routing') return routing
      throw new Error(`the classic hooks must not read canonical.${String(key)}`)
    },
  }) as CanonicalBundle
}

function ctxWith(config: BuracleConfig = defaultConfig()): AdapterContext {
  return {
    repoRoot: paths.repoRoot(),
    config,
    paths,
    buracleBin: paths.shimPath(),
    get canonical(): CanonicalBundle { return routingOnly() },
  }
}

const unexpected = (name: string) => () => { throw new Error(`unexpected call: ${name}`) }

function core(over: Partial<HookCore> = {}): HookCore {
  return {
    checkBash: unexpected('checkBash'),
    checkWrite: unexpected('checkWrite'),
    routeTool: unexpected('routeTool'),
    validatePlan: unexpected('validatePlan'),
    stopGuardVerdict: unexpected('stopGuardVerdict'),
    handoffNote: unexpected('handoffNote'),
    restoreContext: unexpected('restoreContext'),
    validateReviewJson: unexpected('validateReviewJson'),
    checkQuestion: unexpected('checkQuestion'),
    consentVerdict: (_c, s) => ({ allow: true, next: s }),
    ...over,
  }
}

function deps(over: Partial<HookDeps> = {}, coreOver: Partial<HookCore> = {}): Partial<HookDeps> {
  return {
    now: () => NOW,
    importModule: async () => undefined,
    branch: async () => 'main',
    project: async () => 'demo',
    sessionMaint: () => undefined,
    env: () => undefined,
    buracleRepo: async () => undefined,
    realpath: () => undefined,
    run: unexpected('run') as HookDeps['run'],
    prepareWorkspace: async () => undefined,
    core: core(coreOver),
    ...over,
  }
}

function writeHeartbeat(beat: Record<string, unknown>): void {
  const f = paths.heartbeatFile('claude', SID)
  mkdirSync(join(f, '..'), { recursive: true })
  writeFileSync(f, JSON.stringify(beat))
}

const MOD_BYPASSED = ['PreToolUse', 'PostToolUse', 'PreCompact', 'UserPromptSubmit']
const MOD_CLASSIC = [...MOD_BYPASSED, 'SessionStart', 'Stop', 'SubagentStop', 'PostCompact']

const json = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>
const feedback = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason } })
const feedbackOf = (stdout: string): string => String((json(stdout)['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['additionalContext'])

describe('payload handling', () => {
  test('bad stdin, missing or invalid session ids are no-ops, except for the PreToolUse guards (G13)', async () => {
    await withSandbox(async () => {
      const d = deps()
      expect(await claudeHook('Stop', 'not json', ctxWith(), d)).toEqual(QUIET)
      expect(await claudeHook('Stop', '[]', ctxWith(), d)).toEqual(QUIET)
      expect(await claudeHook('Stop', fixture('stop.json', { session_id: undefined }), ctxWith(), d)).toEqual(QUIET)
      const guarded = await claudeHook('PreToolUse', fixture('pretooluse-bash.json', { session_id: '../etc' }), ctxWith(), deps({}, { checkBash: () => ({ deny: 'destructive' }) }))
      expect(json(guarded.stdout)['hookSpecificOutput']).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'destructive' })
      expect(await claudeHook('PreToolUse', fixture('pretooluse-bash.json', { session_id: '../etc' }), ctxWith(), deps({}, { checkBash: () => ({}) }))).toEqual(QUIET)
      let called = false
      await claudeHook('SessionEnd', fixture('sessionend.json', { session_id: 'a b' }), ctxWith(), deps({ importModule: async () => { called = true; return undefined } }))
      expect(called).toBe(false)
      expect(await claudeHook('Notification', fixture('stop.json'), ctxWith(), d)).toEqual(QUIET)
    })
  })
})

describe('the mod heartbeat decides who acts (heartbeatHandles)', () => {
  test('a fresh heartbeat silences nothing: the command hooks always act', async () => {
    await withSandbox(async () => {
      writeHeartbeat({ at: NOW - 10_000, classic: true, handles: MOD_CLASSIC })
      saveState('claude', SID, { ...freshState(), plan: { path: '/tmp/project/docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 1000 } })
      const stop = await claudeHook('Stop', fixture('stop.json'), ctxWith(), deps({}, {
        stopGuardVerdict: st => ({ decision: { action: 'block', reason: 'keep going', hook: 'H08' }, next: st, why: 'blocked' }),
      }))
      expect(json(stop.stdout)).toEqual(feedback('keep going'))
      const restore = await claudeHook('SessionStart', fixture('sessionstart-compact.json'), ctxWith(), deps({}, { restoreContext: () => 'restored' }))
      expect(json(restore.stdout)['hookSpecificOutput']).toEqual({ hookEventName: 'SessionStart', additionalContext: 'restored' })
    })
  })

  test('H01 runs on every shell call whatever the heartbeat says', async () => {
    await withSandbox(async () => {
      writeHeartbeat({ at: NOW - 10_000, classic: true, handles: MOD_CLASSIC })
      const commands: string[] = []
      const r = await claudeHook('PreToolUse', fixture('pretooluse-bash.json'), ctxWith(), deps({}, {
        checkBash: c => { commands.push(c); return { deny: 'destructive' } },
      }))
      expect(json(r.stdout)['hookSpecificOutput']).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'destructive' })
      expect(commands).toEqual(['rm -rf / --no-preserve-root'])
      const real = await claudeHook('PreToolUse', fixture('pretooluse-bash.json', { tool_input: { command: 'rm -rf ~' } }), ctxWith(), { ...defaultHookDeps, now: () => NOW })
      expect((json(real.stdout)['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision']).toBe('deny')
    })
  })

  test('a heartbeat without handles, a stale one and a final one cover nothing', async () => {
    await withSandbox(async () => {
      const denyAll = deps({}, { checkBash: () => ({ deny: 'no' }) })
      for (const beat of [{ at: NOW - 10_000 }, { at: NOW - 91_000, handles: MOD_CLASSIC }, { at: NOW - 5_000, handles: MOD_CLASSIC, ended: 'prompt_input_exit' }]) {
        writeHeartbeat(beat)
        const r = await claudeHook('PreToolUse', fixture('pretooluse-bash.json'), ctxWith(), denyAll)
        expect(json(r.stdout)['hookSpecificOutput']).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' })
      }
    })
  })

  test('SessionEnd runs whatever the heartbeat says', async () => {
    await withSandbox(async () => {
      writeHeartbeat({ at: NOW - 10_000, classic: true, handles: [...MOD_CLASSIC, 'SessionEnd'] })
      const calls: unknown[][] = []
      const maint: unknown[][] = []
      await claudeHook('SessionEnd', fixture('sessionend.json'), ctxWith(), deps({
        importModule: async () => ({ spawnFinalizer: (...a: unknown[]) => { calls.push(a) } }),
        sessionMaint: (...a: unknown[]) => { maint.push(a) },
      }))
      expect(calls).toEqual([['claude', SID]])
      expect(maint).toEqual([[NOW, [SID]]])
    })
  })
})

describe('PreToolUse (Bash): H01 then H03', () => {
  test('H01 deny becomes permissionDecision deny with the reason; the guard gets the home, Buracle\'s roots and the session folder', async () => {
    await withSandbox(async sb => {
      const seen: unknown[] = []
      const cfg = defaultConfig()
      cfg.guards.bash.extraDeny = ['terraform destroy']
      const r = await claudeHook('PreToolUse', fixture('pretooluse-bash.json'), ctxWith(cfg), deps({}, {
        checkBash: (command, c) => { seen.push(command, c); return { deny: 'destructive: rm -rf /' } },
      }))
      expect(r.exitCode).toBe(0)
      expect(json(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'destructive: rm -rf /' } })
      expect(seen).toEqual(['rm -rf / --no-preserve-root', { extraDeny: ['terraform destroy'], home: sb.home, selfPaths: sandboxSelfPaths(sb), cwd: '/tmp/project', vault: join(sb.home, 'Documents', 'Buracle'), protect: [], realpath: expect.any(Function) }])
    })
  })

  test('H01 fails closed when the guard throws', async () => {
    await withSandbox(async () => {
      const r = await claudeHook('PreToolUse', fixture('pretooluse-bash.json'), ctxWith(), deps({}, { checkBash: () => { throw new Error('boom') } }))
      expect(json(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: GUARD_FAILED } })
    })
  })

  test('H03: deny, nudge context, failure (open) and allow', async () => {
    await withSandbox(async () => {
      const input = fixture('pretooluse-bash.json', { tool_input: { command: 'grep -r foo .' } })
      const allowBash = { checkBash: () => ({}) }
      let call: Record<string, unknown> | undefined
      const denied = await claudeHook('PreToolUse', input, ctxWith(), deps({}, {
        ...allowBash,
        routeTool: c => { call = c as unknown as Record<string, unknown>; return { action: 'deny', reason: 'use rg', hook: 'H03' } },
      }))
      expect(json(denied.stdout)['hookSpecificOutput']).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'use rg' })
      expect(call).toMatchObject({ harness: 'claude', sessionId: SID, cwd: '/tmp/project', tool: 'Bash', kind: 'bash', command: 'grep -r foo .' })

      const nudged = await claudeHook('PreToolUse', input, ctxWith(), deps({}, { ...allowBash, routeTool: () => ({ action: 'allow', context: ['prefer rg', 'or semble'] }) }))
      expect(json(nudged.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'prefer rg\nor semble' } })

      const failed = await claudeHook('PreToolUse', input, ctxWith(), deps({}, { ...allowBash, routeTool: () => { throw new Error('x') } }))
      expect(failed).toEqual(QUIET)

      const allowed = await claudeHook('PreToolUse', input, ctxWith(), deps({}, { ...allowBash, routeTool: () => ({ action: 'allow' }) }))
      expect(allowed).toEqual(QUIET)
    })
  })

  test('only the shell and write tools are guarded here', async () => {
    await withSandbox(async () => {
      for (const tool of ['Read', 'WebFetch', 'mcp__plugin_buracle_context7__query-docs']) {
        expect(await claudeHook('PreToolUse', fixture('pretooluse-bash.json', { tool_name: tool, tool_input: { file_path: '/x' } }), ctxWith(), deps())).toEqual(QUIET)
      }
    })
  })

  test('Monitor runs its command in the same shell: H01 guards it as Bash', async () => {
    await withSandbox(async () => {
      const commands: string[] = []
      const monitor = (input: Record<string, unknown>) => fixture('pretooluse-bash.json', { tool_name: 'Monitor', tool_input: { description: 'watch', timeout_ms: 1000, ...input } })
      const r = await claudeHook('PreToolUse', monitor({ command: 'rm -rf ~' }), ctxWith(), deps({}, {
        checkBash: c => { commands.push(c); return { deny: 'no' } },
      }))
      expect(json(r.stdout)['hookSpecificOutput']).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'no' })
      expect(commands).toEqual(['rm -rf ~'])
      expect(await claudeHook('PreToolUse', monitor({ ws: { url: 'wss://example.com' } }), ctxWith(), deps())).toEqual(QUIET)
      for (const command of ['rm -rf ~', 'git push --force origin main']) {
        const real = await claudeHook('PreToolUse', monitor({ command }), ctxWith(), { ...defaultHookDeps, now: () => NOW })
        expect((json(real.stdout)['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision']).toBe('deny')
      }
    })
  })

  test('MCP health is read from the health cache in either shape', async () => {
    await withSandbox(async () => {
      expect(readHealth()).toEqual({})
      mkdirSync(paths.stateDir(), { recursive: true })
      writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, mcp: { context7: { status: 'ok', tools: 2 }, semble: { status: 'down' }, x: 'weird', web: 'unknown' } }))
      expect(readHealth()).toEqual({ context7: 'ok', semble: 'down', web: 'unknown' })
      writeFileSync(paths.healthFile(), JSON.stringify({ codegraph: 'unknown' }))
      expect(readHealth()).toEqual({ codegraph: 'unknown' })
    })
  })

  test('a failed start recorded with `until` is down only until then; a down without one stays (core mcpHealthOf)', async () => {
    await withSandbox(async () => {
      const now = Date.UTC(2026, 9, 10, 12, 0, 0)
      mkdirSync(paths.stateDir(), { recursive: true })
      writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, mcp: { 'web-search': { status: 'down', source: 'launch', until: new Date(now + 60_000).toISOString() }, semble: { status: 'down' } } }))
      expect(readHealth(now)).toEqual({ 'web-search': 'down', semble: 'down' })
      expect(readHealth(now + 60_000)).toEqual({ 'web-search': 'unknown', semble: 'down' })
    })
  })
})

describe('PreToolUse (Edit, Write, NotebookEdit): H02 on the path and on where it lands', () => {
  const write = (file: string, cwd = '/tmp/project') => fixture('pretooluse-bash.json', { tool_name: 'Write', cwd, tool_input: { file_path: file, content: 'x' } })

  test('checkWrite gets the named paths with the I4 resolver and the checkout', async () => {
    await withSandbox(async sb => {
      const seen: unknown[] = []
      const r = await claudeHook('PreToolUse', write('/tmp/project/notes.txt'), ctxWith(), deps({
        realpath: q => (q === '/tmp/project/notes.txt' ? `${sb.home}/.ssh/authorized_keys` : undefined),
        buracleRepo: async () => '/tmp/project',
      }, { checkWrite: (paths, c) => { seen.push(paths, c); return { deny: 'protected' } } }))
      expect(json(r.stdout)['hookSpecificOutput']).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'protected' })
      expect(seen[0]).toEqual(['/tmp/project/notes.txt'])
      expect(seen[1]).toMatchObject({ cwd: '/tmp/project', home: sb.home, buracleRepo: '/tmp/project', selfPaths: sandboxSelfPaths(sb) })
      expect((seen[1] as { realpath: (p: string) => string | undefined }).realpath('/tmp/project/notes.txt')).toBe(`${sb.home}/.ssh/authorized_keys`)
    })
  })

  test('with the real core and real symlinks: links into ~/.ssh (also dangling ones) are refused, ordinary files are not', async () => {
    await withSandbox(async sb => {
      const proj = join(sb.root, 'proj')
      mkdirSync(join(proj, 'src'), { recursive: true })
      mkdirSync(join(sb.home, '.ssh'), { recursive: true })
      writeFileSync(join(sb.home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAA\n')
      symlinkSync(join(sb.home, '.ssh', 'authorized_keys'), join(proj, 'notes.txt'))
      symlinkSync(join(sb.home, '.ssh'), join(proj, 'cfg'))
      symlinkSync(join(sb.home, '.ssh', 'not-yet'), join(proj, 'later.txt'))
      const real = { ...defaultHookDeps, now: () => NOW }
      for (const file of ['notes.txt', 'cfg/config', 'later.txt']) {
        const r = await claudeHook('PreToolUse', write(join(proj, file), proj), ctxWith(), real)
        expect((json(r.stdout)['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision']).toBe('deny')
      }
      expect(await claudeHook('PreToolUse', write(join(proj, 'src', 'a.ts'), proj), ctxWith(), real)).toEqual(QUIET)
    })
  })

  test('a throwing guard fails closed', async () => {
    await withSandbox(async () => {
      const r = await claudeHook('PreToolUse', write('/tmp/project/a.ts'), ctxWith(), deps({}, { checkWrite: () => { throw new Error('boom') } }))
      expect(json(r.stdout)['hookSpecificOutput']).toEqual({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: WRITE_GUARD_FAILED })
    })
  })
})

describe("PreToolUse with the real core: Buracle's own setup where this environment puts it (SEC-1)", () => {
  const write = (file: string, cwd: string) => fixture('pretooluse-bash.json', { tool_name: 'Write', cwd, tool_input: { file_path: file, content: 'x' } })
  const bash = (command: string, cwd: string) => fixture('pretooluse-bash.json', { cwd, tool_input: { command } })
  const decision = (r: { stdout: string }): Record<string, unknown> | undefined => (r.stdout === '' ? undefined : json(r.stdout)['hookSpecificOutput'] as Record<string, unknown>)
  const real = () => ({ ...defaultHookDeps, now: () => NOW })

  test('a relocated CODEX_HOME is refused to the write tools and to the shell', () => withSandbox(async ({ root }) => {
    const codex = join(root, 'relocated-codex')
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    await withEnv({ CODEX_HOME: codex }, async () => {
      expect(decision(await claudeHook('PreToolUse', write(join(codex, 'hooks.json'), proj), ctxWith(), real()))?.['permissionDecisionReason']).toContain("Codex's own configuration")
      expect(decision(await claudeHook('PreToolUse', bash(`echo '{}' > '${codex}/config.toml'`, proj), ctxWith(), real()))?.['permissionDecisionReason']).toContain("Codex's own configuration")
      expect(decision(await claudeHook('PreToolUse', write(join(codex, 'AGENTS.md'), proj), ctxWith(), real()))?.['permissionDecision']).not.toBe('deny')
    })
  }))

  test('the checkout these hooks run from is refused from an unrelated session, and writable from inside it', () => withSandbox(async ({ root }) => {
    const repo = paths.repoRoot()
    const target = join(repo, 'src', 'cli', 'main.ts')
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    expect(decision(await claudeHook('PreToolUse', write(target, proj), ctxWith(), real()))?.['permissionDecisionReason']).toContain("Buracle's own source code")
    expect(decision(await claudeHook('PreToolUse', bash(`echo x > '${target}'`, proj), ctxWith(), real()))?.['permissionDecisionReason']).toContain("Buracle's own source code")
    expect(decision(await claudeHook('PreToolUse', write(target, repo), ctxWith(), real()))?.['permissionDecision']).not.toBe('deny')
  }), 20_000)
})

describe('Stop: H08 + H11 through stopGuardVerdict', () => {
  const PLAN = '/tmp/project/docs/plans/p.md'

  function bindPlan(phase: 'plan' | 'implement' = 'implement', path = PLAN): void {
    saveState('claude', SID, { ...freshState(), plan: { path, slug: 'p', status: phase === 'plan' ? 'PENDING' : 'IN_PROGRESS', type: 'Feature', phase, registeredAt: NOW - 1000 } })
  }

  test('without a plan bound to the session nothing is guarded and nothing is written', async () => {
    await withSandbox(async ({ buracleHome }) => {
      expect(await claudeHook('Stop', fixture('stop.json'), ctxWith(), deps())).toEqual(QUIET)
      expect(existsSync(buracleHome)).toBe(false)
    })
  })

  test('a block becomes non-error Stop feedback (additionalContext); the inputs reach the core; an unchanged state is not rewritten', async () => {
    await withSandbox(async () => {
      bindPlan()
      const before = readFileSync(statePath('claude', SID), 'utf8')
      const args: unknown[] = []
      const r = await claudeHook('Stop', fixture('stop.json', { stop_hook_active: true }), ctxWith(), deps({}, {
        stopGuardVerdict: (s, i, cfg, check) => { args.push(i, cfg, check); return { decision: { action: 'block', reason: 'plan not VERIFIED', hook: 'H08' }, next: s, why: 'blocked' } },
      }))
      expect(json(r.stdout)).toEqual(feedback('plan not VERIFIED'))
      expect(args).toEqual([
        { harness: 'claude', sessionId: SID, cwd: '/tmp/project', now: NOW, hookActive: true, lastMessage: 'Task 2 is done; continuing with task 3.' },
        defaultConfig().plan,
        { exists: false, findings: [] },
      ])
      expect(readFileSync(statePath('claude', SID), 'utf8')).toBe(before)
    })
  })

  test('moved guard counters are persisted under the state lock', async () => {
    await withSandbox(async () => {
      bindPlan()
      const r = await claudeHook('Stop', fixture('stop.json'), ctxWith(), deps({}, {
        stopGuardVerdict: s => ({ decision: { action: 'block', reason: 'keep going', hook: 'H08' }, next: { ...s, guard: { blocksForPlan: s.guard.blocksForPlan + 1, blocksInChain: s.guard.blocksInChain + 1, lastBlockAt: NOW } }, why: 'blocked' }),
      }))
      expect(json(r.stdout)).toEqual(feedback('keep going'))
      const saved = JSON.parse(readFileSync(statePath('claude', SID), 'utf8')) as { guard: Record<string, number> }
      expect(saved.guard).toEqual({ blocksForPlan: 1, blocksInChain: 1, lastBlockAt: NOW })
    })
  })

  test('allow, a disabled guard and a throwing guard all let the stop through', async () => {
    await withSandbox(async () => {
      bindPlan()
      expect(await claudeHook('Stop', fixture('stop.json'), ctxWith(), deps({}, { stopGuardVerdict: s => ({ decision: { action: 'allow' }, next: s, why: 'paused' }) }))).toEqual(QUIET)
      const off = defaultConfig()
      off.plan.stopGuard = false
      expect(await claudeHook('Stop', fixture('stop.json'), ctxWith(off), deps())).toEqual(QUIET)
      expect(await claudeHook('Stop', fixture('stop.json'), ctxWith(), deps({}, { stopGuardVerdict: () => { throw new Error('bug') } }))).toEqual(QUIET)
    })
  })

  test('H11: in the planning phase the registered plan file is read and validated for the verdict', async () => {
    await withSandbox(async sb => {
      const plan = join(sb.root, 'docs', 'plans', '2026-10-08-x.md')
      bindPlan('plan', plan)
      const checks: unknown[] = []
      const verdict = (reason: string): HookCore['stopGuardVerdict'] => (s, _i, _c, check) => {
        checks.push(check)
        return { decision: { action: 'block', reason, hook: 'H11' }, next: s, why: 'plan-invalid' }
      }
      const missing = await claudeHook('Stop', fixture('stop.json'), ctxWith(), deps({}, { stopGuardVerdict: verdict('write the plan') }))
      expect(json(missing.stdout)).toEqual(feedback('write the plan'))
      expect(checks).toEqual([{ exists: false, findings: [] }])

      mkdirSync(join(plan, '..'), { recursive: true })
      writeFileSync(plan, '# plan\n')
      const findings = [{ level: 'error' as const, code: 'x', message: 'bad' }]
      const texts: string[] = []
      await claudeHook('Stop', fixture('stop.json'), ctxWith(), deps({}, {
        validatePlan: text => { texts.push(text); return findings },
        stopGuardVerdict: verdict('fix the plan'),
      }))
      expect(texts).toEqual(['# plan\n'])
      expect(checks[1]).toEqual({ exists: true, findings, text: '# plan\n' })
    })
  })

  test('a runaway cap that ends a chain of blocks is announced to the user once', async () => {
    await withSandbox(async () => {
      const cfg = defaultConfig()
      saveState('claude', SID, { ...freshState(), guard: { blocksForPlan: 30, blocksInChain: 2, lastBlockAt: NOW - 5000 }, plan: { path: PLAN, slug: 'p', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 1000 } })
      const release: HookCore['stopGuardVerdict'] = s => ({ decision: { action: 'allow' }, next: { ...s, guard: { ...s.guard, blocksInChain: 0 } }, why: 'runaway-plan' })
      const first = await claudeHook('Stop', fixture('stop.json', { stop_hook_active: true }), ctxWith(cfg), deps({}, { stopGuardVerdict: release }))
      expect(json(first.stdout)).toEqual({ systemMessage: runawayNotice('runaway-plan', cfg.plan) })
      expect(await claudeHook('Stop', fixture('stop.json'), ctxWith(cfg), deps({}, { stopGuardVerdict: release }))).toEqual(QUIET)
      expect(runawayNotice('runaway-chain', cfg.plan)).toContain(String(cfg.plan.runaway.perChain))
      expect(runawayNotice('blocked', cfg.plan)).toBeUndefined()
    })
  })
})

describe('PreCompact (H06) and SessionStart compact (H07)', () => {
  const note = { slug: '2026-10-08-handoff-x', markdown: '---\ntype: handoff\n---\n# Handoff\n' }

  const writer = (inputs: unknown[], id = 'handoff-2026-10-08-handoff-x') => ({ writeHandoff: async (i: unknown) => { inputs.push(i); return { id, path: id, rel: id, title: 'Handoff' } } })

  test('the handoff goes to the memory module, its id is recorded and offered after compaction', async () => {
    await withSandbox(async () => {
      const inputs: unknown[] = []
      let noteInput: Record<string, unknown> | undefined
      const d = deps({ importModule: async n => (n === 'handoff' ? writer(inputs) : undefined) }, { handoffNote: i => { noteInput = i as unknown as Record<string, unknown>; return note } })
      expect(await claudeHook('PreCompact', fixture('precompact.json'), ctxWith(), d)).toEqual(QUIET)
      expect(inputs).toEqual([{ harness: 'claude', sessionId: SID, cwd: '/tmp/project', project: 'demo', branch: 'main', slug: note.slug, markdown: note.markdown, trigger: 'auto', now: NOW }])
      expect(noteInput).toMatchObject({ project: 'demo', harness: 'claude', sessionId: SID, branch: 'main', now: NOW, state: freshState() })
      expect(JSON.parse(readFileSync(handoffRecordPath(SID), 'utf8'))).toEqual({ path: 'handoff-2026-10-08-handoff-x', at: NOW })

      let restoreArgs: unknown[] = []
      const r = await claudeHook('SessionStart', fixture('sessionstart-compact.json'), ctxWith(), deps({}, {
        restoreContext: (s, h) => { restoreArgs = [s, h]; return 'Active plan: none. Handoff: see the memory.' },
      }))
      expect(json(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Active plan: none. Handoff: see the memory.' } })
      expect(restoreArgs).toEqual([freshState(), 'handoff-2026-10-08-handoff-x'])

      await claudeHook('SessionStart', fixture('sessionstart-compact.json'), ctxWith(), deps({ now: () => NOW + 25 * 3600_000 }, {
        restoreContext: (s, h) => { restoreArgs = [s, h]; return undefined },
      }))
      expect(restoreArgs).toEqual([freshState(), undefined])
    })
  })

  test('a record from an older Buracle (a vault file path) is never offered as a handoff id', async () => {
    await withSandbox(async () => {
      mkdirSync(join(handoffRecordPath(SID), '..'), { recursive: true })
      writeFileSync(handoffRecordPath(SID), JSON.stringify({ path: '/home/u/Documents/Buracle/projects/demo/handoffs/h.md', at: NOW }))
      let handoff: unknown = 'unset'
      await claudeHook('SessionStart', fixture('sessionstart-compact.json'), ctxWith(), deps({}, { restoreContext: (_s, h) => { handoff = h; return undefined } }))
      expect(handoff).toBeUndefined()
    })
  })

  test('without the memory module only the compaction time is recorded; BURACLE_NO_MEMORY skips it all', async () => {
    await withSandbox(async sb => {
      await claudeHook('PreCompact', fixture('precompact.json'), ctxWith(), deps({}, { handoffNote: () => note }))
      expect(existsSync(join(sb.home, 'Documents'))).toBe(false)
      expect(JSON.parse(readFileSync(handoffRecordPath(SID), 'utf8'))).toEqual({ at: NOW })

      const inputs: unknown[] = []
      await claudeHook('PreCompact', fixture('precompact.json'), ctxWith(), deps({ env: n => (n === 'BURACLE_NO_MEMORY' ? '1' : undefined), importModule: async n => (n === 'handoff' ? writer(inputs) : undefined) }))
      expect(inputs).toEqual([])
      expect(existsSync(handoffRecordPath(SID))).toBe(false)
    })
  })

  test('without a handoff record the session asks the memory module for its own latest handoff, never another session\'s', async () => {
    await withSandbox(async () => {
      const asked: unknown[] = []
      const mem = { latestHandoff: async (o: unknown) => { asked.push(o); return { id: 'handoff-demo-latest', path: 'handoff-demo-latest', rel: 'handoff-demo-latest', title: 'h' } } }
      let handoff: unknown
      const r = await claudeHook('SessionStart', fixture('sessionstart-compact.json'), ctxWith(), deps({ importModule: async n => (n === 'handoff' ? mem : undefined) }, {
        restoreContext: (_s, h) => { handoff = h; return 'See the handoff.' },
      }))
      expect(json(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'See the handoff.' } })
      expect(handoff).toBe('handoff-demo-latest')
      expect(asked).toEqual([{ project: 'demo', branch: 'main', nowMs: NOW, session: SID }])
    })
  })

  test('when no handoff memory could be written, the open todos are kept in the session record and inlined after compaction', async () => {
    await withSandbox(async () => {
      await claudeHook('PostToolUse', fixture('precompact.json', { hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'write the parser', status: 'in_progress' }, { content: 'old', status: 'completed' }] }, tool_response: {} }), ctxWith(), deps())
      const failing = { writeHandoff: async () => undefined }
      await claudeHook('PreCompact', fixture('precompact.json'), ctxWith(), deps({ importModule: async n => (n === 'handoff' ? failing : undefined) }, { handoffNote: () => note }))
      expect(JSON.parse(readFileSync(handoffRecordPath(SID), 'utf8'))).toEqual({ todo: ['write the parser'], at: NOW })
      const asked: unknown[] = []
      const mem = { latestHandoff: async (o: unknown) => { asked.push(o); return undefined } }
      const r = await claudeHook('SessionStart', fixture('sessionstart-compact.json'), ctxWith(), deps({ importModule: async n => (n === 'handoff' ? mem : undefined) }, { restoreContext: defaultHookDeps.core.restoreContext }))
      const text = (json(r.stdout)['hookSpecificOutput'] as { additionalContext: string }).additionalContext
      expect(text).toContain('Open todos at compaction time (no handoff memory was written):\n- write the parser')
      expect(asked).toEqual([])
    })
  })

  test('a later compaction with no handoff and no open todos replaces the earlier record, and the restore offers no older handoff of the session', async () => {
    await withSandbox(async () => {
      const failing = { writeHandoff: async () => undefined }
      const todos = (status: string) => fixture('precompact.json', { hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'write the parser', status }] }, tool_response: {} })
      await claudeHook('PostToolUse', todos('in_progress'), ctxWith(), deps())
      await claudeHook('PreCompact', fixture('precompact.json'), ctxWith(), deps({ importModule: async n => (n === 'handoff' ? failing : undefined) }, { handoffNote: () => note }))
      expect(JSON.parse(readFileSync(handoffRecordPath(SID), 'utf8'))).toEqual({ todo: ['write the parser'], at: NOW })
      await claudeHook('PostToolUse', todos('completed'), ctxWith(), deps())
      await claudeHook('PreCompact', fixture('precompact.json'), ctxWith(), deps({ importModule: async n => (n === 'handoff' ? failing : undefined) }, { handoffNote: () => note }))
      expect(JSON.parse(readFileSync(handoffRecordPath(SID), 'utf8'))).toEqual({ at: NOW })
      const asked: unknown[] = []
      const mem = { latestHandoff: async (o: unknown) => { asked.push(o); return { id: 'handoff-earlier-compaction', path: 'handoff-earlier-compaction', rel: 'handoff-earlier-compaction', title: 'h' } } }
      const r = await claudeHook('SessionStart', fixture('sessionstart-compact.json'), ctxWith(), deps({ importModule: async n => (n === 'handoff' ? mem : undefined) }, { restoreContext: defaultHookDeps.core.restoreContext }))
      expect(r.stdout).not.toContain('Open todos')
      expect(r.stdout).not.toContain('write the parser')
      expect(r.stdout).not.toContain('handoff-earlier-compaction')
      expect(asked).toEqual([])
    })
  })

  test('the record is replaced before the handoff is written, so a hook killed during the write leaves this compaction\'s todos', async () => {
    await withSandbox(async () => {
      mkdirSync(join(handoffRecordPath(SID), '..'), { recursive: true })
      writeFileSync(handoffRecordPath(SID), JSON.stringify({ path: 'handoff-earlier-compaction', at: NOW - 1000 }))
      await claudeHook('PostToolUse', fixture('precompact.json', { hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'write the parser', status: 'in_progress' }] }, tool_response: {} }), ctxWith(), deps())
      const during: unknown[] = []
      const slow = { writeHandoff: async () => { during.push(JSON.parse(readFileSync(handoffRecordPath(SID), 'utf8'))); return { id: 'handoff-now', path: 'handoff-now', rel: 'handoff-now', title: 'h' } } }
      await claudeHook('PreCompact', fixture('precompact.json'), ctxWith(), deps({ importModule: async n => (n === 'handoff' ? slow : undefined) }, { handoffNote: () => note }))
      expect(during).toEqual([{ todo: ['write the parser'], at: NOW }])
      expect(JSON.parse(readFileSync(handoffRecordPath(SID), 'utf8'))).toEqual({ path: 'handoff-now', at: NOW })
    })
  })

  test('SessionStart only acts on compact and only with something to say', async () => {
    await withSandbox(async () => {
      expect(await claudeHook('SessionStart', fixture('sessionstart-compact.json', { source: 'startup' }), ctxWith(), deps())).toEqual(QUIET)
      expect(await claudeHook('SessionStart', fixture('sessionstart-compact.json'), ctxWith(), deps({}, { restoreContext: () => undefined }))).toEqual(QUIET)
      expect(await claudeHook('SessionStart', fixture('sessionstart-compact.json'), ctxWith(), deps({}, { restoreContext: () => { throw new Error('x') } }))).toEqual(QUIET)
    })
  })
})

describe('SubagentStop: H19 review gate', () => {
  test('an invalid review report sends the reviewer a note; a valid one passes', async () => {
    await withSandbox(async () => {
      const seen: unknown[] = []
      const bad = await claudeHook('SubagentStop', fixture('subagentstop.json'), ctxWith(), deps({}, {
        validateReviewJson: (text, opts) => { seen.push(text, opts); return { ok: false, errors: ['not JSON', 'summary missing'] } },
      }))
      expect(json(bad.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: reviewNote('buracle:plan-build-review', ['not JSON', 'summary missing']) } })
      expect(reviewNote('buracle:plan-build-review', ['not JSON'])).toContain('your final message')
      expect(seen).toEqual(['The plan looks good to me.', { agent: 'buracle:plan-build-review' }])
      const good = await claudeHook('SubagentStop', fixture('subagentstop.json'), ctxWith(), deps({}, { validateReviewJson: () => ({ ok: true, errors: [] }) }))
      expect(good).toEqual(QUIET)
    })
  })

  test('other agents, a continued stop and a failing validator are left alone', async () => {
    await withSandbox(async () => {
      const d = deps()
      expect(await claudeHook('SubagentStop', fixture('subagentstop.json', { agent_type: 'general-purpose' }), ctxWith(), d)).toEqual(QUIET)
      expect(await claudeHook('SubagentStop', fixture('subagentstop.json', { agent_type: 'Explore' }), ctxWith(), d)).toEqual(QUIET)
      expect(await claudeHook('SubagentStop', fixture('subagentstop.json', { stop_hook_active: true }), ctxWith(), d)).toEqual(QUIET)
      expect(await claudeHook('SubagentStop', fixture('subagentstop.json'), ctxWith(), deps({}, { validateReviewJson: () => { throw new Error('x') } }))).toEqual(QUIET)
    })
  })
})

describe('PreToolUse SubagentHandback: H19 in auto mode', () => {
  const bad = (): Partial<HookCore> => ({ validateReviewJson: () => ({ ok: false, errors: ['not JSON'] }) })
  const out = (stdout: string): Record<string, any> => json(stdout) as Record<string, any>

  test('an invalid hand-back is denied once with the reason, the next one only warns, and SubagentStop then leaves that reviewer alone', async () => {
    await withSandbox(async () => {
      const first = out((await claudeHook('PreToolUse', fixture('pretooluse-handback.json'), ctxWith(), deps({}, bad()))).stdout)
      expect(first['hookSpecificOutput']).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
      expect(first['hookSpecificOutput']['permissionDecisionReason']).toContain('Call SubagentHandback again')
      expect(first['hookSpecificOutput']['permissionDecisionReason']).toContain('not JSON')
      const stopBefore = await claudeHook('SubagentStop', fixture('subagentstop.json', { last_assistant_message: '' }), ctxWith(), deps({}, bad()))
      expect(out(stopBefore.stdout)['hookSpecificOutput']['hookEventName']).toBe('SubagentStop')
      const second = out((await claudeHook('PreToolUse', fixture('pretooluse-handback.json'), ctxWith(), deps({}, bad()))).stdout)
      expect(second['hookSpecificOutput']).toBeUndefined()
      expect(second['systemMessage']).toContain('invalid review report again')
      expect(await claudeHook('SubagentStop', fixture('subagentstop.json', { last_assistant_message: '' }), ctxWith(), deps({}, bad()))).toEqual(QUIET)
      expect(out((await claudeHook('SubagentStop', fixture('subagentstop.json', { agent_id: 'other' }), ctxWith(), deps({}, bad()))).stdout)['hookSpecificOutput']['hookEventName']).toBe('SubagentStop')
    })
  })

  test('a valid hand-back passes the report (not the closing text) to the validator; other agents and a failing validator are left alone', async () => {
    await withSandbox(async () => {
      const seen: unknown[] = []
      const ok = await claudeHook('PreToolUse', fixture('pretooluse-handback.json', { tool_input: { message: '{"verdict":"pass"}' } }), ctxWith(), deps({}, {
        validateReviewJson: (text, opts) => { seen.push(text, opts); return { ok: true, errors: [] } },
      }))
      expect(ok).toEqual(QUIET)
      expect(seen).toEqual(['{"verdict":"pass"}', { agent: 'buracle:plan-build-review' }])
      expect(await claudeHook('SubagentStop', fixture('subagentstop.json', { last_assistant_message: 'Done.' }), ctxWith(), deps({}, bad()))).toEqual(QUIET)
      expect(await claudeHook('PreToolUse', fixture('pretooluse-handback.json', { agent_type: 'general-purpose' }), ctxWith(), deps())).toEqual(QUIET)
      expect(await claudeHook('PreToolUse', fixture('pretooluse-handback.json', { agent_id: 'z9' }), ctxWith(), deps({}, { validateReviewJson: () => { throw new Error('x') } }))).toEqual(QUIET)
    })
  })
})

describe('PreToolUse Bash: reviewers stay read-only (H01)', () => {
  const reviewer = (command: string, agent = 'buracle:changes-review') => claudeHook('PreToolUse', fixture('pretooluse-bash.json', { agent_id: 'r1', agent_type: agent, tool_input: { command } }), ctxWith(), deps({}, { checkBash: () => ({}), routeTool: () => ({ action: 'allow' }) }))
  const reason = (r: { stdout: string }): string => (r.stdout === '' ? '' : String((json(r.stdout) as Record<string, any>)['hookSpecificOutput']?.['permissionDecisionReason'] ?? ''))

  test('a reviewer\'s git commit, sed -i, git stash and redirect are denied; git diff and rg pass; another agent is not affected', async () => {
    await withSandbox(async () => {
      for (const command of ['git commit -am x', "sed -i 's/a/b/' src/app.ts", 'git stash', 'git diff > out.patch']) {
        expect({ command, reason: reason(await reviewer(command)) }).toEqual({ command, reason: expect.stringContaining('is a read-only reviewer') })
      }
      for (const command of ['git diff HEAD~1', 'rg -n foo src']) expect({ command, reason: reason(await reviewer(command)) }).toEqual({ command, reason: '' })
      expect(reason(await reviewer('git commit -am x', 'general-purpose'))).toBe('')
    })
  })
})

describe('PostCompact: H14 compaction summary', () => {
  test('the summary becomes one compact spool entry in the fallback file', async () => {
    await withSandbox(async () => {
      const appended: unknown[][] = []
      const spool = { appendSpool: (...a: unknown[]) => { appended.push(a) } }
      const r = await claudeHook('PostCompact', fixture('postcompact.json'), ctxWith(), deps({ importModule: async n => (n === 'spool' ? spool : undefined) }))
      expect(r).toEqual(QUIET)
      expect(appended).toEqual([['claude', SID, [{ ts: NOW, ev: 'compact', excerpt: 'The user asked for a login page; tasks 1-2 of docs/plans/2026-10-08-login.md are done.' }], { suffix: FALLBACK_SPOOL_SUFFIX }]])
    })
  })

  test('BURACLE_NO_CAPTURE, an empty summary or a missing module write nothing', async () => {
    await withSandbox(async () => {
      const appended: unknown[] = []
      const spool = { appendSpool: (...a: unknown[]) => { appended.push(a) } }
      const withSpool = async (n: string) => (n === 'spool' ? spool : undefined)
      expect(await claudeHook('PostCompact', fixture('postcompact.json'), ctxWith(), deps({ importModule: withSpool, env: n => (n === 'BURACLE_NO_CAPTURE' ? '1' : undefined) }))).toEqual(QUIET)
      expect(await claudeHook('PostCompact', fixture('postcompact.json', { compact_summary: '  ' }), ctxWith(), deps({ importModule: withSpool }))).toEqual(QUIET)
      expect(await claudeHook('PostCompact', fixture('postcompact.json'), ctxWith(), deps())).toEqual(QUIET)
      expect(appended).toEqual([])
    })
  })
})

describe('SessionEnd', () => {
  test('always detaches the finalizer and runs session maintenance; failures are harmless', async () => {
    await withSandbox(async () => {
      const calls: unknown[][] = []
      const maint: unknown[][] = []
      const r = await claudeHook('SessionEnd', fixture('sessionend.json'), ctxWith(), deps({
        importModule: async n => (n === 'finalize' ? { spawnFinalizer: async (...a: unknown[]) => { calls.push(a) } } : undefined),
        sessionMaint: (...a: unknown[]) => { maint.push(a) },
      }))
      expect(r).toEqual(QUIET)
      expect(calls).toEqual([['claude', SID]])
      expect(maint).toEqual([[NOW, [SID]]])
      expect(await claudeHook('SessionEnd', fixture('sessionend.json'), ctxWith(), deps())).toEqual(QUIET)
      expect(await claudeHook('SessionEnd', fixture('sessionend.json'), ctxWith(), deps({
        importModule: async () => ({ spawnFinalizer: () => { throw new Error('x') } }),
        sessionMaint: () => { throw new Error('y') },
      }))).toEqual(QUIET)
    })
  })

  test('BURACLE_NO_CAPTURE: no finalizer, but session maintenance still runs', async () => {
    await withSandbox(async () => {
      const calls: unknown[] = []
      const maint: unknown[] = []
      await claudeHook('SessionEnd', fixture('sessionend.json'), ctxWith(), deps({
        env: n => (n === 'BURACLE_NO_CAPTURE' ? '1' : undefined),
        importModule: async () => ({ spawnFinalizer: (...a: unknown[]) => { calls.push(a) } }),
        sessionMaint: (...a: unknown[]) => { maint.push(a) },
      }))
      expect(calls).toEqual([])
      expect(maint).toHaveLength(1)
    })
  })

  test('H16 through the default deps prunes sessions idle for more than 14 days, never the ending one', async () => {
    await withSandbox(async () => {
      const old = 'sess-old-1'
      saveState('claude', old, freshState())
      saveState('claude', SID, freshState())
      const longAgo = (NOW - 20 * 24 * 3600_000) / 1000
      for (const sid of [old, SID]) {
        utimesSync(statePath('claude', sid), longAgo, longAgo)
        utimesSync(paths.sessionDir('claude', sid), longAgo, longAgo)
      }
      await claudeHook('SessionEnd', fixture('sessionend.json'), ctxWith(), { ...defaultHookDeps, now: () => NOW, env: n => (n === 'BURACLE_NO_CAPTURE' ? '1' : undefined) })
      expect(existsSync(paths.sessionDir('claude', old))).toBe(false)
      expect(existsSync(paths.sessionDir('claude', SID))).toBe(true)
    })
  })

  test('through the real CLI shim path it exits 0, prints nothing and returns fast', async () => {
    await withSandbox(async () => {
      const main = join(paths.repoRoot(), 'src', 'cli', 'main.ts')
      await withEnv({ BURACLE_NO_MEMORY: '1' }, async () => {
        const t0 = Date.now()
        const r = await run([process.execPath, main, 'hook', 'claude', 'SessionEnd'], { stdin: fixture('sessionend.json', { session_id: 'sess-cli-end' }), timeoutMs: 10_000 })
        const ms = Date.now() - t0
        expect(r.code).toBe(0)
        expect(r.stdout).toBe('')
        expect(ms).toBeLessThan(1500)
      })
    })
  }, 20_000)
})

describe('with the real core and memory modules', () => {
  test('rm -rf / is denied by H01', async () => {
    await withSandbox(async () => {
      const r = await claudeHook('PreToolUse', fixture('pretooluse-bash.json'), ctxWith(), { ...defaultHookDeps, now: () => NOW })
      expect((json(r.stdout)['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision']).toBe('deny')
    })
  })

  test('an approved plan in implement phase keeps the session going (H08), and the counters move', async () => {
    await withSandbox(async sb => {
      const plan = join(sb.root, 'p.md')
      writeFileSync(plan, '# p\n')
      saveState('claude', SID, { ...freshState(), plan: { path: plan, slug: 'p', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 1000 } })
      const r = await claudeHook('Stop', fixture('stop.json', { cwd: sb.root }), ctxWith(), { ...defaultHookDeps, now: () => NOW })
      const out = feedbackOf(r.stdout)
      expect(json(r.stdout)['decision']).toBeUndefined()
      expect(out).toStartWith('Buracle stop guard:')
      expect(out).toContain(STOP_GUARD_ESCAPE)
      const saved = JSON.parse(readFileSync(statePath('claude', SID), 'utf8')) as { guard: Record<string, number> }
      expect(saved.guard).toMatchObject({ blocksForPlan: 1, blocksInChain: 1, lastBlockAt: NOW })
    })
  })

  test('a planning phase with a missing plan file is held by H11 with the plan-check marker', async () => {
    await withSandbox(async sb => {
      saveState('claude', SID, { ...freshState(), plan: { path: join(sb.root, 'docs', 'plans', 'missing.md'), slug: 'missing', status: 'APPROVED', type: 'Feature', phase: 'plan', registeredAt: NOW - 1000 } })
      const r = await claudeHook('Stop', fixture('stop.json', { cwd: sb.root }), ctxWith(), { ...defaultHookDeps, now: () => NOW })
      expect(feedbackOf(r.stdout)).toStartWith('Buracle plan check:')
    })
  })

  test('H19 with the real validator: free text is refused, a valid report passes', async () => {
    await withSandbox(async () => {
      const bad = await claudeHook('SubagentStop', fixture('subagentstop.json'), ctxWith(), { ...defaultHookDeps, now: () => NOW })
      expect(String((json(bad.stdout)['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'])).toContain('Buracle H19')
      const review = { verdict: 'pass', summary: 'docs/plans/2026-10-08-login.md: the plan covers the request', findings: [] }
      const good = await claudeHook('SubagentStop', fixture('subagentstop.json', { last_assistant_message: JSON.stringify(review) }), ctxWith(), { ...defaultHookDeps, now: () => NOW })
      expect(good).toEqual(QUIET)
    })
  })

  test('PostCompact writes the redacted summary through appendSpool (capture on)', async () => {
    await withSandbox(async () => {
      await withEnv({ BURACLE_NO_CAPTURE: undefined, BURACLE_NO_MEMORY: undefined }, async () => {
        const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
        await claudeHook('PostCompact', fixture('postcompact.json', { compact_summary: `Summary. token ${secret}` }), ctxWith(), { ...defaultHookDeps, now: () => NOW })
        const file = join(paths.memoryStateDir(), 'spool', `claude-${SID}-${FALLBACK_SPOOL_SUFFIX}.jsonl`)
        const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({ ts: NOW, ev: 'compact' })
        expect(String(lines[0]?.['excerpt'])).toStartWith('Summary. token ')
        expect(String(lines[0]?.['excerpt'])).not.toContain(secret)
      })
    })
  })

  test('PostCompact under the run-wide BURACLE_NO_CAPTURE writes no spool file', async () => {
    await withSandbox(async () => {
      await withEnv({ BURACLE_NO_CAPTURE: '1' }, async () => {
        await claudeHook('PostCompact', fixture('postcompact.json'), ctxWith(), { ...defaultHookDeps, now: () => NOW })
        expect(existsSync(join(paths.memoryStateDir(), 'spool'))).toBe(false)
      })
    })
  })
})

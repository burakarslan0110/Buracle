import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { applyPlans } from '../../../src/engine/txn'
import type { RunResult } from '../../../src/engine/proc'
import type { AdapterContext } from '../../../src/adapters/registry'
import { adapter } from '../../../src/adapters/codex/index'
import { installTestHooks } from '../../../src/adapters/codex/install'
import { BYPASS_APPROVAL_POLICY } from '../../../src/adapters/codex/config'
import { codexDoctor, compareVersions, configLoadCheck, effortCheck, featureEnabled, guardProbe, hookCommandProblems, hookTrustReport, mcpCommandProblems, permissionCheck, PROBE_COMMAND, routingCheck, TESTED_CODEX, type DoctorDeps, type DoctorItem } from '../../../src/adapters/codex/doctor'
import { run as runProcess } from '../../../src/engine/proc'
import { HOOK_COMMAND_PREFIX, hookCommand, windowsHookPrefix } from '../../../src/adapters/codex/hooks-config'
import { buracleHooksFile, findBuracleHandlers } from '../../../src/adapters/codex/hooks-config'
import { pathRuleFiles } from '../../../src/adapters/shared/rules'
import { pathToFileURL } from 'node:url'
import { fakeExe } from '../../helpers/fake-exe'
import { withSandbox } from '../../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..', '..')
const canonical: CanonicalBundle = loadCanonicalSync(join(REPO, 'canonical'))
const ctx = (): AdapterContext => ({ repoRoot: REPO, config: defaultConfig(), canonical, paths, buracleBin: paths.shimPath() })

beforeEach(() => { installTestHooks.codexPids = async () => [] })
afterEach(() => { delete installTestHooks.codexPids })

const FEATURES = 'apps                                     stable             true\nhooks                                    stable             true\nmemories                                 stable             false\n'
const mcpList = (names: string[]) => JSON.stringify(names.map(name => ({ name, enabled: true, transport: { type: 'stdio', command: 'npx' } })))
const codexServers = Object.keys(canonical.mcp.servers).filter(id => canonical.mcp.servers[id]?.harnesses.includes('codex'))

const doctorJson = (load: Record<string, unknown> = { status: 'ok', summary: 'config loaded', details: { 'startup warnings': '0' } }) => JSON.stringify({ schemaVersion: 1, overallStatus: 'fail', checks: { 'config.load': { id: 'config.load', ...load }, 'auth.credentials': { status: 'fail' } } })

function fake(over: { version?: string, installed?: boolean, features?: string, mcp?: string, doctor?: string, env?: Record<string, string | undefined> } = {}, seen: string[][] = []): DoctorDeps {
  const res = (stdout: string, code = 0): RunResult => ({ code, stdout, stderr: '', timedOut: false })
  return {
    ...(over.env !== undefined ? { env: () => over.env as Record<string, string | undefined> } : {}),
    detect: async () => (over.installed === false ? { installed: false } : { installed: true, version: over.version ?? '0.161.0', path: '/opt/homebrew/bin/codex' }),
    run: async argv => {
      seen.push(argv)
      if (argv[1] === 'doctor') return res(over.doctor ?? doctorJson(), 1)
      return res(argv.includes('features') ? over.features ?? FEATURES : over.mcp ?? mcpList(codexServers))
    },
  }
}

const by = (items: DoctorItem[], check: string) => items.filter(i => i.check === check)

describe('codex doctor', () => {
  test('version ranges', async () => {
    expect(compareVersions('0.161.0', '0.154.0')).toBe(1)
    expect(compareVersions('0.154.0', '0.154.0')).toBe(0)
    expect(compareVersions('0.99.9', '0.154.0')).toBe(-1)
    await withSandbox(async () => {
      expect(by(await codexDoctor(ctx(), fake({ version: '0.150.0' })), 'codex.version')[0]?.level).toBe('error')
      const newer = TESTED_CODEX.replace(/\d+$/, p => String(Number(p) + 1))
      expect(by(await codexDoctor(ctx(), fake({ version: newer })), 'codex.version')[0]?.level).toBe('warn')
      expect(by(await codexDoctor(ctx(), fake()), 'codex.version')[0]?.level).toBe('ok')
      expect(by(await codexDoctor(ctx(), fake({ installed: false })), 'codex.version')[0]?.level).toBe('error')
    })
  })

  test('host limits (PARITY-10) and the workflow view (PARITY-9): listed on the checked version, flagged for a re-probe on a newer one; the tmux line is named', () => withSandbox(async () => {
    const limits = () => by(items, 'codex.limits')[0]
    let items = await codexDoctor(ctx(), fake({ version: '0.162.1' }))
    expect(limits()).toMatchObject({ level: 'ok' })
    expect(limits()?.detail).toContain('commands-without-turn')
    expect(by(items, 'codex.workflow-view')[0]?.detail).toContain('`buracle statusline codex`')
    items = await codexDoctor(ctx(), fake({ version: '0.163.0' }))
    expect(limits()?.level).toBe('warn')
    expect(limits()?.detail).toContain('bun test tests/adapters/codex/smoke.test.ts -t "host limits"')
  }))

  test('before install: hooks, AGENTS.md block and MCP servers are reported missing', () => withSandbox(async () => {
    const items = await codexDoctor(ctx(), fake({ mcp: '[]' }))
    expect(by(items, 'codex.hooks')[0]?.level).toBe('error')
    expect(by(items, 'codex.agents_md')[0]?.level).toBe('error')
    expect(by(items, 'codex.mcp')[0]?.level).toBe('error')
    expect(by(items, 'codex.features')[0]?.level).toBe('ok')
  }))

  test('after install: everything ok except hook trust, which lists what to approve in /hooks', () => withSandbox(async ({ home }) => {
    await applyPlans([await adapter.installPlan(ctx())])
    const items = await codexDoctor(ctx(), fake())
    for (const c of ['codex.version', 'codex.hooks', 'codex.features', 'codex.mcp', 'codex.agents_md', 'codex.agents', 'codex.rules']) {
      expect({ c, level: by(items, c)[0]?.level }).toEqual({ c, level: 'ok' })
    }
    const trust = by(items, 'codex.hooks.trust')
    expect(trust[0]?.level).toBe('warn')
    expect(trust[0]?.detail).toContain('/hooks')
    expect(trust[0]?.detail).toContain('PreToolUse#0')
    const hooksPath = join(home, '.codex', 'hooks.json')
    const found = findBuracleHandlers(JSON.parse(readFileSync(hooksPath, 'utf8')), hooksPath)
    const state = found.map(h => `[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = ${JSON.stringify(h.hash)}\n`).join('\n')
    writeFileSync(join(home, '.codex', 'config.toml'), readFileSync(join(home, '.codex', 'config.toml'), 'utf8') + '\n' + state)
    const after = by(await codexDoctor(ctx(), fake()), 'codex.hooks.trust')
    expect(after).toEqual([{ level: 'ok', check: 'codex.hooks.trust', detail: `${found.length} Buracle hook(s) trusted` }])
  }))

  test('guard probe: the PreToolUse hook command, run through a shell, must deny a destructive command', () => withSandbox(async ({ home }) => {
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'H01' } })
    const seen: Array<{ argv: string[], stdin: string }> = []
    const fake = async (argv: string[], opts?: { stdin?: string | Uint8Array }) => { seen.push({ argv, stdin: String(opts?.stdin) }); return { code: 0, stdout: deny, stderr: '', timedOut: false } }
    const ok = await guardProbe('x hook codex PreToolUse', fake, home, 'linux')
    expect(ok.level).toBe('ok')
    expect(seen[0]?.argv).toEqual(['/bin/sh', '-c', 'x hook codex PreToolUse'])
    expect(seen[0]?.stdin).toContain(PROBE_COMMAND)
    expect((await guardProbe('"C:\\b\\buracle.cmd" hook codex PreToolUse', fake, home, 'win32')).level).toBe('ok')
    expect(seen[1]?.argv).toEqual(['cmd.exe', '/d', '/s', '/c', '""C:\\b\\buracle.cmd" hook codex PreToolUse"'])
    expect((await guardProbe('x', async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }), home)).level).toBe('error')
    // A shim that runs this checkout's CLI with the hook's arguments (buracle.cmd on Windows).
    const router = pathToFileURL(join(REPO, 'src', 'cli', 'router.ts')).href
    expect(fakeExe(join(paths.binDir(), 'buracle'), `const { runProcess } = await import(${JSON.stringify(router)})\nprocess.exit(await runProcess(argv))`)).toBe(paths.shimPath())
    const prefix = process.platform === 'win32' ? windowsHookPrefix(paths.shimPath()) : HOOK_COMMAND_PREFIX
    const real = await guardProbe(hookCommand('PreToolUse', prefix), (argv, opts) => runProcess(argv, opts ?? {}), home)
    expect(real).toEqual({ level: 'ok', check: 'codex.hooks.probe', detail: expect.stringContaining('denies') })
  }), 60_000)

  test('trust report: untrusted, modified and disabled hooks', () => {
    const hooks = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: '"$HOME/.buracle/bin/buracle" hook codex Stop', timeout: 20 }] }], SessionEnd: [{ hooks: [{ type: 'command', command: '"$HOME/.buracle/bin/buracle" hook codex SessionEnd', timeout: 3 }] }] } })
    expect(hookTrustReport('/h/hooks.json', hooks, undefined)).toEqual({ trusted: [], untrusted: ['Stop#0', 'SessionEnd#0'], modified: [], disabled: [] })
    const cfg = '[hooks.state."/h/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:old"\n[hooks.state."/h/hooks.json:session_end:0:0"]\nenabled = false\n'
    expect(hookTrustReport('/h/hooks.json', hooks, cfg)).toEqual({ trusted: [], untrusted: [], modified: ['Stop#0'], disabled: ['SessionEnd#0'] })
  })

  test('feature listing parse; hooks off is an error; native memories on is a warning', () => withSandbox(async () => {
    expect(featureEnabled(FEATURES, 'hooks')).toBe(true)
    expect(featureEnabled(FEATURES, 'memories')).toBe(false)
    expect(featureEnabled(FEATURES, 'nope')).toBeUndefined()
    const items = await codexDoctor(ctx(), fake({ features: 'hooks  stable  false\nmemories  stable  true\n' }))
    expect(by(items, 'codex.features')[0]?.level).toBe('error')
    expect(by(items, 'codex.memories')[0]?.level).toBe('warn')
  }))

  test('path rules the AGENTS.md block indexes: missing until the core plan wrote them', () => withSandbox(async ({ buracleHome }) => {
    await applyPlans([await adapter.installPlan(ctx())])
    const missing = by(await codexDoctor(ctx(), fake()), 'codex.path_rules')
    expect(missing[0]?.level).toBe('warn')
    expect(missing[0]?.detail).toContain('go.md')
    mkdirSync(join(buracleHome, 'rules', 'paths'), { recursive: true })
    for (const r of pathRuleFiles(canonical)) writeFileSync(join(buracleHome, 'rules', 'paths', r.file), r.content)
    expect(by(await codexDoctor(ctx(), fake()), 'codex.path_rules')).toEqual([{ level: 'ok', check: 'codex.path_rules', detail: 'path rules present' }])
  }))

  test('a Buracle handler registered twice is a warning (it would run twice)', () => withSandbox(async ({ home }) => {
    mkdirSync(join(home, '.codex'), { recursive: true })
    const ours = buracleHooksFile().hooks
    const copy = { hooks: [{ type: 'command', command: '/Users/x/.buracle/bin/buracle hook codex Stop', timeout: 20 }] }
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { ...ours, Stop: [copy, ...(ours.Stop ?? [])] } }))
    const hooks = by(await codexDoctor(ctx(), fake()), 'codex.hooks')
    expect(hooks.map(i => i.level)).toEqual(['ok', 'warn'])
    expect(hooks[1]?.detail).toContain('Stop#1')
  }))

  test('a non-empty AGENTS.override.md hides the block', () => withSandbox(async ({ home }) => {
    await applyPlans([await adapter.installPlan(ctx())])
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'AGENTS.override.md'), '# override\n')
    expect(by(await codexDoctor(ctx(), fake()), 'codex.agents_md')[0]?.level).toBe('warn')
  }))

  test('I8 / SEC-10: every hook command must reach an executable; a hard-coded $HOME path under a custom BURACLE_HOME is an error', () => withSandbox(async ({ root, home }) => {
    const custom = join(root, 'custom-buracle')
    const shim = join(custom, 'bin', 'buracle')
    mkdirSync(join(custom, 'bin'), { recursive: true })
    writeFileSync(shim, '#!/bin/sh\nexit 0\n')
    chmodSync(shim, 0o755)
    const env = { HOME: home, BURACLE_HOME: custom, PATH: process.env['PATH'] }
    await applyPlans([await adapter.installPlan({ ...ctx(), buracleBin: shim })])
    expect(by(await codexDoctor(ctx(), fake({ env })), 'codex.hooks.command').map(i => i.level)).toEqual(['ok'])
    const lost = by(await codexDoctor(ctx(), fake({ env: { HOME: home, PATH: process.env['PATH'] } })), 'codex.hooks.command')
    if (process.platform === 'win32') {
      // On Windows Codex runs commandWindows, which names the shim by its absolute path: an unset BURACLE_HOME changes nothing.
      expect(lost.map(i => i.level)).toEqual(['ok'])
    } else {
      expect(lost.map(i => i.level)).toEqual(['error'])
      expect(lost[0]?.detail).toContain(join(home, '.buracle', 'bin', 'buracle'))
    }
    const legacy = [{ event: 'PreToolUse', groupIndex: 0, handlerIndex: 0, key: 'k', hash: undefined, command: '"$HOME/.buracle/bin/buracle" hook codex PreToolUse' }]
    // The message spells the program as the command does: $HOME expanded, the rest as written.
    expect(hookCommandProblems(legacy, env)).toEqual([`PreToolUse: ${home}/.buracle/bin/buracle does not exist or is not executable`])
    expect(hookCommandProblems([{ ...legacy[0]!, command: '"$(whoami)/x" hook codex Stop' }], env)[0]).toContain('cannot resolve')
  }))

  test('after install: the permission mode, effort, routing keys and Codex\'s own config check are ok', () => withSandbox(async () => {
    await applyPlans([await adapter.installPlan(ctx())])
    const items = await codexDoctor(ctx(), fake())
    for (const c of ['codex.permissions', 'codex.effort', 'codex.routing', 'codex.config']) expect({ c, level: by(items, c)[0]?.level }).toEqual({ c, level: 'ok' })
    expect(by(items, 'codex.effort')[0]?.detail).toContain('"xhigh"')
  }))

  test('permission mode: both no-approval keys, or a warning that names the split and the fix', () => {
    const cfg = { permissions: { bypass: true, enforce: true } }
    expect(permissionCheck({ approval_policy: BYPASS_APPROVAL_POLICY, sandbox_mode: 'danger-full-access' }, cfg).level).toBe('ok')
    const older = permissionCheck({ approval_policy: 'never', sandbox_mode: 'danger-full-access' }, cfg)
    expect(older.level).toBe('warn')
    expect(older.detail).toContain('the consent question never opens in Codex')
    const split = permissionCheck({ approval_policy: BYPASS_APPROVAL_POLICY, sandbox_mode: 'read-only' }, cfg)
    expect(split.level).toBe('warn')
    expect(split.detail).toContain('one unit')
    expect(split.detail).toContain('buracle install codex')
    expect(permissionCheck({}, { permissions: { bypass: true, enforce: false } }).detail).toContain('permissions.enforce is off')
    expect(permissionCheck({ approval_policy: 'on-request' }, { permissions: { bypass: false, enforce: true } })).toEqual({ level: 'ok', check: 'codex.permissions', detail: expect.stringContaining('permissions.bypass is off') })
  })

  test('effort: a model migration that rewrote model_reasoning_effort is named; keep, invalid values and a subagent level some models lack are reported', () => {
    const auto = { effort: { ...defaultConfig().effort, codex: 'auto' } }
    expect(effortCheck({ model_reasoning_effort: 'xhigh', plan_mode_reasoning_effort: 'xhigh', agents: { default_subagent_reasoning_effort: 'xhigh' } }, auto).level).toBe('ok')
    const migrated = effortCheck({ model_reasoning_effort: 'medium', plan_mode_reasoning_effort: 'xhigh', notice: { model_migrations: { 'gpt-5.5': 'gpt-6-sol' } } }, auto)
    expect(migrated.level).toBe('warn')
    expect(migrated.detail).toContain('model_reasoning_effort is "medium", effort.codex wants "xhigh"')
    expect(migrated.detail).toContain('model migration was accepted')
    expect(effortCheck({ model_reasoning_effort: 'xhigh' }, auto).detail).toContain('plan_mode_reasoning_effort is unset')
    expect(effortCheck({ agents: { default_subagent_reasoning_effort: 'max' } }, auto).detail).toContain('spawn_agent fails')
    expect(effortCheck({}, { effort: { ...auto.effort, codex: 'keep' } }).level).toBe('ok')
    expect(effortCheck({}, { effort: { ...auto.effort, codex: 'ultra' } })).toEqual({ level: 'warn', check: 'codex.effort', detail: expect.stringContaining('delegation mode') })
  })

  test('routing keys: critical MCP tools top-level, startup grace 0, web search off under enforce', () => withSandbox(async ({ home }) => {
    await applyPlans([await adapter.installPlan(ctx())])
    const toml = Bun.TOML.parse(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')) as Record<string, any>
    expect(routingCheck(toml, ctx()).level).toBe('ok')
    const hidden = { ...toml, mcp_servers: { ...toml['mcp_servers'], codegraph: { ...toml['mcp_servers']['codegraph'], omit_tools_from: ['deferred'] } } }
    expect(routingCheck(hidden, ctx()).detail).toContain('the tools of codegraph can hide')
    const { mcp_optional_startup_grace_ms: _grace, web_search: _ws, ...rest } = toml
    const loose = routingCheck(rest, ctx())
    expect(loose.level).toBe('warn')
    expect(loose.detail).toContain('mcp_optional_startup_grace_ms is unset')
    expect(loose.detail).toContain('web_search is unset')
    const nudge = defaultConfig()
    nudge.routing.strictness = 'nudge'
    expect(routingCheck({ ...toml, web_search: 'live' }, { ...ctx(), config: nudge }).level).toBe('ok')
  }))

  test('Codex\'s own config check: a config it cannot load is an error, ignored keys are warnings (read from config.load only)', () => {
    const r = (stdout: string, code = 1): RunResult => ({ code, stdout, stderr: '', timedOut: false })
    expect(configLoadCheck(r(doctorJson())).level).toBe('ok')
    const ignored = configLoadCheck(r(doctorJson({ status: 'warning', summary: 'config loaded', details: { 'startup warning': 'Codex is ignoring 1 unrecognized configuration setting.\n  user (/h/.codex/config.toml): `web_searchh` is ignored.' } })))
    expect(ignored.level).toBe('warn')
    expect(ignored.detail).toContain('`web_searchh` is ignored')
    expect(configLoadCheck(r(doctorJson({ status: 'fail', summary: 'config could not be loaded', details: { error: 'invalid data' }, remediation: 'Fix the reported config error, then rerun codex doctor.' })))).toEqual({ level: 'error', check: 'codex.config', detail: expect.stringContaining('does not start: invalid data') })
    expect(configLoadCheck({ code: -1, stdout: '', stderr: '', timedOut: true })).toEqual({ level: 'warn', check: 'codex.config', detail: expect.stringContaining('timed out') })
  })

  test('I8: Buracle MCP commands must resolve (the shim is an error, a missing package runner a warning)', () => {
    const cfg = '[mcp_servers.buracle-memory]\ncommand = "/nope/bin/buracle"\nargs = ["mcp", "memory"]\n[mcp_servers.context7]\ncommand = "definitely-not-a-runner-x"\n[mcp_servers.grep]\nurl = "https://mcp.grep.app"\n[mcp_servers.sh]\ncommand = "/bin/sh"\nargs = ["-c", "exec \\"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle\\" mcp memory"]\n'
    const r = mcpCommandProblems(cfg, ['buracle-memory', 'context7', 'grep', 'sh'], { HOME: '/nonexistent-home', PATH: process.env['PATH'] })
    expect(r.errors).toEqual(['buracle-memory: `/nope/bin/buracle` does not exist or is not executable', 'sh: `/nonexistent-home/.buracle/bin/buracle` does not exist or is not executable'])
    expect(r.warnings).toEqual(['context7: `definitely-not-a-runner-x` is not on PATH'])
  })
})

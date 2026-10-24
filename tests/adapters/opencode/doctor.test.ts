import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { claudeSubscriptionSigns, commandFindings, doctor, effortFinding, mcpCommandFindings, permissionFinding, rememberedVariants, type DoctorItem, type DoctorOptions } from '../../../src/adapters/opencode/doctor'
import { TESTED_WITH } from '../../../src/adapters/opencode/constants'
import { installPlan } from '../../../src/adapters/opencode/install'
import type { RunResult } from '../../../src/engine/proc'
import * as paths from '../../../src/engine/paths'
import { applyPlans } from '../../../src/engine/txn'
import { fakeExe } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { adapterContext } from './helpers'

function ok(stdout: string): RunResult { return { code: 0, stdout, stderr: '', timedOut: false } }

function fake(version: string | undefined, answers: Record<string, string>): DoctorOptions {
  return {
    detect: async () => (version === undefined ? { installed: false } : { installed: true, version, path: '/fake/opencode' }),
    run: async argv => ok(answers[argv.slice(1).join(' ')] ?? ''),
  }
}

function level(items: DoctorItem[], check: string): string | undefined {
  return items.find(i => i.check === check)?.level
}

describe('MCP server commands OpenCode starts', () => {
  test('a missing Windows path (the buracle.cmd shim) is an error; a bare name off PATH is a warning; an existing file is fine', () => withSandbox(async ({ root }) => {
    const shim = join(root, 'buracle.cmd')
    writeFileSync(shim, '@echo off\r\n')
    chmodSync(shim, 0o755)
    const found = mcpCommandFindings({
      gone: { type: 'local', command: ['C:\\Users\\me\\.buracle\\bin\\buracle.cmd', 'mcp', 'memory'] },
      runner: { type: 'local', command: ['definitely-not-a-runner-xyz', 'pkg'] },
      ok: { type: 'local', command: [shim, 'mcp', 'run', 'codegraph'] },
    }, {})
    expect(found.map(f => f.level).sort()).toEqual(['error', 'warn'])
    expect(found.find(f => f.level === 'error')?.detail).toContain('gone: C:\\Users\\me\\.buracle\\bin\\buracle.cmd does not exist')
    expect(found.find(f => f.level === 'warn')?.detail).toContain('runner: `definitely-not-a-runner-xyz` is not on PATH')
  }))
})

describe('opencode doctor', () => {
  test('reports a missing binary and a missing install', () => withSandbox(async () => {
    const items = await doctor(adapterContext(), fake(undefined, {}))
    expect(level(items, 'opencode.binary')).toBe('warn')
    expect(level(items, 'opencode.config')).toBe('error')
    expect(level(items, 'opencode.files')).toBe('error')
    expect(level(items, 'opencode.claude-subscription')).toBe('ok')
  }))

  test('a fresh install with the tested version is healthy; live checks use the running service', () => withSandbox(async ({ buracleHome }) => {
    const ctx = adapterContext()
    await applyPlans([await installPlan(ctx, { opencode: null })])
    expect((await doctor(ctx, fake(TESTED_WITH, { 'service status': 'stopped\n' }))).find(i => i.check === 'opencode.mcp.command' && i.level === 'error')?.detail).toContain(ctx.buracleBin)
    expect(fakeExe(join(dirname(ctx.buracleBin), 'buracle'), '')).toBe(ctx.buracleBin)
    const stopped = await doctor(ctx, fake(TESTED_WITH, { 'service get env BURACLE_HOME': `${buracleHome}\n`, 'service status': 'stopped\n' }))
    expect(stopped.filter(i => i.level === 'error')).toEqual([])
    for (const c of ['opencode.version', 'opencode.config', 'opencode.cli', 'opencode.permissions', 'opencode.effort', 'opencode.files', 'opencode.commands', 'opencode.pointer', 'opencode.agents-md', 'opencode.service-env', 'opencode.live']) expect(level(stopped, c)).toBe('ok')
    expect(stopped.find(i => i.check === 'opencode.effort')?.detail).toContain('default effort xhigh')
    const live = await doctor(ctx, fake(TESTED_WITH, {
      'service get env BURACLE_HOME': buracleHome,
      'service status': 'http://127.0.0.1:49374\n',
      'plugin list': `ID       VERSION  SOURCE\nburacle  local    ${join(paths.opencodeConfigDir(), 'plugins', 'buracle', 'index.js')}\n`,
      'debug config': JSON.stringify([{ type: 'document', info: { mcp: { servers: { 'buracle-memory': { type: 'local', command: ['x'] } } } } }]),
    }))
    expect(level(live, 'opencode.live.plugin')).toBe('ok')
    expect(level(live, 'opencode.live.config')).toBe('ok')
    const unset = await doctor(ctx, fake(TESTED_WITH, { 'service status': 'stopped' }))
    expect(level(unset, 'opencode.service-env')).toBe('warn')
  }), 60_000)

  test('version gates: v1 and old v2 are errors, an untested newer v2 is a warning', () => withSandbox(async () => {
    const ctx = adapterContext()
    expect(level(await doctor(ctx, fake('1.18.35', {})), 'opencode.version')).toBe('error')
    expect(level(await doctor(ctx, fake('2.0.10', {})), 'opencode.version')).toBe('error')
    expect(level(await doctor(ctx, fake(TESTED_WITH, {})), 'opencode.version')).toBe('ok')
    expect(level(await doctor(ctx, fake(TESTED_WITH.replace(/\d+$/, n => String(Number(n) + 1)), {})), 'opencode.version')).toBe('warn')
  }))

  test('host limits (PARITY-10): ok on the version they were checked on, a re-probe hint on a newer one', () => withSandbox(async () => {
    const ctx = adapterContext()
    expect(level(await doctor(ctx, fake('2.0.30', {})), 'opencode.limits')).toBe('ok')
    const newer = (await doctor(ctx, fake('2.0.31', {}))).find(i => i.check === 'opencode.limits')
    expect(newer?.level).toBe('warn')
    expect(newer?.detail).toContain('stop-veto')
  }))

  test('the no-approval mode: autoaccept is ok; another value warns, and says whether install restores it', () => {
    expect(permissionFinding({ bypass: true, enforce: true }, 'autoaccept').level).toBe('ok')
    const enforced = permissionFinding({ bypass: true, enforce: true }, 'ask')
    expect(enforced).toMatchObject({ level: 'warn' })
    expect(enforced.detail).toContain('run `buracle install opencode` to restore it')
    expect(permissionFinding({ bypass: true, enforce: false }, undefined).detail).toContain('Buracle keeps your value')
    expect(permissionFinding({ bypass: false, enforce: true }, 'ask').level).toBe('ok')
  })

  test('effort: the applied default, the user\'s own choices that win, keep, and invalid values', () => {
    const config = { providers: { anthropic: { models: { 'claude-opus-5-5': { settings: { effort: 'medium' } } } }, openai: { models: { 'gpt-x': { settings: { temperature: 1 } } } } } }
    const auto = effortFinding('auto', config, ['anthropic/claude-sonnet-5-5#max'])
    expect(auto.level).toBe('ok')
    expect(auto.detail).toContain('default effort xhigh')
    expect(auto.detail).toContain('anthropic/claude-opus-5-5 (opencode.jsonc)')
    expect(auto.detail).toContain('anthropic/claude-sonnet-5-5#max (picked in the TUI)')
    expect(auto.detail).not.toContain('gpt-x')
    expect(effortFinding('keep', undefined, []).detail).toContain('keep')
    expect(effortFinding('ultra', undefined, [])).toMatchObject({ level: 'warn' })
  })

  test('remembered TUI variants are read from $XDG_STATE_HOME/opencode/model.json ("default" means none)', () => withSandbox(async ({ root }) => {
    const state = join(root, 'state')
    mkdirSync(join(state, 'opencode'), { recursive: true })
    writeFileSync(join(state, 'opencode', 'model.json'), JSON.stringify({ variant: { 'anthropic/claude-opus-5-5': 'max', 'openai/gpt-x': 'default' } }))
    expect(rememberedVariants({ XDG_STATE_HOME: state })).toEqual(['anthropic/claude-opus-5-5#max'])
    expect(rememberedVariants({ HOME: join(root, 'nohome') })).toEqual([])
  }))

  test('command files or config entries that would shadow the plugin\'s workflow commands warn', () => withSandbox(async () => {
    const ctx = adapterContext()
    const dir = paths.opencodeConfigDir()
    expect(commandFindings(ctx, dir, undefined)).toMatchObject([{ level: 'ok' }])
    mkdirSync(join(dir, 'commands'), { recursive: true })
    writeFileSync(join(dir, 'commands', 'plan-build.md'), 'old\n')
    const found = commandFindings(ctx, dir, { commands: { bugfix: { template: 'x' } } })
    expect(found).toMatchObject([{ level: 'warn' }])
    expect(found[0]?.detail).toContain('commands/plan-build.md, commands.bugfix in the config shadow')
  }))

  test('warns when cli.json disables the Buracle TUI plugin', () => withSandbox(async () => {
    const dir = paths.opencodeConfigDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cli.json'), '{ "plugins": ["-buracle"] }')
    expect(level(await doctor(adapterContext(), fake(TESTED_WITH, {})), 'opencode.cli')).toBe('warn')
  }))

  test('detects Claude subscription auth: v1 auth.json, v2 credential rows, auth plugins; never reads secrets', () => withSandbox(async ({ root }) => {
    const data = join(root, 'data')
    mkdirSync(data, { recursive: true })
    expect(claudeSubscriptionSigns(data, [])).toEqual([])
    writeFileSync(join(data, 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', refresh: 'r', access: 'a' }, openai: { type: 'oauth' } }))
    const db = new Database(join(data, 'opencode.db'))
    db.run('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL)')
    db.run(`INSERT INTO credential VALUES ('cred_1', 'claude-max', 'me', '{"type":"oauth","access":"SECRET"}'), ('cred_2', 'anthropic', 'key', '{"type":"key","key":"sk-x"}')`)
    db.close()
    const cfg = join(root, 'opencode.jsonc')
    writeFileSync(cfg, '{ "plugins": ["opencode-anthropic-auth@0.0.13", "@scope/other"] }')
    const signs = claudeSubscriptionSigns(data, [cfg])
    expect(signs.length).toBe(3)
    expect(signs.join('\n')).toContain('"anthropic"')
    expect(signs.join('\n')).toContain('"claude-max"')
    expect(signs.join('\n')).toContain('opencode-anthropic-auth')
    expect(signs.join('\n')).not.toContain('SECRET')
  }))
})

describe('opencode doctor: MCP commands on Windows', () => {
  test('a buracle.cmd shim by its Windows path is checked by existence (OpenCode starts a .cmd through cross-spawn and cmd.exe)', () => withSandbox(async ({ root }) => {
    const cmd = join(root, 'bin', 'buracle.cmd')
    mkdirSync(dirname(cmd), { recursive: true })
    writeFileSync(cmd, '@echo off\r\n')
    const servers = (command: string) => ({ 'buracle-memory': { type: 'local', command: [command, 'mcp', 'memory'] } })
    expect(mcpCommandFindings(servers('C:\\Users\\Ann Lee\\.buracle\\bin\\buracle.cmd'), {})).toEqual([{ level: 'error', detail: expect.stringContaining('buracle-memory: C:\\Users\\Ann Lee\\.buracle\\bin\\buracle.cmd does not exist') }])
    await withEnv({ BURACLE_PLATFORM: 'win32' }, () => { expect(mcpCommandFindings(servers(cmd), {})).toEqual([]) })
    if (process.platform !== 'win32') expect(mcpCommandFindings(servers(cmd), {})[0]?.detail).toContain(`buracle-memory: ${cmd} does not exist or is not executable`)
  }))
})

import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  bashHookCommand, claudeDoctor, commandProgram, commandsFinding, compareVersions, effortFinding, guardProbeFinding, indexFinding, permissionFinding, pluginFinding, PROBE_COMMAND,
  routerFinding, statusLineFinding, validateFinding, versionFinding,
} from '../../../src/adapters/claude/doctor'
import { TESTED_WITH } from '../../../src/adapters/claude/constants'
import type { AdapterContext } from '../../../src/adapters/registry'
import { defaultConfig } from '../../../src/core/config'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { run as runProcess, type RunOptions, type RunResult } from '../../../src/engine/proc'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const REPO = paths.repoRoot()
const FOLDER = join(REPO, 'harness', 'claude')
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '', timedOut: false })

function ctx(): AdapterContext {
  return { repoRoot: REPO, config: defaultConfig(), paths, buracleBin: paths.shimPath(), get canonical(): CanonicalBundle { throw new Error('not needed') } }
}

function validateReport(over: { warnings?: unknown[], errors?: unknown[], gating?: unknown[] } = {}): string {
  return JSON.stringify({
    success: (over.errors ?? []).length === 0 && (over.warnings ?? []).length === 0, strict: true, target: `${FOLDER}/.claude-plugin/plugin.json`,
    manifest: { file: `${FOLDER}/.claude-plugin/plugin.json`, type: 'plugin', errors: over.errors ?? [], warnings: over.warnings ?? [], notes: [], gatingHooks: [] },
    contents: [{ file: `${FOLDER}/hooks/hooks.json`, type: 'hooks', errors: [], warnings: [], notes: [], gatingHooks: over.gating ?? [{ module: './register.tsx', pattern: 'tool.call', hook: 'tool.call{tool=Bash}', hasCatch: true }] }],
  })
}

describe('findings', () => {
  test('version range', () => {
    expect(compareVersions('2.1.293', '2.1.290')).toBe(1)
    expect(compareVersions('2.1.29', '2.1.290')).toBe(-1)
    expect(compareVersions('2.1.290', '2.1.290')).toBe(0)
    expect(versionFinding('2.1.291').level).toBe('ok')
    expect(versionFinding('2.1.293').level).toBe('ok')
    expect(versionFinding('2.1.294').level).toBe('ok')
    const [maj, min, patch] = TESTED_WITH.split('.').map(Number) as [number, number, number]
    expect(versionFinding(TESTED_WITH).level).toBe('ok')
    expect(versionFinding(`${maj}.${min}.${patch + 1}`).level).toBe('warn')
    expect(versionFinding('2.2.0').level).toBe('warn')
    expect(versionFinding('2.1.289').level).toBe('error')
    expect(versionFinding(undefined).level).toBe('error')
  })

  test('plugin state', () => {
    const base = { id: 'buracle@buracle', version: 'unknown', scope: 'user', enabled: true, installPath: '/x', readFromFolder: FOLDER }
    expect(pluginFinding([base], FOLDER).level).toBe('ok')
    expect(pluginFinding(undefined, FOLDER).level).toBe('error')
    expect(pluginFinding([], FOLDER).detail).toContain('not installed')
    expect(pluginFinding([{ ...base, enabled: false }], FOLDER).detail).toContain('disabled')
    expect(pluginFinding([{ ...base, errors: ['hooks module failed'] }], FOLDER).detail).toContain('hooks module failed')
    expect(pluginFinding([{ ...base, readFromFolder: undefined }], FOLDER).level).toBe('warn')
    expect(pluginFinding([{ ...base, readFromFolder: '/other/checkout/harness/claude' }], FOLDER).level).toBe('error')
  })

  test('validate: strict means no error, no warning (plugin.json carries version and author) and a .catch on every gate', () => {
    expect(validateFinding({ code: 0, stdout: validateReport(), stderr: '' })).toEqual({ level: 'ok', check: 'plugin validate', detail: 'passed (1 gating hook, all with .catch)' })
    const version = validateFinding({ code: 1, stdout: validateReport({ warnings: [{ path: 'version', message: 'No version specified.' }] }), stderr: '' })
    expect(version.level).toBe('error')
    expect(version.detail).toContain('version')
    const extra = validateFinding({ code: 1, stdout: validateReport({ warnings: [{ path: 'homepage', message: 'Unknown field' }] }), stderr: '' })
    expect(extra.level).toBe('error')
    expect(extra.detail).toContain('homepage')
    expect(validateFinding({ code: 1, stdout: validateReport(), stderr: '' }).detail).toContain('exited 1')
    const uncaught = validateFinding({ code: 1, stdout: validateReport({ gating: [{ hook: 'tool.call{tool=Write}', hasCatch: false }] }), stderr: '' })
    expect(uncaught.detail).toContain('tool.call{tool=Write}')
    expect(validateFinding({ code: 1, stdout: validateReport({ errors: [{ path: 'name', message: 'bad' }] }), stderr: '' }).level).toBe('error')
    expect(validateFinding({ code: 2, stdout: '', stderr: 'Unexpected error' }).detail).toContain('Unexpected error')
  })

  test('the guard probe runs the plugin\'s PreToolUse hook as Claude Code does and wants a deny', async () => {
    const cmd = bashHookCommand(JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'x hook claude PreToolUse' }] }, { matcher: 'Bash|Monitor', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/bin/buracle" hook claude PreToolUse' }] }] } }))
    expect(cmd).toBe('"${CLAUDE_PLUGIN_ROOT}/bin/buracle" hook claude PreToolUse')
    const seen: Array<{ argv: string[], opts?: RunOptions }> = []
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } })
    const okProbe = await guardProbeFinding(FOLDER, { run: async (argv, opts) => { seen.push(opts !== undefined ? { argv, opts } : { argv }); return ok(deny) } })
    expect(okProbe.level).toBe('ok')
    expect(seen[0]?.argv).toEqual(['/bin/sh', '-c', `"${FOLDER}/bin/buracle" hook claude PreToolUse`])
    expect(String(seen[0]?.opts?.stdin)).toContain(PROBE_COMMAND)
    expect(seen[0]?.opts?.env).toMatchObject({ BURACLE_NO_CAPTURE: '1', BURACLE_NO_MEMORY: '1', BURACLE_NO_AUTOSTART: '1' })
    const silent = await guardProbeFinding(FOLDER, { run: async () => ok('') })
    expect(silent.level).toBe('error')
    expect(silent.detail).toContain('unguarded')
  })

  test('the guard probe end to end: the generated plugin denies through bin/buracle (no shim here: bun fallback)', async () => {
    await withSandbox(async () => {
      const f = await guardProbeFinding(FOLDER, { run: (argv, opts) => runProcess(argv, opts ?? {}) })
      expect(f).toEqual({ level: 'ok', check: 'hooks (guard probe)', detail: expect.stringContaining('denies') })
    })
  }, 60_000)

  test('statusLine', async () => {
    await withSandbox(async sb => {
      const f = join(sb.home, '.claude', 'settings.json')
      expect(statusLineFinding(f).level).toBe('warn')
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      writeFileSync(f, JSON.stringify({ statusLine: { type: 'command', command: '/h/.buracle/bin/buracle statusline claude' } }))
      expect(statusLineFinding(f).level).toBe('ok')
      writeFileSync(f, JSON.stringify({ statusLine: { type: 'command', command: 'ccstatusline' } }))
      expect(statusLineFinding(f).level).toBe('warn')
      writeFileSync(f, '{ broken')
      expect(statusLineFinding(f).level).toBe('error')
    })
  })
})

describe('claudeDoctor', () => {
  function runner(live: { pong: boolean }): { calls: string[][], run: (argv: string[], opts?: RunOptions) => Promise<RunResult> } {
    const calls: string[][] = []
    return {
      calls,
      run: async (argv: string[]) => {
        calls.push(argv)
        const a = argv.slice(1).join(' ')
        if (a === '--version') return ok('2.1.293 (Claude Code)\n')
        if (a === 'plugin list --json') return ok(JSON.stringify([{ id: 'buracle@buracle', version: 'unknown', scope: 'user', enabled: true, installPath: '/c', readFromFolder: FOLDER }]))
        if (a.startsWith('plugin validate --strict --json')) return { code: 0, stdout: validateReport(), stderr: '', timedOut: false }
        if (a.startsWith('-p /buracle-ping')) return live.pong ? ok('pong\n') : { code: 1, stdout: '', stderr: 'mods are off', timedOut: false }
        if (argv[0] === '/bin/sh' && a.includes('hook claude PreToolUse')) return ok(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'H01' } }))
        return { code: 127, stdout: '', stderr: `unexpected ${a}`, timedOut: false }
      },
    }
  }

  test('all checks; liveness only with BURACLE_DOCTOR_LIVE=1', async () => {
    await withSandbox(async sb => {
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      writeFileSync(join(sb.home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'x statusline claude' } }))
      const r = runner({ pong: true })
      const off = await claudeDoctor(ctx(), { which: () => '/bin/claude', run: r.run, now: () => 1, env: () => undefined, cwd: () => sb.root })
      expect(off.map(f => f.check)).toEqual(['claude version', 'plugin', 'plugin validate', 'mod liveness', 'hooks (guard probe)', 'statusLine', 'commands', 'permission mode', 'effort', 'index', 'router'])
      expect(off.slice(0, 6).map(f => f.level)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok'])
      expect(off.find(f => f.check === 'permission mode')?.level).toBe('warn')
      expect(off.find(f => f.check === 'effort')?.level).toBe('warn')
      expect(r.calls.some(c => c.includes('-p'))).toBe(false)
      expect(r.calls.find(c => c.includes('validate'))).toEqual(['/bin/claude', 'plugin', 'validate', '--strict', '--json', FOLDER])

      const live = await claudeDoctor(ctx(), { which: () => '/bin/claude', run: r.run, now: () => 1, env: n => (n === 'BURACLE_DOCTOR_LIVE' ? '1' : undefined), cwd: () => sb.root })
      expect(live.find(f => f.check === 'mod liveness')?.level).toBe('ok')
      expect(r.calls.find(c => c.includes('-p'))).toEqual(['/bin/claude', '-p', '/buracle-ping', '--no-session-persistence', '--strict-mcp-config'])
      const dead = await claudeDoctor(ctx(), { which: () => '/bin/claude', run: runner({ pong: false }).run, now: () => 1, env: n => (n === 'BURACLE_DOCTOR_LIVE' ? '1' : undefined), cwd: () => sb.root })
      expect(dead.find(f => f.check === 'mod liveness')?.level).toBe('error')
    })
  })

  test('without claude on PATH there is one error and no command runs', async () => {
    const calls: string[][] = []
    const r = await claudeDoctor(ctx(), { which: () => undefined, run: async a => { calls.push(a); return ok('') } })
    expect(r).toEqual([{ level: 'error', check: 'claude version', detail: '`claude` is not on PATH' }])
    expect(calls).toEqual([])
  })
})

describe('commands (I8): every hook, MCP, language server and statusLine command resolves to an executable', () => {
  function plugin(root: string): string {
    const folder = join(root, 'plugin')
    mkdirSync(join(folder, 'hooks'), { recursive: true })
    mkdirSync(join(folder, 'bin'), { recursive: true })
    writeFileSync(join(folder, 'hooks', 'hooks.json'), JSON.stringify({ modules: ['./register.tsx'], hooks: {
      PreToolUse: [{ matcher: 'Bash|Monitor', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/bin/buracle" hook claude PreToolUse' }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/bin/buracle" hook claude SessionEnd' }] }],
    } }))
    const launcher = '${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts'
    writeFileSync(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: {
      'buracle-memory': { command: 'bun', args: [launcher, 'mcp', 'memory'] },
      context7: { command: 'bun', args: [launcher, 'mcp', 'run', 'context7'] },
      grep: { type: 'http', url: 'https://mcp.grep.app' },
    } }))
    writeFileSync(join(folder, '.lsp.json'), JSON.stringify({ pyright: { command: 'bun', args: [launcher, 'lsp', 'run', 'pyright'], extensionToLanguage: { '.py': 'python' } } }))
    for (const name of ['buracle', 'buracle.ts']) {
      writeFileSync(join(folder, 'bin', name), '#!/bin/sh\nexit 0\n')
      chmodSync(join(folder, 'bin', name), 0o755)
    }
    return folder
  }
  function shim(path: string): void {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '#!/bin/sh\nexit 0\n')
    chmodSync(path, 0o755)
  }
  const onPath = (name: string) => (name === 'bun' ? '/usr/bin/bun' : undefined)

  test('ok when the plugin entries, the shim and the statusLine program exist', async () => {
    await withSandbox(async sb => {
      const folder = plugin(sb.root)
      const settings = join(sb.home, '.claude', 'settings.json')
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: `${paths.shimPath()} statusline claude` } }))
      expect(commandsFinding(folder, settings, onPath).level).toBe('error')
      shim(paths.shimPath())
      const f = commandsFinding(folder, settings, onPath)
      expect(f).toEqual({ level: 'ok', check: 'commands', detail: expect.stringContaining('resolve') })
    })
  })

  test('a relocated BURACLE_HOME without its shim is an error; a missing third-party launcher a warning', async () => {
    await withSandbox(async sb => {
      const folder = plugin(sb.root)
      shim(paths.shimPath())
      const settings = join(sb.home, '.claude', 'settings.json')
      await withEnv({ BURACLE_HOME: join(sb.root, 'elsewhere') }, async () => {
        const f = commandsFinding(folder, settings, onPath)
        expect(f.level).toBe('error')
        expect(f.detail).toContain(join(sb.root, 'elsewhere', 'bin', 'buracle'))
        shim(paths.shimPath())
        expect(commandsFinding(folder, settings, onPath).level).toBe('ok')
        const noBun = commandsFinding(folder, settings, () => undefined)
        expect(noBun.level).toBe('warn')
        expect(noBun.detail).toContain('MCP context7: bun is not on PATH')
        expect(noBun.detail).toContain('LSP pyright: bun is not on PATH')
      })
    })
  })

  test('a hook launcher that is not executable, or a server launcher that is gone, is an error', async () => {
    await withSandbox(async sb => {
      const folder = plugin(sb.root)
      shim(paths.shimPath())
      chmodSync(join(folder, 'bin', 'buracle'), 0o644)
      const f = commandsFinding(folder, join(sb.home, 'none.json'), onPath)
      expect(f.level).toBe('error')
      expect(f.detail).toContain(`hook: ${join(folder, 'bin', 'buracle')}`)
      chmodSync(join(folder, 'bin', 'buracle'), 0o755)
      rmSync(join(folder, 'bin', 'buracle.ts'))
      const g = commandsFinding(folder, join(sb.home, 'none.json'), onPath)
      expect(g.level).toBe('error')
      expect(g.detail).toContain('MCP buracle-memory launcher')
    })
  })

  test('the program of a command line', () => {
    expect(commandProgram('/h/.buracle/bin/buracle statusline claude')).toBe('/h/.buracle/bin/buracle')
    expect(commandProgram("'/a b/buracle' statusline claude")).toBe('/a b/buracle')
    expect(commandProgram('"/a b/buracle" statusline claude')).toBe('/a b/buracle')
  })
})

describe('permission mode, effort, code indexes and the prompt router', () => {
  const MIN = 60_000
  const perms = (over: Partial<ReturnType<typeof defaultConfig>['permissions']> = {}) => ({ ...defaultConfig().permissions, ...over })
  const bypass = { permissions: { defaultMode: 'bypassPermissions' } }

  test('permission mode: the configured mode, the mode the newest session ran in, and the auto-mode prompt', () => {
    expect(permissionFinding(perms({ bypass: false }), undefined, undefined, undefined, 0)).toMatchObject({ level: 'ok', detail: expect.stringContaining('permissions.bypass is off') })
    const flipped = permissionFinding(perms(), { permissions: { defaultMode: 'auto' } }, { hasSeenAutoDefaultNudge: true }, undefined, 0)
    expect(flipped.level).toBe('warn')
    expect(flipped.detail).toContain('"auto"')
    expect(flipped.detail).toContain('make auto mode your default')
    expect(flipped.detail).toContain('buracle install')
    expect(permissionFinding(perms({ enforce: false }), { permissions: { defaultMode: 'default' } }, undefined, undefined, 0).detail).toContain('permissions.enforce is off')
    expect(permissionFinding(perms(), {}, undefined, undefined, 0).detail).toContain('not set (Claude Code then starts in auto mode)')
    const live = permissionFinding(perms(), bypass, { hasSeenAutoDefaultNudge: true }, { mode: 'acceptEdits', at: 0, sid: 's1' }, 5 * MIN)
    expect(live).toMatchObject({ level: 'warn', detail: expect.stringContaining('the newest session (s1, 5m ago) ran in "acceptEdits"') })
    expect(permissionFinding(perms(), bypass, { hasSeenAutoDefaultNudge: true }, { mode: 'plan', at: 0, sid: 's1' }, MIN).level).toBe('ok')
    expect(permissionFinding(perms(), bypass, { hasSeenAutoDefaultNudge: true }, { mode: 'bypassPermissions', at: 0, sid: 's1' }, 2 * MIN))
      .toEqual({ level: 'ok', check: 'permission mode', detail: 'bypassPermissions; newest session: bypassPermissions, 2m ago' })
    expect(permissionFinding(perms(), bypass, {}, undefined, 0).detail).toContain('"No, keep bypass permissions"')
  })

  test("effort: Buracle's level everywhere, the user's /effort choice kept, values Claude Code drops, the overriding variable", () => {
    const models = (level: string, over: Record<string, string> = {}) => Object.fromEntries(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'].map(m => [m, { effortLevel: over[m] ?? level }]))
    expect(effortFinding('auto', { effortLevel: 'xhigh', modelSettings: models('xhigh') }, undefined)).toEqual({ level: 'ok', check: 'effort', detail: 'xhigh for every model' })
    expect(effortFinding('auto', { effortLevel: 'xhigh', modelSettings: models('xhigh', { 'claude-opus-5-5': 'high' }) }, undefined).detail)
      .toBe("xhigh for every model, except the user's own choice (kept): claude-opus-5-5 high")
    expect(effortFinding('auto', {}, undefined)).toMatchObject({ level: 'warn', detail: expect.stringContaining('buracle install') })
    expect(effortFinding('auto', { effortLevel: 'max', modelSettings: models('xhigh') }, undefined)).toMatchObject({ level: 'warn', detail: expect.stringContaining('drops this value') })
    expect(effortFinding('auto', { effortLevel: 'xhigh', modelSettings: models('xhigh') }, 'max')).toMatchObject({ level: 'warn', detail: expect.stringContaining('CLAUDE_CODE_EFFORT_LEVEL=max') })
    expect(effortFinding('max', undefined, undefined)).toMatchObject({ level: 'warn', detail: expect.stringContaining('effort.claude') })
    expect(effortFinding('keep', { effortLevel: 'high' }, undefined)).toEqual({ level: 'ok', check: 'effort', detail: "effort.claude is keep: Buracle leaves Claude Code's effort alone (effortLevel high)" })
  })

  test('index: codegraph and semble declared and loaded upfront, and the index state of the project doctor runs in', async () => {
    await withSandbox(async sb => {
      const plugin = join(sb.root, 'plugin')
      mkdirSync(plugin, { recursive: true })
      const mcp = (servers: Record<string, unknown>) => writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
      const proj = join(sb.home, 'proj')
      mkdirSync(proj, { recursive: true })
      writeFileSync(join(proj, 'package.json'), '{"name":"proj"}\n')
      const cfg = defaultConfig()
      mcp({ codegraph: { command: 'bun', alwaysLoad: true }, semble: { command: 'bun', alwaysLoad: true } })
      const ready = await indexFinding(plugin, cfg, proj, 1)
      expect(ready.level).toBe('ok')
      expect(ready.detail).toContain(`${proj}: codegraph not built yet, semble not built yet`)
      expect(ready.detail).toContain('codegraph and semble load upfront')
      expect(await indexFinding(plugin, cfg, sb.home, 1)).toMatchObject({ level: 'ok', detail: expect.stringContaining('is not a project') })
      mcp({ codegraph: { command: 'bun' }, semble: { command: 'bun', alwaysLoad: true } })
      expect(await indexFinding(plugin, cfg, proj, 1)).toMatchObject({ level: 'warn', detail: expect.stringContaining('codegraph load behind tool search') })
      mcp({ codegraph: { command: 'bun', alwaysLoad: true } })
      expect(await indexFinding(plugin, cfg, proj, 1)).toMatchObject({ level: 'error', detail: expect.stringContaining('declares no semble server') })
      cfg.index.semble = false
      expect((await indexFinding(plugin, cfg, proj, 1)).level).toBe('ok')
    })
  })

  test('router: the canonical triggers are loaded and every workflow has request phrases', () => {
    const withCanonical = (dir: string): AdapterContext => ({ repoRoot: REPO, config: defaultConfig(), paths, buracleBin: paths.shimPath(), canonical: loadCanonicalSync(dir) })
    const found = routerFinding(withCanonical(join(REPO, 'canonical')))
    expect(found.level).toBe('ok')
    expect(found.detail).toMatch(/^\d+ of \d+ skills with request phrases, \d+ MCP categories with triggers$/)
    const off = withCanonical(join(REPO, 'canonical'))
    off.config.routing.skills = 'off'
    expect(routerFinding(off)).toMatchObject({ level: 'ok', detail: expect.stringContaining('routing.skills is off') })
    expect(routerFinding(withCanonical(join(import.meta.dir, 'fixtures', 'canonical-mini')))).toMatchObject({ level: 'warn', detail: expect.stringContaining('skill-triggers.yaml was not loaded') })
    expect(routerFinding(ctx())).toMatchObject({ level: 'warn', detail: expect.stringContaining('could not be loaded') })
  })
})

import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { run as doctorRun } from '../../../src/cli/commands/doctor'
import { run as updateRun } from '../../../src/cli/commands/update'
import { usage as uninstallUsage } from '../../../src/cli/commands/uninstall'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import { CM_HIDDEN_TOOLS, CM_TOOLS } from '../../../src/core/context-mode'
import { cmHome, cmProjectDir, cmSessionsDir, cmStorageRoot, type CmPackage } from '../../../src/engine/context-mode'
import * as paths from '../../../src/engine/paths'
import { CM_EXPECTED_TOOLS, cmForeignInstalls, cmPlatformFiles, cmSmokeWarning, cmToolchainChanged, contextModeChecks, type CmDoctorOptions } from '../../../src/engine/update/context-mode-doctor'
import { doctorExit, type DoctorCheck } from '../../../src/engine/update/doctor'
import type { HealthFile, StoredMcpEntry } from '../../../src/engine/update/mcp'
import { writeHealth } from '../../../src/engine/update/mcp'
import { tilde } from '../../../src/engine/update/output'
import { npmUrl } from '../../../src/engine/update/updates'
import type { OpsDeps } from '../../../src/engine/update/deps'
import { installCmFixture } from '../../fixtures/context-mode/fixture'
import { IS_WINDOWS } from '../../helpers/fake-exe'
import { withEnv, withSandbox, type Sandbox } from '../../helpers/sandbox'
import { daysAgo, fakeCli, fakeFetch, fakeMcpServer, makeRepo, memoryIO, withDeps } from './helpers'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const AT = new Date(NOW - 5 * 60_000).toISOString()

function installFixture(sb: Sandbox): CmPackage {
  const pkg = installCmFixture(sb, { copy: true })
  writeFileSync(join(pkg.root, 'cli.bundle.mjs'), '// the server bundle of the fixture: never run\n')
  return pkg
}

function healthWith(entry: StoredMcpEntry): HealthFile {
  return { v: 1, checked_at: AT, mcp: { 'context-mode': entry } }
}

const OK_ENTRY: StoredMcpEntry = { status: 'ok', transport: 'stdio', tools: 11, toolNames: [...CM_EXPECTED_TOOLS], version: '0.0.0-fixture', serverName: 'context-mode', checked_at: AT }

function opts(over: Partial<CmDoctorOptions> = {}): CmDoctorOptions {
  return { config: defaultConfig(), nowMs: NOW, env: {}, which: () => undefined, health: healthWith(OK_ENTRY), ...over }
}

const by = (checks: readonly DoctorCheck[], check: string) => checks.find(c => c.check === check)

// The platform.json context-mode's hook scripts read: ~/.context-mode on macOS and Linux (after
// $XDG_CONFIG_HOME), %APPDATA%\context-mode on Windows (its hooks/platform-bridge.mjs). APPDATA points
// into the sandbox here, so the file shows as an absolute path.
function platformFile(root: string): { env: Record<string, string>, file: string, shown: string } {
  if (!IS_WINDOWS) return { env: {}, file: join(paths.home(), '.context-mode', 'platform.json'), shown: '~/.context-mode/platform.json' }
  const appdata = join(root, 'appdata')
  const file = join(appdata, 'context-mode', 'platform.json')
  return { env: { APPDATA: appdata }, file, shown: file }
}

function writeFile(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

function withContextMode(cfg: BuracleConfig, over: Partial<BuracleConfig['contextMode']>): BuracleConfig {
  return { ...cfg, contextMode: { ...cfg.contextMode, ...over } }
}

describe('doctor context-mode: a healthy setup', () => {
  test('toolchain copy, Bun, the session library, switches, handshake, storage, no foreign install, no telemetry: all ok', () => withSandbox(async sb => {
    const pkg = installFixture(sb)
    const checks = await contextModeChecks(opts())
    expect(checks.every(c => c.section === 'context-mode')).toBe(true)
    expect(checks.map(c => [c.check, c.level])).toEqual([
      ['switches', 'ok'], ['toolchain', 'ok'], ['bun', 'ok'], ['session library', 'ok'], ['handshake', 'ok'],
      ['storage', 'ok'], ['foreign installs', 'ok'], ['telemetry', 'ok'],
    ])
    expect(doctorExit(checks)).toBe(0)
    expect(by(checks, 'toolchain')?.detail).toBe(`context-mode 0.0.0-fixture in ${pkg.root}`)
    expect(by(checks, 'session library')?.detail).toMatch(/^the session library of context-mode 0\.0\.0-fixture passes Buracle's smoke test: .* \(\d+ ms\)$/)
    expect(by(checks, 'handshake')?.detail).toBe(`11 tools (${CM_TOOLS.length} in use, ${CM_HIDDEN_TOOLS.length} hidden), v0.0.0-fixture, 5 min ago`)
    expect(by(checks, 'switches')?.detail).toContain('contextMode.enabled: true, contextMode.capture: true')
    expect(by(checks, 'storage')?.detail).toBe(`nothing stored yet (${tilde(cmHome())})`)
    // Without APPDATA, Windows' platform.json is the one under the home folder's AppData\Roaming.
    const telemetryFile = IS_WINDOWS ? '~/AppData/Roaming/context-mode/platform.json' : '~/.context-mode/platform.json'
    expect(by(checks, 'telemetry')?.detail).toBe(`no ${telemetryFile} (context-mode's hook scripts would forward nothing to its hosted platform)`)
  }))
})

describe('doctor context-mode: problems', () => {
  test('not installed: a warning (npx carries it meanwhile), the library untested; switched off it is only a note', () => withSandbox(async () => {
    const checks = await contextModeChecks(opts())
    expect(by(checks, 'toolchain')).toMatchObject({ level: 'warn' })
    expect(by(checks, 'toolchain')?.detail).toContain('`buracle install`')
    expect(by(checks, 'session library')).toMatchObject({ level: 'info', detail: 'not tested: context-mode is not installed in the toolchain' })
    const off = await contextModeChecks(opts({ config: withContextMode(defaultConfig(), { enabled: false }) }))
    expect(by(off, 'toolchain')?.level).toBe('info')
    expect(by(off, 'switches')?.level).toBe('info')
    expect(by(off, 'switches')?.detail).toContain('its next start (a new session or an MCP reconnect)')
  }))

  test('a broken toolchain copy: the folder, the server or the version disagree with toolchain.json', () => withSandbox(async sb => {
    const pkg = installFixture(sb)
    writeFileSync(join(pkg.root, 'package.json'), JSON.stringify({ name: 'context-mode', version: '0.0.1', type: 'module' }))
    expect(by(await contextModeChecks(opts()), 'toolchain')).toMatchObject({ level: 'warn', detail: expect.stringContaining('toolchain.json says 0.0.0-fixture, but') })
    rmSync(join(pkg.root, 'cli.bundle.mjs'))
    expect(by(await contextModeChecks(opts()), 'toolchain')).toMatchObject({ level: 'error', detail: expect.stringContaining('has no server') })
    rmSync(pkg.root, { recursive: true, force: true })
    expect(by(await contextModeChecks(opts()), 'toolchain')).toMatchObject({ level: 'error', detail: expect.stringContaining('holds no package') })
  }))

  test('a session library that fails the smoke test: an error while sessions are recorded, a warning otherwise', () => withSandbox(async sb => {
    const pkg = installFixture(sb)
    writeFileSync(join(pkg.root, 'build', 'session', 'extract.js'), 'export function extractEvents() { return [] }\nexport function extractUserEvents() { return [] }\n')
    const checks = await contextModeChecks(opts())
    expect(by(checks, 'session library')).toMatchObject({ level: 'error' })
    expect(by(checks, 'session library')?.detail).toContain('extractEvents(Edit) gave no file_edit row of category file')
    expect(by(checks, 'session library')?.detail).toContain('`contextMode.capture: false` stops the attempts')
    const noCapture = await contextModeChecks(opts({ config: withContextMode(defaultConfig(), { capture: false }) }))
    expect(by(noCapture, 'session library')?.level).toBe('warn')
    const thrown = await contextModeChecks(opts({ smoke: async () => { throw new Error('import failed') } }))
    expect(by(thrown, 'session library')).toMatchObject({ level: 'error', detail: expect.stringContaining('import failed') })
  }))

  test('no Bun: an error while Context Mode is on', () => withSandbox(async () => {
    expect(by(await contextModeChecks(opts({ bun: () => undefined })), 'bun')?.level).toBe('error')
    expect(by(await contextModeChecks(opts({ bun: () => undefined, config: withContextMode(defaultConfig(), { enabled: false }) })), 'bun')?.level).toBe('warn')
  }))

  test('the handshake: down, never probed, the switched-off server, a tool list Buracle does not know, no names', () => withSandbox(async sb => {
    installFixture(sb)
    const hs = async (entry: StoredMcpEntry | undefined, config = defaultConfig()) =>
      by(await contextModeChecks(opts({ config, health: entry === undefined ? { v: 1, checked_at: AT, mcp: {} } : healthWith(entry) })), 'handshake')
    expect(await hs(undefined)).toMatchObject({ level: 'info', detail: 'no handshake recorded yet; `buracle doctor mcp` runs one' })
    expect(await hs({ status: 'down', error: 'exited with code 1', source: 'launch', until: '2026-10-10T12:10:00.000Z' })).toMatchObject({
      level: 'error', detail: 'down: exited with code 1 (`buracle mcp run` tries again after 2026-10-10T12:10:00.000Z); `buracle doctor mcp` runs the handshake again',
    })
    const stub: StoredMcpEntry = { status: 'ok', transport: 'stdio', tools: 0, toolNames: [], version: 'disabled', serverName: 'context-mode', checked_at: AT }
    expect(await hs(stub, withContextMode(defaultConfig(), { enabled: false }))).toMatchObject({ level: 'ok', detail: 'switched off, 5 min ago: the server answers without tools (contextMode.enabled: false)' })
    expect((await hs(stub))?.level).toBe('info')
    const newer = await hs({ ...OK_ENTRY, tools: 11, toolNames: [...CM_EXPECTED_TOOLS.filter(t => t !== 'ctx_purge'), 'ctx_summarize'], version: '1.0.170' })
    expect(newer?.level).toBe('warn')
    expect(newer?.detail).toContain('new: ctx_summarize (the guards deny them until Buracle knows them); missing: ctx_purge')
    expect(newer?.detail).toContain('the handshake saw v1.0.170 but the toolchain holds 0.0.0-fixture')
    expect(await hs({ status: 'ok', tools: 11 })).toMatchObject({ level: 'info', detail: expect.stringContaining('the tool names were not recorded') })
    expect(by(await contextModeChecks(opts({ catalog: { servers: {} } })), 'handshake')).toMatchObject({ level: 'info', detail: 'canonical/mcp.yaml has no context-mode server' })
  }))

  test('storage: project folders, size, this folder\'s roots; session data other users can read is a warning', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const claudeRoot = cmStorageRoot('claude', proj)
    const codexRoot = cmStorageRoot('codex', cmProjectDir('codex', { cwd: proj }))
    for (const r of [claudeRoot, codexRoot, cmStorageRoot('codex', join(root, 'other'))]) {
      mkdirSync(cmSessionsDir(r), { recursive: true, mode: 0o755 })
      writeFileSync(join(cmSessionsDir(r), 'a.db'), 'x'.repeat(2048))
    }
    chmodSync(cmHome(), 0o755)
    for (const h of ['claude', 'codex']) chmodSync(join(cmHome(), h), 0o755)
    for (const r of [claudeRoot, codexRoot]) chmodSync(r, 0o755)
    const checks = await contextModeChecks(opts({ cwd: proj, env: { CLAUDE_PROJECT_DIR: proj } }))
    const storage = by(checks, 'storage')?.detail ?? ''
    expect(storage).toContain('project folders: claude 1, codex 2; 6 KB; this folder: claude ~/.buracle/context-mode/claude/proj-')
    expect(storage).toContain(', codex ~/.buracle/context-mode/codex/proj-')
    if (process.platform !== 'win32') {
      expect(by(checks, 'storage access')).toMatchObject({ level: 'warn', detail: expect.stringContaining('`chmod -R go-rwx ~/.buracle/context-mode`') })
      chmodSync(cmHome(), 0o700)
      expect(by(await contextModeChecks(opts({ cwd: proj })), 'storage access')).toBeUndefined()
    }
  }))
})

describe('doctor context-mode: installs outside Buracle', () => {
  test('nothing found in a clean home', () => withSandbox(() => {
    expect(cmForeignInstalls({ which: () => undefined })).toEqual([])
  }))

  test('Claude Code: its plugin, marketplace and cache-heal hook', () => withSandbox(() => {
    const dir = paths.claudeDir()
    writeFile(join(dir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'context-mode@context-mode': [{ scope: 'user', version: '1.0.169' }], 'buracle@buracle': [{}] } }))
    writeFile(join(dir, 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'context-mode': { source: { source: 'github', repo: 'mksglu/context-mode' } } }))
    writeFile(join(dir, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'context-mode@context-mode': true, 'buracle@buracle': true },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `"${dir}/hooks/context-mode-cache-heal.mjs"` }] }] },
    }))
    writeFile(join(dir, 'hooks', 'context-mode-cache-heal.mjs'), '// heal\n')
    const found = cmForeignInstalls({ which: () => undefined })
    expect(found.map(f => [f.harness, f.check])).toEqual([['claude', 'claude plugin'], ['claude', 'claude marketplace'], ['claude', 'claude cache-heal hook']])
    expect(found[0]?.detail).toBe('~/.claude/plugins/installed_plugins.json and enabledPlugins in ~/.claude/settings.json name context-mode@context-mode: its start.mjs rewrites ~/.claude/settings.json on every start and its hooks run beside Buracle\'s; `claude plugin uninstall context-mode@context-mode` removes it (Buracle runs context-mode itself)')
    expect(found[2]?.detail).toContain('~/.claude/hooks/context-mode-cache-heal.mjs and its SessionStart entry in ~/.claude/settings.json')
    writeFile(join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'context-mode@context-mode': false } }))
    writeFile(join(dir, 'plugins', 'installed_plugins.json'), '{"version":2,"plugins":{}}')
    expect(cmForeignInstalls({ which: () => undefined }).map(f => f.check)).toEqual(['claude marketplace', 'claude cache-heal hook'])
  }))

  test('Codex: its plugin and marketplace in config.toml, its hook commands in hooks.json (not Buracle\'s)', () => withSandbox(() => {
    const home = paths.codexHome()
    writeFile(join(home, 'config.toml'), 'model = "gpt-6.1-sol"\n\n[plugins."context-mode@context-mode"]\nenabled = true\n\n[marketplaces.context-mode]\nsource = "mksglu/context-mode"\n\n[mcp_servers.context-mode]\ncommand = "buracle"\n')
    writeFile(join(home, 'hooks.json'), JSON.stringify({ hooks: {
      PostToolUse: [
        { hooks: [{ type: 'command', command: '"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" hook codex PostToolUse' }] },
        { matcher: '', hooks: [{ type: 'command', command: 'context-mode hook codex posttooluse' }] },
      ],
      SessionStart: [{ hooks: [{ type: 'command', command: 'node "/x/node_modules/context-mode/hooks/codex/sessionstart.mjs"' }] }],
    } }))
    const found = cmForeignInstalls({ which: () => undefined })
    expect(found.map(f => [f.harness, f.check])).toEqual([['codex', 'codex plugin'], ['codex', 'codex marketplace'], ['codex', 'codex hooks']])
    expect(found[0]?.detail).toContain('`codex plugin remove context-mode@context-mode`')
    expect(found[2]?.detail).toContain('holds 2 context-mode hook command(s) (context-mode hook codex posttooluse)')
  }))

  test('OpenCode: a plugin entry naming context-mode in opencode.json(c) or cli.json; Buracle\'s own plugin is fine', () => withSandbox(() => {
    const dir = paths.opencodeConfigDir()
    writeFile(join(dir, 'opencode.jsonc'), '{\n  // v1 install\n  "plugin": ["context-mode"],\n}\n')
    writeFile(join(dir, 'cli.json'), JSON.stringify({ plugins: ['/home/me/.config/opencode/plugins/buracle', ['context-mode@1.0.169', { quiet: true }]] }))
    writeFile(join(dir, 'opencode.json'), JSON.stringify({ plugin: ['my-context-moder', 'other'] }))
    const found = cmForeignInstalls({ which: () => undefined })
    expect(found.map(f => f.check)).toEqual(['opencode plugin', 'opencode plugin'])
    expect(found[0]?.detail).toContain('`plugin` in ~/.config/opencode/opencode.jsonc names context-mode')
    expect(found[1]?.detail).toContain('`plugins` in ~/.config/opencode/cli.json names ["context-mode@1.0.169",{"quiet":true}]')
  }))

  test('omp: its own plugin in ~/.omp/plugins, a context-mode server in ~/.omp/agent/mcp.json (not Buracle\'s Windows entry)', () => withSandbox(() => {
    writeFile(join(paths.ompHome(), 'plugins', 'package.json'), JSON.stringify({ dependencies: { 'context-mode': '^1.0.169', other: '1.0.0' } }))
    writeFile(join(paths.ompAgentDir(), 'mcp.json'), JSON.stringify({ mcpServers: {
      'context-mode': { type: 'stdio', command: 'node', args: ['/x/node_modules/context-mode/server.bundle.mjs'] },
      'buracle-cm': { type: 'stdio', command: 'C:\\Users\\me\\.buracle\\bin\\buracle.cmd', args: ['mcp', 'run', 'context-mode'] },
      notes: { command: 'notes-mcp', args: ['--dir', '/x/context-mode-notes'] },
    } }))
    const found = cmForeignInstalls({ which: () => undefined })
    expect(found.map(f => [f.harness, f.check])).toEqual([['omp', 'omp plugin'], ['omp', 'omp mcp.json']])
    expect(found[1]?.detail).toContain('`mcpServers.context-mode` in ~/.omp/agent/mcp.json')
    writeFile(join(paths.ompHome(), 'plugins', 'package.json'), '{}')
    writeFile(join(paths.ompHome(), 'plugins', 'omp-plugins.lock.json'), JSON.stringify({ plugins: { 'context-mode': { enabled: true } } }))
    expect(cmForeignInstalls({ which: () => undefined }).map(f => f.check)).toContain('omp plugin')
  }))

  test('Claude Code: a context-mode MCP server of the user (~/.claude.json), of a project (its local scope) or in this folder\'s .mcp.json; Buracle\'s own entry is fine', () => withSandbox(({ root }) => {
    const proj = join(root, 'proj')
    writeFile(paths.claudeJson(), JSON.stringify({
      mcpServers: { 'context-mode': { type: 'stdio', command: 'npx', args: ['-y', 'context-mode'] }, notes: { command: 'notes-mcp', args: ['--dir', '/x/context-mode-notes'] } },
      projects: { [proj]: { mcpServers: { cm: { command: 'node', args: ['/x/node_modules/context-mode/server.bundle.mjs'] } } }, '/elsewhere': { allowedTools: [] } },
    }))
    writeFile(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: {
      'context-mode': { command: 'npx', args: ['-y', 'context-mode@latest'] },
      'buracle-cm': { command: 'bun', args: ['/p/bin/buracle.ts', 'mcp', 'run', 'context-mode'] },
    } }))
    const found = cmForeignInstalls({ which: () => undefined, cwd: proj })
    expect(found.map(f => [f.harness, f.check])).toEqual([['claude', 'claude mcp server'], ['claude', 'claude mcp server'], ['claude', 'claude mcp server']])
    expect(found[0]?.detail).toBe('`mcpServers.context-mode` in ~/.claude.json (user scope) starts context-mode outside Buracle\'s launcher (no storage root, no platform, no stub), and its tools reach Claude Code under another name (`mcp__context-mode__<tool>`) beside Buracle\'s; `claude mcp remove context-mode -s user` removes it')
    expect(found[1]?.detail).toStartWith(`\`projects[${JSON.stringify(proj)}].mcpServers.cm\` in ~/.claude.json (local scope) starts context-mode outside Buracle's launcher`)
    expect(found[1]?.detail).toEndWith(`; \`claude mcp remove cm -s local\`, run in ${proj}, removes it`)
    expect(found[2]?.detail).toStartWith(`\`mcpServers.context-mode\` in ${join(proj, '.mcp.json')} (project scope) starts`)
    expect(found[2]?.detail).toEndWith('; `claude mcp remove context-mode -s project`, run in that folder, removes it')
    expect(cmForeignInstalls({ which: () => undefined, cwd: root }).map(f => f.check)).toEqual(['claude mcp server', 'claude mcp server'])
  }))

  test('a global CLI on PATH, unless it is Buracle\'s own toolchain copy', () => withSandbox(() => {
    expect(cmForeignInstalls({ which: () => '/usr/local/bin/context-mode' })).toEqual([{ check: 'global cli', detail: expect.stringContaining('`context-mode` on PATH (/usr/local/bin/context-mode)') }])
    expect(cmForeignInstalls({ which: () => join(paths.toolchainDir(), 'npm', 'context-mode', 'node_modules', '.bin', 'context-mode') })).toEqual([])
  }))

  test('in the section: a warning per install, a note for a harness Buracle does not manage; the telemetry file with an install that reads it is an error', () => withSandbox(async ({ root }) => {
    const telemetry = platformFile(root)
    writeFile(join(paths.codexHome(), 'config.toml'), '[plugins."context-mode@context-mode"]\nenabled = true\n')
    writeFile(join(paths.claudeDir(), 'hooks', 'context-mode-cache-heal.mjs'), '// heal\n')
    writeFile(telemetry.file, '{"api_key":"ctxm_x"}')
    const cfg = defaultConfig()
    const config: BuracleConfig = { ...cfg, harnesses: { ...cfg.harnesses, codex: { ...cfg.harnesses.codex, enabled: false } } }
    const checks = await contextModeChecks(opts({ config, env: telemetry.env }))
    expect(by(checks, 'codex plugin')?.level).toBe('info')
    expect(by(checks, 'claude cache-heal hook')?.level).toBe('warn')
    expect(by(checks, 'foreign installs')).toBeUndefined()
    expect(by(checks, 'telemetry')).toMatchObject({
      level: 'error',
      detail: `${telemetry.shown} exists: while it does, context-mode's hook scripts (run by its Claude Code and Codex plugins) forward session events to its hosted platform. Buracle runs none of them, but the context-mode install above (codex plugin) does: remove it or delete the file`,
    })
    expect(doctorExit(checks)).toBe(1)
  }))

  test('telemetry: every platform.json context-mode\'s hook scripts read ($XDG_CONFIG_HOME first); a warning while no install that runs them was found', () => withSandbox(async ({ root, home }) => {
    const xdg = join(root, 'xdg')
    const env = { XDG_CONFIG_HOME: xdg }
    expect(cmPlatformFiles(env, 'linux')).toEqual([join(xdg, 'context-mode', 'platform.json'), join(home, '.context-mode', 'platform.json')])
    expect(cmPlatformFiles({ XDG_CONFIG_HOME: '' }, 'darwin')).toEqual([join(home, '.context-mode', 'platform.json')])
    expect(cmPlatformFiles({ APPDATA: '/c/Users/me/AppData/Roaming', XDG_CONFIG_HOME: xdg }, 'win32')).toEqual([join('/c/Users/me/AppData/Roaming', 'context-mode', 'platform.json')])
    expect(cmPlatformFiles({}, 'win32')).toEqual([join(home, 'AppData', 'Roaming', 'context-mode', 'platform.json')])
    if (IS_WINDOWS) {
      // One file on Windows: $XDG_CONFIG_HOME and ~/.context-mode are not read there.
      const { env: appdata, file } = platformFile(root)
      const win = { ...env, ...appdata }
      expect(by(await contextModeChecks(opts({ env: win })), 'telemetry')).toMatchObject({ level: 'ok', detail: `no ${file} (context-mode's hook scripts would forward nothing to its hosted platform)` })
      writeFile(join(xdg, 'context-mode', 'platform.json'), '{"api_key":"ctxm_x"}')
      expect(by(await contextModeChecks(opts({ env: win })), 'telemetry')?.level).toBe('ok')
      writeFile(file, '{"api_key":"ctxm_x"}')
      const alone = await contextModeChecks(opts({ env: win }))
      expect(by(alone, 'telemetry')).toMatchObject({
        level: 'warn',
        detail: `${file} exists: while it does, context-mode's hook scripts (run by its Claude Code and Codex plugins) forward session events to its hosted platform. Buracle runs none of them, and none of them was found installed; delete the file unless a context-mode setup outside Buracle uses it`,
      })
      expect(doctorExit(alone)).toBe(2)
      writeFile(paths.claudeJson(), JSON.stringify({ mcpServers: { 'context-mode': { command: 'npx', args: ['-y', 'context-mode'] } } }))
      expect(by(await contextModeChecks(opts({ env: win })), 'telemetry')).toMatchObject({ level: 'warn', detail: expect.stringContaining(`${file} exists: while it does,`) })
      writeFile(join(paths.claudeDir(), 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'context-mode@context-mode': [{ scope: 'user' }] } }))
      expect(by(await contextModeChecks(opts({ env: win })), 'telemetry')).toMatchObject({ level: 'error', detail: expect.stringContaining('Buracle runs none of them, but the context-mode install above (claude plugin) does: remove it or delete the file') })
      return
    }
    expect(by(await contextModeChecks(opts({ env })), 'telemetry')).toMatchObject({
      level: 'ok', detail: `no ${join(xdg, 'context-mode', 'platform.json')} or ~/.context-mode/platform.json (context-mode's hook scripts would forward nothing to its hosted platform)`,
    })
    writeFile(join(xdg, 'context-mode', 'platform.json'), '{"api_key":"ctxm_x"}')
    const alone = await contextModeChecks(opts({ env }))
    expect(by(alone, 'telemetry')).toMatchObject({
      level: 'warn',
      detail: `${join(xdg, 'context-mode', 'platform.json')} exists: while it does, context-mode's hook scripts (run by its Claude Code and Codex plugins) forward session events to its hosted platform. Buracle runs none of them, and none of them was found installed; delete the file unless a context-mode setup outside Buracle uses it`,
    })
    expect(doctorExit(alone)).toBe(2)
    writeFile(join(home, '.context-mode', 'platform.json'), '{"api_key":"ctxm_x"}')
    writeFile(paths.claudeJson(), JSON.stringify({ mcpServers: { 'context-mode': { command: 'npx', args: ['-y', 'context-mode'] } } }))
    expect(by(await contextModeChecks(opts({ env })), 'telemetry')).toMatchObject({ level: 'warn', detail: expect.stringContaining(`${join(xdg, 'context-mode', 'platform.json')} and ~/.context-mode/platform.json exist: while they do,`) })
    writeFile(join(paths.claudeDir(), 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'context-mode@context-mode': [{ scope: 'user' }] } }))
    expect(by(await contextModeChecks(opts({ env })), 'telemetry')).toMatchObject({ level: 'error', detail: expect.stringContaining('Buracle runs none of them, but the context-mode install above (claude plugin) does: remove it or delete the files') })
  }))
})

describe('telemetry next to an install that runs no hook scripts', () => {
  test("context-mode's omp plugin reads no platform.json (1.0.169 delivers it as an MCP server only): the file stays a warning", () => withSandbox(async ({ root }) => {
    const telemetry = platformFile(root)
    writeFile(join(paths.ompHome(), 'plugins', 'package.json'), JSON.stringify({ dependencies: { 'context-mode': '^1.0.169' } }))
    writeFile(telemetry.file, '{"platform_url":"https://example.invalid"}')
    const checks = await contextModeChecks(opts({ env: telemetry.env }))
    expect(by(checks, 'omp plugin')?.level).toBe('warn')
    expect(by(checks, 'telemetry')).toMatchObject({ level: 'warn', detail: expect.stringContaining('none of them was found installed') })
    expect(doctorExit(checks)).toBe(2)
  }))
})

describe('buracle doctor context-mode (the command)', () => {
  test('the topic runs only this section, reads health.json and exits by the worst finding', () => withSandbox(async sb => {
    const repo = makeRepo(sb.root)
    installFixture(sb)
    writeHealth({ mcp: { 'context-mode': { ...OK_ENTRY, transport: 'stdio', ms: 140, checked_at: new Date().toISOString(), status: 'ok' } } }, new Date().toISOString())
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO({ json: true })
      const code = await doctorRun(['context-mode', '--json'], io)
      const r = JSON.parse(io.out()) as { code: number, checks: DoctorCheck[] }
      expect(r.checks.length).toBeGreaterThan(0)
      expect(r.checks.every(c => c.section === 'context-mode')).toBe(true)
      expect(by(r.checks, 'handshake')?.level).toBe('ok')
      expect(by(r.checks, 'session library')?.level).toBe('ok')
      expect(code).toBe(doctorExit(r.checks))
      const tty = memoryIO({ tty: true })
      Object.assign(tty.stdout, { isTTY: true, columns: 120 })
      await doctorRun(['context-mode'], tty)
      expect(tty.out()).toContain('Context Mode')
    })
  }))
})

describe('the smoke test after a toolchain install or upgrade', () => {
  test('only for context-mode installed or upgraded', () => {
    expect(cmToolchainChanged([{ id: 'mcp:context-mode', status: 'upgraded' }])).toBe(true)
    expect(cmToolchainChanged([{ id: 'mcp:context-mode', status: 'installed' }])).toBe(true)
    expect(cmToolchainChanged([{ id: 'mcp:context-mode', status: 'ok' }, { id: 'mcp:context7', status: 'upgraded' }])).toBe(false)
    expect(cmToolchainChanged([])).toBe(false)
  })

  test('a passing library says nothing', () => withSandbox(async sb => {
    installFixture(sb)
    expect(await cmSmokeWarning()).toBeUndefined()
  }))

  test('a failing one is a warning naming the problems; so is a smoke test that throws', () => withSandbox(async sb => {
    const pkg = installFixture(sb)
    writeFileSync(join(pkg.root, 'build', 'session', 'extract.js'), 'export function extractEvents() { return [] }\nexport function extractUserEvents() { return [] }\n')
    const w = await cmSmokeWarning()
    expect(w).toStartWith('context-mode 0.0.0-fixture: its session library fails Buracle\'s smoke test (extractEvents(Read) gave no file_read row of category file;')
    expect(w).toContain('; extractEvents(Edit) gave no file_edit row of category file;')
    expect(w).toEndWith('session continuity fails open until a release passes it (the tools still work). Details: `buracle doctor context-mode`.')
    expect(await cmSmokeWarning(async () => { throw new Error('boom') })).toBe('context-mode: its session library fails Buracle\'s smoke test (boom); session continuity fails open until a release passes it (the tools still work). Details: `buracle doctor context-mode`.')
    rmSync(join(sb.buracleHome, 'state', 'toolchain.json'))
    expect(await cmSmokeWarning()).toContain('(context-mode is not installed in the toolchain)')
  }))

  test('`buracle update --yes`: a toolchain upgrade of context-mode is smoke tested; a failure is a warning, not a failed update', () => withSandbox(async sb => {
    const NOW_U = Date.parse('2026-10-08T12:00:00Z')
    const repo = makeRepo(sb.root, { 'canonical/mcp.yaml': `servers:
  context-mode:
    description: Sandboxed execution and indexed search that keep large output out of context
    transport: stdio
    package: { registry: npm, name: context-mode, version: latest, bin: context-mode }
    harnesses: [claude, codex, opencode, omp]
    pin: latest
    critical: true
    routing: []
` })
    const pkg = installFixture(sb)
    writeFileSync(join(pkg.root, 'build', 'session', 'extract.js'), 'export function extractEvents() { return [] }\nexport function extractUserEvents() { return [] }\n')
    const f = fakeFetch({ [npmUrl('context-mode')]: { 'dist-tags': { latest: '1.0.170' }, time: { '1.0.169': daysAgo(NOW_U, 30), '1.0.170': daysAgo(NOW_U, 10) }, versions: { '1.0.169': {}, '1.0.170': {} } } })
    fakeMcpServer(join(sb.buracleHome, 'bin', 'buracle'), '1.0.170')
    const calls: string[][] = []
    const runToolchain: OpsDeps['runToolchain'] = async (_b, o) => {
      calls.push([...(o.only ?? [])])
      return { items: [{ id: 'mcp:context-mode', group: 'mcp', label: 'context-mode', required: true, status: 'upgraded', current: '1.0.170', detail: '' }], state: { v: 1, updated_at: '', packages: {}, system: {} }, changed: true }
    }
    await withDeps({ repoRoot: () => repo, adapters: async () => [], fetch: f, now: () => NOW_U, runToolchain }, async () => {
      await withEnv({ BURACLE_NO_TOOLCHAIN: undefined }, async () => {
        const io = memoryIO()
        expect(await updateRun(['--yes', 'mcp'], io)).toBe(0)
        expect(calls).toEqual([['mcp:context-mode']])
        expect(io.out()).toMatch(/applied {2}mcp context-mode: toolchain \S+ → 1\.0\.170/)
        expect(io.out()).toContain('handshake context-mode: ok')
        expect(io.err()).toContain('warning: context-mode 0.0.0-fixture: its session library fails Buracle\'s smoke test')
        const json = memoryIO({ json: true })
        expect(await updateRun(['--yes', 'mcp', '--json'], json)).toBe(0)
        expect((JSON.parse(json.out()) as { warnings: string[] }).warnings).toEqual([expect.stringContaining('fails Buracle\'s smoke test')])
      })
    })
  }), 150_000)
})

describe('uninstall --purge-state', () => {
  test('the help names Context Mode\'s session data', () => {
    expect(uninstallUsage).toContain('context-mode/ with Context Mode\'s session')
  })
})

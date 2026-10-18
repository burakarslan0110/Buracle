import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig } from '../../src/core/config'
import { loadConfig, loadConfigSync, refreshRuntimeConfigIfStale, runtimeConfigSnapshot, writeRuntimeConfig } from '../../src/engine/config'
import * as paths from '../../src/engine/paths'
import { withEnv, withSandbox } from '../helpers/sandbox'

function writeUserConfig(buracleHome: string, text: string): void {
  mkdirSync(buracleHome, { recursive: true })
  writeFileSync(join(buracleHome, 'config.yaml'), text)
}

describe('loadConfig', () => {
  test('canonical defaults without a user config', () => withSandbox(async ({ buracleHome }) => {
    const r = await loadConfig()
    expect(r.errors).toEqual([])
    expect(r.config).toEqual(defaultConfig())
    expect(r.files).toEqual({ canonical: join(paths.repoRoot(), 'canonical', 'buracle.yaml'), user: join(buracleHome, 'config.yaml'), userExists: false })
  }))

  test('user overrides are deep-merged; lists are replaced', () => withSandbox(({ buracleHome }) => {
    writeUserConfig(buracleHome, '# mine\nrouting:\n  strictness: nudge\ncheckers:\n  languages: [go]\nharnesses:\n  omp: { enabled: false }\nrepo: /src/buracle\n')
    const r = loadConfigSync()
    expect(r.errors).toEqual([])
    expect(r.files.userExists).toBe(true)
    expect(r.config.routing.strictness).toBe('nudge')
    expect(r.config.checkers.languages).toEqual(['go'])
    expect(r.config.checkers.timeoutMs).toBe(20000)
    expect(r.config.harnesses.omp.enabled).toBe(false)
    expect(r.config.harnesses.claude.enabled).toBe(true)
    expect(r.config.repo).toBe('/src/buracle')
  }))

  test('invalid values are dropped one by one and reported', () => withSandbox(({ buracleHome }) => {
    writeUserConfig(buracleHome, 'routing:\n  strictness: maximum\nstatusline:\n  style: compact\nunknownThing: 1\n')
    const r = loadConfigSync()
    expect(r.config.routing.strictness).toBe('enforce')
    expect(r.config.statusline.style).toBe('compact')
    expect(r.errors.length).toBe(2)
    expect(r.errors.every(e => e.startsWith(join(buracleHome, 'config.yaml')))).toBe(true)
    expect(r.errors.some(e => e.includes('routing.strictness'))).toBe(true)
    expect(r.errors.some(e => e.includes('unknownThing: unknown key'))).toBe(true)
  }))

  test('an unknown key says it is ignored and may have been renamed; a renamed key keeps its value and is a warning', () => withSandbox(({ buracleHome }) => {
    writeUserConfig(buracleHome, 'perms:\n  enforced: false\nroutng:\n  strictness: off\n')
    const r = loadConfigSync({ renames: [{ from: 'perms.enforced', to: 'permissions.enforce', since: '0.9.0' }] })
    expect(r.config.permissions.enforce).toBe(false)
    expect(r.warnings).toEqual([`${join(buracleHome, 'config.yaml')}: perms.enforced was renamed to permissions.enforce in 0.9.0; its value was used (rename the key in config.yaml)`])
    expect(r.errors).toEqual([`${join(buracleHome, 'config.yaml')}: routng: unknown key (ignored; misspelled, renamed or removed? \`buracle config get\` prints the valid keys)`])
    expect(r.config.routing.strictness).toBe('enforce')
    expect(loadConfigSync().warnings).toEqual([])
  }))

  test('unparsable YAML is reported, never treated as empty overrides', () => withSandbox(({ buracleHome }) => {
    writeUserConfig(buracleHome, 'routing: [unclosed\n')
    const r = loadConfigSync()
    expect(r.config).toEqual(defaultConfig())
    expect(r.errors.length).toBe(1)
    expect(r.errors[0]).toContain('invalid YAML')
  }))

  test('a missing canonical file falls back to built-in defaults with an error', () => withSandbox(({ root }) => {
    const r = loadConfigSync({ repoRoot: root, userConfigPath: join(root, 'none.yaml') })
    expect(r.config).toEqual(defaultConfig())
    expect(r.errors[0]).toContain('not found')
  }))
})

describe('runtime config snapshot', () => {
  test('writes resolved paths as stable JSON', () => withSandbox(async ({ home, buracleHome }) => {
    const cfg = defaultConfig()
    const file = await writeRuntimeConfig(cfg)
    expect(file).toBe(join(buracleHome, 'state', 'runtime-config.json'))
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const snap = JSON.parse(text) as ReturnType<typeof runtimeConfigSnapshot>
    expect(snap.v).toBe(1)
    expect(snap.config).toEqual(cfg)
    expect(snap.resolved).toEqual({
      buracleHome, brain: join(buracleHome, 'brain'), shim: join(buracleHome, 'bin', 'buracle'), repoRoot: paths.repoRoot(),
      claudeDir: join(home, '.claude'), codexHome: join(home, '.codex'), opencodeConfigDir: join(home, '.config', 'opencode'), ompAgentDir: join(home, '.omp', 'agent'),
      bun: Bun.which('bun') ?? process.execPath,
    })
    expect(JSON.stringify(runtimeConfigSnapshot(cfg), null, 2) + '\n').toBe(text)
  }))

  test('a hand edit of config.yaml refreshes the snapshot: the installer\'s dirs stay, an older snapshot\'s vault goes', () => withSandbox(async ({ buracleHome, root }) => {
    const file = paths.runtimeConfigFile()
    mkdirSync(join(file, '..'), { recursive: true })
    const old = runtimeConfigSnapshot(defaultConfig())
    writeFileSync(file, JSON.stringify({ ...old, resolved: { ...old.resolved, claudeDir: join(root, 'cc'), vault: join(root, 'vault'), brain: '/stale/brain' } }))
    writeFileSync(join(buracleHome, 'config.yaml'), 'routing:\n  strictness: nudge\n')
    utimesSync(file, new Date(), new Date(Date.now() - 10_000))
    expect(refreshRuntimeConfigIfStale()).toBe(true)
    const snap = JSON.parse(readFileSync(file, 'utf8')) as { config: { routing: { strictness: string } }, resolved: Record<string, string> }
    expect(snap.config.routing.strictness).toBe('nudge')
    expect(snap.resolved['claudeDir']).toBe(join(root, 'cc'))
    expect(snap.resolved['brain']).toBe(join(buracleHome, 'brain'))
    expect('vault' in snap.resolved).toBe(false)
    expect(refreshRuntimeConfigIfStale()).toBe(false)
  }))

  test('resolved harness dirs follow the environment of the writer; config repo wins over the checkout', () => withSandbox(async ({ root }) => {
    await withEnv({ CLAUDE_CONFIG_DIR: join(root, 'cc'), CODEX_HOME: join(root, 'cx'), XDG_CONFIG_HOME: join(root, 'xdg'), PI_CODING_AGENT_DIR: join(root, 'pi') }, () => {
      const r = runtimeConfigSnapshot({ ...defaultConfig(), repo: '/somewhere/buracle' }).resolved
      expect(r).toMatchObject({ claudeDir: join(root, 'cc'), codexHome: join(root, 'cx'), opencodeConfigDir: join(root, 'xdg', 'opencode'), ompAgentDir: join(root, 'pi'), repoRoot: '/somewhere/buracle' })
    })
  }))
})

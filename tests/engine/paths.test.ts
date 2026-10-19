import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../src/engine/proc'
import * as paths from '../../src/engine/paths'
import { withEnv, withSandbox } from '../helpers/sandbox'

describe('paths', () => {
  test('defaults follow HOME', () => withSandbox(({ home }) => {
    expect(paths.home()).toBe(home)
    expect(paths.buracleHome()).toBe(join(home, '.buracle'))
    expect(paths.claudeDir()).toBe(join(home, '.claude'))
    expect(paths.claudeJson()).toBe(join(home, '.claude.json'))
    expect(paths.codexHome()).toBe(join(home, '.codex'))
    expect(paths.agentsDir()).toBe(join(home, '.agents'))
    expect(paths.opencodeConfigDir()).toBe(join(home, '.config', 'opencode'))
    expect(paths.opencodeDataDir()).toBe(join(home, '.local', 'share', 'opencode'))
    expect(paths.ompAgentDir()).toBe(join(home, '.omp', 'agent'))
    expect(paths.ompHome()).toBe(join(home, '.omp'))
    expect(paths.localBinDir()).toBe(join(home, '.local', 'bin'))
    expect(paths.oldVaultRoot()).toBe(join(home, 'Documents', 'Buracle'))
  }))

  test('BURACLE_HOME is honored (withSandbox sets it)', () => withSandbox(({ buracleHome }) => {
    expect(paths.buracleHome()).toBe(buracleHome)
    expect(paths.ownedLedgerFile()).toBe(join(buracleHome, 'state', 'owned.json'))
    expect(paths.runtimeConfigFile()).toBe(join(buracleHome, 'state', 'runtime-config.json'))
    expect(paths.journalFile('t1')).toBe(join(buracleHome, 'journal', 't1.json'))
    expect(paths.logFile()).toBe(join(buracleHome, 'logs', 'buracle.log'))
    expect(paths.shimPath()).toBe(join(buracleHome, 'bin', process.platform === 'win32' ? 'buracle.cmd' : 'buracle'))
    expect(paths.brainDir()).toBe(join(buracleHome, 'brain'))
    expect(paths.userConfigFile()).toBe(join(buracleHome, 'config.yaml'))
  }))

  test('harness overrides', () => withSandbox(({ root }) => withEnv({
    CLAUDE_CONFIG_DIR: join(root, 'cc'),
    CODEX_HOME: join(root, 'cx'),
    XDG_CONFIG_HOME: join(root, 'xc'),
    XDG_DATA_HOME: join(root, 'xd'),
    PI_CODING_AGENT_DIR: join(root, 'pi'),
  }, () => {
    expect(paths.claudeDir()).toBe(join(root, 'cc'))
    expect(paths.claudeJson()).toBe(join(root, 'cc', '.claude.json'))
    expect(paths.codexHome()).toBe(join(root, 'cx'))
    expect(paths.opencodeConfigDir()).toBe(join(root, 'xc', 'opencode'))
    expect(paths.opencodeDataDir()).toBe(join(root, 'xd', 'opencode'))
    expect(paths.ompAgentDir()).toBe(join(root, 'pi'))
  })))

  test('empty and relative XDG values are ignored', () => withSandbox(({ home }) => withEnv({ XDG_CONFIG_HOME: 'relative/dir', XDG_DATA_HOME: '' }, () => {
    expect(paths.opencodeConfigDir()).toBe(join(home, '.config', 'opencode'))
    expect(paths.opencodeDataDir()).toBe(join(home, '.local', 'share', 'opencode'))
  })))

  test('the old vault is at its fixed path whatever an older config.yaml or BURACLE_VAULT says', () => withSandbox(({ home, buracleHome, root }) => withEnv({ BURACLE_VAULT: join(root, 'vault') }, () => {
    expect(paths.expandHome('~')).toBe(home)
    expect(paths.expandHome('/x/~')).toBe('/x/~')
    mkdirSync(buracleHome, { recursive: true })
    writeFileSync(join(buracleHome, 'config.yaml'), 'vault: ~/Obsidian/Mine\n')
    expect(paths.oldVaultRoot()).toBe(join(home, 'Documents', 'Buracle'))
  })))

  test('session ids', () => withSandbox(({ buracleHome }) => {
    expect(paths.isValidSessionId('a1b2-c3:d4.e_5')).toBe(true)
    for (const bad of ['', '..', '.', 'a/b', 'a b', 'x'.repeat(129), 42, undefined]) expect(paths.isValidSessionId(bad)).toBe(false)
    expect(paths.sessionDir('codex', 'abc')).toBe(join(buracleHome, 'sessions', 'codex', 'abc'))
    expect(paths.heartbeatFile('claude', 'abc')).toBe(join(buracleHome, 'run', 'claude', 'abc.json'))
    expect(() => paths.sessionDir('codex', '../escape')).toThrow(/invalid session id/)
  }))

  test('repoRoot finds this checkout', () => {
    const root = paths.repoRoot()
    expect(existsSync(join(root, 'canonical', 'buracle.yaml'))).toBe(true)
    expect(paths.canonicalDir()).toBe(join(root, 'canonical'))
    expect(paths.harnessDir('codex')).toBe(join(root, 'harness', 'codex'))
  })

  test('findCheckout / isCheckout', () => withSandbox(({ root }) => {
    const repo = paths.repoRoot()
    expect(paths.findCheckout(join(repo, 'src', 'engine'))).toBe(repo)
    expect(paths.isCheckout(repo)).toBe(true)
    expect(paths.findCheckout(root)).toBeUndefined()
  }))

  test('configuredRepoRoot: config `repo` (with ~), else runtime-config resolved.repoRoot, each only when it is a checkout', () => withSandbox(({ home, buracleHome }) => {
    const fake = join(home, 'src', 'buracle')
    mkdirSync(join(fake, 'canonical'), { recursive: true })
    writeFileSync(join(fake, 'canonical', 'buracle.yaml'), 'version: 1\n')
    writeFileSync(join(fake, 'package.json'), '{}\n')
    const other = join(home, 'other')
    mkdirSync(join(other, 'canonical'), { recursive: true })
    writeFileSync(join(other, 'canonical', 'buracle.yaml'), 'version: 1\n')
    writeFileSync(join(other, 'package.json'), '{}\n')
    expect(paths.configuredRepoRoot()).toBeUndefined()
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(join(buracleHome, 'state', 'runtime-config.json'), JSON.stringify({ v: 1, resolved: { repoRoot: other } }))
    expect(paths.configuredRepoRoot()).toBe(other)
    writeFileSync(join(buracleHome, 'config.yaml'), '# mine\nrepo: ~/src/buracle\n')
    expect(paths.configuredRepoRoot()).toBe(fake)
    writeFileSync(join(buracleHome, 'config.yaml'), 'repo: /nowhere/buracle\n')
    expect(paths.configuredRepoRoot()).toBe(other)
    writeFileSync(join(buracleHome, 'config.yaml'), 'repo: [broken\n')
    writeFileSync(join(buracleHome, 'state', 'runtime-config.json'), JSON.stringify({ v: 1, resolved: { repoRoot: 'relative/path' } }))
    expect(paths.configuredRepoRoot()).toBeUndefined()
  }))

  test('bundled into a plugin (no checkout around it), repoRoot() falls back to the recorded checkout', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = paths.repoRoot()
    const entry = join(root, 'entry.ts')
    writeFileSync(entry, `import { repoRoot } from ${JSON.stringify(join(repo, 'src', 'engine', 'paths.ts'))}\nconsole.log(repoRoot())\n`)
    const out = join(root, 'plugin', 'buracle')
    const built = await Bun.build({ entrypoints: [entry], outdir: out, target: 'bun' })
    expect(built.success).toBe(true)
    const bundle = join(out, 'entry.js')
    const env = { HOME: home, BURACLE_HOME: buracleHome }
    expect((await run([process.execPath, bundle], { env, timeoutMs: 20_000 })).stdout.trim()).toBe(join(root))
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    writeFileSync(join(buracleHome, 'state', 'runtime-config.json'), JSON.stringify({ v: 1, resolved: { repoRoot: repo } }))
    expect((await run([process.execPath, bundle], { env, timeoutMs: 20_000 })).stdout.trim()).toBe(repo)
    writeFileSync(join(buracleHome, 'config.yaml'), `repo: ${repo}\n`)
    writeFileSync(join(buracleHome, 'state', 'runtime-config.json'), '{}')
    expect((await run([process.execPath, bundle], { env, timeoutMs: 20_000 })).stdout.trim()).toBe(repo)
  }), 60_000)
})

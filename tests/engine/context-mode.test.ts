import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CM_SERVER_ID as CORE_SERVER_ID } from '../../src/core/context-mode'
import { HARNESSES } from '../../src/core/events'
import {
  CM_PACKAGE, CM_SERVER_ID, cmEmptyClaudeConfigDir, cmHarnessOfPlatform, cmHome, cmPackage, cmPlatform, cmProbeRoot, cmProjectDir, cmSentinelDir,
  cmServerEnv, cmSessionsDir, cmStaleClaudePlugin, cmStorageRoot, ensureCmDirs,
} from '../../src/engine/context-mode'
import { emptyToolchainState } from '../../src/engine/toolchain/state'
import { withSandbox } from '../helpers/sandbox'

const hash12 = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 12)

describe('context-mode names and platforms', () => {
  test('the server id (re-exported from core) and the package are context-mode', () => {
    expect(CM_SERVER_ID).toBe('context-mode')
    expect(CM_SERVER_ID).toBe(CORE_SERVER_ID)
    expect(CM_PACKAGE).toBe('context-mode')
  })

  test('every harness maps to a context-mode platform and back', () => {
    expect(HARNESSES.map(cmPlatform)).toEqual(['claude-code', 'codex', 'opencode', 'omp'])
    for (const h of HARNESSES) expect(cmHarnessOfPlatform(cmPlatform(h))).toBe(h)
    expect(cmHarnessOfPlatform(' codex ')).toBe('codex')
    expect(cmHarnessOfPlatform('kilo')).toBeUndefined()
    expect(cmHarnessOfPlatform(undefined)).toBeUndefined()
  })
})

describe('storage roots: one per harness and project', () => {
  test('<BURACLE_HOME>/context-mode/<harness>/<slug>-<12 hex of the folder>', async () => {
    await withSandbox(async ({ buracleHome }) => {
      expect(cmStorageRoot('codex', '/work/app', 'linux')).toBe(join(buracleHome, 'context-mode', 'codex', `app-${hash12('/work/app')}`))
      expect(cmSessionsDir(cmStorageRoot('omp', '/work/app', 'linux'))).toBe(join(buracleHome, 'context-mode', 'omp', `app-${hash12('/work/app')}`, 'sessions'))
    })
  })

  test('projects and harnesses never share a root; the same folder always gets the same one', async () => {
    await withSandbox(async () => {
      const roots = new Set([
        cmStorageRoot('claude', '/work/app'), cmStorageRoot('claude', '/other/app'), cmStorageRoot('claude', '/work/api'), cmStorageRoot('codex', '/work/app'),
      ])
      expect(roots.size).toBe(4)
      expect(cmStorageRoot('claude', '/work/app')).toBe(cmStorageRoot('claude', '/work/app'))
      const [a, b] = [cmStorageRoot('opencode', '/work/app', 'linux'), cmStorageRoot('opencode', '/other/app', 'linux')]
      expect(basename(a)).toBe(`app-${hash12('/work/app')}`)
      expect(basename(b)).toBe(`app-${hash12('/other/app')}`)
    })
  })

  test('trailing separators do not change the root; the file system root stays /', async () => {
    await withSandbox(async ({ buracleHome }) => {
      expect(cmStorageRoot('omp', '/work/app/', 'linux')).toBe(cmStorageRoot('omp', '/work/app', 'linux'))
      expect(cmStorageRoot('omp', '/work/app///', 'darwin')).toBe(cmStorageRoot('omp', '/work/app', 'darwin'))
      expect(cmStorageRoot('omp', '/', 'linux')).toBe(join(buracleHome, 'context-mode', 'omp', `root-${hash12('/')}`))
      expect(cmStorageRoot('omp', '///', 'linux')).toBe(cmStorageRoot('omp', '/', 'linux'))
    })
  })

  test('case folds on macOS and Windows, not on Linux', async () => {
    await withSandbox(async () => {
      expect(cmStorageRoot('codex', '/Work/App', 'darwin')).toBe(cmStorageRoot('codex', '/work/app', 'darwin'))
      expect(basename(cmStorageRoot('codex', '/Work/App', 'darwin'))).toBe(`app-${hash12('/work/app')}`)
      expect(cmStorageRoot('codex', '/Work/App', 'linux')).not.toBe(cmStorageRoot('codex', '/work/app', 'linux'))
      expect(basename(cmStorageRoot('codex', '/Work/App', 'linux'))).toBe(`app-${hash12('/Work/App')}`)
      expect(cmStorageRoot('codex', 'C:\\Work\\App\\', 'win32')).toBe(cmStorageRoot('codex', 'c:\\work\\app', 'win32'))
      expect(cmStorageRoot('codex', 'C:/Work/App/', 'win32')).toBe(cmStorageRoot('codex', 'C:\\Work\\App', 'win32'))
      expect(basename(cmStorageRoot('codex', 'C:\\Work\\App', 'win32'))).toBe(`app-${hash12('c:\\work\\app')}`)
      expect(basename(cmStorageRoot('codex', 'C:/Work/My Repo', 'win32'))).toBe(`my-repo-${hash12('c:\\work\\my repo')}`)
      expect(cmStorageRoot('codex', '/work/a\\b', 'linux')).not.toBe(cmStorageRoot('codex', '/work/a/b', 'linux'))
    })
  })

  test('the slug: lower case, - for runs of other characters, at most 24 characters, else root', async () => {
    await withSandbox(async () => {
      const slug = (dir: string): string => {
        const leaf = basename(cmStorageRoot('claude', dir, 'linux'))
        return leaf.slice(0, leaf.length - 13)
      }
      expect(slug('/Users/me/Desktop/Buracle Plugin/buracle')).toBe('buracle')
      expect(slug('/work/My Project (v2)!')).toBe('my-project-v2')
      expect(slug('/work/__init__')).toBe('init')
      expect(slug('/work/A Very Long Project Name That Goes On')).toBe('a-very-long-project-name')
      expect(slug('/work/abcdefghijklmnopqrstuvw xyz')).toBe('abcdefghijklmnopqrstuvw')
      expect(slug('/work/___')).toBe('root')
      expect(slug('/')).toBe('root')
      expect(slug('/work/back\\slash')).toBe('back-slash')
    })
  })

  test('the probe root and the sentinel folder sit beside the harness roots', async () => {
    await withSandbox(async ({ buracleHome }) => {
      expect(cmProbeRoot()).toBe(join(buracleHome, 'context-mode', 'probe'))
      expect(cmSentinelDir()).toBe(join(buracleHome, 'context-mode', 'sentinel'))
    })
  })

  test('ensureCmDirs creates the project root with its sessions folder and the sentinel folder, private to the user', async () => {
    await withSandbox(async () => {
      ensureCmDirs('claude', '/work/app')
      const root = cmStorageRoot('claude', '/work/app')
      const made = [dirname(dirname(root)), dirname(root), root, cmSessionsDir(root), cmSentinelDir()]
      for (const p of made) expect(existsSync(p)).toBe(true)
      if (process.platform !== 'win32') for (const p of made) expect({ p, mode: statSync(p).mode & 0o777 }).toEqual({ p, mode: 0o700 })
      expect(existsSync(cmSessionsDir(cmStorageRoot('claude', '/work/other')))).toBe(false)
    })
  })
})

describe('the toolchain copy', () => {
  test('undefined until the toolchain holds it', () => {
    expect(cmPackage(emptyToolchainState())).toBeUndefined()
  })

  test('the package folder inside the npm prefix', () => {
    const s = emptyToolchainState()
    s.packages['npm:context-mode'] = { registry: 'npm', name: 'context-mode', version: '1.0.169', dir: '/tc/npm/context-mode', bins: { 'context-mode': '/tc/npm/context-mode/node_modules/context-mode/cli.bundle.mjs' }, installed_at: 'x' }
    expect(cmPackage(s)).toEqual({ root: '/tc/npm/context-mode/node_modules/context-mode', version: '1.0.169', dir: '/tc/npm/context-mode' })
  })
})

describe('the project folder', () => {
  const realpath = (p: string): string => p.replace(/^\/tmp\//, '/private/tmp/')

  test('Claude Code: CLAUDE_PROJECT_DIR verbatim', () => {
    expect(cmProjectDir('claude', { claudeProjectDir: '/tmp/proj', cwd: '/tmp/proj/src', realpath })).toBe('/tmp/proj')
  })

  test('without CLAUDE_PROJECT_DIR and on the other harnesses: the real path of cwd', () => {
    expect(cmProjectDir('claude', { cwd: '/tmp/proj', realpath })).toBe('/private/tmp/proj')
    expect(cmProjectDir('codex', { claudeProjectDir: '/x', cwd: '/tmp/proj', realpath })).toBe('/private/tmp/proj')
    expect(cmProjectDir('omp', { cwd: '/gone', realpath: () => { throw new Error('ENOENT') } })).toBe('/gone')
  })
})

describe('the MCP server environment', () => {
  const realpath = (p: string): string => p

  test('a harness platform gets the root of its project, the sentinel folder, the project folder and PWD', async () => {
    await withSandbox(async () => {
      const env = cmServerEnv({ CONTEXT_MODE_PLATFORM: 'codex', PATH: '/bin', PWD: '/stale' }, { cwd: '/work/app', realpath, platform: 'linux' })
      expect(env).toEqual({
        CONTEXT_MODE_PLATFORM: 'codex', PATH: '/bin', PWD: '/work/app', CONTEXT_MODE_DIR: cmStorageRoot('codex', '/work/app', 'linux'),
        CONTEXT_MODE_MCP_SENTINEL_DIR: cmSentinelDir(), CONTEXT_MODE_PROJECT_DIR: '/work/app',
      })
    })
  })

  test('the root follows the real path of cwd, so every project of a harness gets its own', async () => {
    await withSandbox(async () => {
      const real = (p: string): string => p.replace(/^\/tmp\//, '/private/tmp/')
      const a = cmServerEnv({ CONTEXT_MODE_PLATFORM: 'opencode' }, { cwd: '/tmp/a', realpath: real })
      const b = cmServerEnv({ CONTEXT_MODE_PLATFORM: 'opencode' }, { cwd: '/tmp/b', realpath: real })
      expect(a['CONTEXT_MODE_DIR']).toBe(cmStorageRoot('opencode', '/private/tmp/a'))
      expect(b['CONTEXT_MODE_DIR']).toBe(cmStorageRoot('opencode', '/private/tmp/b'))
      expect(a['CONTEXT_MODE_DIR']).not.toBe(b['CONTEXT_MODE_DIR'])
      expect(a['CONTEXT_MODE_PROJECT_DIR']).toBe('/private/tmp/a')
    })
  })

  test('Claude Code: CLAUDE_PROJECT_DIR is the project folder and keys the root; no override', async () => {
    await withSandbox(async () => {
      const env = cmServerEnv({ CONTEXT_MODE_PLATFORM: 'claude-code', CLAUDE_PROJECT_DIR: '/work/app' }, { cwd: '/work/app/sub', realpath })
      expect(env['CONTEXT_MODE_DIR']).toBe(cmStorageRoot('claude', '/work/app'))
      expect(env['CONTEXT_MODE_PROJECT_DIR']).toBeUndefined()
      expect(env['CLAUDE_PROJECT_DIR']).toBe('/work/app')
      expect(cmServerEnv({ CONTEXT_MODE_PLATFORM: 'claude-code', CLAUDE_PROJECT_DIR: '/work/app/' }, { cwd: '/elsewhere', realpath })['CONTEXT_MODE_DIR']).toBe(cmStorageRoot('claude', '/work/app'))
      const bare = cmServerEnv({ CONTEXT_MODE_PLATFORM: 'claude-code' }, { cwd: '/work/app/sub', realpath })
      expect(bare['CONTEXT_MODE_DIR']).toBe(cmStorageRoot('claude', '/work/app/sub'))
      expect(bare['CONTEXT_MODE_PROJECT_DIR']).toBe('/work/app/sub')
    })
  })

  test('omp: PI_CODING_AGENT_DIR is dropped (context-mode would take it for the project)', async () => {
    await withSandbox(async () => {
      const env = cmServerEnv({ CONTEXT_MODE_PLATFORM: 'omp', PI_CODING_AGENT_DIR: '/home/u/.omp/agent' }, { cwd: '/work/app', realpath })
      expect(env['PI_CODING_AGENT_DIR']).toBeUndefined()
      expect(env['CONTEXT_MODE_PROJECT_DIR']).toBe('/work/app')
      expect(env['CONTEXT_MODE_DIR']).toBe(cmStorageRoot('omp', '/work/app'))
    })
  })

  test('a harness platform replaces an inherited storage root and project folder (a user\'s export, or a harness started from a ctx_execute command); without one the values already set win', async () => {
    await withSandbox(async () => {
      const inherited = { CONTEXT_MODE_DIR: '/custom', CONTEXT_MODE_PROJECT_DIR: '/p', PWD: '/p', CONTEXT_MODE_MCP_SENTINEL_DIR: '/s' }
      for (const h of ['codex', 'opencode', 'omp'] as const) {
        const env = cmServerEnv({ CONTEXT_MODE_PLATFORM: cmPlatform(h), ...inherited }, { cwd: '/elsewhere', realpath })
        expect({ h, dir: env['CONTEXT_MODE_DIR'], project: env['CONTEXT_MODE_PROJECT_DIR'], pwd: env['PWD'] })
          .toEqual({ h, dir: cmStorageRoot(h, '/elsewhere'), project: '/elsewhere', pwd: '/elsewhere' })
        expect(env['CONTEXT_MODE_MCP_SENTINEL_DIR']).toBe('/s')
      }
      expect(cmServerEnv({ CONTEXT_MODE_PLATFORM: 'claude-code', CLAUDE_PROJECT_DIR: '/work/app', ...inherited }, { cwd: '/elsewhere', realpath }))
        .toMatchObject({ CONTEXT_MODE_DIR: cmStorageRoot('claude', '/work/app'), CONTEXT_MODE_PROJECT_DIR: '/p', PWD: '/p' })
      expect(cmServerEnv({ CONTEXT_MODE_PLATFORM: 'claude-code', ...inherited }, { cwd: '/elsewhere', realpath }))
        .toMatchObject({ CONTEXT_MODE_DIR: cmStorageRoot('claude', '/elsewhere'), CONTEXT_MODE_PROJECT_DIR: '/elsewhere', PWD: '/elsewhere' })
      expect(cmServerEnv(inherited, { cwd: '/w', realpath })).toMatchObject(inherited)
      const probe = cmServerEnv({}, { cwd: '/w', realpath })
      expect(probe['CONTEXT_MODE_DIR']).toBe(cmProbeRoot())
      expect(probe['CONTEXT_MODE_MCP_SENTINEL_DIR']).toBe(cmSentinelDir())
      expect(probe['CONTEXT_MODE_PROJECT_DIR']).toBe('/w')
      expect(cmServerEnv({ CONTEXT_MODE_PLATFORM: 'omp', CONTEXT_MODE_DIR: ' ', CONTEXT_MODE_MCP_SENTINEL_DIR: '' }, { cwd: '/w', realpath })).toMatchObject({
        CONTEXT_MODE_DIR: cmStorageRoot('omp', '/w'), CONTEXT_MODE_MCP_SENTINEL_DIR: cmSentinelDir(),
      })
      expect(cmServerEnv({ CONTEXT_MODE_DIR: ' ' }, { cwd: '/w', realpath })['CONTEXT_MODE_DIR']).toBe(cmProbeRoot())
    })
  })

  test("Codex: PATH loses Codex's arg0 helper folders (apply_patch) and keeps every other entry in order", async () => {
    await withSandbox(async () => {
      const path = [
        '/Users/u/.codex/tmp/arg0/codex-arg0kQ74cT', '/opt/homebrew/Caskroom/codex/0.161.0/codex-path', '/usr/bin', '',
        '/sb/home/.codex/tmp/arg0/codex-arg0u3djfS/', '/opt/tmp/arg0/other', '/x/tmp/arg0/codex-arg0abc/bin', '/bin',
      ].join(':')
      const env = cmServerEnv({ CONTEXT_MODE_PLATFORM: 'codex', PATH: path }, { cwd: '/work/app', realpath, platform: 'darwin' })
      expect(env['PATH']).toBe(['/opt/homebrew/Caskroom/codex/0.161.0/codex-path', '/usr/bin', '', '/opt/tmp/arg0/other', '/x/tmp/arg0/codex-arg0abc/bin', '/bin'].join(':'))
      const win = cmServerEnv({ CONTEXT_MODE_PLATFORM: 'codex', Path: 'C:\\Users\\u\\.codex\\tmp\\arg0\\codex-arg0Ab12;C:\\Windows\\System32' }, { cwd: 'C:\\work', realpath, platform: 'win32' })
      expect(win['Path']).toBe('C:\\Windows\\System32')
      expect(cmServerEnv({ CONTEXT_MODE_PLATFORM: 'codex' }, { cwd: '/w', realpath })['PATH']).toBeUndefined()
    })
  })

  test('the other harnesses and the probe keep PATH as it is', async () => {
    await withSandbox(async () => {
      const path = '/Users/u/.codex/tmp/arg0/codex-arg0kQ74cT:/usr/bin'
      for (const p of ['claude-code', 'opencode', 'omp', undefined]) {
        expect(cmServerEnv({ CONTEXT_MODE_PLATFORM: p, PATH: path }, { cwd: '/w', realpath })['PATH']).toBe(path)
      }
    })
  })
})

describe("context-mode's own Claude Code plugin in Claude's plugin registry", () => {
  const registry = (dir: string, plugins: unknown): string => {
    const file = join(dir, 'plugins', 'installed_plugins.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof plugins === 'string' ? plugins : JSON.stringify({ version: 2, plugins }))
    return file
  }
  const cached = (dir: string, version: string): string => join(dir, 'plugins', 'cache', 'context-mode', 'context-mode', version)

  test('a context-mode@context-mode folder in the plugin cache that is gone: the folder the server would link itself into', async () => {
    await withSandbox(async ({ root, home }) => {
      const claude = join(home, '.claude')
      const [gone, there] = [cached(claude, '1.0.160'), cached(claude, '1.0.169')]
      mkdirSync(there, { recursive: true })
      registry(claude, { 'context-mode@context-mode': [{ scope: 'user', installPath: gone, version: '1.0.160' }, { scope: 'project', installPath: there, version: '1.0.169' }], 'buracle@buracle': [{ installPath: cached(claude, 'b') }] })
      expect(cmEmptyClaudeConfigDir()).toBe(join(cmHome(), 'claude-config-empty'))
      expect(cmStaleClaudePlugin({ HOME: home }, { cwd: root })).toEqual([gone])
      expect(cmStaleClaudePlugin({ HOME: home, CLAUDE_CONFIG_DIR: '  ' }, { cwd: root })).toEqual([gone])
      mkdirSync(gone, { recursive: true })
      expect(cmStaleClaudePlugin({ HOME: home }, { cwd: root })).toEqual([])
    })
  })

  test('CLAUDE_CONFIG_DIR moves the registry: an absolute folder, a leading ~ (the home folder) or a folder relative to the server\'s', async () => {
    await withSandbox(async ({ root, home }) => {
      const forms: Array<[string, string]> = [[join(root, 'abs'), join(root, 'abs')], ['~/alt', join(home, 'alt')], ['rel', join(root, 'rel')]]
      for (const [value, dir] of forms) {
        registry(dir, { 'context-mode@context-mode': [{ installPath: cached(dir, '1.0.160') }] })
        expect({ value, stale: cmStaleClaudePlugin({ HOME: home, CLAUDE_CONFIG_DIR: value }, { cwd: root }) }).toEqual({ value, stale: [cached(dir, '1.0.160')] })
      }
      expect(cmStaleClaudePlugin({ HOME: home }, { cwd: root })).toEqual([])
    })
  })

  test('nothing to re-link: another plugin, a folder outside the plugin cache, no or a broken registry', async () => {
    await withSandbox(async ({ root, home }) => {
      const claude = join(home, '.claude')
      const stale = (): string[] => cmStaleClaudePlugin({ HOME: home }, { cwd: root })
      expect(stale()).toEqual([])
      registry(claude, { 'context-mode@other': [{ installPath: cached(claude, '1') }], 'context-mode@context-mode': [{ installPath: join(root, 'elsewhere', 'gone') }, { installPath: '' }, { installPath: 7 }, null, { version: '1' }] })
      expect(stale()).toEqual([])
      registry(claude, { 'context-mode@context-mode': { installPath: cached(claude, '1') } })
      expect(stale()).toEqual([])
      registry(claude, '{ "plugins": { "context-mode@context-mode": [ { "installPath": "x" } ] }, }')
      expect(stale()).toEqual([])
    })
  })

  test('the plugin cache is compared by its real path, as context-mode does', async () => {
    await withSandbox(async ({ root, home }) => {
      const claude = join(home, '.claude')
      const real = join(root, 'volume', 'cache')
      mkdirSync(real, { recursive: true })
      mkdirSync(join(claude, 'plugins'), { recursive: true })
      symlinkSync(real, join(claude, 'plugins', 'cache'))
      const viaReal = join(real, 'context-mode', 'context-mode', '1.0.160')
      registry(claude, { 'context-mode@context-mode': [{ installPath: viaReal }, { installPath: cached(claude, '1.0.161') }] })
      expect(cmStaleClaudePlugin({ HOME: home }, { cwd: root })).toEqual([viaReal])
    })
  })
})

describe('reading the real toolchain state', () => {
  test('cmPackage reads toolchain.json of BURACLE_HOME', async () => {
    await withSandbox(async ({ buracleHome }) => {
      mkdirSync(join(buracleHome, 'state'), { recursive: true })
      writeFileSync(join(buracleHome, 'state', 'toolchain.json'), JSON.stringify({
        v: 1, updated_at: 'x', system: {},
        packages: { 'npm:context-mode': { registry: 'npm', name: 'context-mode', version: '2.0.0', dir: '/p', bins: { 'context-mode': '/p/node_modules/context-mode/cli.bundle.mjs' }, installed_at: 'x' } },
      }))
      expect(cmPackage()?.version).toBe('2.0.0')
    })
  })
})

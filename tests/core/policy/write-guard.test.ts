import { describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyTool } from '../../../src/core/events'
import { checkWrite, credentialLocation, protectGlobToRegExp, realpathQueries, type WriteGuardContext } from '../../../src/core/policy/write-guard'
import { withSandbox } from '../../helpers/sandbox'

const HOME = '/Users/u'
const CWD = '/Users/u/code/app'
const ctx: WriteGuardContext = { cwd: CWD, home: HOME, vault: '~/Documents/Buracle', protect: [] }
const deny = (paths: string[], extra: Partial<WriteGuardContext> = {}): string | undefined => checkWrite(paths, { ...ctx, ...extra }).deny

describe('checkWrite: allowed project files', () => {
  const ok = [
    'src/index.ts', './README.md', '/Users/u/code/app/tests/a.test.ts', '.env.example', 'config/.env.sample', '.env.template', '.env.local.example',
    'src/credentials.ts', 'src/auth/credentials_test.py', 'docs/credentials.md', 'keys.ts', 'src/env.ts', 'environment.yml', 'id_test.go',
    '/Users/u/Documents/Buracle/projects/app/decisions/2026-10-08-x.md', '/Users/u/Documents/Buracle/inbox/note.md', '/Users/u/.claude/CLAUDE.md',
    '/tmp/x/env.sh', 'harness/README.md', '.github/workflows/ci.yml', '.gitignore', 'monkey.pemx',
  ]
  for (const p of ok) test(`allows ${p}`, () => expect(checkWrite([p], ctx)).toEqual({}))
})

describe('checkWrite: secrets and credentials', () => {
  const cases: Array<[string, string]> = [
    ['.env', 'environment secrets'], ['.env.local', 'environment secrets'], ['config/.env.production', 'environment secrets'], ['.envrc', 'environment secrets'],
    ['/Users/u/code/other/.ENV', 'environment secrets'], ['certs/server.pem', 'private key'], ['tls/server.key', 'private key'], ['store.p12', 'private key'],
    ['id_rsa', 'SSH key'], ['deploy/id_ed25519.pub', 'SSH key'], ['keys/id_ecdsa', 'SSH key'], ['credentials.json', 'credentials file'],
    ['secrets/credentials', 'credentials file'], ['config/credentials.yml.enc', 'credentials file'], ['~/.ssh/config', "user's SSH directory"],
    ['/Users/u/.ssh/authorized_keys', "user's SSH directory"], ['/Users/u/.SSH/known_hosts', "user's SSH directory"], ['~/.aws/credentials', 'AWS credentials'],
    ['/Users/u/.aws/config', 'AWS credentials'],
  ]
  for (const [p, why] of cases) {
    test(`denies ${p}`, () => {
      const reason = deny([p])
      expect(reason).toContain(why)
      expect(reason?.trim().endsWith('.')).toBe(true)
    })
  }

  test('the .env reason points to .env.example', () => {
    expect(deny(['.env'])).toContain('.env.example')
  })

  test('paths are shown relative to home', () => {
    expect(deny(['/Users/u/.ssh/config'])).toContain('`~/.ssh/config`')
  })
})

describe('checkWrite: Buracle-managed locations', () => {
  test('~/.buracle/state is changed through the CLI only', () => {
    const reason = deny(['/Users/u/.buracle/state/owned.json'])
    expect(reason).toContain('buracle CLI')
    expect(reason).toContain("Buracle's own state")
    expect(deny(['~/.buracle/state/memory/spool/x.jsonl'])).toBeDefined()
    expect(deny(['/Users/u/.buracle/statefile'])).toContain("Buracle's own installation")
    expect(deny(['/Users/u/.buracle/statefile'])).not.toContain("Buracle's own state")
  })

  test('vault internals (.obsidian, .git) are protected; notes are not', () => {
    expect(deny(['/Users/u/Documents/Buracle/.obsidian/app.json'])).toContain('Obsidian')
    expect(deny(['/Users/u/Documents/Buracle/.git/config'])).toContain('git internals')
    expect(deny(['../../Documents/Buracle/.obsidian/workspace.json'])).toContain('Obsidian')
    expect(deny(['/Users/u/Documents/Buracle/.buracle/state.json'])).toContain('buracle CLI')
    expect(deny(['/elsewhere/.obsidian/app.json'])).toBeUndefined()
    expect(deny(['/Users/u/Documents/Buracle/.git/config'], { vault: '' })).toBeUndefined()
    expect(deny(['/v/.obsidian/x'], { vault: '/v' })).toBeDefined()
  })

  test('the generated harness/ tree is protected inside the Buracle repo (explicit root)', () => {
    const repo = '/Users/u/code/buracle'
    const reason = deny([`${repo}/harness/claude/hooks/register.tsx`], { cwd: repo, buracleRepo: repo })
    expect(reason).toContain('buracle build')
    expect(reason).toContain('canonical/')
    expect(deny(['harness/codex/hooks.json'], { cwd: repo, buracleRepo: repo })).toBeDefined()
    expect(deny(['../harness/notes.md'], { cwd: `${repo}/src`, buracleRepo: repo })).toBeDefined()
    expect(deny(['harness/notes.md'], { cwd: `${repo}/src`, buracleRepo: repo })).toBeUndefined()
    expect(deny(['harness/claude/x.ts'], { cwd: '/Users/u/code/app', buracleRepo: repo })).toBeUndefined()
    expect(deny([`${repo}/canonical/hooks.yaml`], { cwd: repo, buracleRepo: repo })).toBeUndefined()
  })

  test('without an explicit root the repo is recognized from the generated tree layout', () => {
    const repo = '/Users/u/Desktop/Buracle Plugin/buracle'
    expect(deny([`${repo}/harness/claude/skills/plan-build/SKILL.md`], { cwd: repo })).toContain('buracle build')
    expect(deny(['harness/agents-skills/plan-build/SKILL.md'], { cwd: repo })).toBeDefined()
    expect(deny([`${repo}/harness/claude/x`], { cwd: '/tmp' })).toBeUndefined()
    expect(deny(['harness/unrelated/file.txt'], { cwd: repo })).toBeUndefined()
  })
})

describe("checkWrite: Buracle's own setup (SEC-1)", () => {
  const cases: Array<[string, string]> = [
    ['~/.buracle/bin/buracle', "Buracle's own installation"], ['~/.buracle/bin/buracle.cmd', "Buracle's own installation"],
    ['~/.buracle/config.yaml', "Buracle's own installation"], ['/Users/u/.buracle/rules/paths/typescript.md', "Buracle's own installation"],
    ['~/.buracle/toolchain/npm/x/package.json', "Buracle's own installation"], ['~/.buracle/logs/buracle.log', "Buracle's own installation"],
    ['~/.buracle/sessions/claude/s1/consent.json', "Buracle's own installation"],
    ['~/.local/bin/buracle', '`buracle` command on PATH'], ['/Users/u/.local/bin/buracle.cmd', '`buracle` command on PATH'],
    ['~/.claude/settings.json', "Claude Code's own configuration"], ['~/.claude/settings.local.json', "Claude Code's own configuration"],
    ['~/.claude/plugins/cache/buracle/buracle/0.3.0/hooks/hooks.json', "Claude Code's own configuration"], ['~/.claude/plugins/installed_plugins.json', "Claude Code's own configuration"],
    ['~/.codex/config.toml', "Codex's own configuration"], ['~/.codex/hooks.json', "Codex's own configuration"], ['~/.codex/rules/buracle.rules', "Codex's own configuration"],
    ['~/.config/opencode/opencode.json', "OpenCode's own configuration"], ['~/.config/opencode/opencode.jsonc', "OpenCode's own configuration"],
    ['~/.config/opencode/cli.json', "OpenCode's own configuration"], ['~/.config/opencode/plugins/buracle/index.js', "OpenCode's own configuration"],
    ['~/.omp/agent/config.yml', "omp's own configuration"], ['~/.omp/agent/config.yaml', "omp's own configuration"], ['~/.omp/agent/extensions/x.ts', "omp's own configuration"],
    ['~/.omp/agent/hooks/pre/x.ts', "omp's own configuration"], ['~/.omp/plugins/node_modules/buracle-omp/package.json', "omp's own configuration"],
  ]
  for (const [p, why] of cases) {
    test(`denies ${p}`, () => {
      const reason = deny([p])
      expect(reason).toContain(why)
      expect(reason?.trim().endsWith('.')).toBe(true)
      expect(reason).toContain(';')
    })
  }

  test('the reasons name the way to make the change instead', () => {
    expect(deny(['~/.buracle/config.yaml'])).toContain('`buracle config set …`')
    expect(deny(['~/.buracle/bin/buracle'])).toContain('`buracle install`')
    expect(deny(['~/.local/bin/buracle'])).toContain('`buracle install`')
    for (const p of ['~/.claude/settings.json', '~/.codex/hooks.json', '~/.config/opencode/opencode.json', '~/.omp/agent/config.yml']) {
      expect(deny([p])).toContain('ask the user to make this change themselves')
    }
    expect(deny(['~/.claude/settings.json'])).toContain('`claude plugin …`')
    expect(deny(['~/.codex/config.toml'])).toContain('`codex features …`')
    expect(deny(['~/.config/opencode/cli.json'])).toContain('`opencode plugin …`')
    expect(deny(['~/.omp/agent/config.yml'])).toContain('`omp config set …`')
    expect(deny(['~/.buracle/config.yaml'])).toStartWith('`~/.buracle/config.yaml` ')
  })

  test('neighbouring files the agent may write stay allowed', () => {
    for (const p of ['~/.claude/CLAUDE.md', '~/.claude/projects/app/s1.jsonl', '~/.claude/agents/x.md', '~/.codex/AGENTS.md', '~/.codex/agents/r.toml',
      '~/.omp/agent/AGENTS.md', '~/.omp/agent/mcp.json', '~/.config/nvim/init.lua', '~/.config/opencode-old/x.json', '~/.local/bin/tool',
      '~/.local/share/opencode/log.txt', '~/.buracle-old/config.yaml', '~/.buraclex', '~/.claudeX/settings.json', '~/.cache/buracle/x']) {
      expect({ p, deny: deny([p]) }).toEqual({ p, deny: undefined })
    }
    for (const p of ['/Users/u/code/app/.claude/settings.json', '/Users/u/code/app/.codex/config.toml', '/Users/u/code/app/opencode.json']) {
      expect({ p, deny: deny([p], { contents: { [p]: { after: '' } } }) }).toEqual({ p, deny: undefined })
      expect(deny([p])).toContain('file edit or whole-file write tool')
    }
  })

  test('spelling: case, `..` and file:// URLs do not get around it', () => {
    expect(deny(['/Users/u/.Buracle/BIN/buracle'])).toContain("Buracle's own installation")
    expect(deny(['/Users/u/.CLAUDE/Settings.json'])).toContain('Claude Code')
    expect(deny(['../../.codex/hooks.json'])).toContain('Codex')
    expect(deny(['file:///Users/u/.local/bin/buracle'])).toContain('`buracle` command on PATH')
  })

  test('the home folder a path names is recognized, also when it is not ctx.home', () => {
    expect(deny(['/Users/other/.buracle/bin/buracle'])).toContain("Buracle's own installation")
    expect(deny(['/home/runner/.codex/hooks.json'])).toContain('Codex')
    expect(deny(['/root/.claude/settings.json'])).toContain('Claude Code')
    expect(deny(['/var/root/.config/opencode/opencode.json'])).toContain('OpenCode')
    expect(deny(['/Users/u/code/other/.buracle/bin/buracle'])).toBeUndefined()
  })

  test('relocated roots (BURACLE_HOME, CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME, PI_CODING_AGENT_DIR) are honored', () => {
    const selfPaths = { buracleHome: '/opt/buracle', claudeDir: '/cfg/claude', codexHome: '/cfg/codex', opencodeConfigDir: '/xdg/opencode', ompAgentDir: '/cfg/omp' }
    expect(deny(['/opt/buracle/bin/buracle'], { selfPaths })).toContain("Buracle's own installation")
    expect(deny(['/opt/buracle/state/owned.json'], { selfPaths })).toContain("Buracle's own state")
    expect(deny(['/cfg/claude/settings.json'], { selfPaths })).toContain('Claude Code')
    expect(deny(['/cfg/claude/plugins/x/hooks/hooks.json'], { selfPaths })).toContain('Claude Code')
    expect(deny(['/cfg/codex/config.toml'], { selfPaths })).toContain('Codex')
    expect(deny(['/xdg/opencode/opencode.json'], { selfPaths })).toContain('OpenCode')
    expect(deny(['/cfg/omp/extensions/a.ts'], { selfPaths })).toContain('omp')
    expect(deny(['~/.claude/settings.json'], { selfPaths })).toContain('Claude Code')
    for (const p of ['/cfg/claude/CLAUDE.md', '/cfg/codex/AGENTS.md', '/cfg/omp/AGENTS.md', '/opt/other/x']) expect(deny([p], { selfPaths })).toBeUndefined()
    expect(deny(['/cfg/claude/settings.json'])).toBeUndefined()
  })

  test('a relocated root that covers /, the home folder or the project is ignored rather than refusing everything', () => {
    for (const selfPaths of [{ buracleHome: '/' }, { buracleHome: '/Users/u' }, { opencodeConfigDir: '/Users/u/code' }, { buracleHome: '/Users' }, { buracleHome: 'relative/dir' }]) {
      expect({ selfPaths, deny: deny(['src/index.ts'], { selfPaths }) }).toEqual({ selfPaths, deny: undefined })
    }
    expect(deny(['/Users/u/hooks.json'], { selfPaths: { codexHome: '/Users/u' } })).toContain('Codex')
    expect(deny(['/Users/u/notes.md'], { selfPaths: { codexHome: '/Users/u' } })).toBeUndefined()
  })
})

describe('checkWrite: the Buracle checkout, from an unrelated session', () => {
  const repo = '/Users/u/Desktop/Buracle Plugin/buracle'
  const selfPaths = { repo }
  const SOURCE = "Buracle's own source code"

  test('a session in another project cannot write anywhere in the checkout', () => {
    for (const p of [
      `${repo}/src/cli/main.ts`, `${repo}/src/core/policy/write-guard.ts`, `${repo}/harness/omp/extensions/buracle.js`, `${repo}/canonical/hooks.yaml`,
      `${repo}/package.json`, `${repo}/.git/hooks/pre-commit`, repo, '../../Desktop/Buracle Plugin/buracle/src/a.ts', '~/Desktop/Buracle Plugin/buracle/src/a.ts',
      '/USERS/u/desktop/Buracle Plugin/BURACLE/src/a.ts',
    ]) {
      expect({ p, reason: deny([p], { selfPaths }) }).toEqual({ p, reason: expect.stringContaining(SOURCE) })
    }
  })

  test('the reason says what the checkout is and where to change it instead', () => {
    const reason = deny([`${repo}/src/cli/main.ts`], { selfPaths }) as string
    expect(reason).toStartWith('`~/Desktop/Buracle Plugin/buracle/src/cli/main.ts` ')
    expect(reason).toContain('every Buracle hook runs')
    expect(reason).toContain('a session opened in the Buracle repository')
    expect(reason).toContain('ask the user')
    expect(reason.trim().endsWith('.')).toBe(true)
  })

  test('inside the checkout, or from a folder that holds it, the normal rules apply', () => {
    for (const cwd of [repo, `${repo}/src`, `${repo}/.claude/worktrees/w1`, '/Users/u/Desktop/Buracle Plugin', '/Users/u/Desktop', HOME, '/']) {
      expect({ cwd, deny: deny([`${repo}/src/cli/main.ts`], { cwd, selfPaths }) }).toEqual({ cwd, deny: undefined })
    }
    expect(deny([`${repo}/harness/claude/hooks/hooks.json`], { cwd: repo, selfPaths, buracleRepo: repo })).toContain('buracle build')
    expect(deny([`${repo}/src/cli/main.ts`], { cwd: '', selfPaths })).toBeUndefined()
  })

  test('folders next to the checkout and the project itself stay writable; an unusable value is ignored', () => {
    for (const p of ['/Users/u/Desktop/Buracle Plugin/notes.md', '/Users/u/Desktop/Buracle Plugin/buracle-old/x.ts', '/Users/u/Desktop/Buracle Plugin/buraclex', 'src/index.ts', '/tmp/x']) {
      expect({ p, deny: deny([p], { selfPaths }) }).toEqual({ p, deny: undefined })
    }
    for (const r of ['/', 'relative/buracle', '', '~/code/buracle', HOME, '/Users']) {
      expect({ r, deny: deny(['src/index.ts', '/tmp/x', '/Users/u/notes.md'], { cwd: '/srv/work', selfPaths: { repo: r } }) }).toEqual({ r, deny: undefined })
    }
  })

  test('symlinks: a project link into the checkout, and a checkout or session folder reached through a link', () => {
    const resolve = (links: Record<string, string>) => (p: string): string | undefined => {
      for (const [from, to] of Object.entries(links)) if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length)
      return undefined
    }
    expect(deny(['vendor/b/src/cli/main.ts'], { selfPaths, realpath: resolve({ '/Users/u/code/app/vendor/b': repo }) })).toContain(SOURCE)
    expect(deny(['/data/buracle/src/a.ts'], { selfPaths: { repo: '/links/buracle' }, realpath: resolve({ '/links/buracle': '/data/buracle' }) })).toContain(SOURCE)
    const linkedSession = { cwd: '/links/buracle/src', selfPaths: { repo: '/data/buracle' }, realpath: resolve({ '/links/buracle': '/data/buracle' }) }
    expect(deny(['/links/buracle/src/a.ts'], linkedSession)).toBeUndefined()
    expect(deny(['/data/buracle/src/a.ts'], linkedSession)).toBeUndefined()
  })
})

describe('checkWrite: guards.write.protect globs', () => {
  test('file-name patterns match anywhere', () => {
    expect(deny(['data/app.sqlite'], { protect: ['*.sqlite'] })).toContain('`*.sqlite`')
    expect(deny(['data/APP.SQLITE'], { protect: ['*.sqlite'] })).toBeDefined()
    expect(deny(['data/app.db'], { protect: ['*.sqlite'] })).toBeUndefined()
  })

  test('relative patterns are relative to the project', () => {
    expect(deny(['docs/legal/terms.md'], { protect: ['docs/legal/*.md'] })).toBeDefined()
    expect(deny(['docs/legal/sub/terms.md'], { protect: ['docs/legal/*.md'] })).toBeUndefined()
    expect(deny(['docs/legal/sub/terms.md'], { protect: ['docs/legal/**'] })).toBeDefined()
    expect(deny(['a/b/secrets/x.txt'], { protect: ['**/secrets/**'] })).toBeDefined()
    expect(deny(['/elsewhere/docs/legal/terms.md'], { protect: ['docs/legal/*.md'] })).toBeUndefined()
  })

  test('absolute and home patterns, braces and classes', () => {
    expect(deny(['/Users/u/notes/a.md'], { protect: ['~/notes/**'] })).toBeDefined()
    expect(deny(['/etc/hosts'], { protect: ['/etc/*'] })).toBeDefined()
    expect(deny(['src/gen/a.ts'], { protect: ['src/{gen,generated}/**'] })).toBeDefined()
    expect(deny(['src/generated/a.ts'], { protect: ['src/{gen,generated}/**'] })).toBeDefined()
    expect(deny(['v1.lock'], { protect: ['v[0-9].lock'] })).toBeDefined()
    expect(deny(['vx.lock'], { protect: ['v[0-9].lock'] })).toBeUndefined()
  })

  test('invalid or empty patterns are ignored', () => {
    expect(deny(['a.ts'], { protect: ['', '   ', '[', null as unknown as string] })).toBeUndefined()
  })

  test('glob compiler semantics', () => {
    const re = protectGlobToRegExp('src/**/*.ts')
    expect(re?.test('src/a.ts')).toBe(true)
    expect(re?.test('src/x/y/a.ts')).toBe(true)
    expect(re?.test('srcx/a.ts')).toBe(false)
    expect(protectGlobToRegExp('a?c')?.test('abc')).toBe(true)
    expect(protectGlobToRegExp('a?c')?.test('a/c')).toBe(false)
    expect(protectGlobToRegExp('*.md')?.test('dir/a.md')).toBe(false)
  })
})

describe('checkWrite: inputs', () => {
  test('returns the first protected path of several', () => {
    expect(deny(['src/a.ts', '.env', 'id_rsa'])).toContain('.env')
  })

  test('resolves relative paths, `..` and file:// URLs against cwd', () => {
    expect(deny(['src/../.env'])).toContain('.env')
    expect(deny(['file:///Users/u/.ssh/config'])).toBeDefined()
    expect(deny(['../../.aws/credentials'], { cwd: '/Users/u/code' })).toBeDefined()
  })

  test('ignores empty entries and tolerates a malformed context', () => {
    expect(checkWrite(['', '   '], ctx)).toEqual({})
    expect(checkWrite(undefined as unknown as string[], ctx)).toEqual({})
    expect(checkWrite(['.env'], { cwd: '', home: '', vault: '', protect: [] }).deny).toBeDefined()
    expect(checkWrite(['/Users/u/.ssh/x'], { cwd: '', home: '', vault: '', protect: [] })).toEqual({})
  })
})

describe('checkWrite: `~/` paths of tools that resolve them against the home folder', () => {
  const home = { homeTilde: HOME }

  test('a write or an edit to ~/.ssh or ~/.aws is denied', () => {
    for (const [tool, input] of [
      ['write', { path: '~/.ssh/authorized_keys', content: 'ssh-ed25519 AAAA x' }],
      ['edit', { path: '~/.aws/credentials', oldString: 'a', newString: 'b' }],
      ['patch', { patchText: '*** Begin Patch\n*** Add File: ~/.ssh/config\n+Host *\n*** End Patch' }],
    ] as const) {
      const call = classifyTool('opencode', tool, { ...input }, CWD, undefined, home)
      expect({ tool, deny: deny(call.paths) }).toEqual({ tool, deny: expect.stringContaining('`~/.') })
    }
    expect(deny(classifyTool('omp', 'write', { path: '~/.ssh/authorized_keys', content: 'x' }, CWD, undefined, home).paths)).toContain("user's SSH directory")
  })

  test('without the option the target is hidden: `<cwd>/~/.ssh/...` is an ordinary project path', () => {
    const call = classifyTool('opencode', 'write', { path: '~/.ssh/authorized_keys', content: 'x' }, CWD)
    expect(call.paths).toEqual(['/Users/u/code/app/~/.ssh/authorized_keys'])
    expect(deny(call.paths)).toBeUndefined()
  })

  test('ordinary files in the home folder or the project still pass', () => {
    expect(deny(classifyTool('opencode', 'write', { path: '~/notes/todo.md', content: 'x' }, CWD, undefined, home).paths)).toBeUndefined()
    expect(deny(classifyTool('opencode', 'write', { path: 'src/~draft.ts', content: 'x' }, CWD, undefined, home).paths)).toBeUndefined()
  })
})

describe('checkWrite: symlinks resolved through ctx.realpath', () => {
  const fakeFs = (links: Record<string, string>, existing: string[] = []): ((p: string) => string | undefined) => {
    const exists = new Set(existing)
    const step = (p: string): string | undefined => {
      for (const [from, to] of Object.entries(links)) {
        if (p === from) return to
        if (p.startsWith(from + '/')) return to + p.slice(from.length)
      }
      return undefined
    }
    return (p: string) => {
      let cur = p
      let linked = false
      for (let i = 0; i < 16; i++) {
        const next = step(cur)
        if (next === undefined || next === cur) break
        cur = next
        linked = true
      }
      return linked || exists.has(cur) ? cur : undefined
    }
  }

  test('a file symlink into ~/.ssh is denied, the real path also', () => {
    const realpath = fakeFs({ '/Users/u/code/app/notes.txt': '/Users/u/.ssh/authorized_keys' })
    const reason = deny(['notes.txt'], { realpath })
    expect(reason).toContain('follows a symlink')
    expect(reason).toContain("user's SSH directory")
    expect(reason).toContain('`~/code/app/notes.txt`')
    expect(deny(['/Users/u/.ssh/authorized_keys'], { realpath })).toBeDefined()
  })

  test('a new file under a symlinked directory resolves through its nearest existing ancestor', () => {
    const realpath = fakeFs({ '/Users/u/code/app/cfg': '/Users/u/.ssh' }, ['/Users/u/code/app', '/Users/u/code', '/Users/u', '/'])
    expect(deny(['cfg/config'], { realpath })).toContain("user's SSH directory")
    expect(deny(['cfg/new/dir/file'], { realpath })).toContain("user's SSH directory")
    const toState = fakeFs({ '/Users/u/code/app/st': '/Users/u/.buracle/state' })
    expect(deny(['st/runtime-config.json'], { realpath: toState })).toContain("Buracle's own state")
    const toVault = fakeFs({ '/Users/u/code/app/v': '/Users/u/Documents/Buracle/.obsidian' })
    expect(deny(['v/app.json'], { realpath: toVault })).toContain('Obsidian')
  })

  test('roots are resolved too (macOS /tmp → /private/tmp): the resolved target is compared with both', () => {
    const realpath = fakeFs({ '/tmp': '/private/tmp' })
    const c: Partial<WriteGuardContext> = { home: '/tmp/sb/home', cwd: '/tmp/sb/home/proj', realpath }
    expect(deny(['/tmp/sb/home/.ssh/authorized_keys'], c)).toContain("user's SSH directory")
    const link = fakeFs({ '/tmp': '/private/tmp', '/private/tmp/sb/home/proj/k': '/private/tmp/sb/home/.ssh/id_x' })
    expect(deny(['k'], { ...c, realpath: link })).toContain("user's SSH directory")
  })

  test("SEC-1: links into Buracle's setup, and setup folders that are links themselves", () => {
    const toShim = fakeFs({ '/Users/u/code/app/run.sh': '/Users/u/.buracle/bin/buracle' })
    expect(deny(['run.sh'], { realpath: toShim })).toContain('follows a symlink')
    expect(deny(['run.sh'], { realpath: toShim })).toContain("Buracle's own installation")
    const dotfiles = fakeFs({ '/Users/u/.claude': '/Users/u/dotfiles/claude' }, ['/Users/u/dotfiles/claude/settings.json'])
    expect(deny(['/Users/u/dotfiles/claude/settings.json'], { realpath: dotfiles })).toContain('Claude Code')
    expect(deny(['/Users/u/dotfiles/claude/plugins/x/hooks/hooks.json'], { realpath: dotfiles })).toContain('Claude Code')
    expect(deny(['/Users/u/dotfiles/claude/CLAUDE.md'], { realpath: dotfiles })).toBeUndefined()
    expect(deny(['/Users/u/dotfiles/zshrc'], { realpath: dotfiles })).toBeUndefined()
    const relocated = fakeFs({ '/cfg/codex': '/data/codex' })
    expect(deny(['/data/codex/hooks.json'], { realpath: relocated, selfPaths: { codexHome: '/cfg/codex' } })).toContain('Codex')
  })

  test('a path spelled with the real location of a linked home is judged like the home itself', () => {
    const realpath = fakeFs({ '/tmp': '/private/tmp' })
    const c: Partial<WriteGuardContext> = { home: '/tmp/sb/home', cwd: '/tmp/sb/home/proj', realpath }
    expect(deny(['/private/tmp/sb/home/.ssh/authorized_keys'], c)).toContain("user's SSH directory")
    expect(deny(['/private/tmp/sb/home/.buracle/config.yaml'], c)).toContain("Buracle's own installation")
    expect(deny(['/private/tmp/sb/home/proj/src/a.ts'], c)).toBeUndefined()
  })

  test('ordinary files, unresolvable paths and a misbehaving resolver are allowed', () => {
    expect(deny(['src/a.ts'], { realpath: (p: string) => p })).toBeUndefined()
    expect(deny(['src/a.ts'], { realpath: () => undefined })).toBeUndefined()
    expect(deny(['src/a.ts'], { realpath: () => { throw new Error('EACCES') } })).toBeUndefined()
    expect(deny(['src/a.ts'], { realpath: () => 'relative/path' })).toBeUndefined()
    expect(deny(['link.md'], { realpath: fakeFs({ '/Users/u/code/app/link.md': '/Users/u/code/app/docs/real.md' }) })).toBeUndefined()
    expect(deny(['notes.txt'])).toBeUndefined()
  })

  test('realpathQueries lists the target, its ancestors and the roots', () => {
    const q = realpathQueries(['cfg/config'], ctx)
    expect(q).toEqual(expect.arrayContaining(['/Users/u/code/app/cfg/config', '/Users/u/code/app/cfg', '/Users/u/code/app', '/Users/u', '/', '/Users/u/Documents/Buracle']))
    expect(q).toEqual(expect.arrayContaining(['/Users/u/.buracle', '/Users/u/.local/bin', '/Users/u/.claude', '/Users/u/.codex', '/Users/u/.config/opencode', '/Users/u/.omp/agent', '/Users/u/.omp']))
    expect(realpathQueries(['a'], { ...ctx, selfPaths: { claudeDir: '/cfg/claude' } } as WriteGuardContext)).toContain('/cfg/claude')
    expect(realpathQueries(undefined as unknown as string[], ctx)).toEqual([])
    const asked = new Set<string>()
    checkWrite(['cfg/config'], { ...ctx, realpath: (p: string) => { asked.add(p); return undefined } } as WriteGuardContext)
    for (const p of asked) expect(q).toContain(p)
    const askedSelf = new Set<string>()
    const withSelf = { ...ctx, selfPaths: { codexHome: '/cfg/codex' } } as WriteGuardContext
    checkWrite(['/cfg/codex/x'], { ...withSelf, realpath: (p: string) => { askedSelf.add(p); return undefined } } as WriteGuardContext)
    const qSelf = realpathQueries(['/cfg/codex/x'], withSelf)
    for (const p of askedSelf) expect(qSelf).toContain(p)
    const withRepo = { ...ctx, selfPaths: { repo: '/data/buracle' } } as WriteGuardContext
    const askedRepo = new Set<string>()
    checkWrite(['/data/buracle/src/a.ts'], { ...withRepo, realpath: (p: string) => { askedRepo.add(p); return undefined } } as WriteGuardContext)
    const qRepo = realpathQueries(['/data/buracle/src/a.ts'], withRepo)
    expect(qRepo).toContain('/data/buracle')
    for (const p of askedRepo) expect(qRepo).toContain(p)
  })

  test('with real symlinks and fs.realpathSync (the resolver adapters pass)', () => withSandbox(({ root }) => {
    const home = join(root, 'h')
    const proj = join(home, 'proj')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(home, '.ssh', 'authorized_keys'), 'original\n')
    symlinkSync(join(home, '.ssh', 'authorized_keys'), join(proj, 'notes.txt'))
    symlinkSync(join(home, '.ssh'), join(proj, 'cfg'))
    const realpath = (p: string): string | undefined => { try { return realpathSync(p) } catch { return undefined } }
    const c: WriteGuardContext = { cwd: proj, home, vault: join(home, 'vault'), protect: [], realpath }
    expect(checkWrite([join(proj, 'notes.txt')], c).deny).toContain('follows a symlink')
    expect(checkWrite([join(proj, 'cfg', 'config')], c).deny).toContain("user's SSH directory")
    expect(checkWrite([join(proj, 'README.md')], c)).toEqual({})
    const { realpath: _resolver, ...noResolver } = c
    expect(checkWrite([join(proj, 'notes.txt')], noResolver)).toEqual({})
  }))

  test("SEC-1 with real symlinks: a link to the shim, and a ~/.claude that lives in a dotfiles folder", () => withSandbox(({ root }) => {
    const home = join(root, 'h')
    const proj = join(home, 'proj')
    mkdirSync(join(home, '.buracle', 'bin'), { recursive: true })
    mkdirSync(join(home, 'dotfiles', 'claude'), { recursive: true })
    mkdirSync(proj, { recursive: true })
    writeFileSync(join(home, '.buracle', 'bin', 'buracle'), '#!/bin/sh\n')
    writeFileSync(join(home, 'dotfiles', 'claude', 'settings.json'), '{}\n')
    symlinkSync(join(home, '.buracle', 'bin', 'buracle'), join(proj, 'run.sh'))
    symlinkSync(join(home, 'dotfiles', 'claude'), join(home, '.claude'))
    const realpath = (p: string): string | undefined => { try { return realpathSync(p) } catch { return undefined } }
    const c: WriteGuardContext = { cwd: proj, home, vault: join(home, 'vault'), protect: [], realpath }
    expect(checkWrite([join(proj, 'run.sh')], c).deny).toContain("Buracle's own installation")
    expect(checkWrite([join(home, '.claude', 'settings.json')], c).deny).toContain('Claude Code')
    expect(checkWrite([join(home, 'dotfiles', 'claude', 'settings.json')], c).deny).toContain('Claude Code')
    expect(checkWrite([join(home, 'dotfiles', 'claude', 'CLAUDE.md')], c)).toEqual({})
    expect(checkWrite([join(proj, 'README.md')], c)).toEqual({})
  }))
})

describe('credentialLocation: what a tool that indexes what it reads must leave alone', () => {
  const at = (path: string, cwd = CWD) => credentialLocation(path, { cwd, home: HOME })
  test('secret files, credential folders and the folders that hold them', () => {
    expect(at('.env')).toBe('holds environment secrets')
    expect(at('config/server.key')).toBe('is a private key or certificate')
    expect(at('~/.ssh/id_ed25519')).toBe("is in the user's SSH directory")
    expect(at('/Users/u/.aws/credentials')).toBe("is in the user's AWS credentials directory")
    expect(at('.gnupg/pubring.kbx', HOME)).toBe("is in the user's GnuPG directory")
    expect(at('/home/other/.ssh/config')).toBe("is in the user's SSH directory")
    for (const p of ['/Users/u', '~', '/Users', '/', '../..', '../../..']) expect({ p, why: at(p) }).toEqual({ p, why: expect.stringContaining('credentials') })
    expect(credentialLocation('/', { cwd: '', home: '' })).toContain('credentials')
  })

  test('project files, templates and other folders are fine', () => {
    for (const p of ['docs/spec.md', '.env.example', 'logs/app.log', CWD, '/Users/u/code', '..', '/tmp/x.json', 'src/credentials.ts']) expect({ p, why: at(p) }).toEqual({ p, why: undefined })
    expect(credentialLocation(42 as unknown as string, { cwd: CWD, home: HOME })).toBeUndefined()
  })

  test("the home folder's usual credential stores and the folders that hold them; checkWrite is unchanged", () => {
    const stores = ['~/.netrc', '~/.git-credentials', '~/.npmrc', '~/.pypirc', '~/.docker/config.json', '~/.kube/config', '~/.config/gh/hosts.yml', '~/.config/gcloud/credentials.db', '~/.azure/accessTokens.json']
    for (const p of stores) expect({ p, why: at(p) }).toEqual({ p, why: expect.stringContaining('credential store') })
    for (const p of ['/home/other/.netrc', '/Users/other/.config/gh/hosts.yml', '/root/.docker/config.json']) expect({ p, why: at(p) }).toEqual({ p, why: expect.stringContaining('credential store') })
    for (const p of ['~/.config', '~/.config/gh', '~/.docker', '~/.kube', '~/.azure', '~/.config/gcloud']) expect({ p, why: at(p) }).toEqual({ p, why: expect.stringContaining('credential store') })
    for (const p of ['~/.config/nvim/init.lua', '~/.docker/daemon.json', '~/.kube/cache', '.npmrc', '.netrc', 'docs/.git-credentials.example']) expect({ p, why: at(p) }).toEqual({ p, why: undefined })
    for (const p of ['~/.netrc', '~/.npmrc', '~/.docker/config.json', '~/.kube/config', '~/.config/gh/hosts.yml', '~/.azure/config']) expect({ p, w: checkWrite([p], ctx) }).toEqual({ p, w: {} })
  })
})

describe('checkWrite: Windows paths (drive letters, backslashes, any case)', () => {
  const win: WriteGuardContext = { cwd: 'C:\\Users\\u\\code\\app', home: 'C:\\Users\\u', vault: '~/Documents/Buracle', protect: [] }
  const wdeny = (paths: string[], extra: Partial<WriteGuardContext> = {}): string | undefined => checkWrite(paths, { ...win, ...extra }).deny

  test('the credential folders match whatever the separator and the case', () => {
    for (const p of ['C:\\Users\\u\\.ssh\\id_rsa.pub', 'c:/users/U/.SSH/authorized_keys', 'C:/Users/u/.ssh', '~\\.ssh\\config', '~/.ssh/config', '..\\..\\.ssh\\known_hosts', 'file:///C:/Users/u/.ssh/config', '\\Users\\u\\.ssh\\config']) {
      expect({ p, why: wdeny([p]) }).toEqual({ p, why: expect.stringContaining("user's SSH directory") })
    }
    expect(wdeny(['C:\\Users\\u\\.aws\\credentials'])).toContain('AWS credentials')
    expect(wdeny(['C:\\Users\\u\\.ssh\\config'])).toStartWith('`~/.ssh/config` ')
  })

  test('secret files and the setup folders of Buracle and the harnesses', () => {
    expect(wdeny(['.env'])).toContain('environment secrets')
    expect(wdeny(['config\\server.key'])).toContain('private key')
    expect(wdeny(['C:\\Users\\u\\.buracle\\config.yaml'])).toContain("Buracle's own installation")
    expect(wdeny(['C:\\Users\\u\\.buracle\\state\\owned.json'])).toContain("Buracle's own state")
    expect(wdeny(['C:\\Users\\u\\.local\\bin\\buracle.cmd'])).toContain('`buracle` command on PATH')
    expect(wdeny(['c:\\USERS\\u\\.Claude\\settings.json'])).toContain("Claude Code's own configuration")
    expect(wdeny(['C:/Users/u/.codex/hooks.json'])).toContain("Codex's own configuration")
    expect(wdeny(['C:\\Users\\u\\.config\\opencode\\opencode.json'])).toContain("OpenCode's own configuration")
    expect(wdeny(['C:\\Users\\u\\.omp\\agent\\extensions\\x.ts'])).toContain("omp's own configuration")
    expect(wdeny(['D:\\Users\\other\\.claude\\settings.json'])).toContain("Claude Code's own configuration")
    expect(wdeny(['C:\\Users\\u\\Documents\\Buracle\\.obsidian\\app.json'])).toContain('Obsidian')
  })

  test('a PowerShell profile is a shell startup file: a relocation in it is refused, other lines pass', () => {
    const profile = 'C:\\Users\\u\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1'
    expect(wdeny([profile])).toContain('shell startup file')
    expect(wdeny([profile], { contents: { [profile]: { after: "$env:BURACLE_HOME = 'D:\\elsewhere'\n" } } })).toContain('moves Buracle or a harness')
    expect(wdeny([profile], { contents: { [profile]: { after: "[Environment]::SetEnvironmentVariable('CODEX_HOME', 'D:\\c', 'User')\n" } } })).toContain('moves Buracle or a harness')
    expect(wdeny([profile], { contents: { [profile]: { after: 'Set-Alias ll Get-ChildItem\n' } } })).toBeUndefined()
  })

  test('relocated roots, drive patterns in guards.write.protect and the relative ones', () => {
    const selfPaths = { buracleHome: 'D:\\buracle', claudeDir: 'D:\\cfg\\claude' }
    expect(wdeny(['d:/BURACLE/bin/buracle.cmd'], { selfPaths })).toContain("Buracle's own installation")
    expect(wdeny(['D:\\cfg\\claude\\settings.json'], { selfPaths })).toContain('Claude Code')
    expect(wdeny(['src\\a.ts'], { selfPaths: { buracleHome: 'C:\\' } })).toBeUndefined()
    expect(wdeny(['C:\\Users\\u\\code\\app\\secrets\\db.txt'], { protect: ['secrets/**'] })).toContain('guards.write.protect')
    expect(wdeny(['secrets\\db.txt'], { protect: ['secrets/**'] })).toContain('guards.write.protect')
    expect(wdeny(['D:\\Data\\Vault\\x.md'], { protect: ['D:\\data\\vault\\**'] })).toContain('guards.write.protect')
    expect(wdeny(['D:\\Data\\other\\x.md'], { protect: ['D:\\data\\vault\\**'] })).toBeUndefined()
    expect(wdeny(['\\\\srv\\share\\keys\\x.md'], { protect: ['\\\\srv\\share\\keys\\**'] })).toContain('guards.write.protect')
  })

  test("the Buracle checkout: harness/ is generated inside it, and all of it is Buracle's source from an unrelated session", () => {
    const inRepo = { cwd: 'C:\\code\\buracle', buracleRepo: 'C:\\code\\buracle' }
    expect(wdeny(['harness\\next\\x.md'], inRepo)).toContain('generated by `buracle build`')
    expect(wdeny(['src\\a.ts'], inRepo)).toBeUndefined()
    expect(wdeny(['C:\\code\\buracle\\harness\\claude\\x.md'], { cwd: 'c:\\code\\buracle' })).toContain('generated by `buracle build`')
    expect(wdeny(['C:\\code\\buracle\\src\\cli\\main.ts'], { selfPaths: { repo: 'C:\\code\\buracle' } })).toContain("Buracle's own source code")
    expect(wdeny(['C:\\code\\buracle\\src\\cli\\main.ts'], { cwd: 'C:\\code\\buracle\\src', selfPaths: { repo: 'C:\\code\\buracle' } })).toBeUndefined()
  })

  test('symlinks resolve on Windows spellings too: a link into ~/.ssh, a new file under a linked folder', () => {
    const links: Record<string, string> = { 'C:/Users/u/code/app/notes.txt': 'C:\\Users\\u\\.ssh\\authorized_keys', 'C:/Users/u/code/app/cfg': 'C:\\Users\\u\\.ssh' }
    const realpath = (p: string): string | undefined => {
      for (const [from, to] of Object.entries(links)) {
        if (p === from) return to
        if (p.startsWith(from + '/')) return to + p.slice(from.length).replace(/\//g, '\\')
      }
      return undefined
    }
    expect(wdeny(['notes.txt'], { realpath })).toContain('follows a symlink')
    expect(wdeny(['cfg\\new\\file'], { realpath })).toContain("user's SSH directory")
    const q = realpathQueries(['cfg\\config'], win)
    expect(q).toEqual(expect.arrayContaining(['C:/Users/u/code/app/cfg/config', 'C:/Users/u/code/app/cfg', 'C:/Users/u', 'C:/', 'C:/Users/u/.claude']))
    expect(q).not.toContain('/')
  })

  test('ordinary project and home files pass; credentialLocation reads Windows paths', () => {
    for (const p of ['src\\index.ts', 'C:\\Users\\u\\code\\app\\README.md', 'C:\\Users\\u\\.claude\\CLAUDE.md', 'C:\\Users\\u\\Documents\\Buracle\\inbox\\n.md', 'D:\\tmp\\x.json']) {
      expect({ p, deny: wdeny([p]) }).toEqual({ p, deny: undefined })
    }
    const at = (p: string) => credentialLocation(p, { cwd: win.cwd, home: win.home })
    expect(at('C:\\Users\\u\\.ssh\\id_ed25519')).toBe("is in the user's SSH directory")
    expect(at('c:\\users\\u')).toContain('credentials')
    expect(at('C:\\')).toContain('credentials')
    expect(at('C:\\Users\\other\\.ssh\\config')).toBe("is in the user's SSH directory")
    expect(at('~\\.netrc')).toContain('credential store')
    expect(at('C:\\Users\\u\\code\\app\\docs\\spec.md')).toBeUndefined()
  })
})

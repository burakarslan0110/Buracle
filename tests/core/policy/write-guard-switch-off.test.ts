import { describe, expect, test } from 'bun:test'
import { parse as parseYaml } from 'yaml'
import { checkWrite, guardedFile, type ConfigParsers, type WriteContent, type WriteGuardContext } from '../../../src/core/policy/write-guard'
import { jsoncParse } from '../../../src/engine/merge'

const HOME = '/Users/u'
const CWD = '/Users/u/code/app'
const ctx: WriteGuardContext = { cwd: CWD, home: HOME, vault: '~/Documents/Buracle', protect: [] }

const parsers: ConfigParsers = {
  jsonc: t => { const r = jsoncParse(t); if (!r.ok) throw new Error(r.error); return r.value },
  toml: t => Bun.TOML.parse(t),
  yaml: t => parseYaml(t) as unknown,
}

function judge(path: string, after: string, before?: string, extra: Partial<WriteGuardContext> = {}): string | undefined {
  const content: WriteContent = before === undefined ? { after } : { after, before }
  return checkWrite([path], { ...ctx, parsers, contents: { [path]: content }, ...extra }).deny
}

const json = (v: unknown): string => JSON.stringify(v, null, 2)

const bare = (extra: Partial<WriteGuardContext>): WriteGuardContext => ({ ...ctx, ...extra })

describe('G1: project settings are refused at the path when the content is unknown', () => {
  const files = [
    `${CWD}/.claude/settings.local.json`, `${CWD}/.claude/settings.json`, '.claude/settings.local.json', `${CWD}/sub/.claude/settings.json`,
    `${CWD}/.codex/config.toml`, `${CWD}/opencode.json`, `${CWD}/opencode.jsonc`, `${CWD}/.opencode/opencode.jsonc`,
    `${CWD}/.omp/config.yml`, `${CWD}/.omp/config.yaml`, `${CWD}/.omp/settings.json`,
    `${CWD}/.opencode/plugins/x.ts`, `${CWD}/.opencode/plugin/x.js`, `${CWD}/.omp/extensions/x.ts`, `${CWD}/.omp/hooks/pre/x.ts`, `${CWD}/.omp/plugins/p/index.ts`,
    `${CWD}/.CLAUDE/Settings.Local.json`,
  ]
  for (const p of files) {
    test(`denies ${p} without content`, () => {
      const reason = checkWrite([p], ctx).deny
      expect(reason).toContain('file edit or whole-file write tool')
      expect(reason).toContain('ask the user')
      expect(reason?.trim().endsWith('.')).toBe(true)
    })
  }

  test('neighbouring project files stay writable', () => {
    for (const p of [`${CWD}/.claude/commands/x.md`, `${CWD}/.claude/agents/r.md`, `${CWD}/.claude/skills/s/SKILL.md`, `${CWD}/.codex/AGENTS.md`,
      `${CWD}/.omp/rules/r.md`, `${CWD}/.omp/AGENTS.md`, `${CWD}/.opencode/skills/s/SKILL.md`, `${CWD}/settings.json`, `${CWD}/config.toml`, `${CWD}/.mcp.json`]) {
      expect({ p, deny: checkWrite([p], ctx).deny }).toEqual({ p, deny: undefined })
    }
  })

  test('the user-level settings stay SEC-1 areas: refused whatever the content', () => {
    const reason = judge(`${HOME}/.claude/settings.json`, json({ permissions: { allow: ['Bash(ls)'] } }))
    expect(reason).toContain("Claude Code's own configuration")
  })
})

describe('G1: Claude Code project settings', () => {
  const file = `${CWD}/.claude/settings.local.json`

  test('ordinary changes pass: permissions, env, hooks, the memory redirect, Buracle enabled', () => {
    for (const s of [
      { permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(.env)'] } },
      { env: { NODE_ENV: 'test', BURACLE_NO_AUTOSTART: '1' } },
      { autoMemoryDirectory: '~/Documents/Buracle/projects/app/claude' },
      { enabledPlugins: { 'buracle@buracle': true, 'other@market': false } },
      { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] } },
      { disableAllHooks: false },
    ]) {
      expect({ s, deny: judge(file, json(s)) }).toEqual({ s, deny: undefined })
    }
  })

  test('changes that switch Buracle off are refused', () => {
    const cases: Array<[unknown, string]> = [
      [{ enabledPlugins: { 'buracle@buracle': false } }, "turns Buracle's plugin off"],
      [{ enabledPlugins: { 'Buracle@local-market': false } }, "turns Buracle's plugin off"],
      [{ disableAllHooks: true }, 'disableAllHooks'],
      [{ allowManagedHooksOnly: true }, 'allowManagedHooksOnly'],
      [{ env: { BURACLE_HOME: '/tmp/fb' } }, 'env.BURACLE_HOME'],
      [{ env: { HOME: '/tmp/h' } }, 'env.HOME'],
      [{ env: { CLAUDE_CONFIG_DIR: '/tmp/c' } }, 'env.CLAUDE_CONFIG_DIR'],
      [{ env: { BURACLE_HOOK_TIMEOUT_MS: '1' } }, 'cuts every Buracle hook short'],
      [{ disabledExtensions: ['extension-module:buracle'] }, 'disabledExtensions'],
    ]
    for (const [s, why] of cases) {
      const reason = judge(file, json(s))
      expect({ s, reason }).toEqual({ s, reason: expect.stringContaining(why) as unknown as string })
      expect(reason).toContain('ask the user to make this change themselves')
      expect(reason?.trim().endsWith('.')).toBe(true)
    }
  })

  test('JSON with comments and trailing commas is parsed, not skipped', () => {
    expect(judge(file, '{\n  // keep quiet\n  "enabledPlugins": { "buracle@buracle": false, },\n}\n')).toContain("Buracle's plugin off")
    expect(judge(file, '{\n  /* team */ "permissions": { "allow": ["Bash(ls)"], },\n}\n')).toBeUndefined()
  })

  test("a setting the file already held is the user's: an unrelated edit passes, a new one does not", () => {
    const before = json({ disableAllHooks: true, permissions: { allow: [] } })
    expect(judge(file, json({ disableAllHooks: true, permissions: { allow: ['Bash(ls)'] } }), before)).toBeUndefined()
    expect(judge(file, json({ disableAllHooks: true, enabledPlugins: { 'buracle@buracle': false } }), before)).toContain("Buracle's plugin off")
    expect(judge(file, json({ env: { BURACLE_HOME: '/tmp/b' } }), json({ env: { BURACLE_HOME: '/tmp/a' } }))).toContain('BURACLE_HOME')
  })

  test('text that does not parse (a fragment a shell appends) is scanned for the words of those settings', () => {
    expect(judge(file, ', "disableAllHooks": true }')).toContain('cannot read as valid settings')
    expect(judge(file, '{ "permissions": ')).toBeUndefined()
    expect(checkWrite([file], bare({ contents: { [file]: { after: json({ enabledPlugins: { 'buracle@buracle': false } }) } } })).deny).toContain("Buracle's plugin off")
  })
})

describe('G1: Codex project config', () => {
  const file = `${CWD}/.codex/config.toml`

  test('ordinary changes pass', () => {
    for (const t of ['model = "o4"\n', '[mcp_servers.x]\ncommand = "x"\n', '[features]\nhooks = true\nmemories = false\n', '[projects."/a"]\ntrust_level = "trusted"\n']) {
      expect({ t, deny: judge(file, t) }).toEqual({ t, deny: undefined })
    }
  })

  test('hooks switched off, in any TOML spelling, a disabled Buracle plugin, hook trust state and relocations are refused', () => {
    const cases: Array<[string, string]> = [
      ['[features]\nhooks = false\n', 'features.hooks'],
      ['features.hooks = false\n', 'features.hooks'],
      ['features = { codex_hooks = false }\n', 'features.codex_hooks'],
      ['[profiles.fast.features]\nhooks = false\n', 'profiles.fast.features.hooks'],
      ['[plugins."buracle@buracle"]\nenabled = false\n', "turns Buracle's plugin off"],
      ['[hooks.state."/Users/u/.codex/hooks.json:pre_tool_use:0"]\nenabled = false\n', 'trust state'],
      ['allow_managed_hooks_only = true\n', 'allow_managed_hooks_only'],
      ['[shell_environment_policy.set]\nBURACLE_HOME = "/tmp/fb"\n', 'BURACLE_HOME'],
    ]
    for (const [t, why] of cases) expect({ t, reason: judge(file, t) }).toEqual({ t, reason: expect.stringContaining(why) as unknown as string })
  })

  test('without a TOML parser the changed lines are scanned', () => {
    const r = checkWrite([file], bare({ contents: { [file]: { after: '[features]\nhooks = false\n' } } })).deny
    expect(r).toContain('hooks = false')
    expect(checkWrite([file], bare({ contents: { [file]: { after: 'model = "o4"\n' } } })).deny).toBeUndefined()
  })
})

describe('G1: OpenCode config and omp settings', () => {
  test('OpenCode: a `-buracle` (or wildcard) plugin entry is refused, other plugins pass', () => {
    const file = `${CWD}/opencode.jsonc`
    expect(judge(file, json({ plugins: ['-buracle'] }))).toContain("removes Buracle's plugin")
    expect(judge(file, json({ plugins: ['-*'] }))).toContain("removes Buracle's plugin")
    expect(judge(file, json({ plugins: ['-bur*'] }))).toContain("removes Buracle's plugin")
    expect(judge(`${CWD}/.opencode/opencode.json`, json({ plugin: ['-buracle'] }))).toContain("removes Buracle's plugin")
    for (const c of [{ plugins: ['opencode-x', '-opencode.prompt.footer'] }, { mcp: { servers: { x: { type: 'local', command: ['x', '--flag'] } } } }]) {
      expect({ c, deny: judge(file, json(c)) }).toEqual({ c, deny: undefined })
    }
  })

  test('omp: disabledExtensions naming Buracle is refused in YAML and JSON; other settings pass', () => {
    expect(judge(`${CWD}/.omp/config.yml`, 'disabledExtensions:\n  - extension-module:buracle\n')).toContain('disabledExtensions')
    expect(judge(`${CWD}/.omp/config.yaml`, 'disabledExtensions: [extension-module:buracle]\n')).toContain('disabledExtensions')
    expect(judge(`${CWD}/.omp/settings.json`, json({ disabledExtensions: ['extension-module:buracle'] }))).toContain('disabledExtensions')
    expect(judge(`${CWD}/.omp/config.yml`, 'disabledExtensions:\n  - extension-module:other\nmodel: x\n')).toBeUndefined()
    expect(judge(`${CWD}/.omp/config.yml`, 'disabledProviders: ["*"]\n')).toBeUndefined()
  })

  test('plugin and extension code passes unless it names Buracle; a folder named after Buracle is refused', () => {
    expect(judge(`${CWD}/.opencode/plugins/fmt.ts`, 'export default { id: "fmt", setup() {} }\n')).toBeUndefined()
    expect(judge(`${CWD}/.opencode/plugins/x.ts`, 'export default { id: "buracle", setup() {} }\n')).toContain('names Buracle')
    expect(judge(`${CWD}/.opencode/plugins/buracle/index.ts`, 'export default {}\n')).toContain('folder that names Buracle')
    expect(judge(`${CWD}/.omp/extensions/x.ts`, 'import { rmSync } from "node:fs"\nrmSync(home + "/.omp/plugins/node_modules/buracle-omp", { recursive: true })\n')).toContain('names Buracle')
    expect(judge('/Users/u/Desktop/buracle/.opencode/plugins/fmt.ts', 'export default {}\n', undefined, { cwd: '/Users/u/Desktop/buracle' })).toBeUndefined()
  })
})

describe('G3: shell startup files and launchd agents', () => {
  test('shell startup files are guarded under the home folder only', () => {
    for (const rel of ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.config/fish/config.fish', '.config/fish/conf.d/env.fish', '.config/fish/fish_variables']) {
      expect({ rel, kind: guardedFile(`${HOME}/${rel}`, HOME)?.kind }).toEqual({ rel, kind: 'shell-startup' })
      expect({ rel, kind: guardedFile(`/home/other/${rel}`, HOME)?.kind }).toEqual({ rel, kind: 'shell-startup' })
    }
    expect(guardedFile(`${CWD}/.zshrc`, HOME)).toBeUndefined()
    expect(guardedFile(`${HOME}/Library/LaunchAgents/com.x.plist`, HOME)?.kind).toBe('launchd-agent')
    expect(guardedFile('/Library/LaunchDaemons/com.x.plist', HOME)?.kind).toBe('launchd-agent')
    expect(checkWrite(['~/.zshrc'], ctx).deny).toContain('file edit or whole-file write tool')
  })

  test('a line that moves BURACLE_HOME, the home folder or a harness config folder is refused, in every shell', () => {
    const cases = [
      'export BURACLE_HOME=/tmp/fb', 'BURACLE_HOME=/tmp/fb', 'export HOME=/tmp/h', 'typeset -x CODEX_HOME=/tmp/c', 'declare -x CLAUDE_CONFIG_DIR=/tmp/c',
      'export XDG_CONFIG_HOME=/tmp/x', 'export XDG_DATA_HOME=/tmp/x', 'export PI_CODING_AGENT_DIR=/tmp/o', 'export BURACLE_CORTEXDB_BIN=/tmp/v',
      'set -gx BURACLE_HOME /tmp/fb', 'set -Ux XDG_CONFIG_HOME /tmp/x', 'setenv BURACLE_HOME /tmp/fb', 'launchctl setenv BURACLE_HOME /tmp/fb',
      'SETUVAR --export BURACLE_HOME:/tmp/fb', ': ${BURACLE_HOME:=/tmp/fb}', 'BURACLE_HOME=/tmp/fb; export BURACLE_HOME', 'export PATH=/x HOME=/tmp/h',
    ]
    for (const line of cases) {
      const reason = judge(`${HOME}/.zshrc`, `alias ll='ls -l'\n${line}\n`, "alias ll='ls -l'\n")
      expect({ line, reason }).toEqual({ line, reason: expect.stringContaining('moves Buracle or a harness') as unknown as string })
    }
  })

  test('ordinary startup lines pass, and a line the file already had is the user\'s', () => {
    for (const line of ['export PATH="$HOME/bin:$PATH"', 'export JAVA_HOME=/opt/jdk', 'eval "$(rbenv init -)"', 'set -gx PATH $HOME/bin $PATH', '# export BURACLE_HOME=/tmp/fb', 'cd $HOME']) {
      expect({ line, deny: judge(`${HOME}/.zshrc`, `${line}\n`) }).toEqual({ line, deny: undefined })
    }
    const before = 'export XDG_CONFIG_HOME="$HOME/.config"\n'
    expect(judge(`${HOME}/.zshrc`, `${before}export EDITOR=vim\n`, before)).toBeUndefined()
  })

  test('a launchd agent that sets one of those variables is refused; others pass', () => {
    const plist = (env: string) => `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>Label</key><string>com.x</string>\n<key>EnvironmentVariables</key>\n<dict>\n${env}\n</dict>\n</dict></plist>\n`
    expect(judge(`${HOME}/Library/LaunchAgents/com.x.plist`, plist('<key>BURACLE_HOME</key>\n<string>/tmp/fb</string>'))).toContain('BURACLE_HOME')
    expect(judge(`${HOME}/Library/LaunchAgents/com.x.plist`, plist('<key>HOME</key>\n<string>/tmp/h</string>'))).toContain('HOME')
    expect(judge(`${HOME}/Library/LaunchAgents/com.x.plist`, '<array><string>/bin/launchctl</string><string>setenv</string><string>BURACLE_HOME</string></array>\n')).toContain('BURACLE_HOME')
    expect(judge(`${HOME}/Library/LaunchAgents/com.x.plist`, plist('<key>PATH</key>\n<string>/usr/bin</string>'))).toBeUndefined()
  })

  test('the shim under a relocated BURACLE_HOME stays a SEC-1 area whatever the content', () => {
    const selfPaths = { buracleHome: '/opt/fb-home' }
    expect(checkWrite(['/opt/fb-home/bin/buracle'], bare({ selfPaths, contents: { '/opt/fb-home/bin/buracle': { after: '#!/bin/sh\n' } } })).deny).toContain("Buracle's own installation")
  })
})

describe('guardedFile with ancestor: folders that hold a guarded file (for copies and moves of whole folders)', () => {
  test('the harness folders of a project and the home-folder holders count only with the flag', () => {
    for (const p of [`${CWD}/.claude`, `${CWD}/.codex`, `${CWD}/.omp`, `${CWD}/.opencode`, `${CWD}/.opencode/plugins`, `${HOME}/Library/LaunchAgents`, `${HOME}/.config/fish`]) {
      expect({ p, hit: guardedFile(p, HOME, true) !== undefined }).toEqual({ p, hit: true })
    }
    expect(guardedFile(`${CWD}/.claude`, HOME)).toBeUndefined()
    expect(guardedFile(`${CWD}/src`, HOME, true)).toBeUndefined()
  })
})

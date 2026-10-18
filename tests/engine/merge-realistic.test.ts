import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { jsoncParse, jsoncSet, tomlParse, tomlPatchTables, tomlRemove, yamlParse, yamlSet } from '../../src/engine/merge'
import { applyPlans, readLedger, type Op } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

const CODEX_TOML = `# ~/.codex/config.toml (hand-written)
model = "gpt-6.1-sol"          # main model
model_reasoning_effort = "high"
approval_policy = "on-request" # ask before running
notify = ["bash", "-lc", "afplay /System/Library/Sounds/Glass.aiff"]

[features]
# experiments I opted into
web_search_request = true
unified_exec = false

[tui]
theme = "dark"   # keep
notifications = [
  "agent-turn-complete",   # when a turn ends
  "approval-requested",
]

# GitHub through Docker
[mcp_servers.github]
command = "docker"
args = [
  "run", "-i", "--rm",
  "ghcr.io/github/github-mcp-server",   # pinned by digest elsewhere
]
env_vars = ["GITHUB_TOKEN"]

[mcp_servers.github.env]
LOG_LEVEL = "debug"

[projects."/Users/me/code/app"]
trust_level = "trusted"

[projects."/Users/me/code/x.y"]
trust_level = "untrusted"

[profiles.fast]
model = "gpt-6.1-mini"
description = """
not a table:
[mcp_servers.context7]
# not a comment
"""
literal = '''C:\\path\\[x]'''

[[skills.config]]
path = "/Users/me/skills/a"
enabled = false

[[skills.config]]
path = "/Users/me/skills/b"
enabled = true
`

const TABLES = {
  'mcp_servers.context7': { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.2.0'], startup_timeout_sec: 20 },
  'mcp_servers.buracle-memory': { command: '/Users/me/.buracle/bin/buracle', args: ['mcp', 'memory'], env: { MODE: 'stdio' } },
}
const KEYS = {
  'tui.status_line': ['model-with-reasoning', 'context-used', 'five-hour-limit'],
  'tui.terminal_title': ['project-name'],
  'features.memories': false,
  'tools.update_plan.enabled': true,
}

describe('Codex config.toml', () => {
  test('patching touches only the owned tables and keys; every other byte survives', () => {
    const out = tomlPatchTables(CODEX_TOML, TABLES, KEYS)
    const expected = CODEX_TOML
      .replace('notify = ["bash", "-lc", "afplay /System/Library/Sounds/Glass.aiff"]\n', 'notify = ["bash", "-lc", "afplay /System/Library/Sounds/Glass.aiff"]\ntools.update_plan.enabled = true\n')
      .replace('unified_exec = false\n', 'unified_exec = false\nmemories = false\n')
      .replace('  "approval-requested",\n]\n', '  "approval-requested",\n]\nstatus_line = ["model-with-reasoning", "context-used", "five-hour-limit"]\nterminal_title = ["project-name"]\n')
      + '\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp@4.2.0"]\nstartup_timeout_sec = 20\n'
      + '\n[mcp_servers.buracle-memory]\ncommand = "/Users/me/.buracle/bin/buracle"\nargs = ["mcp", "memory"]\nenv = { MODE = "stdio" }\n'
    expect(out).toBe(expected)
    const parsed = tomlParse(out) as Record<string, any>
    expect(parsed['profiles']['fast']['description']).toBe('not a table:\n[mcp_servers.context7]\n# not a comment\n')
    expect(parsed['skills']['config']).toEqual([{ path: '/Users/me/skills/a', enabled: false }, { path: '/Users/me/skills/b', enabled: true }])
    expect(parsed['projects']).toEqual({ '/Users/me/code/app': { trust_level: 'trusted' }, '/Users/me/code/x.y': { trust_level: 'untrusted' } })
    expect(parsed['mcp_servers']['github']).toEqual({ command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'], env_vars: ['GITHUB_TOKEN'], env: { LOG_LEVEL: 'debug' } })
    expect(tomlRemove(out, { tables: Object.keys(TABLES), keys: Object.keys(KEYS) })).toBe(CODEX_TOML)
    expect(tomlPatchTables(out, TABLES, KEYS)).toBe(out)
  })

  test('replacing an owned table keeps the comments around it and tidies its dropped sub-tables', () => {
    const out = tomlPatchTables(CODEX_TOML, { 'mcp_servers.github': { command: 'gh-mcp' } })
    expect(out).toContain('# GitHub through Docker\n[mcp_servers.github]\ncommand = "gh-mcp"\n\n[projects."/Users/me/code/app"]\n')
    expect(out).not.toContain('\n\n\n')
  })

  test('a CRLF file stays CRLF and round-trips', () => {
    const crlf = CODEX_TOML.replace(/\n/g, '\r\n')
    const out = tomlPatchTables(crlf, TABLES, KEYS)
    expect(/(^|[^\r])\n/.test(out)).toBe(false)
    expect(tomlParse(out)).toEqual(tomlParse(tomlPatchTables(CODEX_TOML, TABLES, KEYS)))
    expect(tomlRemove(out, { tables: Object.keys(TABLES), keys: Object.keys(KEYS) })).toBe(crlf)
  })

  test('install and uninstall through the engine restore the exact original', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'config.toml')
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, CODEX_TOML)
    const r = await applyPlans([{ id: 'codex', harness: 'codex', ops: [{ kind: 'toml-tables', path: p, tables: TABLES, keys: KEYS, owner: 'codex' }] }])
    expect(r.conflicts).toEqual([])
    const keys = Object.keys(await readLedger())
    expect(keys.length).toBe(6)
    const u = await applyPlans([{ id: 'codex', harness: 'codex', ops: keys.map(k => ({ kind: 'remove', path: k, owner: 'codex' }) as Op) }])
    expect(u.conflicts).toEqual([])
    expect(readFileSync(p, 'utf8')).toBe(CODEX_TOML)
  }))
})

const OPENCODE_JSONC = `{
  // OpenCode config (mine)
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight", // trailing comment
  /* block comment */
  "mcp": {
    "servers": {
      "mine": { "type": "local", "command": ["my-mcp"] }, // keep
    },
  },
}
`

const OMP_YAML = `# Oh My Pi
tools:
  approvalMode: ask # ask first
statusLine:
  preset: default
  segments:
    - model
    - cwd
`

describe('opencode.jsonc and omp config.yml', () => {
  test('install then uninstall keeps every comment and gives back the same data', () => withSandbox(async (sb) => {
    const oc = join(sb.home, '.config', 'opencode', 'opencode.jsonc')
    const omp = join(sb.home, '.omp', 'agent', 'config.yml')
    mkdirSync(dirname(oc), { recursive: true })
    mkdirSync(dirname(omp), { recursive: true })
    writeFileSync(oc, OPENCODE_JSONC)
    writeFileSync(omp, OMP_YAML)
    const r = await applyPlans([{ id: 'x', harness: 'core', ops: [
      { kind: 'jsonc-merge', path: oc, set: { 'mcp.servers.context7': { type: 'local', command: ['npx', '-y', 'c7'], codemode: false }, share: 'disabled' }, owner: 'opencode' },
      { kind: 'yaml-merge', path: omp, set: { 'memory.backend': 'off', 'statusLine.preset': 'default', 'tools.extra': true }, owner: 'omp' },
    ] }])
    expect(r.conflicts).toEqual([])
    for (const c of ['// OpenCode config (mine)', '// trailing comment', '/* block comment */', '// keep']) expect(readFileSync(oc, 'utf8')).toContain(c)
    expect(readFileSync(omp, 'utf8')).toContain('approvalMode: ask # ask first')
    const led = await readLedger()
    const u = await applyPlans([{ id: 'x', harness: 'core', ops: Object.entries(led).map(([k, e]) => ({ kind: 'remove', path: k, owner: e.owner }) as Op) }])
    expect(u.conflicts).toEqual([])
    const ocText = readFileSync(oc, 'utf8')
    for (const c of ['// OpenCode config (mine)', '// trailing comment', '/* block comment */', '// keep']) expect(ocText).toContain(c)
    expect(jsoncParse(ocText)).toEqual(jsoncParse(OPENCODE_JSONC))
    expect(readFileSync(omp, 'utf8')).toContain('# Oh My Pi')
    expect(yamlParse(readFileSync(omp, 'utf8'))).toEqual(yamlParse(OMP_YAML))
    expect(readFileSync(omp, 'utf8')).toBe(OMP_YAML)
  }))
})

describe('setter edge cases', () => {
  test('jsoncSet removal never leaves a dangling comma', () => {
    const cases: Array<[string, string[], unknown]> = [
      ['{ "a": 1, }', ['a'], {}],
      ['{\n  "a": 1, // c\n}\n', ['a'], {}],
      ['{ "o": { "x": 1 /* c */ , }, "k": 2 }', ['o', 'x'], { o: {}, k: 2 }],
      ['{ "a": 1, "b": 2, }', ['b'], { a: 1 }],
      ['{ "a": 1, "b": 2, }', ['a'], { b: 2 }],
      ['{ "a": 1 }', ['missing'], { a: 1 }],
      ['', ['missing'], undefined],
    ]
    for (const [text, path, want] of cases) {
      const out = jsoncSet(text, path, undefined)
      const parsed = jsoncParse(out)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value).toEqual(want)
    }
    expect(jsoncSet('{\n  "a": 1, // keep me\n}\n', ['a'], undefined)).toContain('// keep me')
  })

  test('removing a key that is not there leaves YAML and JSONC text byte for byte', () => {
    const yaml = 'a:   1    # odd spacing\nlist: [ x,  y ]\n'
    expect(yamlSet(yaml, ['nope'], undefined)).toBe(yaml)
    expect(yamlSet(yaml, ['a', 'deeper'], undefined)).toBe(yaml)
    const jsonc = '{ "a":   1 ,  }'
    expect(jsoncSet(jsonc, ['nope'], undefined)).toBe(jsonc)
  })

  test('a root key inserted before the first table is removed without leaving a blank line', () => {
    const text = '[features]\nmemories = false\n'
    const once = tomlPatchTables(text, {}, { 'tools.update_plan.enabled': true })
    expect(once).toBe('tools.update_plan.enabled = true\n\n[features]\nmemories = false\n')
    expect(tomlRemove(once, { keys: ['tools.update_plan.enabled'] })).toBe(text)
    const commented = '# header\n\n# about features\n[features]\nmemories = false\n'
    expect(tomlRemove(tomlPatchTables(commented, {}, { a: 1 }), { keys: ['a'] })).toBe(commented)
  })

  test('replacing an owned key keeps the comment on its line, including after a multi-line value', () => {
    expect(tomlPatchTables('a = 1 # mine\nb = 2\n', {}, { a: 5 })).toBe('a = 5 # mine\nb = 2\n')
    expect(tomlPatchTables('[t]\nx = [\n  1, # one\n  2,\n] # trailing\ny = 1\n', {}, { 't.x': [3] })).toBe('[t]\nx = [3] # trailing\ny = 1\n')
    expect(tomlPatchTables('s = """\nmulti\n"""   # note\n', {}, { s: 'one' })).toBe('s = "one"   # note\n')
    expect(tomlPatchTables('a = 1', {}, { a: 2 })).toBe('a = 2')
  })
})

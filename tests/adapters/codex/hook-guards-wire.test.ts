import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleCodexHook } from '../../../src/adapters/codex/hook'
import { defaultConfig } from '../../../src/core/config'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctx, deps, payload } from './hook-helpers'

const bash = (command: string, cwd: string) => payload('PreToolUse', { cwd, tool_name: 'Bash', tool_use_id: 'c1', tool_input: { command } })
const patch = (body: string, cwd: string) => payload('PreToolUse', { cwd, tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch\n` } })
const mcp = (tool: string, input: Record<string, unknown>, cwd: string) => payload('PreToolUse', { cwd, tool_name: tool, tool_use_id: 'm1', tool_input: input })

async function reason(input: string, config = defaultConfig()): Promise<string | undefined> {
  const r = await handleCodexHook('PreToolUse', input, ctx(config), deps({}))
  return r.stdout === '' ? undefined : JSON.parse(r.stdout).hookSpecificOutput?.permissionDecisionReason
}

describe('Codex H01 meets the write context (W1.1)', () => {
  test('a deleting find that starts at the old memory vault is refused by H01 (BURACLE_VAULT no longer moves it); a protect glob covers a shell write', () => withSandbox(async ({ root, home }) => {
    const proj = join(root, 'proj')
    const vault = join(home, 'Documents', 'Buracle')
    mkdirSync(proj, { recursive: true })
    mkdirSync(vault, { recursive: true })
    const config = defaultConfig()
    config.guards.write.protect = ['secrets/**']
    await withEnv({ BURACLE_VAULT: join(root, 'elsewhere', 'vault') }, async () => {
      const r = await reason(bash(`find ${vault} -type f -delete`, proj), config)
      expect(r).toStartWith('Buracle H01: ')
      expect(r).toContain('Buracle memory vault')
    })
    expect(await reason(bash('echo x > secrets/a.txt', proj), config)).toContain('guards.write.protect')
    expect(await reason(bash('echo x > notes/a.txt', proj), config)).toBeUndefined()
  }), 20_000)
})

describe('Codex H02 judges apply_patch by what it leaves in a guarded file (W1.2)', () => {
  test('project Claude settings: a permission passes, disableAllHooks is refused (Add File and Update File)', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    writeFileSync(join(proj, '.claude', 'settings.json'), '{\n  "permissions": {\n    "allow": []\n  }\n}\n')
    const update = (lines: string[]) => patch(['*** Update File: .claude/settings.json', '@@', ...lines].join('\n'), proj)
    expect(await reason(update(['   "permissions": {', '-    "allow": []', '+    "allow": ["Bash(npm test:*)"]']))).toBeUndefined()
    const off = await reason(update(['   "permissions": {', '-    "allow": []', '+    "allow": []', '+  },', '+  "disableAllHooks": true, "x": {']))
    expect(off).toStartWith('Buracle H02: ')
    expect(off).toContain('disableAllHooks')
    expect(await reason(patch('*** Add File: .claude/settings.local.json\n+{ "permissions": { "allow": ["Read"] } }', proj))).toBeUndefined()
    expect(await reason(patch('*** Add File: .claude/settings.local.json\n+{ "disableAllHooks": true }', proj))).toContain('disableAllHooks')
    expect(await reason(patch('*** Add File: .codex/config.toml\n+[features]\n+hooks = false', proj))).toContain('features.hooks')
    expect(await reason(patch('*** Add File: .codex/config.toml\n+model = "gpt-6.1-sol"', proj))).toBeUndefined()
    expect(await reason(update(['-    "nope": 1', '+    "x": 2']))).toContain('cannot see what this write puts there')
    expect(await reason(patch('*** Delete File: .claude/settings.json', proj))).toContain('cannot see what this write puts there')
  }), 20_000)

  test('a shell-fed apply_patch is judged the same way', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const shell = (body: string) => bash(`cd ${proj} && apply_patch <<'EOF'\n*** Begin Patch\n${body}\n*** End Patch\nEOF`, proj)
    expect(await reason(shell('*** Add File: opencode.json\n+{ "model": "x" }'))).toBeUndefined()
    expect(await reason(shell('*** Add File: opencode.json\n+{ "plugins": ["-buracle"] }'))).toContain("removes Buracle's plugin")
  }), 20_000)
})

describe('Codex MCP calls that name a file they write go through H02 (W1.3, G12)', () => {
  test('a protected target is refused, an ordinary one passes, read-only servers are not judged', () => withSandbox(async ({ root, home }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const heap = 'mcp__chrome_devtools__take_heapsnapshot'
    const r = await reason(mcp(heap, { filePath: join(home, '.codex', 'config.toml') }, proj))
    expect(r).toStartWith('Buracle H02: ')
    expect(r).toContain("Codex's own configuration")
    expect(await reason(mcp('mcp__someserver__save_file', { path: '~/.ssh/authorized_keys' }, proj))).toContain('SSH directory')
    expect(await reason(mcp(heap, { filePath: join(proj, 'h.heapsnapshot') }, proj))).toBeUndefined()
    expect(await reason(mcp('mcp__semble__find_related', { file_path: '.env', line: 1, repo: proj }, proj))).toBeUndefined()
  }), 20_000)

  test('a throwing write guard fails closed for an MCP call with a file argument', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const d = deps({ checkWrite: () => { throw new Error('boom') } })
    const r = await handleCodexHook('PreToolUse', mcp('mcp__chrome_devtools__take_screenshot', { filePath: join(proj, 's.png') }, proj), ctx(), d)
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toStartWith('Buracle H02: the write guard could not check')
  }), 20_000)
})

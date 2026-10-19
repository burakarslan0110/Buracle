import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WRITE_GUARD_FAILED, claudeHook, defaultHookDeps, type HookDeps } from '../../../src/adapters/claude/hook'
import type { AdapterContext } from '../../../src/adapters/registry'
import { hookBundle } from '../../../src/cli/hook-data'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import * as paths from '../../../src/engine/paths'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const NOW = 1_800_000_000_000
const SID = 'sess-self-protect'

function ctx(config = defaultConfig()): AdapterContext {
  const routing = hookBundle(paths.repoRoot(), () => { throw new Error('the classic hooks must not load the canonical bundle') }).routing
  const canonical = new Proxy({}, {
    get: (_t, key) => {
      if (key === 'routing') return routing
      throw new Error(`the classic hooks must not read canonical.${String(key)}`)
    },
  }) as CanonicalBundle
  return { repoRoot: paths.repoRoot(), config, paths, buracleBin: paths.shimPath(), get canonical(): CanonicalBundle { return canonical } }
}

const real = (over: Partial<HookDeps> = {}): Partial<HookDeps> => ({ ...defaultHookDeps, now: () => NOW, ...over })

function pre(tool: string, input: Record<string, unknown>, cwd: string, sid: unknown = SID): string {
  return JSON.stringify({ session_id: sid, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd, permission_mode: 'default' })
}

function decision(r: { stdout: string }): Record<string, unknown> | undefined {
  return r.stdout === '' ? undefined : (JSON.parse(r.stdout) as Record<string, Record<string, unknown>>)['hookSpecificOutput']
}

const denied = (r: { stdout: string }): string | undefined => {
  const d = decision(r)
  return d?.['permissionDecision'] === 'deny' ? String(d['permissionDecisionReason']) : undefined
}

describe('G1: Edit, MultiEdit and Write of project settings are judged by what they leave there', () => {
  test('Claude settings: a change that switches Buracle off is refused, an ordinary one passes', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    const file = join(proj, '.claude', 'settings.local.json')
    writeFileSync(file, '{\n  "permissions": { "allow": [] },\n  "autoMemoryDirectory": "~/x"\n}\n')
    const edit = (old_string: string, new_string: string) => pre('Edit', { file_path: file, old_string, new_string }, proj)
    expect(denied(await claudeHook('PreToolUse', edit('"allow": []', '"allow": ["Bash(npm test:*)"]'), ctx(), real()))).toBeUndefined()
    expect(denied(await claudeHook('PreToolUse', edit('"autoMemoryDirectory": "~/x"', '"autoMemoryDirectory": "~/x",\n  "enabledPlugins": { "buracle@buracle": false }'), ctx(), real()))).toContain("turns Buracle's plugin off")
    expect(denied(await claudeHook('PreToolUse', pre('MultiEdit', { file_path: file, edits: [{ old_string: '"allow": []', new_string: '"allow": ["x"]' }, { old_string: '"~/x"', new_string: '"~/x", "disableAllHooks": true' }] }, proj), ctx(), real()))).toContain('disableAllHooks')
    expect(denied(await claudeHook('PreToolUse', pre('Write', { file_path: join(proj, '.claude', 'settings.json'), content: '{ "env": { "BURACLE_HOME": "/tmp/fb" } }' }, proj), ctx(), real()))).toContain('BURACLE_HOME')
    expect(denied(await claudeHook('PreToolUse', pre('Write', { file_path: join(proj, '.claude', 'settings.json'), content: '{ "permissions": { "allow": ["Read"] } }' }, proj), ctx(), real()))).toBeUndefined()
    expect(denied(await claudeHook('PreToolUse', edit('"nope"', '"x"'), ctx(), real()))).toContain('file edit or whole-file write tool')
    expect(readFileSync(file, 'utf8')).toContain('"allow": []')
  }), 20_000)

  test('Codex TOML and omp YAML are parsed with the real parsers', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const write = (rel: string, content: string) => pre('Write', { file_path: join(proj, rel), content }, proj)
    expect(denied(await claudeHook('PreToolUse', write('.codex/config.toml', 'features = { hooks = false }\n'), ctx(), real()))).toContain('features.hooks')
    expect(denied(await claudeHook('PreToolUse', write('.codex/config.toml', '[features]\nhooks = true\n'), ctx(), real()))).toBeUndefined()
    expect(denied(await claudeHook('PreToolUse', write('.omp/config.yml', 'disabledExtensions:\n  - extension-module:buracle\n'), ctx(), real()))).toContain('disabledExtensions')
    expect(denied(await claudeHook('PreToolUse', write('opencode.json', '{ "plugins": ["-buracle"] }'), ctx(), real()))).toContain("removes Buracle's plugin")
    expect(denied(await claudeHook('PreToolUse', pre('NotebookEdit', { notebook_path: join(proj, '.claude', 'settings.json'), new_source: 'x' }, proj), ctx(), real()))).toContain('file edit or whole-file write tool')
  }), 20_000)
})

describe('G3: shell startup files', () => {
  test('an Edit that exports BURACLE_HOME is refused; other startup edits pass', () => withSandbox(async ({ root, home }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const rc = join(home, '.zshrc')
    writeFileSync(rc, 'export EDITOR=vim\n')
    const edit = (new_string: string) => pre('Edit', { file_path: rc, old_string: 'export EDITOR=vim', new_string }, proj)
    expect(denied(await claudeHook('PreToolUse', edit('export EDITOR=vim\nexport BURACLE_HOME=/tmp/fb'), ctx(), real()))).toContain('moves Buracle or a harness')
    expect(denied(await claudeHook('PreToolUse', edit('export EDITOR=vim\nset -gx XDG_CONFIG_HOME /tmp/x'), ctx(), real()))).toContain('moves Buracle or a harness')
    expect(denied(await claudeHook('PreToolUse', edit('export EDITOR=vim\nexport PATH="$HOME/bin:$PATH"'), ctx(), real()))).toBeUndefined()
  }), 20_000)
})

describe('G12: MCP calls that name a file they write go through H02', () => {
  const heap = 'mcp__plugin_buracle_chrome-devtools__take_heapsnapshot'

  test("chrome-devtools writing Claude Code's settings is refused; an ordinary output passes", () => withSandbox(async ({ root, home }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const r = await claudeHook('PreToolUse', pre(heap, { filePath: join(home, '.claude', 'settings.json') }, proj), ctx(), real())
    expect(denied(r)).toContain("Claude Code's own configuration")
    expect(denied(r)).toStartWith('Buracle H02 (guard.write): ')
    expect(denied(await claudeHook('PreToolUse', pre(heap, { filePath: '~/.ssh/authorized_keys' }, proj), ctx(), real()))).toContain('SSH directory')
    expect(denied(await claudeHook('PreToolUse', pre(heap, { filePath: '.claude/settings.local.json' }, proj), ctx(), real()))).toContain('file edit or whole-file write tool')
    expect(denied(await claudeHook('PreToolUse', pre(heap, { filePath: join(proj, 'heap.heapsnapshot') }, proj), ctx(), real()))).toBeUndefined()
  }), 20_000)

  test('a server Buracle does not install is judged too, and only by H02 (no usage ledger, no routing)', () => withSandbox(async ({ root, home }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    expect(denied(await claudeHook('PreToolUse', pre('mcp__myfiles__save_file', { path: join(home, '.ssh', 'authorized_keys'), content: 'x' }, proj), ctx(), real()))).toStartWith('Buracle H02 (guard.write): ')
    expect(denied(await claudeHook('PreToolUse', pre('mcp__claude_ai_Docs__export', { outputPath: join(home, '.claude', 'settings.json') }, proj), ctx(), real()))).toContain("Claude Code's own configuration")
    expect(await claudeHook('PreToolUse', pre('mcp__myfiles__save_file', { path: join(proj, 'notes.md'), content: 'x' }, proj), ctx(), real())).toEqual({ stdout: '', exitCode: 0 })
    expect(await claudeHook('PreToolUse', pre('mcp__myfiles__list', {}, proj), ctx(), real())).toEqual({ stdout: '', exitCode: 0 })
    expect(existsSync(join(paths.sessionDir('claude', SID), 'ledger.json'))).toBe(false)
  }), 20_000)

  test('read-only servers are not judged; a throwing guard fails closed', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const throwing = real({ core: { ...defaultHookDeps.core, checkWrite: () => { throw new Error('boom') } } })
    expect(denied(await claudeHook('PreToolUse', pre('mcp__plugin_buracle_semble__find_related', { file_path: '.env', line: 1, repo: proj }, proj), ctx(), throwing))).toBeUndefined()
    expect(denied(await claudeHook('PreToolUse', pre(heap, { filePath: join(proj, 'h.heapsnapshot') }, proj), ctx(), throwing))).toBe(WRITE_GUARD_FAILED)
  }), 20_000)
})

describe('G13: a payload without a valid session_id still meets the PreToolUse guards', () => {
  for (const sid of [undefined, '', '../etc', 'a b']) {
    test(`session_id ${JSON.stringify(sid)}: H01, H02 and H20 still deny; other events stay quiet`, () => withSandbox(async ({ root, home }) => {
      const proj = join(root, 'proj')
      mkdirSync(proj, { recursive: true })
      expect(denied(await claudeHook('PreToolUse', pre('Bash', { command: 'rm -rf ~' }, proj, sid), ctx(), real()))).toBeDefined()
      expect(denied(await claudeHook('PreToolUse', pre('Write', { file_path: join(home, '.ssh', 'config'), content: 'x' }, proj, sid), ctx(), real()))).toContain('SSH directory')
      expect(denied(await claudeHook('PreToolUse', pre('mcp__plugin_buracle_chrome-devtools__take_screenshot', { filePath: join(home, '.claude', 'settings.json') }, proj, sid), ctx(), real()))).toContain("Claude Code's own configuration")
      expect(denied(await claudeHook('PreToolUse', pre('Bash', { command: 'git push origin main' }, proj, sid), ctx(), real()))).toStartWith('Buracle H20 (consent.gate): ')
      expect(await claudeHook('PreToolUse', pre('Bash', { command: 'ls' }, proj, sid), ctx(), real())).toEqual({ stdout: '', exitCode: 0 })
      expect(await claudeHook('PreToolUse', pre('Write', { file_path: join(proj, 'a.ts'), content: 'x' }, proj, sid), ctx(), real())).toEqual({ stdout: '', exitCode: 0 })
      expect(await claudeHook('Stop', JSON.stringify({ session_id: sid, hook_event_name: 'Stop', cwd: proj }), ctx(), real())).toEqual({ stdout: '', exitCode: 0 })
      if (typeof sid === 'string' && sid !== '') expect(existsSync(join(paths.sessionsDir('claude'), sid))).toBe(false)
      expect(readFileSync(paths.logFile(), 'utf8')).toContain('no valid session_id')
    }), 30_000)
  }
})

describe('the PowerShell tool (Windows) meets the shell guards like Bash', () => {
  test('its tool_input.command reaches H01 and H20; an ordinary command passes', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    expect(denied(await claudeHook('PreToolUse', pre('PowerShell', { command: 'rm -rf ~' }, proj), ctx(), real()))).toContain('would delete your home directory')
    expect(denied(await claudeHook('PreToolUse', pre('PowerShell', { command: 'git push origin main' }, proj), ctx(), real()))).toStartWith('Buracle H20 (consent.gate): ')
    expect(denied(await claudeHook('PreToolUse', pre('PowerShell', { command: 'Get-ChildItem' }, proj), ctx(), real()))).toBeUndefined()
  }), 20_000)

  test('its command is read as PowerShell: Remove-Item and rmdir -r on the home are refused, recursive deletes and force pushes are held', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const ps = async (command: string) => denied(await claudeHook('PreToolUse', pre('PowerShell', { command }, proj), ctx(), real()))
    expect(await ps('Remove-Item -Recurse -Force ~')).toContain('`Remove-Item -Recurse -Force ~` would delete your home directory')
    expect(await ps('rmdir ~ -r')).toContain('would delete your home directory')
    expect(denied(await claudeHook('PreToolUse', pre('Bash', { command: 'rmdir ~ -r' }, proj), ctx(), real()))).toBeUndefined()
    expect(await ps('git push --force origin feature')).toStartWith('Buracle H20 (consent.gate): this command force-pushes')
    expect(await ps('rmdir src -r')).toStartWith('Buracle H20 (consent.gate): this command deletes a directory tree')
    expect(await ps('Remove-Item node_modules -Recurse -Force')).toBeUndefined()
  }), 20_000)
})

describe('H01 meets the write context shell writes are judged with (task W1.1)', () => {
  test('a deleting find that starts at the old memory vault is refused by H01 (BURACLE_VAULT no longer moves it); a protect glob covers a shell write', () => withSandbox(async ({ root, home }) => {
    const proj = join(root, 'proj')
    const vault = join(home, 'Documents', 'Buracle')
    mkdirSync(proj, { recursive: true })
    mkdirSync(vault, { recursive: true })
    const config = defaultConfig()
    config.guards.write.protect = ['secrets/**']
    await withEnv({ BURACLE_VAULT: join(root, 'elsewhere', 'vault') }, async () => {
      const r = denied(await claudeHook('PreToolUse', pre('Bash', { command: `find ${vault} -type f -delete` }, proj), ctx(config), real()))
      expect(r).toContain('Buracle memory vault')
      expect(r).not.toContain('H20')
    })
    expect(denied(await claudeHook('PreToolUse', pre('Bash', { command: 'echo x > secrets/a.txt' }, proj), ctx(config), real()))).toContain('guards.write.protect')
    expect(denied(await claudeHook('PreToolUse', pre('Bash', { command: 'echo x > notes/a.txt' }, proj), ctx(config), real()))).toBeUndefined()
  }), 20_000)
})

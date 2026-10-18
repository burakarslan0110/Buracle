import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyPlans, readLedger, type Op } from '../../src/engine/txn'
import { jsoncSet, tomlPatchTables } from '../../src/engine/merge'
import { withSandbox } from '../helpers/sandbox'

const O = 'test'

function write(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}
function read(p: string): string {
  return readFileSync(p, 'utf8')
}
async function uninstallAll(): Promise<void> {
  const led = await readLedger()
  const keys = Object.keys(led)
  await applyPlans([{ id: 'u', harness: 'core', ops: keys.map((k): Op => ({ kind: 'remove', path: k, owner: led[k]?.owner ?? O })) }])
}

describe('F20: install + uninstall is byte-restoring', () => {
  test('files without a final newline (TOML, Markdown, single-line JSON, JSONC, YAML)', () => withSandbox(async (sb) => {
    const h = sb.home
    const files: Record<string, string> = {
      '.codex/config.toml': '# user\nmodel = "gpt-5.5-codex"',
      '.codex/AGENTS.md': '# My global Codex notes\nBe terse.',
      '.codex/hooks.json': '{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say hi"}]}]}}',
      '.config/opencode/opencode.jsonc': '{"model": "anthropic/claude-sonnet-4-5"}',
      '.omp/agent/config.yml': 'theme: dark',
    }
    for (const [rel, text] of Object.entries(files)) write(join(h, rel), text)
    const group = { hooks: [{ type: 'command', command: '"$HOME/.buracle/bin/buracle" hook codex PreToolUse' }] }
    const r = await applyPlans([{ id: 'i', harness: 'core', ops: [
      { kind: 'toml-tables', path: join(h, '.codex/config.toml'), tables: { 'mcp_servers.c7': { command: 'npx', args: ['-y', 'c7@1'] } }, keys: { 'tui.status_line': ['model'] }, owner: O },
      { kind: 'md-block', path: join(h, '.codex/AGENTS.md'), id: 'buracle', content: 'rules', owner: O },
      { kind: 'json-list-merge', path: join(h, '.codex/hooks.json'), pointer: 'hooks.PreToolUse', items: [group], identity: 'hooks.0.command', owner: O },
      { kind: 'jsonc-merge', path: join(h, '.config/opencode/opencode.jsonc'), set: { share: 'disabled', 'mcp.c7': { type: 'local', command: ['npx', 'c7'] } }, owner: O },
      { kind: 'yaml-merge', path: join(h, '.omp/agent/config.yml'), set: { 'memory.backend': 'off', 'tools.approvalMode': 'write' }, owner: O },
    ] }])
    expect(r.conflicts).toEqual([])
    for (const rel of Object.keys(files)) expect(read(join(h, rel)).endsWith('\n')).toBe(false)
    expect(read(join(h, '.codex/hooks.json'))).not.toContain('\n')
    await uninstallAll()
    for (const [rel, text] of Object.entries(files)) expect(read(join(h, rel))).toBe(text)
  }))

  test('a JSONC neighbour stays on its one line through install and uninstall', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.config/opencode/opencode.jsonc')
    const text = '{\n  // my servers\n  "mcp": {\n    "notes": { "type": "local", "command": ["node", "/Users/me/bin/notes-mcp.js"], },\n  },\n  "b": { "x": 1 }\n}\n'
    write(p, text)
    await applyPlans([{ id: 'i', harness: 'core', ops: [{ kind: 'jsonc-merge', path: p, set: { 'mcp.context7': { type: 'remote', url: 'https://x' }, share: 'disabled' }, owner: O }] }])
    expect(read(p)).toContain('    "notes": { "type": "local", "command": ["node", "/Users/me/bin/notes-mcp.js"], },\n')
    expect(read(p)).toContain('  "b": { "x": 1 }')
    await uninstallAll()
    expect(read(p)).toBe(text)
  }))

  test('a comment inside a TOML table Buracle owns survives an update (a pin bump)', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex/config.toml')
    write(p, 'model = "m"\n')
    const op = (pin: string): Op => ({ kind: 'toml-tables', path: p, tables: { 'mcp_servers.context7': { command: 'npx', args: ['-y', `@upstash/context7-mcp@${pin}`] } }, owner: O })
    await applyPlans([{ id: 'i', harness: 'core', ops: [op('4.5.0')] }])
    write(p, read(p).replace('[mcp_servers.context7]\n', '[mcp_servers.context7]\n# NOTE(me): API key comes from the env\n'))
    const r = await applyPlans([{ id: 'i', harness: 'core', ops: [op('4.6.0')] }])
    expect(r.conflicts).toEqual([])
    expect(read(p)).toBe('model = "m"\n\n[mcp_servers.context7]\n# NOTE(me): API key comes from the env\ncommand = "npx"\nargs = ["-y", "@upstash/context7-mcp@4.6.0"]\n')
  }))

  test('a YAML flow map keeps its spacing and comment', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.omp/agent/config.yml')
    const text = '# omp settings\nstatusLine: {separator: powerline}   # flow map\ntools: {bash: {timeout: 120}}\ntheme: dark\n'
    write(p, text)
    await applyPlans([{ id: 'i', harness: 'core', ops: [{ kind: 'yaml-merge', path: p, set: { 'statusLine.showHookStatus': false, 'tools.approvalMode': 'write' }, owner: O }] }])
    expect(read(p)).toBe('# omp settings\nstatusLine: {separator: powerline, showHookStatus: false}   # flow map\ntools: {bash: {timeout: 120}, approvalMode: write}\ntheme: dark\n')
    await uninstallAll()
    expect(read(p)).toBe(text)
  }))

  test('helpers: single-line JSON edits stay compact; TOML keys keep their order and comments', () => {
    expect(jsoncSet('{"a": 1}', 'b', { c: [1] })).toBe('{"a": 1, "b": {"c":[1]}}')
    expect(jsoncSet('{"a": 1, "b": {"c":[1]}}', 'b', undefined)).toBe('{"a": 1}')
    expect(tomlPatchTables('[t]\na = 1 # one\n# about b\nb = 2\n', { t: { a: 1, b: 3, c: 4 } })).toBe('[t]\na = 1 # one\n# about b\nb = 3\nc = 4\n')
  })
})

import { describe, expect, test } from 'bun:test'
import { defaultConfig } from '../../../src/core/config'
import { claudeNativeOff, codexNativeOff, offServersFor, ompNativeOff, opencodeNativeOff, parseJsoncLoose, withOffServers } from '../../../src/core/policy/mcp-off'
import type { McpHealth } from '../../../src/core/policy/routing'
import { sessionMcpHealth } from '../../../src/core/policy/usage'

describe('the off servers of a harness', () => {
  test('offServersFor reads mcp.off.<harness>, and is empty for a config without the section', () => {
    const c = defaultConfig()
    c.mcp.off.codex = ['web-fetch', 'semble']
    expect(offServersFor(c, 'codex')).toEqual(['web-fetch', 'semble'])
    expect(offServersFor(c, 'claude')).toEqual([])
    expect(offServersFor({ mcp: undefined }, 'omp')).toEqual([])
    expect(offServersFor({ mcp: { off: { omp: ['ok', 3, ''] } } }, 'omp')).toEqual(['ok'])
  })

  test('Claude Code: a deniedMcpServers entry by name (plain or plugin form), by the exact command, or by URL; the per-project /mcp toggle in either name form', () => {
    const servers = {
      'web-fetch': { commands: [['bun', '/repo/harness/claude/bin/buracle.ts', 'mcp', 'run', 'web-fetch'], ['bun', '${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts', 'mcp', 'run', 'web-fetch']] },
      semble: { commands: [['bun', '/repo/harness/claude/bin/buracle.ts', 'mcp', 'run', 'semble']] },
      context7: { commands: [['bun', '/repo/harness/claude/bin/buracle.ts', 'mcp', 'run', 'context7']] },
      grep: { commands: [], url: 'https://mcp.grep.app' },
      codegraph: { commands: [] },
    }
    const user = { deniedMcpServers: [{ serverName: 'plugin:buracle:context7' }, { serverCommand: ['bun', '/repo/harness/claude/bin/buracle.ts', 'mcp', 'run', 'web-fetch'] }] }
    const project = { deniedMcpServers: [{ serverUrl: 'https://mcp.grep.app' }, { serverCommand: ['bun', '/repo/harness/claude/bin/buracle.ts', 'mcp', 'run'] }, 'junk'] }
    const managed = { deniedMcpServers: [{ serverName: 'semble' }] }
    const state = { projects: { '/work/app': { disabledMcpServers: ['plugin:buracle:codegraph', 'other'] }, '/elsewhere': { disabledMcpServers: ['context7'] } } }
    expect(claudeNativeOff({ settings: [user, project, undefined, managed], state, project: '/work/app', servers }).sort()).toEqual(['codegraph', 'context7', 'grep', 'semble', 'web-fetch'])
    expect(claudeNativeOff({ settings: [{ deniedMcpServers: [{ serverCommand: ['bun', '${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts', 'mcp', 'run', 'web-fetch'] }] }], state: undefined, project: '/x', servers })).toEqual(['web-fetch'])
    expect(claudeNativeOff({ settings: ['not json', null, 42], state: 'x', project: '/work/app', servers })).toEqual([])
  })

  test('Codex: enabled = false in its server table; OpenCode: disabled: true (or the older enabled: false); omp: the disabledServers list', () => {
    expect(codexNativeOff({ mcp_servers: { 'web-fetch': { enabled: false, command: 'x' }, semble: { enabled: true }, context7: {} } })).toEqual(['web-fetch'])
    expect(codexNativeOff('nope')).toEqual([])
    expect(opencodeNativeOff([{ mcp: { servers: { 'web-fetch': { type: 'local', disabled: true }, semble: { disabled: false } } } }, { mcp: { context7: { enabled: false } } }, undefined]).sort()).toEqual(['context7', 'web-fetch'])
    expect(ompNativeOff([{ disabledServers: ['web-search', 7] }, { disabledServers: 'x' }, { mcpServers: {} }])).toEqual(['web-search'])
  })

  test('parseJsoncLoose reads JSON with comments and trailing commas, keeps // and /* inside strings, and gives undefined for broken text', () => {
    const text = '{\n  // a comment\n  "url": "https://x.y/*not*/z", /* block */\n  "list": [1, 2,],\n  "s": "a \\" // still string",\n}\n'
    expect(parseJsoncLoose(text)).toEqual({ url: 'https://x.y/*not*/z', list: [1, 2], s: 'a " // still string' })
    expect(parseJsoncLoose('{ "a": ')).toBeUndefined()
  })

  test('withOffServers marks them off and leaves the rest; the session error count never turns off back into down', () => {
    const health: McpHealth = { 'web-fetch': 'ok', context7: 'down', semble: 'unknown' }
    const folded = withOffServers(health, ['web-fetch', 'grep'])
    expect(folded).toEqual({ 'web-fetch': 'off', context7: 'down', semble: 'unknown', grep: 'off' })
    expect(health['web-fetch']).toBe('ok')
    expect(withOffServers(health, [])).toBe(health)
    const ledger = { mcpErrors: { 'web-fetch': 5, context7: 1 } }
    expect(sessionMcpHealth(folded, ledger as never)['web-fetch']).toBe('off')
  })
})

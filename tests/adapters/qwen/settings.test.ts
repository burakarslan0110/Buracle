import { describe, expect, test } from 'bun:test'
import { adapter } from '../../../src/adapters/qwen/index'
import { HOOK_COMMAND_PREFIX, isBuracleCommand, qwenExcluded, qwenHooks, qwenMcpEntry, qwenMcpServers, QWEN_HOOK_EVENTS, QWEN_UNSERVED, settingsFragment } from '../../../src/adapters/qwen/settings'
import type { HookBinding } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import { harnessProfile } from '../../../src/core/harness/index'
import { canonical, ctx } from './helpers'

const bindingEvents = (b: HookBinding): string[] => [b.event, ...(b.also ?? []).map(a => a.event)]

describe('Qwen Code settings: hooks from canonical/hooks.yaml', () => {
  const hooks = qwenHooks(canonical)

  test('every event of a qwen binding is registered or recorded as not served, and every event is a native Qwen event', () => {
    const wanted = new Set(canonical.hooks.hooks.flatMap(h => { const b = h.bindings.qwen; return b !== undefined && !('unsupported' in b) ? bindingEvents(b) : [] }))
    for (const e of wanted) expect({ e, handled: Object.keys(hooks).includes(e) || e in QWEN_UNSERVED }).toEqual({ e, handled: true })
    for (const e of Object.keys(hooks)) expect({ e, native: harnessProfile('qwen').events.native.includes(e) }).toEqual({ e, native: true })
    for (const e of Object.keys(QWEN_UNSERVED)) expect({ e, reason: QWEN_UNSERVED[e]?.length }).toEqual({ e, reason: expect.any(Number) })
    expect(Object.keys(hooks).every(e => (QWEN_HOOK_EVENTS as readonly string[]).includes(e))).toBe(true)
  })

  test('each group runs the one constant command with the event as its argument, and the names tell sync and async groups apart', () => {
    const names = new Set<string>()
    for (const [event, groups] of Object.entries(hooks)) for (const g of groups) {
      const h = g.hooks[0]
      expect(h?.command).toBe(`${HOOK_COMMAND_PREFIX}${event}`)
      expect(isBuracleCommand(h?.command)).toBe(true)
      expect(names.has(h?.name ?? '')).toBe(false)
      names.add(h?.name ?? '')
    }
    expect(hooks['PostToolUse']?.map(g => g.hooks[0]?.async)).toEqual([undefined, true])
  })

  test('timeouts are milliseconds of 1000 or more, which every supported Qwen Code release reads as milliseconds', () => {
    for (const groups of Object.values(hooks)) for (const g of groups) expect(g.hooks[0]?.timeout).toBeGreaterThanOrEqual(1000)
    expect(hooks['PreToolUse']?.[0]?.hooks[0]?.timeout).toBe(10_000)
  })

  test('a matcher is the union of the bindings, anchored; events that take none get none', () => {
    const async = hooks['PostToolUse']?.find(g => g.hooks[0]?.async === true)
    expect(async?.matcher).toMatch(/^\^\(\?:.*mcp__\.\*.*\)\$$/)
    expect(hooks['PostToolUseFailure']?.[0]?.matcher).toBe('^(?:mcp__.*)$')
    for (const e of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd']) for (const g of hooks[e] ?? []) expect(g.matcher).toBeUndefined()
    // The shell tools of the guards are among the PreToolUse tools, or the group has no matcher and covers every tool.
    const pre = hooks['PreToolUse']?.[0]?.matcher
    expect(pre === undefined || /run_shell_command/.test(pre)).toBe(true)
  })

  test('the isBuracleCommand test knows Buracle hook commands only', () => {
    expect(isBuracleCommand('"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" hook qwen Stop')).toBe(true)
    expect(isBuracleCommand('/usr/bin/buracle hook claude Stop')).toBe(false)
    expect(isBuracleCommand('./my-hook.sh')).toBe(false)
    expect(isBuracleCommand(undefined)).toBe(false)
  })
})

describe('Qwen Code settings: MCP servers from canonical/mcp.yaml', () => {
  test('exactly the servers the catalog assigns to qwen', () => {
    const want = Object.keys(canonical.mcp.servers).filter(id => canonical.mcp.servers[id]?.harnesses.includes('qwen')).sort()
    expect(Object.keys(qwenMcpServers(canonical, '/x/bin/buracle')).sort()).toEqual(want)
    expect(want).toContain('buracle-memory')
  })

  test('a stdio server runs through the shim by absolute path; an HTTP server names its URL both ways (httpUrl for the stable line, url and type for 1.0 preview); env references become ${NAME}', () => {
    const servers = qwenMcpServers(canonical, '/x/bin/buracle')
    expect(servers['buracle-memory']).toMatchObject({ command: '/x/bin/buracle', args: ['mcp', 'memory'] })
    expect(servers['web-fetch']).toMatchObject({ command: '/x/bin/buracle', args: ['mcp', 'run', 'web-fetch'] })
    expect(qwenMcpEntry('r', { transport: 'http', url: 'https://x.test/mcp', tool_timeout_sec: 20 } as never, '/b')).toEqual({ httpUrl: 'https://x.test/mcp', url: 'https://x.test/mcp', type: 'http', timeout: 20_000 })
    expect(qwenMcpEntry('s', { transport: 'stdio', command: 'tool', args: ['a'], env: { KEY: '${ENV:SECRET}', PLAIN: 'v' } } as never, '/b')).toEqual({ command: 'tool', args: ['a'], env: { KEY: '${SECRET}', PLAIN: 'v' } })
  })

  test('the servers turned off for qwen go to Qwen\'s own deny list; unknown ids are dropped', () => {
    const cfg = defaultConfig()
    cfg.mcp.off.qwen = ['web-fetch', 'not-a-server']
    expect(qwenExcluded(canonical, cfg)).toEqual(['web-fetch'])
    expect(qwenExcluded(canonical, defaultConfig())).toEqual([])
  })
})

describe('Qwen Code adapter build', () => {
  test('writes one deterministic fragment of what the install merges into settings.json', async () => {
    const files = await adapter.build(ctx())
    expect(files.map(f => f.path)).toEqual(['settings.fragment.json'])
    expect(files[0]?.content).toBe(settingsFragment(canonical, '{buracle}'))
    expect(files[0]?.content).toBe((await adapter.build(ctx()))[0]?.content as string)
    const parsed = JSON.parse(files[0]?.content as string) as { hooks: Record<string, unknown>, mcpServers: Record<string, { command?: string }> }
    expect(Object.keys(parsed.hooks)).toEqual(Object.keys(qwenHooks(canonical)))
    expect(parsed.mcpServers['buracle-memory']?.command).toBe('{buracle}')
  })
})

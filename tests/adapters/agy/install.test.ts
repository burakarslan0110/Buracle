import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agyHooks, agyMcpServers, HOOK_NAME, isBuracleCommand } from '../../../src/adapters/agy/config'
import { adapter } from '../../../src/adapters/agy/index'
import { defaultConfig } from '../../../src/core/config'
import { harnessProfile } from '../../../src/core/harness/index'
import { jsoncParse } from '../../../src/engine/merge'
import { applyPlans } from '../../../src/engine/txn'
import { withSandbox } from '../../helpers/sandbox'
import { canonical, ctx } from './helpers'

type Json = Record<string, unknown>
const dir = (home: string): string => join(home, '.gemini', 'config')
const read = (file: string): Json => {
  const r = jsoncParse(readFileSync(file, 'utf8'))
  if (!r.ok) throw new Error(r.error)
  return r.value as Json
}
const install = async (config = defaultConfig()) => applyPlans([await adapter.installPlan(ctx(config))])
const uninstall = async () => applyPlans([await (adapter.uninstallPlan as NonNullable<typeof adapter.uninstallPlan>)(ctx())])

describe('the generated hooks and servers', () => {
  const hooks = agyHooks(canonical)
  const flat = (event: string): Array<{ command: string, timeout: number }> => (hooks[event] as Json[]).flatMap(g => (g['hooks'] !== undefined ? g['hooks'] as never[] : [g as never]))

  test('one synchronous command handler per event the bindings use, in seconds; tool events carry a matcher group', () => {
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'Stop'])
    for (const e of Object.keys(hooks)) {
      expect(flat(e)).toHaveLength(1)
      expect(flat(e)[0]?.command).toEndWith(` hook agy ${e}`)
      expect(isBuracleCommand(flat(e)[0]?.command)).toBe(true)
    }
    expect((hooks['PreToolUse'] as Json[])[0]?.['matcher']).toBe('*')
    expect((hooks['SessionStart'] as Json[])[0]?.['matcher']).toBeUndefined()
    // The longest binding of each event, in seconds: H16 holds SessionStart for 30 s, the checkers hold PostToolUse for 30 s.
    expect(Object.fromEntries(Object.keys(hooks).map(e => [e, flat(e)[0]?.timeout]))).toEqual({ SessionStart: 30, PreToolUse: 10, PostToolUse: 30, PreInvocation: 10, Stop: 15 })
  })

  test('every agy binding of hooks.yaml names an event the hooks file registers', () => {
    const events = new Set(Object.keys(hooks))
    for (const h of canonical.hooks.hooks) {
      const b = h.bindings.agy
      if (b === undefined || 'unsupported' in b) continue
      for (const e of [b.event, ...(b.also ?? []).map(a => a.event)]) expect({ id: h.id, e, ok: events.has(e) }).toEqual({ id: h.id, e, ok: true })
    }
  })

  test('the MCP entries are stdio commands or url entries, with no environment forwarding', () => {
    const servers = agyMcpServers(canonical, '/x/bin/buracle')
    expect(servers['buracle-memory']).toEqual({ command: '/x/bin/buracle', args: ['mcp', 'memory'] })
    expect(servers['grep']).toEqual({ url: 'https://mcp.grep.app' })
    expect(JSON.stringify(servers)).not.toContain('${')
    expect(Object.keys(servers).sort()).toEqual(Object.keys(canonical.mcp.servers).filter(id => canonical.mcp.servers[id]?.harnesses.includes('agy')).sort())
  })
})

describe('install into ~/.gemini/config', () => {
  test('writes the buracle hook and the MCP servers and nothing else in the folder', async () => {
    await withSandbox(async ({ home }) => {
      const r = await install()
      expect(r.conflicts).toEqual([])
      expect(Object.keys(read(join(dir(home), 'hooks.json')))).toEqual([HOOK_NAME])
      expect(read(join(dir(home), 'hooks.json'))[HOOK_NAME]).toEqual(JSON.parse(JSON.stringify(agyHooks(canonical))))
      expect(Object.keys(read(join(dir(home), 'mcp_config.json'))['mcpServers'] as Json).sort()).toEqual(Object.keys(agyMcpServers(canonical, '/x/bin/buracle')).sort())
      expect(readdirSync(dir(home)).sort()).toEqual(['hooks.json', 'mcp_config.json'])
      expect(existsSync(join(home, '.agents'))).toBe(false)
    })
  })

  test('a second install changes nothing', async () => {
    await withSandbox(async ({ home }) => {
      await install()
      const files = ['hooks.json', 'mcp_config.json'].map(f => join(dir(home), f))
      const first = files.map(f => readFileSync(f, 'utf8'))
      expect((await install()).applied).toBe(0)
      expect(files.map(f => readFileSync(f, 'utf8'))).toEqual(first)
    })
  })

  test('the user\'s own hooks and servers stay; a server turned off in mcp.off.agy is written disabled', async () => {
    await withSandbox(async ({ home }) => {
      mkdirSync(dir(home), { recursive: true })
      writeFileSync(join(dir(home), 'hooks.json'), JSON.stringify({ mine: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: '/my/lint.sh' }] }] } }))
      writeFileSync(join(dir(home), 'mcp_config.json'), JSON.stringify({ mcpServers: { mine: { command: 'my-server', disabled: false } } }))
      const cfg = defaultConfig()
      cfg.mcp.off.agy = ['web-fetch']
      expect((await install(cfg)).conflicts).toEqual([])
      expect(Object.keys(read(join(dir(home), 'hooks.json'))).sort()).toEqual(['buracle', 'mine'])
      const servers = read(join(dir(home), 'mcp_config.json'))['mcpServers'] as Record<string, Json>
      expect(servers['mine']).toEqual({ command: 'my-server', disabled: false })
      expect(servers['web-fetch']?.['disabled']).toBe(true)
      expect(servers['context7']?.['disabled']).toBeUndefined()
    })
  })

  test('a Buracle server entry the user changed is kept, and a file that is not valid JSON is not touched', async () => {
    await withSandbox(async ({ home }) => {
      await install()
      const file = join(dir(home), 'mcp_config.json')
      const s = read(file)['mcpServers'] as Record<string, Json>
      const edited = { ...s['buracle-memory'], args: ['mcp', 'memory', '--mine'] }
      writeFileSync(file, JSON.stringify({ mcpServers: { ...s, 'buracle-memory': edited } }, null, 2))
      const r = await install()
      expect((read(file)['mcpServers'] as Record<string, Json>)['buracle-memory']).toEqual(edited)
      expect(r.skipped.length + r.conflicts.length).toBeGreaterThan(0)
      writeFileSync(join(dir(home), 'hooks.json'), '{ "buracle": ')
      expect((await install()).conflicts.length).toBeGreaterThan(0)
      expect(readFileSync(join(dir(home), 'hooks.json'), 'utf8')).toBe('{ "buracle": ')
    })
  })

  test('uninstall removes what Buracle wrote and leaves the user\'s entries', async () => {
    await withSandbox(async ({ home }) => {
      mkdirSync(dir(home), { recursive: true })
      writeFileSync(join(dir(home), 'hooks.json'), JSON.stringify({ mine: { Stop: [{ command: '/my/stop.sh' }] } }))
      writeFileSync(join(dir(home), 'mcp_config.json'), JSON.stringify({ mcpServers: { mine: { command: 'x' } } }))
      await install()
      await uninstall()
      expect(read(join(dir(home), 'hooks.json'))).toEqual({ mine: { Stop: [{ command: '/my/stop.sh' }] } })
      expect(read(join(dir(home), 'mcp_config.json'))).toEqual({ mcpServers: { mine: { command: 'x' } } })
    })
  })

  test('uninstall with nothing installed is an empty plan', async () => {
    await withSandbox(async () => {
      expect((await uninstall()).applied).toBe(0)
    })
  })

  test('the skills are not the adapter\'s: the profile asks the shared install for a link per skill in <config>/skills', () => {
    expect(harnessProfile('agy').skills).toMatchObject({ readsAgentsDir: false, linkDir: 'skills' })
    expect(harnessProfile('agy').adapterPending).toBeUndefined()
    expect(harnessProfile('agy').companionPending).toBe(true)
  })
})

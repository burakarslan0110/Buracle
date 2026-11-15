import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { adapter } from '../../../src/adapters/qwen/index'
import { isBuracleCommand, qwenHooks, qwenMcpServers } from '../../../src/adapters/qwen/settings'
import { defaultConfig } from '../../../src/core/config'
import { jsoncParse } from '../../../src/engine/merge'
import { applyPlans } from '../../../src/engine/txn'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { canonical, ctx } from './helpers'

type Settings = { hooks?: Record<string, Array<{ matcher?: string, hooks: Array<{ command: string, name?: string }> }>>, mcpServers?: Record<string, unknown>, mcp?: { excluded?: string[] }, [k: string]: unknown }

const settingsFile = (home: string): string => join(home, '.qwen', 'settings.json')
const read = (home: string): Settings => {
  const r = jsoncParse(readFileSync(settingsFile(home), 'utf8'))
  if (!r.ok) throw new Error(r.error)
  return r.value as Settings
}
const install = async (config = defaultConfig()) => applyPlans([await adapter.installPlan(ctx(config))])
const uninstall = async () => applyPlans([await (adapter.uninstallPlan as NonNullable<typeof adapter.uninstallPlan>)(ctx())])

describe('install into ~/.qwen/settings.json', () => {
  test('writes the hooks and the MCP servers of canonical/ and nothing else in the folder', async () => {
    await withSandbox(async ({ home }) => {
      const r = await install()
      expect(r.conflicts).toEqual([])
      const s = read(home)
      expect(Object.keys(s.hooks ?? {})).toEqual(Object.keys(qwenHooks(canonical)))
      expect(Object.keys(s.mcpServers ?? {}).sort()).toEqual(Object.keys(qwenMcpServers(canonical, '/x/bin/buracle')).sort())
      expect(s.mcp).toBeUndefined()
      expect(readdirSync(join(home, '.qwen'))).toEqual(['settings.json'])
      expect(existsSync(join(home, '.agents'))).toBe(false)
    })
  })

  test('a second install changes nothing', async () => {
    await withSandbox(async ({ home }) => {
      await install()
      const first = readFileSync(settingsFile(home), 'utf8')
      const again = await install()
      expect(again.applied).toBe(0)
      expect(readFileSync(settingsFile(home), 'utf8')).toBe(first)
    })
  })

  test('the user\'s own hooks, servers, keys and comments stay; a hook of theirs on the same event is kept next to Buracle\'s', async () => {
    await withSandbox(async ({ home }) => {
      mkdirSync(join(home, '.qwen'), { recursive: true })
      writeFileSync(settingsFile(home), `{
  // my settings
  "theme": "dark",
  "hooks": { "PreToolUse": [ { "matcher": "^edit$", "hooks": [ { "type": "command", "command": "/my/lint.sh" } ] } ] },
  "mcpServers": { "mine": { "command": "my-server" } },
  "mcp": { "excluded": ["theirs"] },
}
`)
      await withEnv({}, async () => {
        const cfg = defaultConfig()
        cfg.mcp.off.qwen = ['web-fetch']
        expect((await install(cfg)).conflicts).toEqual([])
      })
      const text = readFileSync(settingsFile(home), 'utf8')
      expect(text).toContain('// my settings')
      const s = read(home)
      expect(s['theme']).toBe('dark')
      expect(s.mcpServers?.['mine']).toEqual({ command: 'my-server' })
      expect(s.mcp?.excluded).toEqual(['theirs', 'web-fetch'])
      const pre = s.hooks?.['PreToolUse'] ?? []
      expect(pre.some(g => g.hooks[0]?.command === '/my/lint.sh')).toBe(true)
      expect(pre.filter(g => isBuracleCommand(g.hooks[0]?.command)).length).toBe(1)
    })
  })

  test('a Buracle server entry the user changed is kept, and a file that is not valid JSON is not touched', async () => {
    await withSandbox(async ({ home }) => {
      await install()
      const s = read(home)
      const edited = { ...(s.mcpServers?.['buracle-memory'] as object), args: ['mcp', 'memory', '--mine'] }
      writeFileSync(settingsFile(home), JSON.stringify({ ...s, mcpServers: { ...s.mcpServers, 'buracle-memory': edited } }, null, 2))
      const r = await install()
      expect(read(home).mcpServers?.['buracle-memory']).toEqual(edited)
      expect(r.skipped.length + r.conflicts.length).toBeGreaterThan(0)
      writeFileSync(settingsFile(home), '{ "hooks": ')
      const broken = await install()
      expect(broken.conflicts.length).toBeGreaterThan(0)
      expect(readFileSync(settingsFile(home), 'utf8')).toBe('{ "hooks": ')
    })
  })

  test('uninstall removes what Buracle wrote and leaves the user\'s keys', async () => {
    await withSandbox(async ({ home }) => {
      mkdirSync(join(home, '.qwen'), { recursive: true })
      writeFileSync(settingsFile(home), JSON.stringify({ theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: '/my/stop.sh' }] }] }, mcpServers: { mine: { command: 'x' } } }, null, 2))
      await install()
      await uninstall()
      const s = read(home)
      expect(s['theme']).toBe('dark')
      expect(s.mcpServers).toEqual({ mine: { command: 'x' } })
      const left = Object.values(s.hooks ?? {}).flat().map(g => g.hooks[0]?.command)
      expect(left).toEqual(['/my/stop.sh'])
    })
  })

  test('uninstall with nothing installed is an empty plan', async () => {
    await withSandbox(async () => {
      expect((await uninstall()).applied).toBe(0)
    })
  })

  test('QWEN_HOME relocates the folder the install writes to', async () => {
    await withSandbox(async ({ home }) => {
      await withEnv({ QWEN_HOME: join(home, 'elsewhere') }, async () => {
        await install()
        expect(existsSync(join(home, 'elsewhere', 'settings.json'))).toBe(true)
        expect(existsSync(join(home, '.qwen'))).toBe(false)
      })
    })
  })
})

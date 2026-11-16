import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agyAgentTools, agyPluginFiles, packageVersion } from '../../../src/adapters/agy/plugin'
import { adapter } from '../../../src/adapters/agy/index'
import { applyPlans, readLedger } from '../../../src/engine/txn'
import { withSandbox } from '../../helpers/sandbox'
import { canonical, ctx, REPO } from './helpers'

const plugin = (home: string): string => join(home, '.gemini', 'config', 'plugins', 'buracle')
const files = agyPluginFiles(canonical, '1.2.3')
const get = (path: string): string => files.find(f => f.path === path)?.content ?? ''
const install = async () => applyPlans([await adapter.installPlan(ctx())])
const uninstall = async () => applyPlans([await (adapter.uninstallPlan as NonNullable<typeof adapter.uninstallPlan>)(ctx())])
const walk = (dir: string, base = dir): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)])).sort()

describe('the generated plugin files', () => {
  test('a manifest, one always-on rules file, one file per path rule, one per review agent and the companion agent', () => {
    const paths = canonical.rules.filter(r => r.scope === 'paths').map(r => `rules/buracle-${r.id}.md`)
    const agents = [...canonical.agents.map(a => `agents/${a.id}.md`), 'agents/buracle-companion.md']
    expect(files.map(f => f.path).sort()).toEqual(['plugin.json', 'rules/AGENTS.md', ...paths, ...agents].sort())
    expect(JSON.parse(get('plugin.json'))).toEqual({ name: 'buracle', displayName: 'Buracle Stack', version: '1.2.3', description: expect.any(String) })
    expect(packageVersion(REPO)).toMatch(/^\d+\.\d+\.\d+/)
  })

  test('the always-on rules are one plain Markdown file: every always rule, the commands section, no frontmatter, under the 24 KB file cap', () => {
    const text = get('rules/AGENTS.md')
    expect(text.startsWith('---')).toBe(false)
    expect(text).toContain('# Buracle Stack commands in AGY CLI')
    expect(text).toContain('`/plan-build`')
    for (const cmd of ['buracle mem remember', 'buracle mem ui --open', 'buracle plan status --json']) expect(text).toContain(cmd)
    expect(text).not.toContain('{{')
    expect(Buffer.byteLength(text)).toBeLessThan(24_000)
  })

  test('a path rule is a rule file with trigger: glob and one comma-separated globs string', () => {
    const go = canonical.rules.find(r => r.id === 'go')
    expect(go).toBeDefined()
    const text = get('rules/buracle-go.md')
    expect(text).toStartWith('---\ntrigger: glob\nglobs: "**/*.go, **/go.mod, **/go.sum, **/go.work"\n')
    expect(text).not.toContain('paths:')
    expect(text.split('---\n')[2]).toContain('# Go')
  })

  test('a review agent is a subagent that is not a main agent, read-only unless it says otherwise, with its shared body resolved', () => {
    for (const a of canonical.agents) {
      const text = get(`agents/${a.id}.md`)
      expect(text).toStartWith(`---\nname: "${a.id}"\n`)
      expect(text).toContain('\nsubagent: true\nmainAgent: false\n')
      expect(text).toMatch(/\ntools: \[read_file[^\]]*\]\n/)
      expect(text).not.toMatch(/edit_file|write_file/)
      expect(text).toContain('\ninheritMcp: true\n')
      expect(text).not.toContain('{{include')
    }
    expect(agyAgentTools({ id: 'x', file: 'agents/x.md', body: '', frontmatter: { access: 'read-write', tools: ['read', 'edit', 'write', 'bash', 'web'] } })).toEqual(['read_file', 'edit_file', 'write_file', 'run_command', 'manage_task', 'search_web'])
    expect(agyAgentTools({ id: 'x', file: 'agents/x.md', body: '', frontmatter: { tools: ['edit', 'write'] } })).toEqual(['read_file'])
  })

  test('the generated files are the same on every call', () => {
    expect(agyPluginFiles(canonical, '1.2.3')).toEqual(files)
  })
})

describe('install of the plugin', () => {
  test('writes the plugin folder under <config>/plugins/buracle and nothing else beside the hooks, servers and status line', async () => {
    await withSandbox(async ({ home }) => {
      expect((await install()).conflicts).toEqual([])
      expect(walk(plugin(home))).toEqual(files.map(f => f.path).sort())
      for (const f of files.filter(x => x.path !== 'plugin.json')) expect(readFileSync(join(plugin(home), f.path), 'utf8')).toBe(f.content)
      expect(readdirSync(join(home, '.gemini', 'config')).sort()).toEqual(['hooks.json', 'mcp_config.json', 'plugins'])
      expect((await install()).applied).toBe(0)
    })
  })

  test('a plugin file the user changed is kept, and a file of the user\'s own in the folder stays', async () => {
    await withSandbox(async ({ home }) => {
      await install()
      const rules = join(plugin(home), 'rules', 'AGENTS.md')
      writeFileSync(rules, '# my rules\n')
      writeFileSync(join(plugin(home), 'rules', 'mine.md'), '# mine\n')
      const r = await install()
      expect(readFileSync(rules, 'utf8')).toBe('# my rules\n')
      expect(r.skipped.length + r.conflicts.length).toBeGreaterThan(0)
      await uninstall()
      expect(readFileSync(rules, 'utf8')).toBe('# my rules\n')
      expect(existsSync(join(plugin(home), 'rules', 'mine.md'))).toBe(true)
      expect(walk(plugin(home))).toEqual(['rules/AGENTS.md', 'rules/mine.md'])
    })
  })

  test('uninstall removes every file of the plugin and the ledger holds none of them afterwards', async () => {
    await withSandbox(async ({ home }) => {
      mkdirSync(join(home, '.gemini', 'config', 'plugins', 'other'), { recursive: true })
      writeFileSync(join(home, '.gemini', 'config', 'plugins', 'other', 'plugin.json'), '{"name":"other"}')
      await install()
      await uninstall()
      expect(existsSync(plugin(home)) ? walk(plugin(home)) : []).toEqual([])
      expect(existsSync(join(home, '.gemini', 'config', 'plugins', 'other', 'plugin.json'))).toBe(true)
      expect(Object.keys(await readLedger()).filter(p => p.includes('/plugins/buracle/'))).toEqual([])
    })
  })

  test('the build output mirrors the plugin under plugin/', async () => {
    const built = await adapter.build(ctx())
    expect(built.filter(f => f.path.startsWith('plugin/')).map(f => f.path.slice('plugin/'.length)).sort()).toEqual(agyPluginFiles(canonical, packageVersion(REPO)).map(f => f.path).sort())
  })
})

describe('what the host cannot do', () => {
  test('AGY: custom commands are skills, so the always-on rules name the CLI twins of the utility commands', () => {
    expect(get('rules/AGENTS.md')).toContain('AGY has no custom command that runs without a model turn')
  })

  test('AGY: H19 is an unsupported cell, because PostToolUse carries no subagent result', () => {
    const h19 = canonical.hooks.hooks.find(h => h.id === 'H19')
    expect(h19?.bindings.agy).toMatchObject({ unsupported: expect.stringContaining('result') })
  })
})

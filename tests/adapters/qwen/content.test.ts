import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { qwenAgentFiles, qwenAgentTools, qwenCommandFiles, qwenContentFiles, qwenMemoryBlock, qwenPathRuleFiles, QWEN_COMMANDS } from '../../../src/adapters/qwen/content'
import { handleQwenHook } from '../../../src/adapters/qwen/hook'
import { adapter } from '../../../src/adapters/qwen/index'
import { harnessProfile } from '../../../src/core/harness/index'
import { defaultConfig } from '../../../src/core/config'
import { applyPlans } from '../../../src/engine/txn'
import { qwenArgv } from '../../../src/workflow/companion-hosts'
import { withSandbox } from '../../helpers/sandbox'
import { canonical, ctx, json, payload } from './helpers'

const install = async () => applyPlans([await adapter.installPlan(ctx(defaultConfig()))])
const uninstall = async () => applyPlans([await (adapter.uninstallPlan as NonNullable<typeof adapter.uninstallPlan>)(ctx())])
const qwenDir = (home: string) => join(home, '.qwen')
const readIn = (home: string, rel: string) => readFileSync(join(qwenDir(home), rel), 'utf8')

describe('the files the Qwen install adds (rules, path rules, agents, commands)', () => {
  test('the QWEN.md block holds the always-loaded rules and the commands, not the path rules', () => {
    const block = qwenMemoryBlock(canonical)
    for (const r of canonical.rules.filter(r => r.scope === 'always')) expect(block).toContain(r.body.trim().split('\n')[0] as string)
    expect(block).toContain('# Buracle commands in Qwen Code')
    for (const c of QWEN_COMMANDS) expect(block).toContain(`/${c.name}`)
    expect(block).toContain("Qwen Code's own `/btw`")
    expect(block).not.toContain('Path-scoped rules')
    expect(block.length).toBeLessThan(12_000)
  })

  test('a path rule file carries the `paths:` frontmatter Qwen Code scopes a rule by', () => {
    const files = qwenPathRuleFiles(canonical)
    expect(files.map(f => f.path)).toEqual(canonical.rules.filter(r => r.scope === 'paths').map(r => `rules/buracle/${r.id}.md`).sort())
    for (const f of files) expect(f.content).toMatch(/^---\npaths:\n {2}- "/)
  })

  test('the review agents become Qwen agents: name, description, a read-only tool allowlist with named MCP tools, the shared body resolved', () => {
    const files = qwenAgentFiles(canonical)
    expect(files.map(f => f.path)).toEqual(['changes-review', 'goal-build-review', 'plan-build-review'].map(id => `agents/${id}.md`))
    for (const f of files) {
      expect(f.content).toStartWith('---\nname: ')
      expect(f.content).not.toContain('{{include:')
      const head = f.content.split('---')[1] as string
      expect(head).toContain('  - read_file')
      expect(head).toContain('  - mcp__codegraph__codegraph_explore')
      expect(head).toContain('  - mcp__context7__resolve-library-id')
      for (const w of ['write_file', '  - edit', 'notebook_edit']) expect(head).not.toContain(w)
    }
    const agent = canonical.agents[0]
    if (agent === undefined) throw new Error('no agents')
    expect(qwenAgentTools({ ...agent, frontmatter: { ...agent.frontmatter, access: 'read-write', tools: ['read', 'write'] } })).toEqual(['read_file', 'write_file', 'edit', 'notebook_edit'])
  })

  test('the commands are Markdown files with a description and the arguments placeholder', () => {
    const files = qwenCommandFiles()
    expect(files.map(f => f.path)).toEqual(['commands/brain.md', 'commands/remember.md', 'commands/buracle-status.md'])
    for (const f of files) expect(f.content).toMatch(/^---\ndescription: ".+"\n---\n[\s\S]*\{\{args\}\}/)
  })

  test('install writes the block and the files; the build lists the same files', async () => {
    await withSandbox(async ({ home }) => {
      const r = await install()
      expect(r.conflicts).toEqual([])
      expect(readIn(home, 'QWEN.md')).toContain('<!-- buracle:buracle:start -->')
      for (const f of qwenContentFiles(canonical)) expect(readIn(home, f.path)).toBe(f.content)
      const built = await adapter.build(ctx())
      expect(built.map(f => f.path)).toEqual(expect.arrayContaining(['settings.fragment.json', 'QWEN.md', ...qwenContentFiles(canonical).map(f => f.path)]))
      expect((await install()).applied).toBe(0)
    })
  })

  test('a user\'s QWEN.md text stays around the block, and uninstall removes only Buracle\'s part', async () => {
    await withSandbox(async ({ home }) => {
      mkdirSync(qwenDir(home), { recursive: true })
      writeFileSync(join(qwenDir(home), 'QWEN.md'), '# My notes\n\nAlways answer briefly.\n')
      mkdirSync(join(qwenDir(home), 'agents'), { recursive: true })
      writeFileSync(join(qwenDir(home), 'agents', 'mine.md'), '---\nname: mine\ndescription: x\n---\nhi\n')
      expect((await install()).conflicts).toEqual([])
      const text = readIn(home, 'QWEN.md')
      expect(text).toContain('Always answer briefly.')
      expect(text).toContain('# Buracle commands in Qwen Code')
      await uninstall()
      expect(readIn(home, 'QWEN.md')).toBe('# My notes\n\nAlways answer briefly.\n')
      expect(readIn(home, 'agents/mine.md')).toContain('name: mine')
      for (const f of qwenContentFiles(canonical)) expect(existsSync(join(qwenDir(home), f.path))).toBe(false)
    })
  })

  test('a file of the user\'s with the name of a Buracle file is kept, not overwritten', async () => {
    await withSandbox(async ({ home }) => {
      mkdirSync(join(qwenDir(home), 'commands'), { recursive: true })
      writeFileSync(join(qwenDir(home), 'commands', 'brain.md'), 'my own brain command\n')
      const r = await install()
      expect(r.conflicts.some(c => (c.op as { path: string }).path.endsWith('commands/brain.md'))).toBe(true)
      expect(readIn(home, 'commands/brain.md')).toBe('my own brain command\n')
      expect(existsSync(join(qwenDir(home), 'commands', 'remember.md'))).toBe(true)
    })
  })
})

describe('SubagentStop: H19 judges the review agents', () => {
  const report = { verdict: 'pass', summary: 'docs/plans/p.md: all tasks done', findings: [{ severity: 'suggestion', category: 'maintainability', title: 't', evidence: 'e', suggested_fix: 'f' }], truths: [{ truth: 'export works', status: 'verified', evidence: 'bun test: 12 pass' }] }
  const stop = (extra: Record<string, unknown>) => handleQwenHook('SubagentStop', payload('SubagentStop', { agent_id: 'a1', ...extra }), ctx())

  test('an invalid report goes back to the reviewer once, then only warns the lead; a valid one and other agents pass quietly', async () => {
    await withSandbox(async () => {
      const bad = await stop({ agent_type: 'changes-review', stop_hook_active: false, last_assistant_message: 'Looks good to me!' })
      const out = json(bad.stdout)
      expect(out['decision']).toBe('block')
      expect(String(out['reason'])).toStartWith('Buracle H19: your final message is not a valid review report')
      const again = json((await stop({ agent_type: 'changes-review', stop_hook_active: true, last_assistant_message: 'still prose' })).stdout)
      expect(Object.keys(again)).toEqual(['systemMessage'])
      expect(String(again['systemMessage'])).toContain('changes-review returned an invalid review report again')
      expect((await stop({ agent_type: 'changes-review', last_assistant_message: JSON.stringify(report) })).stdout).toBe('')
      expect((await stop({ agent_type: 'worker', last_assistant_message: 'x' })).stdout).toBe('')
      expect((await stop({ last_assistant_message: 'x' })).stdout).toBe('')
    })
  })
})

describe('the second opinion host', () => {
  test('Qwen Code is a companion target, started on stdin with the read tools and the three MCP servers only', () => {
    expect(harnessProfile('qwen').companionPending).toBeUndefined()
    const stable = qwenArgv('0.27.4')
    expect(stable.slice(0, 5)).toEqual(['qwen', '--core-tools', 'read_file,grep_search,glob,list_directory', '--approval-mode', 'default'])
    const modern = qwenArgv('1.0.0-preview.1')
    expect(modern).toEqual(expect.arrayContaining(['--print', '--no-session-persistence', '--tools', 'read_file,grep_search,glob,list_directory', '--permission-mode', 'dont_ask']))
    for (const argv of [stable, modern]) {
      expect(argv[argv.indexOf('--allowed-mcp-server-names') + 1]).toBe('codegraph,semble,context7')
      expect(argv[argv.indexOf('--allowed-tools') + 1]).toContain('mcp__codegraph__codegraph_explore')
      expect(argv.join(' ')).not.toMatch(/run_shell_command|write_file|edit/)
    }
    expect(qwenArgv(undefined)).toContain('--core-tools')
  })
})

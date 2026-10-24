import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { defaultConfig } from '../../../src/core/config'
import type { Harness } from '../../../src/core/events'
import * as paths from '../../../src/engine/paths'
import { mdBlockGet } from '../../../src/engine/merge'
import { adapter } from '../../../src/adapters/codex/index'
import { codexBuildFiles } from '../../../src/adapters/codex/generate'
import { CODEX_HOOK_EVENTS, HOOK_COMMAND_PREFIX, POST_ANSWER_MATCHER, POST_CAPTURE_MATCHER, POST_MASK_HANDLER, POST_MASK_MATCHER, PRE_TOOL_MATCHER } from '../../../src/adapters/codex/hooks-config'
import { approvalPolicyProblem, BYPASS_APPROVAL_POLICY, CODEX_ENUMS, codexMcpTables, CRITICAL_OMIT_TOOLS_FROM, renderTomlTables, STATUS_LINE_ITEMS, TERMINAL_TITLE_ITEMS } from '../../../src/adapters/codex/config'
import type { AdapterContext } from '../../../src/adapters/registry'

const REPO = join(import.meta.dir, '..', '..', '..')
const canonical: CanonicalBundle = loadCanonicalSync(join(REPO, 'canonical'))
const ctx: AdapterContext = { repoRoot: REPO, config: defaultConfig(), canonical, paths, buracleBin: '/nonexistent/.buracle/bin/buracle' }

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p).split(sep).join('/'))
    }
  }
  walk(dir)
  return out
}

const built = await adapter.build(ctx)
const file = (p: string) => (built.find(f => f.path === p) as { content: string }).content

describe('codex build (harness/codex)', () => {
  test('matches the committed tree byte for byte (no missing or stale files)', () => {
    const root = join(REPO, 'harness', 'codex')
    expect(listFiles(root)).toEqual(built.map(f => f.path).sort())
    for (const f of built) expect({ path: f.path, content: readFileSync(join(root, f.path), 'utf8') }).toEqual({ path: f.path, content: f.content })
  })

  test('is deterministic and independent of the user config', async () => {
    const again = await adapter.build({ ...ctx, config: { ...defaultConfig(), context: { warnPct: 50, criticalPct: 60 } } })
    expect(again).toEqual(built)
    expect(codexBuildFiles(canonical).warnings).toEqual([])
  })

  test('contains no absolute user paths', () => {
    for (const f of built) {
      expect({ path: f.path, home: f.content.includes(homedir()) }).toEqual({ path: f.path, home: false })
      expect({ path: f.path, users: /\/Users\/[A-Za-z]/.test(f.content) }).toEqual({ path: f.path, users: false })
    }
  })

  test('hooks.json: every Codex event, the constant command, timeouts within Codex limits', () => {
    const hooks = JSON.parse(file('hooks.json'))
    expect(Object.keys(hooks).sort()).toEqual(['description', 'hooks'])
    expect(Object.keys(hooks.hooks)).toEqual([...CODEX_HOOK_EVENTS])
    for (const [event, groups] of Object.entries(hooks.hooks) as Array<[string, Array<{ matcher?: string, hooks: Array<Record<string, unknown>> }>]>) {
      for (const g of groups) {
        const handler = event === 'PostToolUse' && g.matcher === POST_MASK_MATCHER ? POST_MASK_HANDLER : event
        for (const h of g.hooks) {
          expect(h['type']).toBe('command')
          expect(h['command']).toBe(`${HOOK_COMMAND_PREFIX}${handler}`)
          expect(h['command']).toBe(`"\${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" hook codex ${handler}`)
          expect(Number.isInteger(h['timeout'])).toBe(true)
          if (event === 'SessionEnd') expect(h['timeout'] as number).toBeLessThanOrEqual(3)
          else expect(h['timeout'] as number).toBeLessThanOrEqual(60)
          expect(Object.keys(h).every(k => ['type', 'command', 'timeout', 'async', 'statusMessage'].includes(k))).toBe(true)
        }
      }
    }
    expect(hooks.hooks.PreToolUse[0].matcher).toBe('^(Bash|apply_patch|request_user_input|request_user_input_async|mcp__.+)$')
    expect(hooks.hooks.PreToolUse[0].matcher).toBe(PRE_TOOL_MATCHER)
    expect(hooks.hooks.PostToolUse.map((g: { matcher: string }) => g.matcher)).toEqual(['apply_patch', POST_CAPTURE_MATCHER, POST_MASK_MATCHER, POST_ANSWER_MATCHER])
    const pre = new RegExp(PRE_TOOL_MATCHER)
    for (const name of ['Bash', 'apply_patch', 'request_user_input', 'request_user_input_async', 'mcp__buracle_memory__memory_search', 'mcp__context7__query_docs']) expect({ name, matched: pre.test(name) }).toEqual({ name, matched: true })
    for (const name of ['webrun', 'mcp__', 'xmcp__a__b', 'Bash2', 'spawn_agent', 'update_plan']) expect({ name, matched: pre.test(name) }).toEqual({ name, matched: false })
    const capture = new RegExp(POST_CAPTURE_MATCHER)
    for (const name of ['Bash', 'webrun', 'mcp__web_search__search']) expect({ name, matched: capture.test(name) }).toEqual({ name, matched: true })
    expect(capture.test('apply_patch')).toBe(false)
    expect(hooks.hooks.PostToolUse[0].hooks[0].async).toBeUndefined()
    expect(hooks.hooks.PostToolUse[1].hooks[0].async).toBe(true)
    expect(hooks.hooks.PostToolUse[2].hooks[0].async).toBeUndefined()
    for (const e of ['UserPromptSubmit', 'Stop']) expect(hooks.hooks[e][0].matcher).toBeUndefined()
    expect(hooks.hooks.SubagentStart).toEqual([{ hooks: [{ type: 'command', command: `${HOOK_COMMAND_PREFIX}SubagentStart`, timeout: 10 }] }])
  })

  test('config.fragment.toml parses and holds only Buracle-managed tables and root keys (canonical defaults)', () => {
    const toml = Bun.TOML.parse(file('config.fragment.toml')) as Record<string, any>
    expect(Object.keys(toml).sort()).toEqual(['agents', 'approval_policy', 'compact_prompt', 'features', 'mcp_optional_startup_grace_ms', 'mcp_servers', 'model_reasoning_effort', 'plan_mode_reasoning_effort', 'sandbox_mode', 'tools', 'tui', 'web_search'])
    expect(toml['features']).toEqual({ memories: false })
    expect(Object.keys(toml['mcp_servers']).sort()).toEqual(Object.keys(canonical.mcp.servers).filter(id => canonical.mcp.servers[id]?.harnesses.includes('codex')).sort())
    const top = { omit_tools_from: [...CRITICAL_OMIT_TOOLS_FROM], default_tools_approval_mode: 'approve' }
    expect(toml['mcp_servers']['context7']).toEqual({ command: '{buracle}', args: ['mcp', 'run', 'context7'], startup_timeout_sec: 30, ...top })
    expect(toml['mcp_servers']['codegraph']['env']).toEqual({ CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_MCP_TOOLS: 'explore,search,node,callers,callees,impact,status,files' })
    expect(toml['mcp_servers']['grep']).toEqual({ url: 'https://mcp.grep.app', default_tools_approval_mode: 'approve' })
    expect(toml['mcp_servers']['buracle-memory']).toEqual({ command: '{buracle}', args: ['mcp', 'memory'], ...top })
    expect(toml['mcp_servers']['web-fetch']['tool_timeout_sec']).toBe(180)
    for (const [id, spec] of Object.entries(canonical.mcp.servers)) {
      if (!spec.harnesses.includes('codex')) continue
      expect({ id, omit: toml['mcp_servers'][id]['omit_tools_from'] }).toEqual({ id, omit: spec.critical ? [...CRITICAL_OMIT_TOOLS_FROM] : undefined })
    }
    expect(toml['tools']).toEqual({ update_plan: { enabled: true } })
    for (const id of toml['tui']['status_line']) expect(STATUS_LINE_ITEMS).toContain(id)
    for (const id of toml['tui']['terminal_title']) expect(TERMINAL_TITLE_ITEMS).toContain(id)
    expect(toml['tui']['status_line']).toContain('task-progress')
    expect(toml['mcp_optional_startup_grace_ms']).toBe(0)
    expect(toml['web_search']).toBe('disabled')
    expect([toml['model_reasoning_effort'], toml['plan_mode_reasoning_effort'], toml['agents']]).toEqual(['xhigh', 'xhigh', { default_subagent_reasoning_effort: 'xhigh', enabled: true }])
    expect([toml['approval_policy'], toml['sandbox_mode']]).toEqual([BYPASS_APPROVAL_POLICY, 'danger-full-access'])
    expect(CODEX_ENUMS.web_search).toContain(toml['web_search'])
    expect(approvalPolicyProblem(toml['approval_policy'])).toBeUndefined()
    expect(approvalPolicyProblem('nevr')).toContain('is not one of')
    expect(approvalPolicyProblem({ granular: { rules: 'yes' } })).toContain('approval_policy.granular.rules')
    expect(approvalPolicyProblem({ granular: { rules: true }, extra: 1 })).toContain('is neither one of')
    expect(CODEX_ENUMS.sandbox_mode).toContain(toml['sandbox_mode'])
    expect(file('config.fragment.toml')).not.toMatch(/^(?:model|model_context_window)\s*=|^\[features\]/m)
    const text = file('config.fragment.toml')
    expect(text.search(/^web_search = /m)).toBeGreaterThan(0)
    expect(text.search(/^web_search = /m)).toBeLessThan(text.search(/^\[/m))
  })

  test('agents/<id>.toml: name, description, read-only sandbox, developer_instructions = body', () => {
    for (const a of canonical.agents) {
      const t = Bun.TOML.parse(file(`agents/${a.id}.toml`)) as Record<string, unknown>
      expect(t['name']).toBe(a.id)
      expect(t['description']).toBe((a.frontmatter['description'] as string).replace(/\s+/g, ' ').trim())
      expect(t['sandbox_mode']).toBe(a.frontmatter['access'] === 'read-only' ? 'read-only' : undefined)
      expect(t['developer_instructions']).toBe(a.body.trim() + '\n')
      expect(t['model']).toBeUndefined()
      expect(Object.keys(t).every(k => ['name', 'description', 'sandbox_mode', 'developer_instructions', 'model'].includes(k))).toBe(true)
    }
  })

  test('AGENTS.md block: every always-rule in full, a short memory pointer, a path-rule index, no duplicate routing table', () => {
    const text = file('AGENTS.md')
    const block = mdBlockGet(text, 'buracle') as string
    expect(block).toBeString()
    for (const r of canonical.rules.filter(r => r.scope === 'always')) expect(block).toContain(r.body.trim())
    const memory = block.slice(block.indexOf('# Memory index'), block.indexOf('# Buracle commands in Codex')).trim().split('\n')
    expect(memory.length).toBeLessThanOrEqual(10)
    const commands = block.slice(block.indexOf('# Buracle commands in Codex'), block.indexOf('# Path-scoped rules'))
    for (const s of ['`$plan-build`', '`$bugfix`', '`buracle mem remember -- "<text>"`', '`$memory`', '`buracle mem ui --open`', '`buracle flow status`', '`/side`']) expect(commands).toContain(s)
    expect(commands).not.toContain('`$memory`,')
    for (const r of canonical.rules.filter(r => r.scope === 'paths')) expect(block).toContain(`\`~/.buracle/rules/paths/${r.id}.md\``)
    expect(block.split('| Need | Use first | Fallback |').length).toBe(2)
  })

  test('rules/paths/<id>.md keep their globs; rules/buracle.rules forbids catastrophic commands', () => {
    for (const r of canonical.rules.filter(r => r.scope === 'paths')) {
      const t = file(`rules/paths/${r.id}.md`)
      expect(t.startsWith('---\npaths:\n')).toBe(true)
      expect(t).toContain(r.body.trim())
    }
    const rules = file('rules/buracle.rules')
    expect(rules).toContain('prefix_rule(')
    expect(rules).toContain('decision = "forbidden"')
    expect(rules).not.toContain('decision = "allow"')
  })
})

describe('codex MCP tables from the mcp.yaml fields', () => {
  test('env plus harness_env.codex (a forwarded variable as env_vars) and tool_timeout_sec; nothing of another harness', () => {
    const base = { description: 'd', harnesses: ['claude', 'codex'] as Harness[], pin: 'latest' as const, critical: false, routing: [] }
    const warnings: string[] = []
    const tables = codexMcpTables({
      servers: {
        sandbox: {
          ...base, transport: 'stdio', package: { registry: 'npm', name: 'sandbox-mcp', version: 'latest' },
          env: { SHARED: '1' }, harness_env: { codex: { WHO: 'codex', SANDBOX_TOKEN: '${ENV:SANDBOX_TOKEN}', OTHER: '${ENV:RENAMED}' }, claude: { WHO: 'claude' } },
          tool_timeout_sec: 90,
        },
        remote: { ...base, transport: 'http', url: 'https://mcp.example.com', tool_timeout_sec: 5 },
        plain: { ...base, transport: 'stdio', package: { registry: 'npm', name: 'plain-mcp', version: 'latest' } },
      },
    }, '/b/buracle', warnings)
    expect(tables['mcp_servers.sandbox']).toEqual({
      command: '/b/buracle', args: ['mcp', 'run', 'sandbox'], env: { SHARED: '1', WHO: 'codex' }, env_vars: ['SANDBOX_TOKEN'], startup_timeout_sec: 30, tool_timeout_sec: 90,
    })
    expect(tables['mcp_servers.remote']).toEqual({ url: 'https://mcp.example.com', tool_timeout_sec: 5 })
    expect(tables['mcp_servers.plain']).toEqual({ command: '/b/buracle', args: ['mcp', 'run', 'plain'], startup_timeout_sec: 30 })
    expect(warnings).toEqual(['mcp.yaml: sandbox: env OTHER forwards ${ENV:RENAMED}; Codex can only forward a variable under its own name, so it is not passed'])
    const toml = Bun.TOML.parse(renderTomlTables(Object.entries(tables))) as Record<string, any>
    expect(toml['mcp_servers']['sandbox']['tool_timeout_sec']).toBe(90)
    expect(toml['mcp_servers']['sandbox']['env_vars']).toEqual(['SANDBOX_TOKEN'])
  })
})

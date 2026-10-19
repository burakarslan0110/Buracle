import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { buildFiles, commandNames, type BuiltFile } from '../../../src/adapters/opencode/build'
import { CLI_SCHEMA_URL, CONFIG_SCHEMA_URL, GLOBAL_PERMISSIONS } from '../../../src/adapters/opencode/constants'
import { diffTree } from '../../../src/adapters/opencode/dev-build'
import { configPermissions, configSet, mcpDenyRules, mcpServerEntry } from '../../../src/adapters/opencode/render'
import { catalogSkills, type McpServerSpec } from '../../../src/core/catalog'
import { CM_HIDDEN_TOOLS } from '../../../src/core/context-mode'
import type { Harness } from '../../../src/core/events'
import { jsoncParse } from '../../../src/engine/merge'
import { parseFrontmatter } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { flowPath } from '../../../src/workflow/flow'
import { withSandbox } from '../../helpers/sandbox'
import { firstLineDiff } from '../../helpers/text-diff'
import { adapterContext, canonical, fakeMemory, fakeServerContext, REPO } from './helpers'

function userInvocable(): string[] {
  return catalogSkills(canonical().skills).filter(s => s.userInvocable).map(s => s.id).sort()
}

let first: BuiltFile[] | undefined
async function built(): Promise<BuiltFile[]> {
  first ??= await buildFiles(adapterContext())
  return first
}

function file(files: BuiltFile[], p: string): string {
  const f = files.find(x => x.path === p)
  if (f === undefined) throw new Error(`missing ${p}`)
  return f.content
}

describe('opencode build', () => {
  test('is deterministic: two builds are byte-identical', async () => {
    const a = await built()
    const b = await buildFiles(adapterContext())
    expect(b.map(f => f.path)).toEqual(a.map(f => f.path))
    for (let i = 0; i < a.length; i++) expect(b[i]?.content === a[i]?.content).toBe(true)
  }, 60_000)

  test('does not depend on the process cwd (built from outside the checkout, e.g. `buracle doctor` in a project)', async () => {
    const a = await built()
    const saved = process.cwd()
    let b: BuiltFile[]
    try {
      process.chdir(os.tmpdir())
      b = await buildFiles(adapterContext())
    } finally {
      process.chdir(saved)
    }
    expect(b.map(f => f.path)).toEqual(a.map(f => f.path))
    for (let i = 0; i < a.length; i++) expect({ file: a[i]?.path, diff: firstLineDiff(a[i]?.content ?? '', b[i]?.content ?? '') }).toEqual({ file: a[i]?.path, diff: undefined })
  }, 60_000)

  test('matches the committed harness/opencode tree (regenerate with `bun src/adapters/opencode/dev-build.ts`)', async () => {
    const d = diffTree(await built(), paths.harnessDir('opencode'))
    expect({ changed: d.changed, extra: d.extra }).toEqual({ changed: [], extra: [] })
  }, 60_000)

  test('produces the expected files and no absolute user or repository paths', async () => {
    const files = await built()
    const names = files.map(f => f.path)
    expect(names).toContain('plugins/buracle/index.js')
    expect(names).toContain('plugins/buracle/tui.js')
    expect(names).toContain('AGENTS.block.md')
    expect(names).toContain('config/opencode.fragment.jsonc')
    expect(names).toContain('config/cli.fragment.jsonc')
    expect(names).toContain('manifest.json')
    for (const a of canonical().agents) expect(names).toContain(`agents/${a.id}.md`)
    expect(names.filter(n => n.startsWith('commands/'))).toEqual([])
    const leaks = [REPO, os.userInfo().homedir, process.env['HOME'] ?? REPO].filter(x => x.length > 1)
    for (const f of files) for (const l of leaks) expect(f.content.includes(l)).toBe(false)
  }, 60_000)

  test('manifest.json lists the entry points: a workflow command for every user-invocable skill, and the utility commands', async () => {
    const manifest = JSON.parse(file(await built(), 'manifest.json')) as { commands: { workflow: string[], utility: string[] } }
    expect(manifest.commands.workflow).toEqual(userInvocable())
    expect(manifest.commands.workflow).not.toContain('memory')
    expect(manifest.commands.workflow).not.toContain('buracle')
    for (const id of ['plan-build', 'goal-build', 'bugfix', 'requirements', 'research', 'inspect', 'dead-code', 'project-rules', 'new-skill', 'ab-test']) expect(manifest.commands.workflow).toContain(id)
    expect(manifest.commands.utility).toEqual(['aside', 'brain', 'buracle', 'buracle-ping', 'buracle-status', 'remember'])
    expect(commandNames(canonical())).toEqual(manifest.commands)
  }, 60_000)

  test('agents are v2-native read-only subagents', async () => {
    const files = await built()
    for (const a of canonical().agents) {
      const doc = parseFrontmatter(file(files, `agents/${a.id}.md`))
      expect(Object.keys(doc.frontmatter).every(k => ['description', 'mode', 'model', 'permissions', 'hidden', 'color', 'steps', 'disabled', 'request', 'variant'].includes(k))).toBe(true)
      expect(doc.frontmatter['mode']).toBe('subagent')
      const perms = doc.frontmatter['permissions'] as Array<{ action: string, resource: string, effect: string }>
      expect(perms[0]).toEqual({ action: '*', resource: '*', effect: 'deny' })
      expect(perms.at(-1)).toEqual({ action: 'edit', resource: '*', effect: 'deny' })
      expect(perms.some(p => p.action === 'codegraph_*' && p.effect === 'allow')).toBe(true)
      expect(doc.body.trim().length).toBeGreaterThan(100)
    }
  }, 60_000)

  test('config fragments and the AGENTS.md block carry the Buracle keys', async () => {
    const files = await built()
    const cfg = jsoncParse(file(files, 'config/opencode.fragment.jsonc'))
    expect(cfg.ok).toBe(true)
    const v = (cfg.ok ? cfg.value : {}) as Record<string, any>
    expect(v['$schema']).toBe(CONFIG_SCHEMA_URL)
    expect(v['share']).toBe('disabled')
    expect(v['permissions']).toEqual([...GLOBAL_PERMISSIONS, ...CM_HIDDEN_TOOLS.map(t => ({ action: `context-mode_${t}`, resource: '*', effect: 'deny' }))])
    const servers = v['mcp']['servers'] as Record<string, Record<string, unknown>>
    expect(servers['context-mode']).toEqual({
      type: 'local',
      command: ['{env:HOME}/.buracle/bin/buracle', 'mcp', 'run', 'context-mode'],
      environment: { CONTEXT_MODE_PLATFORM: 'opencode' },
      codemode: false,
      timeout: { startup: 60_000 },
    })
    const expectIds = Object.entries(canonical().mcp.servers).filter(([, s]) => s.harnesses.includes('opencode')).map(([id]) => id).sort()
    expect(Object.keys(servers).sort()).toEqual(expectIds)
    for (const [id, s] of Object.entries(canonical().mcp.servers)) {
      if (!s.harnesses.includes('opencode')) continue
      expect(servers[id]?.['codemode'] === false).toBe(s.critical)
    }
    expect(servers['buracle-memory']?.['command']).toEqual(['{env:HOME}/.buracle/bin/buracle', 'mcp', 'memory'])
    const cli = jsoncParse(file(files, 'config/cli.fragment.jsonc'))
    expect(cli.ok ? cli.value : undefined).toEqual({ $schema: CLI_SCHEMA_URL })
    const block = file(files, 'AGENTS.block.md')
    for (const r of canonical().rules.filter(x => x.scope === 'always')) {
      const heading = /^#\s+.+$/m.exec(r.body)?.[0]
      if (heading !== undefined) expect(block).toContain(heading)
    }
    for (const r of canonical().rules.filter(x => x.scope === 'paths')) {
      expect(block).toContain(`~/.buracle/rules/paths/${r.id}.md`)
      const line = block.split('\n').find(l => l.includes(`/rules/paths/${r.id}.md`)) ?? ''
      for (const g of r.frontmatter['paths'] as string[]) expect({ rule: r.id, g, listed: line.includes(`\`${g}\``) }).toEqual({ rule: r.id, g, listed: true })
    }
    expect(block).not.toMatch(/\(\+\d+ more\)/)
  }, 60_000)

  test('the server bundle loads as a v2 plugin module and registers its hooks', async () => {
    const files = await built()
    await withSandbox(async ({ root }) => {
      const entry = join(root, 'index.js')
      writeFileSync(entry, file(files, 'plugins/buracle/index.js'))
      const mod = await import(entry) as { default: { id: string, setup: (ctx: unknown) => Promise<unknown> } }
      expect(mod.default.id).toBe('buracle')
      expect(typeof mod.default.setup).toBe('function')
      const f = fakeServerContext(root)
      const cleanup = await mod.default.setup(f.ctx)
      expect(f.hooks.size).toBe(9)
      expect([...f.commands.keys()].sort()).toEqual(userInvocable())
      expect(f.modelTransforms.length).toBe(1)
      const ev = await f.trigger('permission.evaluate', { sessionID: 'ses_bundle1', action: 'shell', resources: ['rm -rf /'], effect: 'allow' })
      expect((ev as { effect: string }).effect).toBe('deny')
      if (typeof cleanup === 'function') await (cleanup as () => Promise<void>)()
      void fakeMemory
    })
  }, 60_000)

  test('the server bundle guards context-mode\'s tools and carries none of its SQLite modules (only the child client)', async () => {
    const server = file(await built(), 'plugins/buracle/index.js')
    for (const m of ['session', 'library', 'bridge']) expect(server).not.toContain(`// src/adapters/shared/context-mode/${m}.ts`)
    expect(server).toContain('// src/adapters/shared/context-mode/client.ts')
    await withSandbox(async ({ root }) => {
      const entry = join(root, 'index.js')
      writeFileSync(entry, server)
      const mod = await import(entry) as { default: { setup: (ctx: unknown) => Promise<unknown> } }
      const f = fakeServerContext(root)
      const cleanup = await mod.default.setup(f.ctx)
      await f.trigger('tool.execute.before', { tool: 'context-mode_ctx_execute', sessionID: 'ses_bundle2', agent: 'build', messageID: 'msg_1', id: 'call_b1', input: { language: 'shell', code: 'rm -rf ~' } })
      const ev = await f.trigger('permission.evaluate', { sessionID: 'ses_bundle2', action: 'context-mode_ctx_execute', resources: ['*'], effect: 'allow', source: { type: 'tool', messageID: 'msg_1', id: 'call_b1' } })
      expect((ev as { effect: string, message?: string }).message).toStartWith('[Buracle H01 guard.bash] ')
      if (typeof cleanup === 'function') await (cleanup as () => Promise<void>)()
    })
  }, 60_000)

  test('the TUI bundle loads against host-provided UI modules: status line, workflow band above the prompt, utility commands', async () => {
    const files = await built()
    await withSandbox(async ({ root }) => {
      const entry = join(root, 'tui.js')
      writeFileSync(entry, file(files, 'plugins/buracle/tui.js'))
      const sid = 'ses_band1'
      mkdirSync(join(flowPath('opencode', sid), '..'), { recursive: true })
      writeFileSync(flowPath('opencode', sid), JSON.stringify({ v: 1, stack: [{ workflow: 'plan-build', title: 'Rate limit the API', source: 'command', startedAt: Date.now() - 120_000, phase: { id: 'implement', since: Date.now() - 60_000 } }], updatedAt: Date.now() }))
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'tui-host.ts'), entry, sid], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      expect(err).toBe('')
      expect(code).toBe(0)
      const r = JSON.parse(out) as { id: string, slots: string[], root: string, line: string, band: string[], commands: Array<{ id: string, slash: { name: string, aliases?: string[], arguments?: boolean } }> }
      expect(r.id).toBe('buracle')
      expect(r.slots).toEqual(['prompt.footer.status', 'session.composer.top'])
      expect(r.root).toBe('box')
      expect(r.line).toContain('big')
      expect(r.line).toContain('30%')
      expect(r.band.length).toBeGreaterThanOrEqual(2)
      expect(r.band[0]).toContain('plan-build')
      expect(r.band[0]).toContain('Rate limit the API')
      expect(r.band.join('\n')).toContain('Implement')
      for (const row of r.band) expect(row.length).toBeLessThanOrEqual(154)
      expect(r.commands).toEqual([
        { id: 'buracle.remember', slash: { name: 'remember', arguments: true } },
        { id: 'buracle.brain', slash: { name: 'buracle-brain', arguments: true } },
        { id: 'buracle.aside', slash: { name: 'aside', arguments: true } },
        { id: 'buracle.status', slash: { name: 'buracle-status', aliases: ['buracle'], arguments: true } },
        { id: 'buracle.ping', slash: { name: 'buracle-ping', arguments: true } },
      ])
    })
  }, 60_000)

  test('the TUI bundle\'s /aside runs the host\'s /btw with the question; /buracle-ping answers pong; /buracle is the status dialog', async () => {
    const files = await built()
    await withSandbox(async ({ root }) => {
      const entry = join(root, 'tui.js')
      writeFileSync(entry, file(files, 'plugins/buracle/tui.js'))
      const runIn = async (command: string, input: string) => {
        const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'tui-host.ts'), entry, 'ses_cmd1', command, input], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        expect({ err, code }).toEqual({ err: '', code: 0 })
        return JSON.parse(out) as { toasts: Array<{ message: string, variant?: string }>, alerts: Array<{ title: string }>, btw: string[] }
      }
      const a = await runIn('aside', '  what does this branch change?  ')
      expect({ btw: a.btw, toasts: a.toasts, alerts: a.alerts }).toEqual({ btw: ['what does this branch change?'], toasts: [], alerts: [] })
      const p = await runIn('buracle-ping', '')
      expect({ btw: p.btw, toasts: p.toasts.map(t => [t.message, t.variant]) }).toEqual({ btw: [], toasts: [['pong', 'success']] })
      const s = await runIn('buracle', '')
      expect(s.alerts.map(x => x.title)).toEqual(['Buracle status'])
    })
  }, 60_000)
})

describe('opencode MCP entries from the mcp.yaml fields', () => {
  const base = { description: 'd', harnesses: ['opencode', 'codex'] as Harness[], pin: 'latest' as const, critical: false, routing: [] }
  const sandbox: McpServerSpec = {
    ...base, transport: 'stdio', package: { registry: 'npm', name: 'sandbox-mcp', version: 'latest', runtime: 'bun', scripts: false },
    env: { SHARED: '1' }, harness_env: { opencode: { WHO: 'opencode', TOKEN: '${ENV:SANDBOX_TOKEN}' }, codex: { WHO: 'codex' } },
    tool_timeout_sec: 90, enabled_tools: ['run'], disabled_tools: ['upgrade', 'insight'],
  }

  test('environment: env plus harness_env.opencode ({env:NAME} forwarding); tool_timeout_sec as timeout.execution in ms only above OpenCode\'s own 12 h or with tool_timeout_hard', () => {
    expect(mcpServerEntry(sandbox, '/b/buracle', 'sandbox')).toEqual({
      type: 'local', command: ['/b/buracle', 'mcp', 'run', 'sandbox'],
      environment: { SHARED: '1', TOKEN: '{env:SANDBOX_TOKEN}', WHO: 'opencode' },
      timeout: { startup: 60_000 },
    })
    const remote = { ...base, transport: 'http' as const, url: 'https://mcp.example.com' }
    expect(mcpServerEntry({ ...remote, tool_timeout_sec: 5 }, '/b/buracle', 'remote')).toEqual({ type: 'remote', url: 'https://mcp.example.com', oauth: false })
    expect(mcpServerEntry({ ...remote, tool_timeout_sec: 43_200 }, '/b/buracle', 'remote')).toEqual({ type: 'remote', url: 'https://mcp.example.com', oauth: false })
    expect(mcpServerEntry({ ...remote, tool_timeout_sec: 43_201 }, '/b/buracle', 'remote')).toEqual({ type: 'remote', url: 'https://mcp.example.com', oauth: false, timeout: { execution: 43_201_000 } })
    expect(mcpServerEntry({ ...sandbox, tool_timeout_sec: 43_201 }, '/b/buracle', 'sandbox')['timeout']).toEqual({ startup: 60_000, execution: 43_201_000 })
    expect(mcpServerEntry({ ...base, transport: 'stdio', command: 'long-mcp', tool_timeout_sec: 43_201 }, '/b/buracle', 'long')).toEqual({ type: 'local', command: ['long-mcp'], timeout: { execution: 43_201_000 } })
    expect(mcpServerEntry({ ...sandbox, tool_timeout_sec: 180, tool_timeout_hard: true }, '/b/buracle', 'sandbox')['timeout']).toEqual({ startup: 60_000, execution: 180_000 })
    expect(mcpServerEntry({ ...remote, tool_timeout_sec: 180, tool_timeout_hard: true }, '/b/buracle', 'remote')).toEqual({ type: 'remote', url: 'https://mcp.example.com', oauth: false, timeout: { execution: 180_000 } })
    expect(mcpServerEntry({ ...remote, tool_timeout_sec: 180, tool_timeout_hard: false }, '/b/buracle', 'remote')).toEqual({ type: 'remote', url: 'https://mcp.example.com', oauth: false })
    expect(mcpServerEntry({ ...sandbox, tool_timeout_sec: undefined, harness_env: undefined, env: undefined }, '/b/buracle', 'sandbox')).toEqual({ type: 'local', command: ['/b/buracle', 'mcp', 'run', 'sandbox'], timeout: { startup: 60_000 } })
  })

  test('disabled_tools become deny rules on <server>_<tool> after the static rules, for OpenCode servers only', () => {
    const c = { ...canonical(), mcp: { servers: { sandbox, codexOnly: { ...sandbox, harnesses: ['codex'] as Harness[], disabled_tools: ['gone'] } } } }
    expect(mcpDenyRules(c)).toEqual([
      { action: 'sandbox_upgrade', resource: '*', effect: 'deny' },
      { action: 'sandbox_insight', resource: '*', effect: 'deny' },
    ])
    expect(configPermissions(c)).toEqual([...GLOBAL_PERMISSIONS, ...mcpDenyRules(c)])
    expect(configSet(c, '/b/buracle')['permissions']).toEqual(configPermissions(c))
  })
})

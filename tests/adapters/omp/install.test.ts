import { describe, expect, test } from 'bun:test'
import { defaultConfig } from '../../../src/core/config'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { AdapterContext } from '../../../src/adapters/registry'
import { adapter, uninstallPlan } from '../../../src/adapters/omp/index'
import { linkStatus } from '../../../src/adapters/omp/check-link'
import { compareVersions, configFindings, effortFindings, mcpCommandFindings, permissionFinding, sharedAgentsFinding, userEffortFinding } from '../../../src/adapters/omp/doctor'
import { agentsPointer, AGENTS_BLOCK_ID, linkCheckArgv, ompConfigKeys, ompConfigKeysFor, ompConfigPath, ompLspLayout, SHARED_AGENTS_IMPORT, userPlanAutosave, userStatusPreset, windowsMcpOp } from '../../../src/adapters/omp/install'
import { DEFAULT_BAND_LAYOUT, DEFAULT_OMP_SEGMENTS, ompStatusData, ompStatusLine } from '../../../src/adapters/omp/statusline'
import { OMP_TESTED_WITH, ompCommandSkills, ompMcpServerIds } from '../../../src/adapters/omp/generated'
import { devContext } from '../../../src/adapters/omp/dev-build'
import { loadConfigSync } from '../../../src/engine/config'
import { mdBlockGet } from '../../../src/engine/merge'
import * as paths from '../../../src/engine/paths'
import { applyPlans, rollbackTxn, type Plan } from '../../../src/engine/txn'
import { exePath, fakeExe, IS_WINDOWS, narrowPath, pathOf } from '../../helpers/fake-exe'
import { withEnv, withSandbox, type Sandbox } from '../../helpers/sandbox'

const REPO = paths.repoRoot()
const HARNESS_BUILT = existsSync(join(REPO, 'harness', 'omp', 'package.json'))

// A fake omp in <root>/bin: it records its calls and its plugin link under $HOME. `configPath`
// replaces what `omp config path` prints (the agent dir: $PI_CODING_AGENT_DIR or ~/.omp/agent).
function installFakeOmp(sb: Sandbox, opts: { version?: string, usage?: string, configPath?: string } = {}): string {
  const bin = join(sb.root, 'bin')
  const usage = opts.usage ?? '{"generatedAt":1,"reports":[],"accountsWithoutUsage":[],"disabledCredentials":[],"capacity":{}}'
  fakeExe(join(bin, 'omp'), `import { join } from 'node:path'
const home = process.env.HOME ?? ''
const state = join(home, '.fake-omp-link')
append(join(home, '.fake-omp-calls'), argv.join(' '))
const two = argv.slice(0, 2).join(' ')
if (two === 'plugin link') { fs.writeFileSync(state, argv[2] ?? ''); console.log('linked'); process.exit(0) }
if (two === 'plugin list') {
  console.log(fs.existsSync(state) ? JSON.stringify({ npm: [{ name: 'buracle-omp', version: '0.1.0', path: fs.readFileSync(state, 'utf8'), enabled: true }], marketplace: [] }) : '{"npm":[],"marketplace":[]}')
  process.exit(0)
}
if (two === 'plugin uninstall') { fs.rmSync(state, { force: true }); console.log('removed'); process.exit(0) }
if (two === 'usage --json') { console.log(${JSON.stringify(usage)}); process.exit(0) }
if (two === 'config path') { console.log(${opts.configPath !== undefined ? JSON.stringify(opts.configPath) : "process.env.PI_CODING_AGENT_DIR || join(home, '.omp', 'agent')"}); process.exit(0) }
if (argv[0] === '--version') { console.log(${JSON.stringify(`omp/${opts.version ?? OMP_TESTED_WITH}`)}); process.exit(0) }
console.error('unexpected: ' + argv.join(' '))
process.exit(3)`)
  return bin
}

function ctxFor(over: Partial<AdapterContext> = {}): AdapterContext {
  return { ...devContext(REPO), ...over }
}

function calls(sb: Sandbox): string[] {
  try { return readFileSync(join(sb.home, '.fake-omp-calls'), 'utf8').trim().split('\n').filter(Boolean) } catch { return [] }
}

const USER_CONFIG = `# my omp settings
theme:
  dark: titanium # I like this one
statusLine:
  separator: pipe # keep pipes
tools:
  approval:
    bash: prompt
`

describe('omp installPlan', () => {
  test('plan shape: yaml-merge of the owned keys, AGENTS.md pointer block, the language servers omp lacks, idempotent plugin link', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      const plan = await adapter.installPlan(ctxFor())
      const agentDir = join(sb.home, '.omp', 'agent')
      expect(plan.id).toBe('omp')
      expect(plan.harness).toBe('omp')
      // On Windows omp gets the MCP servers in its own mcp.json too, just before the link.
      const windowsOps = IS_WINDOWS ? [windowsMcpOp(ctxFor(), agentDir)] : []
      expect(plan.ops.map(o => o.kind)).toEqual(['yaml-merge', 'md-block', 'json-merge', ...windowsOps.map(o => o.kind), 'exec'])
      expect(plan.ops.slice(3, -1)).toEqual(windowsOps)
      expect(plan.ops[0]).toEqual({ kind: 'yaml-merge', path: join(agentDir, 'config.yml'), owner: 'omp', set: {
        'statusLine.preset': 'custom', 'statusLine.leftSegments': ['model', 'path', 'git', 'pr', 'subagents'],
        'statusLine.rightSegments': ['usage', 'context_pct', 'cost', 'status'], 'statusLine.showHookStatus': false,
        'tools.approvalMode': 'yolo',
        'tools.xdev': false, defaultThinkingLevel: 'xhigh',
        'memory.backend': 'off', 'lsp.diagnosticsOnEdit': true, enabledProviders: [],
        'task.eager': 'preferred',
        'plan.autosave': true, 'plan.autosaveDir': paths.ompPlanStagingDir(),
      }, enforce: ['tools.approvalMode'], soft: ['defaultThinkingLevel', 'task.eager', 'plan.autosave', 'plan.autosaveDir', 'lsp.diagnosticsOnEdit'] })
      expect(plan.ops[1]).toMatchObject({ kind: 'md-block', path: join(agentDir, 'AGENTS.md'), id: AGENTS_BLOCK_ID, owner: 'omp' })
      expect(plan.ops[2]).toEqual({ kind: 'json-merge', path: join(sb.home, '.omp', 'agent', 'lsp.json'), owner: 'omp', set: {
        'servers.csharp-ls': { command: 'csharp-ls', args: [], fileTypes: ['.cs'], rootMarkers: ['*.sln', '*.slnx', '*.csproj', '.git'], languageId: 'csharp' },
      } })
      const exec = plan.ops.at(-1) as Extract<Plan['ops'][number], { kind: 'exec' }>
      const omp = exePath(join(bin, 'omp'))
      expect(exec.argv).toEqual([omp, 'plugin', 'link', join(REPO, 'harness', 'omp')])
      expect(exec.undo).toEqual([omp, 'plugin', 'uninstall', 'buracle-omp'])
      expect(exec.idempotentCheck).toEqual([Bun.which('bun') ?? process.execPath, join(REPO, 'src', 'adapters', 'omp', 'check-link.ts'), join(REPO, 'harness', 'omp'), '--omp', omp])
    })
  }))

  test('Windows: the agent dir\'s mcp.json gets the Buracle servers run by buracle.cmd (omp starts a .cmd through cmd.exe; it cannot start the plugin\'s /bin/sh entries)', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const shim = 'C:\\Users\\Ann Lee\\.buracle\\bin\\buracle.cmd'
    await withEnv({ BURACLE_PLATFORM: 'win32' }, async () => {
      const plan = await adapter.installPlan(ctxFor({ buracleBin: shim }))
      expect(plan.ops.map(o => o.kind)).toEqual(['yaml-merge', 'md-block', 'json-merge', 'json-merge', 'exec'])
      const mcp = plan.ops[3] as Extract<Plan['ops'][number], { kind: 'json-merge' }>
      expect(mcp.path).toBe(join(sb.home, '.omp', 'agent', 'mcp.json'))
      expect(mcp.set['mcpServers."buracle-memory"']).toEqual({ type: 'stdio', command: shim, args: ['mcp', 'memory'] })
      for (const entry of Object.values(mcp.set) as Array<{ type: string, command?: string }>) if (entry.type === 'stdio') expect(entry.command).not.toBe('/bin/sh')
    })
    await withEnv({ BURACLE_PLATFORM: 'darwin' }, async () => {
      const plan = await adapter.installPlan(ctxFor())
      expect(plan.ops.some(o => o.kind === 'json-merge' && o.path.endsWith('mcp.json'))).toBe(false)
    })
  }))

  test('honors PI_CODING_AGENT_DIR and an existing config.yaml', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const agentDir = join(sb.root, 'custom-agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'config.yaml'), 'theme:\n  dark: x\n')
    await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
      const plan = await adapter.installPlan(ctxFor())
      expect(plan.ops[0]).toMatchObject({ path: join(agentDir, 'config.yaml') })
      expect(plan.ops[1]).toMatchObject({ path: join(agentDir, 'AGENTS.md') })
    })
    expect(ompConfigPath(join(sb.root, 'nothing-here'))).toBe(join(sb.root, 'nothing-here', 'config.yml'))
  }))

  test('applies through the txn engine: comments and user keys survive, re-apply is a no-op, rollback restores and unlinks', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    const agentDir = join(sb.home, '.omp', 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'config.yml'), USER_CONFIG)
    writeFileSync(join(agentDir, 'AGENTS.md'), '# My global omp notes\n\nBe terse.\n')
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      const plan = await adapter.installPlan(ctxFor())
      const first = await applyPlans([plan])
      expect(first.conflicts).toEqual([])
      expect(first.applied).toBe(IS_WINDOWS ? 5 : 4) // Windows: also the MCP servers in the agent dir's mcp.json
      expect(JSON.parse(readFileSync(join(agentDir, 'lsp.json'), 'utf8'))).toEqual({ servers: { 'csharp-ls': { command: 'csharp-ls', args: [], fileTypes: ['.cs'], rootMarkers: ['*.sln', '*.slnx', '*.csproj', '.git'], languageId: 'csharp' } } })
      const text = readFileSync(join(agentDir, 'config.yml'), 'utf8')
      expect(text).toContain('# my omp settings')
      expect(text).toContain('dark: titanium # I like this one')
      expect(text).toContain('separator: pipe # keep pipes')
      const doc = parseYaml(text) as Record<string, any>
      expect(doc['theme']).toEqual({ dark: 'titanium' })
      expect(doc['tools']).toEqual({ approval: { bash: 'prompt' }, approvalMode: 'yolo', xdev: false })
      expect(doc['defaultThinkingLevel']).toBe('xhigh')
      expect(doc['statusLine']).toEqual({ separator: 'pipe', preset: 'custom', leftSegments: ['model', 'path', 'git', 'pr', 'subagents'], rightSegments: ['usage', 'context_pct', 'cost', 'status'], showHookStatus: false })
      expect(doc['memory']).toEqual({ backend: 'off' })
      expect(doc['enabledProviders']).toEqual([])
      const agents = readFileSync(join(agentDir, 'AGENTS.md'), 'utf8')
      expect(agents.startsWith('# My global omp notes\n\nBe terse.\n\n<!-- buracle:omp:start -->\n## Buracle\n')).toBe(true)
      expect(agents).toContain(SHARED_AGENTS_IMPORT)
      expect(readFileSync(join(sb.home, '.fake-omp-link'), 'utf8')).toBe(join(REPO, 'harness', 'omp'))

      const again = await applyPlans([await adapter.installPlan(ctxFor())])
      expect(again.applied).toBe(0)
      expect(again.conflicts).toEqual([])
      expect(again.skipped.map(s => s.reason)).toContain('already done (idempotent check passed)')
      expect(calls(sb).filter(c => c.startsWith('plugin link'))).toHaveLength(1)

      const report = await rollbackTxn(first.txn)
      expect(report.errors).toEqual([])
      expect(readFileSync(join(agentDir, 'config.yml'), 'utf8')).toBe(USER_CONFIG)
      expect(readFileSync(join(agentDir, 'AGENTS.md'), 'utf8')).toBe('# My global omp notes\n\nBe terse.\n')
      expect(existsSync(join(sb.home, '.fake-omp-link'))).toBe(false)
    })
  }))

  test('permissions.enforce writes the no-approval mode back over a user value (warning; uninstall restores it); a user effort level is kept', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    const agentDir = join(sb.home, '.omp', 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'config.yml'), 'tools:\n  approvalMode: always-ask\ndefaultThinkingLevel: low\n')
    mkdirSync(join(sb.home, '.agents'), { recursive: true })
    writeFileSync(join(sb.home, '.agents', 'AGENTS.md'), '# shared\n')
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      const r = await applyPlans([await adapter.installPlan(ctxFor())])
      expect(r.conflicts).toEqual([])
      expect(r.warnings).toEqual([expect.stringContaining('tools.approvalMode') as unknown as string])
      expect(r.skipped.map(s => s.reason)).toContain('kept user value (defaultThinkingLevel)')
      const doc = parseYaml(readFileSync(join(agentDir, 'config.yml'), 'utf8')) as Record<string, any>
      expect(doc['tools']).toEqual({ approvalMode: 'yolo', xdev: false })
      expect(doc['defaultThinkingLevel']).toBe('low')
      expect(doc['memory']).toEqual({ backend: 'off' })
      const block = mdBlockGet(readFileSync(join(agentDir, 'AGENTS.md'), 'utf8'), AGENTS_BLOCK_ID)
      expect(block).toContain('@~/.agents/AGENTS.md')
      await applyPlans([await adapter.uninstallPlan!(ctxFor())])
      const after = parseYaml(readFileSync(join(agentDir, 'config.yml'), 'utf8')) as Record<string, any>
      expect(after).toEqual({ tools: { approvalMode: 'always-ask' }, defaultThinkingLevel: 'low' })
    })
  }))

  test('without permissions.enforce a value the user set keeps winning (conflict); effort.omp keep writes no effort', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    const agentDir = join(sb.home, '.omp', 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'config.yml'), 'tools:\n  approvalMode: always-ask\n')
    const config = defaultConfig()
    config.permissions.enforce = false
    config.effort.omp = 'keep'
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      const plan = await adapter.installPlan(ctxFor({ config }))
      expect(plan.ops[0]).not.toHaveProperty('enforce')
      expect((plan.ops[0] as { soft?: string[] }).soft).toEqual(['task.eager', 'plan.autosave', 'plan.autosaveDir', 'lsp.diagnosticsOnEdit'])
      const r = await applyPlans([plan])
      expect(r.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('tools.approvalMode') as unknown as string])
      const doc = parseYaml(readFileSync(join(agentDir, 'config.yml'), 'utf8')) as Record<string, any>
      expect(doc['tools']).toEqual({ approvalMode: 'always-ask', xdev: false })
      expect(doc['defaultThinkingLevel']).toBeUndefined()
    })
  }))

  test('OMP-AGENTSMD-SHADOW: a ~/.agents/AGENTS.md created after the install is imported without a reinstall', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    const agentDir = join(sb.home, '.omp', 'agent')
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      await applyPlans([await adapter.installPlan(ctxFor())])
    })
    mkdirSync(join(sb.home, '.agents'), { recursive: true })
    writeFileSync(join(sb.home, '.agents', 'AGENTS.md'), 'SHARED-MARKER-XYZ: always answer in Turkish.\n')
    const block = mdBlockGet(readFileSync(join(agentDir, 'AGENTS.md'), 'utf8'), AGENTS_BLOCK_ID) as string
    expect(block).toContain('@~/.agents/AGENTS.md')
    expect(sharedAgentsFinding(block, true, '/a')).toBeUndefined()
    const old = '## Buracle\n\nBuracle is active.'
    expect(sharedAgentsFinding(old, false, '/a')).toBeUndefined()
    expect(sharedAgentsFinding(old, true, '/a')).toMatchObject({ level: 'warn', check: 'omp AGENTS.md' })
  }))

  test('F24: a user status line preset keeps the whole statusLine group the user\'s (one reported conflict, no injected keys)', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    const agentDir = join(sb.home, '.omp', 'agent')
    mkdirSync(agentDir, { recursive: true })
    const user = 'statusLine:\n  preset: minimal\n  separator: powerline\n'
    writeFileSync(join(agentDir, 'config.yml'), user)
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      const r = await applyPlans([await adapter.installPlan(ctxFor())])
      expect(r.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('statusLine.preset') as unknown as string])
      const doc = parseYaml(readFileSync(join(agentDir, 'config.yml'), 'utf8')) as Record<string, any>
      expect(doc['statusLine']).toEqual({ preset: 'minimal', separator: 'powerline' })
      expect(doc['tools']).toEqual({ approvalMode: 'yolo', xdev: false })
    })
    expect(userStatusPreset('base: &b\n  preset: compact\nstatusLine:\n  <<: *b\n')).toBe('compact')
    expect(userStatusPreset('statusLine:\n  preset: custom\n')).toBeUndefined()
    expect(userStatusPreset(undefined)).toBeUndefined()
    expect(Object.keys(ompConfigKeys(ctxFor(), { userPreset: 'minimal' })).filter(k => k.startsWith('statusLine.'))).toEqual(['statusLine.preset'])
    const off = defaultConfig()
    off.permissions.bypass = false
    expect(ompConfigKeys({ ...ctxFor(), config: off })['tools.approvalMode']).toBe('write')
  }))

  test('H12: plan.autosave points at the staging folder unless the user set up omp\'s own autosave', () => withSandbox(async sb => {
    const staging = paths.ompPlanStagingDir()
    expect(userPlanAutosave(undefined, staging)).toBe(false)
    expect(userPlanAutosave('theme:\n  dark: x\n', staging)).toBe(false)
    expect(userPlanAutosave(`plan:\n  autosave: true\n  autosaveDir: ${staging}\n`, staging)).toBe(false)
    expect(userPlanAutosave('plan:\n  autosave: true\n', staging)).toBe(true)
    expect(userPlanAutosave('plan:\n  autosave: false\n', staging)).toBe(true)
    expect(userPlanAutosave('plan:\n  autosaveDir: ~/plans\n', staging)).toBe(true)
    const file = join(sb.root, 'config.yml')
    writeFileSync(file, 'plan:\n  autosave: true\n')
    const mine = ompConfigKeysFor(ctxFor(), file)
    expect(['plan.autosave', 'plan.autosaveDir'].filter(k => k in mine)).toEqual([])
    writeFileSync(file, 'theme:\n  dark: x\n')
    expect(ompConfigKeysFor(ctxFor(), file)).toMatchObject({ 'plan.autosave': true, 'plan.autosaveDir': staging })
  }))

  test('adapter.uninstallPlan removes what install wrote (ledger-proven) and unlinks; a repeat is a no-op', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    const agentDir = join(sb.home, '.omp', 'agent')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'config.yml'), USER_CONFIG)
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      await applyPlans([await adapter.installPlan(ctxFor())])
      expect(typeof adapter.uninstallPlan).toBe('function')
      const plan = await adapter.uninstallPlan!(ctxFor())
      const config = join(agentDir, 'config.yml')
      expect(plan.ops.filter(o => o.kind === 'remove').map(o => o.path)).toEqual([
        ...Object.keys(ompConfigKeys(ctxFor(), { planStaging: paths.ompPlanStagingDir() })).map(k => `${config}#${k}`), `${join(agentDir, 'AGENTS.md')}#md:${AGENTS_BLOCK_ID}`, `${join(agentDir, 'lsp.json')}#servers.csharp-ls`,
        ...(IS_WINDOWS ? ompMcpServerIds(ctxFor().canonical).map(id => `${join(agentDir, 'mcp.json')}#mcpServers.${id}`) : []),
      ].sort())
      const unlink = plan.ops.at(-1) as Extract<Plan['ops'][number], { kind: 'exec' }>
      expect(unlink.argv).toEqual([exePath(join(bin, 'omp')), 'plugin', 'uninstall', 'buracle-omp'])
      expect(unlink.idempotentCheck?.at(-1)).toBe('--absent')
      const r = await applyPlans([plan])
      expect(r.conflicts).toEqual([])
      const after = readFileSync(config, 'utf8')
      expect(parseYaml(after)).toEqual(parseYaml(USER_CONFIG))
      expect(after).toContain('dark: titanium # I like this one')
      expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(false)
      expect(existsSync(join(agentDir, 'lsp.json'))).toBe(false)
      expect(existsSync(join(agentDir, 'mcp.json'))).toBe(false)
      expect(existsSync(join(sb.home, '.fake-omp-link'))).toBe(false)
      expect(calls(sb).filter(c => c === 'plugin uninstall buracle-omp')).toHaveLength(1)
      const again = await adapter.uninstallPlan!(ctxFor())
      expect(again.ops.map(o => o.kind)).toEqual(['exec'])
      const second = await applyPlans([again])
      expect(second.applied).toBe(0)
      expect(calls(sb).filter(c => c === 'plugin uninstall buracle-omp')).toHaveLength(1)
    })
  }))

  test('a flat lsp.json (servers without a "servers" wrapper) gets csharp-ls next to them, never a "servers" key that would hide them; uninstall restores it', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    const agentDir = join(sb.home, '.omp', 'agent')
    mkdirSync(agentDir, { recursive: true })
    const user = { gopls: { settings: { gopls: { staticcheck: true } } }, 'my-lsp': { command: 'my-lsp', fileTypes: ['.xyz'], rootMarkers: ['.git'] }, idleTimeoutMs: 60000 }
    writeFileSync(join(agentDir, 'lsp.json'), JSON.stringify(user, null, 2))
    expect([ompLspLayout(undefined), ompLspLayout(''), ompLspLayout('{ nope'), ompLspLayout('{"idleTimeoutMs":5}'), ompLspLayout('{"servers":{"a":{}},"b":{}}'), ompLspLayout(JSON.stringify(user))]).toEqual(['wrapped', 'wrapped', 'wrapped', 'wrapped', 'wrapped', 'flat'])
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      const plan = await adapter.installPlan(ctxFor())
      expect(Object.keys((plan.ops[2] as { set: Record<string, unknown> }).set)).toEqual(['csharp-ls'])
      expect((await applyPlans([plan])).conflicts).toEqual([])
      const after = JSON.parse(readFileSync(join(agentDir, 'lsp.json'), 'utf8')) as Record<string, unknown>
      expect(Object.keys(after).sort()).toEqual(['csharp-ls', 'gopls', 'idleTimeoutMs', 'my-lsp'])
      expect(after).toMatchObject({ ...user, 'csharp-ls': { command: 'csharp-ls', fileTypes: ['.cs'] } })
      expect((await applyPlans([await adapter.installPlan(ctxFor())])).applied).toBe(0)
      const removed = (await adapter.uninstallPlan!(ctxFor())).ops.filter(o => o.kind === 'remove').map(o => o.path)
      expect(removed).toContain(`${join(agentDir, 'lsp.json')}#csharp-ls`)
      expect((await applyPlans([await adapter.uninstallPlan!(ctxFor())])).conflicts).toEqual([])
      expect(JSON.parse(readFileSync(join(agentDir, 'lsp.json'), 'utf8'))).toEqual(user)
    })
  }))

  test('uninstallPlan follows the ledger: keys a newer build no longer writes go too; an unreadable ledger falls back to the plan keys', () => withSandbox(async () => {
    const ctx = ctxFor()
    const agentDir = paths.ompAgentDir()
    const ledger = {
      [`${join(agentDir, 'config.yml')}#statusLine.oldKey`]: { owner: 'omp', sha256: 'x', path: join(agentDir, 'config.yml'), pointer: 'statusLine.oldKey', writtenAt: 't', kind: 'yaml' as const },
      [`${join(agentDir, 'AGENTS.md')}#md:omp`]: { owner: 'omp', sha256: 'x', path: join(agentDir, 'AGENTS.md'), pointer: 'md:omp', writtenAt: 't', kind: 'md-block' as const },
      '/elsewhere/file': { owner: 'codex', sha256: 'x', path: '/elsewhere/file', writtenAt: 't', kind: 'file' as const },
    }
    const plan = await uninstallPlan(ctx, { ledger })
    expect(plan.ops.filter(o => o.kind === 'remove').map(o => o.path)).toEqual([`${join(agentDir, 'AGENTS.md')}#md:omp`, `${join(agentDir, 'config.yml')}#statusLine.oldKey`])
    expect(plan.ops.every(o => o.owner === 'omp')).toBe(true)
    expect(plan).toMatchObject({ id: 'omp-uninstall', harness: 'omp' })
    mkdirSync(paths.stateDir(), { recursive: true })
    writeFileSync(paths.ownedLedgerFile(), '{ not json')
    const config = join(agentDir, 'config.yml')
    const removed = async () => (await uninstallPlan(ctx)).ops.filter(o => o.kind === 'remove').map(o => o.path)
    expect(await removed()).toEqual(expect.arrayContaining([`${config}#plan.autosave`, `${config}#plan.autosaveDir`, `${join(agentDir, 'AGENTS.md')}#md:omp`]))
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(config, 'plan:\n  autosave: true\n')
    expect((await removed()).filter(k => k.includes('#plan.'))).toEqual([])
  }))

  test('refuses to plan when harness/omp has not been built', async () => {
    await expect(adapter.installPlan(ctxFor({ repoRoot: '/nonexistent/buracle' }))).rejects.toThrow(/not built/)
  })
})

describe('omp status line and AGENTS.md pointer', () => {
  const layout = (native?: Record<string, unknown>) => ({ rows: [['month', 'mem']], thresholds: { ctxWarn: 75, ctxCrit: 90 }, emoji: false, ...(native ? { native } : {}) })

  test('segment lists come from statusline.yaml omp.native (validated omp ids), else the design default', () => {
    expect(ompStatusLine(undefined)).toEqual({ left: [...DEFAULT_OMP_SEGMENTS.left], right: [...DEFAULT_OMP_SEGMENTS.right], showHookStatus: false })
    expect(ompStatusLine(layout({ leftSegments: ['model', 'bogus', 'git', 'model'], rightSegments: ['usage', 'status', 'git'] })))
      .toEqual({ left: ['model', 'git'], right: ['usage', 'status'], showHookStatus: false })
    expect(ompStatusLine(layout({ leftSegments: ['nope'] }))).toEqual({ left: [...DEFAULT_OMP_SEGMENTS.left], right: [...DEFAULT_OMP_SEGMENTS.right], showHookStatus: false })
    expect(ompStatusLine(layout({ leftSegments: ['model'], rightSegments: ['status'], showHookStatus: true })).showHookStatus).toBe(true)
  })

  test('the live canonical layout drives the installed keys', () => {
    const native = devContext(REPO).canonical.statusline.omp?.native
    const keys = ompConfigKeys(devContext(REPO))
    if (native?.leftSegments !== undefined) expect(keys['statusLine.leftSegments']).toEqual(native.leftSegments)
    if (native?.rightSegments !== undefined) expect(keys['statusLine.rightSegments']).toEqual(native.rightSegments)
  })

  test('showHookStatus is only managed when the status segment is placed or set explicitly', () => {
    const base = devContext(REPO)
    const withoutStatus = ompConfigKeys({ canonical: { ...base.canonical, statusline: { omp: layout({ leftSegments: ['model'], rightSegments: ['usage'] }) } } })
    expect(Object.keys(withoutStatus)).toEqual(['statusLine.preset', 'statusLine.leftSegments', 'statusLine.rightSegments', 'tools.approvalMode', 'tools.xdev', 'defaultThinkingLevel', 'memory.backend', 'lsp.diagnosticsOnEdit', 'enabledProviders', 'task.eager'])
  })

  test('status texts and band layout are embedded from the canonical layout', () => {
    expect(ompStatusData(undefined)).toEqual({ layout: DEFAULT_BAND_LAYOUT, setStatus: { 'buracle.budget': ['month'], 'buracle.hooks': ['hooks'], 'buracle.mem': ['mem'] } })
    expect(ompStatusData(layout({ setStatus: { 'buracle.mem': ['mem'], 'bad key!': ['x'], 'buracle.budget': ['month', 'cost'] } })))
      .toEqual({ layout: { rows: [['month', 'mem']], thresholds: { ctxWarn: 75, ctxCrit: 90 }, emoji: false }, setStatus: { 'buracle.budget': ['month', 'cost'], 'buracle.mem': ['mem'] } })
    expect(ompStatusData(layout({ setStatus: { 'buracle.ay': ['month'], 'buracle.mem': ['mem'] } })).setStatus).toEqual({ 'buracle.budget': ['month'], 'buracle.mem': ['mem'] })
    expect(['buracle.mem', 'buracle.budget'].sort()).toEqual(['buracle.budget', 'buracle.mem'])
  })

  test('the pointer is short and names the plugin, the workflows and the utility commands', () => {
    const p = agentsPointer({ commands: ['plan-build', 'goal-build'] })
    expect(p.split('\n').length).toBeLessThanOrEqual(5)
    expect(p).toContain('`buracle-omp` plugin')
    expect(p).toContain('`/plan-build`, `/goal-build`')
    for (const c of ['`/buracle-status`', '`/buracle`', '`/remember <text>`', '`/brain`']) expect(p).toContain(c)
  })
})

describe('omp link check and doctor', () => {
  test('linkStatus interprets omp plugin list --json', () => withSandbox(async sb => {
    const dir = join(sb.root, 'pkg')
    mkdirSync(dir)
    const list = (entries: unknown[]) => JSON.stringify({ npm: entries, marketplace: [] })
    expect(linkStatus(list([]), dir).state).toBe('absent')
    expect(linkStatus(list([{ name: 'buracle-omp', path: dir, enabled: true }]), dir).state).toBe('linked')
    expect(linkStatus(list([{ name: 'buracle-omp', path: dir, enabled: false }]), dir).state).toBe('disabled')
    expect(linkStatus(list([{ name: 'buracle-omp', path: sb.home, enabled: true }]), dir).state).toBe('elsewhere')
    expect(linkStatus('not json', dir).state).toBe('unknown')
    expect(linkStatus('{"npm":{}}', dir).state).toBe('unknown')
  }))

  test('I8: plugin .mcp.json commands must resolve; a custom BURACLE_HOME is followed through the sh -c wrapper', () => withSandbox(async ({ root, home }) => {
    const custom = join(root, 'custom')
    mkdirSync(join(custom, 'bin'), { recursive: true })
    writeFileSync(join(custom, 'bin', 'buracle'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(custom, 'bin', 'buracle'), 0o755)
    const mcp = (memory: Record<string, unknown>) => JSON.stringify({ mcpServers: { 'buracle-memory': memory, ctx: { type: 'stdio', command: 'no-such-runner-q' }, grep: { type: 'http', url: 'https://x' } } })
    const shell = { type: 'stdio', command: '/bin/sh', args: ['-c', 'exec "${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" "$@"', 'buracle', 'mcp', 'memory'] }
    const env = { HOME: home, BURACLE_HOME: custom, PATH: narrowPath() }
    expect(mcpCommandFindings(mcp(shell), env, '/p/.mcp.json').map(f => f.level)).toEqual(['warn'])
    const legacy = mcpCommandFindings(mcp({ type: 'stdio', command: '${HOME}/.buracle/bin/buracle', args: ['mcp', 'memory'] }), env, '/p/.mcp.json')
    expect(legacy.map(f => f.level)).toEqual(['error', 'warn'])
    expect(legacy[0]?.detail).toContain(`${home}/.buracle/bin/buracle`) // the text of ${HOME}/.buracle/bin/buracle, expanded as omp expands it
    expect(mcpCommandFindings(undefined, env, '/p/.mcp.json')[0]?.level).toBe('error')
  }))

  test('I8 on Windows: the entries of the agent dir\'s mcp.json win over the plugin\'s /bin/sh ones; a server still on /bin/sh is an error', () => withSandbox(async ({ root, home }) => {
    const cmd = join(root, 'bin', 'buracle.cmd')
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(cmd, '@echo off\r\n')
    const shell = { type: 'stdio', command: '/bin/sh', args: ['-c', 'exec "${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" "$@"', 'buracle', 'mcp', 'memory'] }
    const plugin = JSON.stringify({ mcpServers: { 'buracle-memory': shell, codegraph: { ...shell, args: [...shell.args.slice(0, 3), 'mcp', 'run', 'codegraph'] }, grep: { type: 'http', url: 'https://x' } } })
    const env = { HOME: home, PATH: '' }
    const file = join(home, '.omp', 'agent', 'mcp.json')
    const none = mcpCommandFindings(plugin, env, '/p/.mcp.json', { text: undefined, file })
    expect(none.map(f => f.level)).toEqual(['error'])
    expect(none[0]?.detail).toContain(`buracle-memory: /bin/sh does not exist on Windows; \`buracle install omp\` writes this server into ${file}`)
    const user = (command: string) => JSON.stringify({ mcpServers: { 'buracle-memory': { type: 'stdio', command, args: ['mcp', 'memory'] }, codegraph: { type: 'stdio', command, args: ['mcp', 'run', 'codegraph'] } } })
    expect(mcpCommandFindings(plugin, env, '/p/.mcp.json', { text: user(cmd), file })).toEqual([{ level: 'ok', check: 'omp mcp', detail: '3 plugin MCP server commands resolve' }])
    const gone = mcpCommandFindings(plugin, env, '/p/.mcp.json', { text: user(join(root, 'gone', 'buracle.cmd')), file })
    expect(gone[0]?.detail).toContain(`buracle-memory: ${join(root, 'gone', 'buracle.cmd')} does not exist`)
  }))

  test('permission mode (PLAN §2.7): yolo under permissions.bypass; a changed value is explained with what writes it back', () => {
    const cfg = (bypass: boolean, enforce: boolean) => ({ permissions: { bypass, enforce } })
    expect(permissionFinding({ tools: { approvalMode: 'yolo' } }, cfg(true, true), '/f')).toMatchObject({ level: 'ok', check: 'omp permission mode' })
    const changed = permissionFinding({ tools: { approvalMode: 'always-ask' } }, cfg(true, true), '/f')
    expect(changed).toMatchObject({ level: 'warn' })
    expect(changed.detail).toContain('tools.approvalMode is "always-ask", not yolo')
    expect(changed.detail).toContain('run `buracle install` to write it back (permissions.enforce)')
    expect(permissionFinding({ tools: { approvalMode: 'always-ask' } }, cfg(true, false), '/f').detail).toContain('permissions.enforce is off, so Buracle keeps that value')
    expect(permissionFinding({}, cfg(true, true), '/f').detail).toContain('is not set in /f')
    expect(permissionFinding({ tools: { approvalMode: 'write' } }, cfg(false, true), '/f')).toMatchObject({ level: 'ok', detail: 'tools.approvalMode write (permissions.bypass is off)' })
  })

  test('effort (PLAN §2.7): defaultThinkingLevel against effort.omp; a user level is theirs; a :level role suffix overrides it', () => {
    const effort = (omp: string) => ({ effort: { claude: 'auto', codex: 'auto', opencode: 'auto', omp } })
    expect(effortFindings({ defaultThinkingLevel: 'xhigh' }, effort('auto'), '/f')).toEqual([{ level: 'ok', check: 'omp effort', detail: 'defaultThinkingLevel xhigh (effort.omp)' }])
    expect(effortFindings({ defaultThinkingLevel: 'low' }, effort('auto'), '/f')).toEqual([{ level: 'ok', check: 'omp effort', detail: 'defaultThinkingLevel "low" is your own value and stays (effort.omp would write xhigh)' }])
    expect(effortFindings({}, effort('auto'), '/f')[0]).toMatchObject({ level: 'warn' })
    expect(effortFindings({}, effort('keep'), '/f')[0]).toMatchObject({ level: 'ok', detail: "effort.omp is keep: omp's own defaultThinkingLevel stays (not set (omp's default is high))" })
    expect(effortFindings({ defaultThinkingLevel: 'auto' }, effort('classifier'), '/f')[0]?.detail).toBe('defaultThinkingLevel auto (effort.omp)')
    expect(effortFindings({}, effort('off'), '/f')[0]).toMatchObject({ level: 'warn' })
    expect(effortFindings({}, effort('bogus'), '/f')[0]?.detail).toContain('effort.omp:')
    const role = effortFindings({ defaultThinkingLevel: 'xhigh', modelRoles: { default: 'anthropic/claude-opus-5-5:high' } }, effort('auto'), '/f')
    expect(role.map(f => f.level)).toEqual(['ok', 'warn'])
    expect(role[1]?.detail).toContain('modelRoles.default ends in :high')
  })

  test('effort: `off` is never a level omp keeps; in the user config or in omp\'s own settings it is a clear warning', () => {
    const effort = (omp: string) => ({ effort: { claude: 'auto', codex: 'auto', opencode: 'auto', omp } })
    const fromUser = userEffortFinding('off', effort('auto'), '/u/config.yaml')
    expect(fromUser).toMatchObject({ level: 'warn', check: 'omp effort' })
    expect(fromUser?.detail).toContain('effort.omp "off" in /u/config.yaml is not used')
    expect(fromUser?.detail).toContain("Oh My Pi's settings cannot hold 'off' (it ignores it and runs at high); minimal is the least thinking it saves")
    expect(fromUser?.detail).toContain('Buracle uses effort.omp auto instead (defaultThinkingLevel xhigh)')
    expect(fromUser?.detail).toContain('buracle config set effort.omp')
    expect(userEffortFinding('bogus', effort('auto'), '/u')?.detail).toContain("'bogus' is not an effort value for Oh My Pi")
    expect(userEffortFinding(3, effort('auto'), '/u')?.level).toBe('warn')
    for (const ok of ['auto', 'keep', 'minimal', 'max', 'classifier']) expect(userEffortFinding(ok, effort(ok), '/u')).toBeUndefined()
    expect(userEffortFinding(undefined, effort('auto'), '/u')).toBeUndefined()
    const live = effortFindings({ defaultThinkingLevel: 'off' }, effort('auto'), '/f')
    expect(live).toEqual([{ level: 'warn', check: 'omp effort', detail: 'defaultThinkingLevel "off" in /f is not a level omp accepts (minimal, low, medium, high, xhigh, max, auto): omp ignores it and runs at high. Set one with `omp config set defaultThinkingLevel <level>` (effort.omp would write xhigh)' }])
    expect(effortFindings({ defaultThinkingLevel: 'off' }, effort('keep'), '/f')[0]).toMatchObject({ level: 'warn', detail: expect.stringContaining('omp ignores it and runs at high') })
  })

  test('effort.omp: off in the user config: install writes the default level, never off, and doctor explains it', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    mkdirSync(sb.buracleHome, { recursive: true })
    writeFileSync(paths.userConfigFile(), 'effort:\n  omp: off\n')
    const loaded = loadConfigSync({ repoRoot: REPO })
    expect(loaded.config.effort.omp).toBe('auto')
    expect(loaded.errors.join('\n')).toContain('effort.omp')
    const ctx = ctxFor({ config: loaded.config })
    expect('defaultThinkingLevel' in ompConfigKeys({ canonical: ctx.canonical, config: { ...loaded.config, effort: { ...loaded.config.effort, omp: 'off' } } })).toBe(false)
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? ''), CLAUDE_CONFIG_DIR: undefined }, async () => {
      const plan = await adapter.installPlan(ctx)
      expect((plan.ops[0] as { set: Record<string, unknown> }).set['defaultThinkingLevel']).toBe('xhigh')
      await applyPlans([plan])
      const text = readFileSync(join(sb.home, '.omp', 'agent', 'config.yml'), 'utf8')
      expect((parseYaml(text) as Record<string, unknown>)['defaultThinkingLevel']).toBe('xhigh')
      expect(text).not.toMatch(/defaultThinkingLevel:\s*off/)
      const effortRows = (await adapter.doctor(ctx)).filter(f => f.check === 'omp effort')
      expect(effortRows[0]).toMatchObject({ level: 'warn', detail: expect.stringContaining(`effort.omp "off" in ${paths.userConfigFile()} is not used`) })
      expect(effortRows[1]).toMatchObject({ level: 'ok', detail: 'defaultThinkingLevel xhigh (effort.omp)' })
    })
  }))

  test('compareVersions and configFindings', () => {
    expect(compareVersions('18.8.3', '18.8.0')).toBeGreaterThan(0)
    expect(compareVersions('18.7.9', '18.8.0')).toBeLessThan(0)
    expect(compareVersions('18.8.0', '18.8.0')).toBe(0)
    expect(configFindings(undefined, { a: 1 }, '/f')[0]?.level).toBe('warn')
    expect(configFindings('a: [', { a: 1 }, '/f')[0]?.level).toBe('error')
    expect(configFindings('a:\n  b: 1\n', { 'a.b': 1 }, '/f')).toEqual([{ level: 'ok', check: 'omp config', detail: '1 Buracle keys set in /f' }])
    expect(configFindings('a:\n  b: 2\n', { 'a.b': 1, c: [] }, '/f')).toEqual([{ level: 'warn', check: 'omp config', detail: '/f: a.b = 2 (Buracle: 1); c missing' }])
  })

  test('doctor: healthy after install (usage without accounts is only a warning)', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? ''), CLAUDE_CONFIG_DIR: undefined }, async () => {
      await applyPlans([await adapter.installPlan(ctxFor())])
      expect((await adapter.doctor(ctxFor())).find(f => f.check === 'omp mcp')?.level).toBe('error')
      mkdirSync(join(sb.buracleHome, 'bin'), { recursive: true })
      writeFileSync(join(sb.buracleHome, 'bin', 'buracle'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(sb.buracleHome, 'bin', 'buracle'), 0o755)
      if (IS_WINDOWS) writeFileSync(paths.shimPath(), '@echo off\r\n') // omp runs the agent dir's mcp.json there, which names buracle.cmd
      const findings = await adapter.doctor(ctxFor())
      const by = Object.fromEntries(findings.map(f => [f.check, f]))
      expect(by['omp version']).toMatchObject({ level: 'ok', detail: `omp ${OMP_TESTED_WITH} (tested ${OMP_TESTED_WITH})` })
      expect(by['omp plugin']).toMatchObject({ level: 'ok' })
      expect(by['omp config']).toMatchObject({ level: 'ok' })
      expect(by['omp permission mode']).toMatchObject({ level: 'ok' })
      expect(by['omp effort']).toMatchObject({ level: 'ok', detail: 'defaultThinkingLevel xhigh (effort.omp)' })
      expect(by['omp AGENTS.md']).toMatchObject({ level: 'ok' })
      expect(by['omp usage']).toMatchObject({ level: 'warn' })
      expect(by['omp agent dir']).toMatchObject({ level: 'ok', detail: join(sb.home, '.omp', 'agent') })
      expect(by['shared skills']).toMatchObject({ level: 'warn' })
      expect(findings.filter(f => f.level === 'error')).toEqual([])
    })
    for (const id of ompCommandSkills(ctxFor().canonical)) {
      mkdirSync(join(sb.home, '.agents', 'skills', id), { recursive: true })
      writeFileSync(join(sb.home, '.agents', 'skills', id, 'SKILL.md'), '---\nname: x\n---\n')
    }
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      expect((await adapter.doctor(ctxFor())).find(f => f.check === 'shared skills')?.level).toBe('ok')
    })
  }))

  test('doctor: an omp agent dir other than the installed one is reported', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb)
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      await applyPlans([await adapter.installPlan(ctxFor())])
    })
    installFakeOmp(sb, { configPath: join(sb.home, '.omp', 'profiles', 'work', 'agent') })
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      const f = (await adapter.doctor(ctxFor())).find(x => x.check === 'omp agent dir')
      expect(f?.level).toBe('warn')
      expect(f?.detail).toContain(join('profiles', 'work', 'agent'))
    })
  }))

  test('doctor: old omp is an error, a missing link is an error, missing omp only warns', () => withSandbox(async sb => {
    if (!HARNESS_BUILT) return
    const bin = installFakeOmp(sb, { version: '18.7.2', usage: '{"reports":[{"provider":"openai-codex"}]}' })
    await withEnv({ PATH: pathOf(bin, process.env['PATH'] ?? '') }, async () => {
      const findings = await adapter.doctor(ctxFor())
      const by = Object.fromEntries(findings.map(f => [f.check, f]))
      expect(by['omp version']?.level).toBe('error')
      expect(by['omp plugin']).toMatchObject({ level: 'error' })
      expect(by['omp usage']).toMatchObject({ level: 'ok', detail: '`omp usage --json` works (1 provider report)' })
      expect(by['omp config']?.level).toBe('warn')
    })
    await withEnv({ PATH: join(sb.root, 'empty') }, async () => {
      expect(await adapter.doctor(ctxFor())).toEqual([{ level: 'warn', check: 'omp', detail: 'omp is not on PATH; omp checks skipped' }])
    })
  }))
})

describe('link check argv', () => {
  test('runs on the PATH bun, which survives a Homebrew upgrade (the journal keeps the argv for undo)', () => {
    expect(linkCheckArgv('/r', '/p', '/x/omp')[0]).toBe(Bun.which('bun') ?? process.execPath)
  })
})

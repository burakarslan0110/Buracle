import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import { EFFORT_SCALES } from '../../../src/core/effort'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { mdBlockGet, valueHash } from '../../../src/engine/merge'
import * as paths from '../../../src/engine/paths'
import { applyPlans, listLedgerKey, readLedger, type Op } from '../../../src/engine/txn'
import { permissionCheck } from '../../../src/adapters/codex/doctor'
import type { AdapterContext } from '../../../src/adapters/registry'
import { adapter } from '../../../src/adapters/codex/index'
import { codexBuildFiles } from '../../../src/adapters/codex/generate'
import { codexProcessesUsing, HarnessBusyError, hookCommandPrefixFor, hooksJsonOps, installTestHooks, parseLsofFields, tildePath, tuiOps } from '../../../src/adapters/codex/install'
import { codexArtifacts } from '../../../src/adapters/codex/generate'
import { buracleHooksFile, CODEX_HOOK_EVENTS, findBuracleHandlers, HOOK_COMMAND_PREFIX, HOOK_GROUP_IDENTITY, hookCommand, hookTrustHash, hookTrustKey, LEGACY_HOOK_COMMAND_PREFIX, POST_MASK_HANDLER, POST_MASK_MATCHER, PRE_TOOL_MATCHER } from '../../../src/adapters/codex/hooks-config'
import { BYPASS_KEYS, bypassUnitBlocked, codexTrustPlan, trustTables } from '../../../src/adapters/codex/trust'
import { BYPASS_APPROVAL_POLICY } from '../../../src/adapters/codex/config'
import { CODEX_ENUMS, codexEnumProblem, codexValueProblems, SUBAGENT_EFFORTS, subagentEffort } from '../../../src/adapters/codex/config'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..', '..')
const canonical: CanonicalBundle = loadCanonicalSync(join(REPO, 'canonical'))

function context(over: Partial<AdapterContext> = {}): AdapterContext {
  return { repoRoot: REPO, config: defaultConfig(), canonical, paths, buracleBin: paths.shimPath(), ...over }
}

async function install(ctx = context()) {
  return applyPlans([await adapter.installPlan(ctx)])
}

const read = (p: string) => readFileSync(p, 'utf8')

beforeEach(() => { installTestHooks.codexPids = async () => [] })
afterEach(() => { delete installTestHooks.codexPids; delete installTestHooks.openFiles })

const USER_CONFIG = `# My Codex settings
model = "gpt-6.1-sol"   # keep this model
model_context_window = 400000
approval_policy = "on-request"

[features]
memories = false        # off on purpose

[projects."/Users/me/work/app"]
trust_level = "trusted"

# my own MCP server
[mcp_servers.my-tools]
command = "my-tools"
args = ["--stdio"]

[tui]
theme = "dracula"       # picked with /theme
notifications = true

[hooks.state."/Users/me/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:abc"
`

describe('codex installPlan', () => {
  test('fresh install writes every managed file; a second plan changes nothing', () => withSandbox(async ({ home }) => {
    const r = await install()
    expect(r.conflicts).toEqual([])
    const codex = join(home, '.codex')
    const build = codexBuildFiles(canonical).files
    const builtHooks = JSON.parse((build.find(f => f.path === 'hooks.json') as { content: string }).content)
    expect(JSON.parse(read(join(codex, 'hooks.json')))).toEqual({ hooks: builtHooks.hooks })
    const toml = Bun.TOML.parse(read(join(codex, 'config.toml'))) as Record<string, any>
    expect(toml['mcp_servers']['buracle-memory']).toEqual({ command: paths.shimPath(), args: ['mcp', 'memory'], omit_tools_from: ['deferred', 'code_mode'], default_tools_approval_mode: 'approve' })
    expect(toml['mcp_servers']['context7']).toMatchObject({ command: paths.shimPath(), args: ['mcp', 'run', 'context7'] })
    expect(toml['mcp_servers']['grep']).toEqual({ url: 'https://mcp.grep.app', default_tools_approval_mode: 'approve' })
    expect(toml['tui']['status_line']).toContain('context-used')
    expect(toml['tools']['update_plan']).toEqual({ enabled: true })
    expect(toml['approval_policy']).toEqual(BYPASS_APPROVAL_POLICY)
    expect(toml['sandbox_mode']).toBe('danger-full-access')
    expect(toml['mcp_optional_startup_grace_ms']).toBe(0)
    expect(toml['web_search']).toBe('disabled')
    expect([toml['model_reasoning_effort'], toml['plan_mode_reasoning_effort'], toml['agents']]).toEqual(['xhigh', 'xhigh', { default_subagent_reasoning_effort: 'xhigh', enabled: true }])
    expect(toml['features']).toEqual({ memories: false })
    expect(toml['compact_prompt']).toStartWith('Compact this conversation into a handoff summary')
    expect(toml['compact_prompt']).toContain('Keep the approaches that were tried and rejected')
    expect(Object.keys(toml).sort()).toEqual(['agents', 'approval_policy', 'compact_prompt', 'features', 'mcp_optional_startup_grace_ms', 'mcp_servers', 'model_reasoning_effort', 'plan_mode_reasoning_effort', 'sandbox_mode', 'tools', 'tui', 'web_search'])
    const block = mdBlockGet(read(join(codex, 'AGENTS.md')), 'buracle') as string
    expect(block).toContain('# Core working rules')
    expect(block).toContain('`~/.buracle/rules/paths/python.md`')
    for (const a of canonical.agents) expect(existsSync(join(codex, 'agents', `${a.id}.toml`))).toBe(true)
    expect(read(join(codex, 'rules', 'buracle.rules'))).toContain('prefix_rule(')
    expect(existsSync(join(home, '.buracle', 'rules', 'paths'))).toBe(false)
    const again = await install()
    expect(again).toMatchObject({ txn: '', applied: 0, conflicts: [] })
  }))

  test('merges into a realistic config.toml: comments, model, features, projects, hooks.state and user tables survive', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    mkdirSync(codex, { recursive: true })
    writeFileSync(join(codex, 'config.toml'), USER_CONFIG)
    const r = await install()
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([expect.stringContaining('approval_policy: already defined by the user (was "on-request"); wrote Buracle\'s value because the key is enforced')])
    const text = read(join(codex, 'config.toml'))
    for (const line of USER_CONFIG.split('\n').filter(l => l.trim() !== '' && !l.startsWith('approval_policy'))) expect(text).toContain(line)
    const toml = Bun.TOML.parse(text) as Record<string, any>
    expect(toml['model']).toBe('gpt-6.1-sol')
    expect(toml['model_context_window']).toBe(400000)
    expect(toml['features']).toEqual({ memories: false })
    expect(toml['mcp_servers']['my-tools']).toEqual({ command: 'my-tools', args: ['--stdio'] })
    expect(toml['tui']).toMatchObject({ theme: 'dracula', notifications: true })
    expect(toml['tui']['status_line']).toContain('five-hour-limit')
    expect(toml['tui']['terminal_title']).toContain('activity')
    expect(toml['hooks']['state']['/Users/me/.codex/hooks.json:stop:0:0']).toEqual({ trusted_hash: 'sha256:abc' })
    expect(toml['approval_policy']).toEqual(BYPASS_APPROVAL_POLICY)
    expect(toml['sandbox_mode']).toBe('danger-full-access')
    expect(text.indexOf('mcp_optional_startup_grace_ms = 0')).toBeLessThan(text.indexOf('[features]'))
    expect(text.indexOf('model_reasoning_effort = "xhigh"')).toBeLessThan(text.indexOf('[features]'))
    expect(text.match(/^\[tui\]$/gm)).toHaveLength(1)
    expect(await install()).toMatchObject({ txn: '' })
  }))

  test('a status line the user chose (e.g. with /statusline) is kept and reported, the rest still installs', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    mkdirSync(codex, { recursive: true })
    writeFileSync(join(codex, 'config.toml'), '[tui]\nstatus_line = ["model", "git-branch"]\n')
    const r = await install()
    expect(r.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('tui.status_line')])
    const toml = Bun.TOML.parse(read(join(codex, 'config.toml'))) as Record<string, any>
    expect(toml['tui']['status_line']).toEqual(['model', 'git-branch'])
    expect(toml['tui']['terminal_title']).toContain('project-name')
    expect(toml['mcp_servers']['context7']).toBeDefined()
  }))

  test('[tui] keys are owned one by one: later user or Codex keys never cause a conflict', () => withSandbox(async ({ home }) => {
    const path = join(home, '.codex', 'config.toml')
    await install()
    const text = read(path)
    expect(text).toMatch(/^tui\.terminal_title = /m)
    writeFileSync(path, text.replace(/^(tui\.terminal_title = .*\n)/m, '$1tui.theme = "nord"\ntui.model_availability_nux = { seen = true }\n'))
    const r = await install()
    expect(r.conflicts).toEqual([])
    const toml = Bun.TOML.parse(read(path)) as Record<string, any>
    expect(toml['tui']['theme']).toBe('nord')
    expect(toml['tui']['model_availability_nux']).toEqual({ seen: true })
    expect(toml['tui']['status_line']).toContain('context-used')
  }))

  test('hooks.json: one json-list-merge per event with the matcher+command identity; nothing else', () => {
    const a = codexArtifacts({ canonical, buracle: '/b', pathRulesDir: '~/r' })
    const ops = hooksJsonOps('/h/.codex/hooks.json', a)
    expect(ops.map(o => (o as { pointer: string }).pointer)).toEqual(CODEX_HOOK_EVENTS.map(e => `hooks.${e}`))
    for (const op of ops) {
      expect(op).toMatchObject({ kind: 'json-list-merge', path: '/h/.codex/hooks.json', identity: HOOK_GROUP_IDENTITY, owner: 'codex', format: 'json' })
      const event = (op as { pointer: string }).pointer.slice('hooks.'.length) as keyof ReturnType<typeof buracleHooksFile>['hooks']
      expect((op as { items: unknown[] }).items).toEqual(buracleHooksFile().hooks[event] ?? [])
    }
  })

  test('user hooks.json: user groups, events and keys stay; Buracle groups are appended after them', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    mkdirSync(codex, { recursive: true })
    const user = {
      description: 'my hooks',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/guard.py', timeout: 5 }] }],
        PermissionRequest: [{ hooks: [{ type: 'command', command: 'approve.sh' }] }],
      },
    }
    writeFileSync(join(codex, 'hooks.json'), JSON.stringify(user, null, 2) + '\n')
    const r = await install()
    expect(r.conflicts).toEqual([])
    const after = JSON.parse(read(join(codex, 'hooks.json')))
    expect(after.description).toBe('my hooks')
    expect(after.hooks.PermissionRequest).toEqual([...user.hooks.PermissionRequest, ...(buracleHooksFile().hooks.PermissionRequest ?? [])])
    expect(after.hooks.PreToolUse).toEqual([...user.hooks.PreToolUse, ...(buracleHooksFile().hooks.PreToolUse ?? [])])
    const ours = findBuracleHandlers(after, join(codex, 'hooks.json'))
    expect(new Set(ours.map(h => h.event))).toEqual(new Set(CODEX_HOOK_EVENTS))
    expect(ours.find(h => h.event === 'PreToolUse')?.key).toBe(`${join(codex, 'hooks.json')}:pre_tool_use:1:0`)
    expect(await install()).toMatchObject({ txn: '', applied: 0, conflicts: [] })
  }))

  test('a user group with Buracle\'s identity but other content is kept and reported, never duplicated', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    mkdirSync(codex, { recursive: true })
    const edited = { matcher: PRE_TOOL_MATCHER, hooks: [{ type: 'command', command: hookCommand('PreToolUse'), timeout: 99 }] }
    writeFileSync(join(codex, 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [edited] } }) + '\n')
    const r = await install()
    expect(r.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('hooks.PreToolUse')])
    const after = JSON.parse(read(join(codex, 'hooks.json')))
    expect(after.hooks.PreToolUse).toEqual([edited])
    expect(after.hooks.Stop).toEqual(buracleHooksFile().hooks.Stop)
  }))

  test('Buracle\'s trust keys stay stable across reinstalls and user additions', () => withSandbox(async ({ home }) => {
    const path = join(home, '.codex', 'hooks.json')
    await install()
    const keysOf = () => findBuracleHandlers(JSON.parse(read(path)), path).map(h => `${h.key} ${h.hash}`).sort()
    const before = keysOf()
    const file = JSON.parse(read(path))
    file.hooks.Stop.push({ hooks: [{ type: 'command', command: 'notify.sh' }] })
    file.hooks.Interrupt = [{ hooks: [{ type: 'command', command: 'bell.sh' }] }]
    writeFileSync(path, JSON.stringify(file, null, 2) + '\n')
    expect(await install()).toMatchObject({ txn: '', applied: 0, conflicts: [] })
    const after = JSON.parse(read(path))
    expect(after.hooks.Stop[1]).toEqual({ hooks: [{ type: 'command', command: 'notify.sh' }] })
    expect(after.hooks.Interrupt).toEqual(file.hooks.Interrupt)
    expect(keysOf()).toEqual(before)
  }))

  test('removing the list entries takes out only Buracle\'s groups; a file Buracle created goes when empty', () => withSandbox(async ({ home }) => {
    const path = join(home, '.codex', 'hooks.json')
    const removeAll = async () => applyPlans([{ id: 'u', harness: 'codex', ops: CODEX_HOOK_EVENTS.map((e): Op => ({ kind: 'remove', path: listLedgerKey(path, `hooks.${e}`), owner: 'codex' })) }])
    await install()
    const ledger = await readLedger()
    expect(CODEX_HOOK_EVENTS.every(e => ledger[listLedgerKey(path, `hooks.${e}`)]?.kind === 'json-list')).toBe(true)
    expect((await removeAll()).conflicts).toEqual([])
    expect(existsSync(path)).toBe(false)
    await install()
    const file = JSON.parse(read(path))
    file.hooks.Stop.push({ hooks: [{ type: 'command', command: 'notify.sh' }] })
    writeFileSync(path, JSON.stringify(file, null, 2) + '\n')
    expect((await removeAll()).conflicts).toEqual([])
    expect(JSON.parse(read(path))).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }] } })
  }))

  test('an identical group the user already had is adopted: it stays after removal', () => withSandbox(async ({ home }) => {
    const path = join(home, '.codex', 'hooks.json')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(path, JSON.stringify({ hooks: { Stop: buracleHooksFile().hooks.Stop } }, null, 2) + '\n')
    expect((await install()).conflicts).toEqual([])
    expect(JSON.parse(read(path)).hooks.Stop).toEqual(buracleHooksFile().hooks.Stop)
    await applyPlans([{ id: 'u', harness: 'codex', ops: CODEX_HOOK_EVENTS.map((e): Op => ({ kind: 'remove', path: listLedgerKey(path, `hooks.${e}`), owner: 'codex' })) }])
    expect(JSON.parse(read(path))).toEqual({ hooks: { Stop: buracleHooksFile().hooks.Stop } })
  }))

  test('an unparsable hooks.json is never overwritten', () => withSandbox(async ({ home }) => {
    const path = join(home, '.codex', 'hooks.json')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(path, '{ "hooks": { oops')
    const r = await install()
    expect(r.conflicts.length).toBe(CODEX_HOOK_EVENTS.length)
    expect(read(path)).toBe('{ "hooks": { oops')
  }))

  test('AGENTS.md: user text is kept and the block is appended once', () => withSandbox(async ({ home }) => {
    const path = join(home, '.codex', 'AGENTS.md')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(path, '# My global rules\n\n- Answer in Turkish.\n')
    await install()
    await install()
    const text = read(path)
    expect(text.startsWith('# My global rules\n\n- Answer in Turkish.\n')).toBe(true)
    expect(text.match(/<!-- buracle:buracle:start -->/g)).toHaveLength(1)
  }))

  test('the plan never removes anything itself (buracle install prunes stale items from its install record)', () => withSandbox(async () => {
    const plan = await adapter.installPlan(context())
    expect(plan.ops.filter(o => o.kind === 'remove')).toEqual([])
    expect(plan.ops.every(o => o.owner === 'codex')).toBe(true)
  }))

  test('the plan writes nothing outside CODEX_HOME (path rules are the core plan\'s)', () => withSandbox(async () => {
    const plan = await adapter.installPlan(context())
    const codexHome = paths.codexHome()
    expect(plan.ops.filter(o => o.kind !== 'exec' && !(o as { path: string }).path.startsWith(codexHome + '/'))).toEqual([])
    expect(plan.ops.some(o => o.kind === 'file' && o.path.endsWith('/hooks.json'))).toBe(false)
  }))

  test('CODEX_HOME is honoured', () => withSandbox(async ({ root }) => {
    const custom = join(root, 'custom-codex')
    mkdirSync(custom)
    await withEnv({ CODEX_HOME: custom }, async () => {
      await install()
      expect(existsSync(join(custom, 'hooks.json'))).toBe(true)
      expect(existsSync(join(custom, 'config.toml'))).toBe(true)
    })
  }))

  test('refuses while Codex runs against this CODEX_HOME, unless forced', () => withSandbox(async ({ home }) => {
    installTestHooks.codexPids = async () => [4242]
    installTestHooks.openFiles = async () => new Map([[4242, [join(home, '.codex', 'state_5.sqlite'), join(home, '.codex', 'tmp', 'arg0', 'codex-arg0x', '.lock')]]])
    mkdirSync(join(home, '.codex'), { recursive: true })
    const err = await adapter.installPlan(context()).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(HarnessBusyError)
    expect(err).toMatchObject({ exitCode: 2, code: 'HARNESS_BUSY' })
    expect((err as Error).message).toContain('4242')
    await withEnv({ BURACLE_FORCE: '1' }, async () => {
      expect((await adapter.installPlan(context())).ops.length).toBeGreaterThan(0)
    })
    expect((await adapter.installPlan({ ...context(), force: true } as AdapterContext)).ops.length).toBeGreaterThan(0)
  }))

  test('F15: the running-Codex guard applies to a custom CODEX_HOME too; a Codex using another CODEX_HOME does not block', () => withSandbox(async ({ home }) => {
    const custom = join(home, '.config', 'codex')
    mkdirSync(custom, { recursive: true })
    installTestHooks.codexPids = async () => [6685]
    await withEnv({ CODEX_HOME: custom }, async () => {
      installTestHooks.openFiles = async () => new Map([[6685, [join(custom, 'tmp', 'arg0', 'codex-arg0AbC', '.lock'), join(custom, 'logs_2.sqlite')]]])
      expect(await adapter.installPlan(context()).then(() => 'planned', (e: unknown) => (e as { code?: string }).code)).toBe('HARNESS_BUSY')
      installTestHooks.openFiles = async () => new Map([[6685, ['/Users/me/.codex/tmp/arg0/codex-arg0Q/.lock', '/Users/me/.codex/state_5.sqlite']]])
      expect(await adapter.installPlan(context()).then(() => 'planned', (e: unknown) => (e as { code?: string }).code)).toBe('planned')
      installTestHooks.openFiles = async () => undefined
      expect(await codexProcessesUsing(custom)).toEqual([6685])
      installTestHooks.openFiles = async () => new Map([[6685, ['/dev/null']]])
      expect(await codexProcessesUsing(custom)).toEqual([6685])
    })
  }))

  test('I8: a fresh install writes the BURACLE_HOME-aware command', () => withSandbox(async ({ home }) => {
    await install()
    const hooks = JSON.parse(read(join(home, '.codex', 'hooks.json'))).hooks
    for (const e of CODEX_HOOK_EVENTS) for (const g of hooks[e]) expect(g.hooks[0].command).toBe(hookCommand(e === 'PostToolUse' && g.matcher === POST_MASK_MATCHER ? POST_MASK_HANDLER : e))
    expect(hookCommand('Stop')).toStartWith(HOOK_COMMAND_PREFIX)
  }))

  test('I8 upgrade: an install with the legacy command keeps it under the default BURACLE_HOME (no re-trust, no moved user groups); a custom BURACLE_HOME switches', () => withSandbox(async ({ root, home }) => {
    const hooksPath = join(home, '.codex', 'hooks.json')
    const legacyArtifacts = codexArtifacts({ canonical, buracle: '/b', pathRulesDir: '~/r', hookCommandPrefix: LEGACY_HOOK_COMMAND_PREFIX })
    await applyPlans([{ id: 'codex', harness: 'codex', ops: hooksJsonOps(hooksPath, { ...legacyArtifacts, hooksFile: { hooks: Object.fromEntries(Object.entries(legacyArtifacts.hooksFile.hooks).filter(([e]) => e !== 'SubagentStart')) } }) }])
    const file = JSON.parse(read(hooksPath))
    const userGroup = { hooks: [{ type: 'command', command: 'echo user-audit-2', timeout: 5 }] }
    file.hooks.PreToolUse.push(userGroup)
    writeFileSync(hooksPath, JSON.stringify(file, null, 2) + '\n')
    expect(hookCommandPrefixFor(context(), await readLedger())).toBe(LEGACY_HOOK_COMMAND_PREFIX)
    const r = await install()
    expect(r.conflicts).toEqual([])
    const after = JSON.parse(read(hooksPath)).hooks
    expect(after.PreToolUse).toEqual([{ matcher: PRE_TOOL_MATCHER, hooks: [{ type: 'command', command: hookCommand('PreToolUse', LEGACY_HOOK_COMMAND_PREFIX), timeout: 10 }] }, userGroup])
    expect(after.SubagentStart[0].hooks[0].command).toBe(hookCommand('SubagentStart', LEGACY_HOOK_COMMAND_PREFIX))
    await withEnv({ BURACLE_HOME: join(root, 'custom-home') }, async () => {
      expect(hookCommandPrefixFor(context(), await readLedger())).toBe(HOOK_COMMAND_PREFIX)
    })
    expect(hookCommandPrefixFor(context(), undefined)).toBe(HOOK_COMMAND_PREFIX)
  }))

  test('parseLsofFields reads pid and name fields', () => {
    expect([...parseLsofFields('p12\nfcwd\nn/a b/c\np34\nn/x\n')]).toEqual([[12, ['/a b/c']], [34, ['/x']]])
  })

  test('D3: uninstallPlan removes what the ledger proves codex wrote, with the same busy refusal', () => withSandbox(async ({ home }) => {
    const userGroup = { hooks: [{ type: 'command', command: 'echo user-audit', timeout: 5 }] }
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [userGroup] } }, null, 2) + '\n')
    await install()
    const ledger = await readLedger()
    const owned = Object.keys(ledger).filter(k => ledger[k]?.owner === 'codex').sort()
    expect(owned.length).toBeGreaterThan(5)
    const plan = await adapter.uninstallPlan!(context())
    expect(plan.ops).toEqual(owned.map(path => ({ kind: 'remove', path, owner: 'codex' })))
    installTestHooks.codexPids = async () => [77]
    installTestHooks.openFiles = async () => new Map([[77, [join(home, '.codex', 'tmp', 'arg0', 'codex-arg0z', '.lock')]]])
    const err = await adapter.uninstallPlan!(context()).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(HarnessBusyError)
    expect((err as Error).message).toContain('run the uninstall again')
    installTestHooks.codexPids = async () => []
    await applyPlans([plan])
    expect(JSON.parse(read(join(home, '.codex', 'hooks.json'))).hooks).toEqual({ PreToolUse: [userGroup] })
    expect(Object.values(await readLedger()).filter(e => e.owner === 'codex')).toEqual([])
  }))

  test('F03: uninstall moves the user\'s /hooks approvals with their groups and drops those of Buracle\'s hooks', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    const hooksPath = join(codex, 'hooks.json')
    const configPath = join(codex, 'config.toml')
    const userFirst = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-audit-1', timeout: 5 }] }
    mkdirSync(codex, { recursive: true })
    writeFileSync(hooksPath, JSON.stringify({ hooks: { PreToolUse: [userFirst] } }, null, 2) + '\n')
    writeFileSync(configPath, '# my settings\nmodel = "gpt-6.1-sol"\n')
    await install()
    const userLater = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-audit-2', timeout: 5 }] }
    const doc = JSON.parse(read(hooksPath)) as { hooks: Record<string, Array<{ matcher?: string, hooks: Array<Record<string, unknown>> }>> }
    doc.hooks['PreToolUse']?.push(userLater)
    writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n')
    let trust = ''
    for (const [event, groups] of Object.entries(doc.hooks)) {
      groups.forEach((g, gi) => g.hooks.forEach((h, hi) => {
        trust += `\n[hooks.state.${JSON.stringify(hookTrustKey(hooksPath, event, gi, hi))}]\ntrusted_hash = ${JSON.stringify(hookTrustHash(event, g, h))}\n`
      }))
    }
    writeFileSync(configPath, read(configPath) + trust)
    const buracleGroups = findBuracleHandlers(doc, hooksPath).length
    expect(buracleGroups).toBeGreaterThan(5)

    const plan = await adapter.uninstallPlan!(context())
    const rekey = plan.ops.at(-1) as Extract<Op, { kind: 'toml-rekey' }>
    expect(rekey.kind).toBe('toml-rekey')
    expect(rekey.moves).toEqual([{ from: ['hooks', 'state', hookTrustKey(hooksPath, 'PreToolUse', 2, 0)], to: ['hooks', 'state', hookTrustKey(hooksPath, 'PreToolUse', 1, 0)], value: { trusted_hash: hookTrustHash('PreToolUse', userLater, userLater.hooks[0] as Record<string, unknown>) } }])
    expect(rekey.drops?.length).toBe(buracleGroups)
    const r = await applyPlans([plan])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([])
    expect(JSON.parse(read(hooksPath)).hooks).toEqual({ PreToolUse: [userFirst, userLater] })
    const st = (Bun.TOML.parse(read(configPath)) as { hooks: { state: Record<string, { trusted_hash: string }> } }).hooks.state
    expect(Object.keys(st).sort()).toEqual([hookTrustKey(hooksPath, 'PreToolUse', 0, 0), hookTrustKey(hooksPath, 'PreToolUse', 1, 0)].sort())
    expect(st[hookTrustKey(hooksPath, 'PreToolUse', 1, 0)]?.trusted_hash).toBe(hookTrustHash('PreToolUse', userLater, userLater.hooks[0] as Record<string, unknown>))
    expect(st[hookTrustKey(hooksPath, 'PreToolUse', 0, 0)]?.trusted_hash).toBe(hookTrustHash('PreToolUse', userFirst, userFirst.hooks[0] as Record<string, unknown>))
    expect(read(configPath).startsWith('# my settings\nmodel = "gpt-6.1-sol"\n')).toBe(true)
  }))

  test('F03: without approvals in config.toml the uninstall plan is just the removals', () => withSandbox(async ({ home }) => {
    await install()
    const plan = await adapter.uninstallPlan!(context())
    expect(plan.ops.every(op => op.kind === 'remove')).toBe(true)
    expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(true)
  }))

  test('tuiOps sets exactly the two keys Buracle owns', () => {
    const a = codexArtifacts({ canonical, buracle: '/b', pathRulesDir: '~/r' })
    expect(tuiOps('/h/.codex/config.toml', a)).toEqual([{ kind: 'toml-tables', path: '/h/.codex/config.toml', tables: {}, keys: { 'tui.status_line': a.tui.status_line, 'tui.terminal_title': a.tui.terminal_title }, owner: 'codex' }])
  })

  test('tildePath', () => {
    expect(tildePath('/h/u/.buracle/rules/paths', '/h/u')).toBe('~/.buracle/rules/paths')
    expect(tildePath('/elsewhere/x', '/h/u')).toBe('/elsewhere/x')
  })
})

describe('permissions.bypass on Codex', () => {
  test('off: no approval keys and no trust plan', () => withSandbox(async ({ home }) => {
    const config = defaultConfig()
    config.permissions.bypass = false
    const ctx = context({ config })
    expect((await install(ctx)).conflicts).toEqual([])
    const toml = Bun.TOML.parse(read(join(home, '.codex', 'config.toml'))) as Record<string, unknown>
    expect(Object.keys(BYPASS_KEYS).some(k => k in toml)).toBe(false)
    expect(codexTrustPlan(ctx)).toBeUndefined()
  }))

  test('the trust plan approves exactly Buracle\'s handlers at the indexes the installed hooks.json gives them', () => withSandbox(async ({ home }) => {
    const hooksPath = join(home, '.codex', 'hooks.json')
    mkdirSync(join(home, '.codex'), { recursive: true })
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-guard', timeout: 5 }] }
    writeFileSync(hooksPath, JSON.stringify({ hooks: { PreToolUse: [mine] } }, null, 2) + '\n')
    expect((await install()).conflicts).toEqual([])
    const plan = codexTrustPlan(context())
    expect(plan?.id).toBe('codex-trust')
    expect((await applyPlans([plan as NonNullable<typeof plan>])).conflicts).toEqual([])
    const toml = Bun.TOML.parse(read(join(home, '.codex', 'config.toml'))) as { hooks: { state: Record<string, { trusted_hash: string }> } }
    const ours = findBuracleHandlers(JSON.parse(read(hooksPath)), hooksPath)
    expect(ours.length).toBeGreaterThan(CODEX_HOOK_EVENTS.length - 1)
    for (const h of ours) expect(toml.hooks.state[h.key]).toEqual({ trusted_hash: h.hash as string })
    expect(toml.hooks.state[`${hooksPath}:pre_tool_use:0:0`]).toBeUndefined()
    expect(toml.hooks.state[`${hooksPath}:pre_tool_use:1:0`]).toBeDefined()
    expect(await applyPlans([codexTrustPlan(context()) as NonNullable<ReturnType<typeof codexTrustPlan>>])).toMatchObject({ txn: '', conflicts: [] })
  }))

  test('trustTables quotes keys that hold backslashes and quotes (Windows paths)', () => {
    const text = JSON.stringify(buracleHooksFile())
    const tables = trustTables(text, ['C:\\Users\\me\\.codex\\hooks.json'])
    const names = Object.keys(tables)
    expect(names.length).toBeGreaterThan(0)
    expect(names.every(n => n.startsWith('hooks.state."C:\\\\Users\\\\me'))).toBe(true)
    expect(trustTables('{ broken', ['/x'])).toEqual({})
  })
})

describe('config.toml keys for routing, effort and the no-approval mode (phase 2)', () => {
  const configOf = (over: (c: BuracleConfig) => void): BuracleConfig => {
    const c = defaultConfig()
    over(c)
    return c
  }
  const tomlIn = (codexHome: string) => Bun.TOML.parse(read(join(codexHome, 'config.toml'))) as Record<string, any>

  test('routing: web_search is disabled only while routing is enforced; the MCP startup grace is always 0', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    expect((await install(context({ config: configOf(c => { c.routing.strictness = 'nudge' }) }))).conflicts).toEqual([])
    expect(tomlIn(codex)['web_search']).toBeUndefined()
    expect(tomlIn(codex)['mcp_optional_startup_grace_ms']).toBe(0)
    expect((await install()).conflicts).toEqual([])
    expect(tomlIn(codex)['web_search']).toBe('disabled')
  }))

  test('a web_search the user chose is kept and reported (a plain owned key, not enforced)', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    mkdirSync(codex, { recursive: true })
    writeFileSync(join(codex, 'config.toml'), 'web_search = "live"\n')
    const r = await install()
    expect(r.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('web_search: already defined by the user')])
    expect(tomlIn(codex)['web_search']).toBe('live')
  }))

  test('effort keys are soft: a level Codex wrote after a model migration (or the user chose) is kept and reported as skipped, never a conflict', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    expect((await install()).conflicts).toEqual([])
    const path = join(codex, 'config.toml')
    writeFileSync(path, read(path).replace('model_reasoning_effort = "xhigh"', 'model_reasoning_effort = "medium"') + '\n[notice.model_migrations]\n"gpt-5.5" = "gpt-6-sol"\n')
    const r = await install()
    expect(r.conflicts).toEqual([])
    expect(r.skipped.map(s => s.reason)).toContain('kept user value (model_reasoning_effort)')
    expect(tomlIn(codex)['model_reasoning_effort']).toBe('medium')
    expect(tomlIn(codex)['plan_mode_reasoning_effort']).toBe('xhigh')
    const other = join(home, 'other-codex')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'config.toml'), 'model_reasoning_effort = "low"\n')
    await withEnv({ CODEX_HOME: other }, async () => {
      const r2 = await install()
      expect(r2.conflicts).toEqual([])
      expect(r2.skipped.map(s => s.reason)).toContain('kept user value (model_reasoning_effort)')
    })
    expect(tomlIn(other)['model_reasoning_effort']).toBe('low')
  }))

  test('compact_prompt is soft: a compaction prompt the user set is kept and reported as skipped', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    mkdirSync(codex, { recursive: true })
    writeFileSync(join(codex, 'config.toml'), 'compact_prompt = "Summarize in three bullets."\n')
    const r = await install()
    expect(r.conflicts).toEqual([])
    expect(r.skipped.map(s => s.reason)).toContain('kept user value (compact_prompt)')
    expect(tomlIn(codex)['compact_prompt']).toBe('Summarize in three bullets.')
  }))

  test('effort.codex: a level goes to all three keys (the subagent default within what every model has); keep and invalid values write nothing', () => withSandbox(async () => {
    const effortOf = async (effort: string) => {
      const ops = (await adapter.installPlan(context({ config: configOf(c => { c.effort.codex = effort }) }))).ops
      return ops.find(o => o.kind === 'toml-tables' && ((o as { soft?: string[] }).soft ?? []).includes('model_reasoning_effort')) as { keys: Record<string, string>, soft: string[] } | undefined
    }
    expect((await effortOf('max'))?.keys).toEqual({ model_reasoning_effort: 'max', plan_mode_reasoning_effort: 'max', 'agents.default_subagent_reasoning_effort': 'xhigh' })
    expect((await effortOf('medium'))?.keys).toEqual({ model_reasoning_effort: 'medium', plan_mode_reasoning_effort: 'medium', 'agents.default_subagent_reasoning_effort': 'medium' })
    expect((await effortOf('auto'))?.soft).toEqual(['model_reasoning_effort', 'plan_mode_reasoning_effort', 'agents.default_subagent_reasoning_effort'])
    expect(await effortOf('keep')).toBeUndefined()
    expect(await effortOf('ultra')).toBeUndefined()
    expect([subagentEffort('none'), subagentEffort('minimal')]).toEqual(['low', 'low'])
    for (const level of EFFORT_SCALES.codex.persistable) expect(SUBAGENT_EFFORTS).toContain(subagentEffort(level))
  }))

  test('the subagent default goes into an existing [agents] table, and stays valid TOML next to [agents.<role>] tables', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    mkdirSync(codex, { recursive: true })
    writeFileSync(join(codex, 'config.toml'), '[agents]\nmax_threads = 4\n\n[agents.reviewer]\ndescription = "mine"\nconfig_file = "reviewer.toml"\n')
    expect((await install()).conflicts).toEqual([])
    expect(read(join(codex, 'config.toml')).match(/^\[agents\]$/gm)).toHaveLength(1)
    expect(tomlIn(codex)['agents']).toEqual({ max_threads: 4, default_subagent_reasoning_effort: 'xhigh', enabled: true, reviewer: { description: 'mine', config_file: 'reviewer.toml' } })
    const other = join(home, 'roles-only')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'config.toml'), '[agents.reviewer]\ndescription = "mine"\n')
    await withEnv({ CODEX_HOME: other }, async () => { expect((await install()).conflicts).toEqual([]) })
    expect(tomlIn(other)['agents']).toEqual({ default_subagent_reasoning_effort: 'xhigh', enabled: true, reviewer: { description: 'mine' } })
  }))

  test('permissions.enforce off: the no-approval keys stay one unit (a value the user chose for either one means neither is written)', () => withSandbox(async ({ home }) => {
    const config = configOf(c => { c.permissions.enforce = false })
    const codex = join(home, '.codex')
    mkdirSync(codex, { recursive: true })
    writeFileSync(join(codex, 'config.toml'), 'sandbox_mode = "workspace-write"\n')
    expect((await install(context({ config }))).conflicts).toEqual([])
    expect([tomlIn(codex)['approval_policy'], tomlIn(codex)['sandbox_mode']]).toEqual([undefined, 'workspace-write'])
    const fresh = join(home, 'fresh-codex')
    mkdirSync(fresh, { recursive: true })
    await withEnv({ CODEX_HOME: fresh }, async () => { expect((await install(context({ config }))).conflicts).toEqual([]) })
    expect([tomlIn(fresh)['approval_policy'], tomlIn(fresh)['sandbox_mode']]).toEqual([BYPASS_APPROVAL_POLICY, 'danger-full-access'])
  }))

  test('upgrade: an approval_policy = "never" the ledger shows Buracle wrote becomes the granular policy, also with permissions.enforce off; doctor reports ok', () => withSandbox(async ({ home }) => {
    const config = configOf(c => { c.permissions.enforce = false })
    const codex = join(home, '.codex')
    const file = join(codex, 'config.toml')
    expect((await install(context({ config }))).conflicts).toEqual([])
    writeFileSync(file, read(file).replace(/^approval_policy = .*$/m, 'approval_policy = "never"'))
    const ledger = await readLedger()
    const key = Object.keys(ledger).find(k => k.endsWith('#approval_policy') && ledger[k]?.owner === 'codex') as string
    expect(key).toBeDefined()
    writeFileSync(paths.ownedLedgerFile(), JSON.stringify({ ...ledger, [key]: { ...ledger[key], sha256: valueHash('never') } }))
    expect(tomlIn(codex)['approval_policy']).toBe('never')
    const r = await install(context({ config }))
    expect(r.conflicts).toEqual([])
    expect([tomlIn(codex)['approval_policy'], tomlIn(codex)['sandbox_mode']]).toEqual([BYPASS_APPROVAL_POLICY, 'danger-full-access'])
    expect((await readLedger())[key]?.sha256).toBe(valueHash(BYPASS_APPROVAL_POLICY))
    expect(permissionCheck(tomlIn(codex), config).level).toBe('ok')
  }))

  test('bypassUnitBlocked: a value of the user\'s or a removal blocks; an equal value or one the ledger proves Buracle wrote does not', () => {
    const p = '/h/.codex/config.toml'
    expect(bypassUnitBlocked(undefined, undefined, p)).toBeUndefined()
    expect(bypassUnitBlocked('approval_policy = { granular = { rules = true, sandbox_approval = false, mcp_elicitations = false, request_permissions = false, skill_approval = false } }\n', undefined, p)).toBeUndefined()
    expect(bypassUnitBlocked('approval_policy = "never"\n', undefined, p)).toContain('approval_policy = "never"')
    expect(bypassUnitBlocked('sandbox_mode = "read-only"\n', undefined, p)).toContain('sandbox_mode = "read-only"')
    const ledger = { [`${p}#approval_policy`]: { owner: 'codex', sha256: valueHash('on-request'), path: p, pointer: 'approval_policy', writtenAt: 'x', kind: 'toml-key' as const } }
    expect(bypassUnitBlocked('approval_policy = "on-request"\n', ledger, p)).toBeUndefined()
    expect(bypassUnitBlocked('', ledger, p)).toContain('approval_policy was removed')
    expect(bypassUnitBlocked('approval_policy = [', undefined, p)).toBeUndefined()
  })

  test('a changed matcher keeps its group index; the trust plan records the new hash, also over an earlier /hooks approval (permissions.enforce)', () => withSandbox(async ({ home }) => {
    const codex = join(home, '.codex')
    const hooksPath = join(codex, 'hooks.json')
    const old = { matcher: 'Bash|apply_patch|request_user_input|request_user_input_async', hooks: [{ type: 'command', command: hookCommand('PreToolUse'), timeout: 10 }] }
    await applyPlans([{ id: 'codex', harness: 'codex', ops: [{ kind: 'json-list-merge', path: hooksPath, pointer: 'hooks.PreToolUse', items: [old], identity: HOOK_GROUP_IDENTITY, owner: 'codex', format: 'json' }] }])
    const user = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-audit', timeout: 5 }] }
    const doc = JSON.parse(read(hooksPath))
    doc.hooks.PreToolUse.push(user)
    writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n')
    writeFileSync(join(codex, 'config.toml'), `[hooks.state.${JSON.stringify(hookTrustKey(hooksPath, 'PreToolUse', 0, 0))}]\ntrusted_hash = ${JSON.stringify(hookTrustHash('PreToolUse', old, old.hooks[0] as Record<string, unknown>))}\n`)
    expect((await install()).conflicts).toEqual([])
    const after = JSON.parse(read(hooksPath)).hooks.PreToolUse
    expect(after).toEqual([{ matcher: PRE_TOOL_MATCHER, hooks: [{ type: 'command', command: hookCommand('PreToolUse'), timeout: 10 }] }, user])
    const r = await applyPlans([codexTrustPlan(context()) as NonNullable<ReturnType<typeof codexTrustPlan>>])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([expect.stringContaining('pre_tool_use:0:0')])
    const state = tomlIn(codex)['hooks']['state']
    expect(state[hookTrustKey(hooksPath, 'PreToolUse', 0, 0)]).toEqual({ trusted_hash: hookTrustHash('PreToolUse', after[0], after[0].hooks[0]) })
    expect(state[hookTrustKey(hooksPath, 'PreToolUse', 1, 0)]).toBeUndefined()
    expect(codexTrustPlan(context({ config: configOf(c => { c.permissions.enforce = false }) }))?.ops.every(o => (o as { enforce?: string[] }).enforce === undefined)).toBe(true)
  }))

  test('every enum value Buracle writes is one Codex accepts; a bad one is reported before anything is written', () => {
    expect([...CODEX_ENUMS.reasoning_effort] as string[]).toEqual([...EFFORT_SCALES.codex.levels])
    expect(codexEnumProblem('web_search', 'off')).toContain('Codex would refuse to start')
    expect(codexEnumProblem('omit_tools_from', ['deferred', 'hidden'])).toContain('"hidden"')
    expect(codexEnumProblem('omit_tools_from', [])).toContain('empty list')
    expect(codexEnumProblem('default_tools_approval_mode', 'never')).toBeDefined()
    expect(codexValueProblems({ mcpTables: {}, rootKeys: { mcp_optional_startup_grace_ms: -1 }, effort: { 'agents.default_subagent_reasoning_effort': 'max' } })).toEqual([
      expect.stringContaining('mcp_optional_startup_grace_ms'), expect.stringContaining('spawn_agent would fail'),
    ])
    const a = codexArtifacts({ canonical, buracle: '/b', pathRulesDir: '~/r', config: defaultConfig() })
    expect(codexValueProblems({ mcpTables: a.mcpTables, rootKeys: a.rootKeys, ...(a.effortKeys ? { effort: a.effortKeys } : {}), ...(a.bypassKeys ? { bypass: a.bypassKeys } : {}) })).toEqual([])
  })
})

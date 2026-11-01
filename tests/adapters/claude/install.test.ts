import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { announcementOps, claudeInstallPlan, defaultInstallDeps, effortKeys, effortOps, envOps, LSP_DISABLED_KEY, LSP_NEVER_KEY, lspRecommendationPlan, permissionOps, renderRule, retiredDenyOps, ruleOps, statusLineOp, teamsOps, windowsCliCommand } from '../../../src/adapters/claude/install'
import { buracleInstalledPlugin, KEPT_EXIT, marketplaceHolds, parseList, pluginInstalled, pluginsFrom } from '../../../src/adapters/claude/check'
import type { AdapterContext } from '../../../src/adapters/registry'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { defaultConfig } from '../../../src/core/config'
import * as paths from '../../../src/engine/paths'
import { run } from '../../../src/engine/proc'
import { applyPlans, LIST_IDENTITY_HASH, listTxns, readLedger, type Ledger, type Op } from '../../../src/engine/txn'
import { emptyRecord } from '../../../src/engine/update/install-core'
import { composeUninstall, execUndos, runExecUndos } from '../../../src/engine/update/uninstall'
import { pathToFileURL } from 'node:url'
import { fakeExe } from '../../helpers/fake-exe'
import { withSandbox, withEnv } from '../../helpers/sandbox'

const FIX = join(import.meta.dir, 'fixtures')
const REPO = paths.repoRoot()
const CLAUDE_ENV = {
  'env.CLAUDE_CODE_DISABLE_1M_CONTEXT': 'false',
  'env.CLAUDE_CODE_WORKFLOWS': 'true',
  'env.CLAUDE_CODE_AUTO_CONNECT_IDE': 'true',
  'env.CLAUDE_CODE_NO_FLICKER': 'true',
  'env.CLAUDE_CODE_ENABLE_TODO_TOOLS': 'true',
  'env.CLAUDE_CODE_ENABLE_TASKS': 'true',
  'env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP': '0',
  'env.CLAUDE_CODE_TODO_REMINDER_MODE': 'baseline',
  'env.ENABLE_TOOL_SEARCH': 'true',
}

function ctxFor(over: { bypass?: boolean, enforce?: boolean, effort?: string, retired?: string[] } = {}): AdapterContext {
  const config = defaultConfig()
  if (over.bypass !== undefined) config.permissions.bypass = over.bypass
  if (over.enforce !== undefined) config.permissions.enforce = over.enforce
  if (over.effort !== undefined) config.effort.claude = over.effort
  const canonical = loadCanonicalSync(join(FIX, 'canonical-mini'))
  if (over.retired !== undefined) canonical.plugins = { ...canonical.plugins, claude: { ...canonical.plugins.claude, retired: over.retired } }
  return { repoRoot: REPO, config, canonical, paths, buracleBin: paths.shimPath() }
}

type ExecOp = Extract<Op, { kind: 'exec' }>
const execs = (ops: Op[]) => ops.filter((o): o is ExecOp => o.kind === 'exec')

describe('install plan as data', () => {
  test('Windows status lines: one command line that Git Bash and PowerShell both parse (bare program, single-quoted path), bun running the plugin launcher', async () => {
    await withSandbox(async () => {
      const ctx = (repoRoot: string): AdapterContext => ({ ...ctxFor(), repoRoot, buracleBin: 'C:\\Users\\Ann Lee\\.buracle\\bin\\buracle.cmd' })
      const set = (op: Op) => (op as Extract<Op, { kind: 'json-merge' }>).set as Record<string, { type?: string, command: string }>
      const spaced = set(statusLineOp(ctx('C:\\Users\\Ann Lee\\buracle'), 'C:\\Users\\Ann Lee\\.bun\\bin\\bun.exe', true))
      expect(spaced['statusLine']).toEqual({ type: 'command', command: "bun 'C:/Users/Ann Lee/buracle/harness/claude/bin/buracle.ts' statusline claude", padding: 0, refreshInterval: 60 } as never)
      expect(spaced['subagentStatusLine']).toEqual({ type: 'command', command: "bun 'C:/Users/Ann Lee/buracle/harness/claude/bin/buracle.ts' statusline claude --subagent" })
      const plain = set(statusLineOp(ctx('C:\\Users\\RUNNER~1\\buracle'), 'C:\\Users\\RUNNER~1\\.bun\\bin\\bun.exe', true))
      expect(plain['statusLine']?.command).toBe('C:/Users/RUNNER~1/.bun/bin/bun.exe C:/Users/RUNNER~1/buracle/harness/claude/bin/buracle.ts statusline claude')
      expect(windowsCliCommand({ repoRoot: "C:\\it's", buracleBin: 'C:\\h\\.buracle\\bin\\buracle.cmd' }, 'bun', 'statusline claude')).toBe('C:/h/.buracle/bin/buracle.cmd statusline claude')
      const posix = set(statusLineOp(ctxFor(), '/x/bun', false))
      expect(Object.keys(posix)).toEqual(['statusLine'])
      expect(posix['statusLine']?.command).toMatch(/^\S*buracle\S* statusline claude$/)
    })
  })

  test('the check script runs on the PATH bun, which survives a Homebrew upgrade (the journal keeps the argv for undo)', () => {
    expect(defaultInstallDeps.bunBin()).toBe(Bun.which('bun') ?? process.execPath)
  })

  test('rules, statusLine, the bypass permission keys and exec ops', async () => {
    await withSandbox(async sb => {
      const plan = await claudeInstallPlan(ctxFor(), { claudeBin: () => '/x/claude', bunBin: () => '/x/bun', marketplaces: async () => [], ledger: async () => ({}) })
      expect(plan.id).toBe('claude')
      expect(plan.harness).toBe('claude')
      const files = plan.ops.filter(o => o.kind === 'file') as Array<Extract<Op, { kind: 'file' }>>
      expect(files.map(f => f.path)).toEqual([
        join(sb.home, '.claude', 'rules', 'buracle', 'always', 'core.md'),
        join(sb.home, '.claude', 'rules', 'buracle', 'paths', 'python.md'),
      ])
      expect(files.every(f => f.owner === 'claude')).toBe(true)
      expect(files[0]?.content).toBe('# Core\n\nWork directly. Ask with `AskUserQuestion` only for real decisions.\nClaude-only sentence.\n')
      expect(files[1]?.content).toBe('---\npaths:\n  - "**/*.py"\n  - "**/pyproject.toml"\n---\n\n# Python\n\nUse the project\'s environment and lockfile.\n')

      const merges = plan.ops.filter(o => o.kind === 'json-merge') as Array<Extract<Op, { kind: 'json-merge' }>>
      expect(merges).toHaveLength(7)
      expect(merges[6]?.set).toEqual({ companyAnnouncements: ['Buracle · Memory UI: http://127.0.0.1:41777 (buracle mem ui) · /buracle:plan-build plans and builds a change'] })
      expect(merges[6]?.soft).toEqual(['companyAnnouncements'])
      expect(merges[6]?.enforce).toBeUndefined()
      expect(merges[5]?.set).toEqual({ autoMemoryEnabled: false })
      expect(merges[5]?.soft).toEqual(['autoMemoryEnabled'])
      expect(merges[4]?.set).toEqual(CLAUDE_ENV)
      expect(merges[4]?.enforce).toEqual(Object.keys(CLAUDE_ENV))
      expect(merges[4]?.soft).toBeUndefined()
      expect(merges[3]?.set).toEqual({ 'env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS': '1' })
      expect(merges[3]?.soft).toEqual(['env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'])
      expect(merges[3]?.enforce).toBeUndefined()
      expect(merges.every(m => m.path === join(sb.home, '.claude', 'settings.json'))).toBe(true)
      if (process.platform !== 'win32') expect(merges[0]?.set).toEqual({ statusLine: { type: 'command', command: `${join(sb.buracleHome, 'bin', 'buracle')} statusline claude`, padding: 0, refreshInterval: 60 } })
      else expect((merges[0]?.set['statusLine'] as { command: string }).command).toMatch(/^(?:\/x\/bun|bun) '?[^']*\/harness\/claude\/bin\/buracle\.ts'? statusline claude$/)
      expect(merges[1]?.set).toEqual({ 'permissions.defaultMode': 'bypassPermissions', skipDangerousModePermissionPrompt: true })
      expect(merges[1]?.enforce).toEqual(['permissions.defaultMode', 'skipDangerousModePermissionPrompt'])
      expect(merges[1]?.soft).toBeUndefined()
      const effort = {
        effortLevel: 'xhigh', 'modelSettings.claude-opus-5-5.effortLevel': 'xhigh', 'modelSettings.claude-sonnet-5-5.effortLevel': 'xhigh',
        'modelSettings.claude-haiku-5-5.effortLevel': 'xhigh', 'modelSettings.claude-fable-5-1.effortLevel': 'xhigh',
      }
      expect(merges[2]?.set).toEqual(effort)
      expect(merges[2]?.soft).toEqual(Object.keys(effort))
      expect(merges[2]?.enforce).toBeUndefined()
      expect(JSON.stringify(plan.ops)).not.toContain('CLAUDE_CODE_EFFORT_LEVEL')

      const check = (...a: string[]) => ['/x/bun', join(REPO, 'src/adapters/claude/check.ts'), '--claude', '/x/claude', ...a]
      expect(execs(plan.ops)).toEqual([
        { kind: 'exec', owner: 'claude', soft: true, argv: ['/x/claude', 'plugin', 'marketplace', 'add', 'acme/claude-market'], undo: check('remove-marketplace', 'acme-market'), idempotentCheck: check('marketplace', 'acme-market') },
        { kind: 'exec', owner: 'claude', argv: ['/x/claude', 'plugin', 'marketplace', 'add', REPO], undo: ['/x/claude', 'plugin', 'marketplace', 'remove', 'buracle'], idempotentCheck: check('marketplace', 'buracle', '--path', REPO) },
        { kind: 'exec', owner: 'claude', argv: ['/x/claude', 'plugin', 'install', 'buracle@buracle', '--scope', 'user'], undo: ['/x/claude', 'plugin', 'uninstall', 'buracle@buracle', '--scope', 'user'], idempotentCheck: check('plugin', 'buracle@buracle') },
        { kind: 'exec', owner: 'claude', soft: true, argv: ['/x/claude', 'plugin', 'install', 'lint-lsp@acme-market', '--scope', 'user'], undo: ['/x/claude', 'plugin', 'uninstall', 'lint-lsp@acme-market', '--scope', 'user'], idempotentCheck: check('plugin', 'lint-lsp@acme-market') },
      ])
      const settings = join(sb.home, '.claude', 'settings.json')
      expect(plan.cleanupKeys).toEqual([{ path: settings, pointer: 'enabledPlugins' }, { path: settings, pointer: 'extraKnownMarketplaces' }])
    })
  })

  test('permissions.bypass off: no permission keys at all (the hidden MCP tools of H11 are not a permission mode)', async () => {
    await withSandbox(async () => {
      const plan = await claudeInstallPlan(ctxFor({ bypass: false }), { claudeBin: () => '/x/claude', bunBin: () => '/x/bun', marketplaces: async () => [], ledger: async () => ({}) })
      expect(JSON.stringify(plan.ops.filter(o => o.kind !== 'json-list-merge'))).not.toMatch(/permissions|defaultMode|skipDangerous/)
      expect(plan.ops.filter(o => o.kind === 'json-list-merge').map(o => (o as { pointer: string }).pointer)).toEqual(['permissions.deny'])
    })
  })

  test('permissions.enforce off: the bypass keys are ordinary keys (a value the user changed stays theirs)', () => {
    const op = permissionOps(ctxFor({ enforce: false }))[0] as Extract<Op, { kind: 'json-merge' }>
    expect(op.set).toEqual({ 'permissions.defaultMode': 'bypassPermissions', skipDangerousModePermissionPrompt: true })
    expect(op.enforce).toBeUndefined()
  })

  test('the startup announcement names the configured Memory UI port', () => {
    const ctx = ctxFor()
    ctx.config.memory.ui.port = 41999
    const op = announcementOps(ctx)[0] as Extract<Op, { kind: 'json-merge' }>
    expect(op.path).toBe(join(ctx.paths.claudeDir(), 'settings.json'))
    expect(op.set).toEqual({ companyAnnouncements: ['Buracle · Memory UI: http://127.0.0.1:41999 (buracle mem ui) · /buracle:plan-build plans and builds a change'] })
  })

  test("applied: the announcement is written, a value the user set before or after stays theirs, and uninstall removes only Buracle's", async () => {
    await withSandbox(async sb => {
      const file = join(sb.home, '.claude', 'settings.json')
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      const read = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const plan = { id: 'claude', harness: 'claude' as const, ops: announcementOps(ctxFor()) }
      const ours = (plan.ops[0] as Extract<Op, { kind: 'json-merge' }>).set['companyAnnouncements']

      writeFileSync(file, JSON.stringify({ model: 'opus', companyAnnouncements: ['Team news'] }, null, 2))
      expect((await applyPlans([plan])).conflicts).toEqual([])
      expect(read()).toEqual({ model: 'opus', companyAnnouncements: ['Team news'] })

      writeFileSync(file, JSON.stringify({ model: 'opus' }, null, 2))
      expect((await applyPlans([plan])).conflicts).toEqual([])
      expect(read()).toEqual({ model: 'opus', companyAnnouncements: ours })
      writeFileSync(file, JSON.stringify({ model: 'opus', companyAnnouncements: ['Mine now'] }, null, 2))
      expect((await applyPlans([plan])).conflicts).toEqual([])
      expect(read()['companyAnnouncements']).toEqual(['Mine now'])
      const group = composeUninstall(await readLedger(), [], emptyRecord(), paths.oldVaultRoot()).groups.find(g => g.owner === 'claude')
      await applyPlans([group!.content])
      expect(read()).toEqual({ model: 'opus', companyAnnouncements: ['Mine now'] })
    })
  })

  test("uninstall takes back the announcement Buracle wrote when the user left it alone", async () => {
    await withSandbox(async sb => {
      const file = join(sb.home, '.claude', 'settings.json')
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      writeFileSync(file, JSON.stringify({ model: 'opus' }, null, 2))
      await applyPlans([{ id: 'claude', harness: 'claude', ops: announcementOps(ctxFor()) }])
      const group = composeUninstall(await readLedger(), [], emptyRecord(), paths.oldVaultRoot()).groups.find(g => g.owner === 'claude')
      await applyPlans([group!.content])
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ model: 'opus' })
    })
  })

  test('agents.teams: on writes the agent-teams switch as a soft key; off writes nothing (an earlier value is pruned)', () => {
    const ctx = ctxFor()
    const on = teamsOps(ctx)[0] as Extract<Op, { kind: 'json-merge' }>
    expect(on.path).toBe(join(ctx.paths.claudeDir(), 'settings.json'))
    expect(on.set).toEqual({ 'env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS': '1' })
    expect(on.soft).toEqual(['env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'])
    expect(on.enforce).toBeUndefined()
    ctx.config.agents.teams = false
    expect(teamsOps(ctx)).toEqual([])
  })

  test('the Claude Code env keys are written as enforced keys whatever the config says (agents.teams and permissions off too)', () => {
    const ctx = ctxFor({ bypass: false, enforce: false })
    ctx.config.agents.teams = false
    expect(envOps(ctx)).toEqual([{ kind: 'json-merge', path: join(ctx.paths.claudeDir(), 'settings.json'), set: CLAUDE_ENV, owner: 'claude', enforce: Object.keys(CLAUDE_ENV) }])
  })

  test('effort.claude: keep writes nothing (an earlier value is pruned), a level is written as it is, an invalid value writes nothing', () => {
    expect(effortOps(ctxFor({ effort: 'keep' }))).toEqual([])
    const high = effortOps(ctxFor({ effort: 'high' }))[0] as Extract<Op, { kind: 'json-merge' }>
    expect(Object.values(high.set)).toEqual(['high', 'high', 'high', 'high', 'high'])
    expect(effortOps(ctxFor({ effort: 'max' }))).toEqual([])
    expect(effortKeys('low')).toEqual({
      effortLevel: 'low', 'modelSettings.claude-opus-5-5.effortLevel': 'low', 'modelSettings.claude-sonnet-5-5.effortLevel': 'low',
      'modelSettings.claude-haiku-5-5.effortLevel': 'low', 'modelSettings.claude-fable-5-1.effortLevel': 'low',
    })
  })

  test('a retired plugin gets a soft uninstall, guarded by the `retired` check (only what Buracle installed)', async () => {
    await withSandbox(async () => {
      const plan = await claudeInstallPlan(ctxFor({ retired: ['old-lsp@acme-market'] }), { claudeBin: () => '/x/claude', bunBin: () => '/x/bun', marketplaces: async () => [], ledger: async () => ({}) })
      const check = (...a: string[]) => ['/x/bun', join(REPO, 'src/adapters/claude/check.ts'), '--claude', '/x/claude', ...a]
      expect(execs(plan.ops).at(-1)).toEqual({ kind: 'exec', owner: 'claude', soft: true, argv: ['/x/claude', 'plugin', 'uninstall', 'old-lsp@acme-market', '--scope', 'user'], undo: ['/x/claude', 'plugin', 'install', 'old-lsp@acme-market', '--scope', 'user'], idempotentCheck: check('retired', 'old-lsp@acme-market') })
    })
  })

  test('the official marketplace, which Claude Code manages itself, is never added or removed', async () => {
    await withSandbox(async () => {
      const base = ctxFor()
      const ctx: AdapterContext = {
        ...base,
        canonical: {
          ...base.canonical,
          plugins: {
            ...base.canonical.plugins,
            claude: {
              marketplaces: [{ id: 'claude-plugins-official', source: 'anthropics/claude-plugins-official' }, ...base.canonical.plugins.claude.marketplaces],
              plugins: [{ id: 'pyright-lsp@claude-plugins-official', enabled: true }],
            },
          },
        },
      }
      const plan = await claudeInstallPlan(ctx, { claudeBin: () => '/x/claude', bunBin: () => '/x/bun', marketplaces: async () => [], ledger: async () => ({}) })
      const text = JSON.stringify(execs(plan.ops))
      expect(text).not.toContain('anthropics/claude-plugins-official')
      expect(execs(plan.ops).some(o => (o.undo ?? []).includes('claude-plugins-official'))).toBe(false)
      expect(execs(plan.ops).find(o => o.argv.includes('pyright-lsp@claude-plugins-official'))?.soft).toBe(true)
    })
  })

  test('a buracle marketplace from another checkout is repointed and undo points it back', async () => {
    await withSandbox(async () => {
      const current = [{ name: 'buracle', source: 'directory', path: '/old/checkout' }]
      const plan = await claudeInstallPlan(ctxFor(), { claudeBin: () => 'claude', bunBin: () => 'bun', marketplaces: async () => current, ledger: async () => ({}) })
      const add = execs(plan.ops).find(o => o.argv.includes(REPO))
      expect(add?.undo).toEqual(['claude', 'plugin', 'marketplace', 'add', '/old/checkout'])
    })
  })

  test('rules this adapter wrote earlier but canonical no longer has are removed (ledger-proven only)', async () => {
    await withSandbox(async sb => {
      const root = join(sb.home, '.claude', 'rules', 'buracle')
      const entry = (path: string, owner: string, adopted?: boolean) => ({ owner, sha256: 'x', path, writtenAt: 't', kind: 'file' as const, ...(adopted ? { adopted } : {}) })
      const ledger: Ledger = {
        [join(root, 'paths', 'old.md')]: entry(join(root, 'paths', 'old.md'), 'claude'),
        [join(root, 'paths', 'python.md')]: entry(join(root, 'paths', 'python.md'), 'claude'),
        [join(root, 'paths', 'theirs.md')]: entry(join(root, 'paths', 'theirs.md'), 'codex'),
        [join(root, 'paths', 'adopted.md')]: entry(join(root, 'paths', 'adopted.md'), 'claude', true),
        [join(sb.home, '.claude', 'other.md')]: entry(join(sb.home, '.claude', 'other.md'), 'claude'),
      }
      const removes = ruleOps(ctxFor(), ledger).filter(o => o.kind === 'remove')
      expect(removes).toEqual([{ kind: 'remove', path: join(root, 'paths', 'old.md'), owner: 'claude' }])
    })
  })

  test('renderRule keeps frontmatter of the real path rules', () => {
    const real = loadCanonicalSync(join(REPO, 'canonical'))
    for (const r of real.rules) {
      const text = renderRule(r)
      expect(text.endsWith('\n')).toBe(true)
      expect(text).not.toContain('{{')
      if (r.scope === 'paths') expect(text.startsWith('---\npaths:\n  - "')).toBe(true)
      else expect(text.startsWith('---')).toBe(false)
    }
  })
})

describe('check.ts helpers', () => {
  test('parse listings and match marketplaces and plugins', () => {
    expect(parseList('[]')).toEqual([])
    expect(parseList('noise\n[{"name":"x"}]')).toEqual([{ name: 'x' }])
    expect(parseList('Update available [2.1.294]\n[\n  {"id":"a@b"}\n]\n')).toEqual([{ id: 'a@b' }])
    expect(parseList('{"not":"a list"}')).toBeUndefined()
    expect(parseList('')).toBeUndefined()
    const mk = [{ name: 'buracle', source: 'directory', path: '/a/b/' }]
    expect(marketplaceHolds(mk, 'buracle')).toBe(true)
    expect(marketplaceHolds(mk, 'buracle', '/a/b')).toBe(true)
    expect(marketplaceHolds(mk, 'buracle', '/a/c')).toBe(false)
    expect(marketplaceHolds(mk, 'other')).toBe(false)
    expect(pluginInstalled([{ id: 'buracle@buracle', enabled: false }], 'buracle@buracle')).toBe(true)
    expect(pluginInstalled([], 'buracle@buracle')).toBe(false)
    expect(pluginsFrom([{ id: 'b@acme' }, { id: 'a@acme' }, { id: 'c@other' }, { id: 7 }], 'acme')).toEqual(['a@acme', 'b@acme'])
  })
})

describe('install plan applied through the transaction engine (fake claude)', () => {
  function fakeClaude(root: string): { bin: string, state: string } {
    const state = join(root, 'fake-state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'names.json'), JSON.stringify({ 'acme/claude-market': 'acme-market' }))
    const bin = fakeExe(join(root, 'claude'), `await import(${JSON.stringify(pathToFileURL(join(FIX, 'fake-claude.ts')).href)})`)
    return { bin, state }
  }

  test('applies once, is idempotent, keeps user settings, and rolls back with undo on failure', async () => {
    await withSandbox(async sb => {
      const { bin, state } = fakeClaude(sb.root)
      const settings = join(sb.home, '.claude', 'settings.json')
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'auto', allow: ['Bash(ls)'] }, modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } }, theme: 'dark' }, null, 2))
      await withEnv({ FAKE_CLAUDE_STATE: state }, async () => {
        const deps = { claudeBin: () => bin, bunBin: () => process.execPath }
        const plan = await claudeInstallPlan(ctxFor(), deps)
        const r1 = await applyPlans([plan])
        expect(r1.conflicts).toEqual([])
        expect(r1.warnings.join('\n')).toContain('permissions.defaultMode')
        expect(r1.warnings.join('\n')).toContain('"auto"')
        expect(r1.skipped.map(s => s.reason)).toContainEqual(expect.stringMatching(/^kept user value \(modelSettings\.claude-opus-5-5\.effortLevel\)/))
        expect(r1.txn).not.toBe('')
        const s = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>
        expect(s['permissions']).toEqual({ defaultMode: 'bypassPermissions', allow: ['Bash(ls)'] })
        expect(s['skipDangerousModePermissionPrompt']).toBe(true)
        expect(s['effortLevel']).toBe('xhigh')
        expect(s['modelSettings']).toEqual({
          'claude-opus-5-5': { effortLevel: 'high' },
          'claude-sonnet-5-5': { effortLevel: 'xhigh' }, 'claude-haiku-5-5': { effortLevel: 'xhigh' }, 'claude-fable-5-1': { effortLevel: 'xhigh' },
        })
        expect(s['theme']).toBe('dark')
        expect((s['statusLine'] as Record<string, unknown>)['refreshInterval']).toBe(60)
        expect(existsSync(join(sb.home, '.claude', 'rules', 'buracle', 'paths', 'python.md'))).toBe(true)
        const plugs = JSON.parse(readFileSync(join(state, 'plugins.json'), 'utf8')) as Array<{ id: string }>
        expect(plugs.map(p => p.id).sort()).toEqual(['buracle@buracle', 'lint-lsp@acme-market'])
        const mkts = JSON.parse(readFileSync(join(state, 'marketplaces.json'), 'utf8')) as Array<{ name: string, path?: string }>
        expect(mkts.find(m => m.name === 'buracle')?.path).toBe(REPO)

        const before = readFileSync(join(state, 'calls.log'), 'utf8').split('\n').filter(l => /^plugin (install|marketplace add)/.test(l)).length
        const r2 = await applyPlans([await claudeInstallPlan(ctxFor(), deps)])
        expect(r2.txn).toBe('')
        expect(r2.applied).toBe(0)
        expect(r2.conflicts).toEqual([])
        const after = readFileSync(join(state, 'calls.log'), 'utf8').split('\n').filter(l => /^plugin (install|marketplace add)/.test(l)).length
        expect(after).toBe(before)

        writeFileSync(settings, readFileSync(settings, 'utf8').replace('"bypassPermissions"', '"auto"'))
        const r3 = await applyPlans([await claudeInstallPlan(ctxFor(), deps)])
        expect(r3.conflicts).toEqual([])
        expect((JSON.parse(readFileSync(settings, 'utf8')) as { permissions: { defaultMode: string } }).permissions.defaultMode).toBe('bypassPermissions')
      })
    })
  }, 60_000)

  test('permissions.enforce off: a permission mode the user chose is kept and reported as a conflict', async () => {
    await withSandbox(async sb => {
      const { bin, state } = fakeClaude(sb.root)
      const settings = join(sb.home, '.claude', 'settings.json')
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'default', allow: ['Bash(ls)'] }, theme: 'dark' }, null, 2))
      await withEnv({ FAKE_CLAUDE_STATE: state }, async () => {
        const r = await applyPlans([await claudeInstallPlan(ctxFor({ enforce: false }), { claudeBin: () => bin, bunBin: () => process.execPath })])
        expect(r.conflicts).toHaveLength(1)
        expect(r.conflicts[0]?.detail).toContain('permissions.defaultMode')
        const s = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>
        expect(s['permissions']).toEqual({ defaultMode: 'default', allow: ['Bash(ls)'] })
        expect(s['skipDangerousModePermissionPrompt']).toBe(true)
      })
    })
  }, 60_000)

  test("a failing exec of Buracle's own rolls back the files and undoes the execs that ran", async () => {
    await withSandbox(async sb => {
      const { bin, state } = fakeClaude(sb.root)
      await withEnv({ FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_FAIL: 'install buracle@buracle' }, async () => {
        const plan = await claudeInstallPlan(ctxFor(), { claudeBin: () => bin, bunBin: () => process.execPath })
        await expect(applyPlans([plan])).rejects.toThrow(/rolled back/)
        expect(existsSync(join(sb.home, '.claude', 'rules', 'buracle', 'always', 'core.md'))).toBe(false)
        expect(existsSync(join(sb.home, '.claude', 'settings.json'))).toBe(false)
        expect(JSON.parse(readFileSync(join(state, 'plugins.json'), 'utf8'))).toEqual([])
        expect(JSON.parse(readFileSync(join(state, 'marketplaces.json'), 'utf8'))).toEqual([])
        const calls = readFileSync(join(state, 'calls.log'), 'utf8')
        expect(calls).toContain('plugin marketplace remove buracle')
        expect(calls).toContain('plugin marketplace remove acme-market')
      })
    })
  }, 60_000)

  test('a third-party plugin that fails to install is a warning, not a rollback (soft, I1)', async () => {
    await withSandbox(async sb => {
      const { bin, state } = fakeClaude(sb.root)
      await withEnv({ FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_FAIL: 'install lint-lsp' }, async () => {
        const plan = await claudeInstallPlan(ctxFor(), { claudeBin: () => bin, bunBin: () => process.execPath })
        const r = await applyPlans([plan])
        expect(r.txn).not.toBe('')
        expect(r.warnings.join('\n')).toContain('lint-lsp@acme-market')
        expect(existsSync(join(sb.home, '.claude', 'rules', 'buracle', 'always', 'core.md'))).toBe(true)
        const plugs = JSON.parse(readFileSync(join(state, 'plugins.json'), 'utf8')) as Array<{ id: string }>
        expect(plugs.map(p => p.id)).toEqual(['buracle@buracle'])
      })
    })
  }, 60_000)
})

describe('the undo of a third-party marketplace Buracle added (install F02)', () => {
  function fakeClaude(root: string): { bin: string, state: string } {
    const state = join(root, 'fake-state')
    mkdirSync(state, { recursive: true })
    writeFileSync(join(state, 'names.json'), JSON.stringify({ 'acme/claude-market': 'acme-market' }))
    const bin = fakeExe(join(root, 'claude'), `await import(${JSON.stringify(pathToFileURL(join(FIX, 'fake-claude.ts')).href)})`)
    return { bin, state }
  }
  const check = (bin: string, ...a: string[]) => run([process.execPath, join(REPO, 'src/adapters/claude/check.ts'), '--claude', bin, ...a], { timeoutMs: 60_000 })

  test('uninstall keeps a marketplace the user installed plugins from, and reports why', async () => {
    await withSandbox(async sb => {
      const { bin, state } = fakeClaude(sb.root)
      await withEnv({ FAKE_CLAUDE_STATE: state }, async () => {
        await applyPlans([await claudeInstallPlan(ctxFor(), { claudeBin: () => bin, bunBin: () => process.execPath })])
        expect((await run([bin, 'plugin', 'install', 'userplug@acme-market', '--scope', 'user'])).code).toBe(0)
        const undo = await runExecUndos(execUndos(await listTxns(), emptyRecord()), emptyRecord())
        const mkts = JSON.parse(readFileSync(join(state, 'marketplaces.json'), 'utf8')) as Array<{ name: string }>
        expect(mkts.map(m => m.name)).toEqual(['acme-market'])
        const plugs = JSON.parse(readFileSync(join(state, 'plugins.json'), 'utf8')) as Array<{ id: string }>
        expect(plugs.map(p => p.id)).toEqual(['userplug@acme-market'])
        expect(readFileSync(join(state, 'calls.log'), 'utf8')).not.toContain('plugin marketplace remove acme-market')
        expect(JSON.stringify(undo)).toContain('kept the acme-market marketplace')
        expect(JSON.stringify(undo)).toContain('userplug@acme-market')
      })
    })
  }, 60_000)

  test('retired: removal is due only for a plugin a committed Buracle transaction installed and that is still there', async () => {
    await withSandbox(async sb => {
      const { bin, state } = fakeClaude(sb.root)
      await withEnv({ FAKE_CLAUDE_STATE: state }, async () => {
        expect((await run([bin, 'plugin', 'marketplace', 'add', 'acme/claude-market'])).code).toBe(0)
        expect((await run([bin, 'plugin', 'install', 'old-lsp@acme-market'])).code).toBe(0)
        expect(buracleInstalledPlugin('old-lsp@acme-market')).toBe(false)
        expect((await check(bin, 'retired', 'old-lsp@acme-market')).code).toBe(0)
        const journal = (status: string, ran: boolean) => JSON.stringify({ v: 1, txn: 't', status, execs: [{ argv: [bin, 'plugin', 'install', 'old-lsp@acme-market', '--scope', 'user'], ran }] })
        mkdirSync(paths.journalDir(), { recursive: true })
        writeFileSync(join(paths.journalDir(), 'a.json'), journal('rolled-back', true))
        writeFileSync(join(paths.journalDir(), 'b.json'), journal('committed', false))
        expect((await check(bin, 'retired', 'old-lsp@acme-market')).code).toBe(0)
        writeFileSync(join(paths.journalDir(), 'c.json'), journal('committed', true))
        expect(buracleInstalledPlugin('old-lsp@acme-market')).toBe(true)
        expect((await check(bin, 'retired', 'old-lsp@acme-market')).code).toBe(1)
        expect((await run([bin, 'plugin', 'uninstall', 'old-lsp@acme-market'])).code).toBe(0)
        expect((await check(bin, 'retired', 'old-lsp@acme-market')).code).toBe(0)
      })
    })
  }, 60_000)

  test('remove-marketplace: removed when unused, a no-op when gone, kept when used, untouched when listing fails', async () => {
    await withSandbox(async sb => {
      const { bin, state } = fakeClaude(sb.root)
      await withEnv({ FAKE_CLAUDE_STATE: state }, async () => {
        expect((await run([bin, 'plugin', 'marketplace', 'add', 'acme/claude-market'])).code).toBe(0)
        expect((await run([bin, 'plugin', 'install', 'mine@acme-market'])).code).toBe(0)
        const kept = await check(bin, 'remove-marketplace', 'acme-market')
        expect(kept.code).toBe(KEPT_EXIT)
        expect(kept.stderr).toContain('mine@acme-market')
        expect(readFileSync(join(state, 'calls.log'), 'utf8')).not.toContain('marketplace remove')
        await withEnv({ FAKE_CLAUDE_FAIL: 'plugin list' }, async () => {
          expect((await check(bin, 'remove-marketplace', 'acme-market')).code).toBe(2)
        })
        expect((await run([bin, 'plugin', 'uninstall', 'mine@acme-market'])).code).toBe(0)
        expect((await check(bin, 'remove-marketplace', 'acme-market')).code).toBe(0)
        expect(JSON.parse(readFileSync(join(state, 'marketplaces.json'), 'utf8'))).toEqual([])
        expect((await check(bin, 'remove-marketplace', 'acme-market')).code).toBe(0)
      })
    })
  }, 60_000)
})

describe('retired permissions.deny entries: Buracle hides no MCP tool any more, and an empty json-list-merge op removes what an older install wrote', () => {
  const settingsOf = (home: string) => join(home, '.claude', 'settings.json')
  // Bare-name deny entries the way an install before 0.6.0 wrote them for a server since retired.
  const OLD = ['mcp__plugin_buracle_old-server__upgrade', 'mcp__plugin_buracle_old-server__insight']
  const ADOPTED = 'mcp__plugin_buracle_old-server__doctor'
  const olderInstall = (items: string[]) => ({ id: 'claude', harness: 'claude' as const, ops: [{ kind: 'json-list-merge', path: join(paths.claudeDir(), 'settings.json'), pointer: 'permissions.deny', items, identity: LIST_IDENTITY_HASH, owner: 'claude', format: 'json' } as Op] })
  const retire = () => ({ id: 'claude', harness: 'claude' as const, ops: retiredDenyOps(ctxFor()) })

  test('one op on ~/.claude/settings.json with an empty list, and the install plan carries exactly that list op', async () => {
    await withSandbox(async sb => {
      expect(retiredDenyOps(ctxFor())).toEqual([{ kind: 'json-list-merge', path: settingsOf(sb.home), pointer: 'permissions.deny', items: [], identity: LIST_IDENTITY_HASH, owner: 'claude', format: 'json' }])
      const real = { ...ctxFor(), canonical: loadCanonicalSync(join(REPO, 'canonical')) }
      const plan = await claudeInstallPlan(real, { claudeBin: () => '/x/claude', bunBin: () => '/x/bun', marketplaces: async () => [], ledger: async () => ({}) })
      const lists: Op[] = plan.ops.filter(o => o.kind === 'json-list-merge')
      expect(lists).toEqual(retiredDenyOps(real))
    })
  })

  test("applied over an older install's entries: Buracle's go, the user's own and the adopted one stay, the ledger forgets the list, a second run changes nothing", async () => {
    await withSandbox(async sb => {
      const settings = settingsOf(sb.home)
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)', ADOPTED] }, theme: 'dark' }, null, 2))
      const deny = () => (JSON.parse(readFileSync(settings, 'utf8')) as { permissions: { deny: string[] } }).permissions.deny
      expect((await applyPlans([olderInstall([ADOPTED, ...OLD])])).conflicts).toEqual([])
      expect(deny()).toEqual(['Bash(rm -rf *)', ADOPTED, ...OLD])
      const r1 = await applyPlans([retire()])
      expect(r1.conflicts).toEqual([])
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ permissions: { deny: ['Bash(rm -rf *)', ADOPTED] }, theme: 'dark' })
      expect(Object.values(await readLedger()).filter(e => e.kind === 'json-list')).toEqual([])
      const r2 = await applyPlans([retire()])
      expect(r2.applied).toBe(0)
      expect(deny()).toEqual(['Bash(rm -rf *)', ADOPTED])
    })
  })

  test('a settings file that never had the entries is left alone; one where the older install created the deny list loses the empty permissions too', async () => {
    await withSandbox(async sb => {
      const settings = settingsOf(sb.home)
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      writeFileSync(settings, JSON.stringify({ theme: 'dark' }, null, 2))
      const untouched = await applyPlans([retire()])
      expect({ applied: untouched.applied, conflicts: untouched.conflicts }).toEqual({ applied: 0, conflicts: [] })
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark' })
      await applyPlans([olderInstall(OLD)])
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark', permissions: { deny: OLD } })
      await applyPlans([retire()])
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark' })
    })
  })
})

describe("the env keys Claude Code needs under Buracle (~/.claude/settings.json env)", () => {
  const settingsOf = (home: string) => join(home, '.claude', 'settings.json')
  const plan = () => ({ id: 'claude', harness: 'claude' as const, ops: envOps(ctxFor()) })

  test("applied: every key is added next to the user's own env; a value the user changed is written back with a warning and put back on uninstall", async () => {
    await withSandbox(async sb => {
      const settings = settingsOf(sb.home)
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      const original = { env: { MY_VAR: 'x', CLAUDE_CODE_NO_FLICKER: 'false' }, theme: 'dark' }
      writeFileSync(settings, JSON.stringify(original, null, 2))
      const env = () => (JSON.parse(readFileSync(settings, 'utf8')) as { env: Record<string, string> }).env
      const r1 = await applyPlans([plan()])
      expect(r1.conflicts).toEqual([])
      expect(r1.warnings.join('\n')).toContain('env.CLAUDE_CODE_NO_FLICKER')
      expect(env()).toEqual({
        MY_VAR: 'x',
        CLAUDE_CODE_NO_FLICKER: 'true',
        CLAUDE_CODE_DISABLE_1M_CONTEXT: 'false',
        CLAUDE_CODE_WORKFLOWS: 'true',
        CLAUDE_CODE_AUTO_CONNECT_IDE: 'true',
        CLAUDE_CODE_ENABLE_TODO_TOOLS: 'true',
        CLAUDE_CODE_ENABLE_TASKS: 'true',
        CLAUDE_CODE_STOP_HOOK_BLOCK_CAP: '0',
        CLAUDE_CODE_TODO_REMINDER_MODE: 'baseline',
        ENABLE_TOOL_SEARCH: 'true',
      })
      expect((await applyPlans([plan()])).applied).toBe(0)

      writeFileSync(settings, readFileSync(settings, 'utf8').replace('"CLAUDE_CODE_STOP_HOOK_BLOCK_CAP": "0"', '"CLAUDE_CODE_STOP_HOOK_BLOCK_CAP": "3"'))
      const r3 = await applyPlans([plan()])
      expect(r3.conflicts).toEqual([])
      expect(r3.warnings.join('\n')).toContain('"3"')
      expect(env()['CLAUDE_CODE_STOP_HOOK_BLOCK_CAP']).toBe('0')

      const group = composeUninstall(await readLedger(), [], emptyRecord(), paths.oldVaultRoot()).groups.find(g => g.owner === 'claude')
      expect(group).toBeDefined()
      await applyPlans([group!.content])
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual(original)
    })
  })

  test("the task-tools switch an earlier Buracle wrote as \"1\" (agents.teams) becomes \"true\" without a conflict", async () => {
    await withSandbox(async sb => {
      const settings = settingsOf(sb.home)
      mkdirSync(join(sb.home, '.claude'), { recursive: true })
      writeFileSync(settings, JSON.stringify({ theme: 'dark' }, null, 2))
      const earlier: Op = { kind: 'json-merge', path: settings, set: { 'env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS': '1', 'env.CLAUDE_CODE_ENABLE_TODO_TOOLS': '1' }, owner: 'claude', soft: ['env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'env.CLAUDE_CODE_ENABLE_TODO_TOOLS'] }
      await applyPlans([{ id: 'claude', harness: 'claude', ops: [earlier] }])
      const r = await applyPlans([{ id: 'claude', harness: 'claude', ops: [...teamsOps(ctxFor()), ...envOps(ctxFor())] }])
      expect(r.conflicts).toEqual([])
      expect(r.warnings).toEqual([])
      const env = (JSON.parse(readFileSync(settings, 'utf8')) as { env: Record<string, string> }).env
      expect(env['CLAUDE_CODE_ENABLE_TODO_TOOLS']).toBe('true')
      expect(env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']).toBe('1')
    })
  })
})

describe("Claude Code's LSP plugin recommendation: the official plugins the .lsp.json replaces are never offered", () => {
  const OFFICIAL = ['csharp-lsp', 'gopls-lsp', 'jdtls-lsp', 'pyright-lsp', 'rust-analyzer-lsp', 'typescript-lsp'].map(p => `${p}@claude-plugins-official`)
  const real = () => ({ ...ctxFor(), canonical: loadCanonicalSync(join(REPO, 'canonical')) })

  test('a list op with every lsp.replaces id and the soft switch that turns the dialog off; nothing while Claude Code has not created the file', async () => {
    await withSandbox(async sb => {
      expect(lspRecommendationPlan(real())).toBeUndefined()
      expect(existsSync(join(sb.home, '.claude.json'))).toBe(false)
      writeFileSync(join(sb.home, '.claude.json'), '{}\n')
      expect(lspRecommendationPlan(real())).toEqual({
        id: 'claude-lsp-hints', harness: 'claude',
        ops: [
          { kind: 'json-list-merge', path: join(sb.home, '.claude.json'), pointer: LSP_NEVER_KEY, items: OFFICIAL, identity: LIST_IDENTITY_HASH, owner: 'claude', format: 'json' },
          { kind: 'json-merge', path: join(sb.home, '.claude.json'), set: { [LSP_DISABLED_KEY]: true }, owner: 'claude', soft: [LSP_DISABLED_KEY] },
        ],
      })
      expect(lspRecommendationPlan(ctxFor())?.ops[0]).toMatchObject({ items: [] })
    })
  })

  test("applied: Claude Code's other keys and the user's own entries stay, idempotent; uninstall removes only Buracle's", async () => {
    await withSandbox(async sb => {
      const file = join(sb.home, '.claude.json')
      const own = ['clangd-lsp@claude-plugins-official', 'pyright-lsp@claude-plugins-official']
      writeFileSync(file, JSON.stringify({ numStartups: 7, lspRecommendationIgnoredCount: 3, lspRecommendationNeverPlugins: own }, null, 2))
      const read = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      const plan = lspRecommendationPlan(real())!
      expect((await applyPlans([plan])).conflicts).toEqual([])
      expect(read()).toEqual({ numStartups: 7, lspRecommendationIgnoredCount: 3, lspRecommendationNeverPlugins: [...own, ...OFFICIAL.filter(id => !own.includes(id))], lspRecommendationDisabled: true })
      expect((await applyPlans([plan])).applied).toBe(0)
      const group = composeUninstall(await readLedger(), [], emptyRecord(), paths.oldVaultRoot()).groups.find(g => g.owner === 'claude')
      await applyPlans([group!.content])
      expect(read()).toEqual({ numStartups: 7, lspRecommendationIgnoredCount: 3, lspRecommendationNeverPlugins: own })
    })
  })

  test("the user's lspRecommendationDisabled: false stays, before and after the install, and uninstall leaves it", async () => {
    await withSandbox(async sb => {
      const file = join(sb.home, '.claude.json')
      const read = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      writeFileSync(file, JSON.stringify({ numStartups: 2, lspRecommendationDisabled: false }, null, 2))
      const plan = lspRecommendationPlan(real())!
      expect((await applyPlans([plan])).conflicts).toEqual([])
      expect(read()['lspRecommendationDisabled']).toBe(false)
      const { [LSP_DISABLED_KEY]: _userValue, ...rest } = read()
      writeFileSync(file, JSON.stringify(rest, null, 2))
      expect((await applyPlans([plan])).conflicts).toEqual([])
      expect(read()['lspRecommendationDisabled']).toBe(true)
      writeFileSync(file, JSON.stringify({ ...read(), lspRecommendationDisabled: false }, null, 2))
      expect((await applyPlans([plan])).conflicts).toEqual([])
      expect(read()['lspRecommendationDisabled']).toBe(false)
      const group = composeUninstall(await readLedger(), [], emptyRecord(), paths.oldVaultRoot()).groups.find(g => g.owner === 'claude')
      await applyPlans([group!.content])
      expect(read()['lspRecommendationDisabled']).toBe(false)
    })
  })
})

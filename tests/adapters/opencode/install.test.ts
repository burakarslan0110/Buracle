import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildFiles } from '../../../src/adapters/opencode/build'
import { AGENTS_BLOCK_ID, CLI_SCHEMA_URL, CONFIG_SCHEMA_URL, GLOBAL_PERMISSIONS } from '../../../src/adapters/opencode/constants'
import { CLI_PERMISSIONS_KEY, configTarget, displayPath, installPlan } from '../../../src/adapters/opencode/install'
import { CM_HIDDEN_TOOLS } from '../../../src/core/context-mode'
import { jsoncParse, mdBlockGet } from '../../../src/engine/merge'
import * as paths from '../../../src/engine/paths'
import { applyPlans, rollbackTxn } from '../../../src/engine/txn'
import { fakeExe } from '../../helpers/fake-exe'
import { withSandbox } from '../../helpers/sandbox'
import { adapterContext, canonical } from './helpers'

const USER_JSONC = `{
  // my default model
  "model": "openai/gpt-5.5",
  /* my own MCP server */
  "mcp": {
    "servers": {
      "mine": { "type": "local", "command": ["my-mcp", "--stdio"] },
    },
  },
}
`

function parse(path: string): Record<string, any> {
  const r = jsoncParse(readFileSync(path, 'utf8'))
  if (!r.ok) throw new Error(r.error)
  return r.value as Record<string, any>
}

describe('opencode installPlan', () => {
  test('merges into an existing commented opencode.jsonc, installs every file and is idempotent', () => withSandbox(async ({ home, buracleHome }) => {
    const ctx = adapterContext()
    const cfgDir = paths.opencodeConfigDir()
    expect(cfgDir).toBe(join(home, '.config', 'opencode'))
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'opencode.jsonc'), USER_JSONC)
    writeFileSync(join(cfgDir, 'AGENTS.md'), '# My global rules\n\n- Answer in Turkish.\n')

    const plan = await installPlan(ctx, { opencode: null })
    expect(plan).toMatchObject({ id: 'opencode', harness: 'opencode' })
    expect(plan.ops.some(o => o.kind === 'exec')).toBe(false)
    const res = await applyPlans([plan])
    expect(res.conflicts).toEqual([])

    const text = readFileSync(join(cfgDir, 'opencode.jsonc'), 'utf8')
    expect(text).toContain('// my default model')
    expect(text).toContain('/* my own MCP server */')
    const cfg = parse(join(cfgDir, 'opencode.jsonc'))
    expect(cfg['model']).toBe('openai/gpt-5.5')
    expect(cfg['mcp']['servers']['mine']).toEqual({ type: 'local', command: ['my-mcp', '--stdio'] })
    expect(cfg['$schema']).toBe(CONFIG_SCHEMA_URL)
    expect(cfg['share']).toBe('disabled')
    expect(cfg['permissions']).toEqual([...GLOBAL_PERMISSIONS, ...CM_HIDDEN_TOOLS.map(t => ({ action: `context-mode_${t}`, resource: '*', effect: 'deny' }))])
    expect(cfg['mcp']['servers']['context7']['codemode']).toBe(false)
    expect(cfg['mcp']['servers']['buracle-memory']['command']).toEqual([ctx.buracleBin, 'mcp', 'memory'])
    expect(cfg['mcp']['servers']['context-mode']).toEqual({
      type: 'local', command: [ctx.buracleBin, 'mcp', 'run', 'context-mode'], environment: { CONTEXT_MODE_PLATFORM: 'opencode' },
      codemode: false, timeout: { startup: 60_000 },
    })
    expect(existsSync(join(cfgDir, 'opencode.json'))).toBe(false)

    const built = await buildFiles(ctx)
    for (const f of built.filter(x => x.path.startsWith('plugins/') || x.path.startsWith('agents/'))) {
      expect(readFileSync(join(cfgDir, f.path), 'utf8')).toBe(f.content)
    }
    expect(existsSync(join(cfgDir, 'commands'))).toBe(false)
    expect(JSON.parse(readFileSync(join(cfgDir, 'plugins', 'buracle', 'runtime.json'), 'utf8'))).toEqual({ v: 1, buracleHome, shim: ctx.buracleBin })
    expect(parse(join(cfgDir, 'cli.json'))).toEqual({ $schema: CLI_SCHEMA_URL, plugins: [join(cfgDir, 'plugins', 'buracle')], session: { permissions: 'autoaccept' } })

    const agentsMd = readFileSync(join(cfgDir, 'AGENTS.md'), 'utf8')
    expect(agentsMd.startsWith('# My global rules\n\n- Answer in Turkish.\n')).toBe(true)
    const block = mdBlockGet(agentsMd, AGENTS_BLOCK_ID) ?? ''
    expect(block).toContain('# Core working rules')
    for (const r of canonical().rules.filter(x => x.scope === 'paths')) {
      expect(block).toContain(`${displayPath(join(buracleHome, 'rules', 'paths'), home)}/${r.id}.md`)
    }
    expect(plan.ops.some(o => 'path' in o && o.path.startsWith(join(buracleHome, 'rules')))).toBe(false)
    expect(plan.ops.every(o => o.owner === 'opencode')).toBe(true)
    expect(existsSync(join(buracleHome, 'rules', 'paths'))).toBe(false)

    const again = await applyPlans([await installPlan(ctx, { opencode: null })])
    expect(again.conflicts).toEqual([])
    expect(again.applied).toBe(0)
  }), 60_000)

  test('permissions.bypass off: cli.json gets no session.permissions', () => withSandbox(async () => {
    const base = adapterContext()
    const ctx = { ...base, config: { ...base.config, permissions: { ...base.config.permissions, bypass: false } } }
    await applyPlans([await installPlan(ctx, { opencode: null })])
    expect(parse(join(paths.opencodeConfigDir(), 'cli.json'))['session']).toBeUndefined()
  }), 60_000)

  test('a value the user changed after install is kept and reported', () => withSandbox(async () => {
    const ctx = adapterContext()
    const cfgDir = paths.opencodeConfigDir()
    await applyPlans([await installPlan(ctx, { opencode: null })])
    const file = join(cfgDir, 'opencode.jsonc')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"share": "disabled"', '"share": "manual"'))
    const res = await applyPlans([await installPlan(ctx, { opencode: null })])
    expect(res.conflicts.some(c => c.detail.includes('share'))).toBe(true)
    expect(parse(file)['share']).toBe('manual')
  }), 60_000)

  test('targets an existing opencode.json, keeps a user plugins list in cli.json, refuses unparsable files', () => withSandbox(async () => {
    const ctx = adapterContext()
    const cfgDir = paths.opencodeConfigDir()
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'opencode.json'), '{ "model": "anthropic/claude-sonnet-4-5" }\n')
    writeFileSync(join(cfgDir, 'cli.json'), '{ "plugins": ["opencode.example"] }\n')
    writeFileSync(join(cfgDir, 'AGENTS.md'), '<!-- buracle:rules:start -->\nbroken')
    expect(configTarget(cfgDir)).toBe(join(cfgDir, 'opencode.json'))
    const res = await applyPlans([await installPlan(ctx, { opencode: null })])
    expect(existsSync(join(cfgDir, 'opencode.jsonc'))).toBe(false)
    expect(parse(join(cfgDir, 'opencode.json'))['share']).toBe('disabled')
    expect(parse(join(cfgDir, 'cli.json'))).toEqual({ plugins: ['opencode.example'], $schema: CLI_SCHEMA_URL, session: { permissions: 'autoaccept' } })
    expect(res.conflicts.some(c => c.op.kind === 'md-block')).toBe(true)
    expect(readFileSync(join(cfgDir, 'AGENTS.md'), 'utf8')).toBe('<!-- buracle:rules:start -->\nbroken')
  }), 60_000)

  test('F14: with opencode.json and opencode.jsonc both present, the user\'s opencode.json values are never overridden from the winning .jsonc', () => withSandbox(async () => {
    const ctx = adapterContext()
    const cfgDir = paths.opencodeConfigDir()
    mkdirSync(cfgDir, { recursive: true })
    const userJson = '{\n  "model": "anthropic/claude-sonnet-4-5",\n  "share": "auto",\n  "mcp": { "servers": { "context7": { "type": "local", "command": ["my-context7"] } } }\n}\n'
    writeFileSync(join(cfgDir, 'opencode.json'), userJson)
    writeFileSync(join(cfgDir, 'opencode.jsonc'), '{ "theme": "dracula" }\n')
    expect(configTarget(cfgDir)).toBe(join(cfgDir, 'opencode.jsonc'))
    const res = await applyPlans([await installPlan(ctx, { opencode: null })])
    const jsonc = parse(join(cfgDir, 'opencode.jsonc'))
    expect(jsonc['share']).toBeUndefined()
    expect((jsonc['mcp'] as { servers: Record<string, unknown> }).servers['context7']).toBeUndefined()
    expect(Object.keys((jsonc['mcp'] as { servers: Record<string, unknown> }).servers).length).toBeGreaterThan(0)
    expect(jsonc['permissions']).toBeArray()
    expect(jsonc['theme']).toBe('dracula')
    expect(readFileSync(join(cfgDir, 'opencode.json'), 'utf8')).toBe(userJson)
    const details = res.conflicts.map(c => c.detail).join('\n')
    expect(details).toContain('share')
    expect(details).toContain('context7')
    writeFileSync(join(cfgDir, 'opencode.json'), '{ "share": "disabled" }\n')
    const again = await applyPlans([await installPlan(ctx, { opencode: null })])
    expect(again.conflicts.filter(c => c.detail.includes('share'))).toEqual([])
    expect(readFileSync(join(cfgDir, 'opencode.json'), 'utf8')).toBe('{ "share": "disabled" }\n')
  }), 60_000)

  test('sets BURACLE_HOME in the service env through `opencode service set env` with an undo', () => withSandbox(async ({ root, buracleHome }) => {
    const store = join(root, 'service-env')
    const bin = fakeExe(join(root, 'bin', 'opencode'), `const store = ${JSON.stringify(store)}
const four = argv.slice(0, 4).join(' ')
if (four === 'service get env BURACLE_HOME') { if (fs.existsSync(store)) process.stdout.write(fs.readFileSync(store, 'utf8')); process.exit(0) }
if (four === 'service set env BURACLE_HOME') { fs.writeFileSync(store, argv[4] ?? ''); append(store + '.log', 'set'); process.exit(0) }
if (four === 'service unset env BURACLE_HOME') { fs.rmSync(store, { force: true }); process.exit(0) }
process.exit(1)`)
    const ctx = adapterContext()
    const old = await installPlan(ctx, { opencode: { path: bin, version: '2.0.10' } })
    expect(old.ops.some(o => o.kind === 'exec')).toBe(false)
    expect(old.cleanupKeys).toBeUndefined()
    const plan = await installPlan(ctx, { opencode: { path: bin, version: '2.0.24' } })
    const exec = plan.ops.find(o => o.kind === 'exec')
    expect(exec).toMatchObject({ argv: [bin, 'service', 'set', 'env', 'BURACLE_HOME', buracleHome], undo: [bin, 'service', 'unset', 'env', 'BURACLE_HOME'] })
    expect(plan.cleanupKeys).toEqual([{ path: join(paths.opencodeConfigDir(), 'service.json'), pointer: '' }])
    const res = await applyPlans([plan])
    expect(readFileSync(store, 'utf8')).toBe(buracleHome)
    const again = await applyPlans([await installPlan(ctx, { opencode: { path: bin, version: '2.0.24' } })])
    expect(again.skipped.some(s => s.op.kind === 'exec')).toBe(true)
    expect(readFileSync(`${store}.log`, 'utf8').trim().split('\n').length).toBe(1)
    await rollbackTxn(res.txn)
    expect(existsSync(store)).toBe(false)
  }), 60_000)

  test('files Buracle installed earlier but no longer builds are removed', () => withSandbox(async () => {
    const ctx = adapterContext()
    const cfgDir = paths.opencodeConfigDir()
    const stale = join(cfgDir, 'agents', 'old-review.md')
    await applyPlans([{ id: 'opencode', harness: 'opencode', ops: [{ kind: 'file', path: stale, content: '---\ndescription: old\n---\nold\n', owner: 'opencode' }] }])
    expect(existsSync(stale)).toBe(true)
    const plan = await installPlan(ctx, { opencode: null })
    expect(plan.ops).toContainEqual({ kind: 'remove', path: stale, owner: 'opencode' })
    await applyPlans([plan])
    expect(existsSync(stale)).toBe(false)
  }), 60_000)

  test('the command files an earlier Buracle wrote are removed (they would shadow the plugin commands); the user\'s own stay', () => withSandbox(async () => {
    const ctx = adapterContext()
    const cfgDir = paths.opencodeConfigDir()
    const ours = join(cfgDir, 'commands', 'spec.md')
    const theirs = join(cfgDir, 'commands', 'review-pr.md')
    await applyPlans([{ id: 'opencode', harness: 'opencode', ops: [{ kind: 'file', path: ours, content: '---\ndescription: "Spec"\n---\n\nRun the Buracle `spec` workflow.\n\n$ARGUMENTS\n', owner: 'opencode' }] }])
    writeFileSync(theirs, 'my own command\n')
    const plan = await installPlan(ctx, { opencode: null })
    expect(plan.ops).toContainEqual({ kind: 'remove', path: ours, owner: 'opencode' })
    const res = await applyPlans([plan])
    expect(res.conflicts).toEqual([])
    expect(existsSync(ours)).toBe(false)
    expect(readFileSync(theirs, 'utf8')).toBe('my own command\n')
  }), 60_000)

  test('permissions.enforce: a no-approval mode the user changed is written again with a warning; enforce off keeps the user\'s value', () => withSandbox(async () => {
    const base = adapterContext()
    const cfgDir = paths.opencodeConfigDir()
    mkdirSync(cfgDir, { recursive: true })
    const cli = join(cfgDir, 'cli.json')
    writeFileSync(cli, '{ "session": { "permissions": "ask" } }\n')
    const plan = await installPlan(base, { opencode: null })
    const op = plan.ops.find(o => o.kind === 'jsonc-merge' && o.path === cli)
    expect(op).toMatchObject({ enforce: [CLI_PERMISSIONS_KEY] })
    const res = await applyPlans([plan])
    expect(res.conflicts).toEqual([])
    expect(res.warnings.some(w => w.includes('session.permissions') && w.includes('"ask"'))).toBe(true)
    expect(parse(cli)['session']).toEqual({ permissions: 'autoaccept' })

    writeFileSync(cli, readFileSync(cli, 'utf8').replace('"autoaccept"', '"ask"'))
    const relaxed = { ...base, config: { ...base.config, permissions: { ...base.config.permissions, enforce: false } } }
    const plan2 = await installPlan(relaxed, { opencode: null })
    expect((plan2.ops.find(o => o.kind === 'jsonc-merge' && o.path === cli) as { enforce?: string[] }).enforce).toBeUndefined()
    const res2 = await applyPlans([plan2])
    expect(res2.conflicts.some(c => c.detail.includes('session.permissions'))).toBe(true)
    expect(parse(cli)['session']).toEqual({ permissions: 'ask' })
  }), 60_000)
})

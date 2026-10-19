import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tomlParse, yamlParse } from '../../src/engine/merge'
import { applyPlans, diffPlan, ledgerKey, listTxns, readLedger, rollbackTxn, type Ledger, type Op, type Plan } from '../../src/engine/txn'
import { snapshotTree } from '../helpers/fs-snapshot'
import { withEnv, withSandbox, type Sandbox } from '../helpers/sandbox'

const O = 'claude'

function plan(ops: Op[], id = 'p'): Plan {
  return { id, harness: 'claude', ops }
}
function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mode !== undefined) chmodSync(path, mode)
}
function read(path: string): string {
  return readFileSync(path, 'utf8')
}
function json(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>
}
function removals(led: Ledger, path: string, owner = O): Op[] {
  return Object.keys(led).filter(k => k.startsWith(`${path}#`)).map(k => ({ kind: 'remove', path: k, owner }) as Op)
}
function world(sb: Sandbox) {
  const skip = ['home/.buracle', 'home/Library']
  return snapshotTree(sb.root, rel => skip.some(s => rel === s || rel.startsWith(`${s}/`)))
}
function jsonEdit(path: string, fn: string): string[] {
  return [process.execPath, '-e', `const fs=require('fs');const p=${JSON.stringify(path)};const s=JSON.parse(fs.readFileSync(p,'utf8'));const o=(${fn});fs.writeFileSync(p,JSON.stringify(o,null,2)+'\\n')`]
}

const MODE = 'permissions.defaultMode'
const SKIP = 'skipDangerousModePermissionPrompt'
const bypass = (path: string, extra: Partial<Extract<Op, { kind: 'json-merge' }>> = {}): Op =>
  ({ kind: 'json-merge', path, set: { [MODE]: 'bypassPermissions', [SKIP]: true }, owner: O, enforce: [MODE, SKIP], ...extra })

describe('enforce: JSON keys', () => {
  test('a value the user set before Buracle is overwritten with a warning, recorded, and put back byte for byte on removal', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    const user = '{\n  "permissions": {\n    "defaultMode": "default",\n    "allow": ["Bash(ls)"]\n  },\n  "theme": "dark"\n}\n'
    write(p, user)
    const r = await applyPlans([plan([bypass(p)])])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([`${p} permissions.defaultMode: already set by the user (was "default"); wrote Buracle's value because the key is enforced`])
    expect(json(p)).toEqual({ permissions: { defaultMode: 'bypassPermissions', allow: ['Bash(ls)'] }, theme: 'dark', skipDangerousModePermissionPrompt: true })
    const led = await readLedger()
    expect(led[ledgerKey(p, MODE)]).toMatchObject({ owner: O, displaced: { value: 'default' } })
    expect(led[ledgerKey(p, MODE)]?.adopted).toBeUndefined()
    expect(led[ledgerKey(p, SKIP)]?.displaced).toBeUndefined()
    const again = await applyPlans([plan([bypass(p)])])
    expect(again).toMatchObject({ txn: '', conflicts: [], warnings: [] })
    expect((await readLedger())[ledgerKey(p, MODE)]?.displaced).toEqual({ value: 'default' })
    const u = await applyPlans([plan(removals(await readLedger(), p))])
    expect(u.conflicts).toEqual([])
    expect(read(p)).toBe(user)
    expect(await readLedger()).toEqual({})
  }))

  test('a value changed after Buracle wrote it is enforced again; removal restores the value from before Buracle', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "permissions": {\n    "defaultMode": "default"\n  }\n}\n')
    await applyPlans([plan([bypass(p)])])
    writeFileSync(p, JSON.stringify({ ...json(p), permissions: { defaultMode: 'auto' } }, null, 2) + '\n')
    const flipped = read(p)
    const plain = await applyPlans([plan([{ kind: 'json-merge', path: p, set: { [MODE]: 'bypassPermissions' }, owner: O }])])
    expect(plain.conflicts.map(c => c.detail)).toEqual([`${p} permissions.defaultMode: modified outside Buracle; keeping the user's value`])
    expect(plain.warnings).toEqual([])
    expect(read(p)).toBe(flipped)
    const r = await applyPlans([plan([bypass(p)])])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([`${p} permissions.defaultMode: modified outside Buracle (was "auto"); wrote Buracle's value because the key is enforced`])
    expect((json(p)['permissions'] as Record<string, unknown>)['defaultMode']).toBe('bypassPermissions')
    expect((await readLedger())[ledgerKey(p, MODE)]?.displaced).toEqual({ value: 'default' })
    await applyPlans([plan(removals(await readLedger(), p))])
    expect(json(p)).toEqual({ permissions: { defaultMode: 'default' } })
  }))

  test('a removed enforced key is written again; a key Buracle created is deleted on removal (with the parents it created)', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{}\n')
    expect((await applyPlans([plan([bypass(p)])])).warnings).toEqual([])
    write(p, '{\n  "permissions": {},\n  "skipDangerousModePermissionPrompt": true\n}\n')
    const plain = await applyPlans([plan([{ kind: 'json-merge', path: p, set: { [MODE]: 'bypassPermissions' }, owner: O }])])
    expect(plain.conflicts[0]?.detail).toContain('removed since Buracle installed it; not re-creating it')
    const r = await applyPlans([plan([bypass(p)])])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([`${p} permissions.defaultMode: removed since Buracle installed it; wrote Buracle's value because the key is enforced`])
    expect(json(p)).toEqual({ permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true })
    const led = await readLedger()
    expect(led[ledgerKey(p, MODE)]?.displaced).toBeUndefined()
    expect(led[ledgerKey(p, MODE)]?.created).toEqual(['permissions'])
    await applyPlans([plan(removals(led, p))])
    expect(json(p)).toEqual({})
  }))

  test('a value that equals Buracle\'s is adopted as before; the user\'s later change to it is taken over and is what removal restores', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "permissions": {\n    "defaultMode": "bypassPermissions"\n  }\n}\n')
    const op: Op = { kind: 'json-merge', path: p, set: { [MODE]: 'bypassPermissions' }, owner: O, enforce: [MODE] }
    expect((await applyPlans([plan([op])])).txn).not.toBe('')
    expect((await readLedger())[ledgerKey(p, MODE)]?.adopted).toBe(true)
    write(p, '{\n  "permissions": {\n    "defaultMode": "plan"\n  }\n}\n')
    const r = await applyPlans([plan([op])])
    expect(r.warnings).toEqual([`${p} permissions.defaultMode: set by the user before Buracle (never written by Buracle) (was "plan"); wrote Buracle's value because the key is enforced`])
    const e = (await readLedger())[ledgerKey(p, MODE)]
    expect(e?.adopted).toBeUndefined()
    expect(e?.displaced).toEqual({ value: 'plan' })
    await applyPlans([plan(removals(await readLedger(), p))])
    expect(json(p)).toEqual({ permissions: { defaultMode: 'plan' } })
  }))

  test('jsonc-merge: comments survive the overwrite and the restore', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.config', 'opencode', 'cli.json')
    const user = '{\n  // I want to confirm every edit\n  "session": { "permissions": "prompt" },\n}\n'
    write(p, user)
    const r = await applyPlans([plan([{ kind: 'jsonc-merge', path: p, set: { 'session.permissions': 'autoaccept' }, owner: 'opencode', enforce: ['session.permissions'] }])])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(read(p)).toContain('// I want to confirm every edit')
    expect(read(p)).toContain('"autoaccept"')
    await applyPlans([plan(removals(await readLedger(), p, 'opencode'))])
    expect(read(p)).toBe(user)
  }))
})

describe('enforce: YAML and TOML keys', () => {
  test('yaml-merge: overwritten in place (comment kept) and restored byte for byte', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.omp', 'agent', 'config.yml')
    const user = '# omp settings\ntools:\n  approvalMode: ask # my choice\n  bash:\n    timeout: 120\n'
    write(p, user)
    const r = await applyPlans([plan([{ kind: 'yaml-merge', path: p, set: { 'tools.approvalMode': 'yolo' }, owner: 'omp', enforce: ['tools.approvalMode'] }])])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([`${p} tools.approvalMode: already set by the user (was "ask"); wrote Buracle's value because the key is enforced`])
    expect(read(p)).toBe('# omp settings\ntools:\n  approvalMode: yolo # my choice\n  bash:\n    timeout: 120\n')
    await applyPlans([plan(removals(await readLedger(), p, 'omp'))])
    expect(read(p)).toBe(user)
  }))

  test('toml-tables keys (Codex approval_policy + sandbox_mode as one op): both taken over and restored byte for byte', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'config.toml')
    const user = '# mine\nmodel = "gpt-6.1-sol"\napproval_policy = "on-request" # careful\nsandbox_mode = "workspace-write"\n\n[mcp_servers.mine]\ncommand = "x"\n'
    write(p, user)
    const op: Op = { kind: 'toml-tables', path: p, tables: {}, keys: { approval_policy: 'never', sandbox_mode: 'danger-full-access' }, owner: 'codex', enforce: ['approval_policy', 'sandbox_mode'] }
    const r = await applyPlans([plan([op])])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([
      `${p} approval_policy: already defined by the user (was "on-request"); wrote Buracle's value because the key is enforced`,
      `${p} sandbox_mode: already defined by the user (was "workspace-write"); wrote Buracle's value because the key is enforced`,
    ])
    expect(tomlParse(read(p))).toMatchObject({ approval_policy: 'never', sandbox_mode: 'danger-full-access', model: 'gpt-6.1-sol', mcp_servers: { mine: { command: 'x' } } })
    expect(read(p)).toContain('approval_policy = "never" # careful')
    const led = await readLedger()
    expect(led[ledgerKey(p, 'approval_policy')]?.displaced).toEqual({ value: 'on-request' })
    await applyPlans([plan(removals(led, p, 'codex'))])
    expect(read(p)).toBe(user)
  }))

  test('toml-tables table: the user\'s table is replaced and comes back on removal', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'c.toml')
    write(p, 'top = 1\n\n[t]\na = 1\n')
    const r = await applyPlans([plan([{ kind: 'toml-tables', path: p, tables: { t: { b: 2 } }, owner: 'codex', enforce: ['t'] }])])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([`${p} [t]: already defined by the user (was {"a":1}); wrote Buracle's value because the key is enforced`])
    expect(tomlParse(read(p))).toEqual({ top: 1, t: { b: 2 } })
    expect((await readLedger())[ledgerKey(p, '[t]')]?.displaced).toEqual({ value: { a: 1 } })
    await applyPlans([plan(removals(await readLedger(), p, 'codex'))])
    expect(tomlParse(read(p))).toEqual({ top: 1, t: { a: 1 } })
  }))
})

describe('enforce never crosses', () => {
  test('read-only and unparsable files, YAML merge keys and aliases, and values that cannot be recorded exactly', () => withSandbox(async (sb) => {
    const h = sb.home
    const ro = join(h, 'ro', 'settings.json')
    const broken = join(h, 'broken', 'settings.json')
    const merged = join(h, 'merged', 'config.yml')
    const aliased = join(h, 'aliased', 'config.yml')
    const dated = join(h, 'dated', 'config.toml')
    write(ro, '{\n  "permissions": {\n    "defaultMode": "default"\n  }\n}\n', 0o444)
    write(broken, '{\n  "permissions": {\n    "defaultMode": "default",\n')
    write(merged, 'safe: &safe\n  approvalMode: always-ask\ntools:\n  <<: *safe\n')
    write(aliased, 'mode: &m ask\ntools:\n  approvalMode: *m\n')
    write(dated, 'approval_policy = 1979-05-27T07:32:00Z\n')
    const before = world(sb)
    const r = await applyPlans([plan([
      { kind: 'json-merge', path: ro, set: { [MODE]: 'bypassPermissions' }, owner: O, enforce: [MODE] },
      { kind: 'json-merge', path: broken, set: { [MODE]: 'bypassPermissions' }, owner: O, enforce: [MODE] },
      { kind: 'yaml-merge', path: merged, set: { 'tools.approvalMode': 'yolo' }, owner: 'omp', enforce: ['tools.approvalMode'] },
      { kind: 'yaml-merge', path: aliased, set: { 'tools.approvalMode': 'yolo' }, owner: 'omp', enforce: ['tools.approvalMode'] },
      { kind: 'toml-tables', path: dated, tables: {}, keys: { approval_policy: 'never' }, owner: 'codex', enforce: ['approval_policy'] },
    ])])
    const details = r.conflicts.map(c => c.detail)
    expect(details).toHaveLength(5)
    expect(details[0]).toMatch(/is read-only \(mode 444\); not touching it/)
    expect(details[1]).toContain('is not valid JSON')
    expect(details[2]).toContain('tools.approvalMode is inherited through a YAML merge key')
    expect(details[3]).toBe(`${aliased} tools.approvalMode: the value is a YAML alias (*m); Buracle does not override it, even for an enforced key; keeping the user's value`)
    expect(details[4]).toContain('cannot be recorded exactly')
    expect(r.warnings).toEqual([])
    expect(r.applied).toBe(0)
    expect(world(sb)).toEqual(before)
    expect(statSync(ro).mode & 0o777).toBe(0o444)
    expect(await readLedger()).toEqual({})
  }))
})

describe('enforce and the transaction safety nets', () => {
  test('a rollback gives the user\'s value and the ledger back; after a later edit only Buracle\'s key is undone', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    const user = '{\n  "permissions": {\n    "defaultMode": "default"\n  },\n  "theme": "dark"\n}\n'
    write(p, user)
    const mode = () => (json(p)['permissions'] as Record<string, unknown>)['defaultMode']
    const r = await applyPlans([plan([bypass(p)])])
    expect(mode()).toBe('bypassPermissions')
    const back = await rollbackTxn(r.txn)
    expect(back.errors).toEqual([])
    expect(read(p)).toBe(user)
    expect(await readLedger()).toEqual({})
    const r2 = await applyPlans([plan([bypass(p)])])
    expect(mode()).toBe('bypassPermissions')
    writeFileSync(p, JSON.stringify({ ...json(p), theme: 'light' }, null, 2) + '\n')
    const back2 = await rollbackTxn(r2.txn)
    expect(back2.errors).toEqual([])
    expect(json(p)).toEqual({ permissions: { defaultMode: 'default' }, theme: 'light' })
    expect(await readLedger()).toEqual({})
  }))

  test('re-enforcing a value the harness flipped can be rolled back key by key after a later edit of the file', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "permissions": {\n    "defaultMode": "default"\n  }\n}\n')
    await applyPlans([plan([bypass(p)])])
    writeFileSync(p, JSON.stringify({ ...json(p), permissions: { defaultMode: 'auto' } }, null, 2) + '\n')
    const r = await applyPlans([plan([bypass(p)])])
    expect(r.warnings).toHaveLength(1)
    writeFileSync(p, JSON.stringify({ ...json(p), theme: 'light' }, null, 2) + '\n')
    const rep = await rollbackTxn(r.txn)
    expect(rep.errors).toEqual([])
    expect(rep.skipped).toEqual([])
    expect(json(p)).toEqual({ permissions: { defaultMode: 'auto' }, skipDangerousModePermissionPrompt: true, theme: 'light' })
    expect((await readLedger())[ledgerKey(p, MODE)]?.displaced).toEqual({ value: 'default' })
  }))

  test('a rollback of the removal that restored the user\'s value gives Buracle\'s value and record back, also after a later edit', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "permissions": {\n    "defaultMode": "default"\n  }\n}\n')
    await applyPlans([plan([{ kind: 'json-merge', path: p, set: { [MODE]: 'bypassPermissions' }, owner: O, enforce: [MODE] }])])
    const installed = await readLedger()
    const u = await applyPlans([plan(removals(installed, p))])
    expect(json(p)).toEqual({ permissions: { defaultMode: 'default' } })
    await rollbackTxn(u.txn)
    expect(json(p)).toEqual({ permissions: { defaultMode: 'bypassPermissions' } })
    expect(await readLedger()).toEqual(installed)
    const u2 = await applyPlans([plan(removals(installed, p))])
    writeFileSync(p, JSON.stringify({ ...json(p), theme: 'light' }, null, 2) + '\n')
    const rep = await rollbackTxn(u2.txn)
    expect(rep.errors).toEqual([])
    expect(json(p)).toEqual({ permissions: { defaultMode: 'bypassPermissions' }, theme: 'light' })
    expect(await readLedger()).toEqual(installed)
  }))

  test('fault injection: a failure at any write of an enforcing transaction restores files and ledger exactly', async () => {
    let committedAt = 0
    for (let n = 1; n <= 12 && committedAt === 0; n++) {
      await withSandbox(async (sb) => {
        const settings = join(sb.home, '.claude', 'settings.json')
        const toml = join(sb.home, '.codex', 'config.toml')
        const yml = join(sb.home, '.omp', 'agent', 'config.yml')
        write(settings, '{\n  "permissions": {\n    "defaultMode": "default"\n  }\n}\n')
        write(toml, '# mine\napproval_policy = "on-request"\n')
        write(yml, 'tools:\n  approvalMode: ask\n')
        const ops: Op[] = [
          bypass(settings),
          { kind: 'toml-tables', path: toml, tables: {}, keys: { approval_policy: 'never', sandbox_mode: 'danger-full-access' }, owner: 'codex', enforce: ['approval_policy', 'sandbox_mode'] },
          { kind: 'yaml-merge', path: yml, set: { 'tools.approvalMode': 'yolo' }, owner: 'omp', enforce: ['tools.approvalMode'] },
        ]
        await applyPlans([plan(ops, 'first')])
        writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'auto' }, skipDangerousModePermissionPrompt: true }, null, 2) + '\n')
        writeFileSync(toml, read(toml).replace('"never"', '"untrusted"'))
        writeFileSync(yml, read(yml).replace('yolo', 'write'))
        const before = world(sb)
        const ledgerBefore = await readLedger()
        const result = await withEnv({ BURACLE_TXN_FAIL_AT: String(n) }, () => applyPlans([plan(ops)])).then(r => r, (e: Error) => e)
        if (result instanceof Error) {
          expect(result.message).toContain(`BURACLE_TXN_FAIL_AT=${n}`)
          expect(world(sb)).toEqual(before)
          expect(await readLedger()).toEqual(ledgerBefore)
          expect((await listTxns())[0]?.status).toBe('rolled-back')
          return
        }
        committedAt = n
        expect(result.conflicts).toEqual([])
        expect(result.warnings).toHaveLength(3)
        expect(tomlParse(read(toml))).toMatchObject({ approval_policy: 'never' })
        const led = await readLedger()
        expect(led[ledgerKey(settings, MODE)]?.displaced).toEqual({ value: 'default' })
        expect(led[ledgerKey(toml, 'approval_policy')]?.displaced).toEqual({ value: 'on-request' })
        expect(led[ledgerKey(yml, 'tools.approvalMode')]?.displaced).toEqual({ value: 'ask' })
        await rollbackTxn(result.txn)
        expect(world(sb)).toEqual(before)
        expect(await readLedger()).toEqual(ledgerBefore)
      })
    }
    expect(committedAt).toBe(6)
  })

  test('a removal that keeps an enforced key in place passes the check after a command rewrote that file', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "permissions": {\n    "defaultMode": "default"\n  }\n}\n')
    await applyPlans([plan([bypass(p)])])
    await applyPlans([plan([{ kind: 'json-merge', path: p, set: { [MODE]: 'default', [SKIP]: true }, owner: O, enforce: [MODE, SKIP] }])])
    expect((await readLedger())[ledgerKey(p, MODE)]?.displaced).toEqual({ value: 'default' })
    const u = await applyPlans([plan([
      ...removals(await readLedger(), p),
      { kind: 'exec', argv: jsonEdit(p, '({...s, enabledPlugins: {}})'), owner: O },
    ])])
    expect(u.conflicts).toEqual([])
    expect(u.skipped.map(s => s.reason)).toContain('kept in place: it holds the value it had before Buracle')
    expect(json(p)).toEqual({ permissions: { defaultMode: 'default' }, enabledPlugins: {} })
    expect(await readLedger()).toEqual({})
  }))

  test('dry run and diffPlan preview the overwrite and its warning without writing', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "permissions": {\n    "defaultMode": "default"\n  }\n}\n')
    const before = world(sb)
    const dry = await applyPlans([plan([bypass(p)])], { dryRun: true })
    expect(dry.warnings).toEqual([`${p} permissions.defaultMode: already set by the user (was "default"); wrote Buracle's value because the key is enforced`])
    const d = await diffPlan(plan([bypass(p)]))
    expect(d).toContain('-    "defaultMode": "default"')
    expect(d).toContain('+    "defaultMode": "bypassPermissions"')
    expect(d).toContain(`# warning: ${p} permissions.defaultMode: already set by the user (was "default")`)
    expect(world(sb)).toEqual(before)
    expect(await listTxns()).toEqual([])
  }))
})

describe('soft keys', () => {
  const EFFORT = { effortLevel: 'xhigh', 'modelSettings.claude-opus-5-5.effortLevel': 'xhigh', 'modelSettings.claude-sonnet-5-5.effortLevel': 'xhigh' }
  const effortOp = (path: string, level = 'xhigh', soft = true): Op => {
    const set = Object.fromEntries(Object.keys(EFFORT).map(k => [k, level]))
    return soft ? { kind: 'json-merge', path, set, owner: O, soft: Object.keys(EFFORT) } : { kind: 'json-merge', path, set, owner: O }
  }

  test('a value the user changed or removed is kept and skipped (never a conflict); Buracle\'s own value still updates', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "theme": "dark"\n}\n')
    expect((await applyPlans([plan([effortOp(p)])])).conflicts).toEqual([])
    expect((await readLedger())[ledgerKey(p, 'effortLevel')]?.soft).toBe(true)
    const s = json(p) as { modelSettings: Record<string, Record<string, unknown>> }
    s.modelSettings['claude-opus-5-5'] = { effortLevel: 'high' }
    delete s.modelSettings['claude-sonnet-5-5']
    writeFileSync(p, JSON.stringify(s, null, 2) + '\n')
    const edited = read(p)
    const r = await applyPlans([plan([effortOp(p)])])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.txn).toBe('')
    expect(r.skipped.map(x => x.reason).sort()).toEqual(['kept user value (modelSettings.claude-opus-5-5.effortLevel)', 'kept user value (modelSettings.claude-sonnet-5-5.effortLevel)'])
    expect(read(p)).toBe(edited)
    expect((await applyPlans([plan([effortOp(p, 'xhigh', false)])])).conflicts).toHaveLength(2)
    expect(read(p)).toBe(edited)
    const up = await applyPlans([plan([effortOp(p, 'medium')])])
    expect(up.conflicts).toEqual([])
    expect(json(p)).toMatchObject({ theme: 'dark', effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } })
    expect((json(p)['modelSettings'] as Record<string, unknown>)['claude-sonnet-5-5']).toBeUndefined()
    const u = await applyPlans([plan(removals(await readLedger(), p))])
    expect(u.conflicts).toEqual([])
    expect(u.skipped.map(x => x.reason)).toContain('kept user value (modelSettings.claude-opus-5-5.effortLevel)')
    expect(json(p)).toEqual({ theme: 'dark', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } })
    expect(await readLedger()).toEqual({})
  }))

  test('a value the user had before Buracle is kept and not recorded (YAML, TOML, a YAML merge key)', () => withSandbox(async (sb) => {
    const yml = join(sb.home, '.omp', 'agent', 'config.yml')
    const toml = join(sb.home, '.codex', 'config.toml')
    const merged = join(sb.home, 'merged.yml')
    write(yml, 'defaultThinkingLevel: medium\n')
    write(toml, 'model_reasoning_effort = "low"\n\n[agents]\ndefault_subagent_reasoning_effort = "medium"\n')
    write(merged, 'base: &b\n  defaultThinkingLevel: low\nprofile:\n  <<: *b\n')
    const before = world(sb)
    const r = await applyPlans([plan([
      { kind: 'yaml-merge', path: yml, set: { defaultThinkingLevel: 'xhigh' }, owner: 'omp', soft: ['defaultThinkingLevel'] },
      { kind: 'toml-tables', path: toml, tables: {}, keys: { model_reasoning_effort: 'xhigh', 'agents.default_subagent_reasoning_effort': 'xhigh' }, owner: 'codex', soft: ['model_reasoning_effort', 'agents.default_subagent_reasoning_effort'] },
      { kind: 'yaml-merge', path: merged, set: { 'profile.defaultThinkingLevel': 'xhigh' }, owner: 'omp', soft: ['profile.defaultThinkingLevel'] },
    ])])
    expect(r.conflicts).toEqual([])
    expect(r.skipped.map(x => x.reason)).toEqual([
      'kept user value (defaultThinkingLevel)',
      'kept user value (model_reasoning_effort)',
      'kept user value (agents.default_subagent_reasoning_effort)',
      'kept user value (profile.defaultThinkingLevel)',
    ])
    expect(world(sb)).toEqual(before)
    expect(await readLedger()).toEqual({})
  }))

  test('TOML: a soft key Buracle wrote and the user changed is kept on removal (skipped, not a conflict)', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'config.toml')
    write(p, 'model = "gpt-6.1-sol"\n')
    await applyPlans([plan([{ kind: 'toml-tables', path: p, tables: {}, keys: { model_reasoning_effort: 'xhigh' }, owner: 'codex', soft: ['model_reasoning_effort'] }])])
    writeFileSync(p, read(p).replace('"xhigh"', '"medium"'))
    const u = await applyPlans([plan(removals(await readLedger(), p, 'codex'))])
    expect(u.conflicts).toEqual([])
    expect(u.skipped.map(x => x.reason)).toEqual(['kept user value (model_reasoning_effort)'])
    expect(tomlParse(read(p))).toEqual({ model: 'gpt-6.1-sol', model_reasoning_effort: 'medium' })
    expect(await readLedger()).toEqual({})
  }))

  test('enforce and soft keys mix in one op; the rest of the op follows the plain merge law', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.omp', 'agent', 'config.yml')
    write(p, 'tools:\n  approvalMode: ask\ndefaultThinkingLevel: low\nstatusLine:\n  preset: mine\n')
    const r = await applyPlans([plan([{
      kind: 'yaml-merge', path: p, owner: 'omp',
      set: { 'tools.approvalMode': 'yolo', defaultThinkingLevel: 'xhigh', 'statusLine.preset': 'custom' },
      enforce: ['tools.approvalMode'], soft: ['defaultThinkingLevel'],
    }])])
    expect(r.warnings).toHaveLength(1)
    expect(r.skipped.map(x => x.reason)).toEqual(['kept user value (defaultThinkingLevel)'])
    expect(r.conflicts.map(c => c.detail)).toEqual([`${p} statusLine.preset: already set by the user; keeping the user's value`])
    expect(yamlParse(read(p))).toEqual({ tools: { approvalMode: 'yolo' }, defaultThinkingLevel: 'low', statusLine: { preset: 'mine' } })
  }))
})

describe('validation', () => {
  test('enforce and soft name keys the op sets, as lists, never the same key in both', () => withSandbox(async (sb) => {
    const p = join(sb.home, 's.json')
    const t = join(sb.home, 'c.toml')
    const bad: Array<[Op, RegExp]> = [
      [{ kind: 'json-merge', path: p, set: { a: 1 }, owner: O, enforce: ['b'] }, /enforce names b, which the op does not set/],
      [{ kind: 'json-merge', path: p, set: { a: 1 }, owner: O, soft: 'a' as unknown as string[] }, /soft must be a list of keys/],
      [{ kind: 'yaml-merge', path: p, set: { 'a.b': 1 }, owner: O, enforce: ['a.b'], soft: ['"a"."b"'] }, /cannot be both enforced and soft/],
      [{ kind: 'toml-tables', path: t, tables: { x: { a: 1 } }, keys: { k: 1 }, owner: O, soft: ['y'] }, /soft names y, which the op does not set/],
    ]
    for (const [op, err] of bad) await expect(applyPlans([plan([op])])).rejects.toThrow(err)
    const ok = await applyPlans([plan([
      { kind: 'json-merge', path: p, set: { 'a.b': 1 }, owner: O, enforce: ['"a".b'] },
      { kind: 'toml-tables', path: t, tables: { x: { a: 1 } }, keys: { k: 1 }, owner: O, enforce: ['x'], soft: ['k'] },
    ])])
    expect(ok.conflicts).toEqual([])
  }))
})

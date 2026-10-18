import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyPlans, diffPlan, ledgerKey, listTxns, readJournal, readLedger, rollback, rollbackTxn, txnTestHooks, type Op, type Plan } from '../../src/engine/txn'
import { jsoncParse, tomlParse, yamlParse } from '../../src/engine/merge'
import { snapshotTree } from '../helpers/fs-snapshot'
import { withEnv, withSandbox, type Sandbox } from '../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..')
const O = 'test'

function plan(ops: Op[], id = 'p'): Plan {
  return { id, harness: 'core', ops }
}
function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
function read(path: string): string {
  return readFileSync(path, 'utf8')
}
function world(sb: Sandbox) {
  const skip = ['home/.buracle', 'home/Library', 'scripts']
  return snapshotTree(sb.root, rel => skip.some(s => rel === s || rel.startsWith(`${s}/`)))
}

describe('fault injection across every op kind', () => {
  async function setup(sb: Sandbox): Promise<Plan[]> {
    const h = sb.home
    write(join(sb.root, 'dotfiles', 'opencode.jsonc'), '{\n  // mine\n  "theme": "x"\n}\n')
    mkdirSync(join(h, '.config', 'opencode'), { recursive: true })
    symlinkSync(join(sb.root, 'dotfiles', 'opencode.jsonc'), join(h, '.config', 'opencode', 'opencode.jsonc'))
    write(join(h, '.codex', 'config.toml'), '# mine\nmodel = "m"\n\n[tui]\ntheme = "dark"\n')
    write(join(h, '.omp', 'agent', 'config.yml'), '# omp\ntools:\n  approvalMode: ask\n')
    write(join(h, '.codex', 'AGENTS.md'), '# notes\n')
    await applyPlans([plan([
      { kind: 'file', path: join(h, 'owned-file.txt'), content: 'v1', owner: O },
      { kind: 'file', path: join(h, 'to-remove.txt'), content: 'bye', owner: O },
      { kind: 'symlink', path: join(h, '.local', 'bin', 'buracle'), target: '/v1', owner: O },
      { kind: 'json-merge', path: join(h, '.claude', 'settings.json'), set: { 'env.A': '1', statusLine: { type: 'command' } }, owner: O },
    ], 'base')])
    return [
      plan([
        { kind: 'json-merge', path: join(h, '.claude', 'settings.json'), set: { 'env.A': '2', 'env.B': 'x' }, owner: O },
        { kind: 'remove', path: ledgerKey(join(h, '.claude', 'settings.json'), 'statusLine'), owner: O },
        { kind: 'symlink', path: join(h, 'owned-file.txt'), target: '/now-a-link', owner: O },
        { kind: 'file', path: join(h, '.local', 'bin', 'buracle'), content: '#!/bin/sh\n', mode: 0o755, owner: O },
        { kind: 'remove', path: join(h, 'to-remove.txt'), owner: O },
      ], 'a'),
      plan([
        { kind: 'toml-tables', path: join(h, '.codex', 'config.toml'), tables: { 'mcp_servers.c7': { command: 'npx' } }, keys: { 'tui.status_line': ['model'] }, owner: O },
        { kind: 'md-block', path: join(h, '.codex', 'AGENTS.md'), id: 'buracle', content: 'rules', owner: O },
        { kind: 'jsonc-merge', path: join(h, '.config', 'opencode', 'opencode.jsonc'), set: { share: 'disabled' }, owner: O },
        { kind: 'yaml-merge', path: join(h, '.omp', 'agent', 'config.yml'), set: { 'memory.backend': 'off' }, owner: O },
        { kind: 'file', path: join(h, 'new', 'deep', 'dir', 'f.txt'), content: 'n', owner: O },
      ], 'b'),
    ]
  }

  test('a failure at any write restores files, links, dirs and the ledger exactly; a commit can be rolled back', async () => {
    let committedAt = 0
    for (let n = 1; n <= 40 && committedAt === 0; n++) {
      await withSandbox(async (sb) => {
        const plans = await setup(sb)
        const before = world(sb)
        const ledgerBefore = await readLedger()
        const attempt = withEnv({ BURACLE_TXN_FAIL_AT: String(n) }, () => applyPlans(plans))
        const result = await attempt.then(r => r, (e: Error) => e)
        if (result instanceof Error) {
          expect(result.message).toContain(`BURACLE_TXN_FAIL_AT=${n}`)
          expect(world(sb)).toEqual(before)
          expect(await readLedger()).toEqual(ledgerBefore)
          expect((await listTxns())[0]?.status).toBe('rolled-back')
          return
        }
        committedAt = n
        expect(result.conflicts).toEqual([])
        expect(readlinkSync(join(sb.home, 'owned-file.txt'))).toBe('/now-a-link')
        expect(lstatSync(join(sb.home, '.local', 'bin', 'buracle')).isFile()).toBe(true)
        expect(existsSync(join(sb.home, 'to-remove.txt'))).toBe(false)
        expect(read(join(sb.root, 'dotfiles', 'opencode.jsonc'))).toContain('"share": "disabled"')
        await rollback(result.txn)
        expect(world(sb)).toEqual(before)
        expect(await readLedger()).toEqual(ledgerBefore)
      })
    }
    expect(committedAt).toBeGreaterThan(10)
  })

  test('an exec failing at any position rolls back the files and undoes the execs before it', async () => {
    for (let k = 0; k < 3; k++) {
      await withSandbox(async (sb) => {
        const markers = [0, 1, 2].map(i => join(sb.root, `m${i}`))
        const before = world(sb)
        const execs: Op[] = markers.map((m, i): Op => (i === k
          ? { kind: 'exec', argv: ['sh', '-c', 'echo broken >&2; exit 7'], owner: O }
          : { kind: 'exec', argv: ['touch', m], undo: ['rm', '-f', m], owner: O }))
        await expect(applyPlans([plan([{ kind: 'file', path: join(sb.home, 'f.txt'), content: 'x', owner: O }, ...execs])]))
          .rejects.toThrow(/exec failed \(exit 7\)[\s\S]*broken/)
        for (const m of markers) expect(existsSync(m)).toBe(false)
        expect(world(sb)).toEqual(before)
        expect(existsSync(join(sb.buracleHome, 'state', 'owned.json'))).toBe(false)
      })
    }
  })
})

describe('inputs that must never be written', () => {
  test('unparsable JSON, JSONC, YAML, TOML and Markdown are left byte for byte, and nothing is adopted', () => withSandbox(async (sb) => {
    const h = sb.home
    const cases: Array<[Op, string]> = [
      [{ kind: 'json-merge', path: join(h, 'bom.json'), set: { a: 1 }, owner: O }, '\uFEFF{"a": 1}'],
      [{ kind: 'json-merge', path: join(h, 'tail.json'), set: { a: 1 }, owner: O }, '{"a": 1} trailing'],
      [{ kind: 'jsonc-merge', path: join(h, 'open.jsonc'), set: { a: 1 }, owner: O }, '{ "a": 1 /* never closed'],
      [{ kind: 'yaml-merge', path: join(h, 'multi.yml'), set: { a: 1 }, owner: O }, 'a: 1\n---\nb: 2\n'],
      [{ kind: 'yaml-merge', path: join(h, 'tabs.yml'), set: { a: 1 }, owner: O }, 'a:\n\tb: 1\n'],
      [{ kind: 'yaml-merge', path: join(h, 'dup.yml'), set: { a: 1 }, owner: O }, 'a: 1\na: 1\n'],
      [{ kind: 'toml-tables', path: join(h, 'dup-table.toml'), tables: { x: { a: 1 } }, owner: O }, '[t]\na = 1\n[t]\nb = 2\n'],
      [{ kind: 'toml-tables', path: join(h, 'dup-key.toml'), tables: {}, keys: { a: 1 }, owner: O }, 'a = 1\na = 1\n'],
      [{ kind: 'toml-tables', path: join(h, 'bom.toml'), tables: { x: { a: 1 } }, owner: O }, '\uFEFFa = 1\n'],
      [{ kind: 'md-block', path: join(h, 'two-starts.md'), id: 'b', content: 'y', owner: O }, '<!-- buracle:b:start -->\n<!-- buracle:b:start -->\n<!-- buracle:b:end -->\n'],
      [{ kind: 'yaml-merge', path: join(h, 'scalar.yml'), set: { a: 1 }, owner: O }, 'just a string\n'],
    ]
    for (const [op, text] of cases) write((op as { path: string }).path, text)
    const before = world(sb)
    const r = await applyPlans([plan(cases.map(([op]) => op))])
    expect(r.conflicts.length).toBe(cases.length)
    expect(r.applied).toBe(0)
    expect(r.txn).toBe('')
    expect(world(sb)).toEqual(before)
    expect(await readLedger()).toEqual({})
  }))

  test('removing keys from a file that no longer parses is refused', () => withSandbox(async (sb) => {
    const json = join(sb.home, 's.json')
    const toml = join(sb.home, 'c.toml')
    const yml = join(sb.home, 'c.yml')
    const md = join(sb.home, 'A.md')
    await applyPlans([plan([
      { kind: 'json-merge', path: json, set: { a: 1 }, owner: O },
      { kind: 'toml-tables', path: toml, tables: { t: { a: 1 } }, owner: O },
      { kind: 'yaml-merge', path: yml, set: { a: 1 }, owner: O },
      { kind: 'md-block', path: md, id: 'b', content: 'x', owner: O },
    ])])
    write(json, read(json) + ' garbage')
    write(toml, read(toml) + '[t]\n')
    write(yml, read(yml) + 'a: 2\n')
    write(md, read(md) + '<!-- buracle:b:end -->\n')
    const before = world(sb)
    const keys = Object.keys(await readLedger())
    const r = await applyPlans([plan(keys.map(k => ({ kind: 'remove', path: k, owner: O }) as Op))])
    expect(r.conflicts.length).toBe(4)
    expect(r.applied).toBe(0)
    expect(world(sb)).toEqual(before)
    expect(Object.keys(await readLedger()).sort()).toEqual([...keys].sort())
  }))

  test('a dangling symlink or a link to a directory is never written through', () => withSandbox(async (sb) => {
    const h = sb.home
    const missing = join(sb.root, 'elsewhere', 'deep')
    const links: Array<[string, Op]> = [
      ['s.json', { kind: 'json-merge', path: join(h, 'links', 's.json'), set: { a: 1 }, owner: O }],
      ['c.jsonc', { kind: 'jsonc-merge', path: join(h, 'links', 'c.jsonc'), set: { a: 1 }, owner: O }],
      ['c.yml', { kind: 'yaml-merge', path: join(h, 'links', 'c.yml'), set: { a: 1 }, owner: O }],
      ['c.toml', { kind: 'toml-tables', path: join(h, 'links', 'c.toml'), tables: { t: { a: 1 } }, owner: O }],
      ['A.md', { kind: 'md-block', path: join(h, 'links', 'A.md'), id: 'b', content: 'x', owner: O }],
      ['f.txt', { kind: 'file', path: join(h, 'links', 'f.txt'), content: 'x', owner: O }],
    ]
    mkdirSync(join(h, 'links'), { recursive: true })
    for (const [name] of links) symlinkSync(join(missing, name), join(h, 'links', name))
    mkdirSync(join(sb.root, 'a-dir'))
    symlinkSync(join(sb.root, 'a-dir'), join(h, 'links', 'to-dir.json'))
    const all = [...links.map(([, op]) => op), { kind: 'json-merge', path: join(h, 'links', 'to-dir.json'), set: { a: 1 }, owner: O } as Op]
    const before = world(sb)
    const r = await applyPlans([plan(all)])
    expect(r.conflicts.length).toBe(all.length)
    expect(r.conflicts.filter(c => /not writing through it/.test(c.detail)).length).toBe(6)
    expect(existsSync(join(sb.root, 'elsewhere'))).toBe(false)
    expect(world(sb)).toEqual(before)
  }))
})

describe('the user changes things between install and update', () => {
  test('every kind of edit is kept and reported; untouched owned items still update', () => withSandbox(async (sb) => {
    const h = sb.home
    const settings = join(h, '.claude', 'settings.json')
    const toml = join(h, '.codex', 'config.toml')
    const yml = join(h, '.omp', 'agent', 'config.yml')
    const md = join(h, '.codex', 'AGENTS.md')
    const link = join(h, '.local', 'bin', 'buracle')
    const file = join(h, '.agents', 'skills', 'plan-build', 'SKILL.md')
    const install = (v: string): Plan[] => [plan([
      { kind: 'json-merge', path: settings, set: { 'env.A': v, 'env.B': v }, owner: O },
      { kind: 'toml-tables', path: toml, tables: { 'mcp_servers.a': { v }, 'mcp_servers.b': { v } }, keys: { 'tui.x': v, 'tui.y': v }, owner: O },
      { kind: 'yaml-merge', path: yml, set: { 'k.a': v, 'k.b': v }, owner: O },
      { kind: 'md-block', path: md, id: 'one', content: v, owner: O },
      { kind: 'md-block', path: md, id: 'two', content: v, owner: O },
      { kind: 'symlink', path: link, target: `/target-${v}`, owner: O },
      { kind: 'file', path: file, content: v, owner: O },
    ])]
    expect((await applyPlans(install('1'))).conflicts).toEqual([])
    write(settings, read(settings).replace('"A": "1"', '"A": "mine"'))
    write(toml, read(toml).replace('[mcp_servers.a]\nv = "1"', '[mcp_servers.a]\nv = "1"\nextra = true').replace('x = "1"', 'x = "mine"'))
    write(yml, read(yml).replace('a: "1"', 'a: mine'))
    write(md, read(md).replace('<!-- buracle:one:start -->\n1', '<!-- buracle:one:start -->\nmine'))
    Bun.spawnSync(['ln', '-sfn', '/users-own-target', link])
    write(file, 'mine')
    const r = await applyPlans(install('2'))
    expect(r.conflicts.length).toBe(7)
    const s = JSON.parse(read(settings)) as { env: Record<string, string> }
    expect(s.env).toEqual({ A: 'mine', B: '2' })
    const t = tomlParse(read(toml)) as { mcp_servers: Record<string, unknown>, tui: Record<string, unknown> }
    expect(t.mcp_servers['a']).toEqual({ v: '1', extra: true })
    expect(t.mcp_servers['b']).toEqual({ v: '2' })
    expect(t.tui).toEqual({ x: 'mine', y: '2' })
    expect(yamlParse(read(yml))).toEqual({ k: { a: 'mine', b: '2' } })
    expect(read(md)).toContain('<!-- buracle:one:start -->\nmine\n')
    expect(read(md)).toContain('<!-- buracle:two:start -->\n2\n')
    expect(readlinkSync(link)).toBe('/users-own-target')
    expect(read(file)).toBe('mine')
  }))
})

describe('removal needs ownership proof', () => {
  test('foreign, unrecorded, other-owner and user-modified items are refused', () => withSandbox(async (sb) => {
    const h = sb.home
    const settings = join(h, 's.json')
    write(join(h, 'foreign.txt'), 'f')
    write(settings, '{"user": 1}\n')
    await applyPlans([plan([
      { kind: 'file', path: join(h, 'ours.txt'), content: 'o', owner: 'claude' },
      { kind: 'json-merge', path: settings, set: { ours: 1 }, owner: 'claude' },
    ])])
    write(join(h, 'ours.txt'), 'o + user edit')
    const before = world(sb)
    const r = await applyPlans([plan([
      { kind: 'remove', path: join(h, 'foreign.txt'), owner: 'claude' },
      { kind: 'remove', path: ledgerKey(settings, 'user'), owner: 'claude' },
      { kind: 'remove', path: ledgerKey(settings, 'ours'), owner: 'codex' },
      { kind: 'remove', path: join(h, 'ours.txt'), owner: 'claude' },
    ])])
    expect(r.conflicts.map(c => c.detail)).toEqual([
      `${join(h, 'foreign.txt')} is not recorded as owned by Buracle; not removing it`,
      `${settings}#user is not recorded as owned by Buracle; not removing it`,
      `${settings}#ours is owned by claude, not codex; not removing it`,
      `${join(h, 'ours.txt')} was modified outside Buracle; not removing it`,
    ])
    const whole = await applyPlans([plan([{ kind: 'remove', path: settings, owner: 'claude' }])])
    expect(whole.conflicts.map(c => c.detail)).toEqual([`${settings} is not recorded as owned by Buracle; not removing it`])
    expect(world(sb)).toEqual(before)
  }))

  test('values that were already there (adopted) survive uninstall; values Buracle wrote are removed', () => withSandbox(async (sb) => {
    const h = sb.home
    const json = join(h, '.config', 'opencode', 'opencode.jsonc')
    const toml = join(h, '.codex', 'config.toml')
    const md = join(h, '.codex', 'AGENTS.md')
    const file = join(h, '.agents', 'skills', 'x', 'SKILL.md')
    const link = join(h, '.local', 'bin', 'buracle')
    write(json, '{\n  "share": "disabled"\n}\n')
    write(toml, '[features]\nmemories = false\n')
    write(md, '# notes\n\n<!-- buracle:b:start -->\nsame\n<!-- buracle:b:end -->\n')
    write(file, 'same skill')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync('/shim', link)
    const before = world(sb)
    const r1 = await applyPlans([plan([
      { kind: 'jsonc-merge', path: json, set: { share: 'disabled', autoupdate: false }, owner: O },
      { kind: 'toml-tables', path: toml, tables: {}, keys: { 'features.memories': false, 'tools.update_plan.enabled': true }, owner: O },
      { kind: 'md-block', path: md, id: 'b', content: 'same', owner: O },
      { kind: 'file', path: file, content: 'same skill', owner: O },
      { kind: 'symlink', path: link, target: '/shim', owner: O },
    ])])
    expect(r1.conflicts).toEqual([])
    const led = await readLedger()
    expect(Object.values(led).filter(e => e.adopted === true).length).toBe(5)
    expect(led[ledgerKey(json, 'autoupdate')]?.adopted).toBeUndefined()
    expect(led[ledgerKey(toml, 'tools.update_plan.enabled')]?.adopted).toBeUndefined()
    const r2 = await applyPlans([plan(Object.keys(led).map(k => ({ kind: 'remove', path: k, owner: O }) as Op))])
    expect(r2.conflicts).toEqual([])
    expect(r2.applied).toBe(2)
    expect(r2.skipped.filter(s => /never wrote/.test(s.reason)).length).toBe(5)
    expect(await readLedger()).toEqual({})
    expect(world(sb)).toEqual(before)
  }))

  test('an adopted value stays the user\'s: a later Buracle change reports a conflict instead of overwriting it', () => withSandbox(async (sb) => {
    const toml = join(sb.home, '.codex', 'config.toml')
    const file = join(sb.home, '.agents', 'skills', 'x', 'SKILL.md')
    write(toml, 'approval_policy = "never" # my choice\n')
    write(file, 'v1')
    const ops = (policy: string, body: string): Op[] => [
      { kind: 'toml-tables', path: toml, tables: {}, keys: { approval_policy: policy }, owner: O },
      { kind: 'file', path: file, content: body, owner: O },
    ]
    expect((await applyPlans([plan(ops('never', 'v1'))])).conflicts).toEqual([])
    const r = await applyPlans([plan(ops('on-request', 'v2'))])
    expect(r.conflicts.map(c => c.detail)).toEqual([
      `${toml} approval_policy: set by the user before Buracle (never written by Buracle); keeping the user's version`,
      `${file} was set by the user before Buracle (never written by Buracle); keeping the user's version`,
    ])
    expect(read(toml)).toBe('approval_policy = "never" # my choice\n')
    expect(read(file)).toBe('v1')
  }))

  test('re-applying unchanged values keeps them owned (not adopted), so uninstall still removes them', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'f.txt')
    await applyPlans([plan([{ kind: 'file', path: p, content: 'x', owner: O }])])
    await applyPlans([plan([{ kind: 'file', path: p, content: 'x', owner: O }])])
    expect((await readLedger())[p]?.adopted).toBeUndefined()
    await applyPlans([plan([{ kind: 'remove', path: p, owner: O }])])
    expect(existsSync(p)).toBe(false)
  }))
})

describe('uninstalling from JSONC never breaks the file', () => {
  test('the only member of an object followed by a trailing comma and a comment', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.config', 'opencode', 'opencode.jsonc')
    write(p, '{\n  // mine\n  "theme": "x",\n  "mcp": { "servers": {} },\n}\n')
    await applyPlans([plan([{ kind: 'jsonc-merge', path: p, set: { 'mcp.servers.context7': { type: 'local' } }, owner: O }])])
    write(p, '{\n  // mine\n  "theme": "x",\n  "mcp": {\n    "servers": {\n      "context7": { "type": "local" }, // ours\n    },\n  },\n}\n')
    const r = await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, 'mcp.servers.context7'), owner: O }])])
    expect(r.conflicts).toEqual([])
    const parsed = jsoncParse(read(p))
    expect(parsed).toEqual({ ok: true, value: { theme: 'x', mcp: { servers: {} } } })
    expect(read(p)).toContain('// mine')
    expect(read(p)).toContain('// ours')
  }))

  test('parents Buracle created are removed with its key; comments of the user stay', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.config', 'opencode', 'opencode.jsonc')
    write(p, '{\n  // mine\n  "theme": "x",\n}\n')
    await applyPlans([plan([{ kind: 'jsonc-merge', path: p, set: { 'mcp.servers.context7': { type: 'local' } }, owner: O }])])
    expect((await readLedger())[ledgerKey(p, 'mcp.servers.context7')]?.created).toEqual(['mcp', 'mcp.servers'])
    write(p, '{\n  // mine\n  "theme": "x",\n  "mcp": {\n    "servers": {\n      "context7": { "type": "local" }, // ours\n    },\n  },\n}\n')
    const r = await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, 'mcp.servers.context7'), owner: O }])])
    expect(r.conflicts).toEqual([])
    expect(jsoncParse(read(p))).toEqual({ ok: true, value: { theme: 'x' } })
    expect(read(p)).toContain('// mine')
  }))
})

describe('concurrent writers', () => {
  test('a file rewritten right before its write aborts the transaction without losing that rewrite', () => withSandbox(async (sb) => {
    const first = join(sb.home, 'a.txt')
    const cj = join(sb.home, '.claude.json')
    write(cj, '{\n  "numStartups": 1\n}\n')
    const ledgerBefore = await readLedger()
    txnTestHooks.beforeWrite = (path) => {
      if (path === cj) writeFileSync(cj, '{\n  "numStartups": 2,\n  "projects": {}\n}\n')
    }
    try {
      await expect(applyPlans([plan([
        { kind: 'file', path: first, content: 'A', owner: O },
        { kind: 'json-merge', path: cj, set: { 'mcpServers.c7': { command: 'npx' } }, owner: O },
      ])])).rejects.toThrow(/changed on disk during the transaction/)
    } finally {
      txnTestHooks.beforeWrite = undefined
    }
    expect(read(cj)).toBe('{\n  "numStartups": 2,\n  "projects": {}\n}\n')
    expect(existsSync(first)).toBe(false)
    expect(await readLedger()).toEqual(ledgerBefore)
    expect((await listTxns())[0]?.status).toBe('rolled-back')
    await applyPlans([plan([{ kind: 'json-merge', path: cj, set: { 'mcpServers.c7': { command: 'npx' } }, owner: O }])])
    expect(JSON.parse(read(cj))).toEqual({ numStartups: 2, projects: {}, mcpServers: { c7: { command: 'npx' } } })
  }))

  test('a file rewritten before the backups are taken stops everything before the first write', () => withSandbox(async (sb) => {
    const cj = join(sb.home, '.claude.json')
    const other = join(sb.home, 'new.txt')
    write(cj, '{"a": 1}\n')
    txnTestHooks.afterCompute = () => writeFileSync(cj, '{"a": 2}\n')
    try {
      await expect(applyPlans([plan([
        { kind: 'file', path: other, content: 'n', owner: O },
        { kind: 'json-merge', path: cj, set: { b: 1 }, owner: O },
      ])])).rejects.toThrow(/changed on disk while the transaction was being prepared/)
    } finally {
      txnTestHooks.afterCompute = undefined
    }
    expect(read(cj)).toBe('{"a": 2}\n')
    expect(existsSync(other)).toBe(false)
    expect(await listTxns()).toEqual([])
    expect(existsSync(join(sb.buracleHome, 'backups')) ? readdirSync(join(sb.buracleHome, 'backups')) : []).toEqual([])
  }))
})

describe('a process killed in the middle of a transaction', () => {
  async function killMidway(sb: Sandbox, ops: Op[]): Promise<string> {
    const script = join(sb.root, 'scripts', 'child.ts')
    write(script, [
      `import { applyPlans } from ${JSON.stringify(join(REPO, 'src', 'engine', 'txn.ts'))}`,
      `const ops = ${JSON.stringify(ops)}`,
      `ops.push({ kind: 'exec', argv: ['sleep', '30'], undo: ['true'], owner: 'test' })`,
      `await applyPlans([{ id: 'child', harness: 'core', ops }])`,
    ].join('\n'))
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env }, stdout: 'ignore', stderr: 'ignore' })
    const journalDir = join(sb.buracleHome, 'journal')
    let txn = ''
    for (let i = 0; i < 200 && txn === ''; i++) {
      await Bun.sleep(50)
      for (const n of existsSync(journalDir) ? readdirSync(journalDir) : []) {
        if (!n.endsWith('.json')) continue
        try {
          const j = JSON.parse(read(join(journalDir, n))) as { txn: string, execs: Array<{ started?: boolean }> }
          if (j.execs[0]?.started === true) txn = j.txn
        } catch {  }
      }
    }
    child.kill('SIGKILL')
    await child.exited
    expect(txn).not.toBe('')
    expect((await readJournal(txn)).status).toBe('applying')
    return txn
  }

  const opsFor = (sb: Sandbox, v: string): Op[] => [
    { kind: 'json-merge', path: join(sb.home, '.claude', 'settings.json'), set: { statusLine: { command: v } }, owner: O },
    { kind: 'file', path: join(sb.home, '.agents', 'skills', 'a', 'SKILL.md'), content: v, owner: O },
  ]

  test('rollback() undoes the interrupted transaction', () => withSandbox(async (sb) => {
    write(join(sb.home, '.claude', 'settings.json'), '{\n  "theme": "dark"\n}\n')
    const before = world(sb)
    const txn = await killMidway(sb, opsFor(sb, 'x'))
    expect(world(sb)).not.toEqual(before)
    const report = await rollbackTxn()
    expect(report.txn).toBe(txn)
    expect(report.errors).toEqual([])
    expect(world(sb)).toEqual(before)
    expect((await readJournal(txn)).status).toBe('rolled-back')
    expect(await readLedger()).toEqual({})
  }), 30_000)

  test('the next applyPlans rolls it back first, so its half-written values are not seen as user edits', () => withSandbox(async (sb) => {
    write(join(sb.home, '.claude', 'settings.json'), '{\n  "theme": "dark"\n}\n')
    const txn = await killMidway(sb, opsFor(sb, 'x'))
    const r = await applyPlans([plan(opsFor(sb, 'y'))])
    expect(r.recovered).toEqual([txn])
    expect(r.conflicts).toEqual([])
    expect(JSON.parse(read(join(sb.home, '.claude', 'settings.json')))).toEqual({ theme: 'dark', statusLine: { command: 'y' } })
    expect(read(join(sb.home, '.agents', 'skills', 'a', 'SKILL.md'))).toBe('y')
    expect((await readJournal(txn)).status).toBe('rolled-back')
  }), 30_000)
})

describe('rollback that fails part way', () => {
  test('is marked rollback-failed and can be retried once the cause is fixed', () => withSandbox(async (sb) => {
    const f = join(sb.home, 'f.txt')
    const marker = join(sb.root, 'installed')
    const flag = join(sb.root, 'undo-allowed')
    const r = await applyPlans([plan([
      { kind: 'file', path: f, content: 'x', owner: O },
      { kind: 'exec', argv: ['touch', marker], undo: ['sh', '-c', `test -e '${flag}' && rm -f '${marker}'`], owner: O },
    ])])
    const first = await rollbackTxn(r.txn)
    expect(first.errors.length).toBe(1)
    expect(existsSync(f)).toBe(false)
    expect((await readJournal(r.txn)).status).toBe('rollback-failed')
    writeFileSync(flag, '')
    const second = await rollbackTxn()
    expect(second.txn).toBe(r.txn)
    expect(second.errors).toEqual([])
    expect(second.skipped).toEqual([])
    expect(second.undone.length).toBe(1)
    expect(existsSync(marker)).toBe(false)
    expect((await readJournal(r.txn)).status).toBe('rolled-back')
    await expect(rollback(r.txn)).rejects.toThrow(/already rolled back/)
  }))
})

describe('symlinked config directories', () => {
  test('writes go through a symlinked ~/.claude and a rollback removes only what was created', () => withSandbox(async (sb) => {
    const dot = join(sb.root, 'dotfiles', 'claude')
    write(join(dot, 'settings.json'), '{}\n')
    symlinkSync(dot, join(sb.home, '.claude'))
    const before = world(sb)
    const r = await applyPlans([plan([
      { kind: 'file', path: join(sb.home, '.claude', 'rules', 'buracle', 'core.md'), content: '# core\n', owner: O },
      { kind: 'json-merge', path: join(sb.home, '.claude', 'settings.json'), set: { a: 1 }, owner: O },
    ])])
    expect(read(join(dot, 'rules', 'buracle', 'core.md'))).toBe('# core\n')
    expect(lstatSync(join(sb.home, '.claude')).isSymbolicLink()).toBe(true)
    await rollback(r.txn)
    expect(world(sb)).toEqual(before)
    expect(existsSync(join(dot, 'rules'))).toBe(false)
  }))
})

describe('dry run', () => {
  test('reports dangling links and unparsable files as conflicts without touching them', () => withSandbox(async (sb) => {
    const link = join(sb.home, 'l.json')
    symlinkSync(join(sb.root, 'nowhere.json'), link)
    write(join(sb.home, 'bad.toml'), '[x\n')
    const p = plan([
      { kind: 'json-merge', path: link, set: { a: 1 }, owner: O },
      { kind: 'toml-tables', path: join(sb.home, 'bad.toml'), tables: { t: { a: 1 } }, owner: O },
    ])
    const before = world(sb)
    const r = await applyPlans([p], { dryRun: true })
    expect(r.conflicts.length).toBe(2)
    const d = await diffPlan(p)
    expect(d).toContain('not writing through it')
    expect(d).toContain('is not valid TOML')
    expect(world(sb)).toEqual(before)
  }))
})

describe('a symlink whose target this transaction already changed', () => {
  test('unlinking or replacing such a link works in any op order, and rolls back exactly', () => withSandbox(async (sb) => {
    const target = join(sb.home, 'repo', 'SKILL.md')
    const link = join(sb.home, '.agents', 'skills', 'plan-build')
    const other = join(sb.home, 'repo', 'OTHER.md')
    await applyPlans([plan([
      { kind: 'file', path: target, content: 'skill\n', owner: O },
      { kind: 'file', path: other, content: 'other\n', owner: O },
      { kind: 'symlink', path: link, target, owner: O },
    ])])
    const before = world(sb)
    const r = await applyPlans([plan([{ kind: 'remove', path: target, owner: O }, { kind: 'remove', path: link, owner: O }])])
    expect(r).toMatchObject({ applied: 2, conflicts: [] })
    expect(existsSync(target)).toBe(false)
    expect(() => lstatSync(link)).toThrow()
    const j = await readJournal(r.txn)
    expect(j.files.find(f => f.path === link)?.before).toEqual({ type: 'symlink', target })
    await rollbackTxn(r.txn)
    expect(world(sb)).toEqual(before)
    expect(read(link)).toBe('skill\n')

    const r2 = await applyPlans([plan([{ kind: 'remove', path: target, owner: O }, { kind: 'symlink', path: link, target: other, owner: O }])])
    expect(r2.conflicts).toEqual([])
    expect(readlinkSync(link)).toBe(other)
    await rollbackTxn(r2.txn)
    expect(world(sb)).toEqual(before)
  }))

  test('a link re-pointed by someone else mid-transaction still aborts it', () => withSandbox(async (sb) => {
    const target = join(sb.home, 'repo', 'SKILL.md')
    const link = join(sb.home, '.agents', 'skills', 'plan-build')
    await applyPlans([plan([{ kind: 'file', path: target, content: 'skill\n', owner: O }, { kind: 'symlink', path: link, target, owner: O }])])
    txnTestHooks.beforeWrite = (p: string) => {
      if (p !== link) return
      Bun.spawnSync(['rm', link])
      symlinkSync(join(sb.home, 'elsewhere'), link)
    }
    try {
      await expect(applyPlans([plan([{ kind: 'remove', path: target, owner: O }, { kind: 'remove', path: link, owner: O }])])).rejects.toThrow(/changed on disk during the transaction/)
    } finally {
      delete txnTestHooks.beforeWrite
    }
    expect(readlinkSync(link)).toBe(join(sb.home, 'elsewhere'))
    expect(read(target)).toBe('skill\n')
  }))
})

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'
import { applyPlans, diffPlan, ledgerKey, listTxns, markExecsUndone, readJournal, readLedger, rollback, rollbackTxn, TXN_STEPS, type Op, type Plan } from '../../src/engine/txn'
import { tomlParse } from '../../src/engine/merge'
import { snapshotTree } from '../helpers/fs-snapshot'
import { KEEPS_MODES } from '../helpers/fake-exe'
import { withEnv, withSandbox, type Sandbox } from '../helpers/sandbox'

const OWNER = 'test'

function plan(ops: Op[], id = 'p'): Plan {
  return { id, harness: 'core', ops }
}

function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mode !== undefined) chmodSync(path, mode)
}

// The path a link target names: Windows reports a rooted target ('/x') on the current drive, with backslashes.
function onDisk(target: string): string {
  return process.platform === 'win32' ? win32.resolve(target).toLowerCase() : target
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function userTree(sb: Sandbox) {
  return snapshotTree(sb.home, rel => rel === '.buracle' || rel.startsWith('.buracle/') || rel === 'Library' || rel.startsWith('Library/'))
}

describe('file ops and the merge law', () => {
  test('create → unchanged → update; ledger and journal are recorded', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.agents', 'skills', 'demo', 'SKILL.md')
    const r1 = await applyPlans([plan([{ kind: 'file', path: p, content: 'v1\n', owner: OWNER }])])
    expect(r1.applied).toBe(1)
    expect(r1.conflicts).toEqual([])
    expect(r1.txn).not.toBe('')
    expect(read(p)).toBe('v1\n')
    if (KEEPS_MODES) expect(statSync(p).mode & 0o777).toBe(0o644)
    const led = await readLedger()
    expect(led[p]).toMatchObject({ owner: OWNER, path: p, kind: 'file' })
    const j = await readJournal(r1.txn)
    expect(j.status).toBe('committed')
    expect(j.files.map(f => f.path)).toEqual([p])
    expect(existsSync(join(sb.buracleHome, 'backups', r1.txn))).toBe(true)

    const r2 = await applyPlans([plan([{ kind: 'file', path: p, content: 'v1\n', owner: OWNER }])])
    expect(r2).toEqual({ txn: '', applied: 0, skipped: [{ op: { kind: 'file', path: p, content: 'v1\n', owner: OWNER }, reason: 'unchanged' }], conflicts: [], warnings: [] })

    const r3 = await applyPlans([plan([{ kind: 'file', path: p, content: 'v2\n', mode: 0o755, owner: OWNER }])])
    expect(r3.applied).toBe(1)
    expect(read(p)).toBe('v2\n')
    if (KEEPS_MODES) expect(statSync(p).mode & 0o777).toBe(0o755)
  }))

  test('a user-modified file is kept and reported as a conflict', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'agents', 'review.toml')
    const other = join(sb.home, '.codex', 'agents', 'other.toml')
    await applyPlans([plan([{ kind: 'file', path: p, content: 'ours = 1\n', owner: OWNER }])])
    write(p, 'ours = 1\nmine = 2\n')
    const r = await applyPlans([plan([
      { kind: 'file', path: p, content: 'ours = 2\n', owner: OWNER },
      { kind: 'file', path: other, content: 'x = 1\n', owner: OWNER },
    ])])
    expect(read(p)).toBe('ours = 1\nmine = 2\n')
    expect(r.conflicts.length).toBe(1)
    expect(r.conflicts[0]?.detail).toContain('modified outside Buracle')
    expect(r.applied).toBe(1)
    expect(read(other)).toBe('x = 1\n')
  }))

  test('a pre-existing user file is never overwritten; identical content is adopted', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'rules', 'buracle', 'core.md')
    write(p, 'user text\n')
    const r = await applyPlans([plan([{ kind: 'file', path: p, content: 'ours\n', owner: OWNER }])])
    expect(r.conflicts[0]?.detail).toContain('not owned by Buracle')
    expect(read(p)).toBe('user text\n')

    const q = join(sb.home, '.claude', 'rules', 'buracle', 'same.md')
    write(q, 'same\n')
    const r2 = await applyPlans([plan([{ kind: 'file', path: q, content: 'same\n', owner: OWNER }])])
    expect(r2.skipped.map(s => s.reason)).toEqual(['unchanged'])
    expect((await readLedger())[q]?.owner).toBe(OWNER)
  }))

  test('an owned file the user deleted stays deleted (reported); restore puts it back', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'x', 'f.txt')
    await applyPlans([plan([{ kind: 'file', path: p, content: 'a', owner: OWNER }])])
    Bun.spawnSync(['rm', p])
    const r = await applyPlans([plan([{ kind: 'file', path: p, content: 'a', owner: OWNER }])])
    expect(r.applied).toBe(0)
    expect(r.conflicts.map(c => c.detail)).toEqual([`${p}: removed since Buracle installed it; not re-creating it (run \`buracle install\` in a terminal to put it back)`])
    expect(r.conflicts.map(c => c.removed)).toEqual([true])
    expect(existsSync(p)).toBe(false)
    expect((await readLedger())[p]?.owner).toBe(OWNER)
    expect((await applyPlans([plan([{ kind: 'file', path: p, content: 'a', owner: OWNER }])])).conflicts.length).toBe(1)
    const back = await applyPlans([plan([{ kind: 'file', path: p, content: 'a', owner: OWNER }])], { restore: true })
    expect(back.applied).toBe(1)
    expect(read(p)).toBe('a')
  }))
})

describe('structured merges', () => {
  test('json-merge: first install keeps user values, later updates follow the ledger per key', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "statusLine": { "type": "command", "command": "mine" },\n  "theme": "dark"\n}\n')
    const r1 = await applyPlans([plan([{ kind: 'json-merge', path: p, owner: OWNER, set: {
      statusLine: { type: 'command', command: '/b/buracle statusline claude' },
      'env.BURACLE': '1',
    } }])])
    expect(r1.conflicts.map(c => c.detail)).toEqual([`${p} statusLine: already set by the user; keeping the user's value`])
    const v1 = JSON.parse(read(p)) as Record<string, unknown>
    expect(v1['statusLine']).toEqual({ type: 'command', command: 'mine' })
    expect(v1['env']).toEqual({ BURACLE: '1' })
    expect(v1['theme']).toBe('dark')

    await applyPlans([plan([{ kind: 'json-merge', path: p, owner: OWNER, set: { 'env.BURACLE': '2' } }])])
    expect((JSON.parse(read(p)) as { env: unknown }).env).toEqual({ BURACLE: '2' })
    write(p, read(p).replace('"2"', '"user"'))
    const r3 = await applyPlans([plan([{ kind: 'json-merge', path: p, owner: OWNER, set: { 'env.BURACLE': '3', 'env.OTHER': 'x' } }])])
    expect(r3.conflicts.length).toBe(1)
    expect((JSON.parse(read(p)) as { env: unknown }).env).toEqual({ BURACLE: 'user', OTHER: 'x' })
  }))

  test('unparsable files are never overwritten', () => withSandbox(async (sb) => {
    const cases: Array<[Op, string]> = [
      [{ kind: 'json-merge', path: join(sb.home, 'a.json'), set: { a: 1 }, owner: OWNER }, '{"broken": '],
      [{ kind: 'json-merge', path: join(sb.home, 'c.json'), set: { a: 1 }, owner: OWNER }, '{ // comments are not JSON\n "x": 1 }'],
      [{ kind: 'jsonc-merge', path: join(sb.home, 'b.jsonc'), set: { a: 1 }, owner: OWNER }, '{ "a": [ }'],
      [{ kind: 'yaml-merge', path: join(sb.home, 'c.yml'), set: { a: 1 }, owner: OWNER }, 'a: [1, 2\nb: 3\n'],
      [{ kind: 'toml-tables', path: join(sb.home, 'd.toml'), tables: { t: { a: 1 } }, owner: OWNER }, '[t\na = 1\n'],
      [{ kind: 'md-block', path: join(sb.home, 'e.md'), id: 'x', content: 'y', owner: OWNER }, '<!-- buracle:x:start -->\nno end\n'],
      [{ kind: 'json-merge', path: join(sb.home, 'f.json'), set: { a: 1 }, owner: OWNER }, '[1, 2]'],
    ]
    for (const [op, text] of cases) write((op as { path: string }).path, text)
    const before = userTree(sb)
    const r = await applyPlans([plan(cases.map(([op]) => op))])
    expect(r.conflicts.length).toBe(cases.length)
    expect(r.applied).toBe(0)
    expect(r.txn).toBe('')
    expect(userTree(sb)).toEqual(before)
  }))

  test('jsonc-merge preserves comments; yaml-merge preserves comments', () => withSandbox(async (sb) => {
    const oc = join(sb.home, '.config', 'opencode', 'opencode.jsonc')
    write(oc, '{\n  // my theme\n  "theme": "tokyo",\n}\n')
    const omp = join(sb.home, '.omp', 'agent', 'config.yml')
    write(omp, '# my omp\ntools:\n  approvalMode: ask # was ask\n')
    const r = await applyPlans([plan([
      { kind: 'jsonc-merge', path: oc, owner: OWNER, set: { '$schema': 'https://opencode.ai/config.json', 'mcp.servers.context7.codemode': false } },
      { kind: 'yaml-merge', path: omp, owner: OWNER, set: { 'memory.backend': 'off', 'statusLine.preset': 'custom' } },
    ])])
    expect(r.conflicts).toEqual([])
    expect(r.applied).toBe(2)
    expect(read(oc)).toContain('// my theme')
    expect(read(oc)).toContain('"codemode": false')
    expect(read(omp)).toContain('# my omp')
    expect(read(omp)).toContain('approvalMode: ask # was ask')
    expect(read(omp)).toContain('backend: off')
  }))

  test('toml-tables: surgical, baseline-tracked and conflict-aware', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'config.toml')
    const user = '# my codex\nmodel = "gpt-6.1-sol"\n\n[mcp_servers.mine]\ncommand = "x"\n'
    write(p, user)
    const op = (cmd: string): Op => ({ kind: 'toml-tables', path: p, owner: 'codex', tables: { 'mcp_servers.context7': { command: cmd, args: ['-y'] } }, keys: { 'tools.update_plan.enabled': true } })
    const r1 = await applyPlans([plan([op('npx')])])
    expect(r1.applied).toBe(1)
    expect(read(p)).toBe('# my codex\nmodel = "gpt-6.1-sol"\ntools.update_plan.enabled = true\n\n[mcp_servers.mine]\ncommand = "x"\n\n[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y"]\n')
    expect(tomlParse(read(p))).toMatchObject({ model: 'gpt-6.1-sol', mcp_servers: { mine: { command: 'x' }, context7: { command: 'npx', args: ['-y'] } }, tools: { update_plan: { enabled: true } } })
    const led = await readLedger()
    expect(led[ledgerKey(p, '[mcp_servers.context7]')]?.kind).toBe('toml-table')
    expect(led[ledgerKey(p, 'tools.update_plan.enabled')]?.kind).toBe('toml-key')

    expect((await applyPlans([plan([op('npx')])])).txn).toBe('')
    await applyPlans([plan([op('bunx')])])
    expect(tomlParse(read(p))).toMatchObject({ mcp_servers: { context7: { command: 'bunx' } } })

    write(p, 'model = "gpt-6.1-sol"\n[mcp_servers.mine]\ncommand = "x"\n[mcp_servers.context7]\nargs = ["-y"]\ncommand = "bunx"\n[tools.update_plan]\nenabled = true\n')
    expect((await applyPlans([plan([op('npx')])])).conflicts).toEqual([])
    write(p, read(p).replace('command = "npx"', 'command = "custom"'))
    const r5 = await applyPlans([plan([op('npx2')])])
    expect(r5.conflicts.length).toBe(1)
    expect(read(p)).toContain('command = "custom"')
  }))

  test('md-block: inserted, updated, and user edits respected', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'AGENTS.md')
    write(p, '# My notes\n')
    await applyPlans([plan([{ kind: 'md-block', path: p, id: 'buracle', content: 'rules v1', owner: OWNER }])])
    expect(read(p)).toBe('# My notes\n\n<!-- buracle:buracle:start -->\nrules v1\n<!-- buracle:buracle:end -->\n')
    await applyPlans([plan([{ kind: 'md-block', path: p, id: 'buracle', content: 'rules v2\n', owner: OWNER }])])
    expect(read(p)).toContain('rules v2\n<!-- buracle:buracle:end -->')
    write(p, read(p).replace('rules v2', 'rules v2 + my tweak'))
    const r = await applyPlans([plan([{ kind: 'md-block', path: p, id: 'buracle', content: 'rules v3', owner: OWNER }])])
    expect(r.conflicts.length).toBe(1)
    expect(read(p)).toContain('my tweak')
  }))

  test('merges through a symlinked config file keep the link', () => withSandbox(async (sb) => {
    const real = join(sb.root, 'dotfiles', 'settings.json')
    write(real, '{"a": 1}\n')
    const link = join(sb.home, '.claude', 'settings.json')
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(real, link)
    const r = await applyPlans([plan([{ kind: 'json-merge', path: link, set: { b: 2 }, owner: OWNER }])])
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(JSON.parse(read(real))).toEqual({ a: 1, b: 2 })
    await rollback(r.txn)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(read(real)).toBe('{"a": 1}\n')
  }))
})

describe('symlink and remove ops', () => {
  test('symlinks are created, kept and never replace user files', () => withSandbox(async (sb) => {
    const link = join(sb.home, '.local', 'bin', 'buracle')
    const target = join(sb.buracleHome, 'bin', 'buracle')
    const r1 = await applyPlans([plan([{ kind: 'symlink', path: link, target, owner: OWNER }])])
    expect(r1.applied).toBe(1)
    expect(readlinkSync(link)).toBe(target)
    expect((await applyPlans([plan([{ kind: 'symlink', path: link, target, owner: OWNER }])])).txn).toBe('')
    await applyPlans([plan([{ kind: 'symlink', path: link, target: '/elsewhere', owner: OWNER }])])
    expect(onDisk(readlinkSync(link))).toBe(onDisk('/elsewhere'))

    const userFile = join(sb.home, '.local', 'bin', 'tool')
    write(userFile, '#!/bin/sh\n')
    const r2 = await applyPlans([plan([{ kind: 'symlink', path: userFile, target, owner: OWNER }])])
    expect(r2.conflicts.length).toBe(1)
    expect(lstatSync(userFile).isFile()).toBe(true)
  }))

  test('remove only what the ledger proves is ours and unchanged', () => withSandbox(async (sb) => {
    const owned = join(sb.home, 'o.txt')
    const edited = join(sb.home, 'e.txt')
    const foreign = join(sb.home, 'f.txt')
    await applyPlans([plan([
      { kind: 'file', path: owned, content: 'o', owner: OWNER },
      { kind: 'file', path: edited, content: 'e', owner: OWNER },
    ])])
    write(edited, 'e + user')
    write(foreign, 'f')
    const r = await applyPlans([plan([
      { kind: 'remove', path: owned, owner: OWNER },
      { kind: 'remove', path: edited, owner: OWNER },
      { kind: 'remove', path: foreign, owner: OWNER },
      { kind: 'remove', path: join(sb.home, 'never-existed'), owner: OWNER },
    ])])
    expect(existsSync(owned)).toBe(false)
    expect(read(edited)).toBe('e + user')
    expect(read(foreign)).toBe('f')
    expect(r.applied).toBe(1)
    expect(r.conflicts.length).toBe(2)
    expect(r.skipped.map(s => s.reason)).toEqual(['absent'])
    const led = await readLedger()
    expect(led[owned]).toBeUndefined()
    expect(led[edited]).toBeDefined()
  }))

  test('remove by pointer: JSON key, TOML table and Markdown block', () => withSandbox(async (sb) => {
    const json = join(sb.home, 's.json')
    const toml = join(sb.home, 'c.toml')
    const md = join(sb.home, 'A.md')
    write(json, '{\n  "user": true\n}\n')
    write(toml, '# keep\n[user]\nx = 1\n')
    write(md, '# keep\n')
    const before = userTree(sb)
    await applyPlans([plan([
      { kind: 'json-merge', path: json, set: { 'hooks.Stop': ['b'] }, owner: 'h' },
      { kind: 'toml-tables', path: toml, tables: { 'mcp_servers.x': { command: 'c' } }, owner: 'h' },
      { kind: 'md-block', path: md, id: 'b', content: 'block', owner: 'h' },
    ])])
    const led = await readLedger()
    const keys = Object.keys(led).filter(k => led[k]?.owner === 'h').sort()
    expect(keys).toEqual([ledgerKey(md, 'md:b'), ledgerKey(toml, '[mcp_servers.x]'), ledgerKey(json, 'hooks.Stop')].sort())
    const denied = await applyPlans([plan(keys.map(k => ({ kind: 'remove', path: k, owner: 'other' }) as Op))])
    expect(denied.conflicts.length).toBe(3)
    const r = await applyPlans([plan(keys.map(k => ({ kind: 'remove', path: k, owner: 'h' }) as Op))])
    expect(r.applied).toBe(3)
    expect(read(json)).toBe('{\n  "user": true\n}\n')
    expect(read(toml)).toBe('# keep\n[user]\nx = 1\n')
    expect(read(md)).toBe('# keep\n')
    expect(Object.keys(await readLedger()).filter(k => k.includes('#'))).toEqual([])
    expect(userTree(sb)[ 'A.md']).toBe(before['A.md'])
  }))
})

describe('rollback', () => {
  test('rollback(txn) restores every file, removes created ones and reverts the ledger', () => withSandbox(async (sb) => {
    const settings = join(sb.home, '.claude', 'settings.json')
    const agents = join(sb.home, '.codex', 'AGENTS.md')
    write(settings, '{"theme": "dark"}\n')
    write(agents, '# mine\n', 0o600)
    const before = userTree(sb)
    const ledgerBefore = await readLedger()
    const r = await applyPlans([plan([
      { kind: 'json-merge', path: settings, set: { statusLine: { type: 'command' } }, owner: OWNER },
      { kind: 'md-block', path: agents, id: 'buracle', content: 'x', owner: OWNER },
      { kind: 'file', path: join(sb.home, '.agents', 'skills', 'new', 'SKILL.md'), content: 'n', owner: OWNER },
      { kind: 'symlink', path: join(sb.home, '.local', 'bin', 'buracle'), target: '/x', owner: OWNER },
    ])])
    expect(userTree(sb)).not.toEqual(before)
    await rollback(r.txn)
    expect(userTree(sb)).toEqual(before)
    expect(await readLedger()).toEqual(ledgerBefore)
    expect((await readJournal(r.txn)).status).toBe('rolled-back')
    await expect(rollback(r.txn)).rejects.toThrow(/already rolled back/)
  }))

  test('rollback() without an id undoes the latest committed transaction only', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'f.txt')
    const r1 = await applyPlans([plan([{ kind: 'file', path: p, content: '1', owner: OWNER }])])
    await Bun.sleep(5)
    const r2 = await applyPlans([plan([{ kind: 'file', path: p, content: '2', owner: OWNER }])])
    expect((await listTxns()).map(j => j.txn)).toEqual([r2.txn, r1.txn])
    await rollback()
    expect(read(p)).toBe('1')
    await rollback()
    expect(existsSync(p)).toBe(false)
    await expect(rollback()).rejects.toThrow(/no committed transaction/)
  }))

  test('paths changed after the transaction are left alone (partial rollback)', () => withSandbox(async (sb) => {
    const a = join(sb.home, 'a.txt')
    const b = join(sb.home, 'b.txt')
    const r = await applyPlans([plan([
      { kind: 'file', path: a, content: 'A', owner: OWNER },
      { kind: 'file', path: b, content: 'B', owner: OWNER },
    ])])
    write(b, 'B edited later')
    const report = await rollbackTxn(r.txn)
    expect(report.restored).toEqual([a])
    expect(report.skipped.map(s => s.path)).toEqual([b])
    expect(existsSync(a)).toBe(false)
    expect(read(b)).toBe('B edited later')
    expect((await readLedger())[b]).toBeDefined()
    expect((await readLedger())[a]).toBeUndefined()
  }))

  test('unknown transaction ids are rejected', () => withSandbox(async () => {
    await expect(rollback('20990101T000000000Z-abcdef')).rejects.toThrow(/unknown transaction/)
    await expect(rollback('../../etc')).rejects.toThrow(/invalid transaction id/)
  }))
})

describe('fault injection (BURACLE_TXN_FAIL_AT)', () => {
  const build = (sb: Sandbox): Plan[] => {
    write(join(sb.home, '.claude', 'settings.json'), '{\n  "theme": "dark"\n}\n')
    write(join(sb.home, '.codex', 'config.toml'), '# mine\nmodel = "m"\n')
    write(join(sb.home, '.codex', 'AGENTS.md'), '# notes\n')
    const old = join(sb.home, '.local', 'bin', 'buracle')
    mkdirSync(dirname(old), { recursive: true })
    symlinkSync('/old/target', old)
    return [
      plan([
        { kind: 'json-merge', path: join(sb.home, '.claude', 'settings.json'), set: { statusLine: { command: 'x' } }, owner: OWNER },
        { kind: 'file', path: join(sb.home, '.claude', 'rules', 'buracle', 'core.md'), content: '# core\n', owner: OWNER },
      ], 'claude'),
      plan([
        { kind: 'toml-tables', path: join(sb.home, '.codex', 'config.toml'), tables: { 'mcp_servers.c7': { command: 'npx' } }, owner: OWNER },
        { kind: 'md-block', path: join(sb.home, '.codex', 'AGENTS.md'), id: 'buracle', content: 'rules', owner: OWNER },
        { kind: 'file', path: join(sb.home, '.agents', 'skills', 'plan-build', 'SKILL.md'), content: 'skill', mode: 0o600, owner: OWNER },
      ], 'codex'),
    ]
  }

  test('every write position rolls the whole transaction back', async () => {
    for (let n = 1; n <= 8; n++) {
      await withSandbox(async (sb) => {
        const plans = build(sb)
        const before = userTree(sb)
        const result = withEnv({ BURACLE_TXN_FAIL_AT: String(n) }, () => applyPlans(plans))
        if (n <= 7) {
          await expect(result).rejects.toThrow(new RegExp(`rolled back: BURACLE_TXN_FAIL_AT=${n}`))
          expect(userTree(sb)).toEqual(before)
          expect(existsSync(join(sb.buracleHome, 'state', 'owned.json'))).toBe(false)
          const [j] = await listTxns()
          expect(j?.status).toBe('rolled-back')
          expect(existsSync(join(sb.home, '.agents'))).toBe(false)
          expect(existsSync(join(sb.home, '.claude', 'rules'))).toBe(false)
        } else {
          const r = await result
          expect(r.applied).toBe(5)
          expect(userTree(sb)).not.toEqual(before)
        }
      })
    }
  })

  test('a failure while replacing a symlink restores it', () => withSandbox(async (sb) => {
    const link = join(sb.home, '.local', 'bin', 'buracle')
    await applyPlans([plan([{ kind: 'symlink', path: link, target: '/v1', owner: OWNER }])])
    const before = userTree(sb)
    for (const n of [1, 2]) {
      await expect(withEnv({ BURACLE_TXN_FAIL_AT: String(n) }, () => applyPlans([plan([{ kind: 'symlink', path: link, target: '/v2', owner: OWNER }])]))).rejects.toThrow(/rolled back/)
      expect(userTree(sb)).toEqual(before)
    }
  }))

  test('the ledger is restored when a failure follows the ledger write', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'one.txt')
    await applyPlans([plan([{ kind: 'file', path: p, content: '1', owner: OWNER }])])
    const ledgerBefore = await readLedger()
    for (const n of ['2', '3']) {
      await expect(withEnv({ BURACLE_TXN_FAIL_AT: n }, () => applyPlans([plan([{ kind: 'file', path: p, content: '2', owner: OWNER }])]))).rejects.toThrow(/rolled back/)
      expect(read(p)).toBe('1')
      expect(await readLedger()).toEqual(ledgerBefore)
    }
  }))
})

describe('exec ops', () => {
  test('a failing exec rolls back files and undoes earlier execs', () => withSandbox(async (sb) => {
    const marker = join(sb.root, 'marker')
    const f = join(sb.home, 'file.txt')
    const before = userTree(sb)
    await expect(applyPlans([plan([
      { kind: 'file', path: f, content: 'x', owner: OWNER },
      { kind: 'exec', argv: ['touch', marker], undo: ['rm', '-f', marker], owner: OWNER },
      { kind: 'exec', argv: ['sh', '-c', 'echo nope >&2; exit 3'], owner: OWNER },
    ])])).rejects.toThrow(/exec failed \(exit 3\)[\s\S]*nope/)
    expect(existsSync(marker)).toBe(false)
    expect(userTree(sb)).toEqual(before)
  }))

  test('idempotent checks skip work; successful execs are undone by rollback', () => withSandbox(async (sb) => {
    const marker = join(sb.root, 'installed')
    const op: Op = { kind: 'exec', argv: ['touch', marker], undo: ['rm', '-f', marker], idempotentCheck: ['test', '-e', marker], owner: OWNER }
    const r1 = await applyPlans([plan([op])])
    expect(r1.applied).toBe(1)
    expect(existsSync(marker)).toBe(true)
    const r2 = await applyPlans([plan([op])])
    expect(r2.txn).toBe('')
    expect(r2.skipped.map(s => s.reason)).toEqual(['already done (idempotent check passed)'])
    await rollback(r1.txn)
    expect(existsSync(marker)).toBe(false)
  }))

  test('an exec that does not satisfy its check fails verification', () => withSandbox(async (sb) => {
    await expect(applyPlans([plan([{ kind: 'exec', argv: ['true'], idempotentCheck: ['test', '-e', join(sb.root, 'never')], owner: OWNER }])])).rejects.toThrow(/verification failed/)
  }))
})

describe('dry run and validation', () => {
  test('dryRun and diffPlan write nothing and preview changes', () => withSandbox(async (sb) => {
    const settings = join(sb.home, '.claude', 'settings.json')
    write(settings, '{\n  "theme": "dark"\n}\n')
    const user = join(sb.home, 'user.md')
    write(user, 'mine\n')
    const p = plan([
      { kind: 'json-merge', path: settings, set: { 'env.A': '1' }, owner: OWNER },
      { kind: 'file', path: join(sb.home, 'new.txt'), content: 'hello\n', owner: OWNER },
      { kind: 'file', path: user, content: 'ours\n', owner: OWNER },
      { kind: 'symlink', path: join(sb.home, 'link'), target: '/t', owner: OWNER },
      { kind: 'exec', argv: ['true'], owner: OWNER },
    ])
    const before = snapshotTree(sb.home)
    const r = await applyPlans([p], { dryRun: true })
    expect(r.txn).toBe('')
    expect(r.applied).toBe(4)
    expect(r.conflicts.length).toBe(1)
    const d = await diffPlan(p)
    expect(snapshotTree(sb.home)).toEqual(before)
    expect(d).toContain(`--- ${settings}\n+++ ${settings}\n@@`)
    expect(d).toContain('+  "env": {')
    expect(d).toContain(`--- /dev/null\n+++ ${join(sb.home, 'new.txt')}\n@@ -0,0 +1,1 @@\n+hello`)
    // On Windows a rooted target names that folder on the current drive, and the preview says which.
    const shown = process.platform === 'win32' ? win32.resolve('/t').replace(/\\/g, '/') : '/t'
    expect(d).toContain(`# symlink ${join(sb.home, 'link')} -> ${shown}`)
    expect(d).toContain('# exec: true')
    expect(d).toContain('# conflict: ')
    expect(existsSync(join(sb.buracleHome, 'journal'))).toBe(false)
  }))

  test('diffPlan summarizes a diff too long to review (generated bundles) in one line', () => withSandbox(async (sb) => {
    const big = join(sb.home, 'plugins', 'buracle', 'index.js')
    const small = join(sb.home, 'small.md')
    const bigText = Array.from({ length: 1000 }, (_, i) => `--line ${i}`).join('\n') + '\n'
    const p = plan([
      { kind: 'file', path: big, content: bigText, owner: OWNER },
      { kind: 'file', path: small, content: 'short\n', owner: OWNER },
    ])
    const d = await diffPlan(p)
    expect(d).toContain(`# new file ${big}: +1000 -0 lines (diff of 1003 lines not shown)`)
    expect(d).not.toContain('+--line 999')
    expect(d).toContain(`+++ ${small}\n@@ -0,0 +1,1 @@\n+short`)
    await applyPlans([p])
    const rm = await diffPlan(plan([{ kind: 'remove', path: big, owner: OWNER }]))
    expect(rm).toBe(`# remove ${big}: +0 -1000 lines (diff of 1003 lines not shown)\n`)
  }))

  test('invalid plans are rejected before anything is written', () => withSandbox(async (sb) => {
    const before = snapshotTree(sb.home)
    await expect(applyPlans([plan([{ kind: 'file', path: 'relative.txt', content: '', owner: OWNER }])])).rejects.toThrow(/absolute/)
    await expect(applyPlans([plan([{ kind: 'file', path: join(sb.home, 'x'), content: '', owner: '' }])])).rejects.toThrow(/owner/)
    await expect(applyPlans([plan([{ kind: 'nope', path: join(sb.home, 'x'), owner: OWNER } as unknown as Op])])).rejects.toThrow(/unknown op kind/)
    await expect(applyPlans([plan([{ kind: 'exec', argv: [], owner: OWNER }])])).rejects.toThrow(/argv/)
    await expect(applyPlans([plan([
      { kind: 'file', path: join(sb.home, 'mix.json'), content: '{}', owner: OWNER },
      { kind: 'json-merge', path: join(sb.home, 'mix.json'), set: { a: 1 }, owner: OWNER },
    ])])).rejects.toThrow(/both whole-file and content-merge/)
    expect(snapshotTree(sb.home)).toEqual(before)
  }))

  test('an unparsable ledger stops everything', () => withSandbox(async (sb) => {
    write(join(sb.buracleHome, 'state', 'owned.json'), '{ not json')
    await expect(applyPlans([plan([{ kind: 'file', path: join(sb.home, 'x'), content: '', owner: OWNER }])])).rejects.toThrow(/ledger is unreadable/)
    expect(existsSync(join(sb.home, 'x'))).toBe(false)
  }))

  test('a live lock blocks; a dead, foreign or PID-reused one is taken over (F17)', () => withSandbox(async (sb) => {
    const lock = join(sb.buracleHome, 'state', 'txn.lock')
    const x = join(sb.home, 'x')
    const attempt = () => applyPlans([plan([{ kind: 'file', path: x, content: 'x', owner: OWNER }])])
    const startedAt = Date.now()
    const holder = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 20000)'], { stdout: 'ignore', stderr: 'ignore', env: { ...process.env } })
    try {
      await Bun.sleep(1100)
      write(lock, JSON.stringify({ pid: holder.pid, startedAt }) + '\n')
      await expect(attempt()).rejects.toThrow(/another Buracle transaction is running \(pid \d+, started .*delete that file/)
      write(lock, `${holder.pid}\n`)
      await expect(attempt()).rejects.toThrow(/another Buracle transaction is running/)
      write(lock, JSON.stringify({ pid: holder.pid, startedAt: startedAt - 3_600_000 }) + '\n')
      expect((await attempt()).applied).toBe(1)
      expect(existsSync(lock)).toBe(false)
    } finally {
      holder.kill('SIGKILL')
      await holder.exited
    }
    rmSync(x, { force: true })
    write(lock, '1\n')
    expect((await applyPlans([plan([{ kind: 'file', path: x, content: 'x', owner: OWNER }])], { restore: true })).applied).toBe(1)
    const sleeper = Bun.spawn(['sleep', '20'], { stdout: 'ignore', stderr: 'ignore' })
    try {
      write(lock, `${sleeper.pid}\n`)
      expect((await applyPlans([plan([{ kind: 'file', path: x, content: 'y', owner: OWNER }])])).applied).toBe(1)
    } finally {
      sleeper.kill('SIGKILL')
      await sleeper.exited
    }
    write(lock, '999999\n')
    const r = await applyPlans([plan([{ kind: 'file', path: x, content: 'z', owner: OWNER }])])
    expect(r.applied).toBe(1)
    expect(existsSync(lock)).toBe(false)
  }), 30_000)

  test('empty plans are a no-op', () => withSandbox(async () => {
    expect(await applyPlans([plan([])])).toEqual({ txn: '', applied: 0, skipped: [], conflicts: [], warnings: [] })
    expect(await applyPlans([])).toEqual({ txn: '', applied: 0, skipped: [], conflicts: [], warnings: [] })
  }))
})

describe('TXN_STEPS and journal exec markers', () => {
  const TURKISH_LETTERS = new RegExp(`[${String.fromCodePoint(0xe7, 0x11f, 0x131, 0x130, 0xf6, 0x15f, 0xfc, 0xc7, 0x11e, 0xd6, 0x15e, 0xdc, 0xe2, 0xee)}]`)

  test('TXN_STEPS names the engine steps in order, in English only', () => {
    expect(TXN_STEPS.map(s => s.id)).toEqual(['lock', 'checks', 'plan', 'backup', 'journal', 'write', 'exec', 'verify', 'ledger', 'commit'])
    for (const s of TXN_STEPS) {
      expect(Object.keys(s).sort()).toEqual(['detail', 'id', 'title'])
      expect(s.title.length).toBeGreaterThan(2)
      expect(s.detail.endsWith('.')).toBe(true)
      expect(`${s.title} ${s.detail}`).not.toMatch(TURKISH_LETTERS)
    }
  })

  test('markExecsUndone: an undo that ran outside the engine is never repeated by rollback', () => withSandbox(async (sb) => {
    const marker = join(sb.root, 'installed')
    const undos = join(sb.root, 'undo-count')
    const op: Op = { kind: 'exec', argv: ['touch', marker], undo: ['sh', '-c', `rm -f '${marker}'; echo x >> '${undos}'`], owner: OWNER }
    const r = await applyPlans([plan([op])])
    expect(existsSync(marker)).toBe(true)
    Bun.spawnSync(['rm', '-f', marker])
    expect(await markExecsUndone(r.txn, [['touch', 'nope']])).toBe(0)
    expect(await markExecsUndone(r.txn, [['touch', marker]])).toBe(1)
    expect(await markExecsUndone(r.txn, [['touch', marker]])).toBe(0)
    expect((await readJournal(r.txn)).execs[0]).toMatchObject({ ran: true, undone: true })
    const report = await rollbackTxn(r.txn)
    expect(report.undone).toEqual([])
    expect(existsSync(undos)).toBe(false)
    await expect(markExecsUndone('no-such-txn', [['x']])).rejects.toThrow(/unknown transaction/)
  }))
})

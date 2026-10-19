import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { yamlParse } from '../../src/engine/merge'
import { applyPlans, ledgerKey, readLedger, rollbackTxn, type Op, type Plan } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

const O = 'omp'

function plan(ops: Op[]): Plan {
  return { id: 'p', harness: 'omp', ops }
}

function write(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

const remove = (path: string, pointer: string): Op => ({ kind: 'remove', path: ledgerKey(path, pointer), owner: O })

describe('created containers', () => {
  test('a file Buracle created is deleted when its last key goes (either removal order)', () => withSandbox(async (sb) => {
    for (const order of [['a.b.c', 'a.d'], ['a.d', 'a.b.c']]) {
      const p = join(sb.home, `cfg-${order[0]}.yml`)
      await applyPlans([plan([{ kind: 'yaml-merge', path: p, set: { 'a.b.c': 1, 'a.d': 2 }, owner: O }])])
      expect(read(p)).toBe('a:\n  b:\n    c: 1\n  d: 2\n')
      const led = await readLedger()
      expect(led[ledgerKey(p, 'a.b.c')]?.created).toEqual(['', 'a', 'a.b'])
      expect(led[ledgerKey(p, 'a.d')]?.created).toBeUndefined()
      const first = await applyPlans([plan([remove(p, order[0] as string)])])
      expect(first.conflicts).toEqual([])
      expect(existsSync(p)).toBe(true)
      const heir = (await readLedger())[ledgerKey(p, order[1] as string)]
      expect(heir?.created ?? []).toEqual(order[0] === 'a.b.c' ? ['', 'a'] : ['', 'a', 'a.b'])
      const second = await applyPlans([plan([remove(p, order[1] as string)])])
      expect(second.conflicts).toEqual([])
      expect(existsSync(p)).toBe(false)
    }
  }))

  test('install then uninstall gives a commented YAML file back byte for byte', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.omp', 'agent', 'config.yml')
    const user = '# my omp settings\ntheme:\n  dark: titanium # I like this one\nlist: [ x,  y ]   # padded\n'
    write(p, user)
    await applyPlans([plan([{ kind: 'yaml-merge', path: p, set: { 'memory.backend': 'off', 'statusLine.leftSegments': ['model', 'git'], 'theme.light': 'day' }, owner: O }])])
    const installed = read(p)
    expect(installed.startsWith('# my omp settings\ntheme:\n  dark: titanium # I like this one\n  light: day\nlist: [ x,  y ]   # padded\n')).toBe(true)
    expect(yamlParse(installed)).toEqual({ theme: { dark: 'titanium', light: 'day' }, list: ['x', 'y'], memory: { backend: 'off' }, statusLine: { leftSegments: ['model', 'git'] } })
    const led = await readLedger()
    const r = await applyPlans([plan(Object.keys(led).filter(k => k.startsWith(`${p}#`)).map(k => ({ kind: 'remove', path: k, owner: O }) as Op))])
    expect(r.conflicts).toEqual([])
    expect(read(p)).toBe(user)
  }))

  test("parents the user had stay, even when empty; so do parents the user put keys into", () => withSandbox(async (sb) => {
    const json = join(sb.home, 'settings.json')
    write(json, '{\n  "hooks": {}\n}\n')
    await applyPlans([plan([{ kind: 'json-merge', path: json, set: { 'hooks.Stop': ['x'], 'env.A': '1' }, owner: O }])])
    expect((await readLedger())[ledgerKey(json, 'hooks.Stop')]?.created).toBeUndefined()
    expect((await readLedger())[ledgerKey(json, 'env.A')]?.created).toEqual(['env'])
    write(json, read(json).replace('"A": "1"', '"A": "1",\n    "MINE": "2"'))
    const r = await applyPlans([plan([remove(json, 'hooks.Stop'), remove(json, 'env.A')])])
    expect(r.conflicts).toEqual([])
    expect(JSON.parse(read(json))).toEqual({ hooks: {}, env: { MINE: '2' } })
    expect(Object.keys(await readLedger()).filter(k => k.startsWith(json))).toEqual([])
  }))

  test('a Buracle-created file the user commented in is kept', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'new.yml')
    await applyPlans([plan([{ kind: 'yaml-merge', path: p, set: { 'tools.approvalMode': 'write' }, owner: O }])])
    write(p, '# keep me\n' + read(p))
    const r = await applyPlans([plan([remove(p, 'tools.approvalMode')])])
    expect(r.conflicts).toEqual([])
    expect(existsSync(p)).toBe(true)
    expect(read(p)).toBe('# keep me\n')
  }))

  test('a key the user already deleted still lets the empty parent Buracle created go', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'c.yml')
    write(p, 'theme: dark\n')
    await applyPlans([plan([{ kind: 'yaml-merge', path: p, set: { 'memory.backend': 'off' }, owner: O }])])
    write(p, 'theme: dark\nmemory: {}\n')
    const r = await applyPlans([plan([remove(p, 'memory.backend')])])
    expect(r).toMatchObject({ applied: 1, conflicts: [] })
    expect(read(p)).toBe('theme: dark\n')
  }))

  test('updating an owned key keeps what it created; an adopted key never records anything', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'u.json')
    await applyPlans([plan([{ kind: 'json-merge', path: p, set: { 'a.b': 1 }, owner: O }])])
    await applyPlans([plan([{ kind: 'json-merge', path: p, set: { 'a.b': 2 }, owner: O }])])
    expect((await readLedger())[ledgerKey(p, 'a.b')]?.created).toEqual(['', 'a'])
    const q = join(sb.home, 'v.json')
    write(q, '{ "a": { "b": 1 } }\n')
    await applyPlans([plan([{ kind: 'json-merge', path: q, set: { 'a.b': 1 }, owner: O }])])
    const e = (await readLedger())[ledgerKey(q, 'a.b')]
    expect(e?.adopted).toBe(true)
    expect(e?.created).toBeUndefined()
  }))

  test('a pruning uninstall rolls back to the installed file', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'r.jsonc')
    await applyPlans([plan([{ kind: 'jsonc-merge', path: p, set: { 'mcp.servers.x': { type: 'local' } }, owner: O }])])
    const installed = read(p)
    const u = await applyPlans([plan([remove(p, 'mcp.servers.x')])])
    expect(existsSync(p)).toBe(false)
    const report = await rollbackTxn(u.txn)
    expect(report.errors).toEqual([])
    expect(read(p)).toBe(installed)
    expect((await readLedger())[ledgerKey(p, 'mcp.servers.x')]?.created).toEqual(['', 'mcp', 'mcp.servers'])
  }))
})

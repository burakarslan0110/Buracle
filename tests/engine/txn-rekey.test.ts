import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tomlParse, tomlRenameTable } from '../../src/engine/merge'
import { applyPlans, readLedger, rollbackTxn, type Op, type Plan } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

const K = (i: number) => `/h/.codex/hooks.json:pre_tool_use:${i}:0`
const state = (i: number) => ['hooks', 'state', K(i)]

const CONFIG = `# user settings
model = "gpt-6.1-sol"

[hooks.state."${K(0)}"]
trusted_hash = "sha256:aaa"   # user-audit-1

[hooks.state."${K(1)}"]
trusted_hash = "sha256:bbb"

[hooks.state."${K(2)}"]
# the user's later hook
trusted_hash = "sha256:ccc"

[tui]
theme = "dracula"
`

function setup(home: string, text = CONFIG): string {
  const p = join(home, '.codex', 'config.toml')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(p, text)
  return p
}

function plan(path: string, rekey: Partial<Extract<Op, { kind: 'toml-rekey' }>>): Plan {
  return { id: 'codex-uninstall', harness: 'codex', ops: [{ kind: 'toml-rekey', path, owner: 'codex', ...rekey } as Op] }
}

const DROP_1 = { table: state(1), value: { trusted_hash: 'sha256:bbb' } }
const MOVE_2_1 = { from: state(2), to: state(1), value: { trusted_hash: 'sha256:ccc' } }

describe('toml-rekey', () => {
  test('drops, then moves in place: only the named tables change; nothing goes into the ledger', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    const r = await applyPlans([plan(p, { drops: [DROP_1], moves: [MOVE_2_1] })])
    expect(r.conflicts).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.applied).toBe(1)
    expect(readFileSync(p, 'utf8')).toBe(`# user settings
model = "gpt-6.1-sol"

[hooks.state."${K(0)}"]
trusted_hash = "sha256:aaa"   # user-audit-1

[hooks.state."${K(1)}"]
# the user's later hook
trusted_hash = "sha256:ccc"

[tui]
theme = "dracula"
`)
    expect(await readLedger()).toEqual({})
    const back = await rollbackTxn(r.txn)
    expect(back.errors).toEqual([])
    expect(readFileSync(p, 'utf8')).toBe(CONFIG)
  }))

  test('compare-and-swap: a changed entry or a taken target is left as it is and reported', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    const r = await applyPlans([plan(p, {
      drops: [{ table: state(1), value: { trusted_hash: 'sha256:OLD' } }],
      moves: [{ from: state(2), to: state(0), value: { trusted_hash: 'sha256:ccc' } }, { from: state(1), to: state(5), value: { trusted_hash: 'sha256:OLD' } }],
    })])
    expect(r.txn).toBe('')
    expect(readFileSync(p, 'utf8')).toBe(CONFIG)
    expect(r.warnings.length).toBe(3)
    expect(r.warnings[0]).toContain('changed since the plan was made')
    expect(r.warnings[1]).toContain('the target is already defined')
    expect(r.warnings[2]).toContain('the entry changed since the plan was made')
    const dry = await applyPlans([plan(p, { drops: [{ table: state(1), value: { trusted_hash: 'sha256:OLD' } }] })], { dryRun: true })
    expect(dry.warnings.length).toBe(1)
  }))

  test('an entry already gone is no warning; a missing file is skipped', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    const r = await applyPlans([plan(p, { drops: [{ table: state(9), value: { trusted_hash: 'sha256:x' } }] })])
    expect(r.warnings).toEqual([])
    expect(r.skipped.map(s => s.reason)).toEqual(['unchanged'])
    const none = await applyPlans([plan(join(home, '.codex', 'missing.toml'), { drops: [DROP_1] })])
    expect(none.skipped.map(s => s.reason)).toEqual(['absent'])
  }))

  test('a read-only file is a conflict and stays untouched', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    chmodSync(p, 0o444)
    const r = await applyPlans([plan(p, { drops: [DROP_1] })])
    expect(r.conflicts.map(c => c.detail).join('\n')).toContain('read-only')
    chmodSync(p, 0o644)
    expect(readFileSync(p, 'utf8')).toBe(CONFIG)
  }))

  test('validation', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    await expect(applyPlans([plan(p, { drops: [{ table: [], value: {} }] })])).rejects.toThrow('non-empty list of key segments')
    await expect(applyPlans([plan(p, { moves: [{ from: state(1), to: state(0), value: 'x' as never }] })])).rejects.toThrow('value must be a mapping')
    await expect(applyPlans([plan(p, { drops: 'x' as never })])).rejects.toThrow('drops must be a list')
  }))
})

describe('tomlRenameTable', () => {
  test('renames the header only; refuses dotted or inline forms, sub-tables and a taken target', () => {
    const text = '[a.b]\nx = 1 # c\n\n[a.c]\ny = 2\n'
    expect(tomlRenameTable(text, ['a', 'b'], ['a', 'd e'])).toBe('[a."d e"]\nx = 1 # c\n\n[a.c]\ny = 2\n')
    expect(tomlParse(tomlRenameTable(text, ['a', 'b'], ['z']))).toEqual({ z: { x: 1 }, a: { c: { y: 2 } } })
    expect(() => tomlRenameTable(text, ['a', 'b'], ['a', 'c'])).toThrow('already defined')
    expect(() => tomlRenameTable('a.b.x = 1\n', ['a', 'b'], ['a', 'z'])).toThrow('defined some other way')
    expect(() => tomlRenameTable('[a]\nb = { x = 1 }\n', ['a', 'b'], ['a', 'z'])).toThrow('defined some other way')
    expect(() => tomlRenameTable('[a.b]\nx = 1\n[a.b.c]\ny = 2\n', ['a', 'b'], ['a', 'z'])).toThrow('has sub-tables')
  })
})

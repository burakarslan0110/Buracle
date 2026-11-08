import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tomlParse } from '../../src/engine/merge'
import { applyPlans, readLedger, type Op } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

// What herdr's Codex integration left behind (it appends `[features]` when the file has none): Buracle's earlier
// install had written `features.memories` as a dotted root key, TOML allows one definition of a table, and Codex did
// not start ("duplicate key"). The next install has to repair it, and a fresh install has to avoid it.
const BROKEN = `model = "gpt-x"
features.memories = false
agents.enabled = true

[tui]
a = 1

[features]
hooks = true
`

const KEYS = { 'features.memories': false, 'agents.enabled': true }
const toml = (home: string): string => join(home, '.codex', 'config.toml')
const plan = (path: string, owner = 'codex') => [{ id: 'codex', harness: 'codex' as const, ops: [{ kind: 'toml-tables', path, tables: {}, keys: KEYS, owner, soft: Object.keys(KEYS) } as Op] }]

describe('toml-tables over a file with a dotted key and a [table] header of the same name', () => {
  test('repairs it: the keys move into their tables, nothing else changes, a warning says so, and a second run changes nothing', () => withSandbox(async (sb) => {
    const p = toml(sb.home)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, BROKEN)
    expect(() => tomlParse(BROKEN)).toThrow()

    const r = await applyPlans(plan(p))
    expect(r.conflicts).toEqual([])
    const out = readFileSync(p, 'utf8')
    expect(tomlParse(out)).toEqual({ model: 'gpt-x', tui: { a: 1 }, features: { hooks: true, memories: false }, agents: { enabled: true } })
    expect(out).toBe('model = "gpt-x"\n\n[tui]\na = 1\n\n[features]\nhooks = true\nmemories = false\n\n[agents]\nenabled = true\n')
    expect(r.warnings.join('\n')).toMatch(/features.*agents|agents.*features/)

    const again = await applyPlans(plan(p))
    expect(again.conflicts).toEqual([])
    expect(readFileSync(p, 'utf8')).toBe(out)
  }))

  test('a valid file with the dotted keys is moved to tables too, so a later [features] header from another tool cannot break it', () => withSandbox(async (sb) => {
    const p = toml(sb.home)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'model = "gpt-x"\nfeatures.memories = false\n')
    const r = await applyPlans(plan(p))
    expect(r.conflicts).toEqual([])
    expect(readFileSync(p, 'utf8')).toBe('model = "gpt-x"\n\n[features]\nmemories = false\n\n[agents]\nenabled = true\n')
  }))

  test('a fresh install writes tables, and uninstalling them restores the file byte for byte', () => withSandbox(async (sb) => {
    const p = toml(sb.home)
    mkdirSync(dirname(p), { recursive: true })
    const original = 'model = "gpt-x"\n\n[tui]\na = 1\n'
    writeFileSync(p, original)
    const r = await applyPlans(plan(p))
    expect(r.conflicts).toEqual([])
    const out = readFileSync(p, 'utf8')
    expect(out).toBe(`${original}\n[features]\nmemories = false\n\n[agents]\nenabled = true\n`)
    // herdr's integration finds the table and adds its key to it; the file stays valid.
    writeFileSync(p, out.replace('memories = false\n', 'memories = false\nhooks = true\n'))
    const keys = Object.keys(await readLedger())
    const u = await applyPlans([{ id: 'codex', harness: 'codex', ops: keys.map(k => ({ kind: 'remove', path: k, owner: 'codex' }) as Op) }])
    expect(u.conflicts).toEqual([])
    expect(tomlParse(readFileSync(p, 'utf8'))).toEqual({ model: 'gpt-x', tui: { a: 1 }, features: { hooks: true } })
  }))

  test('a read-only or unrelated-invalid file is left alone as before', () => withSandbox(async (sb) => {
    const p = toml(sb.home)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'a = [1,\nfeatures.memories = false\n')
    const r = await applyPlans(plan(p))
    expect(r.conflicts.map(c => c.detail).join('\n')).toMatch(/not valid TOML/)
    expect(readFileSync(p, 'utf8')).toBe('a = [1,\nfeatures.memories = false\n')
  }))
})

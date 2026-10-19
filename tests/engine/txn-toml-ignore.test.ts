import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configTomlOps, MCP_TABLE_CODEX_KEYS } from '../../src/adapters/codex/install'
import { tomlParse, tomlPatchTables } from '../../src/engine/merge'
import { applyPlans, ledgerKey, readLedger, rollbackTxn, type Op, type Plan } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

const TABLE = 'mcp_servers.context7'
const v1 = { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.5.0'] }
const v2 = { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.6.0'] }
const APPROVAL = '\n[mcp_servers.context7.tools.query-docs]\napproval_mode = "approve"\n'

function op(path: string, values: Record<string, unknown>, ignore: string[] | null = ['tools']): Op {
  return ignore !== null
    ? { kind: 'toml-tables', path, tables: { [TABLE]: values }, owner: 'codex', ignore: { [TABLE]: ignore } }
    : { kind: 'toml-tables', path, tables: { [TABLE]: values }, owner: 'codex' }
}
const plan = (ops: Op[]): Plan => ({ id: 'codex', harness: 'codex', ops })

function setup(home: string): string {
  const p = join(home, '.codex', 'config.toml')
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(p, '# mine\nmodel = "gpt-6.1-sol"\n')
  return p
}

describe('tomlPatchTables keep', () => {
  test('a kept sub-table and a kept inline key survive a table update; others are replaced as before', () => {
    const sub = `[a]\nx = 1\n\n[a.tools.q]\nmode = "approve"\n\n[a.other]\ny = 2\n`
    expect(tomlParse(tomlPatchTables(sub, { a: { x: 2 } }, {}, { a: ['tools'] }))).toEqual({ a: { x: 2, tools: { q: { mode: 'approve' } } } })
    const inline = `[a]\nx = 1 # pinned\ntools = { q = { mode = "approve" } }\n`
    const out = tomlPatchTables(inline, { a: { x: 2 } }, {}, { a: ['tools'] })
    expect(out).toBe(`[a]\nx = 2 # pinned\ntools = { q = { mode = "approve" } }\n`)
    expect(tomlParse(tomlPatchTables(`[a]\nx = 1\n\n[a.tools.q]\nmode = "approve"\n`, { a: { x: 2 } }))).toEqual({ a: { x: 2 } })
  })
})

describe('toml-tables ignore (F10)', () => {
  test('an approval Codex wrote never blocks a pin bump, survives it, and goes with the table on removal', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    expect((await applyPlans([plan([op(p, v1)])])).conflicts).toEqual([])
    expect((await readLedger())[ledgerKey(p, `[${TABLE}]`)]?.ignore).toEqual(['tools'])
    writeFileSync(p, readFileSync(p, 'utf8') + APPROVAL)
    const same = await applyPlans([plan([op(p, v1)])])
    expect(same.conflicts).toEqual([])
    expect(same.txn).toBe('')
    const bump = await applyPlans([plan([op(p, v2)])])
    expect(bump.conflicts).toEqual([])
    const after = tomlParse(readFileSync(p, 'utf8')) as { mcp_servers: { context7: Record<string, unknown> } }
    expect(after.mcp_servers.context7).toEqual({ ...v2, tools: { 'query-docs': { approval_mode: 'approve' } } })
    const rm = await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, `[${TABLE}]`), owner: 'codex' }])])
    expect(rm.conflicts).toEqual([])
    expect(readFileSync(p, 'utf8')).toBe('# mine\nmodel = "gpt-6.1-sol"\n')
  }))

  test('a change of Buracle\'s own keys is still the user\'s change (conflict, kept)', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    await applyPlans([plan([op(p, v1)])])
    writeFileSync(p, readFileSync(p, 'utf8').replace('context7-mcp@4.5.0', 'context7-mcp@9.9.9') + APPROVAL)
    const bump = await applyPlans([plan([op(p, v2)])])
    expect(bump.conflicts.map(c => c.detail).join('\n')).toContain('[mcp_servers.context7]')
    expect(readFileSync(p, 'utf8')).toContain('context7-mcp@9.9.9')
  }))

  test('an install made before `ignore` existed takes it over without a file change', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    await applyPlans([plan([op(p, v1, null)])])
    expect((await readLedger())[ledgerKey(p, `[${TABLE}]`)]?.ignore).toBeUndefined()
    writeFileSync(p, readFileSync(p, 'utf8') + APPROVAL)
    const before = readFileSync(p, 'utf8')
    const r = await applyPlans([plan([op(p, v1)])])
    expect(r.conflicts).toEqual([])
    expect(readFileSync(p, 'utf8')).toBe(before)
    expect((await readLedger())[ledgerKey(p, `[${TABLE}]`)]?.ignore).toEqual(['tools'])
    expect((await applyPlans([plan([op(p, v2)])])).conflicts).toEqual([])
  }))

  test('a rollback of a pin bump keeps the approvals Codex wrote', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    await applyPlans([plan([op(p, v1)])])
    writeFileSync(p, readFileSync(p, 'utf8') + APPROVAL)
    const bump = await applyPlans([plan([op(p, v2)])])
    const back = await rollbackTxn(bump.txn)
    expect(back.errors).toEqual([])
    const t = tomlParse(readFileSync(p, 'utf8')) as { mcp_servers: { context7: Record<string, unknown> } }
    expect(t.mcp_servers.context7).toEqual({ ...v1, tools: { 'query-docs': { approval_mode: 'approve' } } })
  }))

  test('validation: ignore names one of the op\'s tables and never a key it sets', () => withSandbox(async ({ home }) => {
    const p = setup(home)
    await expect(applyPlans([plan([{ kind: 'toml-tables', path: p, tables: { [TABLE]: v1 }, owner: 'codex', ignore: { other: ['tools'] } }])])).rejects.toThrow('not one of its tables')
    await expect(applyPlans([plan([{ kind: 'toml-tables', path: p, tables: { [TABLE]: { ...v1, tools: {} } }, owner: 'codex', ignore: { [TABLE]: ['tools'] } }])])).rejects.toThrow('also ignores')
  }))

  test('the Codex adapter ignores `tools` in every MCP server table it owns', () => {
    const ops = configTomlOps('/h/.codex/config.toml', { mcpTables: { 'mcp_servers.a': { command: 'a' }, 'mcp_servers.b': { url: 'https://b' } }, tui: { status_line: [], terminal_title: [] } } as never)
    const mcp = ops.filter(o => o.kind === 'toml-tables' && Object.keys(o.tables)[0]?.startsWith('mcp_servers.'))
    expect(mcp.length).toBe(2)
    for (const o of mcp) expect((o as Extract<Op, { kind: 'toml-tables' }>).ignore).toEqual({ [Object.keys((o as Extract<Op, { kind: 'toml-tables' }>).tables)[0] as string]: [...MCP_TABLE_CODEX_KEYS] })
  })
})

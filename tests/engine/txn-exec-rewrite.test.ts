import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyPlans, ledgerKey, readJournal, readLedger, rollbackTxn, type Op, type Plan } from '../../src/engine/txn'
import { sha256 } from '../../src/engine/fsx'
import { withSandbox } from '../helpers/sandbox'

const O = 'claude'

function plan(ops: Op[], id = 'p'): Plan {
  return { id, harness: 'claude', ops }
}

function write(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

const USER_SETTINGS = '{\n    "model": "opus",\n    "permissions": {"allow": ["Bash(git status)"]}\n}\n'
const STATUS = { type: 'command', command: '/x/buracle statusline claude', padding: 0 }

function rewriteJson(path: string, fn: string): string[] {
  const script = `const fs=require('fs');const p=${JSON.stringify(path)};const s=JSON.parse(fs.readFileSync(p,'utf8'));const out=(${fn});if(out!==null)fs.writeFileSync(p,JSON.stringify(out,null,2)+'\\n')`
  return [process.execPath, '-e', script]
}

describe('commands that rewrite a file Buracle merged into', () => {
  test('the transaction commits when Buracle\'s values hold; rollback restores the user\'s bytes', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, USER_SETTINGS)
    const r = await applyPlans([plan([
      { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O },
      {
        kind: 'exec', owner: O,
        argv: rewriteJson(p, '({...s, enabledPlugins: {...(s.enabledPlugins||{}), "buracle@buracle": true}})'),
        undo: rewriteJson(p, '(s.enabledPlugins && "buracle@buracle" in s.enabledPlugins) ? (()=>{const {enabledPlugins, ...rest}=s; return rest})() : null'),
      },
    ])])
    expect(r.conflicts).toEqual([])
    const after = read(p)
    expect(JSON.parse(after)).toEqual({ model: 'opus', permissions: { allow: ['Bash(git status)'] }, statusLine: STATUS, enabledPlugins: { 'buracle@buracle': true } })
    const j = await readJournal(r.txn)
    expect(j.status).toBe('committed')
    expect(j.files.find(f => f.path === p)?.after.sha256).toBe(sha256(after))
    expect((await readLedger())[ledgerKey(p, 'statusLine')]?.owner).toBe(O)
    const rep = await rollbackTxn(r.txn)
    expect(rep.skipped).toEqual([])
    expect(rep.errors).toEqual([])
    expect(read(p)).toBe(USER_SETTINGS)
    expect((await readLedger())[ledgerKey(p, 'statusLine')]).toBeUndefined()
  }))

  test('a command that changes the value Buracle wrote fails verification and everything rolls back', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, USER_SETTINGS)
    await expect(applyPlans([plan([
      { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O },
      { kind: 'exec', owner: O, argv: rewriteJson(p, '({...s, statusLine: {type: "command", command: "other"}})') },
    ])])).rejects.toThrow(/verification failed for .*settings\.json: a command of this transaction changed what Buracle wrote there/)
    expect(read(p)).toBe(USER_SETTINGS)
    expect(await readLedger()).toEqual({})
  }))

  test('a command that edits a whole file Buracle wrote fails verification', () => withSandbox(async (sb) => {
    const f = join(sb.home, '.claude', 'rules', 'buracle', 'core.md')
    await expect(applyPlans([plan([
      { kind: 'file', path: f, content: '# rules\n', owner: O },
      { kind: 'exec', owner: O, argv: ['sh', '-c', `printf extra >> '${f}'`] },
    ])])).rejects.toThrow(/verification failed for .*core\.md/)
    expect(existsSync(f)).toBe(false)
    expect(existsSync(dirname(f))).toBe(false)
  }))

  test('a value this transaction removed must stay removed', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, USER_SETTINGS)
    await applyPlans([plan([{ kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O }])])
    const installed = read(p)
    await expect(applyPlans([plan([
      { kind: 'remove', path: ledgerKey(p, 'statusLine'), owner: O },
      { kind: 'exec', owner: O, argv: rewriteJson(p, `({...s, statusLine: ${JSON.stringify(STATUS)}, extra: 1})`) },
    ])])).rejects.toThrow(/verification failed/)
    expect(read(p)).toBe(installed)
  }))

  test('commands that leave the merged file alone keep the exact journal snapshot', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, USER_SETTINGS)
    const marker = join(sb.root, 'ran')
    const r = await applyPlans([plan([
      { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O },
      { kind: 'exec', owner: O, argv: ['touch', marker], undo: ['rm', '-f', marker] },
    ])])
    const j = await readJournal(r.txn)
    expect(j.files.find(f => f.path === p)?.after.sha256).toBe(sha256(read(p)))
    expect(existsSync(marker)).toBe(true)
  }))
})

describe('Markdown and TOML files Buracle created', () => {
  test('an AGENTS.md created for a block is deleted with the block; a pre-existing one stays', () => withSandbox(async (sb) => {
    const created = join(sb.home, '.config', 'opencode', 'AGENTS.md')
    const mine = join(sb.home, '.codex', 'AGENTS.md')
    write(mine, '# My rules\n')
    await applyPlans([plan([
      { kind: 'md-block', path: created, id: 'buracle', content: 'Buracle block', owner: O },
      { kind: 'md-block', path: mine, id: 'buracle', content: 'Buracle block', owner: O },
    ])])
    expect((await readLedger())[ledgerKey(created, 'md:buracle')]?.created).toEqual([''])
    expect((await readLedger())[ledgerKey(mine, 'md:buracle')]?.created).toBeUndefined()
    const r = await applyPlans([plan([
      { kind: 'remove', path: ledgerKey(created, 'md:buracle'), owner: O },
      { kind: 'remove', path: ledgerKey(mine, 'md:buracle'), owner: O },
    ])])
    expect(r.conflicts).toEqual([])
    expect(existsSync(created)).toBe(false)
    expect(read(mine)).toBe('# My rules\n')
  }))

  test('two blocks in a created file: the file goes with the last one, in either order', () => withSandbox(async (sb) => {
    for (const order of [['a', 'b'], ['b', 'a']] as const) {
      const p = join(sb.home, `AGENTS-${order[0]}.md`)
      await applyPlans([plan([
        { kind: 'md-block', path: p, id: 'a', content: 'block a', owner: O },
        { kind: 'md-block', path: p, id: 'b', content: 'block b', owner: O },
      ])])
      await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, `md:${order[0]}`), owner: O }])])
      expect(existsSync(p)).toBe(true)
      expect((await readLedger())[ledgerKey(p, `md:${order[1]}`)]?.created).toEqual([''])
      await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, `md:${order[1]}`), owner: O }])])
      expect(existsSync(p)).toBe(false)
    }
  }))

  test('a created file the user wrote into is kept (only the block goes)', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.omp', 'agent', 'AGENTS.md')
    await applyPlans([plan([{ kind: 'md-block', path: p, id: 'omp', content: 'pointer', owner: O }])])
    write(p, `${read(p)}\nMy own note.\n`)
    const r = await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, 'md:omp'), owner: O }])])
    expect(r.conflicts).toEqual([])
    expect(read(p).trim()).toBe('My own note.')
  }))

  test('a config.toml created by several table ops is deleted after its last table, in either order', () => withSandbox(async (sb) => {
    for (const first of ['[mcp_servers.a]', '[tools.update_plan]']) {
      const p = join(sb.home, `codex-${first.length}`, 'config.toml')
      await applyPlans([plan([
        { kind: 'toml-tables', path: p, tables: { 'mcp_servers.a': { command: 'x' } }, owner: O },
        { kind: 'toml-tables', path: p, tables: { 'tools.update_plan': { enabled: true } }, owner: O },
      ])])
      const second = first === '[mcp_servers.a]' ? '[tools.update_plan]' : '[mcp_servers.a]'
      await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, first), owner: O }])])
      expect(existsSync(p)).toBe(true)
      await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, second), owner: O }])])
      expect(existsSync(p)).toBe(false)
    }
  }))

  test('a pre-existing config.toml stays even when only Buracle\'s tables were in it', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'config.toml')
    write(p, '')
    await applyPlans([plan([{ kind: 'toml-tables', path: p, tables: { 'tools.update_plan': { enabled: true } }, owner: O }])])
    await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, '[tools.update_plan]'), owner: O }])])
    expect(existsSync(p)).toBe(true)
    expect(read(p).trim()).toBe('')
  }))
})

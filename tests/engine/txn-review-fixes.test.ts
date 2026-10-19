import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  applyPlans, cleanupLedgerKey, historyCreatedDirs, ledgerKey, listTxns, readJournal, readLedger, RETENTION, rollbackTxn, withTxnLock,
  type Op, type Plan,
} from '../../src/engine/txn'
import { yamlParse } from '../../src/engine/merge'
import { fakeExe, IS_WINDOWS, KEEPS_MODES } from '../helpers/fake-exe'
import { withSandbox, type Sandbox } from '../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..')
const O = 'claude'

function plan(ops: Op[], extra: Partial<Plan> = {}): Plan {
  return { id: 'p', harness: 'claude', ops, ...extra }
}
function write(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mode !== undefined) chmodSync(path, mode)
}
function read(path: string): string {
  return readFileSync(path, 'utf8')
}
function jsonEdit(path: string, fn: string): string[] {
  return [process.execPath, '-e', `const fs=require('fs');const p=${JSON.stringify(path)};const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};const o=(${fn});fs.writeFileSync(p,JSON.stringify(o,null,2)+'\\n')`]
}

const STATUS = { type: 'command', command: '/x/buracle statusline claude' }

describe('F04: YAML merge keys and aliases are the user\'s values', () => {
  const anchored = '# Oh My Pi settings\nsafe: &safe\n  approvalMode: always-ask   # confirm every write\n\ntools:\n  <<: *safe\n  bash:\n    timeout: 120\n'

  test('a key supplied through `<<: *anchor` is a conflict, never an override (what omp reads stays the same)', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.omp', 'agent', 'config.yml')
    write(p, anchored)
    const r = await applyPlans([plan([{ kind: 'yaml-merge', path: p, set: { 'tools.approvalMode': 'write', 'memory.backend': 'off' }, owner: 'omp' }])])
    expect(r.conflicts.map(c => c.detail)).toEqual([`${p} tools.approvalMode: tools.approvalMode is inherited through a YAML merge key (<<: *anchor); Buracle does not override inherited values; keeping the user's value`])
    expect((Bun.YAML.parse(read(p)) as { tools: unknown }).tools).toEqual({ approvalMode: 'always-ask', bash: { timeout: 120 } })
    expect((yamlParse(read(p)) as { memory: unknown }).memory).toEqual({ backend: 'off' })
    expect((await readLedger())[ledgerKey(p, 'tools.approvalMode')]).toBeUndefined()
  }))

  test('a map on the path supplied by a merge key, or an alias on the path, is a conflict; an inherited equal value is adopted', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.omp', 'agent', 'config.yml')
    const text = 'base: &b\n  statusLine:\n    preset: minimal\n  mode: write\nui:\n  <<: *b\nother: *b\n'
    write(p, text)
    const r = await applyPlans([plan([{ kind: 'yaml-merge', path: p, set: { 'ui.statusLine.showHookStatus': false, 'other.extra': 1, 'ui.mode': 'write' }, owner: 'omp' }])])
    const details = r.conflicts.map(c => c.detail)
    expect(details).toHaveLength(2)
    expect(details[0]).toContain('ui.statusLine is inherited through a YAML merge key')
    expect(details[1]).toContain('other is a YAML alias (*b)')
    expect(read(p)).toBe(text)
    expect((await readLedger())[ledgerKey(p, 'ui.mode')]?.adopted).toBe(true)
  }))
})

describe('F07: an in-process rollback never discards what someone else changed meanwhile', () => {
  test('a merged file: only Buracle\'s key is undone; a concurrent writer\'s keys survive', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "model": "opus"\n}\n')
    const timer = setTimeout(() => {
      const cur = JSON.parse(read(p)) as Record<string, unknown>
      writeFileSync(p, JSON.stringify({ ...cur, theme: 'light' }, null, 2) + '\n')
    }, 300)
    try {
      await expect(applyPlans([plan([
        { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O },
        { kind: 'exec', argv: ['sh', '-c', 'sleep 1; exit 1'], owner: O },
      ])])).rejects.toThrow(/rolled back/)
    } finally { clearTimeout(timer) }
    expect(JSON.parse(read(p))).toEqual({ model: 'opus', theme: 'light' })
    expect(await readLedger()).toEqual({})
    expect((await listTxns())[0]?.status).toBe('rolled-back')
  }))

  test('a whole file someone else rewrote meanwhile is left as is and reported', () => withSandbox(async (sb) => {
    const f = join(sb.home, '.claude', 'rules', 'buracle', 'core.md')
    const timer = setTimeout(() => writeFileSync(f, 'the user rewrote this\n'), 300)
    let err = ''
    try {
      await applyPlans([plan([
        { kind: 'file', path: f, content: '# rules\n', owner: O },
        { kind: 'exec', argv: ['sh', '-c', 'sleep 1; exit 1'], owner: O },
      ])]).catch((e: Error) => { err = e.message })
    } finally { clearTimeout(timer) }
    expect(err).toContain('rolled back')
    expect(err).toContain(`${f}: changed after the transaction; left as is`)
    expect(read(f)).toBe('the user rewrote this\n')
  }))
})

describe('F22: partial side effects of a failed command are undone', () => {
  test('the failed command\'s undo runs (best effort) during the in-process rollback', () => withSandbox(async (sb) => {
    const marker = join(sb.root, 'registered')
    await expect(applyPlans([plan([
      { kind: 'file', path: join(sb.home, 'f.txt'), content: 'x', owner: O },
      { kind: 'exec', argv: ['sh', '-c', `touch '${marker}'; exit 1`], undo: ['rm', '-f', marker], owner: O },
    ])])).rejects.toThrow(/exec failed \(exit 1\)/)
    expect(existsSync(marker)).toBe(false)
    const j = (await listTxns())[0]
    expect(j?.execs[0]).toMatchObject({ started: true, ran: false, failed: true, undone: true })
  }))
})

describe('I1: soft commands', () => {
  test('a failing soft command is a warning; the transaction commits; its undo never runs', () => withSandbox(async (sb) => {
    const f = join(sb.home, '.claude', 'rules', 'buracle', 'core.md')
    const undoMarker = join(sb.root, 'undo-ran')
    const okMarker = join(sb.root, 'ok')
    const r = await applyPlans([plan([
      { kind: 'file', path: f, content: '# rules\n', owner: O },
      { kind: 'exec', argv: ['sh', '-c', 'echo "network unreachable" >&2; exit 4'], undo: ['touch', undoMarker], owner: O, soft: true },
      { kind: 'exec', argv: ['touch', okMarker], undo: ['rm', '-f', okMarker], owner: O },
    ])])
    expect(r.txn).not.toBe('')
    expect(read(f)).toBe('# rules\n')
    expect(existsSync(okMarker)).toBe(true)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('`sh -c echo "network unreachable" >&2; exit 4` failed (exit 4)')
    expect(r.warnings[0]).toContain('network unreachable')
    const j = await readJournal(r.txn)
    expect(j.status).toBe('committed')
    expect(j.execs[0]).toMatchObject({ soft: true, failed: true, ran: false, started: true })
    await rollbackTxn(r.txn)
    expect(existsSync(okMarker)).toBe(false)
    expect(existsSync(undoMarker)).toBe(false)
    expect(existsSync(f)).toBe(false)
  }))
})

describe('F08: two links to one shared file', () => {
  test('edits through both links compose on one file; rollback and removal restore it exactly', () => withSandbox(async (sb) => {
    const shared = join(sb.home, '.agents', 'AGENTS.md')
    write(shared, '# My shared agent instructions\nPrefer small diffs.\n')
    const codex = join(sb.home, '.codex', 'AGENTS.md')
    const opencode = join(sb.home, '.config', 'opencode', 'AGENTS.md')
    mkdirSync(dirname(codex), { recursive: true })
    mkdirSync(dirname(opencode), { recursive: true })
    symlinkSync('../.agents/AGENTS.md', codex)
    symlinkSync('../../.agents/AGENTS.md', opencode)
    const original = read(shared)
    const ops: Op[] = [
      { kind: 'md-block', path: codex, id: 'buracle-codex', content: 'codex rules', owner: 'codex' },
      { kind: 'md-block', path: opencode, id: 'buracle-opencode', content: 'opencode rules', owner: 'opencode' },
    ]
    const r = await applyPlans([{ id: 'both', harness: 'core', ops }])
    expect(r.conflicts).toEqual([])
    expect(read(shared)).toContain('codex rules')
    expect(read(shared)).toContain('opencode rules')
    const j = await readJournal(r.txn)
    expect(j.files).toHaveLength(1)
    expect(j.files[0]?.via).toEqual([opencode])
    await rollbackTxn(r.txn)
    expect(read(shared)).toBe(original)

    await applyPlans([{ id: 'both', harness: 'core', ops }])
    const led = await readLedger()
    const removal = await applyPlans([{ id: 'u', harness: 'core', ops: [
      { kind: 'remove', path: ledgerKey(codex, 'md:buracle-codex'), owner: 'codex' },
      { kind: 'remove', path: ledgerKey(opencode, 'md:buracle-opencode'), owner: 'opencode' },
    ] }])
    expect(Object.keys(led)).toHaveLength(2)
    expect(removal.conflicts).toEqual([])
    expect(read(shared)).toBe(original)
  }))

  test('the same block id through two links is one conflict, not a failed transaction', () => withSandbox(async (sb) => {
    const shared = join(sb.home, 'shared.md')
    write(shared, '# notes\n')
    const a = join(sb.home, 'a.md')
    const b = join(sb.home, 'b.md')
    symlinkSync(shared, a)
    symlinkSync(shared, b)
    const r = await applyPlans([plan([
      { kind: 'md-block', path: a, id: 'buracle', content: 'from a', owner: O },
      { kind: 'md-block', path: b, id: 'buracle', content: 'from b', owner: O },
    ])])
    expect(r.conflicts).toHaveLength(1)
    expect(read(shared)).toContain('from a')
  }))
})

describe('F13: items the user removed stay removed', () => {
  test('keys, tables, blocks and list items: reported, not re-created; restore puts them back', () => withSandbox(async (sb) => {
    const settings = join(sb.home, '.claude', 'settings.json')
    const toml = join(sb.home, '.codex', 'config.toml')
    const hooks = join(sb.home, '.codex', 'hooks.json')
    const md = join(sb.home, '.codex', 'AGENTS.md')
    write(settings, '{\n  "model": "opus"\n}\n')
    write(toml, 'model = "x"\n')
    write(hooks, '{\n  "hooks": {}\n}\n')
    const group = (e: string) => ({ hooks: [{ type: 'command', command: `buracle hook codex ${e}` }] })
    const ops: Op[] = [
      { kind: 'json-merge', path: settings, set: { statusLine: STATUS }, owner: O },
      { kind: 'toml-tables', path: toml, tables: { 'mcp_servers.chrome-devtools': { command: 'npx' } }, owner: 'codex' },
      { kind: 'json-list-merge', path: hooks, pointer: 'hooks.UserPromptSubmit', items: [group('UserPromptSubmit')], identity: ['matcher', 'hooks.0.command'], owner: 'codex' },
      { kind: 'md-block', path: md, id: 'buracle', content: 'rules', owner: 'codex' },
    ]
    expect((await applyPlans([plan(ops)])).conflicts).toEqual([])
    write(settings, '{\n  "model": "opus"\n}\n')
    write(toml, 'model = "x"\n')
    write(hooks, '{\n  "hooks": {\n    "UserPromptSubmit": []\n  }\n}\n')
    unlinkSync(md)
    const r = await applyPlans([plan(ops)])
    expect(r.applied).toBe(0)
    expect(r.conflicts).toHaveLength(4)
    for (const c of r.conflicts) expect(c.detail).toContain('removed since Buracle installed it; not re-creating it')
    expect(read(settings)).toBe('{\n  "model": "opus"\n}\n')
    expect(read(toml)).toBe('model = "x"\n')
    expect(existsSync(md)).toBe(false)
    const back = await applyPlans([plan(ops)], { restore: true })
    expect(back.conflicts).toEqual([])
    expect(JSON.parse(read(settings)).statusLine).toEqual(STATUS)
    expect(read(toml)).toContain('[mcp_servers.chrome-devtools]')
    expect((JSON.parse(read(hooks)) as { hooks: Record<string, unknown[]> }).hooks['UserPromptSubmit']).toEqual([group('UserPromptSubmit')])
    expect(read(md)).toContain('rules')
  }))

  test('a per-op restore decision (the core plan is always restored)', () => withSandbox(async (sb) => {
    const shim = join(sb.buracleHome, 'bin', 'buracle')
    const item = join(sb.home, '.claude', 'rules', 'x.md')
    const ops: Op[] = [{ kind: 'file', path: shim, content: '#!/bin/sh\n', owner: 'core' }, { kind: 'file', path: item, content: 'x\n', owner: O }]
    await applyPlans([plan(ops)])
    unlinkSync(shim)
    unlinkSync(item)
    const r = await applyPlans([plan(ops)], { restore: op => op.owner === 'core' })
    expect(existsSync(shim)).toBe(true)
    expect(existsSync(item)).toBe(false)
    expect(r.conflicts.map(c => c.op.owner)).toEqual([O])
  }))
})

describe('F16: read-only files are never rewritten', () => {
  test('merged files and owned files without the owner write bit are conflicts; bytes and mode stay', () => withSandbox(async (sb) => {
    const toml = join(sb.home, '.codex', 'config.toml')
    const hooks = join(sb.home, '.codex', 'hooks.json')
    const settings = join(sb.home, '.claude', 'settings.json')
    write(toml, '# user config, intentionally read-only\nmodel = "m"\n', 0o444)
    write(hooks, '{\n  "hooks": {}\n}\n', 0o444)
    write(settings, '{\n  "model": "opus"\n}\n', 0o444)
    const r = await applyPlans([plan([
      { kind: 'toml-tables', path: toml, tables: { 'mcp_servers.c7': { command: 'npx' } }, keys: { 'tui.status_line': ['model'] }, owner: 'codex' },
      { kind: 'json-list-merge', path: hooks, pointer: 'hooks.Stop', items: [{ hooks: [{ type: 'command', command: 'b' }] }], identity: 'hooks.0.command', owner: 'codex' },
      { kind: 'json-merge', path: settings, set: { statusLine: STATUS }, owner: O },
    ])])
    expect(r.applied).toBe(0)
    expect(r.conflicts.length).toBe(4)
    for (const c of r.conflicts) expect(c.detail).toMatch(/is read-only \(mode 444\); not touching it/)
    expect(read(toml)).toBe('# user config, intentionally read-only\nmodel = "m"\n')
    expect(statSync(toml).mode & 0o777).toBe(0o444)
    expect(read(settings)).toBe('{\n  "model": "opus"\n}\n')

    const owned = join(sb.home, '.codex', 'agents', 'a.toml')
    await applyPlans([plan([{ kind: 'file', path: owned, content: 'v1\n', owner: 'codex' }])])
    chmodSync(owned, 0o444)
    const up = await applyPlans([plan([{ kind: 'file', path: owned, content: 'v2\n', owner: 'codex' }])])
    expect(up.conflicts[0]?.detail).toContain('read-only')
    const rm = await applyPlans([plan([{ kind: 'remove', path: owned, owner: 'codex' }])])
    expect(rm.conflicts[0]?.detail).toContain('read-only')
    expect(read(owned)).toBe('v1\n')
  }))
})

describe('F06: an interrupted transaction', () => {
  async function startChild(sb: Sandbox, ops: Op[], slow: Op): Promise<{ child: ReturnType<typeof Bun.spawn>, txn: string }> {
    const script = join(sb.root, 'scripts', 'child.ts')
    write(script, [
      `import { applyPlans, isTxnInterrupted } from ${JSON.stringify(join(REPO, 'src', 'engine', 'txn.ts'))}`,
      `const ops = ${JSON.stringify([...ops, slow])}`,
      `try { await applyPlans([{ id: 'child', harness: 'claude', ops }]); process.exit(0) }`,
      `catch (e) { console.error(String(e)); process.exit(isTxnInterrupted(e) ? e.exitCode : 1) }`,
    ].join('\n'))
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env }, stdout: 'ignore', stderr: 'pipe' })
    const journalDir = join(sb.buracleHome, 'journal')
    let txn = ''
    for (let i = 0; i < 300 && txn === ''; i++) {
      await Bun.sleep(50)
      for (const n of existsSync(journalDir) ? readdirSync(journalDir) : []) {
        if (!n.endsWith('.json') || n.startsWith('_')) continue
        try {
          const j = JSON.parse(read(join(journalDir, n))) as { txn: string, execs: Array<{ started?: boolean }> }
          if (j.execs.some(e => e.started === true)) txn = j.txn
        } catch {  }
      }
    }
    expect(txn).not.toBe('')
    await Bun.sleep(400)
    return { child, txn }
  }

  // Bun's SIGINT and SIGTERM end a Windows process outright; no handler runs there.
  test.skipIf(IS_WINDOWS)('Ctrl-C (SIGINT) and SIGTERM roll back in-process: files, the half-run command, the lock', async () => {
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
      await withSandbox(async (sb) => {
        const p = join(sb.home, '.claude', 'settings.json')
        write(p, '{\n  "model": "opus"\n}\n')
        const marker = join(sb.root, 'registered')
        const { child, txn } = await startChild(sb, [{ kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O }],
          { kind: 'exec', argv: ['sh', '-c', `touch '${marker}'; sleep 30`], undo: ['rm', '-f', marker], owner: O })
        child.kill(sig)
        expect(await child.exited).toBe(code)
        expect(read(p)).toBe('{\n  "model": "opus"\n}\n')
        expect(existsSync(marker)).toBe(false)
        const j = await readJournal(txn)
        expect(j.status).toBe('rolled-back')
        expect(j.error).toContain(`interrupted by ${sig}`)
        expect(existsSync(join(sb.buracleHome, 'state', 'txn.lock'))).toBe(false)
        expect(await readLedger()).toEqual({})
      })
    }
  }, 60_000)

  test('after SIGKILL, recovery undoes Buracle\'s keys in a file the command rewrote; the next install owns its value (not adopted)', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "model": "opus"\n}\n')
    const op: Op = { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O }
    const { child, txn } = await startChild(sb, [op], {
      kind: 'exec', owner: O,
      argv: [process.execPath, '-e', `const fs=require('fs');const p=${JSON.stringify(p)};const s=JSON.parse(fs.readFileSync(p,'utf8'));s.extraKnownMarketplaces={x:{source:'github'}};fs.writeFileSync(p,JSON.stringify(s,null,2)+'\\n');setTimeout(() => {}, 30000)`],
      undo: jsonEdit(p, '(({extraKnownMarketplaces, ...rest}) => rest)(s)'),
    })
    // The command needs its own start-up time before it rewrites the file (seconds on Windows).
    for (let i = 0; i < 300 && !read(p).includes('extraKnownMarketplaces'); i++) await Bun.sleep(50)
    child.kill('SIGKILL')
    await child.exited
    const childErr = await new Response(child.stderr as ReadableStream).text()
    expect({ settings: JSON.parse(read(p)), childErr }).toEqual({ settings: { model: 'opus', statusLine: STATUS, extraKnownMarketplaces: { x: { source: 'github' } } }, childErr: '' })
    const r = await applyPlans([plan([op])])
    expect(r.recovered).toEqual([txn])
    expect((await readJournal(txn)).status).toBe('rolled-back')
    const led = await readLedger()
    expect(led[ledgerKey(p, 'statusLine')]?.adopted).toBeUndefined()
    await applyPlans([plan([{ kind: 'remove', path: ledgerKey(p, 'statusLine'), owner: O }])])
    expect(JSON.parse(read(p))).toEqual({ model: 'opus' })
  }), 30_000)

  test('a value recovery cannot undo stays recorded as Buracle\'s (pending), so it is never adopted', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "model": "opus"\n}\n')
    const op: Op = { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O }
    // A command that only waits, started the same way on every platform.
    const { child, txn } = await startChild(sb, [op], { kind: 'exec', argv: [process.execPath, '-e', 'setTimeout(() => {}, 30000)'], owner: O })
    child.kill('SIGKILL')
    await child.exited
    const childErr = await new Response(child.stderr as ReadableStream).text()
    expect({ settings: JSON.parse(read(p)), childErr }).toEqual({ settings: { model: 'opus', statusLine: STATUS }, childErr: '' })
    const broken = read(p).replace('"model"', '// my note\n  "model"')
    writeFileSync(p, broken)
    await expect(applyPlans([plan([{ kind: 'file', path: join(sb.home, 'other.txt'), content: 'x', owner: O }])])).rejects.toThrow(/could not be rolled back completely/)
    expect((await readJournal(txn)).status).toBe('rollback-failed')
    expect((await readLedger())[ledgerKey(p, 'statusLine')]?.adopted).toBeUndefined()
    expect((await readLedger())[ledgerKey(p, 'statusLine')]?.owner).toBe(O)
    writeFileSync(p, broken.replace('// my note\n  ', ''))
    const again = await applyPlans([plan([op])])
    expect(again.conflicts).toEqual([])
    expect((await readLedger())[ledgerKey(p, 'statusLine')]?.adopted).toBeUndefined()
  }), 30_000)
})

describe('rollbackTxn after the user edited a merged file', () => {
  test('Buracle\'s keys are undone; the user\'s later edits stay', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "model": "opus"\n}\n')
    const r = await applyPlans([plan([{ kind: 'json-merge', path: p, set: { statusLine: STATUS, 'env.A': '1' }, owner: O }])])
    const cur = JSON.parse(read(p)) as Record<string, unknown>
    writeFileSync(p, JSON.stringify({ ...cur, theme: 'light', env: { A: 'mine' } }, null, 2) + '\n')
    const rep = await rollbackTxn(r.txn)
    expect(rep.errors).toEqual([])
    expect(rep.skipped).toEqual([])
    expect(rep.warnings.some(w => w.includes('env.A was changed after the transaction; kept'))).toBe(true)
    expect(JSON.parse(read(p))).toEqual({ model: 'opus', theme: 'light', env: { A: 'mine' } })
    expect((await readLedger())[ledgerKey(p, 'statusLine')]).toBeUndefined()
  }))
})

describe('I3: cleanup keys', () => {
  test('an empty container a command left, absent before the first install, goes on removal; a user\'s one stays', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    const original = '{\n  "model": "opus"\n}\n'
    write(p, original)
    const install: Plan = plan([
      { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O },
      { kind: 'exec', argv: jsonEdit(p, '({...s, enabledPlugins: {...(s.enabledPlugins||{}), "buracle@buracle": true}})'), undo: jsonEdit(p, '({...s, enabledPlugins: {}})'), owner: O },
    ], { cleanupKeys: [{ path: p, pointer: 'enabledPlugins' }, { path: p, pointer: 'extraKnownMarketplaces' }] })
    const r = await applyPlans([install])
    expect(r.conflicts).toEqual([])
    const led = await readLedger()
    expect(led[cleanupLedgerKey(p, 'enabledPlugins')]).toMatchObject({ kind: 'cleanup', absentBefore: true, owner: 'claude' })
    Bun.spawnSync(jsonEdit(p, '({...s, enabledPlugins: {}})'))
    const keys = Object.keys(await readLedger()).sort((a, b) => (a.includes('#cleanup:') ? -1 : b.includes('#cleanup:') ? 1 : 0))
    const u = await applyPlans([plan(keys.map(k => ({ kind: 'remove', path: k, owner: O }) as Op))])
    expect(u.conflicts).toEqual([])
    expect(JSON.parse(read(p))).toEqual({ model: 'opus' })
    expect(await readLedger()).toEqual({})
  }))

  test('a key that existed before the first install is never removed', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{\n  "enabledPlugins": {}\n}\n')
    await applyPlans([plan([{ kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O }], { cleanupKeys: [{ path: p, pointer: 'enabledPlugins' }] })])
    expect((await readLedger())[cleanupLedgerKey(p, 'enabledPlugins')]?.absentBefore).toBeUndefined()
    const keys = Object.keys(await readLedger())
    await applyPlans([plan(keys.map(k => ({ kind: 'remove', path: k, owner: O }) as Op))])
    expect(JSON.parse(read(p))).toEqual({ enabledPlugins: {} })
  }))

  test('a rollback removes the empty leftover too (the transaction\'s own backup is the proof)', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.claude', 'settings.json')
    const original = '{\n  "model": "opus"\n}\n'
    write(p, original)
    const r = await applyPlans([plan([
      { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O },
      { kind: 'exec', argv: jsonEdit(p, '({...s, enabledPlugins: {"a@b": true}})'), undo: jsonEdit(p, '({...s, enabledPlugins: {}})'), owner: O },
    ], { cleanupKeys: [{ path: p, pointer: 'enabledPlugins' }] })])
    const rep = await rollbackTxn(r.txn)
    expect(rep.errors).toEqual([])
    expect(JSON.parse(read(p))).toEqual({ model: 'opus' })
  }))
})

describe('F12: a lost ownership ledger', () => {
  test('is rebuilt from the committed journals: nothing is mistaken for the user\'s, removal still works', () => withSandbox(async (sb) => {
    const f = join(sb.home, '.codex', 'rules', 'buracle.rules')
    const p = join(sb.home, '.claude', 'settings.json')
    write(p, '{}\n')
    await applyPlans([plan([{ kind: 'file', path: f, content: 'rules\n', owner: 'codex' }, { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O }])])
    const before = await readLedger()
    unlinkSync(join(sb.buracleHome, 'state', 'owned.json'))
    expect(await readLedger()).toEqual(before)
    const again = await applyPlans([plan([{ kind: 'file', path: f, content: 'rules v2\n', owner: 'codex' }, { kind: 'json-merge', path: p, set: { statusLine: STATUS }, owner: O }])])
    expect(again.warnings.some(w => w.includes('was missing; it was rebuilt from 1 committed transaction(s)'))).toBe(true)
    expect(again.conflicts).toEqual([])
    expect(read(f)).toBe('rules v2\n')
    const led = await readLedger()
    expect(Object.values(led).some(e => e.adopted === true)).toBe(false)
    await applyPlans([plan(Object.keys(led).map(k => ({ kind: 'remove', path: k, owner: led[k]?.owner ?? O }) as Op))])
    expect(existsSync(f)).toBe(false)
    expect(JSON.parse(read(p))).toEqual({})
  }))

  test('takeOwnership records values equal to Buracle\'s as Buracle\'s (when no journal is left)', () => withSandbox(async (sb) => {
    const f = join(sb.home, '.codex', 'rules', 'buracle.rules')
    write(f, 'rules\n')
    await applyPlans([plan([{ kind: 'file', path: f, content: 'rules\n', owner: 'codex' }])], { takeOwnership: true })
    expect((await readLedger())[f]?.adopted).toBeUndefined()
    await applyPlans([plan([{ kind: 'remove', path: f, owner: 'codex' }])])
    expect(existsSync(f)).toBe(false)
  }))
})

describe('F23: retention and private backups', () => {
  test('backups are 0700/0600; old ones are pruned, old journals folded into the checkpoint', () => withSandbox(async (sb) => {
    const f = join(sb.home, 'f.txt')
    write(f, 'user\n')
    const first = await applyPlans([plan([{ kind: 'json-merge', path: join(sb.home, 's.json'), set: { a: 0 }, owner: O }])])
    const backups = join(sb.buracleHome, 'backups')
    if (KEEPS_MODES) {
      expect(statSync(backups).mode & 0o777).toBe(0o700)
      expect(statSync(join(backups, first.txn)).mode & 0o777).toBe(0o700)
      expect(statSync(join(sb.buracleHome, 'journal')).mode & 0o777).toBe(0o700)
    }
    const second = await applyPlans([plan([{ kind: 'json-merge', path: join(sb.home, 's.json'), set: { a: 1 }, owner: O }])])
    expect(existsSync(join(backups, second.txn, 'files', '0'))).toBe(true)
    if (KEEPS_MODES) expect(statSync(join(backups, second.txn, 'files', '0')).mode & 0o777).toBe(0o600)
    for (let i = 2; i < RETENTION.journals + 5; i++) {
      await applyPlans([plan([{ kind: 'json-merge', path: join(sb.home, 's.json'), set: { a: i }, owner: O }])])
    }
    const txns = await listTxns()
    expect(txns.length).toBe(RETENTION.journals)
    expect(readdirSync(backups).length).toBe(RETENTION.backups)
    expect(txns[RETENTION.backups]?.backupsPruned).toBe(true)
    await expect(rollbackTxn(txns[RETENTION.backups + 1]?.txn)).rejects.toThrow(/too old to roll back/)
    const led = await readLedger()
    unlinkSync(join(sb.buracleHome, 'state', 'owned.json'))
    expect(await readLedger()).toEqual(led)
    expect(await historyCreatedDirs()).toEqual([])
  }), 60_000)
})

describe('F18: an undo that would restore a path that no longer exists', () => {
  test('rollback marks it done with a warning instead of failing forever', () => withSandbox(async (sb) => {
    const oldCheckout = join(sb.root, 'old-checkout')
    const newCheckout = join(sb.root, 'new-checkout')
    mkdirSync(newCheckout)
    const log = join(sb.root, 'log')
    const tool = fakeExe(join(sb.root, 'bin', 'tool'), `append(${JSON.stringify(log)}, argv.join(' '))\nif (!fs.existsSync(argv[1] ?? '')) process.exit(1)`)
    const r = await applyPlans([plan([{ kind: 'exec', argv: [tool, 'add', newCheckout], undo: [tool, 'add', oldCheckout], owner: O }])])
    const rep = await rollbackTxn(r.txn)
    expect(rep.errors).toEqual([])
    expect(rep.warnings.some(w => w.includes(`${oldCheckout} no longer exists; nothing to put back`))).toBe(true)
    expect(read(log)).toBe(`add ${newCheckout}\n`)
    expect((await readJournal(r.txn)).status).toBe('rolled-back')
  }))
})

describe('F09: withTxnLock', () => {
  test('holds the lock for a whole sequence; engine calls inside run under it', () => withSandbox(async (sb) => {
    const lock = join(sb.buracleHome, 'state', 'txn.lock')
    await withTxnLock(async () => {
      expect(existsSync(lock)).toBe(true)
      await applyPlans([plan([{ kind: 'file', path: join(sb.home, 'a'), content: 'a', owner: O }])])
      expect(existsSync(lock)).toBe(true)
      await applyPlans([plan([{ kind: 'file', path: join(sb.home, 'b'), content: 'b', owner: O }])])
    })
    expect(existsSync(lock)).toBe(false)
    expect(read(join(sb.home, 'b'))).toBe('b')
  }))
})

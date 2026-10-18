import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { jsoncParse } from '../../src/engine/merge'
import {
  applyPlans, diffPlan, LIST_IDENTITY_HASH, listIdentity, listLedgerKey, listPointerOf, readLedger, rollbackTxn,
  type JsonListMergeOp, type Op, type Plan,
} from '../../src/engine/txn'
import { withEnv, withSandbox } from '../helpers/sandbox'

const OWNER = 'codex'
const ID = ['matcher', 'hooks.0.command']
const cmd = (e: string) => `"$HOME/.buracle/bin/buracle" hook codex ${e}`
const handler = (e: string, timeout: number, extra: Record<string, unknown> = {}) => ({ type: 'command', command: cmd(e), timeout, ...extra })

const OURS: Record<string, unknown[]> = {
  PreToolUse: [{ matcher: 'Bash|apply_patch', hooks: [handler('PreToolUse', 10)] }],
  PostToolUse: [
    { matcher: 'apply_patch', hooks: [handler('PostToolUse', 45, { statusMessage: 'Buracle: checking edited files' })] },
    { matcher: 'Bash', hooks: [handler('PostToolUse', 15, { async: true })] },
  ],
}

const USER_HOOKS = `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/guard.py",
            "timeout": 5
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "say done"
          }
        ]
      }
    ]
  }
}
`

function plan(ops: Op[], id = 'codex'): Plan {
  return { id, harness: 'codex', ops }
}

function listOps(path: string, groups: Record<string, unknown[]>, extra: Partial<JsonListMergeOp> = {}): JsonListMergeOp[] {
  return Object.entries(groups).map(([event, items]) => ({ kind: 'json-list-merge', path, pointer: `hooks.${event}`, items, identity: ID, owner: OWNER, ...extra }))
}

function removeOps(path: string, events: string[]): Op[] {
  return events.map(e => ({ kind: 'remove', path: listLedgerKey(path, `hooks.${e}`), owner: OWNER }))
}

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

function write(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

function hooksOf(p: string): Record<string, unknown[]> {
  return (JSON.parse(read(p)) as { hooks: Record<string, unknown[]> }).hooks
}

describe('identity rules', () => {
  test('field path, composite and hash', () => {
    const item = { matcher: 'Bash', hooks: [{ command: 'x' }] }
    expect(listIdentity('hooks.0.command')(item)).toBe('"x"')
    expect(listIdentity('nope')(item)).toBeUndefined()
    expect(listIdentity(ID)(item)).toBe('["Bash","x"]')
    expect(listIdentity(ID)({ hooks: [{ command: 'x' }] })).toBe('[null,"x"]')
    expect(listIdentity(ID)({ other: 1 })).toBeUndefined()
    expect(listIdentity(LIST_IDENTITY_HASH)(item)).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(listIdentity(LIST_IDENTITY_HASH)({ b: 1, a: 2 })).toBe(listIdentity(LIST_IDENTITY_HASH)({ a: 2, b: 1 }))
    expect(listPointerOf('hooks.PreToolUse')).toBe('hooks.PreToolUse[]')
    expect(listLedgerKey('/x/hooks.json', ['hooks', 'Pre Tool'])).toBe('/x/hooks.json#hooks."Pre Tool"[]')
  })

  test('invalid ops are refused before anything is written', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    const base = { kind: 'json-list-merge', path: p, pointer: 'hooks.Stop', identity: ID, owner: OWNER } as const
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base, items: [OURS['PreToolUse']?.[0], OURS['PreToolUse']?.[0]] }, /share the identity/],
      [{ ...base, items: [{ unrelated: true }] }, /has no identity/],
      [{ ...base, items: 'x' }, /items must be a list/],
      [{ ...base, items: [undefined] }, /not a JSON value/],
      [{ ...base, items: [], identity: '' }, /identity must be/],
      [{ ...base, items: [], identity: [] }, /identity must be/],
      [{ ...base, items: [], format: 'yaml' }, /format must be json or jsonc/],
      [{ ...base, items: [], pointer: '' }, /pointer is required/],
    ]
    for (const [op, why] of bad) await expect(applyPlans([plan([op as unknown as Op])])).rejects.toThrow(why)
    await expect(applyPlans([plan([{ kind: 'file', path: p, content: '{}', owner: OWNER }, { ...base, items: [] } as Op])])).rejects.toThrow(/both whole-file and content-merge/)
    expect(existsSync(p)).toBe(false)
  }))
})

describe('json-list-merge', () => {
  test('creates the file, its parents and the arrays; is idempotent; uninstall removes all of it (either order)', () => withSandbox(async (sb) => {
    for (const order of [['PreToolUse', 'PostToolUse'], ['PostToolUse', 'PreToolUse']]) {
      const p = join(sb.home, `.codex-${order[0]}`, 'hooks.json')
      const r1 = await applyPlans([plan(listOps(p, OURS))])
      expect(r1.conflicts).toEqual([])
      expect(r1.applied).toBe(2)
      expect(hooksOf(p)).toEqual(OURS)
      expect(read(p).endsWith('\n')).toBe(true)
      const led = await readLedger()
      const pre = led[listLedgerKey(p, 'hooks.PreToolUse')]
      expect(pre).toMatchObject({ owner: OWNER, kind: 'json-list', pointer: 'hooks.PreToolUse[]', segs: ['hooks', 'PreToolUse'], identity: ID, created: ['', 'hooks', 'hooks.PreToolUse'] })
      expect(pre?.items).toEqual([{ id: listIdentity(ID)(OURS['PreToolUse']?.[0]) as string, sha256: expect.any(String) as unknown as string }])
      expect(led[listLedgerKey(p, 'hooks.PostToolUse')]?.created).toEqual(['hooks.PostToolUse'])
      expect(led[listLedgerKey(p, 'hooks.PostToolUse')]?.items?.length).toBe(2)

      const again = await applyPlans([plan(listOps(p, OURS))])
      expect(again).toMatchObject({ txn: '', applied: 0, conflicts: [] })
      expect(again.skipped.map(s => s.reason)).toEqual(['unchanged', 'unchanged'])

      const u = await applyPlans([plan(removeOps(p, order as string[]))])
      expect(u.conflicts).toEqual([])
      expect(existsSync(p)).toBe(false)
      expect(Object.keys(await readLedger()).filter(k => k.startsWith(p))).toEqual([])
      const u2 = await applyPlans([plan(removeOps(p, order as string[]))])
      expect(u2).toMatchObject({ txn: '', applied: 0, conflicts: [] })
    }
  }))

  test("the user's items and events stay byte for byte; uninstall gives the original file back", () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    write(p, USER_HOOKS)
    const r = await applyPlans([plan(listOps(p, OURS))])
    expect(r.conflicts).toEqual([])
    const text = read(p)
    expect(text).toContain('"command": "python3 ~/guard.py",\n            "timeout": 5\n          }\n        ]\n      },\n      {')
    const hooks = hooksOf(p)
    expect(hooks['PreToolUse']).toEqual([(JSON.parse(USER_HOOKS) as { hooks: Record<string, unknown[]> }).hooks['PreToolUse']?.[0], ...(OURS['PreToolUse'] ?? [])])
    expect(hooks['Notification']).toEqual((JSON.parse(USER_HOOKS) as { hooks: Record<string, unknown[]> }).hooks['Notification'])
    expect(hooks['PostToolUse']).toEqual(OURS['PostToolUse'])
    const led = await readLedger()
    expect(led[listLedgerKey(p, 'hooks.PreToolUse')]?.created).toBeUndefined()
    expect(led[listLedgerKey(p, 'hooks.PostToolUse')]?.created).toEqual(['hooks.PostToolUse'])

    const u = await applyPlans([plan(removeOps(p, ['PreToolUse', 'PostToolUse']))])
    expect(u.conflicts).toEqual([])
    expect(read(p)).toBe(USER_HOOKS)
  }))

  test("an update replaces Buracle's item in place; items it dropped go, new ones are appended", () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    write(p, USER_HOOKS)
    await applyPlans([plan(listOps(p, OURS))])
    const later = { matcher: 'Read', hooks: [{ type: 'command', command: 'audit.sh' }] }
    const hooks = hooksOf(p)
    hooks['PreToolUse'] = [...(hooks['PreToolUse'] ?? []), later]
    write(p, JSON.stringify({ hooks }, null, 2) + '\n')

    const v2Pre = [{ matcher: 'Bash|apply_patch', hooks: [handler('PreToolUse', 12)] }]
    const v2Post = [OURS['PostToolUse']?.[0], { matcher: 'Bash|exec_command', hooks: [handler('PostToolUse', 15, { async: true })] }]
    const r = await applyPlans([plan(listOps(p, { PreToolUse: v2Pre, PostToolUse: v2Post as unknown[] }))])
    expect(r.conflicts).toEqual([])
    const after = hooksOf(p)
    expect(after['PreToolUse']).toEqual([(JSON.parse(USER_HOOKS) as { hooks: Record<string, unknown[]> }).hooks['PreToolUse']?.[0], ...v2Pre, later])
    expect(after['PostToolUse']).toEqual(v2Post)
    const items = (await readLedger())[listLedgerKey(p, 'hooks.PostToolUse')]?.items ?? []
    expect(items.map(i => i.id)).toEqual(v2Post.map(g => listIdentity(ID)(g) as string))
  }))

  test('a user-modified item of Buracle is kept and reported, never duplicated; reverting it hands it back', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    await applyPlans([plan(listOps(p, { PreToolUse: OURS['PreToolUse'] ?? [] }))])
    const original = read(p)
    write(p, original.replace('"timeout": 10', '"timeout": 99'))
    const v2 = [{ matcher: 'Bash|apply_patch', hooks: [handler('PreToolUse', 12)] }]
    const r = await applyPlans([plan(listOps(p, { PreToolUse: v2 }))])
    expect(r.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('modified outside Buracle; keeping the user') as unknown as string])
    expect(hooksOf(p)['PreToolUse']?.length).toBe(1)
    expect(read(p)).toContain('"timeout": 99')
    const u = await applyPlans([plan(removeOps(p, ['PreToolUse']))])
    expect(u.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('was modified outside Buracle; not removing it') as unknown as string])
    expect(read(p)).toContain('"timeout": 99')
    expect((await readLedger())[listLedgerKey(p, 'hooks.PreToolUse')]).toBeDefined()
    write(p, original)
    const back = await applyPlans([plan(listOps(p, { PreToolUse: v2 }))])
    expect(back.conflicts).toEqual([])
    expect(hooksOf(p)['PreToolUse']).toEqual(v2)
  }))

  test("an identical item the user already had is adopted: never updated, never removed", () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    write(p, JSON.stringify({ hooks: { PreToolUse: OURS['PreToolUse'] } }, null, 2) + '\n')
    const r = await applyPlans([plan(listOps(p, { PreToolUse: OURS['PreToolUse'] ?? [] }))])
    expect(r).toMatchObject({ applied: 0, conflicts: [] })
    expect((await readLedger())[listLedgerKey(p, 'hooks.PreToolUse')]?.items?.[0]?.adopted).toBe(true)
    const v2 = [{ matcher: 'Bash|apply_patch', hooks: [handler('PreToolUse', 12)] }]
    const upd = await applyPlans([plan(listOps(p, { PreToolUse: v2 }))])
    expect(upd.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('set by the user before Buracle') as unknown as string])
    expect(hooksOf(p)['PreToolUse']).toEqual(OURS['PreToolUse'])
    const before = read(p)
    const u = await applyPlans([plan(removeOps(p, ['PreToolUse']))])
    expect(u.conflicts).toEqual([])
    expect(read(p)).toBe(before)
    expect((await readLedger())[listLedgerKey(p, 'hooks.PreToolUse')]).toBeUndefined()
  }))

  test("the user's own item with Buracle's identity is a conflict; nothing is added", () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    const theirs = { matcher: 'Bash|apply_patch', hooks: [handler('PreToolUse', 3)] }
    write(p, JSON.stringify({ hooks: { PreToolUse: [theirs] } }, null, 2) + '\n')
    const before = read(p)
    const r = await applyPlans([plan(listOps(p, { PreToolUse: OURS['PreToolUse'] ?? [] }))])
    expect(r.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('already defined by the user') as unknown as string])
    expect(read(p)).toBe(before)
    expect((await readLedger())[listLedgerKey(p, 'hooks.PreToolUse')]).toBeUndefined()
  }))

  test("when every wanted item is the user's and the old ones are gone, nothing stays in the ledger", () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    await applyPlans([plan(listOps(p, { PreToolUse: OURS['PreToolUse'] ?? [] }))])
    const theirs = { matcher: 'Read', hooks: [handler('PreToolUse', 3)] }
    const hooks = hooksOf(p)
    hooks['PreToolUse'] = [...(hooks['PreToolUse'] ?? []), theirs]
    write(p, JSON.stringify({ hooks }, null, 2) + '\n')
    const r = await applyPlans([plan(listOps(p, { PreToolUse: [{ matcher: 'Read', hooks: [handler('PreToolUse', 10)] }] }))])
    expect(r.conflicts.map(c => c.detail)).toEqual([expect.stringContaining('already defined by the user') as unknown as string])
    expect(hooksOf(p)['PreToolUse']).toEqual([theirs])
    expect((await readLedger())[listLedgerKey(p, 'hooks.PreToolUse')]).toBeUndefined()
  }))

  test('not a list, unparsable, another owner: conflicts, file untouched', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    write(p, '{ "hooks": { "PreToolUse": "nope" } }\n')
    expect((await applyPlans([plan(listOps(p, { PreToolUse: OURS['PreToolUse'] ?? [] }))])).conflicts[0]?.detail).toContain('is not a list')
    write(p, '{ "hooks": ')
    expect((await applyPlans([plan(listOps(p, { PreToolUse: OURS['PreToolUse'] ?? [] }))])).conflicts[0]?.detail).toContain('not valid JSON')
    expect(read(p)).toBe('{ "hooks": ')
    write(p, '{}\n')
    await applyPlans([plan(listOps(p, { PreToolUse: OURS['PreToolUse'] ?? [] }))])
    const other = await applyPlans([plan(listOps(p, { PreToolUse: OURS['PreToolUse'] ?? [] }, { owner: 'opencode' }))])
    expect(other.conflicts[0]?.detail).toContain('managed by codex, not opencode')
  }))

  test('an empty item list removes what Buracle manages there', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    write(p, USER_HOOKS)
    await applyPlans([plan(listOps(p, OURS))])
    const r = await applyPlans([plan(listOps(p, { PreToolUse: [], PostToolUse: [] }))])
    expect(r.conflicts).toEqual([])
    expect(read(p)).toBe(USER_HOOKS)
    expect(Object.keys(await readLedger()).filter(k => k.startsWith(p))).toEqual([])
  }))

  test('hash identity: a changed item is a new item; it takes the place of the one Buracle no longer ships', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    write(p, USER_HOOKS)
    const v1 = OURS['PostToolUse'] ?? []
    await applyPlans([plan(listOps(p, { PostToolUse: v1 }, { identity: LIST_IDENTITY_HASH }))])
    const changed = { matcher: 'apply_patch', hooks: [handler('PostToolUse', 50)] }
    const v2 = [v1[1], changed]
    const r = await applyPlans([plan(listOps(p, { PostToolUse: v2 }, { identity: LIST_IDENTITY_HASH }))])
    expect(r.conflicts).toEqual([])
    expect(hooksOf(p)['PostToolUse']).toEqual([changed, v1[1]])
    const keys = Object.keys(await readLedger())
    await applyPlans([plan(keys.map(k => ({ kind: 'remove', path: k, owner: OWNER }) as Op))])
    expect(hooksOf(p)['PostToolUse']).toBeUndefined()
  }))

  test('F03: when a Buracle group changes its identity, the user\'s later groups keep their indexes (and so their /hooks trust)', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    write(p, USER_HOOKS)
    const ours = OURS['PreToolUse'] ?? []
    await applyPlans([plan(listOps(p, { PreToolUse: ours }))])
    const doc = JSON.parse(read(p)) as { hooks: Record<string, unknown[]> }
    const later = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo audit', timeout: 5 }] }
    doc.hooks['PreToolUse']?.push(later)
    write(p, JSON.stringify(doc, null, 2) + '\n')
    const next = [{ matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: '"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" hook codex PreToolUse', timeout: 10 }] }]
    const r = await applyPlans([plan(listOps(p, { PreToolUse: next }))])
    expect(r.conflicts).toEqual([])
    const list = hooksOf(p)['PreToolUse'] ?? []
    expect(list.length).toBe(3)
    expect(list[1]).toEqual(next[0])
    expect(list[2]).toEqual(later)
  }))

  test('JSONC: comments and trailing commas survive install and uninstall', () => withSandbox(async (sb) => {
    const p = join(sb.home, 'cfg.jsonc')
    const original = '{\n  // my hooks\n  "hooks": {\n    "Stop": [\n      { "hooks": [] }, // mine\n    ],\n  },\n}\n'
    write(p, original)
    const ours = [{ hooks: [handler('Stop', 20)] }]
    const r = await applyPlans([plan([{ kind: 'json-list-merge', path: p, pointer: 'hooks.Stop', items: ours, identity: 'hooks.0.command', owner: OWNER, format: 'jsonc' }])])
    expect(r.conflicts).toEqual([])
    expect(read(p)).toContain('// my hooks')
    expect(read(p)).toContain('// mine')
    const parsed = jsoncParse(read(p))
    expect(parsed.ok && (parsed.value as { hooks: { Stop: unknown[] } }).hooks.Stop).toEqual([{ hooks: [] }, ...ours])
    expect((await readLedger())[listLedgerKey(p, 'hooks.Stop')]?.kind).toBe('jsonc-list')
    expect((await applyPlans([plan([{ kind: 'json-list-merge', path: p, pointer: 'hooks.Other', items: ours, identity: 'hooks.0.command', owner: OWNER }])])).conflicts[0]?.detail).toContain('not valid JSON')
    const u = await applyPlans([plan([{ kind: 'remove', path: listLedgerKey(p, 'hooks.Stop'), owner: OWNER }])])
    expect(u.conflicts).toEqual([])
    expect(jsoncParse(read(p))).toEqual(jsoncParse(original))
    expect(read(p)).toContain('// mine')
  }))

  test('rollback-safe: an injected failure changes nothing; rollbackTxn restores the file exactly', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    write(p, USER_HOOKS)
    await expect(withEnv({ BURACLE_TXN_FAIL_AT: '1' }, () => applyPlans([plan(listOps(p, OURS))]))).rejects.toThrow(/rolled back/)
    expect(read(p)).toBe(USER_HOOKS)
    expect(Object.keys(await readLedger()).filter(k => k.startsWith(p))).toEqual([])
    const r = await applyPlans([plan(listOps(p, OURS))])
    const report = await rollbackTxn(r.txn)
    expect(report.errors).toEqual([])
    expect(read(p)).toBe(USER_HOOKS)
    expect(Object.keys(await readLedger()).filter(k => k.startsWith(p))).toEqual([])
    const again = await applyPlans([plan(listOps(p, OURS))])
    const installed = read(p)
    expect(again.conflicts).toEqual([])
    const u = await applyPlans([plan(removeOps(p, ['PreToolUse', 'PostToolUse']))])
    expect(read(p)).toBe(USER_HOOKS)
    await rollbackTxn(u.txn)
    expect(read(p)).toBe(installed)
    expect(Object.keys(await readLedger()).filter(k => k.startsWith(p)).length).toBe(2)
  }))

  test('diffPlan previews the list change', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    write(p, USER_HOOKS)
    const d = await diffPlan(plan(listOps(p, { PreToolUse: OURS['PreToolUse'] ?? [] })))
    expect(d).toContain(`+++ ${p}`)
    expect(d).toContain(`+        "matcher": "Bash|apply_patch",`)
    expect(read(p)).toBe(USER_HOOKS)
  }))
})

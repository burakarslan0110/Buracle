import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyPlans, cleanupLedgerKey, readLedger, rollbackTxn, type Op, type Plan } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

const O = 'opencode'

function jsonWrite(path: string, expr: string): string[] {
  return [process.execPath, '-e', `const fs=require('fs');const p=${JSON.stringify(path)};let s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch{};fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify((${expr}),null,2)+'\\n')`]
}

function plan(ops: Op[], extra: Partial<Plan> = {}): Plan {
  return { id: O, harness: 'opencode', ops, ...extra }
}

function installPlan(home: string, service: string): Plan {
  return plan([
    { kind: 'file', path: join(home, '.config', 'opencode', 'agents', 'review.md'), content: '# r\n', owner: O },
    { kind: 'exec', argv: jsonWrite(service, '({...s, env: {...(s.env||{}), BURACLE_HOME: "/b"}})'), undo: jsonWrite(service, '(() => { const e = {...(s.env||{})}; delete e.BURACLE_HOME; const o = {...s, env: e}; if (Object.keys(e).length === 0) delete o.env; return o })()'), owner: O },
  ], { cleanupKeys: [{ path: service, pointer: '' }] })
}

async function uninstall(service: string): Promise<void> {
  const led = await readLedger()
  const undo = Object.keys(led).length > 0 ? jsonWrite(service, '(() => { const e = {...(s.env||{})}; delete e.BURACLE_HOME; const o = {...s, env: e}; if (Object.keys(e).length === 0) delete o.env; return o })()') : []
  if (undo.length > 0) Bun.spawnSync(undo)
  const keys = Object.keys(led).sort((a, b) => (a.includes('#cleanup:') ? -1 : b.includes('#cleanup:') ? 1 : 0))
  const r = await applyPlans([plan(keys.map(k => ({ kind: 'remove', path: k, owner: O }) as Op))])
  expect(r.conflicts).toEqual([])
}

describe('I3 cleanup of a whole file (pointer \'\')', () => {
  test('a file a command created goes at uninstall once only `{}` is left', () => withSandbox(async ({ home }) => {
    const service = join(home, '.config', 'opencode', 'service.json')
    const r = await applyPlans([installPlan(home, service)])
    expect(r.conflicts).toEqual([])
    expect(JSON.parse(readFileSync(service, 'utf8'))).toEqual({ env: { BURACLE_HOME: '/b' } })
    expect((await readLedger())[cleanupLedgerKey(service, '')]).toMatchObject({ kind: 'cleanup', absentBefore: true, segs: [] })
    await uninstall(service)
    expect(existsSync(service)).toBe(false)
    expect(await readLedger()).toEqual({})
  }))

  test('a file the user had before the first install stays, even when it is empty', () => withSandbox(async ({ home }) => {
    const service = join(home, '.config', 'opencode', 'service.json')
    mkdirSync(dirname(service), { recursive: true })
    writeFileSync(service, '{}\n')
    await applyPlans([installPlan(home, service)])
    expect((await readLedger())[cleanupLedgerKey(service, '')]?.absentBefore).toBeUndefined()
    await uninstall(service)
    expect(readFileSync(service, 'utf8')).toBe('{}\n')
  }))

  test('a file that holds something of the user\'s stays', () => withSandbox(async ({ home }) => {
    const service = join(home, '.config', 'opencode', 'service.json')
    await applyPlans([installPlan(home, service)])
    Bun.spawnSync(jsonWrite(service, '({...s, port: 4096})'))
    await uninstall(service)
    expect(JSON.parse(readFileSync(service, 'utf8'))).toEqual({ port: 4096 })
  }))

  test('a rollback of the install removes the empty file too', () => withSandbox(async ({ home }) => {
    const service = join(home, '.config', 'opencode', 'service.json')
    const r = await applyPlans([installPlan(home, service)])
    const back = await rollbackTxn(r.txn)
    expect(back.errors).toEqual([])
    expect(existsSync(service)).toBe(false)
  }))
})

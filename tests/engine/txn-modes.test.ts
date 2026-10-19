import { afterEach, describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { applyPlans, txnTestHooks, type Op, type Plan } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

const OWNER = 'test'

function plan(ops: Op[]): Plan {
  return { id: 'p', harness: 'core', ops }
}

describe('file modes on a file system that keeps none (Windows)', () => {
  afterEach(() => { delete txnTestHooks.keepsModes })

  test('a mode alone is no change, so an unchanged file is not rewritten', () => withSandbox(async (sb) => {
    txnTestHooks.keepsModes = false
    const p = join(sb.home, '.codex', 'hooks.json')
    const r1 = await applyPlans([plan([{ kind: 'file', path: p, content: '{}\n', owner: OWNER }])])
    expect(r1.applied).toBe(1)
    expect(r1.conflicts).toEqual([])
    const r2 = await applyPlans([plan([{ kind: 'file', path: p, content: '{}\n', mode: 0o755, owner: OWNER }])])
    expect(r2.applied).toBe(0)
    expect(r2.skipped.map(s => s.reason)).toEqual(['unchanged'])
  }))

  test.skipIf(process.platform === 'win32')('where modes are kept, a mode alone is a change', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    await applyPlans([plan([{ kind: 'file', path: p, content: '{}\n', owner: OWNER }])])
    const r = await applyPlans([plan([{ kind: 'file', path: p, content: '{}\n', mode: 0o755, owner: OWNER }])])
    expect(r.applied).toBe(1)
    expect(statSync(p).mode & 0o777).toBe(0o755)
  }))
})

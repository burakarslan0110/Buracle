import { describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { applyPlans, type Op, type Plan } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

const OWNER = 'test'

function plan(ops: Op[]): Plan {
  return { id: 'p', harness: 'core', ops }
}

describe('file modes', () => {
  test('a mode alone is a change', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.codex', 'hooks.json')
    await applyPlans([plan([{ kind: 'file', path: p, content: '{}\n', owner: OWNER }])])
    const r = await applyPlans([plan([{ kind: 'file', path: p, content: '{}\n', mode: 0o755, owner: OWNER }])])
    expect(r.applied).toBe(1)
    expect(statSync(p).mode & 0o777).toBe(0o755)
  }))
})

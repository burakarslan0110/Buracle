import { describe, expect, test } from 'bun:test'
import { mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { applyPlans, type Op, type Plan } from '../../src/engine/txn'
import { withSandbox } from '../helpers/sandbox'

const OWNER = 'test'

function plan(ops: Op[]): Plan {
  return { id: 'p', harness: 'core', ops }
}

function link(path: string, target: string): void {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path)
}

describe('symlink targets', () => {
  test('a target is stored as written: a backslash is part of it', () => withSandbox(async (sb) => {
    const p = join(sb.home, '.local', 'bin', 'buracle')
    link(p, '\\shim')
    const r = await applyPlans([plan([{ kind: 'symlink', path: p, target: '/shim', owner: OWNER }])])
    expect(r.conflicts.length).toBe(1)
    expect(readlinkSync(p)).toBe('\\shim')
  }))
})

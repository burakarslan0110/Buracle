import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkCortexdbBinary } from '../../src/memory/cortex-check'
import { withSandbox } from '../helpers/sandbox'

const FAKE = join(import.meta.dir, '..', 'fixtures', 'cortexdb', 'fake-cortexdb.ts')

describe('the check a new CortexDB passes before the memory uses it', () => {
  test('a CortexDB that saves, reads, lists, finds and deletes a memory passes', async () => {
    expect(await checkCortexdbBinary(FAKE)).toEqual({ ok: true })
  }, 60_000)

  test('one that does not answer fails with the reason', () => withSandbox(async ({ root }) => {
    const broken = join(root, 'broken-cortexdb.ts')
    writeFileSync(broken, "console.error('unsupported database format'); process.exit(3)\n")
    const r = await checkCortexdbBinary(broken, 10_000)
    expect(r.ok).toBe(false)
  }), 60_000)

  test('one that lost a tool the memory calls fails, naming it', () => withSandbox(async ({ root }) => {
    const partial = join(root, 'partial-cortexdb.ts')
    writeFileSync(partial, `process.env.FAKE_CORTEXDB_DROP = 'memory_search'\nawait import(${JSON.stringify(FAKE)})\n`)
    const r = await checkCortexdbBinary(partial, 10_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('memory_search')
  }), 60_000)
})

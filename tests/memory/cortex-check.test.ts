import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CORTEXDB_MIN_VERSION } from '../../src/engine/toolchain/cortexdb'
import { checkCortexdbBinary, cortexdbVersion, cortexdbVersionProblem } from '../../src/memory/cortex-check'
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

  test('the binary says which release it is; one below the minimum fails with both versions, one that does not say goes on to the trial', () => withSandbox(async ({ root }) => {
    expect(await cortexdbVersion({ path: FAKE, source: 'env' })).toBe('2.151.1')
    const old = join(root, 'old-cortexdb.ts')
    writeFileSync(old, `process.env.FAKE_CORTEXDB_VERSION = '2.136.0'\nawait import(${JSON.stringify(FAKE)})\n`)
    expect(await cortexdbVersion({ path: old, source: 'env' })).toBe('2.136.0')
    expect(await checkCortexdbBinary(old, 10_000)).toEqual({ ok: false, error: `it is CortexDB 2.136.0, older than the ${CORTEXDB_MIN_VERSION} Buracle needs` })
    const silent = join(root, 'silent-cortexdb.ts')
    writeFileSync(silent, "process.exit(0)\n")
    expect(await cortexdbVersion({ path: silent, source: 'env' })).toBeUndefined()
    expect(cortexdbVersionProblem(undefined)).toBeUndefined()
    expect(cortexdbVersionProblem(CORTEXDB_MIN_VERSION)).toBeUndefined()
  }), 60_000)

  test('one without the sweep or the graph listing fails, naming the tool', () => withSandbox(async ({ root }) => {
    for (const tool of ['sweep_expired', 'graph_list_all']) {
      const partial = join(root, `no-${tool}.ts`)
      writeFileSync(partial, `process.env.FAKE_CORTEXDB_DROP = '${tool}'\nawait import(${JSON.stringify(FAKE)})\n`)
      const r = await checkCortexdbBinary(partial, 10_000)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(tool)
    }
  }), 60_000)

  test('one that lost a tool the memory calls fails, naming it', () => withSandbox(async ({ root }) => {
    const partial = join(root, 'partial-cortexdb.ts')
    writeFileSync(partial, `process.env.FAKE_CORTEXDB_DROP = 'memory_search'\nawait import(${JSON.stringify(FAKE)})\n`)
    const r = await checkCortexdbBinary(partial, 10_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('memory_search')
  }), 60_000)
})

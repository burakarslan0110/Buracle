import { describe, expect, test } from 'bun:test'
import { rollbackBroken, type BrokenUpgrade, type RollbackDeps } from '../../src/engine/update/rollback'

interface Pkg { version: string, previous?: string }

// A toolchain of version-holding packages: a rollback swaps version and previous, as the real one does.
// `works(key, version)` says whether a package at that version passes its check.
function fakeToolchain(pkgs: Record<string, Pkg>, works: (key: string, version: string) => boolean, opts: { busy?: boolean, failRollbackAt?: number } = {}) {
  const calls: string[] = []
  const keyOf: Record<string, string> = {}
  let rollbacks = 0
  const deps: RollbackDeps = {
    previous: key => pkgs[key]?.previous,
    async rollback(keys) {
      rollbacks++
      calls.push(`rollback ${keys.join(',')}`)
      if (opts.busy === true) return undefined
      return keys.map(key => {
        const p = pkgs[key] as Pkg
        if (opts.failRollbackAt === rollbacks) return { key, name: key, from: p.version, ok: false, error: 'EACCES: permission denied' }
        const from = p.version
        pkgs[key] = { version: p.previous as string, previous: from }
        return { key, name: key, from, to: pkgs[key]?.version, ok: true }
      })
    },
    async recheck(t) {
      calls.push(`recheck ${t.kind}:${t.id}`)
      const key = keyOf[`${t.kind}:${t.id}`] as string
      const ok = works(key, pkgs[key]?.version as string)
      return ok ? { ok } : { ok, error: `${t.id} did not answer` }
    },
  }
  const broken = (kind: BrokenUpgrade['kind'], id: string, key: string, error = 'no answer to initialize'): BrokenUpgrade => {
    keyOf[`${kind}:${id}`] = key
    return { kind, id, key, error }
  }
  return { deps, calls, pkgs, broken }
}

describe('rolling back an upgrade that fails its check', () => {
  test('puts the previous version back when it works, and says so', async () => {
    const t = fakeToolchain({ 'npm:alpha': { version: '1.1.0', previous: '1.0.0' } }, (_k, v) => v === '1.0.0')
    const verdicts = await rollbackBroken([t.broken('mcp', 'alpha', 'npm:alpha')], t.deps)
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ kind: 'mcp', id: 'alpha', status: 'rolled-back' })
    expect(verdicts[0]?.detail).toContain('1.1.0')
    expect(verdicts[0]?.detail).toContain('1.0.0')
    expect(verdicts[0]?.detail).toContain('no answer to initialize')
    expect(t.pkgs['npm:alpha']?.version).toBe('1.0.0')
    expect(t.calls).toEqual(['rollback npm:alpha', 'recheck mcp:alpha'])
  })

  test('when the previous version fails too, the update was not the cause: the newer version comes back', async () => {
    const t = fakeToolchain({ 'npm:alpha': { version: '1.1.0', previous: '1.0.0' } }, () => false)
    const verdicts = await rollbackBroken([t.broken('mcp', 'alpha', 'npm:alpha')], t.deps)
    expect(verdicts[0]).toMatchObject({ status: 'kept' })
    expect(verdicts[0]?.detail).toContain('not the cause')
    expect(t.pkgs['npm:alpha']?.version).toBe('1.1.0')
    expect(t.calls).toEqual(['rollback npm:alpha', 'recheck mcp:alpha', 'rollback npm:alpha'])
  })

  test('without a kept previous version nothing is touched and the verdict is stuck', async () => {
    const t = fakeToolchain({ 'pypi:semble': { version: '0.9.0' } }, () => false)
    const verdicts = await rollbackBroken([t.broken('mcp', 'semble', 'pypi:semble')], t.deps)
    expect(verdicts[0]).toMatchObject({ status: 'stuck' })
    expect(verdicts[0]?.detail).toContain('no earlier version is kept')
    expect(t.calls).toEqual([])
  })

  test('another Buracle process holding the toolchain lock is reported, with the manual command', async () => {
    const t = fakeToolchain({ 'npm:alpha': { version: '1.1.0', previous: '1.0.0' } }, () => false, { busy: true })
    const verdicts = await rollbackBroken([t.broken('tools', 'pyright', 'npm:alpha', '`pyright --version` exited 1')], t.deps)
    expect(verdicts[0]).toMatchObject({ kind: 'tools', id: 'pyright', status: 'stuck' })
    expect(verdicts[0]?.detail).toContain('another Buracle process')
    expect(verdicts[0]?.detail).toContain('buracle rollback toolchain')
  })

  test('a failed rollback names the error and leaves the package where it is', async () => {
    const t = fakeToolchain({ 'npm:alpha': { version: '1.1.0', previous: '1.0.0' } }, () => false, { failRollbackAt: 1 })
    const verdicts = await rollbackBroken([t.broken('mcp', 'alpha', 'npm:alpha')], t.deps)
    expect(verdicts[0]).toMatchObject({ status: 'stuck' })
    expect(verdicts[0]?.detail).toContain('EACCES')
    expect(t.pkgs['npm:alpha']?.version).toBe('1.1.0')
    expect(t.calls).toEqual(['rollback npm:alpha'])
  })

  test('if putting the newer version back fails after a failed recheck, that is reported instead of hidden', async () => {
    const t = fakeToolchain({ 'npm:alpha': { version: '1.1.0', previous: '1.0.0' } }, () => false, { failRollbackAt: 2 })
    const verdicts = await rollbackBroken([t.broken('mcp', 'alpha', 'npm:alpha')], t.deps)
    expect(verdicts[0]).toMatchObject({ status: 'stuck' })
    expect(verdicts[0]?.detail).toContain('1.0.0')
    expect(verdicts[0]?.detail).toContain('EACCES')
    expect(t.pkgs['npm:alpha']?.version).toBe('1.0.0')
  })

  test('items that share one package roll it back once; the ones that recover keep the rollback, the others say they still fail', async () => {
    const t = fakeToolchain({ 'npm:codegraph': { version: '2.0.0', previous: '1.9.0' } }, (_k, v) => v === '1.9.0')
    const mcp = t.broken('mcp', 'codegraph', 'npm:codegraph')
    const tool = t.broken('tools', 'codegraph', 'npm:codegraph')
    // The CLI check keeps failing on the old version too (say its PATH entry is stale).
    const deps: RollbackDeps = { ...t.deps, recheck: async x => (x.kind === 'tools' ? { ok: false, error: 'codegraph: command not found' } : t.deps.recheck(x)) }
    const verdicts = await rollbackBroken([mcp, tool], deps)
    expect(t.calls.filter(c => c.startsWith('rollback'))).toEqual(['rollback npm:codegraph'])
    expect(verdicts.find(v => v.kind === 'mcp')).toMatchObject({ status: 'rolled-back' })
    expect(verdicts.find(v => v.kind === 'tools')).toMatchObject({ status: 'stuck' })
    expect(verdicts.find(v => v.kind === 'tools')?.detail).toContain('command not found')
    expect(t.pkgs['npm:codegraph']?.version).toBe('1.9.0')
  })

  test('packages are handled one by one and the verdicts keep the order of the input', async () => {
    const t = fakeToolchain({ 'npm:a': { version: '2.0.0', previous: '1.0.0' }, 'npm:b': { version: '3.0.0' } }, (k, v) => k === 'npm:a' && v === '1.0.0')
    const verdicts = await rollbackBroken([t.broken('mcp', 'b', 'npm:b'), t.broken('mcp', 'a', 'npm:a')], t.deps)
    expect(verdicts.map(v => `${v.id}:${v.status}`)).toEqual(['b:stuck', 'a:rolled-back'])
  })

  test('nothing broken means nothing is touched', async () => {
    const t = fakeToolchain({}, () => true)
    expect(await rollbackBroken([], t.deps)).toEqual([])
    expect(t.calls).toEqual([])
  })
})

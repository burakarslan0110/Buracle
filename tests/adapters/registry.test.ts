import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { allAdapters, getAdapter, type Adapter, type AdapterContext } from '../../src/adapters/registry'
import { HARNESSES } from '../../src/core/events'
import { withEnv, withSandbox } from '../helpers/sandbox'

describe('adapter registry', () => {
  test('one adapter per harness, in canonical order', () => {
    expect(allAdapters().map(a => a.harness)).toEqual([...HARNESSES])
    for (const h of HARNESSES) expect(getAdapter(h).harness).toBe(h)
  })

  test('detect() finds the binary on PATH and parses --version', () => withSandbox(async ({ root }) => {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const outputs: Record<string, string> = { claude: '2.1.293 (Claude Code)', codex: 'codex-cli 0.161.0', opencode: 'opencode v2.0.24', omp: 'omp/18.8.3' }
    for (const [name, out] of Object.entries(outputs)) {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${out}"\n`)
      chmodSync(join(bin, name), 0o755)
    }
    await withEnv({ PATH: `${bin}:/usr/bin:/bin` }, async () => {
      const found = await Promise.all(allAdapters().map(a => a.detect()))
      expect(found).toEqual([
        { installed: true, version: '2.1.293', path: join(bin, 'claude') },
        { installed: true, version: '0.161.0', path: join(bin, 'codex') },
        { installed: true, version: '2.0.24', path: join(bin, 'opencode') },
        { installed: true, version: '18.8.3', path: join(bin, 'omp') },
      ])
    })
    await withEnv({ PATH: join(root, 'empty') }, async () => {
      for (const a of allAdapters()) expect(await a.detect()).toEqual({ installed: false })
    })
  }))

  test('every adapter implements the Adapter contract (CONTRACTS §8)', () => {
    const required = ['detect', 'build', 'installPlan', 'doctor'] as const satisfies ReadonlyArray<keyof Adapter>
    const optional = ['hook', 'uninstallPlan'] as const satisfies ReadonlyArray<keyof Adapter>
    for (const a of allAdapters()) {
      expect(HARNESSES).toContain(a.harness)
      for (const m of required) expect({ harness: a.harness, method: m, type: typeof a[m] }).toEqual({ harness: a.harness, method: m, type: 'function' })
      for (const m of optional) {
        if (a[m] !== undefined) expect({ harness: a.harness, method: m, type: typeof a[m] }).toEqual({ harness: a.harness, method: m, type: 'function' })
      }
      const keys = Object.keys(a).filter(k => k !== 'harness')
      expect({ harness: a.harness, extra: keys.filter(k => !(required as readonly string[]).includes(k) && !(optional as readonly string[]).includes(k)) }).toEqual({ harness: a.harness, extra: [] })
    }
    expect(typeof getAdapter('claude').hook).toBe('function')
    expect(typeof getAdapter('codex').hook).toBe('function')
  })

  test('methods return promises (async contract), checked on detect() without a context', async () => {
    await withEnv({ PATH: '/nonexistent-buracle-bin' }, async () => {
      for (const a of allAdapters()) {
        const p = a.detect()
        expect(p).toBeInstanceOf(Promise)
        expect(await p).toEqual({ installed: false })
      }
    })
  })
})

const _uninstallSignature: Adapter['uninstallPlan'] = async (ctx: AdapterContext) => ({ id: `${ctx.repoRoot}-uninstall`, harness: 'core', ops: [] })
void _uninstallSignature

import { cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CmPackage } from '../../../src/engine/context-mode'

export const CM_FIXTURE_PACKAGE = join(import.meta.dir, 'package')

interface FixtureState { calls: unknown[][], fail?: string }

export function recordCmFixture(): FixtureState {
  const state: FixtureState = { calls: [] }
  ;(globalThis as { __cmFixture?: FixtureState }).__cmFixture = state
  return state
}

export function stopCmFixture(): void {
  delete (globalThis as { __cmFixture?: FixtureState }).__cmFixture
}

export function installCmFixture(sb: { root: string, buracleHome: string }, opts: { copy?: boolean } = {}): CmPackage {
  const dir = join(sb.root, 'tc')
  const root = join(dir, 'node_modules', 'context-mode')
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  if (opts.copy === true) cpSync(CM_FIXTURE_PACKAGE, root, { recursive: true })
  else symlinkSync(CM_FIXTURE_PACKAGE, root)
  mkdirSync(join(sb.buracleHome, 'state'), { recursive: true })
  writeFileSync(join(sb.buracleHome, 'state', 'toolchain.json'), JSON.stringify({
    v: 1, updated_at: '2026-10-10T00:00:00.000Z', system: {},
    packages: {
      'npm:context-mode': {
        registry: 'npm', name: 'context-mode', version: '0.0.0-fixture', dir,
        bins: { 'context-mode': join(root, 'cli.bundle.mjs') }, installed_at: '2026-10-10T00:00:00.000Z',
      },
    },
  }))
  return { root, version: '0.0.0-fixture', dir }
}

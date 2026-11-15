import { describe, expect, test } from 'bun:test'
import { allAdapters } from '../../../src/adapters/registry'
import { hasBuiltHarness, runBuild, runDeterminismCheck } from '../../../src/engine/update/build'
import { withSandbox } from '../../helpers/sandbox'
import { REAL_REPO } from './helpers'

// harness/ is not committed on dev: CI builds it for the release on main. What stays checkable here is that the
// generators are deterministic, that the one generated file that is committed (the buracle skill's command
// reference in canonical/) is current, and, for a contributor who has built harness/ locally, that it is current too.
describe('generated output', () => {
  test('two builds into separate output roots are byte-identical and the manifest lists exactly the files written', () => withSandbox(async () => {
    const r = await runDeterminismCheck({ repoRoot: REAL_REPO, adapters: allAdapters() })
    expect(r.errors).toEqual([])
    expect(r.drift).toEqual([])
    expect(r.generated).toBeGreaterThan(100)
  }), 180_000)

  test('the committed command reference in canonical/ matches the CLI help (buracle build refreshes it)', () => withSandbox(async () => {
    const r = await runBuild({ repoRoot: REAL_REPO, check: true, skipHarnessCompare: true, adapters: allAdapters() })
    expect(r.errors).toEqual([])
    expect(r.drift).toEqual([])
  }), 180_000)

  test.skipIf(!hasBuiltHarness(REAL_REPO))('a locally built harness/ is in sync with the generators (buracle build --check)', () => withSandbox(async () => {
    const r = await runBuild({ repoRoot: REAL_REPO, check: true, adapters: allAdapters() })
    expect(r.errors).toEqual([])
    expect(r.drift).toEqual([])
  }), 180_000)
})

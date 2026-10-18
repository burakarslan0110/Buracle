import { describe, expect, test } from 'bun:test'
import { allAdapters } from '../../../src/adapters/registry'
import { hasManifest, runBuild } from '../../../src/engine/update/build'
import { withSandbox } from '../../helpers/sandbox'
import { REAL_REPO } from './helpers'

describe('committed generated output', () => {
  test.skipIf(!hasManifest(REAL_REPO))('harness/ and docs/reference/ are in sync with the generators (buracle build --check)', () => withSandbox(async () => {
    const r = await runBuild({ repoRoot: REAL_REPO, check: true, adapters: allAdapters() })
    expect(r.errors).toEqual([])
    expect(r.drift).toEqual([])
  }), 60_000)
})

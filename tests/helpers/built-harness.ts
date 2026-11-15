import { mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allAdapters } from '../../src/adapters/registry'
import { runBuild, type BuildReport } from '../../src/engine/update/build'
import { realPath } from './sandbox'

// harness/ is generated output and is not committed on dev, so a fresh clone has none. Tests that read the
// generated files read this copy instead: `buracle build` (the same runBuild) writes it once per test run into a
// throwaway output root, with the checkout itself only read. The build is cached on globalThis because bun may
// load this module again for another test file.

const REPO = join(import.meta.dir, '..', '..')

export interface BuiltOutput {
  /** The output root: it holds harness/ (and the generated command reference under canonical/). */
  root: string
  /** The `harness/` folder of the build. */
  harness: string
  /** A checkout-shaped folder: this repository's canonical/ and the built harness/, linked (read only). */
  view: string
  report: BuildReport
}

declare global {
  var __BURACLE_BUILT_HARNESS__: Promise<BuiltOutput> | undefined
}

/** Builds once per run, into the run's own temp folder (the preload removes it at the end). */
export function builtOutput(): Promise<BuiltOutput> {
  globalThis.__BURACLE_BUILT_HARNESS__ ??= (async () => {
    const parent = globalThis.__BURACLE_REAL_HOME_GUARD__?.runRoot ?? realPath(tmpdir())
    const root = join(parent, 'built')
    mkdirSync(root, { recursive: true })
    const report = await runBuild({ repoRoot: REPO, outRoot: root, check: false, docs: false, adapters: allAdapters() })
    if (report.errors.length > 0) throw new Error(`the test build failed: ${report.errors.map(e => `${e.source}: ${e.error}`).join('; ')}`)
    const view = join(parent, 'view')
    mkdirSync(view, { recursive: true })
    symlinkSync(join(REPO, 'canonical'), join(view, 'canonical'))
    symlinkSync(join(root, 'harness'), join(view, 'harness'))
    return { root, harness: join(root, 'harness'), view, report }
  })()
  return globalThis.__BURACLE_BUILT_HARNESS__
}

/** The result of the one build of this run, awaited at import time so that tests can use it synchronously. */
export const BUILT: BuiltOutput = await builtOutput()

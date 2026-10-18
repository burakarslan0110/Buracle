import { join } from 'node:path'
import type { AdapterContext } from '../../adapters/registry'
import type { CanonicalBundle } from '../../core/catalog'
import type { BuracleConfig } from '../../core/config'
import { CanonicalError, loadCanonicalSync } from '../canonical'
import { loadConfigSync, type LoadedConfig } from '../config'
import * as paths from '../paths'
import { errText } from './output'

export function loadBundle(repoRoot: string): { bundle: CanonicalBundle } | { error: string, problems: string[] } {
  try {
    return { bundle: loadCanonicalSync(join(repoRoot, 'canonical')) }
  } catch (e) {
    return { error: errText(e), problems: e instanceof CanonicalError ? e.problems : [errText(e)] }
  }
}

export function buildContext(repoRoot: string, canonical: CanonicalBundle): AdapterContext {
  return { repoRoot, config: canonical.config, canonical, paths, buracleBin: paths.shimPath() }
}

export async function inCheckout<T>(repoRoot: string, fn: () => T | Promise<T>): Promise<T> {
  let prev: string | undefined
  try { prev = process.cwd() } catch { prev = undefined }
  try { process.chdir(repoRoot) } catch { return await fn() }
  try {
    return await fn()
  } finally {
    if (prev !== undefined) { try { process.chdir(prev) } catch {  } }
  }
}

export interface LiveContext {
  ctx: AdapterContext
  loaded: LoadedConfig
  config: BuracleConfig
  canonicalError(): string | undefined
}

export function liveContext(repoRoot: string, opts: { force?: boolean } = {}): LiveContext {
  const loaded = loadConfigSync({ repoRoot })
  let bundle: CanonicalBundle | undefined
  let failure: string | undefined
  const ctx: AdapterContext & { force?: boolean } = {
    repoRoot,
    config: loaded.config,
    paths,
    buracleBin: paths.shimPath(),
    get canonical(): CanonicalBundle {
      if (bundle) return bundle
      const r = loadBundle(repoRoot)
      if ('bundle' in r) { bundle = r.bundle; return bundle }
      failure = r.error
      throw new Error(r.error)
    },
  }
  if (opts.force === true) ctx.force = true
  return { ctx, loaded, config: loaded.config, canonicalError: () => failure }
}

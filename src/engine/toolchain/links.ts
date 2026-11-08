import { existsSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import * as paths from '../paths'
import { uvBinDir } from './packages'
import type { ToolchainState } from './state'
import { pinnedAsset } from './system-download'

export interface ToolLink {
  bin: string
  path: string
  target: string
}

export function linkTarget(registry: 'npm' | 'pypi', dir: string, bin: string): string {
  if (registry === 'pypi') return join(uvBinDir(), bin)
  return join(dir, 'node_modules', '.bin', bin)
}

const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Links for the harness programs the user's shells cannot find by name. A harness installed with `bun add -g` (omp) sits
 * in ~/.bun/bin, which Homebrew's bun does not put on PATH, and Buracle's own checks find it there anyway; so `omp` ran
 * for Buracle and printed "command not found" for the user. Such a program gets a link in ~/.local/bin, the folder the
 * install already puts on PATH. A program PATH finds, or one that already lives in ~/.local/bin, needs none.
 */
export function harnessLinks(
  found: ReadonlyArray<{ harness: string, included: boolean, path?: string }>,
  pathEnv: string | undefined,
  which: (bin: string, PATH: string) => string | undefined = (bin, PATH) => Bun.which(bin, { PATH }) ?? undefined,
): ToolLink[] {
  const out: ToolLink[] = []
  for (const h of found) {
    if (!h.included || h.path === undefined || !existsSync(h.path)) continue
    const bin = basename(h.path)
    if (!BIN_NAME.test(bin) || dirname(h.path) === paths.localBinDir()) continue
    // Only a program in the user's own folders (~/.bun/bin, ~/.npm-global/bin, …): a system folder is on the PATH of the
    // login shell already, and a link in ~/.local/bin, which comes first on PATH, would pin it past nvm or volta.
    if (!h.path.startsWith(paths.home() + sep)) continue
    if (which(bin, pathEnv ?? '') !== undefined) continue
    const path = join(paths.localBinDir(), bin)
    if (!out.some(l => l.path === path)) out.push({ bin, path, target: h.path })
  }
  return out
}

export function toolchainLinks(state: ToolchainState): ToolLink[] {
  const out: ToolLink[] = []
  const add = (bin: string, target: string) => {
    const path = join(paths.localBinDir(), bin)
    if (!out.some(l => l.path === path)) out.push({ bin, path, target })
  }
  for (const pkg of Object.values(state.packages)) {
    for (const bin of pkg.links ?? []) {
      if (!BIN_NAME.test(bin)) continue
      const target = linkTarget(pkg.registry, pkg.dir, bin)
      if (existsSync(target)) add(bin, target)
    }
  }
  const dirs = paths.toolchainBinDirs()
  for (const [name, rec] of Object.entries(state.system)) {
    // A pinned download links every program it brings (node with npm and npx, uv with uvx), for the agents' shells.
    if (rec.via === 'download') {
      const pinned = pinnedAsset(name)
      for (const [bin, rel] of Object.entries(pinned?.asset.bins ?? {})) {
        const target = join(paths.systemToolsDir(), name, rel)
        if (BIN_NAME.test(bin) && existsSync(target)) add(bin, target)
      }
      continue
    }
    const target = rec.path
    if ((rec.via !== 'go' && rec.via !== 'dotnet') || target === undefined) continue
    if (!dirs.some(d => target.startsWith(d + sep)) || !existsSync(target)) continue
    const bin = basename(target).replace(/\.exe$/i, '')
    if (BIN_NAME.test(bin)) add(bin, target)
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}


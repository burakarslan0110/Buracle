import { existsSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import * as paths from '../paths'
import { exeName, isWindows } from '../platform'
import { uvBinDir } from './packages'
import type { ToolchainState } from './state'
import { pinnedAsset } from './system-download'

export interface ToolLink {
  bin: string
  path: string
  target: string
}

export function linkTarget(registry: 'npm' | 'pypi', dir: string, bin: string): string {
  if (registry === 'pypi') return join(uvBinDir(), exeName(bin))
  return join(dir, 'node_modules', '.bin', isWindows() ? `${bin}.cmd` : bin)
}

const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function toolchainLinks(state: ToolchainState): ToolLink[] {
  const out: ToolLink[] = []
  const add = (bin: string, target: string) => {
    const path = join(paths.localBinDir(), isWindows() ? `${bin}.cmd` : bin)
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

export function windowsLauncher(target: string): string {
  return `@echo off\r\nrem Buracle toolchain launcher written by \`buracle install\`.\r\n"${target}" %*\r\n`
}

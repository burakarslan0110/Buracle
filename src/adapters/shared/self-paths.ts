import { isAbsolute, resolve } from 'node:path'
import type { SelfPaths } from '../../core/policy/write-guard'
import { buracleHome, claudeDir, codexHome, expandHome, home, isCheckout, localBinDir, ompAgentDir, ompHome, opencodeConfigDir, repoRoot } from '../../engine/paths'

export interface SelfPathsSource {
  home(): string
  buracleHome(): string
  localBinDir(): string
  claudeDir(): string
  codexHome(): string
  opencodeConfigDir(): string
  ompAgentDir(): string
  ompHome(): string
  repoRoot(): string
  isCheckout(dir: string): boolean
  expandHome(p: string): string
}

const ROOTS = ['buracleHome', 'localBinDir', 'claudeDir', 'codexHome', 'opencodeConfigDir', 'ompAgentDir', 'ompHome'] as const

function attempt(fn: () => string | undefined): string | undefined {
  try {
    const v = fn()
    return typeof v === 'string' && isAbsolute(v) ? v : undefined
  } catch {
    return undefined
  }
}

function installedCheckout(p: SelfPathsSource, configured: string | undefined): string | undefined {
  if (typeof configured === 'string' && configured.trim() !== '') {
    const expanded = p.expandHome(configured.trim())
    const dir = isAbsolute(expanded) ? resolve(expanded) : resolve(p.home(), expanded)
    if (p.isCheckout(dir)) return dir
  }
  const running = p.repoRoot()
  return p.isCheckout(running) ? running : undefined
}

export function selfPaths(configuredRepo?: string, source?: SelfPathsSource): SelfPaths {
  const p: SelfPathsSource = source ?? { home, buracleHome, localBinDir, claudeDir, codexHome, opencodeConfigDir, ompAgentDir, ompHome, repoRoot, isCheckout, expandHome }
  const out: SelfPaths = {}
  for (const key of ROOTS) {
    const v = attempt(() => p[key]())
    if (v !== undefined) out[key] = v
  }
  const repo = attempt(() => installedCheckout(p, configuredRepo))
  if (repo !== undefined) out.repo = repo
  return out
}

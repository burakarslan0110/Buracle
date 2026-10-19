import { basename, dirname } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import type { WorkspaceFacts } from '../../../core/policy/usage'
import type { WorkspaceInfo } from '../../../core/workspace'
import * as paths from '../../../engine/paths'
import { profileGuard } from '../../../workflow/session-store'
import { canonicalDir, codegraphIndexPresent, exclusionContext } from '../../../workflow/workspace'

export const WORKSPACE_THROTTLE_MS = 60_000
const MAX_DIRS = 64

export type WorkspaceFn = (cwd: string, cfg: BuracleConfig, nowMs: number) => Promise<WorkspaceInfo>

interface Prepared { at: number; info: Promise<WorkspaceInfo> }
export const WORKSPACE_KEY = Symbol.for('buracle.opencode.workspaces')

function preparedDirs(): Map<string, Prepared> {
  const g = globalThis as unknown as Record<symbol, unknown>
  let m = g[WORKSPACE_KEY]
  if (!(m instanceof Map)) { m = new Map<string, Prepared>(); g[WORKSPACE_KEY] = m }
  return m as Map<string, Prepared>
}

export function prepareOnce(dir: string, cfg: BuracleConfig, now: number, prepare: WorkspaceFn): Promise<WorkspaceInfo> {
  const map = preparedDirs()
  const hit = map.get(dir)
  if (hit !== undefined && now - hit.at >= 0 && now - hit.at < WORKSPACE_THROTTLE_MS) return hit.info
  const info = prepare(dir, cfg, now)
  info.catch(() => { if (map.get(dir)?.info === info) map.delete(dir) })
  if (map.size >= MAX_DIRS) map.clear()
  map.set(dir, { at: now, info })
  return info
}

export function clearPreparedWorkspaces(): void {
  preparedDirs().clear()
}

export function workspaceFacts(info: WorkspaceInfo | undefined, cfg: BuracleConfig, home: string): WorkspaceFacts {
  const exclude = (Array.isArray(cfg.index.exclude) ? cfg.index.exclude : []).filter((e): e is string => typeof e === 'string')
  const exclusion = { ...exclusionContext(paths.oldVaultRoot(), exclude), home: canonicalDir(home) }
  const facts: WorkspaceFacts = { home, caseInsensitive: exclusion.caseInsensitive, exclusion, realpath: canonicalDir, codegraphIndexed: false }
  if (info !== undefined) {
    facts.cwd = info.cwd
    if (info.children.length > 0) facts.children = [...info.children]
  }
  if (info?.root !== undefined) {
    facts.root = info.root
    facts.codegraphIndexed = cfg.index.codegraph && codegraphIndexPresent(info.root)
  }
  return facts
}

export function profileWarning(pluginDir: string | undefined, runtimeSnapshot: unknown, home: string): string | undefined {
  if (pluginDir === undefined || pluginDir === '') return undefined
  const plugins = dirname(pluginDir)
  const configDir = dirname(plugins)
  if (basename(plugins) !== 'plugins' || basename(configDir) !== 'opencode') return undefined
  return profileGuard('opencode', runtimeSnapshot, { HOME: home, XDG_CONFIG_HOME: dirname(configDir) })
}

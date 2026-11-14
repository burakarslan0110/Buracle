import { basename, dirname } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import type { WorkspaceInfo } from '../../../core/workspace'

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

/** The environment the profile guard (H17) reads: the config folder this plugin was loaded from, when it is an installed one. */
export function profileEnv(pluginDir: string | undefined, home: string): Record<string, string | undefined> | undefined {
  if (pluginDir === undefined || pluginDir === '') return undefined
  const plugins = dirname(pluginDir)
  const configDir = dirname(plugins)
  if (basename(plugins) !== 'plugins' || basename(configDir) !== 'opencode') return undefined
  return { HOME: home, XDG_CONFIG_HOME: dirname(configDir) }
}

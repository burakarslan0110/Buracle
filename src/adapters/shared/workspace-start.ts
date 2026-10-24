import type { BuracleConfig } from '../../core/config'
import type { WorkspaceInfo } from '../../core/workspace'
import { buracleArgv } from '../../usage/bar-info'
import { canonicalDir, infoFor, resolveWorkspace, startIndexRun, workspaceOptions, type IndexSpawner, type WorkspaceTarget } from '../../workflow/workspace'
import { log } from '../../engine/log'

function fallbackInfo(cwd: string, cfg: BuracleConfig): WorkspaceInfo {
  return {
    cwd: canonicalDir(cwd),
    children: [],
    index: { codegraph: { state: cfg.index.codegraph ? 'none' : 'off' }, semble: { state: cfg.index.semble ? 'none' : 'off' } },
  }
}

/**
 * Whether a session start launches the background index run. A single project needs none: its codegraph server brings
 * its own index up to date when it starts (and the launcher's start gate builds the first one), and semble re-indexes
 * when it searches. Only a folder that holds several projects, which no server is started for, is indexed here.
 */
export function indexRunAtSessionStart(target: Pick<WorkspaceTarget, 'root' | 'children'>): boolean {
  return target.root === undefined && target.children.length > 0
}

export async function prepareWorkspace(cwd: string, cfg: BuracleConfig, nowMs: number, o: { spawn?: IndexSpawner, argv?: string[] | undefined } = {}): Promise<WorkspaceInfo> {
  const autostart = process.env['BURACLE_NO_AUTOSTART'] !== '1'
  try {
    const target = await resolveWorkspace(cwd, workspaceOptions(cfg))
    const building = autostart && cfg.index.auto && indexRunAtSessionStart(target) ? startIndexRun(target, cfg, nowMs, 'argv' in o ? o.argv : buracleArgv(), o.spawn) : []
    return infoFor(target, cfg, nowMs, building)
  } catch (e) {
    log('warn', 'workspace: preparing the session start failed', { cwd, error: e })
    return fallbackInfo(cwd, cfg)
  }
}

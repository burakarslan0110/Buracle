import type { BuracleConfig } from '../../core/config'
import type { WorkspaceInfo } from '../../core/workspace'
import { canonicalDir, infoFor, resolveWorkspace, workspaceOptions } from '../../workflow/workspace'
import { log } from '../../engine/log'

function fallbackInfo(cwd: string, cfg: BuracleConfig): WorkspaceInfo {
  return {
    cwd: canonicalDir(cwd),
    children: [],
    index: { codegraph: { state: cfg.index.codegraph ? 'none' : 'off' }, semble: { state: cfg.index.semble ? 'none' : 'off' } },
  }
}

/**
 * What a session start learns about its workspace: the project root, its child projects and the state of their code
 * indexes. It starts nothing. A project's codegraph server brings its own index up to date when it starts (and the
 * launcher of that server builds the first one), semble re-indexes when it searches, and an agent builds the index of
 * a project in a folder of projects when it needs one (`buracle index ensure --cwd <project>`, which the context line names).
 */
export async function prepareWorkspace(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<WorkspaceInfo> {
  try {
    return infoFor(await resolveWorkspace(cwd, workspaceOptions(cfg)), cfg, nowMs)
  } catch (e) {
    log('warn', 'workspace: preparing the session start failed', { cwd, error: e })
    return fallbackInfo(cwd, cfg)
  }
}

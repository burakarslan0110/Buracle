import type { BuracleConfig } from '../../core/config'
import type { WorkspaceInfo } from '../../core/workspace'
import { buracleArgv, ensureMemoryUi } from '../../usage/bar-info'
import { canonicalDir, infoFor, resolveWorkspace, startIndexRun, workspaceOptions } from '../../workflow/workspace'
import { log } from '../../engine/log'

function fallbackInfo(cwd: string, cfg: BuracleConfig): WorkspaceInfo {
  return {
    cwd: canonicalDir(cwd),
    children: [],
    index: { codegraph: { state: cfg.index.codegraph ? 'none' : 'off' }, semble: { state: cfg.index.semble ? 'none' : 'off' } },
  }
}

export async function prepareWorkspace(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<WorkspaceInfo> {
  const autostart = process.env['BURACLE_NO_AUTOSTART'] !== '1'
  if (autostart) {
    try { ensureMemoryUi(nowMs, { sessionStarting: true }) } catch (e) { log('warn', 'workspace: could not start the memory web UI', { error: e }) }
  }
  try {
    const target = await resolveWorkspace(cwd, workspaceOptions(cfg))
    const building = autostart && cfg.index.auto ? startIndexRun(target, cfg, nowMs, buracleArgv()) : []
    return infoFor(target, cfg, nowMs, building)
  } catch (e) {
    log('warn', 'workspace: preparing the session start failed', { cwd, error: e })
    return fallbackInfo(cwd, cfg)
  }
}

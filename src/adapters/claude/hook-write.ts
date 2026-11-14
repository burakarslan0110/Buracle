import type { ToolCall } from '../../core/events'
import type { WriteGuardContext } from '../../core/policy/write-guard'
import * as paths from '../../engine/paths'
import type { AdapterContext } from '../registry'
import type { WriteTargets } from '../shared/pipeline/index'
import { selfPaths } from '../shared/self-paths'
import type { HookDeps } from './hook'
import { CONFIG_PARSERS, writeContents } from './write-content'

export const WRITE_GUARD_FAILED = 'buracle: the write guard (H02) failed, so the file was not changed. Retry it; if this repeats, run `buracle doctor claude` and check ~/.buracle/logs/buracle.log.'

export async function writeGuardContext(cwd: string, ctx: AdapterContext, d: HookDeps): Promise<WriteGuardContext> {
  const repo = await d.buracleRepo(cwd, ctx).catch(() => undefined)
  return {
    cwd, home: paths.home(), vault: paths.oldVaultRoot(), protect: ctx.config.guards.write.protect,
    realpath: (q: string): string | undefined => d.realpath(q),
    selfPaths: selfPaths(ctx.config.repo),
    parsers: CONFIG_PARSERS,
    ...(repo !== undefined ? { buracleRepo: repo } : {}),
  }
}

/** The files a write tool changes and the text they get, for the pipeline's write guard (H02). */
export function writeTargets(call: ToolCall, d: Pick<HookDeps, 'realpath'>): WriteTargets {
  return { paths: call.paths, contents: guard => writeContents(call.tool, call.input, call.paths, guard.home, q => d.realpath(q)) }
}

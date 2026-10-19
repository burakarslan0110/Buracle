import type { ToolCall } from '../../core/events'
import { classifyTool } from '../../core/events'
import { mcpWritePaths } from '../../core/policy/mcp-paths'
import type { WriteGuardContext } from '../../core/policy/write-guard'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import type { AdapterContext } from '../registry'
import { selfPaths } from '../shared/self-paths'
import type { HookDeps } from './hook'
import { H, isObj, out, str, type HookOutcome } from './hook-io'
import { CONFIG_PARSERS, writeContents } from './write-content'

export const WRITE_GUARD_FAILED = 'buracle: the write guard (H02) failed, so the file was not changed. Retry it; if this repeats, run `buracle doctor claude` and check ~/.buracle/logs/buracle.log.'

function deny(reason: string): HookOutcome {
  return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}

async function writeGuardContext(cwd: string, ctx: AdapterContext, d: HookDeps): Promise<WriteGuardContext> {
  const repo = await d.buracleRepo(cwd, ctx).catch(() => undefined)
  return {
    cwd, home: paths.home(), vault: paths.oldVaultRoot(), protect: ctx.config.guards.write.protect,
    realpath: (q: string): string | undefined => d.realpath(q),
    selfPaths: selfPaths(ctx.config.repo),
    parsers: CONFIG_PARSERS,
    ...(repo !== undefined ? { buracleRepo: repo } : {}),
  }
}

export async function preWrite(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps): Promise<HookOutcome | undefined> {
  const tool = str(p['tool_name']) ?? ''
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  const cwd = str(p['cwd']) ?? ''
  try {
    const cls = classifyTool(H, tool, input, cwd)
    if (cls.paths.length === 0) return undefined
    const guard = await writeGuardContext(cwd, ctx, d)
    const contents = writeContents(tool, input, cls.paths, guard.home, q => d.realpath(q))
    const verdict = d.core.checkWrite(cls.paths, Object.keys(contents).length > 0 ? { ...guard, contents } : guard)
    if (verdict.deny !== undefined) return deny(verdict.deny)
  } catch (e) {
    log('error', 'claude hook PreToolUse: H02 write guard failed; denying (fail closed)', { sid, tool, error: e })
    return deny(WRITE_GUARD_FAILED)
  }
  return undefined
}

export async function preMcpWrite(sid: string, ctx: AdapterContext, d: HookDeps, call: ToolCall): Promise<HookOutcome | undefined> {
  try {
    const targets = mcpWritePaths(call.tool, call.input, call.mcp)
    if (targets.length === 0) return undefined
    const verdict = d.core.checkWrite(targets, await writeGuardContext(call.cwd, ctx, d))
    if (verdict.deny !== undefined) return deny(`Buracle H02 (guard.write): ${verdict.deny}`)
  } catch (e) {
    log('error', 'claude hook PreToolUse: H02 write guard failed for an MCP call; denying (fail closed)', { sid, tool: call.tool, error: e })
    return deny(WRITE_GUARD_FAILED)
  }
  return undefined
}

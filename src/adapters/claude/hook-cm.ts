import type { ToolCall } from '../../core/events'
import { classifyTool } from '../../core/events'
import { CM_CLAUDE_TOOLS, CM_RESTORE_MAX_BYTES, cmCaptureBlocked } from '../../core/context-mode'
import { laneStateDenialAll } from '../../core/policy/lane-guard'
import { cmCall, cmReviewerDenial, cmToolOfName, looksLikeCmExecTool, sandboxShellCommands } from '../../core/policy/sandbox'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import type { AdapterContext } from '../registry'
import { consentGateAll } from '../shared/consent-store'
import type { CmForwardResult } from '../shared/context-mode/bridge'
import { selfPaths } from '../shared/self-paths'
import type { HookDeps } from './hook'
import { GUARD_FAILED, H, isSubagent, step, str } from './hook-io'
import { pluginRoot, pluginServers } from './hook-route'

export const CM_POST_ONLY_TOOLS: readonly string[] = ['Glob', 'Grep', 'EnterPlanMode', 'Agent', 'EnterWorktree']

export function isCmToolName(tool: string): boolean {
  return cmToolOfName(H, tool) !== undefined || looksLikeCmExecTool(tool)
}

export function classifyMcpCall(sid: string, ctx: AdapterContext, d: Pick<HookDeps, 'env'>, tool: string, input: Record<string, unknown>, cwd: string): ToolCall | undefined {
  try {
    const servers = pluginServers(pluginRoot(ctx.repoRoot, d.env)) ?? []
    return { harness: H, sessionId: sid, cwd, tool, input, ...classifyTool(H, tool, input, cwd, servers) }
  } catch (e) {
    if (!looksLikeCmExecTool(tool)) throw e
    log('error', 'claude hook PreToolUse: a context-mode call could not be classified; denying (fail closed)', { sid, tool, error: e })
    return undefined
  }
}

function serverDir(d: Pick<HookDeps, 'env'>, cwd: string): string {
  const dir = d.env('CLAUDE_PROJECT_DIR')?.trim()
  return dir !== undefined && dir !== '' ? dir : cwd
}

function pinnedDir(call: ToolCall, cwd: string): string | undefined {
  const c = cmCall(call)
  if (c === undefined || (c.tool !== 'ctx_execute' && c.tool !== 'ctx_batch_execute')) return undefined
  return c.input['cwd'] === undefined && cwd !== '' ? cwd : undefined
}

export interface CmVerdict { deny?: string; updatedInput?: Record<string, unknown> }

export async function cmGuard(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number, call: ToolCall): Promise<CmVerdict> {
  const cwd = call.cwd
  const pin = pinnedDir(call, cwd)
  try {
    const repo = await d.buracleRepo(cwd, ctx).catch(() => undefined)
    const home = paths.home()
    const self = selfPaths(ctx.config.repo)
    const v = d.core.checkSandbox(call, {
      bash: { ...ctx.config.guards.bash, home, selfPaths: self, cwd },
      write: {
        cwd, home, vault: paths.oldVaultRoot(), protect: ctx.config.guards.write.protect,
        realpath: (q: string): string | undefined => d.realpath(q), selfPaths: self, ...(repo !== undefined ? { buracleRepo: repo } : {}),
      },
      serverDir: serverDir(d, cwd),
      ...(pin !== undefined ? { pinnedDir: pin } : {}),
    })
    if (v.deny !== undefined) return { deny: `Buracle ${v.hook ?? 'H01'} (${v.hook === 'H02' ? 'guard.write' : 'guard.bash'}): ${v.deny}` }
  } catch (e) {
    log('error', 'claude hook PreToolUse: the context-mode guard (H01/H02) failed; denying (fail closed)', { sid, tool: call.tool, error: e })
    return { deny: GUARD_FAILED }
  }
  const reviewer = await step('reviewer (context-mode)', undefined as string | undefined, () => cmReviewerDenial(str(p['agent_type']), call))
  if (reviewer !== undefined) return { deny: reviewer }
  const lane = isSubagent(p) ? await step('H01 lane guard (context-mode)', undefined as string | undefined, () => laneStateDenialAll(sandboxShellCommands(call))) : undefined
  if (lane !== undefined) return { deny: lane }
  const consent = await step('H20 consent (context-mode)', undefined as string | undefined, () => consentGateAll(H, sid, sandboxShellCommands(call), now, d.core.consentVerdictAll))
  if (consent !== undefined) return { deny: `Buracle H20 (consent.gate): ${consent}` }
  return pin !== undefined ? { updatedInput: { ...call.input, cwd: pin } } : {}
}

export async function cmForwardDefault(event: string, payload: Record<string, unknown>, ctx: AdapterContext, opts: { maxBytes?: number } = {}): Promise<CmForwardResult> {
  if (isSubagent(payload)) return { action: 'none', skipped: 'subagent' }
  const blocked = cmCaptureBlocked({ config: ctx.config, env: process.env })
  if (blocked !== undefined) return { action: 'none', skipped: blocked }
  const { cmForward } = await import('../shared/context-mode/bridge')
  return cmForward(H, event, payload, { config: ctx.config, ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}) })
}

export async function cmBridge(d: Pick<HookDeps, 'cmForward'>, ctx: AdapterContext, event: string, p: Record<string, unknown>, opts?: { maxBytes?: number }): Promise<CmForwardResult | undefined> {
  return step(`H27 context.session (${event})`, undefined as CmForwardResult | undefined, () => d.cmForward(event, p, ctx, opts))
}

export async function cmBridgeTool(d: Pick<HookDeps, 'cmForward'>, ctx: AdapterContext, event: 'PostToolUse' | 'PostToolUseFailure', p: Record<string, unknown>, tool: string): Promise<void> {
  if (CM_CLAUDE_TOOLS.includes(tool)) await cmBridge(d, ctx, event, p)
}

export async function cmSessionStart(p: Record<string, unknown>, ctx: AdapterContext, d: Pick<HookDeps, 'cmForward'>, room: number): Promise<string> {
  const r = await cmBridge(d, ctx, 'SessionStart', p, { maxBytes: Math.max(0, Math.min(CM_RESTORE_MAX_BYTES, Math.floor(room))) })
  return r?.action === 'restore' && typeof r.text === 'string' ? r.text.trim() : ''
}

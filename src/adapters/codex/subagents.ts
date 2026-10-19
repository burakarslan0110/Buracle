import { dirname, join, resolve } from 'node:path'
import type { Harness } from '../../core/events'
import type { WorkspaceInfo } from '../../core/workspace'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import { readSessionAliases, recordSessionAlias, sessionAliasesPath } from '../../workflow/session-store'
import { canonicalDir } from '../../workflow/workspace'
import type { AdapterContext } from '../registry'
import { loadWorkspaceInfo } from './route'

const H: Harness = 'codex'

function present(x: unknown): boolean {
  return typeof x === 'string' && x !== ''
}

function rec(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
}

export function isSubagentPayload(p: Record<string, unknown>): boolean {
  return present(p['agent_id']) || present(p['agent_type'])
}

export function subagentAliasesFile(ctx: Pick<AdapterContext, 'paths'>): string {
  return join(ctx.paths.sessionsDir(H), 'aliases.json')
}

export const MAX_SUBAGENT_ALIASES = 500

export function recordSubagentAlias(ctx: Pick<AdapterContext, 'paths'>, agentId: string, sid: string): void {
  if (!ctx.paths.isValidSessionId(agentId) || agentId === sid) return
  if (resolve(subagentAliasesFile(ctx)) === resolve(sessionAliasesPath(H))) {
    if (readSessionAliases(H)[agentId] !== sid) recordSessionAlias(H, agentId, sid)
    return
  }
  const file = subagentAliasesFile(ctx)
  const r = readJsonSafeSync<unknown>(file)
  const cur = r.ok ? rec(r.value) : {}
  if (cur[agentId] === sid) return
  const kept = Object.entries(cur).filter((e): e is [string, string] => e[0] !== agentId && typeof e[1] === 'string' && ctx.paths.isValidSessionId(e[1]))
  const next: Record<string, string> = {}
  for (const [k, v] of kept.slice(-(MAX_SUBAGENT_ALIASES - 1))) next[k] = v
  next[agentId] = sid
  ensureDirSync(dirname(file))
  atomicWriteSync(file, JSON.stringify(next) + '\n')
}

export function subagentLedgerId(p: Record<string, unknown>, sid: string, ctx: Pick<AdapterContext, 'paths'>): string | undefined {
  const id = p['agent_id']
  return typeof id === 'string' && id !== sid && ctx.paths.isValidSessionId(id) ? id : undefined
}

export interface WorkspaceReaders {
  workspaceInfo?: (cwd: string, ctx: AdapterContext, nowMs: number) => Promise<WorkspaceInfo | undefined>
  refreshWorkspace?: (info: WorkspaceInfo, ctx: AdapterContext, nowMs: number) => WorkspaceInfo
}

export async function subagentWorkspace(sid: string, cwd: string, ctx: AdapterContext, read: WorkspaceReaders, nowMs: number): Promise<WorkspaceInfo | undefined> {
  const saved = loadWorkspaceInfo(ctx, sid)
  if (saved !== undefined && read.refreshWorkspace !== undefined && saved.cwd === canonicalDir(cwd)) return read.refreshWorkspace(saved, ctx, nowMs)
  return read.workspaceInfo?.(cwd, ctx, nowMs)
}

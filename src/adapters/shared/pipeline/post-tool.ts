import type { PostToolDecision } from '../../../core/events'
import type { SpoolEntry } from '../../../core/memory/spool'
import { loadLedger, updateLedger } from '../../../workflow/ledger'
import { updateState } from '../../../workflow/session-store'
import { fileCheckNotes, sessionOnce, type FileCheckDeps } from '../file-checks'
import { assetsAfterEdit, assetsOptions } from '../project-assets'
import { readWorkspace, spool, type PipelineDeps } from './types'

export interface PostToolInput {
  sessionId: string
  cwd: string
  now: number
  subagent: boolean
  /** The files a successful edit changed, with the text it added and removed as far as the call shows it. */
  edit?: { ok: boolean, paths: string[], added: Readonly<Record<string, string>>, removed(): Readonly<Record<string, string>> }
  /** The user answered a question tool (H08). */
  answered?: boolean
  /** An MCP call's outcome for the session's health. */
  mcp?: { server(): string | undefined, ok: boolean }
  /** What the memory spool gets. */
  entries: SpoolEntry[]
}

export interface PostToolPorts {
  fileChecks: Omit<FileCheckDeps, 'once'>
  /** How long the file checks may take, from the hook's start; it follows the hook timeout the harness registers. */
  editBudgetMs: number
}

export interface PostToolResult extends PostToolDecision { fileNotes: string[], assets?: string }

export function recordMcpResult(d: Pick<PipelineDeps, 'harness' | 'core'>, sid: string, server: string | undefined, ok: boolean): void {
  if (server === undefined || server === '') return
  if (ok && loadLedger(d.harness, sid).mcpErrors?.[server] === undefined) return
  updateLedger(d.harness, sid, l => d.core.ledgerMcpResult(l, server, ok))
}

/** postTool: the memory UI's heartbeat, file checks (H04) and project assets (H28) after an edit, the answer receipt (H08), the spool (H14) and MCP health (H24). */
export async function postTool(input: PostToolInput, d: PipelineDeps & PostToolPorts): Promise<PostToolResult> {
  const { sessionId: sid, cwd, now, edit, mcp } = input
  const H = d.harness
  const out: PostToolResult = { context: [], fileNotes: [] }
  if (!input.subagent) await d.step('H14 memory UI', undefined, () => d.ui.seen(H, sid, now))
  if (edit !== undefined && edit.ok && edit.paths.length > 0) {
    out.fileNotes = await d.step('H04 file checks', [] as string[], () => fileCheckNotes(edit.paths, edit.added, cwd, d.ctx.config.checkers, { ...d.fileChecks, once: sessionOnce(H, sid) }, now + d.editBudgetMs, edit.removed()))
    const assets = await d.step('H28 project assets', undefined as string | undefined, () => assetsAfterEdit(readWorkspace(d.ctx, H, sid)?.root, edit.paths, assetsOptions(now, d.assetsSpawn)))
    if (assets !== undefined) out.assets = assets
  }
  if (input.answered === true) await d.step('H08 answer receipt', undefined, () => { updateState(H, sid, s => d.core.answerReceipt(s, now)) })
  await spool(d, sid, input.entries)
  if (mcp !== undefined) await d.step('H24 MCP result', undefined, () => { recordMcpResult(d, sid, mcp.server(), mcp.ok) })
  out.context = [...out.fileNotes, ...(out.assets !== undefined ? [out.assets] : [])]
  return out
}

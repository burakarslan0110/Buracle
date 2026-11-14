import type { Harness, PostToolDecision } from '../../../core/events'
import type { SpoolEntry } from '../../../core/memory/spool'
import { loadLedger, updateLedger } from '../../../workflow/ledger'
import { fileCheckNotes, type FileCheckDeps } from '../file-checks'
import { assetsAfterEdit, assetsOptions } from '../project-assets'
import type { PipelineDeps } from './types'

export interface PostToolInput {
  harness: Harness
  sessionId: string
  cwd: string
  now: number
  subagent: boolean
  /** The files a successful edit changed, with the text it added and removed as far as the call shows it. */
  edit?: { ok: boolean, paths: string[], added: Readonly<Record<string, string>>, removed(): Readonly<Record<string, string>> }
  /** The user answered a question tool (H08). */
  answered?: boolean
  /** An MCP call's outcome for the session's health; `first` records it before the tool's own steps. */
  mcp?: { server(): string | undefined, ok: boolean, first?: boolean }
  /** What the memory spool gets; read when the spool step runs, so a `postTool.tool` step may add to it. */
  entries: SpoolEntry[]
}

export interface PostToolPorts {
  fileCheckDeps(): FileCheckDeps
  /** Record that the user answered (H08). */
  answerReceipt(): void
  /** How long the file checks may take, from the hook's start. */
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
  const mcpResult = () => d.step('H24 MCP result', undefined, () => { if (mcp !== undefined) recordMcpResult(d, sid, mcp.server(), mcp.ok) })
  if (!input.subagent) await d.step('H14 memory UI', undefined, () => d.ui.seen(H, sid, now))
  if (mcp?.first === true) await mcpResult()
  await d.at?.('postTool.tool')
  if (edit !== undefined && edit.ok && edit.paths.length > 0) {
    out.fileNotes = await d.step('H04 file checks', [] as string[], () => fileCheckNotes(edit.paths, edit.added, cwd, d.ctx.config.checkers, d.fileCheckDeps(), now + d.editBudgetMs, edit.removed()))
    await d.at?.('postTool.checked')
    const assets = await d.step('H28 project assets', undefined as string | undefined, () => assetsAfterEdit(d.workspace.read(sid)?.root, edit.paths, assetsOptions(now, d.assetsSpawn)))
    if (assets !== undefined) out.assets = assets
    await d.at?.('postTool.edited')
  }
  if (input.answered === true) await d.step('H08 answer receipt', undefined, () => { d.answerReceipt() })
  await d.spool(sid, input.entries)
  if (mcp !== undefined && mcp.first !== true) await mcpResult()
  out.context = [...out.fileNotes, ...(out.assets !== undefined ? [out.assets] : [])]
  return out
}

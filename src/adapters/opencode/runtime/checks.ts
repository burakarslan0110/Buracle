import { harnessProfile } from '../../../core/harness/index'
import type { BuracleConfig } from '../../../core/config'
import type { ToolKind } from '../../../core/events'
import { parseApplyPatch } from '../../../core/events'
import type { CheckerPlan } from '../../../core/checkers'
import { patchEdits } from '../../../core/policy/code-facts'
import { removedByFile, type CheckerResult } from '../../shared/checker-scan'

export type CheckerRunner = (plan: CheckerPlan, timeoutMs?: number) => Promise<CheckerResult | null>

/** How long the file checks (H04) may take after an edit; OpenCode waits for the tool hook without a timeout of its own. */
export const OPENCODE_H04_BUDGET_MS = harnessProfile('opencode').editBudgetMs
export const OPENCODE_LSP_BUDGET_MS = 12_000

export type LspEditAsk = (files: readonly string[], opts: { cwd: string, deadlineMs: number, now: () => number }) => Promise<string[]>

type Log = (level: 'debug' | 'warn', msg: string, data?: unknown) => void

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

/** The text an OpenCode edit tool adds to and removes from each file, as far as its input shows it. */
export function editTexts(kind: ToolKind, files: readonly string[], input: Record<string, unknown>, cwd: string, home: string): { added: Record<string, string>, removed: Record<string, string> } {
  const added: Record<string, string> = {}
  const removed: Record<string, string> = {}
  const first = files[0]
  if (kind === 'write') { const c = str(input['content']); if (c !== undefined && first !== undefined) added[first] = c }
  if (kind === 'edit' && first !== undefined) {
    const news: string[] = []
    const olds: string[] = []
    const take = (o: unknown): void => {
      if (o === null || typeof o !== 'object') return
      const r = o as Record<string, unknown>
      const n = str(r['newString'])
      const old = str(r['oldString'])
      if (n !== undefined) news.push(n)
      if (old !== undefined) olds.push(old)
    }
    take(input)
    if (Array.isArray(input['edits'])) input['edits'].forEach(take)
    if (news.length > 0) added[first] = news.join('\n')
    if (olds.length > 0) removed[first] = olds.join('\n')
  }
  if (kind === 'patch') {
    const text = str(input['patchText']) ?? str(input['patch'])
    if (text !== undefined) {
      Object.assign(added, parseApplyPatch(text, cwd, { homeTilde: home }).added)
      Object.assign(removed, removedByFile(patchEdits(text), files))
    }
  }
  return { added, removed }
}

export async function lspEditNotes(files: readonly string[], cfg: BuracleConfig['checkers'], deps: { cwd: string, ask: LspEditAsk, log: Log, now?: () => number }): Promise<string[]> {
  if (!cfg.enabled || files.length === 0) return []
  const now = deps.now ?? Date.now
  try {
    return await deps.ask(files, { cwd: deps.cwd, deadlineMs: now() + OPENCODE_LSP_BUDGET_MS, now })
  } catch (err) {
    deps.log('warn', 'H04 language server failed', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

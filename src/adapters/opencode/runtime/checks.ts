import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import type { ToolKind } from '../../../core/events'
import { parseApplyPatch } from '../../../core/events'
import type { CheckerPlan } from '../../../core/checkers'
import { charsetFindings, checkersFor, findingsOf, lengthNote, tddHint } from '../../../core/checkers'
import { patchEdits } from '../../../core/policy/code-facts'
import { checkOneFile, nodeCheckFs, removedByFile, type CheckerResult, type CheckFs } from '../../shared/checker-scan'

export type CheckerRunner = (plan: CheckerPlan, timeoutMs?: number) => Promise<CheckerResult | null>

export const OPENCODE_H04_BUDGET_MS = 20_000
export const OPENCODE_LSP_BUDGET_MS = 12_000
export const MAX_CHECKED_FILES = 5

export type LspEditAsk = (files: readonly string[], opts: { cwd: string, deadlineMs: number, now: () => number }) => Promise<string[]>

export interface FileCheckDeps {
  root: string
  cwd: string
  home: string
  run: CheckerRunner
  log: (level: 'debug' | 'warn', msg: string, data?: unknown) => void
  now?: () => number
  once?: (key: string) => boolean
  fs?: CheckFs
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

function editTexts(kind: ToolKind, files: readonly string[], input: Record<string, unknown>, cwd: string, home: string): { added: Record<string, string>, removed: Record<string, string> } {
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

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

export async function fileChecks(kind: ToolKind, files: string[], input: Record<string, unknown>, cfg: BuracleConfig['checkers'], deps: FileCheckDeps): Promise<string[]> {
  if (!cfg.enabled) return []
  const now = deps.now ?? Date.now
  const deadlineMs = now() + OPENCODE_H04_BUDGET_MS
  const { added, removed } = editTexts(kind, files, input, deps.cwd, deps.home)
  const notes: string[] = []
  for (const file of files.slice(0, MAX_CHECKED_FILES)) {
    if (!isFile(file)) continue
    const name = basename(file)
    const found = await checkOneFile({
      api: { checkersFor, findingsOf, tddHint, charsetFindings, lengthNote },
      fs: deps.fs ?? nodeCheckFs,
      now,
      run: (plan, timeoutMs) => deps.run(plan, timeoutMs),
      guard: async (what, fallback, fn) => {
        try { return await fn() } catch (err) { deps.log('warn', `H04 ${what} failed`, { file, error: err instanceof Error ? err.message : String(err) }); return fallback }
      },
      ...(deps.once !== undefined ? { once: deps.once } : {}),
    }, { file, cwd: deps.cwd, root: deps.root, home: deps.home, ...(added[file] !== undefined ? { added: added[file] } : {}), ...(removed[file] !== undefined ? { removed: removed[file] } : {}), deadlineMs }, cfg)
    for (const n of found) notes.push(n.kind === 'tdd' ? n.text : `${name}: ${n.text}`)
  }
  return notes
}

export async function lspEditNotes(files: readonly string[], cfg: BuracleConfig['checkers'], deps: { cwd: string, ask: LspEditAsk, log: FileCheckDeps['log'], now?: () => number }): Promise<string[]> {
  if (!cfg.enabled || files.length === 0) return []
  const now = deps.now ?? Date.now
  try {
    return await deps.ask(files, { cwd: deps.cwd, deadlineMs: now() + OPENCODE_LSP_BUDGET_MS, now })
  } catch (err) {
    deps.log('warn', 'H04 language server failed', { error: err instanceof Error ? err.message : String(err) })
    return []
  }
}

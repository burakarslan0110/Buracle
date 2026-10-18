import type { BuracleConfig } from '../../../core/config'
import type { ToolKind } from '../../../core/events'
import { parseApplyPatch } from '../../../core/events'
import { patchEdits } from '../../../core/policy/code-facts'
import { ledgerOnce } from '../../../core/policy/usage'
import { checkOneFile, nodeCheckFs, removedByFile, type CheckFs } from '../../shared/checker-scan'
import type { ExtensionDeps } from './deps'
import type { EditTargets } from './edits'

export const MAX_CHECKED_FILES = 5
export const OMP_H04_BUDGET_MS = 20_000

export interface CheckHost {
  deps: Pick<ExtensionDeps, 'checkers' | 'run' | 'isFile' | 'now' | 'resolveChecker'> & { checkFs?: CheckFs }
  guarded<T>(what: string, fn: () => T): T | undefined
  report(what: string, e: unknown): void
  once?(key: string): boolean
}

export interface CheckOptions {
  root?: string
  home?: string
  removed?: Record<string, string>
  deadlineMs?: number
}

const PATCH_FIELDS = ['input', 'patch', 'patchText']

export function ledgerOnceFn(ledger: Pick<ExtensionDeps['ledger'], 'update'>, lsid: string | undefined): ((key: string) => boolean) | undefined {
  if (lsid === undefined) return undefined
  return key => {
    let fresh = false
    ledger.update(lsid, l => { const r = ledgerOnce(l, key); fresh = r.fresh; return r.next })
    return fresh
  }
}

export function addedTextOf(kind: ToolKind, input: Record<string, unknown>, files: string[], cwd: string, targets: EditTargets | undefined, home?: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (targets !== undefined) {
    for (const c of targets.changes) if (c.added !== '') out[c.file] = c.added
    return out
  }
  const first = files[0]
  if (kind === 'write' && first !== undefined && typeof input['content'] === 'string') out[first] = input['content']
  if (kind === 'patch') {
    for (const f of PATCH_FIELDS) {
      const t = input[f]
      if (typeof t === 'string' && t.includes('***')) Object.assign(out, parseApplyPatch(t, cwd, home !== undefined ? { homeTilde: home } : undefined).added)
    }
  }
  if (kind === 'edit' && first !== undefined) {
    const parts: string[] = []
    const take = (o: unknown) => {
      if (o === null || typeof o !== 'object') return
      for (const k of ['new_string', 'newString', 'newText', 'replacement', 'content', 'text']) {
        const v = (o as Record<string, unknown>)[k]
        if (typeof v === 'string') parts.push(v)
      }
    }
    take(input)
    const edits = input['edits']
    if (Array.isArray(edits)) edits.forEach(take)
    if (parts.length > 0) out[first] = parts.join('\n')
  }
  return out
}

export function removedTextOf(kind: ToolKind, input: Record<string, unknown>, files: string[], targets: EditTargets | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (targets !== undefined) {
    for (const c of targets.changes) if (c.removed !== '') out[c.file] = c.removed
    return out
  }
  if (kind === 'patch') {
    for (const f of PATCH_FIELDS) {
      const t = input[f]
      if (typeof t === 'string' && t.includes('***')) Object.assign(out, removedByFile(patchEdits(t), files))
    }
  }
  const first = files[0]
  if (kind === 'edit' && first !== undefined) {
    const parts: string[] = []
    const take = (o: unknown) => {
      if (o === null || typeof o !== 'object') return
      for (const k of ['old_string', 'oldString', 'oldText']) {
        const v = (o as Record<string, unknown>)[k]
        if (typeof v === 'string') parts.push(v)
      }
    }
    take(input)
    const edits = input['edits']
    if (Array.isArray(edits)) edits.forEach(take)
    if (parts.length > 0) out[first] = parts.join('\n')
  }
  return out
}

export async function checkFiles(host: CheckHost, files: string[], added: Record<string, string>, cwd: string, cfg: BuracleConfig['checkers'], opts: CheckOptions = {}): Promise<string[]> {
  const { deps } = host
  const notes: string[] = []
  const deadlineMs = opts.deadlineMs ?? deps.now() + OMP_H04_BUDGET_MS
  const removed = opts.removed ?? {}
  const once = host.once
  for (const file of files.slice(0, MAX_CHECKED_FILES)) {
    if (!deps.isFile(file)) continue
    const found = await checkOneFile({
      api: deps.checkers,
      fs: deps.checkFs ?? nodeCheckFs,
      now: () => deps.now(),
      run: async (plan, timeoutMs) => {
        const r = await deps.run(plan.argv, { cwd: plan.cwd, timeoutMs, ...(plan.env !== undefined ? { env: plan.env } : {}) })
        return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
      },
      guard: async (what, fallback, fn) => {
        try { return await fn() } catch (e) { host.report(`H04 ${what}`, e); return fallback }
      },
      ...(once !== undefined ? { once: (key: string) => host.guarded('H04 once', () => once(key)) ?? true } : {}),
      ...(deps.resolveChecker !== undefined ? { resolve: deps.resolveChecker } : {}),
    }, { file, cwd, root: opts.root ?? cwd, ...(opts.home !== undefined ? { home: opts.home } : {}), ...(added[file] !== undefined ? { added: added[file] } : {}), ...(removed[file] !== undefined ? { removed: removed[file] } : {}), deadlineMs }, cfg)
    notes.push(...found.map(n => n.text))
  }
  return notes
}

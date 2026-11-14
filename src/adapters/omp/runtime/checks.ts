import type { ToolKind } from '../../../core/events'
import { parseApplyPatch } from '../../../core/events'
import { patchEdits } from '../../../core/policy/code-facts'
import { removedByFile } from '../../shared/checker-scan'
import type { EditTargets } from './edits'

export const OMP_H04_BUDGET_MS = 20_000

const PATCH_FIELDS = ['input', 'patch', 'patchText']

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

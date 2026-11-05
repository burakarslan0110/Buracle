import { resolvePath } from '../../core/events'
import { patchEdits } from '../../core/policy/code-facts'
import type { ReceiptChange } from '../../core/receipt'
import { log } from '../../engine/log'
import { patchTextOf } from './write-content'

function text(x: unknown): string {
  return typeof x === 'string' ? x : ''
}

function rec(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
}

export function patchReceiptChanges(patch: string, cwd: string, home?: string): ReceiptChange[] {
  return patchEdits(patch).flatMap(e => {
    const path = resolvePath(cwd, e.path, home)
    return path !== undefined ? [{ path, removed: e.removed, added: e.added }] : []
  })
}

export function opencodeReceiptChanges(tool: string, input: Record<string, unknown>, paths: readonly string[], cwd: string, home?: string): ReceiptChange[] {
  const path = paths[0]
  if (tool === 'write') return path !== undefined ? [{ path, removed: '', added: text(input['content']) }] : []
  if (tool === 'edit') return path !== undefined ? [{ path, removed: text(input['oldString']), added: text(input['newString']) }] : []
  if (tool === 'multiedit' && Array.isArray(input['edits']) && path !== undefined) {
    const edits = (input['edits'] as unknown[]).map(rec)
    return [{ path, removed: edits.map(e => `${text(e['oldString'])}\n`).join(''), added: edits.map(e => `${text(e['newString'])}\n`).join('') }]
  }
  if (tool === 'patch' || tool === 'apply_patch') {
    const patch = patchTextOf(input)
    return patch !== undefined ? patchReceiptChanges(patch, cwd, home) : []
  }
  return paths.map(p => ({ path: p, removed: '', added: '' }))
}

export function spawnNotify(cli: readonly string[] | undefined, title: string, message: string): boolean {
  if (cli === undefined || cli.length === 0) return false
  try {
    const child = Bun.spawn([...cli, 'notify', 'info', title, message], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, env: { ...process.env } })
    child.unref()
    return true
  } catch (e) {
    log('warn', 'turn notification: spawn failed', { error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

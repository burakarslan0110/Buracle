import { deviationPaths, filePaths, inventoryRows, listedPaths, pathCovered } from './authoring'
import { planOutline } from './format'

export type AuditCode = 'unimplemented' | 'delete-pending' | 'rename-mismatch' | 'unplanned' | 'inventory-open'
export interface DiffEntry { status: string, path: string, from?: string }
export interface AuditFinding { level: 'warning' | 'info', code: AuditCode, message: string, path?: string, task?: number }
export interface AuditOptions { exists: (path: string) => boolean, ignore?: readonly string[] }

const PLAN_FILE = /^docs\/(?:plans|builds)\/[^/]+\.md$/

export function parseNameStatus(z: string): DiffEntry[] {
  const parts = z.split('\0')
  const out: DiffEntry[] = []
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i] ?? ''
    if (status === '') continue
    const kind = status[0] as string
    if (kind === 'R' || kind === 'C') {
      const from = parts[i + 1]
      const to = parts[i + 2]
      i += 2
      if (from !== undefined && to !== undefined && from !== '' && to !== '') out.push({ status: kind, path: to, from })
      continue
    }
    const path = parts[i + 1]
    i += 1
    if (path !== undefined && path !== '') out.push({ status: kind, path })
  }
  return out
}

export function auditPlan(markdown: string, changes: readonly DiffEntry[], o: AuditOptions): AuditFinding[] {
  const outline = planOutline(markdown)
  const status = new Map<string, string>()
  const renamed = new Map<string, string>()
  for (const c of changes) {
    status.set(c.path, c.status)
    if (c.status === 'R' && c.from !== undefined) renamed.set(c.from, c.path)
  }
  const under = (p: string) => p.endsWith('/') ? [...status.keys()].filter(k => k.startsWith(p)) : []
  const changedOk = (p: string): boolean => {
    const s = status.get(p)
    if (s !== undefined) return s !== 'D'
    return under(p).some(k => status.get(k) !== 'D')
  }
  const out: AuditFinding[] = []
  for (const card of outline.cards) {
    const level: AuditFinding['level'] = card.done ? 'warning' : 'info'
    const open = card.done ? '' : ' (the task is not ticked yet)'
    for (const f of card.files) {
      const [p, q] = filePaths(f.path)
      if (p === undefined) continue
      const add = (code: AuditCode, message: string) => out.push({ level, code, message: `Task ${card.n}: ${message}${open}`, path: p, task: card.n })
      if (f.verb === 'Create' || f.verb === 'Modify') {
        if (changedOk(p)) continue
        if (status.get(p) === 'D') add('unimplemented', `${f.verb} \`${p}\`, but the diff deletes it`)
        else if (f.verb === 'Create' && !o.exists(p)) add('unimplemented', `Create \`${p}\`, but the file does not exist`)
        else add('unimplemented', `${f.verb} \`${p}\`, but the diff does not change it${f.verb === 'Create' ? ' (it existed before this run; did the plan mean Modify?)' : ''}`)
      } else if (f.verb === 'Test') {
        if (changedOk(p)) continue
        if (!o.exists(p)) add('unimplemented', `Test \`${p}\`, but the file does not exist`)
        else out.push({ level: 'info', code: 'unimplemented', message: `Task ${card.n}: Test \`${p}\` is unchanged; fine when the task only runs it${open}`, path: p, task: card.n })
      } else if (f.verb === 'Delete') {
        if (o.exists(p)) add('delete-pending', `Delete \`${p}\`, but the file still exists`)
        else if (status.get(p) !== 'D' && !renamed.has(p) && under(p).length === 0) add('delete-pending', `Delete \`${p}\`: the file is gone, but the diff does not delete it (was it in the base at all?)`)
      } else if (q !== undefined) {
        const problems: string[] = []
        if (o.exists(p)) problems.push(`\`${p}\` still exists`)
        if (!o.exists(q)) problems.push(`\`${q}\` does not exist`)
        if (problems.length === 0 && renamed.get(p) !== q && !(status.get(p) === 'D' && status.has(q))) problems.push('the diff shows no rename between them')
        if (problems.length > 0) add('rename-mismatch', `Rename \`${p}\` to \`${q}\`, but ${problems.join(' and ')}`)
      } else {
        const asOld = !o.exists(p) && (renamed.has(p) || status.get(p) === 'D')
        const asNew = o.exists(p) && [...renamed.values()].includes(p)
        if (!asOld && !asNew) add('rename-mismatch', `Rename \`${p}\`, but the diff shows no rename of it (write the line as \`old\` -> \`new\`)`)
      }
    }
  }
  const covered = [...listedPaths(outline), ...deviationPaths(outline)]
  const ignore = new Set(o.ignore ?? [])
  for (const c of changes) {
    const names = c.from !== undefined ? [c.path, c.from] : [c.path]
    if (names.some(n => ignore.has(n) || PLAN_FILE.test(n) || pathCovered(n, covered))) continue
    out.push({ level: 'warning', code: 'unplanned', message: `\`${c.path}\` changed (${c.status}${c.from !== undefined ? ` from \`${c.from}\`` : ''}), but no task's Files and no \`## Deviations\` line names it`, path: c.path })
  }
  const cards = new Map(outline.cards.map(c => [c.n, c]))
  for (const r of inventoryRows(outline)) {
    if (r.tasks.length === 0) {
      if (r.reason === undefined) out.push({ level: 'warning', code: 'inventory-open', message: `Inventory row "${r.item}" names no task that keeps it and no reason for dropping it` })
      continue
    }
    for (const n of r.tasks) {
      const card = cards.get(n)
      if (card === undefined) out.push({ level: 'warning', code: 'inventory-open', message: `Inventory row "${r.item}" names Task ${n}, which the plan does not have`, task: n })
      else if (!card.done) out.push({ level: 'warning', code: 'inventory-open', message: `Inventory row "${r.item}" is kept by Task ${n}, which is not ticked`, task: n })
    }
  }
  return out
}

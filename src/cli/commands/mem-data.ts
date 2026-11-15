import { BACKUP_BUDGET } from '../../core/memory/budgets'
import type { BrainChoice } from '../../memory/backup'

export interface MemDataArgs {
  rest: string[]
  int(k: string): number | undefined
  has(k: string): boolean
  project(): string | undefined
  out(value: unknown, text: string): void
  usage(message: string): never
}

const size = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function choiceOf(a: MemDataArgs, opts: { all: 'default' | 'flag' }): BrainChoice | undefined {
  const project = a.project()
  const picks = [project !== undefined, a.has('person'), a.has('all')].filter(Boolean).length
  if (picks > 1) a.usage('pass one of --project SLUG, --person or --all')
  if (project !== undefined) return { project }
  if (a.has('person')) return { person: true }
  if (a.has('all') || opts.all === 'default') return { all: true }
  return undefined
}

export async function memDataCommand(sub: 'backup' | 'restore', a: MemDataArgs): Promise<number> {
  const b = await import('../../memory/backup')
  if (sub === 'backup') {
    if (a.has('list')) {
      const list = b.listBackups()
      a.out({ backups: list }, list.length === 0 ? 'No backups yet: `buracle mem backup` takes one.' : list.map(m => `${m.id}  ${m.at.slice(0, 16).replace('T', ' ')}  ${m.trigger}  ${b.backupBuckets(m).join(', ')}  (${size(b.backupBytes(m))})`).join('\n'))
      return 0
    }
    if (a.project() !== undefined || a.has('person')) {
      a.usage('a backup holds the whole brain file (every bucket), so --project and --person do not apply to it; --project, --person and --all choose what `buracle mem restore` takes out of a backup')
    }
    const keep = a.int('keep')
    if (keep !== undefined && (keep < 1 || keep > 100)) a.usage('--keep must be between 1 and 100')
    const r = await b.backupBrains({ all: true }, { trigger: 'manual', keep: keep ?? BACKUP_BUDGET.keep })
    if (r.manifest === undefined) { a.out(r, 'Nothing to back up: there is no brain file yet.'); return 0 }
    const m = r.manifest
    a.out(r, [
      `Backup ${m.id}: the whole brain (${b.backupBuckets(m).join(', ') || 'empty'}; ${size(m.file.bytes)}) in ${r.dir ?? ''}`,
      ...(r.pruned.length > 0 ? [`removed older backups: ${r.pruned.join(', ')}`] : []),
      `Restore with: buracle mem restore ${m.id} (--project SLUG | --person | --all)`,
    ].join('\n'))
    return 0
  }
  const id = a.rest[0]
  if (id === undefined) a.usage('usage: buracle mem restore ID (--project SLUG | --person | --all); buracle mem backup --list shows the ids')
  const choice = choiceOf(a, { all: 'flag' })
  if (choice === undefined) a.usage('name what to restore: --project SLUG, --person or --all (a restore replaces the brain file)')
  const r = await b.restoreBackup(id, choice)
  a.out(r, [
    `Restored from ${r.id}: ${r.restored.map(x => (x.all === true ? 'the whole brain file' : `${x.layer === 'person' ? 'the person brain' : `project ${x.project ?? ''}`}${x.memories !== undefined ? ` (${x.memories} memories)` : ''}`)).join(', ')}`,
    ...(r.safety !== undefined ? [`The brain as it was before is in backup ${r.safety} (buracle mem restore ${r.safety} --all puts it back).`] : []),
    ...(r.stopped > 0 ? [`Stopped ${r.stopped} running CortexDB reader(s); their sessions start a new one at their next memory call.`] : []),
  ].join('\n'))
  return 0
}

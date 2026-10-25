import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BACKUP_BUDGET } from '../../core/memory/budgets'
import type { MemoryCtx } from '../../memory/api'
import type { BrainChoice } from '../../memory/backup'

export interface MemDataArgs {
  rest: string[]
  json: boolean
  one(k: string): string | undefined
  many(k: string): string[]
  int(k: string): number | undefined
  has(k: string): boolean
  project(): string | undefined
  ctx(): Promise<MemoryCtx>
  stdin(): Promise<string>
  out(value: unknown, text: string): void
  write(text: string): void
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

export async function memDataCommand(sub: 'backup' | 'restore' | 'export' | 'import', a: MemDataArgs): Promise<number> {
  const b = await import('../../memory/backup')
  if (sub === 'backup') {
    if (a.has('list')) {
      const list = b.listBackups()
      a.out({ backups: list }, list.length === 0 ? 'No backups yet: `buracle mem backup` takes one.' : list.map(m => `${m.id}  ${m.at.slice(0, 16).replace('T', ' ')}  ${m.trigger}  ${b.backupBuckets(m).join(', ')}  (${size(b.backupBytes(m))})${m.v === 1 ? '  [Buracle 0.5: restores bucket by bucket]' : ''}`).join('\n'))
      return 0
    }
    if (a.project() !== undefined || a.has('person')) {
      a.usage('a backup holds the whole brain file (every bucket), so --project and --person do not apply to it: save one bucket with `buracle mem export --project SLUG` (or --person); --project, --person and --all choose what `buracle mem restore` takes out of a backup')
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
  if (sub === 'restore') {
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
  const ex = await import('../../memory/export')
  if (sub === 'export') {
    const { personRef, projectRef } = await import('../../memory/store')
    const { currentProject } = await import('../../memory/api')
    if (a.has('all')) a.usage('an export holds one brain: pass --project SLUG or --person')
    const choice = choiceOf(a, { all: 'flag' })
    let ref
    if (choice !== undefined && 'person' in choice) ref = personRef()
    else {
      const slug = choice !== undefined && 'project' in choice ? choice.project : await currentProject(await a.ctx())
      if (slug === undefined) a.usage('this folder is not inside a project: pass --project SLUG or --person')
      ref = projectRef(slug)
    }
    const r = await ex.exportBrain(ref, { kinds: a.many('type') })
    const file = a.one('out')
    if (file === undefined) { a.write(r.text); return 0 }
    const { atomicWriteSync } = await import('../../engine/fsx')
    atomicWriteSync(resolve(file), r.text, { mode: 0o600 })
    a.out(r.header, `Exported ${r.header.count} memories of ${ref.layer === 'person' ? 'the person brain' : `project ${ref.slug ?? ''}`} to ${resolve(file)}`)
    return 0
  }
  const src = a.rest[0]
  if (src === undefined) a.usage('usage: buracle mem import FILE|- [--project SLUG] [--dry-run]')
  const text = src === '-' ? await a.stdin() : readFileSync(resolve(src), 'utf8')
  const ctx = await a.ctx()
  const slug = a.project()
  if (slug !== undefined) {
    const { readProjectsCache, slugExclusion } = await import('../../memory/project')
    const { bucketExists, projectRef } = await import('../../memory/store')
    if (readProjectsCache().projects[slug] === undefined && !(await bucketExists(projectRef(slug)))) a.usage(`there is no project ${slug} here; run the import in the project's folder once, or pass a known slug`)
    const excluded = await slugExclusion(slug)
    if (excluded !== undefined) {
      const { MemoryError } = await import('../../memory/api')
      throw new MemoryError('no_project', `the project ${slug} is ${excluded}; nothing was imported`)
    }
    ctx.project = slug
  }
  const r = await ex.importMemories(ctx, text, { dryRun: a.has('dry-run') })
  a.out(r, [
    `${r.dryRun ? 'Would import' : 'Imported'} ${r.imported.length} of ${r.imported.length + r.skipped.length} memories from the export of ${r.from.project ?? 'the person brain'} (${r.from.at.slice(0, 10)}); they start unverified:`,
    ...r.imported.map(i => `  + ${i.layer === 'person' ? 'person/' : ''}${i.id} (${i.kind}) <- ${i.from}`),
    ...(r.skipped.length > 0 ? [`Skipped ${r.skipped.length}:`, ...r.skipped.slice(0, 40).map(s => `  - ${s.from}: ${s.reason}`)] : []),
  ].join('\n'))
  return 0
}

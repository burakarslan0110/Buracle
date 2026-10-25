import type { MigrateReport } from '../../memory/migrate'

export interface MemMigrateArgs {
  json: boolean
  has(k: string): boolean
  out(value: unknown, text: string): void
  /** A progress line while the memories are copied (stderr); not called for --json. */
  progress(line: string): void
  usage(message: string): never
}

function reportText(r: MigrateReport): string {
  if (!r.ran) return 'Nothing to migrate: the memory is already one file, brain.db.'
  const lines = [`Migrated Buracle 0.5's brain files into brain.db${r.backup !== undefined ? ` (verified copies first: backups/${r.backup})` : ''}:`]
  for (const f of r.files) {
    lines.push(f.bucket === 'absorbed' ? `  ${f.path}: an archive of a folded project, kept as it is (${f.rows} rows)` : `  ${f.path} -> ${f.bucket}: ${f.memories} memories, ${f.written} written${f.skipped > 0 ? `, ${f.skipped} already there` : ''}`)
  }
  if (r.profile !== undefined) lines.push(`  profile claims: ${r.profile.written} of ${r.profile.claims} became preference memories`)
  if (r.moved.length > 0) lines.push(`Moved aside, not deleted: ${r.moved.join(', ')} -> brain/legacy-0.5`)
  if (r.leftover.length > 0) lines.push(`Could not move (a process still holds them): ${r.leftover.join(', ')}; they are not migrated again`)
  if (r.cleaned.length > 0) lines.push(`Tidied: ${r.cleaned.join(', ')}`)
  lines.push('`buracle mem migrate --rollback` puts the 0.5 files back; `buracle mem migrate --purge-legacy` deletes them and the copies once you are sure.')
  return lines.join('\n')
}

/** `buracle mem migrate [--status] [--dry-run] [--rollback [--force]] [--purge-legacy]` */
export async function memMigrateCommand(a: MemMigrateArgs): Promise<number> {
  const picks = ['status', 'dry-run', 'rollback', 'purge-legacy'].filter(k => a.has(k))
  if (picks.length > 1) a.usage('pass one of --status, --dry-run, --rollback or --purge-legacy')
  if (a.has('force') && !a.has('rollback')) a.usage('--force goes with --rollback')
  const m = await import('../../memory/migrate')
  if (a.has('status')) {
    const s = await m.migrationStatus()
    const mk = s.marker
    a.out(s, [
      `Migration: ${s.state}${mk?.finishedAt !== undefined ? ` (finished ${mk.finishedAt})` : mk !== undefined ? ` (started ${mk.startedAt})` : ''}`,
      s.legacy.length > 0 ? `Buracle 0.5 files waiting: ${s.legacy.join(', ')}` : 'No Buracle 0.5 file waits.',
      `brain.db: ${s.brain.exists ? `person ${s.brain.person}${Object.entries(s.brain.projects).map(([k, n]) => `, ${k} ${n}`).join('')}` : 'does not exist yet'}`,
      ...(s.backup !== undefined ? [`Verified copies before the migration: backups/${s.backup}`] : []),
      ...(s.keptLegacy ? ['Moved-aside 0.5 files: brain/legacy-0.5'] : []),
      ...(mk?.error !== undefined ? [`Last error: ${mk.error}`] : []),
    ].join('\n'))
    return s.state === 'failed' ? 1 : 0
  }
  if (a.has('dry-run')) {
    const d = await m.dryRun()
    a.out(d, [
      d.files.length === 0 ? 'No Buracle 0.5 file waits; nothing would change.' : 'Would migrate (nothing was changed):',
      ...d.files.map(f => (f.bucket === 'absorbed' ? `  ${f.path}: an archive, would be backed up and moved aside` : `  ${f.path} -> ${f.bucket}: ${f.memories} memories, ${f.wouldWrite} to write`)),
      ...(d.claims > 0 ? [`  profile claims: ${d.claims} (the ones the user stated become preference memories)`] : []),
      ...(d.obsolete.length > 0 ? [`Would move aside: ${d.obsolete.join(', ')}`] : []),
    ].join('\n'))
    return 0
  }
  if (a.has('rollback')) {
    const r = await m.rollback({ force: a.has('force') })
    a.out(r, [
      `Put back ${r.restored.length} Buracle 0.5 file(s)${r.restored.length > 0 ? `: ${r.restored.join(', ')}` : ''}${r.stateRestored.length > 0 ? ` and ${r.stateRestored.length} state file(s)` : ''}.`,
      r.keptBrain !== undefined ? `The migrated brain is kept as ${r.keptBrain} (--force deletes it).` : r.removedBrain ? 'The migrated brain.db was deleted (--force).' : 'There was no brain.db.',
      'Install the previous Buracle to use these files; this one migrates them again the next time it reads the memory.',
    ].join('\n'))
    return 0
  }
  if (a.has('purge-legacy')) {
    const r = await m.purgeLegacy()
    a.out(r, r.removed.length > 0 ? `Deleted: ${r.removed.join(', ')}` : 'Nothing to delete: the moved-aside 0.5 files and the copies are already gone.')
    return 0
  }
  const r = await m.runMigration({ waitMs: 60_000, ...(a.json ? {} : { onProgress: a.progress }) })
  a.out(r, reportText(r))
  return 0
}

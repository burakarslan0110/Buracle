import { join } from 'node:path'
import type { Harness } from '../core/events'
import { memIsSlug } from '../core/memory/note'
import { sha256 } from '../engine/fsx'
import * as paths from '../engine/paths'

export function brainDir(): string { return paths.brainDir() }
export function brainProjectsDir(): string { return join(brainDir(), 'projects') }
export function projectDbFile(slug: string): string {
  if (!memIsSlug(slug)) throw new Error(`not a project slug: ${JSON.stringify(slug)}`)
  return join(brainProjectsDir(), `${slug}.db`)
}
export function brainBackupsDir(): string { return join(brainDir(), 'backups') }
export const BACKUP_ID_RE = /^\d{8}-\d{6}(?:-\d{1,3})?$/
export function brainBackupDir(id: string): string {
  if (!BACKUP_ID_RE.test(id)) throw new Error(`not a backup id: ${JSON.stringify(id)}`)
  return join(brainBackupsDir(), id)
}
export function personDbFile(): string { return join(brainDir(), 'person.db') }

export function memStateDir(): string { return paths.memoryStateDir() }
export function spoolDir(): string { return join(memStateDir(), 'spool') }
export function spoolDoneDir(): string { return join(spoolDir(), 'done') }
export function statusDir(): string { return join(memStateDir(), 'status') }
export function statusFile(slug?: string): string {
  if (slug !== undefined && !memIsSlug(slug)) throw new Error(`not a project slug: ${JSON.stringify(slug)}`)
  return join(statusDir(), `${slug ?? '_global'}.json`)
}
export function eventsFile(): string { return join(memStateDir(), 'events.jsonl') }
export function vaultImportFile(): string { return join(memStateDir(), 'vault-import.json') }
export function projectsFile(): string { return join(memStateDir(), 'projects.json') }
export function locksDir(): string { return join(memStateDir(), 'locks') }
export function brainLockFile(db: string): string { return join(locksDir(), `brain-${sha256(db).slice(0, 16)}.lock`) }
export function brainHoldFile(db: string): string { return join(locksDir(), `restore-${sha256(db).slice(0, 16)}.lock`) }
export function cortexChildrenDir(): string { return join(memStateDir(), 'cortex') }
export function cortexChildFile(db: string, pid: number): string { return join(cortexChildrenDir(), `${sha256(db).slice(0, 16)}-${pid}.json`) }
export function sessionRecordsDir(): string { return join(memStateDir(), 'sessions') }
export function sessionRecordFile(h: Harness, sid: string): string { return join(sessionRecordsDir(), `${h}-${sid}.json`) }
export function redactionsFile(): string { return join(memStateDir(), 'redactions.jsonl') }
export function runnerBackoffFile(): string { return join(memStateDir(), 'runner-backoff.json') }

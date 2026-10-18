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
export function brainAbsorbedDir(): string { return join(brainDir(), 'absorbed') }
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
export function upkeepFile(slug?: string): string {
  if (slug !== undefined && !memIsSlug(slug)) throw new Error(`not a project slug: ${JSON.stringify(slug)}`)
  return join(memStateDir(), 'upkeep', `${slug ?? '_person'}.json`)
}
export function distinctFile(slug?: string): string {
  if (slug !== undefined && !memIsSlug(slug)) throw new Error(`not a project slug: ${JSON.stringify(slug)}`)
  return join(memStateDir(), 'distinct', `${slug ?? '_person'}.json`)
}
export function sweepStateFile(): string { return join(memStateDir(), 'sweep.json') }
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
export function distillDir(): string { return join(memStateDir(), 'distill') }
export function profileStateDir(): string { return join(memStateDir(), 'profile') }
export function profileEvidenceDir(): string { return join(profileStateDir(), 'sessions') }
export function profileClaimsFile(): string { return join(profileStateDir(), 'claims.json') }
export function profileDroppedFile(): string { return join(profileStateDir(), 'dropped.json') }
export function scanStateDir(): string { return join(memStateDir(), 'scan') }
export function distillQueueDir(): string { return join(distillDir(), 'queue') }
export function distillLockFile(h: Harness, sid: string): string { return join(locksDir(), `distill-${h}-${sid}.lock`) }
export function distillRunsFile(): string { return join(distillDir(), 'runs.jsonl') }
export function jobsFile(): string { return join(memStateDir(), 'jobs.jsonl') }
export function runnerBackoffFile(): string { return join(memStateDir(), 'runner-backoff.json') }
export function healStateFile(): string { return join(memStateDir(), 'heal.json') }
export function healLockFile(): string { return join(locksDir(), 'heal.lock') }
export function reflectDir(): string { return join(memStateDir(), 'reflect') }
export function reflectRunsFile(): string { return join(reflectDir(), 'runs.jsonl') }
export function reflectUndoDir(): string { return join(reflectDir(), 'undo') }
export function verifyDir(): string { return join(memStateDir(), 'verify') }
export function verifyRunsFile(): string { return join(verifyDir(), 'runs.jsonl') }
export function verifyStateFile(): string { return join(verifyDir(), 'state.json') }
export function verifyUndoDir(): string { return join(verifyDir(), 'undo') }
export function verifyLockFile(slug: string): string {
  if (!memIsSlug(slug)) throw new Error(`not a project slug: ${JSON.stringify(slug)}`)
  return join(locksDir(), `verify-${slug}.lock`)
}
export const VERIFY_RUN_ID_RE = /^vf-\d{8}-\d{6}-[0-9a-f]{4}$/
export function verifyUndoFile(runId: string): string {
  if (!VERIFY_RUN_ID_RE.test(runId)) throw new Error(`not a verify run id: ${JSON.stringify(runId)}`)
  return join(verifyUndoDir(), `${runId}.json`)
}
export const REFLECT_RUN_ID_RE = /^rf-\d{8}-\d{6}-[0-9a-f]{4}$/
export function reflectUndoFile(runId: string): string {
  if (!REFLECT_RUN_ID_RE.test(runId)) throw new Error(`not a reflect run id: ${JSON.stringify(runId)}`)
  return join(reflectUndoDir(), `${runId}.json`)
}

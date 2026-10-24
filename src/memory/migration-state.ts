import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { memIsSlug } from '../core/memory/note'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { legacyAbsorbedDir, legacyPersonDbFile, legacyProjectsDir, migrationFile } from './layout'
import * as paths from '../engine/paths'

/** What Buracle 0.5 stored: a CortexDB file per layer (`person.db`, `projects/<slug>.db`) and the files of folded projects (`absorbed/`). */
export interface LegacyFile {
  /** Relative to the brain folder, with '/' on every platform. */
  path: string
  abs: string
  kind: 'person' | 'project' | 'absorbed'
  slug?: string
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

function dbNames(dir: string): string[] {
  try { return readdirSync(dir).filter(n => n.endsWith('.db')).sort() } catch { return [] }
}

export function discoverLegacy(): LegacyFile[] {
  const out: LegacyFile[] = []
  if (isFile(legacyPersonDbFile())) out.push({ path: 'person.db', abs: legacyPersonDbFile(), kind: 'person' })
  for (const n of dbNames(legacyProjectsDir())) {
    const slug = n.slice(0, -3)
    if (memIsSlug(slug) && isFile(join(legacyProjectsDir(), n))) out.push({ path: `projects/${n}`, abs: join(legacyProjectsDir(), n), kind: 'project', slug })
  }
  for (const n of dbNames(legacyAbsorbedDir())) {
    if (isFile(join(legacyAbsorbedDir(), n))) out.push({ path: `absorbed/${n}`, abs: join(legacyAbsorbedDir(), n), kind: 'absorbed' })
  }
  return out
}

export type MigrationStatus = 'running' | 'complete' | 'failed'

export interface MigrationFileState {
  path: string
  /** `person`, `project:<slug>` or `absorbed` (an archive: it is moved aside, not imported). */
  bucket: string
  count: number
  done: boolean
  /** Rows written into brain.db by the run that finished this file. */
  written?: number
}

export interface MigrationMarker {
  v: 1
  from: '0.5'
  startedAt: string
  finishedAt?: string
  status: MigrationStatus
  /** The folder under brain/backups that holds the verified copies taken before anything changed. */
  backup?: string
  files: MigrationFileState[]
  profile?: { claims: number, written: number, done: boolean }
  /** Legacy files that could not be moved aside (a process still holds them open); they are not migrated again. */
  leftover?: string[]
  error?: string
}

export function readMarker(): MigrationMarker | undefined {
  const r = readJsonSafeSync<MigrationMarker>(migrationFile())
  const m = r.ok ? r.value : undefined
  return m !== undefined && m !== null && typeof m === 'object' && m.v === 1 && Array.isArray(m.files) && typeof m.status === 'string' ? m : undefined
}

export function writeMarker(m: MigrationMarker): void {
  atomicWriteSync(migrationFile(), JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
}

/** Legacy files a migration still has to take in: the ones in the brain folder, minus those a finished run could not move. */
export function pendingLegacy(): LegacyFile[] {
  const found = discoverLegacy()
  if (found.length === 0) return []
  const left = new Set(readMarker()?.leftover ?? [])
  return found.filter(f => !left.has(f.path))
}

/** True while Buracle 0.5 files wait to be folded into brain.db. Cheap enough to ask before every memory call. */
export function legacyPending(): boolean {
  if (!existsSync(paths.brainDir())) return false
  return pendingLegacy().length > 0
}

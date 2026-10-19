import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import {
  changesNotesKey, cleanNotesFile, docNotesKey, emptyNotesFile, inboxWith, isInboxEntry, isReviewNotesFile, openNotes,
  type NotesInboxEntry, type ReviewNotesFile,
} from '../core/plan/notes'
import { atomicWriteSync, readJsonSafeSync, sha256 } from '../engine/fsx'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { liveUiRecord } from '../memory/ui-record'
import { realish, type RepoFacts } from './gitx'
import { withFileLock } from './session-store'

export interface NotesTarget {
  repo: string
  root: string
  key: string
  doc?: { path: string, rel: string }
  branch?: string
  checkout?: string
}

export function repoKey(f: Pick<RepoFacts, 'commonDir' | 'mainRoot'>): string {
  const name = basename(f.mainRoot).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${name === '' ? 'repo' : name}-${sha256(f.commonDir).slice(0, 10)}`
}

export function relIn(top: string, abs: string): string {
  return relative(top, abs).split(sep).join('/')
}

export function docTarget(f: RepoFacts, abs: string): NotesTarget | undefined {
  const path = realish(abs)
  const rel = relIn(f.top, path)
  const key = docNotesKey(rel)
  if (key === undefined) return undefined
  return { repo: repoKey(f), root: f.mainRoot, key, doc: { path, rel } }
}

export function changesTarget(f: RepoFacts, branch: string | undefined, checkout: string): NotesTarget {
  return { repo: repoKey(f), root: f.mainRoot, key: changesNotesKey(branch), ...(branch !== undefined ? { branch } : {}), checkout: realish(checkout) }
}

export function notesPath(t: NotesTarget): string {
  return join(paths.reviewNotesDir(), t.repo, `${t.key}.json`)
}

function fresh(t: NotesTarget): ReviewNotesFile {
  return emptyNotesFile(t.root, { ...(t.doc !== undefined ? { doc: t.doc.rel } : {}), ...(t.branch !== undefined ? { branch: t.branch } : {}) })
}

export function readNotes(t: NotesTarget): ReviewNotesFile {
  const r = readJsonSafeSync<unknown>(notesPath(t))
  if (r.ok && isReviewNotesFile(r.value)) return cleanNotesFile(r.value)
  if (!r.ok && r.code !== 'missing') log('warn', 'review notes: unreadable file, starting empty', { file: notesPath(t), error: r.error })
  return fresh(t)
}

export function updateNotes<R>(t: NotesTarget, fn: (f: ReviewNotesFile) => { file: ReviewNotesFile, result: R }, o: { now: number, byUser: boolean }): R {
  const file = notesPath(t)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  return withFileLock(file, () => {
    const cur = readNotes(t)
    const { file: next, result } = fn(cur)
    if (next !== cur) {
      atomicWriteSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
      recordInbox(t, next, o.now, o.byUser)
    }
    return result
  })
}

export function newNoteId(): string {
  return `n-${randomBytes(4).toString('hex')}`
}

export function docId(abs: string): string {
  return sha256(`doc:${realish(abs)}`).slice(0, 12)
}

export function checkoutId(abs: string): string {
  return sha256(`checkout:${realish(abs)}`).slice(0, 12)
}

export function readInbox(): NotesInboxEntry[] {
  const r = readJsonSafeSync<unknown>(paths.reviewInboxFile())
  const v = r.ok ? r.value : undefined
  const list = v !== null && typeof v === 'object' && Array.isArray((v as { entries?: unknown }).entries) ? (v as { entries: unknown[] }).entries : []
  return list.filter(isInboxEntry)
}

function recordInbox(t: NotesTarget, f: ReviewNotesFile, now: number, byUser: boolean): void {
  const file = paths.reviewInboxFile()
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    withFileLock(file, () => {
      const entry: NotesInboxEntry = {
        at: now, root: t.root, key: `${t.repo}/${t.key}`, open: openNotes(f).length,
        ...(t.doc !== undefined ? { doc: t.doc.path, rel: t.doc.rel } : {}),
        ...(t.checkout !== undefined ? { checkout: t.checkout } : {}),
        ...(t.branch !== undefined ? { branch: t.branch } : {}),
      }
      const entries = inboxWith(readInbox(), entry, byUser)
      atomicWriteSync(file, JSON.stringify({ v: 1, entries }, null, 2) + '\n', { mode: 0o600 })
    })
  } catch (e) {
    log('warn', 'review notes: the inbox was not updated', { error: e })
  }
}

export function reviewPageUrl(query: Readonly<Record<string, string>> = {}): string | undefined {
  const rec = liveUiRecord()
  if (rec === undefined) return undefined
  const q = new URLSearchParams(query).toString()
  return `${rec.url.replace(/\/+$/, '')}/review${q !== '' ? `?${q}` : ''}`
}

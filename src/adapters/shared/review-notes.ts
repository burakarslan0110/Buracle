import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Harness } from '../../core/events'
import { inboxFor, isInboxEntry, notesNoticeText, type NotesInboxEntry, type NoticeSession } from '../../core/plan/notes'
import { atomicWriteSync, readJsonSafeSync, realPath } from '../../engine/fsx'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'

function real(p: string): string {
  try { return realPath(p) } catch { return p }
}

function inbox(): NotesInboxEntry[] {
  const r = readJsonSafeSync<unknown>(paths.reviewInboxFile())
  const v = r.ok ? r.value : undefined
  const list = v !== null && typeof v === 'object' && Array.isArray((v as { entries?: unknown }).entries) ? (v as { entries: unknown[] }).entries : []
  return list.filter(isInboxEntry)
}

export function reviewNotesNotice(h: Harness, sid: string, o: { plan?: string, roots: ReadonlyArray<string | undefined>, now: number }): string | undefined {
  if (!paths.isValidSessionId(sid)) return undefined
  const entries = inbox()
  if (entries.length === 0) return undefined
  const file = join(paths.sessionDir(h, sid), 'review-notes.json')
  const seen = readJsonSafeSync<{ at?: unknown }>(file)
  const since = seen.ok && typeof seen.value?.at === 'number' ? seen.value.at : 0
  const s: NoticeSession = { ...(o.plan !== undefined && o.plan !== '' ? { plan: real(o.plan) } : {}), roots: [...new Set(o.roots.filter((r): r is string => typeof r === 'string' && r !== '').map(real))] }
  const hits = inboxFor(entries, s, since)
  if (hits.length === 0) return undefined
  try {
    mkdirSync(dirname(file), { recursive: true })
    atomicWriteSync(file, JSON.stringify({ at: Math.max(...hits.map(e => e.at)), noticedAt: o.now }) + '\n')
  } catch (e) {
    log('warn', 'review notes: the notice mark was not saved', { error: e })
  }
  return notesNoticeText(hits, s)
}

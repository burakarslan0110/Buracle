import type { Harness } from '../core/events'
import { memNoteHarness, parseNote } from '../core/memory/note'
import { memClip, memOneLine, redact, slugify } from '../core/memory/text'
import { log } from '../engine/log'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { freshHandoff } from './context'
import { resolveProject } from './project'
import { recordRedactions } from './spool'
import { refreshStatus } from './status'
import { listAll, projectRef, recordEvent, saveItem } from './store'

export interface HandoffInput {
  harness: Harness
  sessionId: string
  cwd: string
  project?: string
  branch?: string
  slug: string
  markdown: string
  trigger?: string
  now?: number
}

export interface HandoffRef { id: string, path: string, rel: string, title: string }

const KEEP_MS = 14 * 86_400_000

export async function writeHandoff(input: HandoffInput): Promise<HandoffRef | undefined> {
  if (cortexdbBinary() === undefined) return undefined
  const now = input.now ?? Date.now()
  try {
    const slug = (await resolveProject(input.cwd))?.slug
    if (slug === undefined || slug === '') return undefined
    const red = redact(input.markdown)
    recordRedactions(red.count, red.kinds, 'handoff', now)
    const { fm, body } = parseNote(red.text)
    const title = memClip(memOneLine(typeof fm['title'] === 'string' && fm['title'] !== '' ? fm['title'] : `Handoff: ${slug}`), 200)
    const summary = memClip(memOneLine(typeof fm['description'] === 'string' ? fm['description'] : ''), 300)
    const id = `handoff-${slugify(input.slug).slice(0, 80)}`
    const at = new Date(now).toISOString()
    const ref = projectRef(slug)
    await saveItem(ref, {
      id, kind: 'handoff', layer: 'project', title, summary, body: body.replace(/^# [^\n]*\n+/, '').trim(), tags: ['handoff', ...(input.trigger !== undefined ? [slugify(input.trigger)] : [])],
      sources: typeof fm['plan'] === 'string' ? [fm['plan']] : [], about: [], status: 'active', review: 'ok', importance: 4,
      created: at, updated: at, author: 'buracle', version: 1, history: [{ at, by: memNoteHarness(input.harness), what: 'written before compaction' }],
      harness: memNoteHarness(input.harness), session: input.sessionId, ...(input.branch !== undefined ? { branch: input.branch } : {}),
      expires: new Date(now + KEEP_MS).toISOString(),
    })
    recordEvent({ op: 'write', layer: 'project', project: slug, id, kind: 'handoff', by: memNoteHarness(input.harness) })
    await refreshStatus({ slug, nowMs: now, lastWrite: { by: memNoteHarness(input.harness), type: 'handoff' } })
    return { id, path: id, rel: id, title }
  } catch (e) {
    log('warn', 'memory: handoff not written', { error: e })
    return undefined
  }
}

export async function latestHandoff(opts: { project: string, branch?: string, nowMs?: number, session?: string }): Promise<HandoffRef | undefined> {
  if (cortexdbBinary() === undefined) return undefined
  try {
    const h = freshHandoff(await listAll(projectRef(opts.project)), opts.nowMs ?? Date.now(), opts.branch, opts.session)
    return h ? { id: h.id, path: h.id, rel: h.id, title: h.title } : undefined
  } catch {
    return undefined
  }
}

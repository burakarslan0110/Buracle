import {
  CORE_SECTIONS, coreId, isLive, isMemId, isMemKind, KIND_INFO, similarMemories, WRITABLE_KINDS,
  type MemAuthor, type MemItem, type MemKind, type MemLayer, type MemOrigin,
} from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { coreHumanPart, detectedBlockOf, withDetectedBlock } from '../core/memory/repo'
import { redact } from '../core/memory/text'
import { currentProject, MemoryError, update, write, type MemoryCtx } from './api'
import { listAll, personRef, projectRef, type BrainRef } from './store'

export const EXPORT_FORMAT = 'buracle-memory-export'
export const EXPORT_KINDS: readonly MemKind[] = [...WRITABLE_KINDS, 'core', 'capture']
export const EXPORT_DEFAULT_KINDS: readonly MemKind[] = [...WRITABLE_KINDS, 'core']

export interface ExportHeader { format: typeof EXPORT_FORMAT, v: 1, layer: MemLayer, project?: string, at: string, count: number, kinds: MemKind[] }

export interface ExportLine {
  id: string
  kind: MemKind
  layer: MemLayer
  title: string
  summary: string
  body: string
  tags: string[]
  sources: string[]
  about: string[]
  importance: number
  author: MemAuthor
  review: 'pending' | 'ok'
  created: string
  updated: string
  pinned?: true
  origin?: MemOrigin
  confidence?: number
}

const clean = (s: string): string => redact(s).text

function lineOf(i: MemItem): ExportLine {
  const core = i.kind === 'core'
  const line: ExportLine = {
    id: i.id, kind: i.kind, layer: i.layer, title: clean(i.title),
    summary: core && i.summary.startsWith('Detected:') ? '' : clean(i.summary),
    body: clean(core ? coreHumanPart(i.body) : i.body),
    tags: [...i.tags], sources: i.sources.map(clean), about: [...i.about], importance: i.importance,
    author: i.author, review: i.review, created: i.created, updated: i.updated,
  }
  if (i.pinned === true) line.pinned = true
  if (i.origin !== undefined) line.origin = i.origin
  if (i.confidence !== undefined) line.confidence = i.confidence
  return line
}

export async function exportBrain(ref: BrainRef, opts: { kinds?: readonly string[], nowMs?: number } = {}): Promise<{ header: ExportHeader, lines: ExportLine[], text: string }> {
  const kinds = [...new Set(opts.kinds !== undefined && opts.kinds.length > 0 ? opts.kinds : EXPORT_DEFAULT_KINDS)]
  for (const k of kinds) if (!isMemKind(k) || !EXPORT_KINDS.includes(k)) throw new MemoryError('invalid_input', `an export takes ${EXPORT_KINDS.join(', ')}; ${k} is not one of them (the generated kinds stay in the brain they were learned in)`)
  const now = opts.nowMs ?? Date.now()
  const items = (await listAll(ref)).filter(i => isLive(i, now) && (kinds as string[]).includes(i.kind))
    .sort((a, b) => (a.created || a.updated).localeCompare(b.created || b.updated) || a.id.localeCompare(b.id))
  const lines = items.map(lineOf).filter(l => !(l.kind === 'core' && l.body === '' && l.summary === ''))
  const header: ExportHeader = {
    format: EXPORT_FORMAT, v: 1, layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}),
    at: new Date(now).toISOString(), count: lines.length, kinds: kinds as MemKind[],
  }
  return { header, lines, text: [header, ...lines].map(x => JSON.stringify(x)).join('\n') + '\n' }
}

export interface ImportResult {
  dryRun: boolean
  from: { layer: MemLayer, project?: string, at: string }
  imported: Array<{ id: string, layer: MemLayer, kind: MemKind, from: string }>
  skipped: Array<{ from: string, reason: string }>
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function parseLine(raw: string): ExportLine | undefined {
  let v: unknown
  try { v = JSON.parse(raw) } catch { return undefined }
  if (v === null || typeof v !== 'object') return undefined
  const r = v as Record<string, unknown>
  if (!isMemId(r['id']) || !isMemKind(r['kind']) || typeof r['title'] !== 'string' || r['title'].trim() === '') return undefined
  const author = r['author'] === 'user' || r['author'] === 'buracle' ? r['author'] : 'agent'
  const created = typeof r['created'] === 'string' && Number.isFinite(Date.parse(r['created'])) ? r['created'] : ''
  const line: ExportLine = {
    id: r['id'], kind: r['kind'], layer: r['layer'] === 'person' ? 'person' : 'project', title: r['title'],
    summary: typeof r['summary'] === 'string' ? r['summary'] : '', body: typeof r['body'] === 'string' ? r['body'] : '',
    tags: strings(r['tags']), sources: strings(r['sources']), about: strings(r['about']),
    importance: typeof r['importance'] === 'number' ? r['importance'] : 3, author, review: 'pending', created, updated: created,
  }
  if (r['pinned'] === true) line.pinned = true
  if (r['origin'] === 'explicit' || r['origin'] === 'inferred') line.origin = r['origin']
  if (typeof r['confidence'] === 'number' && Number.isFinite(r['confidence']) && r['confidence'] >= 0 && r['confidence'] <= 1) line.confidence = r['confidence']
  return line
}

function parseHeader(raw: string | undefined): ExportHeader {
  let v: unknown
  try { v = JSON.parse(raw ?? '') } catch { v = undefined }
  const h = v as Partial<ExportHeader> | undefined
  if (h === undefined || h === null || h.format !== EXPORT_FORMAT || h.v !== 1 || (h.layer !== 'project' && h.layer !== 'person') || (h.project !== undefined && !memIsSlug(h.project))) {
    throw new MemoryError('invalid_input', 'this is not a Buracle memory export: its first line must be the header `buracle mem export` writes')
  }
  return h as ExportHeader
}

export async function importMemories(ctx: MemoryCtx, text: string, opts: { dryRun?: boolean, nowMs?: number } = {}): Promise<ImportResult> {
  const rows = text.split('\n').filter(l => l.trim() !== '')
  const header = parseHeader(rows[0])
  const dryRun = opts.dryRun === true
  const now = opts.nowMs ?? Date.now()
  const origin = header.project ?? 'person'
  const result: ImportResult = { dryRun, from: { layer: header.layer, ...(header.project !== undefined ? { project: header.project } : {}), at: header.at }, imported: [], skipped: [] }
  const slug = await currentProject(ctx)
  const loaded = new Map<MemLayer, MemItem[]>()
  const brain = async (layer: MemLayer): Promise<MemItem[]> => {
    const have = loaded.get(layer)
    if (have !== undefined) return have
    const items = await listAll(layer === 'person' ? personRef() : projectRef(slug as string))
    loaded.set(layer, items)
    return items
  }
  for (const [n, raw] of rows.slice(1).entries()) {
    const line = parseLine(raw)
    if (line === undefined) { result.skipped.push({ from: `line ${n + 2}`, reason: 'not a memory line' }); continue }
    const from = `${origin}/${line.id}`
    const skip = (reason: string) => { result.skipped.push({ from, reason }) }
    if (!EXPORT_KINDS.includes(line.kind)) { skip(`${line.kind} memories are generated where they were learned and are not imported`); continue }
    if (!KIND_INFO[line.kind].layers.includes(line.layer)) { skip(`a ${line.kind} memory lives in the ${KIND_INFO[line.kind].layers.join(' or ')} layer`); continue }
    if (line.layer === 'project' && slug === undefined) { skip('there is no project here: run the import in the project\'s folder or pass --project'); continue }
    const items = await brain(line.layer)
    const marker = `export:${from}`
    if (items.some(i => i.importedFrom === marker && isLive(i, now))) { skip('imported before'); continue }
    if (line.kind === 'core') {
      const section = line.id.replace(/^core-/, '')
      const human = coreHumanPart(line.body)
      if (!CORE_SECTIONS.includes(section) || line.id !== coreId(section)) { skip('not one of the six core pages'); continue }
      if (human === '') { skip('the core page holds no text of its own'); continue }
      const cur = items.find(i => i.id === line.id)
      if (cur !== undefined && coreHumanPart(cur.body) !== '') { skip('this project\'s core page has text already'); continue }
      if (!dryRun) {
        if (cur !== undefined) {
          const takeSummary = line.summary !== '' && (cur.summary === '' || cur.summary.startsWith('Detected:'))
          await update(ctx, { id: cur.id, patch: { body: withDetectedBlock(human, detectedBlockOf(cur.body)), ...(takeSummary ? { summary: line.summary } : {}) }, reason: `imported from ${from}` })
        } else {
          await write(ctx, { kind: 'core', title: line.title, summary: line.summary, body: human, layer: 'project' }, { internal: true, id: line.id, author: line.author, importedFrom: marker })
        }
        loaded.delete('project')
      }
      result.imported.push({ id: line.id, layer: 'project', kind: 'core', from })
      continue
    }
    if (dryRun) {
      const twin = similarMemories({ title: line.title, summary: line.summary, kind: line.kind }, items, now, 0.6).find(s => s.item.kind === line.kind || s.score >= 0.9)
      if (twin !== undefined) skip(`a live memory already says this: ${twin.item.id}`)
      else result.imported.push({ id: line.id, layer: line.layer, kind: line.kind, from })
      continue
    }
    const r = await write(ctx, {
      kind: line.kind, title: line.title, summary: line.summary, body: line.body, layer: line.layer,
      sources: line.sources, tags: line.tags, about: line.about, importance: line.importance,
      ...(line.pinned === true ? { pin: true } : {}),
      ...(line.origin !== undefined ? { origin: line.origin } : {}), ...(line.confidence !== undefined ? { confidence: line.confidence } : {}),
    }, { ...(line.kind === 'capture' ? { internal: true } : {}), author: line.author, importedFrom: marker, ...(line.created !== '' ? { created: line.created } : {}) })
    if (r.action === 'duplicate_suspected') { skip(`a live memory already says this: ${r.id}`); continue }
    loaded.delete(line.layer)
    result.imported.push({ id: r.id, layer: r.layer, kind: line.kind, from })
  }
  return result
}

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { HARNESSES } from '../../core/events'
import { dropNote, editNote, openNotes, parseNoteInput, withNote, type ReviewNotesFile, REVIEW_DOC_DIRS } from '../../core/plan/notes'
import * as paths from '../../engine/paths'
import { tilde } from '../../engine/update/output'
import { listWorktrees, realish, repoFacts, type RepoFacts } from '../../workflow/gitx'
import { notificationsFile } from '../../workflow/notify'
import { analyzePlan } from '../../workflow/plan-file'
import { changesTarget, checkoutId, docId, docTarget, newNoteId, readNotes, repoKey, updateNotes, type NotesTarget } from '../../workflow/review-notes'
import { diagramSvgs } from '../../workflow/diagram'
import { metaForPlan } from '../../workflow/worktree'
import { readProjectsCache } from '../project'
import { UiApiError } from './api'

const DOCS_PER_REPO = 80
const DOC_MAX_BYTES = 1024 * 1024
const SESSION_FRESH_MS = 7 * 24 * 60 * 60 * 1000
const ASK_FRESH_MS = 2 * 24 * 60 * 60 * 1000
const LIST_CACHE_MS = 4000
const DIAGRAMS_PER_DOC = 30

export interface ReviewSessionMark { harness: string, session: string, status: string, phase: string, paused: boolean, reason?: string, since?: string }

export interface ReviewDoc {
  id: string
  path: string
  rel: string
  dir: string
  title: string
  type?: string
  status?: string
  approved?: boolean
  modified: string
  open: number
  done: number
  changes?: string
  session?: ReviewSessionMark
  asked?: string
}

export interface ReviewCheckout { id: string, path: string, shown: string, branch?: string, main: boolean, open: number }

export interface ReviewRepo { key: string, name: string, slug?: string, root: string, docs: ReviewDoc[], checkouts: ReviewCheckout[] }

interface Repo { facts: RepoFacts, slug?: string, name: string, extra: Set<string> }

interface Listing { at: number, repos: ReviewRepo[], docs: Map<string, { doc: ReviewDoc, facts: RepoFacts }>, checkouts: Map<string, { checkout: ReviewCheckout, facts: RepoFacts }> }

let cached: Listing | undefined
let building: Promise<Listing> | undefined
const FACTS_TTL_MS = 60_000
const factsCache = new Map<string, { at: number, facts: RepoFacts | undefined }>()
const infoCache = new Map<string, { sig: string, title?: string, type?: string, status?: string, approved?: boolean }>()

async function factsOf(dir: string, nowMs: number): Promise<RepoFacts | undefined> {
  const hit = factsCache.get(dir)
  if (hit !== undefined && nowMs >= hit.at && nowMs - hit.at < FACTS_TTL_MS) return hit.facts
  const facts = await repoFacts(dir)
  factsCache.set(dir, { at: nowMs, facts })
  return facts
}

function docInfo(path: string, s: { mtimeMs: number, size: number }): { title?: string, type?: string, status?: string, approved?: boolean } {
  const sig = `${s.mtimeMs}:${s.size}`
  const hit = infoCache.get(path)
  if (hit?.sig === sig) return hit
  const info = analyzePlan(s.size <= DOC_MAX_BYTES ? readFileSync(path, 'utf8') : '')
  const out = { sig, ...(info.title !== undefined ? { title: info.title } : {}), ...(info.type !== undefined ? { type: info.type } : {}), ...(info.status !== undefined ? { status: info.status } : {}), ...(info.approved !== undefined ? { approved: info.approved } : {}) }
  infoCache.set(path, out)
  return out
}

function boundPlans(nowMs: number): Map<string, ReviewSessionMark> {
  const out = new Map<string, ReviewSessionMark & { at: number }>()
  for (const h of HARNESSES) {
    let dirs: string[] = []
    try { dirs = readdirSync(paths.sessionsDir(h)) } catch { continue }
    for (const sid of dirs) {
      const file = join(paths.sessionsDir(h), sid, 'state.json')
      let at: number
      try { at = statSync(file).mtimeMs } catch { continue }
      if (nowMs - at > SESSION_FRESH_MS) continue
      let st: { plan?: { path?: unknown, status?: unknown, phase?: unknown }, interaction?: { state?: unknown, reason?: unknown, since?: unknown } }
      try { st = JSON.parse(readFileSync(file, 'utf8')) as typeof st } catch { continue }
      const p = st.plan
      if (p === undefined || typeof p.path !== 'string') continue
      const key = realish(p.path)
      const prev = out.get(key)
      if (prev !== undefined && prev.at >= at) continue
      const paused = st.interaction?.state === 'paused'
      out.set(key, {
        at, harness: h, session: sid, status: typeof p.status === 'string' ? p.status : '', phase: typeof p.phase === 'string' ? p.phase : '', paused,
        ...(paused && typeof st.interaction?.reason === 'string' ? { reason: st.interaction.reason.slice(0, 200) } : {}),
        ...(paused && typeof st.interaction?.since === 'number' ? { since: new Date(st.interaction.since).toISOString() } : {}),
      })
    }
  }
  return new Map([...out].map(([k, { at: _at, ...v }]) => [k, v]))
}

function approvalAsks(nowMs: number): Map<string, string> {
  const out = new Map<string, string>()
  let text = ''
  try { text = readFileSync(notificationsFile(), 'utf8') } catch { return out }
  for (const line of text.split('\n').slice(-400)) {
    if (line.trim() === '') continue
    try {
      const r = JSON.parse(line) as { type?: unknown, plan?: unknown, ts?: unknown }
      if ((r.type !== 'plan_approval' && r.type !== 'prd_approval') || typeof r.plan !== 'string' || typeof r.ts !== 'string') continue
      if (nowMs - Date.parse(r.ts) > ASK_FRESH_MS) continue
      out.set(realish(r.plan), r.ts)
    } catch {  }
  }
  return out
}

function docFiles(top: string): string[] {
  const out: Array<{ path: string, at: number }> = []
  for (const dir of REVIEW_DOC_DIRS) {
    const base = join(top, 'docs', dir)
    let names: string[] = []
    try { names = readdirSync(base) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.md') || n.startsWith('.')) continue
      const p = join(base, n)
      try {
        const s = statSync(p)
        if (s.isFile()) out.push({ path: p, at: s.mtimeMs })
      } catch {  }
    }
  }
  return out.sort((a, b) => b.at - a.at).map(x => x.path)
}

function counts(t: NotesTarget): { open: number, done: number } {
  const f = readNotes(t)
  const open = openNotes(f).length
  return { open, done: f.notes.length - open }
}

function docEntry(path: string, facts: RepoFacts, marks: Map<string, ReviewSessionMark>, asks: Map<string, string>): { doc: ReviewDoc, facts: RepoFacts } | undefined {
  const t = docTarget(facts, path)
  if (t === undefined || t.doc === undefined) return undefined
  let modified = ''
  let info: ReturnType<typeof docInfo>
  try {
    const s = lstatSync(path)
    if (!s.isFile()) return undefined
    modified = new Date(s.mtimeMs).toISOString()
    info = docInfo(path, s)
  } catch { return undefined }
  const rel = t.doc.rel
  const name = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '')
  const meta = metaForPlan(facts.commonDir, t.doc.path)
  const changes = meta !== undefined && meta.lane !== true && existsSync(meta.path) ? checkoutId(meta.path) : checkoutId(facts.top)
  const mark = marks.get(t.doc.path)
  const ask = asks.get(t.doc.path)
  const doc: ReviewDoc = {
    id: docId(t.doc.path), path: t.doc.path, rel, dir: rel.split('/')[1] ?? '', title: info.title ?? name, modified, ...counts(t), changes,
    ...(info.type !== undefined ? { type: info.type } : {}),
    ...(info.status !== undefined ? { status: info.status } : {}),
    ...(info.approved !== undefined ? { approved: info.approved } : {}),
    ...(mark !== undefined ? { session: mark } : {}),
    ...(ask !== undefined ? { asked: ask } : {}),
  }
  return { doc, facts }
}

async function build(nowMs: number): Promise<Listing> {
  const repos = new Map<string, Repo>()
  const add = async (dir: string, slug?: string, name?: string): Promise<Repo | undefined> => {
    if (!existsSync(dir)) return undefined
    const facts = await factsOf(dir, nowMs)
    if (facts === undefined) return undefined
    const have = repos.get(facts.commonDir)
    if (have !== undefined) {
      if (have.slug === undefined && slug !== undefined) have.slug = slug
      return have
    }
    const r: Repo = { facts: { ...facts, top: facts.mainRoot }, name: name ?? basename(facts.mainRoot), extra: new Set(), ...(slug !== undefined ? { slug } : {}) }
    repos.set(facts.commonDir, r)
    return r
  }
  for (const [slug, rec] of Object.entries(readProjectsCache().projects)) {
    if (rec.scope === 'adhoc') continue
    const root = rec.roots.find(r => existsSync(r))
    if (root !== undefined) await add(root, slug, rec.ownerRepo !== undefined && rec.ownerRepo !== '' ? rec.ownerRepo : undefined)
  }
  const marks = boundPlans(nowMs)
  const asks = approvalAsks(nowMs)
  const pinned = new Map<string, RepoFacts>()
  for (const p of new Set([...marks.keys(), ...asks.keys()])) {
    if (!existsSync(p)) continue
    const facts = await factsOf(dirname(p), nowMs)
    if (facts === undefined) continue
    const r = await add(facts.mainRoot)
    if (r === undefined) continue
    r.extra.add(p)
    pinned.set(p, facts)
  }
  const docs = new Map<string, { doc: ReviewDoc, facts: RepoFacts }>()
  const checkouts = new Map<string, { checkout: ReviewCheckout, facts: RepoFacts }>()
  const out: ReviewRepo[] = []
  for (const r of repos.values()) {
    const list: ReviewDoc[] = []
    const seen = new Set<string>()
    for (const p of [...r.extra, ...docFiles(r.facts.mainRoot)]) {
      const real = realish(p)
      if (seen.has(real)) continue
      seen.add(real)
      if (list.length >= DOCS_PER_REPO && !r.extra.has(p)) break
      const e = docEntry(real, pinned.get(p) ?? r.facts, marks, asks)
      if (e === undefined) continue
      list.push(e.doc)
      docs.set(e.doc.id, e)
    }
    const trees: ReviewCheckout[] = []
    for (const w of await listWorktrees(r.facts.mainRoot)) {
      if (w.bare || w.prunable || !existsSync(w.path)) continue
      const { branch: _mainBranch, ...shared } = r.facts
      const facts: RepoFacts = { ...shared, top: w.path, linked: realish(w.path) !== realish(r.facts.mainRoot), ...(w.branch !== undefined ? { branch: w.branch } : {}) }
      const t = changesTarget(facts, w.branch, w.path)
      const c: ReviewCheckout = { id: checkoutId(w.path), path: w.path, shown: tilde(w.path), main: !facts.linked, open: counts(t).open, ...(w.branch !== undefined ? { branch: w.branch } : {}) }
      trees.push(c)
      checkouts.set(c.id, { checkout: c, facts })
    }
    out.push({ key: repoKey(r.facts), name: r.name, root: r.facts.mainRoot, docs: list, checkouts: trees, ...(r.slug !== undefined ? { slug: r.slug } : {}) })
  }
  const latest = (x: ReviewRepo) => x.docs.reduce((m, d) => (d.modified > m ? d.modified : m), '')
  out.sort((a, b) => Number(b.docs.some(d => d.session !== undefined || d.asked !== undefined)) - Number(a.docs.some(d => d.session !== undefined || d.asked !== undefined)) || latest(b).localeCompare(latest(a)) || a.name.localeCompare(b.name))
  return { at: nowMs, repos: out, docs, checkouts }
}

export async function reviewListing(nowMs: number, fresh = false): Promise<Listing> {
  if (!fresh && cached !== undefined && nowMs - cached.at < LIST_CACHE_MS && nowMs >= cached.at) return cached
  if (building !== undefined) return building
  building = build(nowMs).then(l => { cached = l; return l }).finally(() => { building = undefined })
  return building
}

export function forgetReviewListing(): void {
  cached = undefined
}

export async function reviewDocs(nowMs: number): Promise<Record<string, unknown>> {
  const l = await reviewListing(nowMs, true)
  return { now: new Date(nowMs).toISOString(), repos: l.repos }
}

function idOf(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || !/^[0-9a-f]{12}$/.test(raw)) throw new UiApiError(400, 'bad_id', `${what} must be the 12-character id the review page lists`)
  return raw
}

async function findDoc(raw: unknown, nowMs: number): Promise<{ doc: ReviewDoc, facts: RepoFacts }> {
  const id = idOf(raw, 'doc')
  const hit = (await reviewListing(nowMs)).docs.get(id) ?? (await reviewListing(nowMs, true)).docs.get(id)
  if (hit === undefined) throw new UiApiError(404, 'unknown_doc', 'there is no such plan, build contract or PRD on the review page')
  return hit
}

export async function findCheckout(raw: unknown, nowMs: number): Promise<{ checkout: ReviewCheckout, facts: RepoFacts }> {
  const id = idOf(raw, 'checkout')
  const hit = (await reviewListing(nowMs)).checkouts.get(id) ?? (await reviewListing(nowMs, true)).checkouts.get(id)
  if (hit === undefined) throw new UiApiError(404, 'unknown_checkout', 'there is no such checkout on the review page')
  return hit
}

function notesOut(f: ReviewNotesFile): Record<string, unknown> {
  return { notes: [...f.notes].sort((a, b) => a.at.localeCompare(b.at)), open: openNotes(f).length }
}

const FENCE_RE = /^\s*(```+|~~~+)\s*([\w+-]*)/

// The bodies of the ```mermaid blocks, found the way the page's renderDoc (review-doc.js) walks the
// document, so each body is the key the page looks its drawing up by.
export function mermaidBlocks(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  if ((lines[0] ?? '').trim() === '---') {
    for (let j = 1; j < Math.min(lines.length, 80); j++) if ((lines[j] ?? '').trim() === '---') { i = j + 1; break }
  }
  const out = new Set<string>()
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !(lines[i] ?? '').includes('-->')) i++
      i++
      continue
    }
    const fence = FENCE_RE.exec(line)
    if (fence === null) { i++; continue }
    const mark = fence[1] as string
    const body: string[] = []
    i++
    while (i < lines.length && !(lines[i] ?? '').trim().startsWith(mark)) body.push(lines[i++] as string)
    i++
    if (fence[2] === 'mermaid') out.add(body.join('\n'))
  }
  return [...out]
}

type DiagramEntry = { light: string, dark: string } | { error: string }

async function docDiagrams(text: string): Promise<Record<string, DiagramEntry>> {
  const blocks = mermaidBlocks(text)
  const drawn = await diagramSvgs(blocks.slice(0, DIAGRAMS_PER_DOC))
  const out: Record<string, DiagramEntry> = {}
  blocks.forEach((body, n) => {
    const d = drawn[n]
    out[body] = d === undefined
      ? { error: `not drawn: a document shows at most ${DIAGRAMS_PER_DOC} diagrams` }
      : d.ok ? { light: d.light, dark: d.dark } : { error: d.error }
  })
  return out
}

export async function reviewDoc(id: string | null, nowMs: number): Promise<Record<string, unknown>> {
  const { doc, facts } = await findDoc(id, nowMs)
  let text: string
  try {
    const s = lstatSync(doc.path)
    if (!s.isFile()) throw new UiApiError(404, 'unknown_doc', 'the file is gone')
    if (s.size > DOC_MAX_BYTES) throw new UiApiError(413, 'too_large', `the file is larger than ${DOC_MAX_BYTES} bytes`)
    text = readFileSync(doc.path, 'utf8')
  } catch (e) {
    if (e instanceof UiApiError) throw e
    throw new UiApiError(404, 'unknown_doc', 'the file is gone')
  }
  const t = docTarget(facts, doc.path) as NotesTarget
  return { ...doc, root: facts.mainRoot, text, diagrams: await docDiagrams(text), ...notesOut(readNotes(t)) }
}

async function targetOf(body: Record<string, unknown>, nowMs: number): Promise<NotesTarget> {
  if (body['doc'] !== undefined) {
    const { doc, facts } = await findDoc(body['doc'], nowMs)
    const t = docTarget(facts, doc.path)
    if (t === undefined) throw new UiApiError(400, 'bad_doc', 'this file takes no notes')
    return t
  }
  if (body['checkout'] !== undefined) {
    const { checkout, facts } = await findCheckout(body['checkout'], nowMs)
    return changesTarget(facts, checkout.branch, checkout.path)
  }
  throw new UiApiError(400, 'bad_target', 'name the doc or the checkout the note belongs to')
}

export function checkoutNotes(checkout: ReviewCheckout, facts: RepoFacts): Record<string, unknown> {
  return notesOut(readNotes(changesTarget(facts, checkout.branch, checkout.path)))
}

export async function addReviewNote(body: Record<string, unknown>, nowMs: number): Promise<Record<string, unknown>> {
  const t = await targetOf(body, nowMs)
  const input = parseNoteInput(body)
  if (typeof input === 'string') throw new UiApiError(400, 'bad_note', input)
  if (t.doc !== undefined && input.kind !== 'plan') throw new UiApiError(400, 'bad_note', 'a document takes plan notes; code notes belong to a checkout')
  if (t.doc === undefined && input.kind !== 'code') throw new UiApiError(400, 'bad_note', 'a checkout takes code notes')
  const id = newNoteId()
  const at = new Date(nowMs).toISOString()
  const f = updateNotes(t, cur => {
    const next = withNote(cur, input, id, at)
    if (typeof next === 'string') throw new UiApiError(409, 'too_many_notes', next)
    return { file: next, result: next }
  }, { now: nowMs, byUser: true })
  forgetReviewListing()
  return { ok: true, id, ...notesOut(f) }
}

export async function editReviewNote(body: Record<string, unknown>, nowMs: number): Promise<Record<string, unknown>> {
  const t = await targetOf(body, nowMs)
  const id = typeof body['id'] === 'string' ? body['id'] : ''
  const text = typeof body['text'] === 'string' ? body['text'] : ''
  const f = updateNotes(t, cur => {
    const r = editNote(cur, id, text, new Date(nowMs).toISOString())
    if (r.problem !== undefined) throw new UiApiError(400, 'bad_note', r.problem)
    if (!r.found) throw new UiApiError(404, 'unknown_note', 'there is no open note with this id; the agent may have applied it')
    return { file: r.file, result: r.file }
  }, { now: nowMs, byUser: true })
  return { ok: true, id, ...notesOut(f) }
}

export async function deleteReviewNote(body: Record<string, unknown>, nowMs: number): Promise<Record<string, unknown>> {
  const t = await targetOf(body, nowMs)
  const id = typeof body['id'] === 'string' ? body['id'] : ''
  const f = updateNotes(t, cur => {
    const r = dropNote(cur, id)
    if (!r.found) throw new UiApiError(404, 'unknown_note', 'there is no note with this id')
    return { file: r.file, result: r.file }
  }, { now: nowMs, byUser: true })
  forgetReviewListing()
  return { ok: true, id, deleted: true, ...notesOut(f) }
}

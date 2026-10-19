import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isLive, type MemItem } from '../core/memory/brain'
import type { Harness } from '../core/events'
import { memIsSlug } from '../core/memory/note'
import {
  profileAggregate, profileCategory, profileFacts, profileSessionEvidence, profileSignalsFromDigest,
  type ProfileClaim, type ProfileEvidence, type ProfileFact,
} from '../core/memory/profile'
import type { SpoolDigest } from '../core/memory/spool'
import { normalizeForSearch, slugify } from '../core/memory/text'
import { atomicWriteSync, readJsonSafeSync, sha256 } from '../engine/fsx'
import { log } from '../engine/log'
import { profileClaimsFile, profileDroppedFile, profileEvidenceDir } from './layout'
import { deleteItem, listAll, personRef, projectRef, recordEvent, saveItem, withBrainLock, type BrainRef } from './store'

interface EvidenceFile { v: 1, source: string, harness: string, project?: string, endedMs: number, evidence: ProfileEvidence[] }

const MAX_SESSION_FILES = 1500
const MAX_AGE_MS = 400 * 86_400_000

export function recordSessionEvidence(h: Harness, sid: string, input: { digest: SpoolDigest, project: string, nowMs: number }): number {
  const ts = input.digest.endedMs ?? input.nowMs
  const signals = [
    ...input.digest.signals,
    ...profileSignalsFromDigest(input.digest, { harness: h }).map(signal => ({ ts, signal })),
  ].map(x => ({ ts: x.ts, signal: x.signal }))
  const source = `${h}-${sid}`
  const evidence = profileSessionEvidence(signals, { source, harness: h, project: input.project })
  const file = join(profileEvidenceDir(), `${source}.json`)
  if (evidence.length === 0) {
    try { unlinkSync(file) } catch {  }
    return 0
  }
  const rec: EvidenceFile = { v: 1, source, harness: h, project: input.project, endedMs: ts, evidence: evidence.slice(0, 200) }
  mkdirSync(profileEvidenceDir(), { recursive: true })
  atomicWriteSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 })
  return evidence.length
}

export function recordInferenceEvidence(h: Harness, sid: string, input: { evidence: readonly ProfileEvidence[], project?: string, nowMs: number }): number {
  if (input.evidence.length === 0) return 0
  const source = `${h}-${sid}`
  const file = join(profileEvidenceDir(), `${source}.infer.json`)
  const prev = readJsonSafeSync<EvidenceFile>(file)
  const kept = prev.ok && prev.value !== null && prev.value.v === 1 && Array.isArray(prev.value.evidence) ? prev.value.evidence : []
  const fresh = new Set(input.evidence.map(e => `${e.key}\0${e.polarity}`))
  const evidence = [...kept.filter(e => !fresh.has(`${e.key}\0${e.polarity}`)), ...input.evidence].slice(-50)
  const rec: EvidenceFile = { v: 1, source, harness: h, ...(input.project !== undefined ? { project: input.project } : {}), endedMs: input.nowMs, evidence }
  mkdirSync(profileEvidenceDir(), { recursive: true })
  atomicWriteSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 })
  return input.evidence.length
}

export function profileKnownClaims(): Array<{ key: string, text: string, hypothesis: boolean }> {
  const r = readJsonSafeSync<{ claims?: unknown }>(profileClaimsFile())
  const claims = r.ok && r.value !== null && Array.isArray(r.value.claims) ? r.value.claims : []
  return claims
    .filter((c): c is ProfileClaim => c !== null && typeof c === 'object' && typeof (c as ProfileClaim).key === 'string' && typeof (c as ProfileClaim).text === 'string')
    .filter(c => c.text !== c.key && !c.key.startsWith('feedback.') && !c.key.startsWith('usage.') && !c.key.startsWith('env.') && !c.key.startsWith('style.'))
    .map(c => ({ key: c.key, text: c.text, hypothesis: c.hypothesis === true }))
}

function loadEvidence(nowMs: number): { evidence: ProfileEvidence[], sessions: number } {
  let names: string[] = []
  try { names = readdirSync(profileEvidenceDir()).filter(n => n.endsWith('.json')) } catch { return { evidence: [], sessions: 0 } }
  const files = names.map(n => {
    const p = join(profileEvidenceDir(), n)
    let mtime = 0
    try { mtime = statSync(p).mtimeMs } catch {  }
    return { p, mtime }
  }).sort((a, b) => b.mtime - a.mtime)
  const evidence: ProfileEvidence[] = []
  const sources = new Set<string>()
  for (const [i, f] of files.entries()) {
    if (i >= MAX_SESSION_FILES || nowMs - f.mtime > MAX_AGE_MS) {
      try { unlinkSync(f.p) } catch {  }
      continue
    }
    const r = readJsonSafeSync<EvidenceFile>(f.p)
    if (!r.ok || r.value === null || typeof r.value !== 'object' || r.value.v !== 1 || !Array.isArray(r.value.evidence)) continue
    sources.add(typeof r.value.source === 'string' ? r.value.source : f.p)
    for (const e of r.value.evidence) {
      if (e === null || typeof e !== 'object' || typeof e.key !== 'string' || typeof e.ts !== 'number') continue
      evidence.push(e)
    }
  }
  return { evidence, sessions: sources.size }
}

const NEGATIVE = /\b(?:never|don'?t|do not|avoid|no)\b/i

function preferenceEvidence(items: readonly MemItem[], nowMs: number): ProfileEvidence[] {
  const out: ProfileEvidence[] = []
  for (const i of items) {
    if (i.kind !== 'preference' || !isLive(i, nowMs)) continue
    const polarity: 1 | -1 = NEGATIVE.test(i.title) ? -1 : 1
    const ts = Date.parse(i.updated || i.created)
    out.push({
      kind: 'statement', key: `note:${i.id}`.slice(0, 120), polarity, weight: 3,
      category: profileCategory(i.title, polarity), text: i.title, events: 1, ts: Number.isFinite(ts) ? ts : nowMs, source: `note:${i.id}`,
    })
  }
  return out
}

interface DroppedFile { v: 1, dropped: Record<string, { at: number, text: string }> }

function loadDropped(): DroppedFile['dropped'] {
  const r = readJsonSafeSync<DroppedFile>(profileDroppedFile())
  const d = r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 1 ? r.value.dropped : undefined
  return d !== null && typeof d === 'object' ? d : {}
}

function withoutDropped(evidence: readonly ProfileEvidence[], dropped: DroppedFile['dropped']): ProfileEvidence[] {
  return evidence.filter(e => { const d = dropped[e.key]; return d === undefined || typeof d.at !== 'number' || e.ts > d.at })
}

async function currentClaims(now: number, person: readonly MemItem[]): Promise<{ claims: ProfileClaim[], sessions: number }> {
  const stored = loadEvidence(now)
  return { claims: profileAggregate(withoutDropped([...stored.evidence, ...preferenceEvidence(person, now)], loadDropped()), now), sessions: stored.sessions }
}

function factId(prefix: 'profile' | 'convention', key: string): string {
  return `${prefix}-${slugify(key.replace(/^(said|note|group):/, '')).slice(0, 48).replace(/-+$/, '')}-${sha256(key).slice(0, 6)}`
}

function factImportance(f: ProfileFact): number {
  return f.hypothesis ? 2 : f.explicit ? 5 : f.confidence === 'high' ? 4 : 3
}

async function syncFacts(ref: BrainRef, kind: 'profile' | 'convention', wanted: ReadonlyMap<string, ProfileFact>, nowMs: number): Promise<number> {
  return withBrainLock(ref, async () => {
    const have = (await listAll(ref)).filter(i => i.kind === kind)
    const at = new Date(nowMs).toISOString()
    let n = 0
    for (const [id, f] of wanted) {
      const cur = have.find(i => i.id === id)
      const summary = `${f.category} · ${f.hypothesis ? 'hypothesis' : f.confidence}${f.explicit ? ' · stated by the user' : f.inferred === true ? ' · inferred from sessions' : ''}`
      const tags = [f.category, ...(f.hypothesis ? ['hypothesis'] : []), ...(f.explicit ? ['stated'] : []), ...(f.inferred === true ? ['inferred'] : []), `rank-${f.rank}`]
      const seen = f.events > 0 ? `${f.inferred === true ? 'Inferred' : 'Seen'} ${f.events} time${f.events === 1 ? '' : 's'} in ${f.sessions} session${f.sessions === 1 ? '' : 's'}; last ${new Date(f.lastSeen).toISOString().slice(0, 10)}.` : ''
      const body = f.why !== undefined ? `${seen}\n\nLatest sign: ${f.why}` : seen
      if (cur !== undefined && cur.title === f.text && cur.summary === summary && cur.body === body && cur.tags.join(',') === tags.join(',')) continue
      await saveItem(ref, {
        id, kind, layer: ref.layer, title: f.text, summary, body, tags, sources: [], about: [], status: 'active', review: 'ok',
        importance: factImportance(f), created: cur?.created ?? at, updated: at, author: 'buracle', version: (cur?.version ?? 0) + 1,
        history: [...(cur?.history ?? []), { at, by: 'buracle', what: cur ? 'updated from sessions' : 'learned from sessions' }].slice(-8), harness: 'buracle',
      })
      n++
    }
    for (const old of have) if (!wanted.has(old.id)) { await deleteItem(ref, old.id); n++ }
    if (n > 0) recordEvent({ op: 'update', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), kind, n, by: 'buracle' })
    return n
  })
}

export interface ProfileUpdateResult {
  changed: number
  claims: number
  sessions: number
  conventions: string[]
}

export async function updateProfile(opts: { nowMs?: number, projects?: string[] } = {}): Promise<ProfileUpdateResult> {
  const now = opts.nowMs ?? Date.now()
  const result: ProfileUpdateResult = { changed: 0, claims: 0, sessions: 0, conventions: [] }
  const person = await listAll(personRef())
  const { claims, sessions } = await currentClaims(now, person)
  result.claims = claims.length
  result.sessions = sessions
  const prev = readJsonSafeSync<{ localProjects?: unknown }>(profileClaimsFile())
  const previous = prev.ok && prev.value !== null && Array.isArray(prev.value.localProjects) ? prev.value.localProjects.filter(memIsSlug) : []
  const facts = profileFacts(claims)
  const localProjects = [...new Set(facts.filter(f => f.project !== undefined && !f.hypothesis).map(f => f.project as string))].sort()
  try { atomicWriteSync(profileClaimsFile(), JSON.stringify({ v: 1, at: now, sessions, localProjects, claims }, null, 2) + '\n', { mode: 0o600 }) } catch (e) { log('warn', 'memory: profile claims not recorded', { error: e }) }
  const global = new Map(facts.filter(f => f.project === undefined).map(f => [factId('profile', f.key), f] as const))
  result.changed += await syncFacts(personRef(), 'profile', global, now)
  const slugs = new Set<string>([...(opts.projects ?? []), ...localProjects, ...previous])
  for (const slug of slugs) {
    if (!memIsSlug(slug)) continue
    const local = new Map(facts.filter(f => f.project === slug && !f.hypothesis).map(f => [factId('convention', f.key), f] as const))
    const n = await syncFacts(projectRef(slug), 'convention', local, now)
    if (n > 0) { result.changed += n; result.conventions.push(slug) }
  }
  return result
}

export function profileLines(person: readonly MemItem[], max = 10, nowMs = Date.now()): string[] {
  const rank = (i: MemItem) => Number((i.tags.find(t => t.startsWith('rank-')) ?? 'rank-9').slice(5))
  return person
    .filter(i => i.kind === 'profile' && isLive(i, nowMs) && !i.tags.includes('hypothesis'))
    .sort((a, b) => rank(a) - rank(b) || b.importance - a.importance || a.title.localeCompare(b.title))
    .slice(0, max)
    .map(i => `- ${i.title}${i.summary.includes('· medium') ? ' (medium)' : ''}`)
}

export interface ProfileDropResult {
  dropped: Array<{ key: string, text: string }>
  matches: Array<{ key: string, text: string }>
  update?: ProfileUpdateResult
}

export async function dropProfileClaim(query: string, opts: { nowMs?: number, all?: boolean } = {}): Promise<ProfileDropResult> {
  const now = opts.nowMs ?? Date.now()
  const q = query.trim()
  if (q === '') return { dropped: [], matches: [] }
  const { claims } = await currentClaims(now, await listAll(personRef()))
  const exact = claims.filter(c => c.key === q)
  const words = normalizeForSearch(q)
  const found = exact.length > 0 ? exact : claims.filter(c => normalizeForSearch(c.text).includes(words) || (c.quote !== undefined && normalizeForSearch(c.quote).includes(words)))
  const matches = found.map(c => ({ key: c.key, text: c.text }))
  if (matches.length === 0 || (matches.length > 1 && opts.all !== true)) return { dropped: [], matches }
  const dropped = { ...loadDropped() }
  for (const m of matches) dropped[m.key] = { at: now, text: m.text }
  mkdirSync(dirname(profileDroppedFile()), { recursive: true })
  atomicWriteSync(profileDroppedFile(), JSON.stringify({ v: 1, dropped } satisfies DroppedFile, null, 2) + '\n', { mode: 0o600 })
  const update = await updateProfile({ nowMs: now, projects: [...new Set(found.flatMap(c => c.projects))] })
  return { dropped: matches, matches, update }
}

export async function profileSummary(): Promise<{ top: string[], hypotheses: string[], claims: number, sessions: number, at?: number }> {
  const r = readJsonSafeSync<{ at?: number, sessions?: number, claims?: unknown[] }>(profileClaimsFile())
  const state = r.ok && r.value !== null && typeof r.value === 'object' ? r.value : {}
  const person = await listAll(personRef()).catch(() => [] as MemItem[])
  const out: { top: string[], hypotheses: string[], claims: number, sessions: number, at?: number } = {
    top: profileLines(person, 20),
    hypotheses: person.filter(i => i.kind === 'profile' && i.tags.includes('hypothesis')).map(i => `- ${i.title}`),
    claims: Array.isArray(state.claims) ? state.claims.length : 0, sessions: typeof state.sessions === 'number' ? state.sessions : 0,
  }
  if (typeof state.at === 'number') out.at = state.at
  return out
}

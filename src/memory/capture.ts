import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HARNESSES, isHarness, type Harness } from '../core/events'
import { isLive, KIND_INFO, similarMemories, type MemItem } from '../core/memory/brain'
import { CAPTURE_BUDGET } from '../core/memory/budgets'
import { memNoteHarness } from '../core/memory/note'
import { signalGroup, type PromptSignal } from '../core/memory/signals'
import { memClip, memOneLine } from '../core/memory/text'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { write, type MemoryCtx } from './api'
import { sessionRecordFile, sessionRecordsDir, spoolDir } from './layout'
import { openSessions, readSessionRecord } from './session-open'
import { listAll, personRef } from './store'

export const PENDING_GIVE_UP_MS = 14 * 86_400_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RECORDS_SCANNED = 200

export interface PreferenceResult {
  written: string[]
  superseded: string[]
  skipped: number
}

/** The marker a preference memory carries in `sources`, so the same statement is not filed twice. */
export function signalToken(s: Pick<PromptSignal, 'key' | 'polarity'>): string {
  return `signal:${s.key}${s.polarity === -1 ? '|not' : ''}`
}

function tokensOf(m: MemItem): string[] {
  return m.sources.filter(s => s.startsWith('signal:'))
}

/**
 * Files what the user stated about how to work ("always", "never", "from now on", a reply-language request) as
 * person-layer preference memories, with no model involved. Each one carries origin `explicit` and confidence 1:
 * the user's own words, which no later inference may overrule. A statement already filed (same signal, or a
 * near-identical title) is skipped; a newer statement in an exclusive group (the reply language, asking first or
 * never) replaces the older one.
 */
export async function capturePreferences(
  signals: ReadonlyArray<{ ts: number, signal: PromptSignal }>,
  o: { harness: Harness, sid: string, cwd: string, nowMs: number },
): Promise<PreferenceResult> {
  const out: PreferenceResult = { written: [], superseded: [], skipped: 0 }
  const statements = [...signals].filter(s => s.signal.kind === 'statement').sort((a, b) => a.ts - b.ts)
  if (statements.length === 0) return out
  const ctx: MemoryCtx = {
    cwd: o.cwd, harness: memNoteHarness(o.harness), generatedBy: 'process:buracle-capture', agent: true, session: o.sid, project: null, now: () => o.nowMs,
  }
  const latest = new Map<string, { ts: number, signal: PromptSignal }>()
  for (const s of statements) latest.set(signalToken(s.signal), s)
  let existing = (await listAll(personRef())).filter(i => isLive(i, o.nowMs) && i.kind === 'preference')
  for (const { signal } of latest.values()) {
    const token = signalToken(signal)
    if (existing.some(i => tokensOf(i).includes(token))) { out.skipped++; continue }
    const title = memClip(memOneLine(signal.text ?? signal.key), 200)
    const summary = memClip(memOneLine(signal.quote ?? ''), 300)
    if (similarMemories({ title, summary, kind: 'preference' }, existing, o.nowMs, 0.85).length > 0) { out.skipped++; continue }
    const group = signalGroup(signal.key)
    const opposite = `signal:${signal.key}${signal.polarity === -1 ? '' : '|not'}`
    const replaced = existing.filter(i => explicit(i) && tokensOf(i).some(t => t === opposite || (group !== undefined && t.startsWith(`signal:${group}=`) && t !== token)))
    const quote = signal.quote !== undefined ? `The user said: "${memClip(memOneLine(signal.quote), 300)}"` : ''
    const w = await write(ctx, {
      kind: 'preference', layer: 'person', title, summary, body: quote, force: true, importance: 4,
      tags: ['explicit', ...(signal.category !== undefined ? [signal.category] : [])],
      sources: [token, `session:${o.sid}`], supersedes: replaced.map(i => i.id),
    }, { internal: true, author: 'buracle', origin: 'explicit', confidence: 1, review: 'ok' })
    if (w.action === 'duplicate_suspected') { out.skipped++; continue }
    out.written.push(w.id)
    out.superseded.push(...(w.superseded ?? []))
    existing = (await listAll(personRef())).filter(i => isLive(i, o.nowMs) && i.kind === 'preference')
  }
  return out
}

function explicit(i: MemItem): boolean {
  return i.origin === 'explicit' && !KIND_INFO[i.kind].generated
}

export interface PendingSession {
  h: Harness
  sid: string
  why: 'retry' | 'stale' | 'orphan'
  /** The newest sign of life, so the oldest can be taken first. */
  lastMs: number
}

function activeSpools(): Array<{ name: string, mtimeMs: number }> {
  let names: string[] = []
  try { names = readdirSync(spoolDir()) } catch { return [] }
  const out: Array<{ name: string, mtimeMs: number }> = []
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    try { out.push({ name, mtimeMs: statSync(join(spoolDir(), name)).mtimeMs }) } catch {  }
  }
  return out
}

function sidOf(name: string, h: Harness): string[] {
  const rest = name.slice(h.length + 1, -'.jsonl'.length)
  const cuts: string[] = []
  for (let i = rest.length; i > 0; i = rest.lastIndexOf('-', i - 1)) cuts.push(rest.slice(0, i))
  return cuts
}

/**
 * Sessions whose capture is still owed and that no live session or running finalizer can claim: a failed or held
 * model call waiting for another try, a session whose harness died before the end hook ran, and spools nothing
 * recorded. Everything counts only once it is `pendingAfterMs` old, so a session that is merely quiet is left alone.
 */
/**
 * Whether a file changed too recently to settle. A file's mtime carries sub-millisecond digits and `Date.now()` is cut to
 * whole milliseconds, so a file written in the same millisecond as the check has an mtime slightly AFTER `nowMs`: with no
 * waiting asked for (afterMs 0, the doctor) nothing is ever too recent.
 */
function tooRecent(nowMs: number, mtimeMs: number, afterMs: number): boolean {
  return afterMs > 0 && nowMs - mtimeMs < afterMs
}

export function pendingSessions(nowMs: number, opts: { skip?: { h: Harness, sid: string }, max?: number, afterMs?: number } = {}): PendingSession[] {
  const afterMs = opts.afterMs ?? CAPTURE_BUDGET.pendingAfterMs
  const max = opts.max ?? CAPTURE_BUDGET.pendingPerRun
  const live = new Set(openSessions(nowMs).map(s => `${s.h}-${s.sid}`))
  const skip = opts.skip !== undefined ? `${opts.skip.h}-${opts.skip.sid}` : undefined
  const spools = activeSpools()
  const found = new Map<string, PendingSession>()
  const add = (p: PendingSession): void => {
    const key = `${p.h}-${p.sid}`
    if (key !== skip && !live.has(key) && !found.has(key)) found.set(key, p)
  }
  let names: string[] = []
  try { names = readdirSync(sessionRecordsDir()) } catch {  }
  const recent = names.filter(n => n.endsWith('.json')).flatMap(n => {
    try { return [{ n, mtimeMs: statSync(join(sessionRecordsDir(), n)).mtimeMs }] } catch { return [] }
  }).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, RECORDS_SCANNED)
  const recorded = new Set<string>()
  for (const { n } of recent) {
    const dash = n.indexOf('-')
    const h = n.slice(0, dash)
    const sid = n.slice(dash + 1, -'.json'.length)
    if (!isHarness(h) || !paths.isValidSessionId(sid)) continue
    recorded.add(`${h}-${sid}`)
    const rec = readSessionRecord(h, sid)
    if (rec === undefined) continue
    const mine = spools.filter(s => sidOf(s.name, h).includes(sid) && s.name.startsWith(`${h}-`))
    let last = 0
    try { last = statSync(sessionRecordFile(h, sid)).mtimeMs } catch {  }
    for (const s of mine) last = Math.max(last, s.mtimeMs)
    if (tooRecent(nowMs, last, afterMs)) continue
    if (rec.status === 'ended') {
      const c = rec.capture
      const waiting = c?.state === 'retry' && c.tries < CAPTURE_BUDGET.maxTries && nowMs - (rec.finalizedMs ?? 0) < PENDING_GIVE_UP_MS && nowMs - (c.lastTryMs ?? 0) >= afterMs
      if (waiting) add({ h, sid, why: 'retry', lastMs: c.lastTryMs ?? last })
      else if (mine.length > 0) add({ h, sid, why: 'stale', lastMs: last })
    } else add({ h, sid, why: 'stale', lastMs: last })
  }
  for (const s of spools) {
    const dash = s.name.indexOf('-')
    const h = s.name.slice(0, dash)
    if (dash <= 0 || !isHarness(h) || tooRecent(nowMs, s.mtimeMs, afterMs)) continue
    const cuts = sidOf(s.name, h)
    if (cuts.some(sid => recorded.has(`${h}-${sid}`) || (paths.isValidSessionId(sid) && existsSync(sessionRecordFile(h, sid))))) continue
    const sid = cuts.find(c => UUID_RE.test(c)) ?? cuts[0]
    if (sid !== undefined && paths.isValidSessionId(sid)) add({ h, sid, why: 'orphan', lastMs: s.mtimeMs })
  }
  const order = (h: Harness) => HARNESSES.indexOf(h)
  return [...found.values()].sort((a, b) => a.lastMs - b.lastMs || order(a.h) - order(b.h) || (a.sid < b.sid ? -1 : 1)).slice(0, max)
}

export function logPending(p: readonly PendingSession[]): void {
  if (p.length > 0) log('info', 'memory: stale sessions are captured with this one', { sessions: p.map(x => `${x.h}-${x.sid}:${x.why}`) })
}

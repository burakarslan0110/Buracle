import { randomBytes } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isLive, memoryIdFor, type MemItem, type MemKind, type MemLayer, type MemReview } from '../core/memory/brain'
import type { Harness } from '../core/events'
import { REFLECT_BUDGET, type ReflectBudget } from '../core/memory/budgets'
import { brainEventsSince,
  duplicatePairs, memoryLink, parseReflectPlan, recalledSince, REFLECT_BY, reflectApplyOrder, reflectDue, reflectFocus, reflectLookup, reflectOpTarget,
  reflectPrompt, reflectUpkeep, validateReflectOps, type ReflectOp, type ReflectRejection,
} from '../core/memory/reflect'
import { coreHumanPart, detectedBlockOf, withDetectedBlock } from '../core/memory/repo'
import { memClip, memOneLine, redact } from '../core/memory/text'
import { VERIFY_BY } from '../core/memory/verify'
import { atomicWriteSync, sha256 } from '../engine/fsx'
import { log } from '../engine/log'
import { eventsFile, locksDir, reflectUndoDir, reflectUndoFile, REFLECT_RUN_ID_RE } from './layout'
import { tryLock } from './lock'
import { chooseHarnesses, choiceHoldsRunner, choiceRunner, choiceSkip, choiceWhy, type HarnessPick, type ModelChoice } from './model'
import {
  appendReflectRun, lastReflectAt, markReflectUndone, readReflectRuns,
  type ReflectApplied, type ReflectRunEntry, type ReflectSkip, type ReflectTrigger,
} from './reflect-log'
import { appendJob } from './jobs'
import { RUNNER_TIMEOUT_MS, runnerModelId, type ModelRunner } from './runner'
import { recordRedactions } from './spool'
import { refreshStatus } from './status'
import { brainExists, deleteItem, getStored, listAll, personRef, projectRef, recordEvent, saveItem, withBrainLock, type BrainRef, type Stored } from './store'
import { curatorEvidence } from './curate'
import { repointMemoryLinks } from './links'
import { projectRoot } from './project'
import { readUpkeep, refreshUpkeepFor } from './sweep'

export type ReflectRunner = ModelRunner
export {
  listReflectRuns, readReflectRuns, reflectOverview,
  type ReflectApplied, type ReflectOverview, type ReflectRunEntry, type ReflectRunView, type ReflectScope, type ReflectSkip, type ReflectTrigger,
} from './reflect-log'
export { REFLECT_BY } from '../core/memory/reflect'

export const NO_REFLECT_ENV = 'BURACLE_NO_REFLECT'
export const REFLECT_DEFAULT_MODEL = 'default'

export interface ReflectRun extends ReflectRunEntry {
  logged: boolean
}

export interface ReflectOptions {
  trigger: ReflectTrigger
  runner?: ReflectRunner
  dryRun?: boolean
  nowMs?: number
  harness?: Harness
  model?: string
  env?: Readonly<Record<string, string | undefined>>
}

const DAY_MS = 86_400_000
const EVENTS_TAIL_BYTES = 1 << 20

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function newRunId(nowMs: number): string {
  const s = iso(nowMs)
  return `rf-${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11, 19).replace(/:/g, '')}-${randomBytes(2).toString('hex')}`
}

function readEventsTail(): unknown[] {
  let fd: number | undefined
  try {
    fd = openSync(eventsFile(), 'r')
    const size = fstatSync(fd).size
    const start = Math.max(0, size - EVENTS_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split('\n')
    if (start > 0) lines.shift()
    const out: unknown[] = []
    for (const l of lines) { if (l.trim() !== '') { try { out.push(JSON.parse(l)) } catch {  } } }
    return out
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export async function reflectBrain(ref: BrainRef, opts: ReflectOptions): Promise<ReflectRun> {
  const t0 = Date.now()
  const run = await reflectBrainOnce(ref, opts)
  if (run.skipped !== 'unchanged') {
    appendJob({
      job: 'reflect', trigger: opts.trigger,
      outcome: run.skipped === undefined ? 'ran' : run.skipped === 'runner-failed' ? 'failed' : 'skipped',
      ...(run.skipped !== undefined ? { reason: run.skipped } : {}),
      ...(run.skipped === undefined ? { detail: `applied ${run.applied.length}, rejected ${run.rejected.length}${run.dryRun === true ? ' (dry run)' : ''}` } : run.detail !== undefined ? { detail: run.detail } : {}),
      ...(run.harness !== undefined ? { harness: run.harness } : {}), layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), ms: Date.now() - t0,
    })
  }
  return run
}

async function reflectBrainOnce(ref: BrainRef, opts: ReflectOptions): Promise<ReflectRun> {
  const now = opts.nowMs ?? Date.now()
  const cfg = REFLECT_BUDGET
  const env = opts.env ?? process.env
  const model = runnerModelId(opts.model)
  const choice = chooseHarnesses({ ...(opts.harness !== undefined ? { prefer: opts.harness } : {}), ...(model !== undefined ? { model } : {}), nowMs: now, checkCli: opts.runner === undefined })
  const pick = choice.picks[0]
  const run: ReflectRun = {
    v: 1, id: newRunId(now), at: iso(now), layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}),
    trigger: opts.trigger, ...(pick !== undefined ? { harness: pick.harness } : {}),
    model: pick?.model ?? REFLECT_DEFAULT_MODEL,
    ...(opts.dryRun === true ? { dryRun: true } : {}),
    rounds: 0, subQueries: 0, shown: 0, proposed: 0, applied: [], rejected: [], inputChars: 0, outputChars: 0, logged: false,
  }
  const manual = opts.trigger === 'manual'
  const finish = async (skipped?: ReflectSkip, detail?: string, logIt = true): Promise<ReflectRun> => {
    if (skipped !== undefined) run.skipped = skipped
    if (detail !== undefined) run.detail = detail
    if (logIt) {
      const { logged: _l, ...entry } = run
      run.logged = await appendReflectRun(entry, now)
    }
    return run
  }
  if (opts.runner === undefined && env[NO_REFLECT_ENV] === '1') return finish('disabled', `${NO_REFLECT_ENV}=1`, false)
  if (!brainExists(ref)) return finish('no-brain', 'nothing was written to this brain yet', false)
  if (pick === undefined && (opts.runner === undefined || choiceHoldsRunner(choice))) return finish(choiceSkip(choice), choiceWhy(choice), manual)
  const entries = readReflectRuns()
  const release = tryLock(join(locksDir(), `reflect-${sha256(ref.db).slice(0, 16)}.lock`), 15 * 60_000, { heartbeat: true })
  if (!release) return finish('busy', 'another reflect run works on this brain', manual)
  try {
    return await runLocked(ref, run, { cfg, choice, pick, opts, now, entries, manual, finish })
  } finally {
    release()
  }
}

const REFLECT_WORK: readonly string[] = ['capture', 'duplicate', 'contradicted']

function reflectWorkWaits(ref: BrainRef): boolean {
  return (readUpkeep(ref.slug)?.items ?? []).some(u => u.quiet !== true && u.reasons.some(r => REFLECT_WORK.includes(r)))
}

function reflectWorkDue(ref: BrainRef, nowMs: number, sinceMs: number, everyMs: number): boolean {
  return nowMs - sinceMs >= everyMs && reflectWorkWaits(ref)
}

interface RunCtx {
  cfg: ReflectBudget
  choice: ModelChoice
  pick: HarnessPick | undefined
  opts: ReflectOptions
  now: number
  entries: readonly ReflectRunEntry[]
  manual: boolean
  finish: (skipped?: ReflectSkip, detail?: string, logIt?: boolean) => Promise<ReflectRun>
}

async function runLocked(ref: BrainRef, run: ReflectRun, c: RunCtx): Promise<ReflectRun> {
  const { cfg, now } = c
  const sinceCheap = lastReflectAt(c.entries, ref, true)
  if (!c.manual && sinceCheap !== undefined && !brainEventsSince(readEventsTail(), { layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}) }, iso(sinceCheap), [REFLECT_BY]) && !reflectWorkDue(ref, now, sinceCheap, cfg.relateEveryMs)) {
    return c.finish('unchanged', 'no event in the brain since the last run', false)
  }
  const items = await listAll(ref)
  const live = items.filter(i => isLive(i, now))
  const byId = new Map(live.map(i => [i.id, i]))
  const stored = readUpkeep(ref.slug)?.items ?? []
  const missing = new Set(stored.filter(u => u.reasons.includes('source-missing')).map(u => u.id))
  const upkeep = [...reflectUpkeep(items, now).filter(u => !missing.has(u.id)), ...stored.filter(u => missing.has(u.id) && byId.has(u.id))]
  const duplicates = duplicatePairs(upkeep)
  const since = lastReflectAt(c.entries, ref, true)
  const recalled = recalledSince(readEventsTail(), { layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}) }, iso(since ?? now - 7 * DAY_MS))
  const due = reflectDue({ items, nowMs: now, ...(since !== undefined ? { lastRunMs: since } : {}), recalled, relateEveryMs: cfg.relateEveryMs, ignoreBy: [REFLECT_BY, VERIFY_BY], waiting: reflectWorkWaits(ref) })
  if (!c.manual && !due.due) return c.finish('unchanged', 'nothing was written or changed since the last run', false)
  const focus = reflectFocus({ items, nowMs: now, upkeep, recalled, changed: due.changed })
  if (focus.ids.length === 0) return c.finish('nothing-to-do', 'no memory needs attention', c.manual)
  const focusItems = focus.ids.map(id => byId.get(id)).filter((i): i is MemItem => i !== undefined)
  const root = ref.slug !== undefined ? projectRoot(ref.slug) : undefined
  const evidence = await curatorEvidence({ ...(root !== undefined ? { root } : {}), items: focusItems, upkeep })
  const runner = c.opts.runner ?? choiceRunner(c.choice, {
    nowMs: () => Date.now(),
    onNext: (from, error, to) => {
      log('info', 'memory: a harness CLI failed during reflect', { layer: ref.layer, project: ref.slug, from: from.harness, to: to?.harness, error: redact(error).text })
      if (to !== undefined) { run.harness = to.harness; run.model = to.model ?? REFLECT_DEFAULT_MODEL }
    },
  })
  const model = c.pick?.model
  const shownIds = new Set<string>()
  const hits: MemItem[] = []
  let queriesLeft = cfg.maxSubQueries
  let rawOps: unknown[] = []
  let redactions = 0
  for (let round = 1; round <= cfg.maxRounds; round++) {
    const final = round === cfg.maxRounds || queriesLeft <= 0
    const prompt = reflectPrompt({
      round: final ? 'ops' : 'queries', layer: ref.layer, focus: focusItems, focusWhy: focus.why, hits, duplicates, evidence,
      maxOps: cfg.maxOpsPerRun, queriesLeft, maxOutputTokens: cfg.maxOutputTokens, maxChars: Math.max(2000, cfg.maxInputTokens * 4),
    })
    for (const id of prompt.shown) shownIds.add(id)
    redactions += prompt.redactions
    run.inputChars += prompt.text.length
    run.rounds++
    const out = await runner(prompt.text, { ...(model !== undefined ? { model } : {}), maxOutputTokens: cfg.maxOutputTokens, timeoutMs: RUNNER_TIMEOUT_MS })
    if (!out.ok && out.unavailable === true) {
      run.rounds--
      run.shown = shownIds.size
      return c.finish('runner-unavailable', memClip(memOneLine(redact(out.error ?? 'the harness CLI is not on PATH').text), 300), c.manual)
    }
    if (!out.ok) {
      run.rounds--
      run.shown = shownIds.size
      return c.finish('runner-failed', memClip(memOneLine(redact(out.error ?? 'the model did not answer').text), 300))
    }
    const text = out.text.slice(0, Math.max(4000, cfg.maxOutputTokens * 6))
    run.outputChars += text.length
    const plan = parseReflectPlan(text)
    if (final) { rawOps = plan.ops; break }
    const queries = plan.queries.slice(0, queriesLeft)
    if (queries.length === 0) { rawOps = plan.ops; break }
    queriesLeft -= queries.length
    run.subQueries += queries.length
    for (const q of queries) for (const h of reflectLookup(items, q.q, now, 5)) if (!hits.some(x => x.id === h.id)) hits.push(h)
  }
  run.shown = shownIds.size
  run.focus = focus.ids.filter(id => shownIds.has(id))
  run.proposed = rawOps.length
  const shown = new Map<string, MemItem>()
  for (const id of shownIds) { const i = byId.get(id); if (i !== undefined) shown.set(id, i) }
  const v = validateReflectOps(rawOps, { shown, live, duplicates, maxOps: cfg.maxOpsPerRun, evidence })
  run.rejected.push(...v.rejected)
  redactions += v.redactions
  if (redactions > 0) recordRedactions(redactions, ['reflect'], 'reflect', now)
  if (c.opts.dryRun === true) {
    run.planned = v.accepted.map(describe)
    return c.finish()
  }
  if (v.accepted.length > 0) await applyAll(ref, run, v.accepted, items, now)
  if (run.applied.length > 0) {
    try {
      await refreshUpkeepFor(ref, { nowMs: now })
      await refreshStatus({ ...(ref.slug !== undefined ? { slug: ref.slug } : {}), nowMs: now, lastWrite: { by: REFLECT_BY } })
    } catch (e) { log('warn', 'memory: upkeep not refreshed after reflect', { error: e }) }
  }
  return c.finish()
}

function describe(op: ReflectOp): ReflectApplied {
  const base = { op: op.op, id: reflectOpTarget(op), why: op.why }
  switch (op.op) {
    case 'relate': return { ...base, to: op.to }
    case 'merge': return { ...base, to: op.into }
    case 'file': return { ...base, to: op.kind }
    case 'drop': return op.twin !== undefined ? { ...base, to: op.twin } : base
    case 'synthesize': return { ...base, to: op.from.join(',') }
    default: return base
  }
}

interface Touched {
  version: number
  now?: string
  retiredInto?: string
  retired?: true
  before: {
    tags?: string[], about?: string[], sources?: string[], summary?: string, review?: MemReview, kind?: MemKind,
    title?: string, body?: string,
    contradictedAt?: string, contradictedNote?: string,
  }
}

interface UndoJournal {
  v: 1
  runId: string
  at: string
  layer: MemLayer
  project?: string
  touched: Record<string, Touched>
  created: Array<{ id: string, version: number }>
}

function writeJournal(j: UndoJournal): void {
  mkdirSync(reflectUndoDir(), { recursive: true, mode: 0o700 })
  atomicWriteSync(reflectUndoFile(j.runId), JSON.stringify(j, null, 2) + '\n', { mode: 0o600 })
}

async function applyAll(ref: BrainRef, run: ReflectRun, accepted: readonly ReflectOp[], items: readonly MemItem[], now: number): Promise<void> {
  const at = iso(now)
  const journal: UndoJournal = { v: 1, runId: run.id, at, layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), touched: {}, created: [] }
  const expected = new Map(items.map(i => [i.id, i.version]))
  const event = (op: 'update' | 'write' | 'retire', id: string, kind: MemKind) => recordEvent({ op, layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), id, kind, by: REFLECT_BY })
  await withBrainLock(ref, async () => {
    const taken = new Set((await listAll(ref)).map(i => i.id))
    const current = async (id: string): Promise<Stored | 'gone' | 'changed'> => {
      const s = await getStored(ref, id)
      if (s === undefined) return 'gone'
      if (s.item.version !== expected.get(id) || !isLive(s.item, now)) return 'changed'
      return s
    }
    const touch = (id: string, field: keyof Touched['before'], value: Touched['before'][keyof Touched['before']]): Touched => {
      const t = journal.touched[id] ?? { version: 0, before: {} }
      if (t.before[field] === undefined) (t.before as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value
      journal.touched[id] = t
      return t
    }
    const next = (s: Stored, what: string): MemItem => ({
      ...s.item, tags: [...s.item.tags], about: [...s.item.about], sources: [...s.item.sources],
      version: s.item.version + 1, updated: at,
      history: [...s.item.history, { at, by: REFLECT_BY, what: memClip(memOneLine(`reflect ${run.id}: ${what}`), 200) }].slice(-8),
    })
    const done = (key: string, item: MemItem) => {
      expected.set(item.id, item.version)
      const t = journal.touched[key]
      if (t !== undefined) t.version = item.version
    }
    for (const op of reflectApplyOrder(accepted)) {
      const target = reflectOpTarget(op)
      const skip = (reason: ReflectRejection['reason']) => { run.rejected.push({ op: op.op, id: target, reason }) }
      try {
        if (op.op === 'synthesize') {
          const sources: MemItem[] = []
          for (const id of op.from) {
            const s = await getStored(ref, id)
            if (s === undefined || !isLive(s.item, now)) break
            sources.push(s.item)
          }
          if (sources.length !== op.from.length) { skip('gone'); continue }
          const id = memoryIdFor('capture', op.title, taken)
          taken.add(id)
          const item: MemItem = {
            id, kind: 'capture', layer: ref.layer, title: op.title, summary: '',
            body: `Synthesized by Buracle's reflect run ${run.id} from ${op.from.join(', ')}. A draft: check it against the code or a primary source, then file it (memory_update move) or deprecate it.${op.body !== '' ? `\n\n${op.body}` : ''}`,
            tags: ['reflect'], sources: op.from.map(memoryLink), about: [], status: 'active', review: 'pending', importance: 2,
            created: at, updated: at, author: 'buracle', version: 1, history: [{ at, by: REFLECT_BY, what: `reflect ${run.id}: synthesized` }],
            harness: REFLECT_BY, model: run.model,
          }
          await saveItem(ref, item)
          journal.created.push({ id, version: 1 })
          expected.set(id, 1)
          event('write', id, 'capture')
          writeJournal(journal)
          run.applied.push({ ...describe(op), id })
          continue
        }
        const cur = await current(op.id)
        if (cur === 'gone' || cur === 'changed') { skip(cur); continue }
        const item = cur.item
        switch (op.op) {
          case 'tag': {
            const fresh = op.add.filter(t => !item.tags.includes(t))
            if (fresh.length === 0) { skip('changed'); continue }
            const n = next(cur, `tags + ${fresh.join(', ')}`)
            touch(op.id, 'tags', item.tags)
            n.tags = [...item.tags, ...fresh].slice(0, 12)
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('update', n.id, n.kind)
            break
          }
          case 'about': {
            const have = new Set(item.about.map(a => a.toLowerCase()))
            const fresh = op.add.filter(a => !have.has(a.toLowerCase()))
            if (fresh.length === 0) { skip('changed'); continue }
            const n = next(cur, `about + ${fresh.join(', ')}`)
            touch(op.id, 'about', item.about)
            n.about = [...item.about, ...fresh].slice(0, 12)
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('update', n.id, n.kind)
            break
          }
          case 'relate': {
            const to = await getStored(ref, op.to)
            if (to === undefined || !isLive(to.item, now)) { skip('gone'); continue }
            const n = next(cur, `related to ${op.to}`)
            touch(op.id, 'sources', item.sources)
            n.sources = [...item.sources, memoryLink(op.to)].slice(0, 20)
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('update', n.id, n.kind)
            break
          }
          case 'summary': {
            if (item.review === 'ok' && item.summary.trim() !== '') { skip('changed'); continue }
            const n = next(cur, 'summary written')
            touch(op.id, 'summary', item.summary)
            n.summary = op.text
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('update', n.id, n.kind)
            break
          }
          case 'doubt': {
            if (item.review !== 'ok') { skip('changed'); continue }
            const n = next(cur, `doubt: ${op.reason}`)
            touch(op.id, 'review', item.review)
            n.review = 'pending'
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('update', n.id, n.kind)
            break
          }
          case 'rewrite': {
            if (item.contradictedAt === undefined || item.review !== 'pending') { skip('changed'); continue }
            const n = next(cur, `restated after a contradiction: ${op.why}`)
            touch(op.id, 'title', item.title)
            touch(op.id, 'summary', item.summary)
            touch(op.id, 'body', item.body)
            touch(op.id, 'review', item.review)
            touch(op.id, 'contradictedAt', item.contradictedAt)
            touch(op.id, 'contradictedNote', item.contradictedNote ?? '')
            if (op.title !== undefined) n.title = op.title
            if (op.summary !== undefined) n.summary = op.summary
            if (op.body !== undefined) n.body = op.body
            n.review = 'pending'
            delete n.contradictedAt
            delete n.contradictedNote
            delete n.verifiedAt
            delete n.verifiedBy
            delete n.verifiedCommit
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('update', n.id, n.kind)
            break
          }
          case 'sources': {
            const n = next(cur, `sources set after evidence: ${op.why}`)
            touch(op.id, 'sources', item.sources)
            touch(op.id, 'review', item.review)
            n.sources = op.set.slice(0, 20)
            n.review = 'pending'
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('update', n.id, n.kind)
            break
          }
          case 'retire': {
            if (item.pinned === true) { skip('changed'); continue }
            const n = next(cur, `retired on evidence: ${op.why}`)
            n.status = 'deprecated'
            n.deprecatedAt = at
            journal.touched[op.id] = { ...(journal.touched[op.id] ?? { before: {} }), version: n.version, retired: true }
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('retire', n.id, n.kind)
            break
          }
          case 'core': {
            if (item.kind !== 'core' || coreHumanPart(item.body) !== '') { skip('changed'); continue }
            const n = next(cur, `drafted by reflect: ${op.why}`)
            touch(op.id, 'body', item.body)
            n.body = withDetectedBlock(op.body, detectedBlockOf(item.body))
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('update', n.id, n.kind)
            break
          }
          case 'drop': {
            if (item.kind !== 'capture' || item.pinned === true) { skip('changed'); continue }
            const n = next(cur, `dropped: ${op.why}${op.twin !== undefined ? ` (already in ${op.twin})` : ''}`)
            n.status = 'deprecated'
            n.deprecatedAt = at
            journal.touched[op.id] = { ...(journal.touched[op.id] ?? { before: {} }), version: n.version, retired: true }
            await saveItem(ref, n, cur.keep)
            done(op.id, n)
            event('retire', n.id, n.kind)
            break
          }
          case 'file': {
            if (item.kind !== 'capture') { skip('changed'); continue }
            const free = new Set(taken)
            free.delete(item.id)
            const newId = memoryIdFor(op.kind, item.title, free)
            const n: MemItem = { ...next(cur, `filed as ${op.kind}`), id: newId, kind: op.kind, review: 'pending' }
            const t = touch(op.id, 'kind', item.kind)
            touch(op.id, 'review', item.review)
            await saveItem(ref, n, {})
            if (newId !== item.id) {
              await deleteItem(ref, item.id)
              taken.delete(item.id)
              await repointMemoryLinks(ref, items, item.id, newId, at, REFLECT_BY)
            }
            taken.add(newId)
            t.now = newId
            done(op.id, n)
            event('update', newId, op.kind)
            writeJournal(journal)
            run.applied.push({ ...describe(op), to: newId })
            continue
          }
          case 'merge': {
            const into = await current(op.into)
            if (into === 'gone' || into === 'changed') { skip(into); continue }
            const retired = next(cur, `merged into ${op.into}`)
            const kept = next(into, `took over ${op.id}`)
            touch(op.into, 'tags', into.item.tags)
            touch(op.into, 'sources', into.item.sources)
            touch(op.into, 'about', into.item.about)
            kept.tags = [...new Set([...into.item.tags, ...item.tags])].slice(0, 12)
            kept.sources = [...new Set([...into.item.sources, ...item.sources])].slice(0, 20)
            kept.about = [...new Set([...into.item.about, ...item.about])].slice(0, 12)
            journal.touched[op.id] = { ...(journal.touched[op.id] ?? { before: {} }), version: retired.version, retiredInto: op.into }
            await saveItem(ref, retired, cur.keep)
            await saveItem(ref, kept, into.keep, { supersedes: [op.id] })
            done(op.id, retired)
            done(op.into, kept)
            event('retire', op.id, item.kind)
            event('update', op.into, into.item.kind)
            break
          }
        }
        writeJournal(journal)
        run.applied.push(describe(op))
      } catch (e) {
        log('warn', 'memory: a reflect operation was not applied', { op: op.op, id: target, error: e })
        for (const [k, t] of Object.entries(journal.touched)) if (t.version === 0) delete journal.touched[k]
        skip('failed')
      }
    }
  })
  if (run.applied.length === 0) { try { unlinkSync(reflectUndoFile(run.id)) } catch {  } }
}

export interface ReflectUndoResult {
  runId: string
  layer: MemLayer
  project?: string
  restored: string[]
  retired: string[]
  conflicts: Array<{ id: string, reason: 'changed' | 'gone' }>
}

function readJournal(runId: string): UndoJournal | undefined {
  try {
    const v = JSON.parse(readFileSync(reflectUndoFile(runId), 'utf8')) as UndoJournal
    return v.v === 1 && v.runId === runId && (v.layer === 'project' || v.layer === 'person') && typeof v.touched === 'object' && Array.isArray(v.created) ? v : undefined
  } catch {
    return undefined
  }
}

export async function undoReflect(runId: string, opts: { nowMs?: number } = {}): Promise<ReflectUndoResult> {
  if (!REFLECT_RUN_ID_RE.test(runId)) throw new Error(`not a reflect run id: ${JSON.stringify(runId)} (see buracle mem reflect --list)`)
  const j = readJournal(runId)
  if (j === undefined) {
    const run = readReflectRuns().find(e => e.id === runId)
    throw new Error(run === undefined ? `no reflect run ${runId}` : run.undone !== undefined ? `${runId} was undone already (${run.undone})` : `${runId} changed nothing, or its undo journal is gone`)
  }
  const now = opts.nowMs ?? Date.now()
  const at = iso(now)
  const ref = j.layer === 'person' ? personRef() : projectRef(j.project ?? '')
  const res: ReflectUndoResult = { runId, layer: j.layer, ...(j.project !== undefined ? { project: j.project } : {}), restored: [], retired: [], conflicts: [] }
  const event = (op: 'update' | 'retire', id: string, kind: MemKind) => recordEvent({ op, layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), id, kind, by: REFLECT_BY })
  const history = (i: MemItem, what: string) => [...i.history, { at, by: REFLECT_BY, what: `reflect ${runId} undone: ${what}` }].slice(-8)
  await withBrainLock(ref, async () => {
    for (const c of j.created) {
      const s = await getStored(ref, c.id)
      if (s === undefined) { res.conflicts.push({ id: c.id, reason: 'gone' }); continue }
      if (s.item.version !== c.version || s.item.status !== 'active') { res.conflicts.push({ id: c.id, reason: 'changed' }); continue }
      await saveItem(ref, { ...s.item, status: 'deprecated', deprecatedAt: at, version: s.item.version + 1, updated: at, history: history(s.item, 'draft retired') }, s.keep)
      event('retire', c.id, s.item.kind)
      res.retired.push(c.id)
    }
    for (const [id, t] of Object.entries(j.touched)) {
      const curId = t.now ?? id
      const s = await getStored(ref, curId)
      if (s === undefined) { res.conflicts.push({ id, reason: 'gone' }); continue }
      if (s.item.version !== t.version) { res.conflicts.push({ id, reason: 'changed' }); continue }
      const restored: MemItem = { ...s.item, version: s.item.version + 1, updated: at, history: history(s.item, 'restored') }
      if (t.before.tags !== undefined) restored.tags = [...t.before.tags]
      if (t.before.about !== undefined) restored.about = [...t.before.about]
      if (t.before.sources !== undefined) restored.sources = [...t.before.sources]
      if (t.before.summary !== undefined) restored.summary = t.before.summary
      if (t.before.review !== undefined) restored.review = t.before.review
      if (t.before.title !== undefined) restored.title = t.before.title
      if (t.before.body !== undefined) restored.body = t.before.body
      if (t.before.contradictedAt !== undefined) {
        if (t.before.contradictedAt !== '') restored.contradictedAt = t.before.contradictedAt
        if (t.before.contradictedNote !== undefined && t.before.contradictedNote !== '') restored.contradictedNote = t.before.contradictedNote
      }
      if (t.retired === true) {
        restored.status = 'active'
        delete restored.deprecatedAt
      }
      let keep = s.keep
      if (t.retiredInto !== undefined) {
        const { superseded_by: _b, superseded_at: _a, ...rest } = s.keep
        keep = rest
        restored.status = 'active'
        delete restored.supersededBy
        delete restored.supersededAt
      }
      if (t.now !== undefined && t.now !== id) {
        if (await getStored(ref, id) !== undefined) { res.conflicts.push({ id, reason: 'changed' }); continue }
        restored.id = id
        restored.kind = t.before.kind ?? 'capture'
        await saveItem(ref, restored, {})
        await deleteItem(ref, curId)
        await repointMemoryLinks(ref, await listAll(ref), curId, id, at, REFLECT_BY)
      } else {
        if (t.before.kind !== undefined) restored.kind = t.before.kind
        await saveItem(ref, restored, keep)
      }
      event('update', id, restored.kind)
      res.restored.push(id)
    }
  })
  try { unlinkSync(reflectUndoFile(runId)) } catch {  }
  await markReflectUndone(runId, at)
  try {
    await refreshUpkeepFor(ref, { nowMs: now })
    await refreshStatus({ ...(ref.slug !== undefined ? { slug: ref.slug } : {}), nowMs: now, lastWrite: { by: REFLECT_BY } })
  } catch (e) { log('warn', 'memory: upkeep not refreshed after a reflect undo', { error: e }) }
  return res
}


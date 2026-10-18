import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { isLive, type MemItem, type MemReview } from '../core/memory/brain'
import type { Harness } from '../core/events'
import { VERIFY_BUDGET } from '../core/memory/budgets'
import { memClip, memOneLine, redact } from '../core/memory/text'
import {
  parseVerifyAnswer, validateVerdicts, VERIFY_BY, VERIFY_LATER_MS, VERIFY_SETTLED_TRIES, verifyCandidates, verifyPrompt,
  type VerifyCandidate, type VerifyExcerpt, type VerifyVerdict,
} from '../core/memory/verify'
import { atomicWriteSync } from '../engine/fsx'
import { log } from '../engine/log'
import { dirtyFiles, excerptsFor, fitExcerpts, headOf, keyOf, knownFiles } from './evidence'
export { fitExcerpts } from './evidence'
import { appendJob } from './jobs'
import { verifyLockFile, verifyRunsFile, verifyUndoFile, VERIFY_RUN_ID_RE } from './layout'
import { tryLock } from './lock'
import { chooseHarnesses, choiceHoldsRunner, choiceRunner, choiceSkip, choiceWhy } from './model'
import { projectRoot } from './project'
import { RUNNER_TIMEOUT_MS, runnerModelId, type ModelRunner } from './runner'
import { refreshStatus } from './status'
import { brainExists, getStored, listAll, projectRef, recordEvent, saveItem, withBrainLock } from './store'
import { readUpkeep, refreshUpkeepFor } from './sweep'
import { NO_VERIFY_ENV, readVerifyState, writeVerifyState } from './verify-start'

export { NO_VERIFY_ENV } from './verify-start'

export { VERIFY_BY } from '../core/memory/verify'

export type VerifyTrigger = 'session-end' | 'heal' | 'manual' | 'session-start' | 'tick'
export type VerifySkip =
  | 'disabled' | 'no-brain' | 'no-root' | 'no-git' | 'rate-limit' | 'no-harness'
  | 'runner-unavailable' | 'busy' | 'nothing-to-do' | 'runner-failed'

export interface VerifyRunEntry {
  v: 1
  id: string
  at: string
  project: string
  trigger: VerifyTrigger
  harness?: Harness
  model: string
  dryRun?: boolean
  checked: number
  verified: Array<{ id: string, checked: string }>
  contradicted: Array<{ id: string, note: string }>
  unsure: Array<{ id: string, why?: string }>
  rounds: number
  skipped?: VerifySkip
  detail?: string
  undone?: string
  inputChars: number
  outputChars: number
}

export interface VerifyRun extends VerifyRunEntry { logged: boolean }

export interface VerifyOptions {
  trigger: VerifyTrigger
  runner?: ModelRunner
  dryRun?: boolean
  nowMs?: number
  harness?: Harness
  model?: string
  env?: Readonly<Record<string, string | undefined>>
}

const DAY_MS = 86_400_000
const RUNS_KEEP_MS = 30 * DAY_MS
const RUNS_KEEP_LINES = 500
const LOCK_STALE_MS = 10 * 60_000
const PACK_OVERHEAD_CHARS = 1400


function iso(ms: number): string { return new Date(ms).toISOString() }

function newRunId(nowMs: number): string {
  const s = iso(nowMs)
  return `vf-${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11, 19).replace(/:/g, '')}-${randomBytes(2).toString('hex')}`
}

function isEntry(v: unknown): v is VerifyRunEntry {
  if (v === null || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return e['v'] === 1 && typeof e['id'] === 'string' && typeof e['at'] === 'string' && typeof e['project'] === 'string' && Array.isArray(e['verified'])
}

export function readVerifyRuns(): VerifyRunEntry[] {
  let text = ''
  try { text = readFileSync(verifyRunsFile(), 'utf8') } catch { return [] }
  const out: VerifyRunEntry[] = []
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue
    try { const v = JSON.parse(l) as unknown; if (isEntry(v)) out.push(v) } catch {  }
  }
  return out
}

export function listVerifyRuns(limit = 20): VerifyRunEntry[] {
  return readVerifyRuns().reverse().slice(0, limit)
}

function appendVerifyRun(entry: VerifyRunEntry, nowMs: number): boolean {
  try {
    const file = verifyRunsFile()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
    const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
    const atOf = (l: string): number => { try { return Date.parse((JSON.parse(l) as { at?: string }).at ?? '') || 0 } catch { return 0 } }
    const kept = lines.filter(l => nowMs - atOf(l) <= RUNS_KEEP_MS).slice(-RUNS_KEEP_LINES)
    if (kept.length < lines.length) atomicWriteSync(file, kept.join('\n') + '\n', { mode: 0o600 })
    return true
  } catch (e) {
    log('warn', 'memory: a verifier run was not recorded', { error: e })
    return false
  }
}

function markUndone(runId: string, atIso: string): void {
  try {
    const file = verifyRunsFile()
    const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
    atomicWriteSync(file, lines.map(l => {
      try { const v = JSON.parse(l) as unknown; return isEntry(v) && v.id === runId ? JSON.stringify({ ...v, undone: atIso }) : l } catch { return l }
    }).join('\n') + '\n', { mode: 0o600 })
  } catch (e) { log('warn', 'memory: the verifier run log was not marked', { runId, error: e }) }
}

interface UndoEntry {
  version: number
  before: { review: MemReview, verifiedAt?: string, verifiedBy?: string, verifiedCommit?: string, contradictedAt?: string, contradictedNote?: string }
}
interface UndoJournal { v: 1, runId: string, project: string, touched: Record<string, UndoEntry> }

export async function verifyProject(slug: string, opts: VerifyOptions): Promise<VerifyRun> {
  const t0 = Date.now()
  const r = await verifyOnce(slug, opts)
  appendJob({
    job: 'verify', trigger: opts.trigger,
    outcome: r.skipped === undefined ? 'ran' : r.skipped === 'runner-failed' ? 'failed' : 'skipped',
    ...(r.skipped !== undefined ? { reason: r.skipped } : {}),
    ...(r.skipped === undefined ? { detail: `${r.dryRun === true ? 'dry run: ' : ''}${r.verified.length} verified, ${r.contradicted.length} contradicted, ${r.unsure.length} unsure of ${r.checked}` } : r.detail !== undefined ? { detail: r.detail } : {}),
    ...(r.harness !== undefined ? { harness: r.harness } : {}), project: slug, layer: 'project', ms: Date.now() - t0,
  })
  return r
}

async function verifyOnce(slug: string, opts: VerifyOptions): Promise<VerifyRun> {
  const now = opts.nowMs ?? Date.now()
  const cfg = VERIFY_BUDGET
  const env = opts.env ?? process.env
  const model = runnerModelId(opts.model)
  const choice = chooseHarnesses({ ...(opts.harness !== undefined ? { prefer: opts.harness } : {}), ...(model !== undefined ? { model } : {}), nowMs: now, checkCli: opts.runner === undefined })
  const pick = choice.picks[0]
  const run: VerifyRun = {
    v: 1, id: newRunId(now), at: iso(now), project: slug, trigger: opts.trigger,
    ...(pick !== undefined ? { harness: pick.harness } : {}),
    model: pick?.model ?? 'default', ...(opts.dryRun === true ? { dryRun: true } : {}),
    checked: 0, verified: [], contradicted: [], unsure: [], rounds: 0, inputChars: 0, outputChars: 0, logged: false,
  }
  const manual = opts.trigger === 'manual'
  const finish = (skipped?: VerifySkip, detail?: string, logIt = true): VerifyRun => {
    if (skipped !== undefined) run.skipped = skipped
    if (detail !== undefined) run.detail = memClip(memOneLine(redact(detail).text), 300)
    if (logIt) { const { logged: _l, ...entry } = run; run.logged = appendVerifyRun(entry, now) }
    return run
  }
  if (opts.runner === undefined && env[NO_VERIFY_ENV] === '1') return finish('disabled', `${NO_VERIFY_ENV}=1`, false)
  const ref = projectRef(slug)
  if (!brainExists(ref)) return finish('no-brain', 'nothing was written to this brain yet', false)
  const root = projectRoot(slug)
  if (root === undefined) return finish('no-root', 'the project has no known root folder', manual)
  const head = await headOf(root)
  if (head === undefined) return finish('no-git', 'the project is not a git repository (or git did not answer)', manual)
  if (pick === undefined && (opts.runner === undefined || choiceHoldsRunner(choice))) return finish(choiceSkip(choice), choiceWhy(choice), manual)
  const release = tryLock(verifyLockFile(slug), LOCK_STALE_MS, { heartbeat: true })
  if (!release) return finish('busy', 'another verifier run works on this project', manual)
  try {
    return await runLocked()
  } finally {
    release()
  }

  async function runLocked(): Promise<VerifyRun> {
    const items = await listAll(ref)
    const live = items.filter(i => isLive(i, now))
    const queue = (readUpkeep(slug)?.items ?? []).map(u => ({ id: u.id, reasons: [...u.reasons] as string[] }))
    const queued = new Set(queue.map(q => q.id))
    for (const i of live) if (i.review === 'pending' && i.contradictedAt === undefined && !queued.has(i.id)) queue.push({ id: i.id, reasons: ['unverified'] })
    const known = await knownFiles(root as string)
    const dirty = await dirtyFiles(root as string)
    const state = readVerifyState()
    const pool = verifyCandidates({ items, upkeep: queue, nowMs: now, backoff: {}, keys: {}, max: Number.MAX_SAFE_INTEGER })
    const keys: Record<string, string> = {}
    for (const c of pool) keys[c.item.id] = keyOf(root as string, c.item, known)
    const itemById = new Map(items.map(i => [i.id, i]))
    const backoff = Object.fromEntries(Object.entries(state.backoff).filter(([id, e]) => { const i = itemById.get(id); return i === undefined || (i.updated || i.created) <= e.at }))
    const candidates = verifyCandidates({ items, upkeep: queue, nowMs: now, backoff, keys, max: cfg.maxPerRun })
    if (candidates.length === 0) return finish('nothing-to-do', 'no memory waits to be checked against the code', manual)
    type Pack = { candidate: VerifyCandidate, excerpts: VerifyExcerpt[], full: VerifyExcerpt[] }
    const packs: Pack[] = []
    const backOff = (id: string, mode: 'try' | 'settle' | 'later' = 'try'): void => {
      const prev = state.backoff[id]
      const key = keys[id] ?? ''
      const before = prev !== undefined && prev.key === key ? (prev.tries ?? 0) : 0
      const tries = mode === 'later' ? before : mode === 'settle' ? Math.max(before + 1, VERIFY_SETTLED_TRIES) : before + 1
      state.backoff[id] = { at: iso(now), key, head: head!.full, tries, ...(mode === 'later' ? { until: iso(now + VERIFY_LATER_MS) } : {}) }
    }
    for (const c of candidates) {
      const excerpts = await excerptsFor(root as string, c.item, known)
      if (excerpts.length === 0) {
        run.unsure.push({ id: c.item.id, why: 'no evidence: no cited or quoted file found in the repository' })
        backOff(c.item.id, 'settle')
        continue
      }
      packs.push({ candidate: c, excerpts, full: excerpts })
    }
    if (packs.length === 0) {
      if (opts.dryRun !== true) writeVerifyState(state, now)
      return finish(undefined, 'no evidence for any candidate', manual)
    }
    const maxChars = Math.max(4000, cfg.maxInputTokens * 4)
    const runner = opts.runner ?? choiceRunner(choice, {
      nowMs: () => Date.now(),
      onNext: (from, error, to) => {
        log('info', 'memory: a harness CLI failed during the verifier', { slug, from: from.harness, to: to?.harness, error: redact(error).text })
        if (to !== undefined) { run.harness = to.harness; run.model = to.model ?? 'default' }
      },
    })
    const seen = new Set<string>()
    let changed = false
    let pending = packs
    for (let round = 1; round <= VERIFY_SETTLED_TRIES && pending.length > 0; round++) {
      const r = await judge(round, pending)
      if (r.stop !== undefined) {
        if (round === 1) return finish(r.stop.skipped, r.stop.detail, r.stop.logIt)
        run.detail = memClip(memOneLine(redact(`round ${round} stopped${r.stop.skipped !== undefined ? ` (${r.stop.skipped})` : ''}: ${r.stop.detail}`).text), 300)
        break
      }
      changed = changed || r.changed
      pending = r.again
    }
    const last = new Map(run.unsure.map(u => [u.id, u]))
    run.unsure = [...last.values()].filter(u => !run.verified.some(v => v.id === u.id) && !run.contradicted.some(c => c.id === u.id))
    run.checked = seen.size
    if (changed) {
      try {
        await refreshUpkeepFor(ref, { nowMs: now })
        await refreshStatus({ slug, nowMs: now, lastWrite: { by: VERIFY_BY } })
      } catch (e) { log('warn', 'memory: upkeep not refreshed after the verifier', { error: e }) }
    }
    return finish(undefined, run.detail)

    function shareFor(n: number): number {
      return Math.max(600, Math.floor((maxChars * 0.75) / n) - PACK_OVERHEAD_CHARS)
    }

    async function judge(round: number, list: readonly Pack[]): Promise<{ stop?: { skipped?: VerifySkip, detail: string, logIt: boolean }, again: Pack[], changed: boolean }> {
      const share = shareFor(list.length)
      for (const p of list) p.excerpts = fitExcerpts(p.full, share)
      const prompt = verifyPrompt({ project: slug, packs: list, maxChars, maxOutputTokens: cfg.maxOutputTokens })
      for (const id of prompt.shown) seen.add(id)
      run.checked = seen.size
      run.inputChars += prompt.text.length
      if (prompt.shown.length === 0) {
        for (const p of list) run.unsure.push({ id: p.candidate.item.id, why: 'the evidence did not fit the prompt budget' })
        return { stop: { detail: 'no candidate fit the prompt budget', logIt: manual }, again: [], changed: false }
      }
      run.rounds = round
      const out = await runner(prompt.text, { ...(pick?.model !== undefined ? { model: pick.model } : {}), maxOutputTokens: cfg.maxOutputTokens, timeoutMs: RUNNER_TIMEOUT_MS })
      if (!out.ok && out.unavailable === true) { run.rounds = round - 1; return { stop: { skipped: 'runner-unavailable', detail: out.error ?? 'the harness CLI is not on PATH', logIt: manual }, again: [], changed: false } }
      if (!out.ok) { run.rounds = round - 1; return { stop: { skipped: 'runner-failed', detail: out.error ?? 'the model did not answer', logIt: true }, again: [], changed: false } }
      const text = out.text.slice(0, Math.max(4000, cfg.maxOutputTokens * 6))
      run.outputChars += text.length
      const answer = parseVerifyAnswer(text)
      if (answer.length === 0) {
        if (opts.dryRun !== true) {
          for (const id of prompt.shown) backOff(id, 'later')
          writeVerifyState(state, now)
        }
        return { stop: { skipped: 'runner-failed', detail: `the answer held no verdicts, so it counts as no try for any memory: ${memClip(memOneLine(redact(text).text), 160)}`, logIt: true }, again: [], changed: false }
      }
      const shown = new Map(list.filter(p => prompt.shown.includes(p.candidate.item.id)).map(p => [p.candidate.item.id, { item: p.candidate.item, excerpts: p.excerpts }]))
      const v = validateVerdicts(answer, { shown })
      const byId = new Map(v.verdicts.map(x => [x.id, x]))
      const unsure: Array<{ id: string, why?: string }> = []
      for (const id of shown.keys()) if (!byId.has(id)) unsure.push({ id, why: 'no verdict' })
      const holds: Array<{ id: string, checked: string }> = []
      const wrong: Array<{ id: string, note: string }> = []
      const decided: VerifyVerdict[] = []
      const moved: string[] = []
      for (const x of v.verdicts) {
        if (x.verdict === 'unsure') { unsure.push({ id: x.id, ...(x.downgraded !== undefined ? { why: x.downgraded } : x.note !== '' ? { why: x.note } : {}) }); continue }
        const item = shown.get(x.id)?.item
        if (opts.dryRun !== true && item !== undefined && keyOf(root as string, item, known) !== keys[x.id]) {
          unsure.push({ id: x.id, why: 'its files changed during the run' })
          moved.push(x.id)
          continue
        }
        if (x.verdict === 'holds') holds.push({ id: x.id, checked: x.checked })
        else wrong.push({ id: x.id, note: x.note })
        decided.push(x)
      }
      run.unsure.push(...unsure)
      if (opts.dryRun === true) {
        run.verified.push(...holds)
        run.contradicted.push(...wrong)
        return { again: [], changed: false }
      }
      for (const u of unsure) backOff(u.id)
      const size = (xs: readonly VerifyExcerpt[]): number => xs.reduce((n, x) => n + x.text.length, 0)
      const retry = list.filter(p => {
        const id = p.candidate.item.id
        const u = unsure.find(x => x.id === id)
        return u !== undefined && !moved.includes(id) && (state.backoff[id]?.tries ?? 0) < VERIFY_SETTLED_TRIES && (size(p.excerpts) < size(p.full) || u.why === 'no verdict')
      })
      const again = retry.length > 0 && retry.length < list.length ? retry : []
      for (const u of unsure) if (!moved.includes(u.id) && !again.some(p => p.candidate.item.id === u.id) && (state.backoff[u.id]?.tries ?? 0) < VERIFY_SETTLED_TRIES) backOff(u.id, 'settle')
      const marked = new Set([...shown].filter(([, s]) => s.excerpts.some(e => dirty.has(e.file))).map(([id]) => id))
      const applied = await applyVerdicts(decided, shown, marked)
      for (const id of applied.verified) delete state.backoff[id]
      writeVerifyState(state, now)
      run.verified.push(...holds.filter(x => applied.verified.includes(x.id)))
      run.contradicted.push(...wrong.filter(x => applied.contradicted.includes(x.id)))
      return { again, changed: applied.verified.length + applied.contradicted.length > 0 }
    }
  }

  async function applyVerdicts(verdicts: readonly VerifyVerdict[], shown: ReadonlyMap<string, { item: MemItem }>, marked: ReadonlySet<string>): Promise<{ verified: string[], contradicted: string[] }> {
    const res = { verified: [] as string[], contradicted: [] as string[] }
    if (verdicts.length === 0) return res
    const at = iso(now)
    const journal: UndoJournal = { v: 1, runId: run.id, project: slug, touched: {} }
    await withBrainLock(ref, async () => {
      for (const x of verdicts) {
        const seen = shown.get(x.id)?.item
        const cur = await getStored(ref, x.id)
        if (seen === undefined || cur === undefined || cur.item.version !== seen.version) continue
        const i = cur.item
        const before: UndoEntry['before'] = {
          review: i.review, ...(i.verifiedAt !== undefined ? { verifiedAt: i.verifiedAt } : {}), ...(i.verifiedBy !== undefined ? { verifiedBy: i.verifiedBy } : {}),
          ...(i.verifiedCommit !== undefined ? { verifiedCommit: i.verifiedCommit } : {}), ...(i.contradictedAt !== undefined ? { contradictedAt: i.contradictedAt } : {}),
          ...(i.contradictedNote !== undefined ? { contradictedNote: i.contradictedNote } : {}),
        }
        const quoted = [...new Set(x.quotes.map(q => q.file))].slice(0, 3).join(', ')
        const n: MemItem = { ...i, version: i.version + 1, updated: at }
        if (x.verdict === 'holds') {
          n.review = 'ok'
          n.verifiedAt = at
          n.verifiedBy = VERIFY_BY
          n.verifiedCommit = marked.has(x.id) ? `${head!.short}+` : head!.short
          delete n.contradictedAt
          delete n.contradictedNote
          n.history = [...i.history, { at, by: VERIFY_BY, what: memClip(memOneLine(`verify ${run.id}: verified against ${quoted} (${x.checked})`), 200) }].slice(-8)
        } else {
          n.review = 'pending'
          n.contradictedAt = at
          n.contradictedNote = memClip(memOneLine(`${x.note}${quoted !== '' ? ` (${quoted})` : ''}`), 200)
          n.history = [...i.history, { at, by: VERIFY_BY, what: memClip(memOneLine(`verify ${run.id}: contradicted: ${x.note}`), 200) }].slice(-8)
        }
        try {
          await saveItem(ref, n, cur.keep)
        } catch (e) {
          log('warn', 'memory: the verifier could not save a memory', { id: x.id, error: e })
          continue
        }
        journal.touched[x.id] = { version: n.version, before }
        recordEvent({ op: 'update', layer: 'project', project: slug, id: x.id, kind: i.kind, by: VERIFY_BY })
        if (x.verdict === 'holds') res.verified.push(x.id)
        else res.contradicted.push(x.id)
      }
    })
    if (Object.keys(journal.touched).length > 0) {
      try {
        mkdirSync(dirname(verifyUndoFile(run.id)), { recursive: true, mode: 0o700 })
        atomicWriteSync(verifyUndoFile(run.id), JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 })
      } catch (e) { log('warn', 'memory: the verifier undo journal was not written', { error: e }) }
    }
    return res
  }
}

export interface VerifyUndoResult {
  runId: string
  project: string
  restored: string[]
  conflicts: Array<{ id: string, reason: 'changed' | 'gone' }>
}

export async function undoVerify(runId: string, opts: { nowMs?: number } = {}): Promise<VerifyUndoResult> {
  if (!VERIFY_RUN_ID_RE.test(runId)) throw new Error(`not a verify run id: ${JSON.stringify(runId)} (see buracle mem verify --list)`)
  let j: UndoJournal | undefined
  try {
    const v = JSON.parse(readFileSync(verifyUndoFile(runId), 'utf8')) as UndoJournal
    if (v.v === 1 && v.runId === runId && typeof v.touched === 'object') j = v
  } catch {  }
  if (j === undefined) {
    const r = readVerifyRuns().find(e => e.id === runId)
    throw new Error(r === undefined ? `no verifier run ${runId}` : r.undone !== undefined ? `${runId} was undone already (${r.undone})` : `${runId} changed nothing, or its undo journal is gone`)
  }
  const journal = j
  const now = opts.nowMs ?? Date.now()
  const at = iso(now)
  const ref = projectRef(journal.project)
  const res: VerifyUndoResult = { runId, project: journal.project, restored: [], conflicts: [] }
  await withBrainLock(ref, async () => {
    for (const [id, t] of Object.entries(journal.touched)) {
      const s = await getStored(ref, id)
      if (s === undefined) { res.conflicts.push({ id, reason: 'gone' }); continue }
      if (s.item.version !== t.version) { res.conflicts.push({ id, reason: 'changed' }); continue }
      const n: MemItem = { ...s.item, review: t.before.review, version: s.item.version + 1, updated: at, history: [...s.item.history, { at, by: VERIFY_BY, what: `verify ${runId} undone` }].slice(-8) }
      for (const k of ['verifiedAt', 'verifiedBy', 'verifiedCommit', 'contradictedAt', 'contradictedNote'] as const) {
        const b = t.before[k]
        if (b === undefined) delete n[k]
        else n[k] = b
      }
      await saveItem(ref, n, s.keep)
      recordEvent({ op: 'update', layer: 'project', project: journal.project, id, kind: n.kind, by: VERIFY_BY })
      res.restored.push(id)
    }
  })
  try { unlinkSync(verifyUndoFile(runId)) } catch {  }
  markUndone(runId, at)
  try {
    await refreshUpkeepFor(ref, { nowMs: now })
    await refreshStatus({ slug: journal.project, nowMs: now, lastWrite: { by: VERIFY_BY } })
  } catch (e) { log('warn', 'memory: upkeep not refreshed after a verifier undo', { error: e }) }
  return res
}

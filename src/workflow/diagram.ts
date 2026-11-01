// Draws Mermaid diagrams for `buracle diagram` (text) and the review page (SVG). The library runs in
// src/workflow/diagram-worker.ts inside a Bun Worker: its text renderer can loop forever, so every
// job has a time limit and a worker past it is terminated. One batch runs at a time, so at most one
// worker is alive; finished results are cached by the hash of what was drawn.
import { createHash } from 'node:crypto'
import { textWidth } from '../core/status/format'

export const DIAGRAM_TIMEOUT_MS = 5000
export const DIAGRAM_TOTAL_MS = 15000
export const DIAGRAM_MAX_CHARS = 20000
export const SVG_MAX_BYTES = 1_000_000

const CACHE_MAX_ENTRIES = 256
const CACHE_MAX_BYTES = 16_000_000
const TIMEOUT_TTL_MS = 60_000

export type DiagramKind = 'text' | 'svg'
export type FailureReason = 'invalid' | 'too_large' | 'timeout' | 'budget' | 'worker'

export interface TextDrawing { ok: true, kind: 'text', text: string, width: number }
export interface SvgDrawing { ok: true, kind: 'svg', light: string, dark: string }
export interface DiagramFailure { ok: false, reason: FailureReason, error: string }
export type Drawing = TextDrawing | SvgDrawing | DiagramFailure

export interface DrawOptions {
  kind: DiagramKind
  ascii?: boolean
  timeoutMs?: number
  totalMs?: number
}

export interface DiagramJob { id: number, kind: DiagramKind, source: string, ascii: boolean }
export type WorkerReply =
  | { id: number, ok: true, kind: 'text', text: string }
  | { id: number, ok: true, kind: 'svg', light: string, dark: string }
  | { id: number, ok: false, reason: 'invalid' | 'worker', error: string }

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*mermaid\s*$/i

// Strips what agents commonly wrap around the source: a ```mermaid fence, a trailing `;` on the
// header line (`flowchart TD;`) and Windows line ends. Anything else goes to the library as is.
export function normalizeMermaid(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && (lines[0] ?? '').trim() === '') lines.shift()
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop()
  const open = FENCE_OPEN.exec(lines[0] ?? '')
  const mark = open?.[1]
  if (mark !== undefined && lines.length >= 2 && (lines[lines.length - 1] ?? '').trim() === mark) {
    lines.shift()
    lines.pop()
  }
  const header = lines.findIndex(l => l.trim() !== '' && !l.trim().startsWith('%%'))
  if (header >= 0) {
    let h = (lines[header] ?? '').trimEnd()
    if (h.endsWith(';')) h = h.slice(0, -1).trimEnd()
    lines[header] = h
  }
  return lines.join('\n')
}

function seconds(ms: number): string {
  return `${Number((ms / 1000).toFixed(1))} s`
}

function fail(reason: FailureReason, error: string): DiagramFailure {
  return { ok: false, reason, error }
}

interface CacheEntry { value: Drawing, bytes: number, expires?: number }
const cache = new Map<string, CacheEntry>()
let cacheBytes = 0
const inFlight = new Map<string, Promise<Drawing>>()

function cacheKey(kind: DiagramKind, ascii: boolean, source: string): string {
  return createHash('sha256').update(`${kind}\0${ascii ? 1 : 0}\0${source}`).digest('hex')
}

function sizeOf(d: Drawing): number {
  if (!d.ok) return d.error.length
  return d.kind === 'text' ? d.text.length : d.light.length + d.dark.length
}

function cached(key: string, nowMs: number): Drawing | undefined {
  const hit = cache.get(key)
  if (hit === undefined) return undefined
  if (hit.expires !== undefined && hit.expires <= nowMs) {
    cache.delete(key)
    cacheBytes -= hit.bytes
    return undefined
  }
  cache.delete(key)
  cache.set(key, hit)
  return hit.value
}

// Only results that were really drawn are kept: a drawing, a library error, a drawing too large to
// show, or this source's own timeout (for a minute). A budget skip or a worker failure says nothing
// about the source.
function remember(key: string, value: Drawing, nowMs: number): void {
  if (!value.ok && value.reason !== 'invalid' && value.reason !== 'too_large' && value.reason !== 'timeout') return
  const old = cache.get(key)
  if (old !== undefined) { cache.delete(key); cacheBytes -= old.bytes }
  const entry: CacheEntry = { value, bytes: sizeOf(value) }
  if (!value.ok && value.reason === 'timeout') entry.expires = nowMs + TIMEOUT_TTL_MS
  cache.set(key, entry)
  cacheBytes += entry.bytes
  for (const [k, e] of cache) {
    if (cache.size <= CACHE_MAX_ENTRIES && cacheBytes <= CACHE_MAX_BYTES) break
    cache.delete(k)
    cacheBytes -= e.bytes
  }
}

class WorkerSlot {
  private worker: Worker | undefined
  private nextId = 1

  private open(): Worker {
    this.worker ??= new Worker(new URL('./diagram-worker.ts', import.meta.url).href)
    return this.worker
  }

  close(): void {
    this.worker?.terminate()
    this.worker = undefined
  }

  // Resolves with the worker's reply, or with a failure when the limit passes or the worker breaks;
  // a worker that timed out or broke is terminated, so the next job gets a fresh one.
  run(job: Omit<DiagramJob, 'id'>, limitMs: number, onLimit: () => DiagramFailure): Promise<WorkerReply | DiagramFailure> {
    let worker: Worker
    try {
      worker = this.open()
    } catch (err) {
      return Promise.resolve(fail('worker', `cannot start the diagram worker: ${err instanceof Error ? err.message : String(err)}`))
    }
    const id = this.nextId++
    return new Promise(resolve => {
      const done = (r: WorkerReply | DiagramFailure, broken: boolean) => {
        clearTimeout(timer)
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        worker.removeEventListener('close', onClose)
        if (broken) this.close()
        resolve(r)
      }
      const onMessage = (e: MessageEvent<WorkerReply>) => { if (e.data.id === id) done(e.data, false) }
      const onError = (e: Event) => done(fail('worker', `the diagram worker failed: ${(e as ErrorEvent).message ?? 'unknown error'}`), true)
      const onClose = () => done(fail('worker', 'the diagram worker exited early'), true)
      const timer = setTimeout(() => done(onLimit(), true), limitMs)
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.addEventListener('close', onClose)
      worker.postMessage({ ...job, id })
    })
  }
}

let queue: Promise<unknown> = Promise.resolve()

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

function toDrawing(r: WorkerReply | DiagramFailure): Drawing {
  if (!r.ok) return 'id' in r ? fail(r.reason, r.error) : r
  if (r.kind === 'text') return { ok: true, kind: 'text', text: r.text, width: Math.max(0, ...r.text.split('\n').map(textWidth)) }
  if (r.light.length > SVG_MAX_BYTES || r.dark.length > SVG_MAX_BYTES) return fail('too_large', 'the drawing is larger than 1 MB')
  return { ok: true, kind: 'svg', light: r.light, dark: r.dark }
}

async function drawBatch(jobs: ReadonlyArray<{ key: string, source: string }>, o: Required<DrawOptions>, settle: (key: string, d: Drawing) => void): Promise<void> {
  const slot = new WorkerSlot()
  const started = performance.now()
  try {
    for (const job of jobs) {
      const left = o.totalMs - (performance.now() - started)
      const budget = () => fail('budget', `not drawn: the drawing budget of ${seconds(o.totalMs)} for this batch ran out`)
      if (left <= 0) { settle(job.key, budget()); continue }
      const own = left >= o.timeoutMs
      const limitMs = own ? o.timeoutMs : left
      const reply = await slot.run({ kind: o.kind, source: job.source, ascii: o.ascii }, limitMs, () =>
        own ? fail('timeout', `the drawing did not finish within ${seconds(o.timeoutMs)}; split the diagram into smaller ones`) : budget())
      settle(job.key, toDrawing(reply))
    }
  } finally {
    slot.close()
  }
}

// The one entry point that runs the library: draws each source in order in one worker, replacing a
// worker that stalls, within `timeoutMs` per source and `totalMs` for the whole batch.
export async function drawDiagrams(sources: readonly string[], opts: DrawOptions): Promise<Drawing[]> {
  const o: Required<DrawOptions> = { kind: opts.kind, ascii: opts.ascii === true, timeoutMs: opts.timeoutMs ?? DIAGRAM_TIMEOUT_MS, totalMs: opts.totalMs ?? DIAGRAM_TOTAL_MS }
  const out: Array<Drawing | Promise<Drawing>> = []
  const jobs: Array<{ key: string, source: string }> = []
  const waiting = new Map<string, (d: Drawing) => void>()
  for (const raw of sources) {
    // A raw source far past the limit is refused before anything walks it (stdin has no size cap).
    if (raw.length > 2 * DIAGRAM_MAX_CHARS) { out.push(fail('too_large', `the diagram source is ${raw.length} characters; the limit is ${DIAGRAM_MAX_CHARS}`)); continue }
    const source = normalizeMermaid(raw)
    if (source.trim() === '') { out.push(fail('invalid', 'Empty mermaid diagram')); continue }
    if (source.length > DIAGRAM_MAX_CHARS) { out.push(fail('too_large', `the diagram source is ${source.length} characters; the limit is ${DIAGRAM_MAX_CHARS}`)); continue }
    const key = cacheKey(o.kind, o.ascii, source)
    const hit = cached(key, Date.now())
    if (hit !== undefined) { out.push(hit); continue }
    const pending = inFlight.get(key)
    if (pending !== undefined) { out.push(pending); continue }
    const promise = new Promise<Drawing>(resolve => waiting.set(key, resolve))
    inFlight.set(key, promise)
    out.push(promise)
    jobs.push({ key, source })
  }
  if (jobs.length > 0) {
    const settle = (key: string, d: Drawing) => {
      remember(key, d, Date.now())
      inFlight.delete(key)
      waiting.get(key)?.(d)
      waiting.delete(key)
    }
    await serial(() => drawBatch(jobs, o, settle)).catch((err: unknown) => {
      for (const key of [...waiting.keys()]) settle(key, fail('worker', `the diagram worker failed: ${err instanceof Error ? err.message : String(err)}`))
    })
  }
  return Promise.all(out)
}

export async function drawDiagram(source: string, opts: { ascii?: boolean, timeoutMs?: number }): Promise<TextDrawing | DiagramFailure> {
  const [r] = await drawDiagrams([source], { kind: 'text', ascii: opts.ascii === true, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) })
  if (r === undefined) return fail('worker', 'no drawing came back')
  return r.ok && r.kind === 'svg' ? fail('worker', 'unexpected SVG drawing') : r
}

export async function diagramSvgs(sources: readonly string[], opts: { timeoutMs?: number, totalMs?: number } = {}): Promise<Array<SvgDrawing | DiagramFailure>> {
  const out = await drawDiagrams(sources, { kind: 'svg', ...opts })
  return out.map(r => (r.ok && r.kind === 'text' ? fail('worker', 'unexpected text drawing') : r))
}

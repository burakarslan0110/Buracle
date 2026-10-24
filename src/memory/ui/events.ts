import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { isMemId, isMemKind, regionOf, type MemKind, type MemLayer, type MemRegion } from '../../core/memory/brain'
import { memIsSlug } from '../../core/memory/note'
import { personRegionOfKind, type PersonRegion } from '../../core/memory/person-brain'
import { eventsFile } from '../layout'
import type { BrainOp } from '../store'
import type { UiScope } from './api'

const OPS: ReadonlySet<string> = new Set<BrainOp>(['write', 'update', 'retire', 'delete', 'recall', 'import'])
const MAX_CHUNK = 256 * 1024

export interface UiEvent {
  at: string
  op: BrainOp
  layer: MemLayer
  project?: string
  id?: string
  kind?: MemKind
  region?: MemRegion | PersonRegion
  ids?: string[]
  n?: number
  by?: string
}

const BY_RE = /^[a-z][a-z0-9-]{0,39}$/

export function parseEventLine(line: string): UiEvent | undefined {
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return undefined }
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r['op'] !== 'string' || !OPS.has(r['op']) || (r['layer'] !== 'project' && r['layer'] !== 'person')) return undefined
  const e: UiEvent = { at: typeof r['at'] === 'string' ? r['at'].slice(0, 40) : '', op: r['op'] as BrainOp, layer: r['layer'] }
  if (memIsSlug(r['project'])) e.project = r['project']
  if (isMemId(r['id'])) e.id = r['id']
  if (isMemKind(r['kind'])) {
    e.kind = r['kind']
    const region = e.layer === 'person' ? personRegionOfKind(r['kind']) : regionOf(r['kind'])
    if (region !== undefined) e.region = region
  }
  if (Array.isArray(r['ids'])) e.ids = r['ids'].filter(isMemId).slice(0, 20)
  if (typeof r['n'] === 'number' && Number.isFinite(r['n'])) e.n = r['n']
  if (typeof r['by'] === 'string' && BY_RE.test(r['by'])) e.by = r['by']
  return e
}

export function eventInScope(e: UiEvent, scope: UiScope): boolean {
  return scope.kind === 'person' ? e.layer === 'person' : e.layer === 'project' && e.project === scope.slug
}

function fileSize(file: string): number {
  try { return statSync(file).size } catch { return 0 }
}

export interface EventStreamOptions { pollMs?: number, pingMs?: number }

export function eventStream(req: Request, scope: UiScope, opts: EventStreamOptions = {}): Response {
  const file = eventsFile()
  const resume = Number(req.headers.get('last-event-id') ?? new URL(req.url).searchParams.get('since') ?? Number.NaN)
  let offset = Number.isInteger(resume) && resume >= 0 ? resume : fileSize(file)
  const enc = new TextEncoder()
  const timers: Array<ReturnType<typeof setInterval>> = []
  let closed = false
  const stop = () => {
    closed = true
    for (const t of timers) clearInterval(t)
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        if (closed) return
        try { controller.enqueue(enc.encode(s)) } catch { stop() }
      }
      const tick = () => {
        const size = fileSize(file)
        if (size < offset) offset = 0
        if (size === offset) return
        const len = Math.min(size - offset, MAX_CHUNK)
        const buf = Buffer.alloc(len)
        let fd: number | undefined
        try {
          fd = openSync(file, 'r')
          readSync(fd, buf, 0, len, offset)
        } catch {
          return
        } finally {
          if (fd !== undefined) closeSync(fd)
        }
        const last = buf.lastIndexOf(10)
        if (last < 0) {
          if (len === MAX_CHUNK) offset += len
          return
        }
        let pos = 0
        while (pos <= last) {
          const nl = buf.indexOf(10, pos)
          const e = parseEventLine(buf.subarray(pos, nl).toString('utf8'))
          pos = nl + 1
          if (e !== undefined && eventInScope(e, scope)) send(`id: ${offset + pos}\nevent: brain\ndata: ${JSON.stringify(e)}\n\n`)
        }
        offset += last + 1
      }
      send(`retry: 3000\n: buracle brain events for ${scope.key}\n\n`)
      tick()
      const poll = setInterval(tick, opts.pollMs ?? 1000)
      const ping = setInterval(() => send(': ping\n\n'), opts.pingMs ?? 20_000)
      for (const t of [poll, ping]) {
        t.unref?.()
        timers.push(t)
      }
      req.signal.addEventListener('abort', () => {
        stop()
        try { controller.close() } catch {  }
      })
    },
    cancel() { stop() },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
}

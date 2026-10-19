import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../core/events'
import { memCaptureOff, SPOOL_LIMITS, spoolFileMatches, spoolFileName, spoolLine, spoolParse, spoolSanitize, type SpoolEntry } from '../core/memory/spool'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { isValidSessionId } from '../engine/paths'
import { log } from '../engine/log'
import { redactionsFile, sessionRecordFile, spoolDir, spoolDoneDir } from './layout'

export type { SpoolEntry } from '../core/memory/spool'

export function captureOff(): boolean {
  return memCaptureOff(process.env)
}

export function recordRedactions(count: number, kinds: string[], where: string, nowMs = Date.now()): void {
  if (count <= 0) return
  try {
    const file = redactionsFile()
    mkdirSync(join(file, '..'), { recursive: true })
    appendFileSync(file, JSON.stringify({ ts: nowMs, count, kinds, where }) + '\n', { mode: 0o600 })
  } catch (e) {
    log('warn', 'memory: cannot record redactions', { error: e })
  }
}

export function pruneRedactions(nowMs = Date.now()): void {
  try {
    const file = redactionsFile()
    if (statSync(file).size < 256 * 1024) return
    const keep = readFileSync(file, 'utf8').split('\n').filter(line => {
      try { return (JSON.parse(line) as { ts?: number }).ts! >= nowMs - 48 * 3600_000 } catch { return false }
    })
    atomicWriteSync(file, keep.length > 0 ? keep.join('\n') + '\n' : '')
  } catch {  }
}

export function redactionsSince(sinceMs: number): number {
  try {
    let total = 0
    for (const line of readFileSync(redactionsFile(), 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const r = JSON.parse(line) as { ts?: number, count?: number }
        if (typeof r.ts === 'number' && r.ts >= sinceMs && typeof r.count === 'number') total += r.count
      } catch {  }
    }
    return total
  } catch {
    return 0
  }
}

function sessionExcluded(h: Harness, sid: string): boolean {
  const r = readJsonSafeSync<{ excluded?: unknown }>(sessionRecordFile(h, sid))
  return r.ok && r.value !== null && typeof r.value === 'object' && r.value.excluded === true
}

export function appendSpool(h: Harness, sid: string, entries: SpoolEntry[], opts: { suffix?: string } = {}): void {
  try {
    if (captureOff()) return
    if (!isValidSessionId(sid)) { log('warn', 'memory: spool append without a valid session id', { h }); return }
    if (sessionExcluded(h, sid)) return
    if (!Array.isArray(entries) || entries.length === 0) return
    const dir = spoolDir()
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, spoolFileName(h, sid, opts.suffix))
    let size = 0
    try { size = statSync(file).size } catch {  }
    let text = ''
    let redacted = 0
    const kinds = new Set<string>()
    for (const raw of entries) {
      const { entry, redactions } = spoolSanitize(raw)
      if (!entry) continue
      redacted += redactions.count
      for (const k of redactions.kinds) kinds.add(k)
      const line = spoolLine(entry)
      const projected = size + text.length + line.length
      if (projected > SPOOL_LIMITS.hardFileBytes) break
      if (projected > SPOOL_LIMITS.softFileBytes && (entry.ev === 'tool' || entry.ev === 'prompt')) continue
      text += line
    }
    if (text !== '') appendFileSync(file, text, { mode: 0o600 })
    recordRedactions(redacted, [...kinds].sort(), 'spool')
  } catch (e) {
    log('warn', 'memory: spool append failed', { h, sid, error: e })
  }
}

export function spoolFiles(h: Harness, sid: string): { active: string[], done: string[] } {
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter(n => spoolFileMatches(n, h, sid)).sort().map(n => join(dir, n))
    } catch {
      return []
    }
  }
  return { active: list(spoolDir()), done: list(spoolDoneDir()) }
}

export function deleteSpool(h: Harness, sid: string): void {
  const { active, done } = spoolFiles(h, sid)
  for (const f of [...active, ...done]) {
    try { unlinkSync(f) } catch (e) { if ((e as { code?: string }).code !== 'ENOENT') log('warn', 'memory: cannot delete spool file', { f, error: e }) }
  }
}

export function activeSpoolFiles(h: Harness, sids: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let names: string[]
  try { names = readdirSync(spoolDir()) } catch { return out }
  for (const n of names.sort()) {
    if (!n.startsWith(`${h}-`) || !n.endsWith('.jsonl')) continue
    const rest = n.slice(h.length + 1, -'.jsonl'.length)
    for (let i = rest.length; i > 0; i = rest.lastIndexOf('-', i - 1)) {
      const sid = rest.slice(0, i)
      if (sids.has(sid)) out.set(sid, [...(out.get(sid) ?? []), join(spoolDir(), n)])
    }
  }
  return out
}

export function readSpool(h: Harness, sid: string): SpoolEntry[] {
  const { active, done } = spoolFiles(h, sid)
  const out: SpoolEntry[] = []
  for (const f of [...done, ...active]) {
    try { out.push(...spoolParse(readFileSync(f, 'utf8'))) } catch {  }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

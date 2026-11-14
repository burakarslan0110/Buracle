import { sanitizePromptSignal, type PromptSignal } from './signals'
import { redactClip } from './redact'

export interface SpoolEntry { ts: number; ev: 'prompt'|'turn'|'compact'|'stop'|'note'|'prompt-signal'; tool?: string; paths?: string[]; excerpt?: string; model?: string; tokens?: number; signal?: PromptSignal }

export const SPOOL_EVENTS: readonly SpoolEntry['ev'][] = ['prompt', 'turn', 'compact', 'stop', 'note', 'prompt-signal']

export const EXCERPT_EVENTS: readonly SpoolEntry['ev'][] = ['prompt', 'turn', 'stop', 'compact', 'note']


export const NO_CAPTURE_ENV = 'BURACLE_NO_CAPTURE'

export function memCaptureOff(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[NO_CAPTURE_ENV] === '1'
}

export const SPOOL_LIMITS = {
  excerpt: 2000,
  promptExcerpt: 800,
  compactExcerpt: 8000,
  paths: 50,
  path: 600,
  tool: 128,
  model: 128,
  softFileBytes: 4 * 1024 * 1024,
  hardFileBytes: 8 * 1024 * 1024,
} as const

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

function finite(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

export function spoolSanitize(input: unknown): { entry?: SpoolEntry, redactions: { count: number, kinds: string[] } } {
  const none = { count: 0, kinds: [] as string[] }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { redactions: none }
  const x = input as Record<string, unknown>
  const ts = finite(x['ts'])
  const ev = x['ev']
  if (ts === undefined || typeof ev !== 'string' || !(SPOOL_EVENTS as readonly string[]).includes(ev)) return { redactions: none }
  const entry: SpoolEntry = { ts: Math.round(ts), ev: ev as SpoolEntry['ev'] }
  let count = 0
  const kinds = new Set<string>()
  const scrub = (s: string, max: number): string => {
    const r = redactClip(s, max)
    count += r.count
    for (const k of r.kinds) kinds.add(k)
    return r.text
  }
  if (typeof x['tool'] === 'string' && x['tool'] !== '') entry.tool = clip(x['tool'], SPOOL_LIMITS.tool)
  if (Array.isArray(x['paths'])) {
    const ps = x['paths'].filter((p): p is string => typeof p === 'string' && p !== '').slice(0, SPOOL_LIMITS.paths).map(p => clip(p, SPOOL_LIMITS.path))
    if (ps.length > 0) entry.paths = ps
  }
  if (typeof x['excerpt'] === 'string' && x['excerpt'] !== '' && (EXCERPT_EVENTS as readonly string[]).includes(ev)) {
    const max = ev === 'compact' ? SPOOL_LIMITS.compactExcerpt : ev === 'prompt' ? SPOOL_LIMITS.promptExcerpt : SPOOL_LIMITS.excerpt
    entry.excerpt = scrub(x['excerpt'], max)
  }
  if (ev === 'prompt-signal') {
    const signal = sanitizePromptSignal(x['signal'], scrub)
    if (!signal) return { redactions: { count, kinds: [...kinds].sort() } }
    entry.signal = signal
  }
  if (typeof x['model'] === 'string' && x['model'] !== '') entry.model = clip(x['model'], SPOOL_LIMITS.model)
  const tokens = finite(x['tokens'])
  if (tokens !== undefined && tokens >= 0) entry.tokens = Math.round(tokens)
  return { entry, redactions: { count, kinds: [...kinds].sort() } }
}

export function spoolPromptExcerpt(text: string): string | undefined {
  const t = text.trim()
  return t === '' || t.startsWith('<') ? undefined : t
}

export function spoolLine(entry: SpoolEntry): string {
  return JSON.stringify(entry) + '\n'
}

export function spoolParse(text: string): SpoolEntry[] {
  const out: SpoolEntry[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    let v: unknown
    try { v = JSON.parse(t) } catch { continue }
    const { entry } = spoolSanitize(v)
    if (entry) out.push(entry)
  }
  return out
}

export function spoolFileName(harness: string, sid: string, suffix?: string): string {
  const s = suffix !== undefined && suffix !== '' ? `-${suffix.replace(/[^A-Za-z0-9._:-]/g, '_')}` : ''
  return `${harness}-${sid}${s}.jsonl`
}

export function spoolFileMatches(name: string, harness: string, sid: string): boolean {
  const base = `${harness}-${sid}`
  if (!name.endsWith('.jsonl') || !name.startsWith(base)) return false
  const rest = name.slice(base.length, -'.jsonl'.length)
  return rest === '' || rest.startsWith('-')
}

export interface SpoolDigest {
  startedMs?: number
  endedMs?: number
  compactions: Array<{ ts: number, trigger?: string, summary: string }>
  finalMessage?: string
  model?: string
  tokens: number
  turns: number
  prompts: number
  notes: string[]
  userPrompts: Array<{ ts: number, text: string }>
  signals: Array<{ ts: number, signal: PromptSignal }>
}

export const SPOOL_DIGEST_PROMPTS = 40

export function spoolIsEmptySession(d: SpoolDigest): boolean {
  return d.compactions.length === 0 && d.finalMessage === undefined && d.tokens === 0
}

export function spoolDigest(entries: readonly SpoolEntry[]): SpoolDigest {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts)
  const d: SpoolDigest = { compactions: [], tokens: 0, turns: 0, prompts: 0, notes: [], userPrompts: [], signals: [] }
  let lastMsgTs = -Infinity
  for (const e of sorted) {
    if (d.startedMs === undefined || e.ts < d.startedMs) d.startedMs = e.ts
    if (d.endedMs === undefined || e.ts > d.endedMs) d.endedMs = e.ts
    if (e.model !== undefined) d.model = e.model
    if (e.tokens !== undefined) d.tokens += e.tokens
    switch (e.ev) {
      case 'prompt':
        d.prompts++
        if (e.excerpt !== undefined) d.userPrompts.push({ ts: e.ts, text: e.excerpt })
        break
      case 'turn':
      case 'stop':
        if (e.ev === 'turn') d.turns++
        if (e.excerpt !== undefined && e.ts >= lastMsgTs) { d.finalMessage = e.excerpt; lastMsgTs = e.ts }
        break
      case 'compact':
        if (e.excerpt !== undefined) {
          const c: { ts: number, trigger?: string, summary: string } = { ts: e.ts, summary: e.excerpt }
          if (e.tool !== undefined) c.trigger = e.tool
          d.compactions.push(c)
        }
        break
      case 'note':
        if (e.excerpt !== undefined && !d.notes.includes(e.excerpt)) d.notes.push(e.excerpt)
        for (const p of e.paths ?? []) if (!d.notes.includes(p)) d.notes.push(p)
        break
      case 'prompt-signal':
        if (e.signal !== undefined && d.signals.length < 500) d.signals.push({ ts: e.ts, signal: e.signal })
        break
    }
  }
  d.userPrompts = d.userPrompts.slice(-SPOOL_DIGEST_PROMPTS)
  return d
}

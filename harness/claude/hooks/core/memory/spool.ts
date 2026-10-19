import type { ToolKind } from '../events'
import { profileSanitizeSignal, type ProfileSignal } from './profile'
import { redactClip } from './text'

export interface SpoolEntry { ts: number; ev: 'prompt'|'tool'|'turn'|'compact'|'stop'|'note'|'signal'; tool?: string; kind?: ToolKind; paths?: string[]; cmd?: string; exit?: number; ms?: number; excerpt?: string; model?: string; tokens?: number; signal?: ProfileSignal }

export const SPOOL_EVENTS: readonly SpoolEntry['ev'][] = ['prompt', 'tool', 'turn', 'compact', 'stop', 'note', 'signal']

export const EXCERPT_EVENTS: readonly SpoolEntry['ev'][] = ['prompt', 'turn', 'stop', 'compact', 'note']

const TOOL_KINDS: readonly ToolKind[] = ['bash', 'edit', 'write', 'patch', 'read', 'search', 'web_search', 'web_fetch',
  'ask_user', 'plan_exit', 'plan_enter', 'todo', 'agent', 'mcp', 'other']

export const NO_CAPTURE_ENV = 'BURACLE_NO_CAPTURE'

export function memCaptureOff(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[NO_CAPTURE_ENV] === '1'
}

export const SPOOL_LIMITS = {
  excerpt: 2000,
  promptExcerpt: 800,
  compactExcerpt: 8000,
  cmd: 600,
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
  if (typeof x['kind'] === 'string' && (TOOL_KINDS as readonly string[]).includes(x['kind'])) entry.kind = x['kind'] as ToolKind
  if (Array.isArray(x['paths'])) {
    const ps = x['paths'].filter((p): p is string => typeof p === 'string' && p !== '').slice(0, SPOOL_LIMITS.paths).map(p => clip(p, SPOOL_LIMITS.path))
    if (ps.length > 0) entry.paths = ps
  }
  if (typeof x['cmd'] === 'string' && x['cmd'] !== '') entry.cmd = scrub(x['cmd'], SPOOL_LIMITS.cmd)
  const exit = finite(x['exit'])
  if (exit !== undefined) entry.exit = Math.trunc(exit)
  const ms = finite(x['ms'])
  if (ms !== undefined && ms >= 0) entry.ms = Math.round(ms)
  if (typeof x['excerpt'] === 'string' && x['excerpt'] !== '' && (EXCERPT_EVENTS as readonly string[]).includes(ev)) {
    const max = ev === 'compact' ? SPOOL_LIMITS.compactExcerpt : ev === 'prompt' ? SPOOL_LIMITS.promptExcerpt : SPOOL_LIMITS.excerpt
    entry.excerpt = scrub(x['excerpt'], max)
  }
  if (ev === 'signal') {
    const signal = profileSanitizeSignal(x['signal'], scrub)
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
  files: string[]
  commands: number
  tests: { runs: number, failures: number }
  failures: Array<{ cmd: string, exit: number }>
  gitCommits: number
  compactions: Array<{ ts: number, trigger?: string, summary: string }>
  finalMessage?: string
  model?: string
  tokens: number
  turns: number
  prompts: number
  tools: number
  notes: string[]
  userPrompts: Array<{ ts: number, text: string }>
  lastTestExit?: number
  toolCounts: Record<string, number>
  commandHeads: Record<string, number>
  signals: Array<{ ts: number, signal: ProfileSignal }>
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export const SPOOL_DIGEST_PROMPTS = 40

const TEST_RE = /(?:^|[\s;&|(])(?:bun\s+test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test|npx\s+(?:vitest|jest)|vitest|jest|pytest|python3?\s+-m\s+pytest|go\s+test|cargo\s+test|deno\s+test|make\s+test|rspec|phpunit|mix\s+test|dotnet\s+test|gradle\s+test|mvn\s+test|swift\s+test)\b/
const GIT_COMMIT_RE = /(?:^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?commit\b/

export function spoolIsTestCommand(cmd: string): boolean {
  return TEST_RE.test(cmd)
}

export function spoolCommandHeads(cmd: string): string[] {
  const out: string[] = []
  for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
    const words = seg.trim().split(/\s+/).filter(w => w !== '')
    while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string) || ['sudo', 'env', 'time', 'exec', 'command'].includes(words[0] as string))) words.shift()
    if (words.length === 0) continue
    const head = words.slice(0, 2).join(' ').toLowerCase()
    if (/^[a-z0-9./_-]/.test(head)) out.push(head.slice(0, 60))
  }
  return out
}

function relTo(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path
  const base = cwd.replace(/[\\/]+$/, '')
  return path.length > base.length + 1 && path.startsWith(base) && (path[base.length] === '/' || path[base.length] === '\\') ? path.slice(base.length + 1) : path
}

export function spoolIsEmptySession(d: SpoolDigest): boolean {
  return d.tools === 0 && d.commands === 0 && d.files.length === 0 && d.compactions.length === 0 && d.finalMessage === undefined && d.tokens === 0
}

export function spoolDigest(entries: readonly SpoolEntry[], cwd?: string): SpoolDigest {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts)
  const d: SpoolDigest = {
    files: [], commands: 0, tests: { runs: 0, failures: 0 }, failures: [], gitCommits: 0, compactions: [],
    tokens: 0, turns: 0, prompts: 0, tools: 0, notes: [], userPrompts: [], toolCounts: {}, commandHeads: {}, signals: [],
  }
  const files = new Map<string, number>()
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
      case 'tool': {
        d.tools++
        if (e.tool !== undefined && !UNSAFE_KEYS.has(e.tool) && (Object.hasOwn(d.toolCounts, e.tool) || Object.keys(d.toolCounts).length < 200)) d.toolCounts[e.tool] = (d.toolCounts[e.tool] ?? 0) + 1
        if (e.kind === 'edit' || e.kind === 'write' || e.kind === 'patch') {
          for (const p of e.paths ?? []) { files.delete(p); files.set(p, e.ts) }
        }
        if (e.cmd !== undefined) {
          d.commands++
          for (const head of spoolCommandHeads(e.cmd)) {
            if (!UNSAFE_KEYS.has(head) && (Object.hasOwn(d.commandHeads, head) || Object.keys(d.commandHeads).length < 100)) d.commandHeads[head] = (d.commandHeads[head] ?? 0) + 1
          }
          const failed = e.exit !== undefined && e.exit !== 0
          if (spoolIsTestCommand(e.cmd)) {
            d.tests.runs++
            if (failed) d.tests.failures++
            if (e.exit !== undefined) d.lastTestExit = e.exit
          }
          if (GIT_COMMIT_RE.test(e.cmd) && !failed) d.gitCommits++
          if (failed) d.failures.push({ cmd: e.cmd, exit: e.exit as number })
        }
        break
      }
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
      case 'signal':
        if (e.signal !== undefined && d.signals.length < 500) d.signals.push({ ts: e.ts, signal: e.signal })
        break
    }
  }
  d.files = [...files.keys()].map(p => relTo(p, cwd))
  d.failures = d.failures.slice(-10)
  d.userPrompts = d.userPrompts.slice(-SPOOL_DIGEST_PROMPTS)
  return d
}

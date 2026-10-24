import type { SpoolDigest } from './spool'
import { memLocalDate, memLocalTime } from './note'
import { memClip, memOneLine, memShortSid } from './text'

export interface MemSessionRecord {
  v: 1
  harness: string
  sid: string
  cwd: string
  slug?: string
  excluded?: boolean
  memoryId?: string
  startedMs: number
  branch?: string
  commitStart?: string
  status: 'active' | 'ended'
  finalizedMs?: number
  stats?: MemSessionStats
  capture?: MemCaptureState
}

/**
 * Where the model-assisted capture of a session stands. It lives in the session record, never in the brain: a
 * failed or held model call leaves the brain untouched and only marks the session for another try.
 */
export interface MemCaptureState {
  state: 'done' | 'retry' | 'gave-up'
  /** Model calls that failed or returned an invalid reply. */
  tries: number
  lastTryMs?: number
  /** Digest of the material the last successful distillation read. */
  sha?: string
  detail?: string
}

export interface MemSessionStats {
  endedMs?: number
  prompts: number
  turns: number
  tools: number
  commands: number
  files: number
  tests: number
  testFailures: number
  tokens?: number
  model?: string
  commits?: number
  filesChanged?: number
  insertions?: number
  deletions?: number
  topTools?: Array<[string, number]>
}

export function memDiffstatCounts(stat: string | undefined): { filesChanged?: number, insertions?: number, deletions?: number } {
  const out: { filesChanged?: number, insertions?: number, deletions?: number } = {}
  if (stat === undefined) return out
  const files = /(\d+) files? changed/.exec(stat)
  const ins = /(\d+) insertions?\(\+\)/.exec(stat)
  const del = /(\d+) deletions?\(-\)/.exec(stat)
  if (files?.[1] !== undefined) out.filesChanged = Number(files[1])
  if (ins?.[1] !== undefined) out.insertions = Number(ins[1])
  if (del?.[1] !== undefined) out.deletions = Number(del[1])
  return out
}

export const MEM_SESSION_TOP_TOOLS = 8

export function memSessionStats(d: SpoolDigest, git?: { commits: number, diffstat?: string }): MemSessionStats {
  const s: MemSessionStats = {
    prompts: d.prompts, turns: d.turns, tools: d.tools, commands: d.commands, files: d.files.length,
    tests: d.tests.runs, testFailures: d.tests.failures,
  }
  if (d.endedMs !== undefined) s.endedMs = d.endedMs
  if (d.tokens > 0) s.tokens = d.tokens
  if (d.model !== undefined) s.model = d.model
  if (git !== undefined) Object.assign(s, { commits: git.commits }, memDiffstatCounts(git.diffstat))
  const top = Object.entries(d.toolCounts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MEM_SESSION_TOP_TOOLS)
  if (top.length > 0) s.topTools = top
  return s
}

export function memSessionMemoryId(noteHarness: string, sid: string): string {
  return `session-${noteHarness.replace(/[^a-z0-9-]/g, '-')}-${memShortSid(sid)}`
}

function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function memSessionAreas(files: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const f of files) {
    if (f.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f)) continue
    const segs = f.split('/').filter(x => x !== '' && x !== '.')
    const area = segs.length >= 3 ? `${segs[0]}/${segs[1]}` : segs.length === 2 ? segs[0] : undefined
    if (area !== undefined) counts.set(area, (counts.get(area) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a)
}

export function memSessionOutcome(d: SpoolDigest | undefined, extra: { commits?: string[] } = {}): string | undefined {
  if (d === undefined) return undefined
  const parts: string[] = []
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
  if (d.files.length > 0) {
    const areas = memSessionAreas(d.files).slice(0, 3)
    parts.push(`changed ${plural(d.files.length, 'file')}${areas.length > 0 ? ` (${areas.join(', ')})` : ''}`)
  }
  if (d.tests.runs > 0) {
    const last = d.lastTestExit === undefined ? '' : d.lastTestExit === 0 ? ', the last one passed' : ', the last one failed'
    parts.push(`ran tests ${d.tests.runs === 1 ? 'once' : `${d.tests.runs} times`}${last}`)
  }
  const commits = extra.commits?.length ?? 0
  if (commits > 0) parts.push(plural(commits, 'commit'))
  return parts.length > 0 ? `Outcome: ${parts.join('; ')}.` : undefined
}

export function memSessionTitle(harness: string, startedMs: number, offsetMin: number, topic?: string): string {
  const t = topic !== undefined ? memClip(memOneLine(topic), 70) : ''
  return t !== '' ? `${harness} session: ${t}` : `${harness} session ${memLocalDate(startedMs, offsetMin)} ${memLocalTime(startedMs, offsetMin)}`
}

export function memSessionBody(input: { startedMs: number, endedMs?: number, offsetMin: number, branch?: string }, d: SpoolDigest | undefined, extra: { commits?: string[], diffstat?: string, summary?: string } = {}): string {
  const lines: string[] = []
  const summary = extra.summary ?? d?.finalMessage
  if (summary !== undefined && summary.trim() !== '') lines.push('Summary:', summary.trim())
  if (d !== undefined && d.compactions.length > 0) {
    lines.push('', 'Compaction summaries:')
    for (const c of d.compactions) lines.push(`- ${memLocalDate(c.ts, input.offsetMin)} ${memLocalTime(c.ts, input.offsetMin)}${c.trigger !== undefined ? ` (${c.trigger})` : ''}: ${memClip(memOneLine(c.summary), 1200)}`)
  }
  const log: string[] = []
  const end = input.endedMs ?? d?.endedMs
  if (end !== undefined) log.push(`- Time: ${memLocalDate(input.startedMs, input.offsetMin)} ${memLocalTime(input.startedMs, input.offsetMin)}-${memLocalTime(end, input.offsetMin)} (${duration(end - input.startedMs)})`)
  if (input.branch !== undefined) log.push(`- Branch: ${input.branch}`)
  if (d !== undefined) {
    if (d.files.length > 0) {
      const shown = d.files.slice(-25).map(f => `\`${f.replace(/`/g, "'")}\``).join(', ')
      log.push(`- Files touched (${d.files.length}): ${shown}${d.files.length > 25 ? ', ...' : ''}`)
    }
    if (d.commands > 0) {
      const tests = d.tests.runs > 0 ? `; test runs: ${d.tests.runs}${d.tests.failures > 0 ? ` (${d.tests.failures} failed)` : ''}` : ''
      log.push(`- Commands: ${d.commands}${tests}`)
    }
    if (d.failures.length > 0) {
      log.push(`- Failed commands: ${d.failures.slice(-5).map(f => `\`${memClip(memOneLine(f.cmd), 80).replace(/`/g, "'")}\` (exit ${f.exit})`).join(', ')}`)
    }
    if (d.turns > 0 || d.prompts > 0) log.push(`- Turns: ${Math.max(d.turns, d.prompts)}${d.tools > 0 ? `; tool calls: ${d.tools}` : ''}`)
  }
  if (extra.commits !== undefined && extra.commits.length > 0) {
    log.push(`- Commits (${extra.commits.length}): ${extra.commits.slice(0, 10).map(c => memClip(memOneLine(c), 90)).join('; ')}`)
  }
  if (extra.diffstat !== undefined && extra.diffstat.trim() !== '') log.push(`- Diffstat: ${memOneLine(extra.diffstat)}`)
  if (log.length > 0) lines.push('', 'Work log (recorded by hooks):', ...log)
  return lines.join('\n').trim()
}

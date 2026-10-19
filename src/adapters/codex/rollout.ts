import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { resolve } from 'node:path'
import type { RateWindow } from '../../core/status/model'
import { codexContextUsedPct, parseCodexLine, type CodexCarry } from '../../usage/codex'

const TAIL_BYTES = 512 * 1024
const COMPACTION_TAIL_BYTES = 4 * 1024 * 1024

export interface RolloutTelemetry {
  model?: string
  effort?: string
  ctx?: { pct: number, tokens: number, window: number }
  windows: RateWindow[]
  at?: number
}

export function readTail(path: string, maxBytes = TAIL_BYTES): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    let text = buf.toString('utf8')
    if (len < size) {
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    return text
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {  }
  }
}

export function contextUsedPct(tokensInContext: number, window: number): number {
  return codexContextUsedPct(tokensInContext, window)
}

export function fallbackWindowLabel(minutes: number): string {
  const bands: Array<[number, string]> = [[300, '5h'], [1440, '1d'], [10080, '7d'], [43200, '30d'], [525600, '365d']]
  for (const [m, label] of bands) if (Math.abs(minutes - m) <= m * 0.05) return label
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
}

type CodexWindow = NonNullable<NonNullable<CodexCarry['rate']>['primary']>

function rateWindow(w: CodexWindow | undefined, label: (minutes: number) => string): RateWindow | undefined {
  if (w === undefined || !Number.isFinite(w.used)) return undefined
  const out: RateWindow = { pct: w.used, label: w.minutes !== undefined ? label(w.minutes) : '?' }
  if (w.minutes !== undefined) out.windowMinutes = w.minutes
  if (w.resetsAt !== undefined) out.resetsAt = new Date(w.resetsAt * 1000).toISOString()
  return out
}

export function parseRolloutTelemetry(text: string, opts: { nowMs: number, label?: (minutes: number) => string }): RolloutTelemetry {
  const carry: CodexCarry = {}
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { parseCodexLine(line, carry) } catch {  }
  }
  const label = opts.label ?? fallbackWindowLabel
  const out: RolloutTelemetry = { windows: [] }
  if (carry.model !== undefined) out.model = carry.model
  if (carry.effort !== undefined) out.effort = carry.effort
  const c = carry.ctx
  if (c !== undefined && c.window !== undefined && c.window > 0 && Number.isFinite(c.tokens)) {
    out.ctx = { pct: codexContextUsedPct(c.tokens, c.window), tokens: c.tokens, window: c.window }
    out.at = c.ts
  }
  for (const w of [rateWindow(carry.rate?.primary, label), rateWindow(carry.rate?.secondary, label)]) {
    if (w === undefined) continue
    if (w.resetsAt !== undefined && Date.parse(w.resetsAt) <= opts.nowMs) continue
    out.windows.push(w)
  }
  return out
}

export function readRolloutTelemetry(path: string, opts: { nowMs: number, label?: (minutes: number) => string }): RolloutTelemetry | undefined {
  const text = readTail(path)
  return text === undefined ? undefined : parseRolloutTelemetry(text, opts)
}

function jsonStringAt(text: string, start: number): string | undefined {
  if (text[start] !== '"') return undefined
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') { i++; continue }
    if (ch === '"') {
      try { return JSON.parse(text.slice(start, i + 1)) as string } catch { return undefined }
    }
  }
  return undefined
}

export function compactionSummary(text: string): string | undefined {
  const marker = '"type":"compacted"'
  let at = text.lastIndexOf(marker)
  while (at >= 0) {
    const lineStart = text.lastIndexOf('\n', at) + 1
    const lineEnd = text.indexOf('\n', at)
    const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd)
    let message: string | undefined
    try {
      const o = JSON.parse(line) as { type?: unknown, payload?: { message?: unknown } }
      if (o.type === 'compacted' && typeof o.payload?.message === 'string') message = o.payload.message
    } catch {
      const rest = text.slice(at, lineEnd < 0 ? text.length : lineEnd)
      const m = /^"type":"compacted"\s*,\s*"payload"\s*:\s*\{\s*"message"\s*:\s*/.exec(rest)
      if (m !== null) message = jsonStringAt(rest, m[0].length)
    }
    if (message !== undefined && message.trim() !== '') return message
    at = at === 0 ? -1 : text.lastIndexOf(marker, at - 1)
  }
  return undefined
}

export function readCompactionSummary(path: string): string | undefined {
  const text = readTail(path, COMPACTION_TAIL_BYTES)
  return text === undefined ? undefined : compactionSummary(text)
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function lastFunctionCall(text: string, match: { callId: string } | { name: string }): Record<string, unknown> | undefined {
  const needle = 'callId' in match ? `"call_id":${JSON.stringify(match.callId)}` : `"name":${JSON.stringify(match.name)}`
  let at = text.lastIndexOf(needle)
  while (at >= 0) {
    const start = text.lastIndexOf('\n', at) + 1
    const end = text.indexOf('\n', at)
    try {
      const o = JSON.parse(text.slice(start, end < 0 ? text.length : end)) as unknown
      const p = isRecord(o) && o['type'] === 'response_item' ? o['payload'] : undefined
      if (isRecord(p) && p['type'] === 'function_call' && typeof p['arguments'] === 'string'
        && ('callId' in match ? p['call_id'] === match.callId : p['name'] === match.name)) {
        const args = JSON.parse(p['arguments']) as unknown
        return isRecord(args) ? args : undefined
      }
    } catch {  }
    at = start === 0 ? -1 : text.lastIndexOf(needle, start - 1)
  }
  return undefined
}

export function callAnswered(text: string, callId: string): boolean {
  const needle = `"call_id":${JSON.stringify(callId)}`
  let at = text.lastIndexOf(needle)
  while (at >= 0) {
    const start = text.lastIndexOf('\n', at) + 1
    const end = text.indexOf('\n', at)
    try {
      const o = JSON.parse(text.slice(start, end < 0 ? text.length : end)) as unknown
      const p = isRecord(o) && o['type'] === 'response_item' ? o['payload'] : undefined
      if (isRecord(p) && typeof p['type'] === 'string' && p['type'].endsWith('_output') && p['call_id'] === callId) return true
    } catch {  }
    at = start === 0 ? -1 : text.lastIndexOf(needle, start - 1)
  }
  return false
}

export function readExecCwd(path: string, callId: string, cwd: string): string | undefined {
  const text = readTail(path)
  const args = text === undefined ? undefined : lastFunctionCall(text, { callId })
  if (args === undefined) return undefined
  const workdir = args['workdir']
  return typeof workdir === 'string' && workdir.trim() !== '' ? resolve(cwd, workdir) : cwd
}

const DONE_STEPS = new Set(['completed', 'done', 'cancelled'])

export function readOpenPlanSteps(path: string): string[] | undefined {
  const plan = readLatestPlan(path)
  return plan === undefined ? undefined : openPlanSteps(plan)
}

export function readLatestPlan(path: string): unknown[] | undefined {
  const text = readTail(path, COMPACTION_TAIL_BYTES)
  const args = text === undefined ? undefined : lastFunctionCall(text, { name: 'update_plan' })
  if (args === undefined) return undefined
  return Array.isArray(args['plan']) ? args['plan'] : []
}

export function openPlanSteps(plan: readonly unknown[]): string[] {
  const out: string[] = []
  for (const item of plan) {
    if (!isRecord(item) || typeof item['step'] !== 'string') continue
    const step = item['step'].trim()
    const status = typeof item['status'] === 'string' ? item['status'] : 'pending'
    if (step !== '' && !DONE_STEPS.has(status)) out.push(step.slice(0, 200))
  }
  return out.slice(0, 30)
}

export function collaborationMode(text: string): string | undefined {
  const marker = '"type":"turn_context"'
  let at = text.lastIndexOf(marker)
  while (at >= 0) {
    const start = text.lastIndexOf('\n', at) + 1
    const end = text.indexOf('\n', at)
    try {
      const o = JSON.parse(text.slice(start, end < 0 ? text.length : end)) as unknown
      const p = isRecord(o) && o['type'] === 'turn_context' ? o['payload'] : undefined
      if (isRecord(p)) {
        const c = p['collaboration_mode']
        const mode = isRecord(c) ? c['mode'] : undefined
        return typeof mode === 'string' && mode !== '' ? mode.toLowerCase() : undefined
      }
    } catch {  }
    at = start === 0 ? -1 : text.lastIndexOf(marker, start - 1)
  }
  return undefined
}

export function readCollaborationMode(path: string): string | undefined {
  const text = readTail(path, COMPACTION_TAIL_BYTES)
  return text === undefined ? undefined : collaborationMode(text)
}

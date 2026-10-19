import { mkdirSync, appendFileSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../core/events'
import type { MemLayer } from '../core/memory/brain'
import { REFLECT_BUDGET } from '../core/memory/budgets'
import { reflectGuards, type ReflectGuard, type ReflectRejection } from '../core/memory/reflect'
import { atomicWriteSync } from '../engine/fsx'
import { log } from '../engine/log'
import { locksDir, reflectRunsFile, reflectUndoDir } from './layout'
import { acquireLock } from './lock'
import { chooseHarnesses, type HarnessHold, type HarnessPick } from './model'
import type { BrainRef } from './store'

export type ReflectTrigger = 'session-end' | 'manual' | 'heal' | 'tick'

export type ReflectSkip =
  | 'disabled' | 'no-brain' | 'unchanged' | 'rate-limit' | 'no-harness' | 'busy'
  | 'nothing-to-do' | 'runner-failed' | 'runner-unavailable'

export interface ReflectApplied {
  op: string
  id: string
  why: string
  to?: string
}

export interface ReflectRunEntry {
  v: 1
  id: string
  at: string
  layer: MemLayer
  project?: string
  trigger: ReflectTrigger
  harness?: Harness
  model: string
  dryRun?: boolean
  rounds: number
  subQueries: number
  shown: number
  focus?: string[]
  proposed: number
  applied: ReflectApplied[]
  planned?: ReflectApplied[]
  rejected: ReflectRejection[]
  skipped?: ReflectSkip
  detail?: string
  undone?: string
  inputChars: number
  outputChars: number
}

const DAY_MS = 86_400_000
const RUNS_KEEP_MS = 30 * DAY_MS
const RUNS_KEEP_LINES = 500

export function scopeKey(layer: MemLayer, project?: string): string {
  return layer === 'person' ? 'person' : `project:${project ?? ''}`
}

function sameBrain(e: { layer: MemLayer, project?: string }, ref: BrainRef): boolean {
  return e.layer === ref.layer && (ref.layer === 'person' || e.project === ref.slug)
}

function isEntry(v: unknown): v is ReflectRunEntry {
  if (v === null || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return e['v'] === 1 && typeof e['id'] === 'string' && typeof e['at'] === 'string' && (e['layer'] === 'project' || e['layer'] === 'person') && Array.isArray(e['applied']) && Array.isArray(e['rejected'])
}

export function readReflectRuns(): ReflectRunEntry[] {
  let text = ''
  try { text = readFileSync(reflectRunsFile(), 'utf8') } catch { return [] }
  const out: ReflectRunEntry[] = []
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue
    try { const v = JSON.parse(l) as unknown; if (isEntry(v)) out.push(v) } catch {  }
  }
  return out
}

function runsLock(): string {
  return join(locksDir(), 'reflect-runs.lock')
}

export async function appendReflectRun(entry: ReflectRunEntry, nowMs: number): Promise<boolean> {
  const release = await acquireLock(runsLock(), { timeoutMs: 5000, staleMs: 30_000 })
  try {
    const file = reflectRunsFile()
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
    const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
    const atOf = (l: string): number => { try { return Date.parse((JSON.parse(l) as { at?: string }).at ?? '') || 0 } catch { return 0 } }
    const kept = lines.filter(l => nowMs - atOf(l) <= RUNS_KEEP_MS).slice(-RUNS_KEEP_LINES)
    if (kept.length < lines.length) atomicWriteSync(file, kept.join('\n') + '\n', { mode: 0o600 })
    pruneUndo(nowMs)
    return true
  } catch (e) {
    log('warn', 'memory: a reflect run was not recorded', { error: e })
    return false
  } finally {
    release?.()
  }
}

function pruneUndo(nowMs: number): void {
  let names: string[] = []
  try { names = readdirSync(reflectUndoDir()) } catch { return }
  for (const n of names) {
    const p = join(reflectUndoDir(), n)
    try { if (nowMs - statSync(p).mtimeMs > RUNS_KEEP_MS) unlinkSync(p) } catch {  }
  }
}

export async function markReflectUndone(runId: string, atIso: string): Promise<void> {
  const release = await acquireLock(runsLock(), { timeoutMs: 5000, staleMs: 30_000 })
  try {
    const file = reflectRunsFile()
    const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
    const out = lines.map(l => {
      try {
        const v = JSON.parse(l) as unknown
        return isEntry(v) && v.id === runId ? JSON.stringify({ ...v, undone: atIso }) : l
      } catch { return l }
    })
    atomicWriteSync(file, out.join('\n') + '\n', { mode: 0o600 })
  } catch (e) {
    log('warn', 'memory: the reflect run log was not marked', { runId, error: e })
  } finally {
    release?.()
  }
}

export function focusRuns(entries: readonly ReflectRunEntry[], ref: BrainRef): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const e of entries) {
    if (!sameBrain(e, ref) || e.rounds === 0 || e.dryRun === true || e.undone !== undefined || !Array.isArray(e.focus)) continue
    for (const id of e.focus) {
      if (typeof id !== 'string') continue
      const list = out.get(id) ?? []
      list.push(e.at)
      out.set(id, list)
    }
  }
  for (const list of out.values()) list.sort()
  return out
}

export function lastReflectAt(entries: readonly ReflectRunEntry[], ref: BrainRef, calledModel = false): number | undefined {
  let best: number | undefined
  for (const e of entries) {
    if (!sameBrain(e, ref) || (calledModel && e.rounds === 0)) continue
    const t = Date.parse(e.at)
    if (Number.isFinite(t) && (best === undefined || t > best)) best = t
  }
  return best
}

export interface ReflectRunView extends ReflectRunEntry {
  undo?: string
}

function view(e: ReflectRunEntry): ReflectRunView {
  return e.applied.length > 0 && e.undone === undefined && e.dryRun !== true ? { ...e, undo: `buracle mem reflect --undo ${e.id}` } : { ...e }
}

export function listReflectRuns(limit = 20): ReflectRunView[] {
  return readReflectRuns().reverse().slice(0, limit).map(view)
}

export type ReflectScope = { kind: 'person' } | { kind: 'project', slug: string }

export interface ReflectOverview {
  scope: string
  config: {
    harnesses: HarnessPick[]
    held: HarnessHold[]
    maxOpsPerRun: number
    maxSubQueries: number
    relateEveryMin: number
    runsToday: number
  }
  guards: ReflectGuard[]
  runs: ReflectRunView[]
}

export function reflectRunsToday(entries: readonly ReflectRunEntry[], nowMs: number): number {
  return entries.filter(e => e.rounds > 0 && nowMs - Date.parse(e.at) <= DAY_MS).length
}

export function reflectOverview(scope: ReflectScope, nowMs: number): ReflectOverview {
  const cfg = REFLECT_BUDGET
  const entries = readReflectRuns()
  const choice = chooseHarnesses({ nowMs })
  const key = scope.kind === 'person' ? 'person' : scopeKey('project', scope.slug)
  return {
    scope: key,
    config: {
      harnesses: choice.picks, held: choice.held,
      maxOpsPerRun: cfg.maxOpsPerRun, maxSubQueries: cfg.maxSubQueries, relateEveryMin: Math.round(cfg.relateEveryMs / 60_000), runsToday: reflectRunsToday(entries, nowMs),
    },
    guards: reflectGuards(),
    runs: entries.filter(e => scopeKey(e.layer, e.project) === key).reverse().slice(0, 20).map(view),
  }
}

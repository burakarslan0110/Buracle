import { isAbsolute, join, normalize, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { normalizePlanText } from '../../../core/plan/capture'
import { shownPath } from '../../../workflow/plan-capture'
import type { OmpToolResultEvent } from './types'

export const OMP_PLAN_APPROVED = 'Plan approved.'
export const OMP_PLAN_OPEN = '<plan path="'
export const OMP_PLAN_CLOSE = '</plan>'
export const OMP_LOCAL_SCHEME = 'local://'
export const STAGED_PLAN_MAX_AGE_MS = 10 * 60_000
export const STAGED_PLAN_STALE_MS = 24 * 60 * 60_000
export const USER_PLAN_MAX_AGE_MS = 2 * 60_000

export interface StagedPlan { path: string, text: string }

export interface SavedPlan { path: string, note?: string }

export interface PlanStore {
  save(plan: string, cwd: string, nowMs: number, sid?: string): Promise<SavedPlan | undefined>
  staged(nowMs: number): StagedPlan[]
  autosaved(cwd: string, nowMs: number): StagedPlan[]
  sweep(nowMs: number): void
  drop(path: string): void
}

export interface PlanSignal { prompt?: string, approved?: boolean, plan?: string }

function record(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined
}

export function ompPlanSettings(doc: unknown): Record<string, unknown> | undefined {
  return record(record(doc)?.['plan'])
}

export function ompAutosaveDir(configText: string | undefined, cwd: string, home: string): string | undefined {
  if (configText === undefined || configText.trim() === '') return undefined
  let doc: unknown
  try { doc = parseYaml(configText) as unknown } catch { return undefined }
  const p = ompPlanSettings(doc)
  if (p === undefined || p['autosave'] !== true) return undefined
  const raw = typeof p['autosaveDir'] === 'string' ? p['autosaveDir'].trim() : ''
  if (raw === '') return join(cwd, '.omp', 'plans')
  const dir = raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
  return isAbsolute(dir) ? normalize(dir) : resolve(cwd, dir)
}

export function proposeDetails(details: unknown): Record<string, unknown> | undefined {
  const d = record(details)
  const xdev = record(d?.['xdev'])
  return xdev !== undefined ? (xdev['tool'] === 'propose' ? record(xdev['inner']) : undefined) : d
}

export function planFileOf(details: unknown, artifactsDir: string | null | undefined, cwd: string): string | undefined {
  const raw = proposeDetails(details)?.['planFilePath']
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  if (!raw.startsWith(OMP_LOCAL_SCHEME)) return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? undefined : resolve(cwd, raw)
  if (typeof artifactsDir !== 'string' || artifactsDir === '') return undefined
  let rel: string
  try { rel = decodeURIComponent(raw.slice(OMP_LOCAL_SCHEME.length).replace(/[?#].*$/, '').replaceAll('\\', '/')) } catch { return undefined }
  const parts = rel.split('/').filter(p => p !== '' && p !== '.')
  if (parts.length === 0 || parts.includes('..')) return undefined
  return join(resolve(artifactsDir, 'local'), ...parts)
}

export function approvedPlanOf(prompt: string): string | undefined {
  const text = prompt.replace(/\r\n?/g, '\n')
  if (!text.trimStart().startsWith(OMP_PLAN_APPROVED)) return undefined
  const open = text.indexOf(OMP_PLAN_OPEN)
  const bodyStart = open < 0 ? -1 : text.indexOf('\n', open)
  const close = text.lastIndexOf(`\n${OMP_PLAN_CLOSE}`)
  if (bodyStart < 0 || close < bodyStart) return undefined
  const plan = text.slice(bodyStart + 1, close).trim()
  return plan !== '' ? plan : undefined
}

export function approvingResult(event: Pick<OmpToolResultEvent, 'isError' | 'details' | 'content'>): boolean {
  if (event.isError) return false
  if (proposeDetails(event.details)?.['planExists'] !== true) return false
  const text = (Array.isArray(event.content) ? event.content : []).map(c => (typeof c?.text === 'string' ? c.text : '')).join('').trim()
  return text.startsWith('Plan approved')
}

export async function capturePlans(store: PlanStore, cwd: string, nowMs: number, signal: PlanSignal, sid?: string): Promise<SavedPlan[]> {
  const plan = signal.prompt !== undefined ? approvedPlanOf(signal.prompt) : signal.plan !== undefined && normalizePlanText(signal.plan) !== '' ? signal.plan : undefined
  if (plan === undefined && signal.approved !== true) {
    store.sweep(nowMs)
    return []
  }
  const staged = store.staged(nowMs)
  if (plan !== undefined) {
    const key = normalizePlanText(plan)
    for (const s of staged) if (normalizePlanText(s.text) === key) store.drop(s.path)
    const one = await store.save(plan, cwd, nowMs, sid)
    return one !== undefined ? [one] : []
  }
  const seen = new Set<string>()
  const saved: SavedPlan[] = []
  const keep = async (text: string): Promise<void> => {
    const key = normalizePlanText(text)
    if (key === '' || seen.has(key)) return
    seen.add(key)
    const one = await store.save(text, cwd, nowMs, sid)
    if (one !== undefined) saved.push(one)
  }
  for (const s of staged) {
    await keep(s.text)
    store.drop(s.path)
  }
  for (const s of store.autosaved(cwd, nowMs)) await keep(s.text)
  return saved
}

export function planSavedNote(saved: readonly SavedPlan[], cwd: string): string {
  const plain = saved.filter(f => f.note === undefined)
  const notes = saved.flatMap(f => (f.note !== undefined ? [f.note] : []))
  if (plain.length > 0) notes.push(`Buracle: the approved plan was saved to ${plain.map(f => shownPath(f.path, cwd)).join(', ')} (H12).`)
  return notes.join('\n\n')
}

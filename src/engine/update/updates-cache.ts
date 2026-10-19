import { atomicWriteSync, readJsonSafeSync } from '../fsx'
import * as paths from '../paths'
import type { Risk } from './versions'

export type UpdateKind = 'self' | 'skills' | 'mcp' | 'plugins' | 'harness' | 'tools' | 'pricing'
export const UPDATE_KINDS: readonly UpdateKind[] = ['self', 'skills', 'mcp', 'plugins', 'harness', 'tools', 'pricing']

export function isUpdateKind(x: unknown): x is UpdateKind {
  return typeof x === 'string' && (UPDATE_KINDS as readonly string[]).includes(x)
}

export interface UpdateItem {
  kind: UpdateKind
  id: string
  current: string | null
  latest: string | null
  action: string
  risk: Risk
  note?: string
  command?: string[]
  publishedAt?: string
  source?: string
}

export interface HeldItem { kind: UpdateKind; id: string; current: string | null; version: string; publishedAt: string; ageDays: number }
export interface UpdateError { kind: UpdateKind; id?: string; error: string }

export interface UpdatesCache {
  v: 1
  checked_at: string
  kinds: UpdateKind[]
  items: UpdateItem[]
  held: HeldItem[]
  errors: UpdateError[]
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function readUpdatesCache(): UpdatesCache | undefined {
  const r = readJsonSafeSync<unknown>(paths.updatesFile())
  if (!r.ok || !isRecord(r.value) || typeof r.value['checked_at'] !== 'string' || !Array.isArray(r.value['items'])) return undefined
  const v = r.value
  return {
    v: 1,
    checked_at: v['checked_at'] as string,
    kinds: Array.isArray(v['kinds']) ? (v['kinds'] as unknown[]).filter(isUpdateKind) : [...UPDATE_KINDS],
    items: (v['items'] as unknown[]).filter((i): i is UpdateItem => isRecord(i) && isUpdateKind(i['kind']) && typeof i['id'] === 'string'),
    held: Array.isArray(v['held']) ? (v['held'] as unknown[]).filter((i): i is HeldItem => isRecord(i) && isUpdateKind(i['kind'])) : [],
    errors: Array.isArray(v['errors']) ? (v['errors'] as unknown[]).filter((i): i is UpdateError => isRecord(i) && isUpdateKind(i['kind'])) : [],
  }
}

const order = (k: UpdateKind) => UPDATE_KINDS.indexOf(k)
function sortItems<T extends { kind: UpdateKind, id?: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => order(a.kind) - order(b.kind) || ((a.id ?? '') < (b.id ?? '') ? -1 : (a.id ?? '') > (b.id ?? '') ? 1 : 0))
}

export function writeUpdatesCache(fresh: Omit<UpdatesCache, 'v'>): UpdatesCache {
  const prev = readUpdatesCache()
  const checked = new Set(fresh.kinds)
  const keep = <T extends { kind: UpdateKind }>(xs: T[] | undefined) => (xs ?? []).filter(x => !checked.has(x.kind))
  const next: UpdatesCache = {
    v: 1,
    checked_at: fresh.checked_at,
    kinds: UPDATE_KINDS.filter(k => checked.has(k) || (prev?.kinds ?? []).includes(k)),
    items: sortItems([...keep(prev?.items), ...fresh.items]),
    held: sortItems([...keep(prev?.held), ...fresh.held]),
    errors: sortItems([...keep(prev?.errors), ...fresh.errors]),
  }
  const { v, checked_at, kinds, items, held, errors } = next
  atomicWriteSync(paths.updatesFile(), JSON.stringify({ v, checked_at, kinds, count: items.length, items, held, errors }, null, 2) + '\n')
  return next
}

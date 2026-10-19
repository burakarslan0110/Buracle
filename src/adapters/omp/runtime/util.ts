import type { OmpContext, OmpMessage } from './types'
import { isValidSessionId } from '../../../engine/paths'

export function sessionOf(ctx: OmpContext | undefined): string | undefined {
  try {
    const id = ctx?.sessionManager?.getSessionId?.()
    return isValidSessionId(id) ? id : undefined
  } catch {
    return undefined
  }
}

export function isMain(ctx: OmpContext | undefined): boolean {
  const kind = ctx?.agent?.kind
  return kind === undefined || kind === 'main'
}

export function hasTui(ctx: OmpContext | undefined): boolean {
  return ctx !== undefined && ctx.mode === 'tui' && ctx.hasUI !== false
}

export function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>(res => { timer = setTimeout(() => res(fallback), ms) })
  return Promise.race([work, late]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

export function messageText(msg: OmpMessage | undefined): string {
  if (msg === undefined || msg === null) return ''
  const c = msg.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  const parts: string[] = []
  for (const b of c) {
    if (b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}

export function numAt(x: unknown, ...keys: string[]): number | undefined {
  let cur: unknown = x
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : undefined
}

export function strAt(x: unknown, ...keys: string[]): string | undefined {
  let cur: unknown = x
  for (const k of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return typeof cur === 'string' ? cur : undefined
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…'
}

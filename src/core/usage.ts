import type { Harness } from './events'
import type { RateWindow } from './status/model'

export interface UsageSnapshot { harness: Harness; computed_at: string; windows: RateWindow[]; month: { start: string; tokens: number; usd?: number; byModel: Record<string, { tokens: number; usd?: number }> } }
export type PricingTable = Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }>

function lookupForms(model: string): string[] {
  const out: string[] = []
  const add = (s: string) => { if (s !== '' && !out.includes(s)) out.push(s) }
  const m = model.trim().toLowerCase()
  add(m)
  const last = m.slice(m.lastIndexOf('/') + 1)
  add(last)
  const bedrock = /^(?:[a-z]{2,8}(?:-[a-z]+)?\.)?anthropic\.(.+)$/u.exec(last)
  if (bedrock?.[1] !== undefined) add(bedrock[1])
  for (const f of [...out]) if (f.startsWith('claude') && f.includes('.')) add(f.replace(/\./gu, '-'))
  return out
}

function sameModel(rest: string): boolean {
  if (rest === '') return true
  const c = rest[0]
  if (c === '@' || c === ':' || c === '[' || c === '_' || c === ' ') return true
  if (c === '-') return !/^-\d{1,2}(?!\d)/u.test(rest)
  return false
}

export function pricingKeyFor(model: string, table: PricingTable): string | undefined {
  let best: string | undefined
  let bestLen = -1
  const keys = Object.keys(table)
  for (const form of lookupForms(model)) {
    for (const key of keys) {
      const k = key.trim().toLowerCase()
      if (k === '' || k.length <= bestLen || !form.startsWith(k)) continue
      if (!sameModel(form.slice(k.length))) continue
      best = key
      bestLen = k.length
    }
  }
  return best
}

function count(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0
}

function rate(n: number | undefined): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

export function priceOf(model: string, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }, table: PricingTable): number | undefined {
  const key = pricingKeyFor(model, table)
  if (key === undefined) return undefined
  const p = table[key]
  const input = rate(p?.input)
  const output = rate(p?.output)
  if (p === undefined || input === undefined || output === undefined) return undefined
  const cacheRead = rate(p.cacheRead) ?? input
  const cacheWrite = rate(p.cacheWrite) ?? input
  return (count(tokens.input) * input + count(tokens.output) * output + count(tokens.cacheRead) * cacheRead + count(tokens.cacheWrite) * cacheWrite) / 1_000_000
}

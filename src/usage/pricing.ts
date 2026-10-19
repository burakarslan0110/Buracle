import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { PricingTable } from '../core/usage'
import { atomicWriteSync } from '../engine/fsx'
import { canonicalDir } from '../engine/paths'

export const LITELLM_PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'

export function pricingFile(): string {
  return join(canonicalDir(), 'pricing.yaml')
}

type Price = PricingTable[string]

function rate(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : undefined
}

export function validatePricing(x: unknown): { table: PricingTable, errors: string[] } {
  const table: PricingTable = {}
  const errors: string[] = []
  if (x === null || x === undefined) return { table, errors }
  if (typeof x !== 'object' || Array.isArray(x)) return { table, errors: ['pricing: expected a mapping of model prefix → prices'] }
  for (const [key, v] of Object.entries(x as Record<string, unknown>)) {
    const e = v as Record<string, unknown> | null
    const input = rate(e?.['input'])
    const output = rate(e?.['output'])
    if (e === null || typeof e !== 'object' || input === undefined || output === undefined) {
      errors.push(`${key}: input and output must be non-negative numbers (USD per MTok)`)
      continue
    }
    const p: Price = { input, output }
    const cr = rate(e['cacheRead'])
    const cw = rate(e['cacheWrite'])
    if (cr !== undefined) p.cacheRead = cr
    if (cw !== undefined) p.cacheWrite = cw
    for (const k of Object.keys(e)) if (!['input', 'output', 'cacheRead', 'cacheWrite'].includes(k)) errors.push(`${key}.${k}: unknown key`)
    table[key] = p
  }
  return { table, errors }
}

export function loadPricing(path = pricingFile()): PricingTable {
  try {
    return validatePricing(parseYaml(readFileSync(path, 'utf8')) as unknown).table
  } catch {
    return {}
  }
}

function perMTok(x: unknown): number | undefined {
  const v = rate(x)
  return v === undefined ? undefined : Number((v * 1e6).toPrecision(12))
}

export function pricingFromLitellm(json: unknown, models: string[]): { table: PricingTable, missing: string[] } {
  const src = json !== null && typeof json === 'object' ? json as Record<string, Record<string, unknown> | undefined> : {}
  const table: PricingTable = {}
  const missing: string[] = []
  for (const model of [...new Set(models)].sort()) {
    const e = src[model]
    const input = perMTok(e?.['input_cost_per_token'])
    const output = perMTok(e?.['output_cost_per_token'])
    if (e === undefined || input === undefined || output === undefined) { missing.push(model); continue }
    const p: Price = { input, output }
    const cr = perMTok(e['cache_read_input_token_cost'])
    const cw = perMTok(e['cache_creation_input_token_cost'])
    if (cr !== undefined) p.cacheRead = cr
    if (cw !== undefined) p.cacheWrite = cw
    table[model] = p
  }
  return { table, missing }
}

export function renderPricingYaml(table: PricingTable, meta: { source: string, fetchedAt: string }): string {
  const lines = [
    '# List prices in USD per million tokens (MTok) for the monthly "mo" estimate (CONTRACTS §5.8, §7.2).',
    '# Keys are model-id prefixes; the longest matching prefix wins (`claude-opus-5-5` also prices',
    '# `claude-opus-5-5-20261001`). Models missing from the source are left out, never guessed.',
    '# cacheWrite is the 5-minute cache-write rate; 1-hour writes and long-context surcharges are not modelled.',
    `# Source: ${meta.source}`,
    `# Fetched: ${meta.fetchedAt}`,
    '# Refresh: `buracle update` (src/usage/pricing.ts refreshPricing()).',
  ]
  for (const key of Object.keys(table).sort()) {
    const p = table[key] as Price
    const parts = [`input: ${p.input}`, `output: ${p.output}`]
    if (p.cacheRead !== undefined) parts.push(`cacheRead: ${p.cacheRead}`)
    if (p.cacheWrite !== undefined) parts.push(`cacheWrite: ${p.cacheWrite}`)
    lines.push(`${key}: { ${parts.join(', ')} }`)
  }
  return lines.join('\n') + '\n'
}

function sameTable(a: PricingTable, b: PricingTable): boolean {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.join('\n') !== kb.join('\n')) return false
  return ka.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

export interface RefreshPricingOptions {
  fetcher?: (url: string) => Promise<string>
  path?: string
  models?: string[]
  url?: string
  now?: () => Date
  write?: boolean
}

export interface RefreshPricingResult { changed: boolean; written: boolean; path: string; table: PricingTable; missing: string[]; fetchedAt: string; yaml: string }

async function defaultFetcher(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`)
  return res.text()
}

export async function refreshPricing(opts: RefreshPricingOptions = {}): Promise<RefreshPricingResult> {
  const path = opts.path ?? pricingFile()
  const url = opts.url ?? LITELLM_PRICES_URL
  const current = loadPricing(path)
  const models = opts.models ?? Object.keys(current)
  const text = await (opts.fetcher ?? defaultFetcher)(url)
  const json = JSON.parse(text) as unknown
  const { table, missing } = pricingFromLitellm(json, models)
  const fetchedAt = (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/u, 'Z')
  const yaml = renderPricingYaml(table, { source: url, fetchedAt })
  const changed = !sameTable(current, table)
  const written = changed && opts.write !== false
  if (written) atomicWriteSync(path, yaml)
  return { changed, written, path, table, missing, fetchedAt, yaml }
}

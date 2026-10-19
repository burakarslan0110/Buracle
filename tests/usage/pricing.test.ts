import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { LITELLM_PRICES_URL, loadPricing, pricingFile, pricingFromLitellm, refreshPricing, renderPricingYaml, validatePricing } from '../../src/usage/pricing'
import { withSandbox } from '../helpers/sandbox'

const LITELLM = {
  'claude-opus-5-5': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 0.000004, output_cost_per_token: 0.00002, cache_read_input_token_cost: 2e-7, cache_creation_input_token_cost: 0.000005, cache_creation_input_token_cost_above_1hr: 0.000008 },
  'gpt-6.1-sol': { litellm_provider: 'openai', mode: 'chat', input_cost_per_token: 0.000002, output_cost_per_token: 0.00001, cache_read_input_token_cost: 1e-7 },
  'us.anthropic.claude-opus-5-5': { input_cost_per_token: 0.0000044, output_cost_per_token: 0.000022 },
  'chatgpt/gpt-6.1-sol': { litellm_provider: 'chatgpt', mode: 'responses' },
  sample_spec: { input_cost_per_token: 0 },
}

describe('pricingFromLitellm', () => {
  test('converts per-token prices to USD per MTok for exact keys only', () => {
    const r = pricingFromLitellm(LITELLM, ['gpt-6.1-sol', 'claude-opus-5-5', 'claude-unknown-9', 'chatgpt/gpt-6.1-sol'])
    expect(r.table).toEqual({
      'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1 },
    })
    expect(r.missing).toEqual(['chatgpt/gpt-6.1-sol', 'claude-unknown-9'])
    expect(pricingFromLitellm(null, ['x']).missing).toEqual(['x'])
  })
})

describe('renderPricingYaml', () => {
  test('deterministic, sorted, with source and fetch date, and round-trips', () => {
    const table = pricingFromLitellm(LITELLM, ['gpt-6.1-sol', 'claude-opus-5-5']).table
    const yaml = renderPricingYaml(table, { source: LITELLM_PRICES_URL, fetchedAt: '2026-10-07T22:52:59Z' })
    expect(yaml).toBe(renderPricingYaml({ 'gpt-6.1-sol': table['gpt-6.1-sol']!, 'claude-opus-5-5': table['claude-opus-5-5']! }, { source: LITELLM_PRICES_URL, fetchedAt: '2026-10-07T22:52:59Z' }))
    expect(yaml).toContain(`# Source: ${LITELLM_PRICES_URL}\n# Fetched: 2026-10-07T22:52:59Z\n`)
    expect(yaml.split('\n').filter(l => !l.startsWith('#') && l !== '')).toEqual([
      'claude-opus-5-5: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }',
      'gpt-6.1-sol: { input: 2, output: 10, cacheRead: 0.1 }',
    ])
    expect(validatePricing(parseYaml(yaml))).toEqual({ table, errors: [] })
  })
})

describe('validatePricing / loadPricing', () => {
  test('keeps good entries and reports bad ones', () => {
    const r = validatePricing({ a: { input: 1, output: 2, cacheRead: 0.1, extra: 1 }, b: { input: 'x', output: 1 }, c: 5 })
    expect(r.table).toEqual({ a: { input: 1, output: 2, cacheRead: 0.1 } })
    expect(r.errors).toEqual(['a.extra: unknown key', 'b: input and output must be non-negative numbers (USD per MTok)', 'c: input and output must be non-negative numbers (USD per MTok)'])
    expect(validatePricing(null)).toEqual({ table: {}, errors: [] })
    expect(validatePricing([1]).errors.length).toBe(1)
  })

  test('canonical/pricing.yaml is valid, sourced and lists the current lineup', () => {
    const text = readFileSync(pricingFile(), 'utf8')
    expect(text).toContain(`# Source: ${LITELLM_PRICES_URL}`)
    expect(text).toMatch(/^# Fetched: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m)
    const { table, errors } = validatePricing(parseYaml(text))
    expect(errors).toEqual([])
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'gpt-6.1-sol']) expect(table[id]).toBeDefined()
    expect(loadPricing()).toEqual(table)
  })

  test('a missing or broken file is an empty table', () => withSandbox(({ root }) => {
    expect(loadPricing(join(root, 'nope.yaml'))).toEqual({})
    writeFileSync(join(root, 'bad.yaml'), 'a: [unclosed\n')
    expect(loadPricing(join(root, 'bad.yaml'))).toEqual({})
  }))
})

describe('refreshPricing', () => {
  test('re-prices the models in the file with an injected fetcher; writes only on change', () => withSandbox(async ({ root }) => {
    const path = join(root, 'pricing.yaml')
    writeFileSync(path, '# old\nclaude-opus-5-5: { input: 5, output: 25 }\ngpt-6.1-sol: { input: 2, output: 10, cacheRead: 0.1 }\n')
    const urls: string[] = []
    const fetcher = async (url: string) => { urls.push(url); return JSON.stringify(LITELLM) }
    const now = () => new Date('2026-10-08T06:00:00.123Z')
    const r = await refreshPricing({ fetcher, path, now })
    expect(urls).toEqual([LITELLM_PRICES_URL])
    expect(r).toMatchObject({ changed: true, written: true, missing: [], fetchedAt: '2026-10-08T06:00:00Z' })
    expect(readFileSync(path, 'utf8')).toBe(r.yaml)
    expect(loadPricing(path)['claude-opus-5-5']).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })

    const again = await refreshPricing({ fetcher, path, now: () => new Date('2026-10-09T00:00:00Z') })
    expect(again).toMatchObject({ changed: false, written: false })
    expect(readFileSync(path, 'utf8')).toContain('# Fetched: 2026-10-08T06:00:00Z')

    const dry = await refreshPricing({ fetcher, path, models: ['claude-opus-5-5', 'claude-new-6'], write: false })
    expect(dry).toMatchObject({ changed: true, written: false, missing: ['claude-new-6'] })
  }))

  test('fetch failures propagate (the caller decides)', () => withSandbox(async ({ root }) => {
    const path = join(root, 'pricing.yaml')
    writeFileSync(path, 'gpt-6.1-sol: { input: 2, output: 10 }\n')
    await expect(refreshPricing({ path, fetcher: async () => { throw new Error('offline') } })).rejects.toThrow('offline')
    await expect(refreshPricing({ path, fetcher: async () => 'not json' })).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('gpt-6.1-sol: { input: 2, output: 10 }\n')
  }))
})

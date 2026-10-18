import { describe, expect, test } from 'bun:test'
import type { PricingTable } from '../../src/core/usage'
import { priceOf, pricingKeyFor } from '../../src/core/usage'
import { loadPricing } from '../../src/usage/pricing'

const TABLE: PricingTable = {
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'gpt-6': { input: 1, output: 4 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
}
const T = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite })

describe('pricingKeyFor', () => {
  test('longest prefix wins; dated, tagged and routed ids resolve', () => {
    expect(pricingKeyFor('claude-opus-5-5', TABLE)).toBe('claude-opus-5-5')
    expect(pricingKeyFor('claude-opus-5-5-20261001', TABLE)).toBe('claude-opus-5-5')
    expect(pricingKeyFor('claude-opus-5-5[1m]', TABLE)).toBe('claude-opus-5-5')
    expect(pricingKeyFor('claude-opus-5-5@20261001', TABLE)).toBe('claude-opus-5-5')
    expect(pricingKeyFor('Claude-Opus-5-5', TABLE)).toBe('claude-opus-5-5')
    expect(pricingKeyFor('anthropic/claude-opus-5-5', TABLE)).toBe('claude-opus-5-5')
    expect(pricingKeyFor('openrouter/anthropic/claude-opus-5.5', TABLE)).toBe('claude-opus-5-5')
    expect(pricingKeyFor('us.anthropic.claude-opus-5-5-20261001-v1:0', TABLE)).toBe('claude-opus-5-5')
    expect(pricingKeyFor('claude-opus-5-20260301', TABLE)).toBe('claude-opus-5')
    expect(pricingKeyFor('gpt-6.1-sol', TABLE)).toBe('gpt-6.1-sol')
    expect(pricingKeyFor('openai/gpt-6.1-sol', TABLE)).toBe('gpt-6.1-sol')
  })

  test('never guesses across versions', () => {
    expect(pricingKeyFor('claude-opus-5-6', TABLE)).toBeUndefined()
    expect(pricingKeyFor('claude-opus-5-10', TABLE)).toBeUndefined()
    expect(pricingKeyFor('gpt-6.2-sol', TABLE)).toBeUndefined()
    expect(pricingKeyFor('gpt-60', TABLE)).toBeUndefined()
    expect(pricingKeyFor('claude-sonnet-5-5', TABLE)).toBeUndefined()
    expect(pricingKeyFor('', TABLE)).toBeUndefined()
    expect(pricingKeyFor('claude-opus-5-5', {})).toBeUndefined()
  })
})

describe('priceOf', () => {
  test('USD per million tokens with cache rates', () => {
    expect(priceOf('claude-opus-5-5', T(1_000_000, 500_000, 2_000_000, 100_000), TABLE)).toBeCloseTo(4 + 10 + 0.4 + 0.5, 10)
    expect(priceOf('claude-opus-5-5-20261001', T(1000, 0), TABLE)).toBeCloseTo(0.004, 12)
  })

  test('without a cache rate, cached tokens are billed as input', () => {
    expect(priceOf('gpt-6', T(0, 0, 1_000_000, 1_000_000), TABLE)).toBeCloseTo(2, 10)
  })

  test('unknown models and garbage counts', () => {
    expect(priceOf('mystery-model', T(1000, 1000), TABLE)).toBeUndefined()
    expect(priceOf('claude-opus-5-5', T(-5, Number.NaN, Number.POSITIVE_INFINITY, 0), TABLE)).toBe(0)
    expect(priceOf('claude-opus-5-5', T(1, 1), { 'claude-opus-5-5': { input: Number.NaN, output: 1 } })).toBeUndefined()
  })

  test('the canonical table prices the current lineup', () => {
    const table = loadPricing()
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'gpt-6.1-sol']) {
      expect(pricingKeyFor(id, table)).toBe(id)
      expect(priceOf(id, T(1_000_000, 0), table)).toBeGreaterThan(0)
    }
    expect(priceOf('claude-opus-5-5', T(1_000_000, 1_000_000, 1_000_000, 1_000_000), table)).toBeCloseTo(4 + 20 + 0.2 + 5, 10)
  })
})

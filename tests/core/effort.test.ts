import { describe, expect, test } from 'bun:test'
import { defaultConfig, EFFORT_VALUES, validateConfig } from '../../src/core/config'
import { EFFORT_SCALES, effortBelowTop, effortConfigValues, effortRank, resolveEffort } from '../../src/core/effort'
import { HARNESSES } from '../../src/core/events'

describe('resolveEffort', () => {
  test('auto is xhigh on every harness: all four top out at max', () => {
    for (const h of HARNESSES) {
      expect(EFFORT_SCALES[h].top).toBe('max')
      expect(effortBelowTop(h)).toBe('xhigh')
      expect(resolveEffort(h, 'auto')).toEqual({ level: 'xhigh' })
    }
  })

  test('keep leaves the harness setting alone', () => {
    for (const h of HARNESSES) expect(resolveEffort(h, 'keep')).toEqual({ off: true })
  })

  test('the levels each harness saves are written as they are', () => {
    for (const v of ['low', 'medium', 'high', 'xhigh']) expect(resolveEffort('claude', v)).toEqual({ level: v })
    for (const v of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) expect(resolveEffort('codex', v)).toEqual({ level: v })
    for (const v of ['low', 'medium', 'high', 'xhigh', 'max']) expect(resolveEffort('opencode', v)).toEqual({ level: v })
    for (const v of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) expect(resolveEffort('omp', v)).toEqual({ level: v })
    expect(resolveEffort('codex', ' High ')).toEqual({ level: 'high' })
  })

  test("omp's settings cannot hold off, so Buracle never writes it", () => {
    expect(EFFORT_SCALES.omp.persistable).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'])
    expect(EFFORT_VALUES.omp).not.toContain('off')
    const off = resolveEffort('omp', 'off')
    expect('invalid' in off && off.invalid).toContain('minimal')
    expect(validateConfig({ ...defaultConfig(), effort: { ...defaultConfig().effort, omp: 'off' } }).ok).toBe(false)
  })

  test("omp's own per-prompt mode is spelled classifier in the config and written as auto", () => {
    expect(resolveEffort('omp', 'classifier')).toEqual({ level: 'auto' })
    expect(resolveEffort('claude', 'classifier')).toHaveProperty('invalid')
  })

  test('values a harness cannot save are refused with a reason', () => {
    const claudeMax = resolveEffort('claude', 'max')
    expect('invalid' in claudeMax && claudeMax.invalid).toContain('one session')
    const ultra = resolveEffort('codex', 'ultra')
    expect('invalid' in ultra && ultra.invalid).toContain('delegation mode')
    const typo = resolveEffort('opencode', 'xhig')
    expect('invalid' in typo && typo.invalid).toContain("'xhig' is not an effort value for OpenCode")
    expect('invalid' in typo && typo.invalid).toContain('auto, keep, low, medium, high, xhigh, max')
    expect(resolveEffort('omp', 'none')).toHaveProperty('invalid')
    expect(resolveEffort('claude', 'off')).toHaveProperty('invalid')
  })

  test('the accepted values are exactly what config validation accepts', () => {
    for (const h of HARNESSES) {
      expect(effortConfigValues(h)).toEqual([...EFFORT_VALUES[h]])
      for (const v of EFFORT_VALUES[h]) expect(resolveEffort(h, v)).not.toHaveProperty('invalid')
    }
    const cfg = { ...defaultConfig(), effort: { ...defaultConfig().effort, claude: 'max' } }
    expect(validateConfig(cfg).ok).toBe(false)
  })

  test('effortRank orders levels and knows no modes', () => {
    expect(effortRank('claude', 'xhigh')).toBeGreaterThan(effortRank('claude', 'high') ?? Infinity)
    expect(effortRank('claude', 'max')).toBe(4)
    expect(effortRank('omp', 'auto')).toBeUndefined()
    expect(effortRank('codex', 'ultra')).toBeUndefined()
  })
})

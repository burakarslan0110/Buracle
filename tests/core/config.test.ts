import { describe, expect, test } from 'bun:test'
import { configSchemaLeaves, defaultConfig, mergeConfig, mergeConfigLenient, runtimeSnapshotConfig, validateConfig } from '../../src/core/config'

describe('the runtime snapshot', () => {
  test('a runtime snapshot of another version gives the defaults and says so; version 1 is merged', () => {
    const defaults = defaultConfig()
    const other = runtimeSnapshotConfig({ v: 2, config: { routing: { strictness: 'off' } } }, defaults)
    expect(other.config).toEqual(defaults)
    expect(other.warnings).toEqual(['runtime-config.json has version 2, this Buracle Stack reads version 1: the defaults apply until `buracle install` writes it again'])
    const ok = runtimeSnapshotConfig({ v: 1, config: { routing: { strictness: 'off' } } }, defaults)
    expect(ok.config.routing.strictness).toBe('off')
    expect(ok.warnings).toEqual([])
  })
})

describe('defaultConfig', () => {
  test('is valid and fresh on every call', () => {
    const a = defaultConfig()
    expect(validateConfig(a).ok).toBe(true)
    a.checkers.languages.push('cobol')
    a.harnesses.claude.enabled = false
    const b = defaultConfig()
    expect(b.checkers.languages).not.toContain('cobol')
    expect(b.harnesses.claude.enabled).toBe(true)
  })

  test('documented defaults', () => {
    const c = defaultConfig()
    expect('vault' in c).toBe(false)
    expect('context' in c).toBe(false)
    expect('runaway' in c.plan).toBe(false)
    expect(c.routing.strictness).toBe('enforce')
    expect(c.skills.sources).toEqual([{ name: 'buracle', path: 'canonical/skills' }])
  })

  test('the workflow switches: questions, the three independent reviews and goal-build verification on, no second opinion, no model-switch pause, no native plan mode', () => {
    const p = defaultConfig().plan
    expect({ questions: p.questions, reviews: p.reviews, goalVerification: p.goalVerification, modelSwitch: p.modelSwitch, nativePlanMode: p.nativePlanMode })
      .toEqual({ questions: true, reviews: { plan: true, changes: true, goal: true, companion: 'off' }, goalVerification: true, modelSwitch: 'off', nativePlanMode: 'off' })
  })
})

describe('configSchemaLeaves', () => {
  test('every setting the schema knows, with its type: a default exists for each one, and the plan switches are among them', () => {
    const all = configSchemaLeaves()
    const valueAt = (key: string): unknown => key.split('.').reduce<unknown>((o, k) => (o !== null && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), defaultConfig())
    for (const l of all.filter(x => x.key !== 'repo')) {
      const v = valueAt(l.key)
      expect({ key: l.key, type: Array.isArray(v) ? 'list' : typeof v }).toEqual({ key: l.key, type: l.t === 'bool' ? 'boolean' : l.t === 'int' ? 'number' : l.t === 'list' ? 'list' : 'string' })
    }
    expect(all.map(l => l.key)).not.toContain('version')
    const plan = configSchemaLeaves('plan')
    expect(plan.every(l => l.key.startsWith('plan.'))).toBe(true)
    expect(plan).toEqual(expect.arrayContaining([
      { key: 'plan.questions', t: 'bool' }, { key: 'plan.reviews.changes', t: 'bool' }, { key: 'plan.goalVerification', t: 'bool' },
      { key: 'plan.modelSwitch', t: 'enum', values: ['off', 'manual'] }, { key: 'plan.stopGuard', t: 'bool' }, { key: 'plan.nativePlanMode', t: 'enum', values: ['off', 'on'] },
    ]))
    expect(configSchemaLeaves('memory.ui')).toEqual([{ key: 'memory.ui.autostart', t: 'bool' }])
    expect(defaultConfig().memory.ui.autostart).toBe(true)
    const notBool = validateConfig({ ...defaultConfig(), memory: { ui: { autostart: 'yes' }, exclude: [] } })
    expect(notBool.ok ? [] : notBool.errors).toEqual([expect.stringContaining('memory.ui.autostart: expected boolean')])
  })
})

describe('the mcp section', () => {
  test('sharing is on and no server is off by default; shared must be a boolean and each harness list a list of server ids', () => {
    expect(defaultConfig().mcp).toEqual({ shared: true, off: { claude: [], codex: [], opencode: [], omp: [], qwen: [], pi: [], agy: [] } })
    expect(configSchemaLeaves('mcp')).toEqual([
      { key: 'mcp.shared', t: 'bool' },
      { key: 'mcp.off.claude', t: 'list' }, { key: 'mcp.off.codex', t: 'list' }, { key: 'mcp.off.opencode', t: 'list' }, { key: 'mcp.off.omp', t: 'list' },
      { key: 'mcp.off.qwen', t: 'list' }, { key: 'mcp.off.pi', t: 'list' }, { key: 'mcp.off.agy', t: 'list' },
    ])
    const bad = defaultConfig() as unknown as Record<string, any>
    bad.mcp.shared = 'yes'
    bad.mcp.off.codex = 'web-fetch'
    bad.mcp.off.omp = [1]
    bad.mcp.off.cursor = []
    const r = validateConfig(bad)
    expect(r.ok ? [] : r.errors).toEqual(expect.arrayContaining([
      'mcp.shared: expected boolean, got string "yes"',
      'mcp.off.codex: expected array, got string "web-fetch"',
      'mcp.off.omp[0]: expected string, got number 1',
      'mcp.off.cursor: unknown key',
    ]))
    expect(mergeConfigLenient(defaultConfig(), { mcp: { shared: false, off: { codex: ['web-fetch'] } } }).config.mcp).toEqual({ shared: false, off: { claude: [], codex: ['web-fetch'], opencode: [], omp: [], qwen: [], pi: [], agy: [] } })
  })
})

describe('validateConfig', () => {
  test('reports dotted paths for every problem', () => {
    const bad = defaultConfig() as unknown as Record<string, any>
    bad.routing.strictness = 'strict'
    bad.update.minReleaseAgeDays = -1
    bad.memory.exclude = 1.5
    bad.harnesses.cursor = { enabled: true }
    delete bad.memory.ui.autostart
    bad.skills.sources = [{ name: 'x' }]
    const r = validateConfig(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContain('routing.strictness: expected one of enforce | nudge | off, got string "strict"')
    expect(r.errors).toContain('update.minReleaseAgeDays: must be >= 0, got -1')
    expect(r.errors).toContain('memory.exclude: expected array, got number 1.5')
    expect(validateConfig({ ...defaultConfig(), update: { minReleaseAgeDays: 1.5 } })).toEqual({ ok: false, errors: ['update.minReleaseAgeDays: expected integer, got number 1.5'] })
    expect(r.errors).toContain('harnesses.cursor: unknown key')
    expect(r.errors).toContain('memory.ui.autostart: missing')
    expect(r.errors).toContain('skills.sources[0]: needs exactly one of `path` or `git`')
  })

  test('the workflow switches are checked like every other key', () => {
    const bad = defaultConfig() as unknown as Record<string, any>
    bad.plan.modelSwitch = 'auto'
    bad.plan.nativePlanMode = true
    bad.plan.reviews.changes = 'no'
    bad.plan.reviews.companion = true
    bad.plan.questions = 1
    const r = validateConfig(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual(expect.arrayContaining([
      'plan.modelSwitch: expected one of off | manual, got string "auto"',
      'plan.nativePlanMode: expected one of off | on, got boolean true',
      'plan.reviews.changes: expected boolean, got string "no"',
      'plan.reviews.companion: expected one of off | auto | claude | codex | opencode | omp | qwen | pi | agy, got boolean true',
      'plan.questions: expected boolean, got number 1',
    ]))
    const lenient = mergeConfigLenient(defaultConfig(), { plan: { modelSwitch: 'manual', reviews: { changes: false, companion: 'gemini' }, goalVerification: 'off' } })
    expect(lenient.config.plan.modelSwitch).toBe('manual')
    expect(lenient.config.plan.reviews).toEqual({ plan: true, changes: false, goal: true, companion: 'off' })
    expect(mergeConfigLenient(defaultConfig(), { plan: { reviews: { companion: 'codex' } } }).config.plan.reviews.companion).toBe('codex')
    expect(lenient.config.plan.goalVerification).toBe(true)
    expect(lenient.errors).toEqual(['plan.reviews.companion: expected one of off | auto | claude | codex | opencode | omp | qwen | pi | agy, got string "gemini"', 'plan.goalVerification: expected boolean, got string "off"'])
  })

  test('cross checks', () => {
    expect(validateConfig({ ...defaultConfig(), context: { warnPct: 96, criticalPct: 95 } })).toEqual({ ok: false, errors: ['context: unknown key'] })
    const d = defaultConfig()
    d.skills.sources = [{ name: 'a', git: 'https://x/y.git', ref: 'main' }, { name: 'a', path: 'p', ref: 'v1' }]
    const r = validateConfig(d)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors).toContain('skills.sources[1].ref: `ref` is only valid with `git`')
      expect(r.errors).toContain('skills.sources[1].name: duplicate source name "a"')
    }
  })

  test('rejects non-objects', () => {
    expect(validateConfig(null)).toEqual({ ok: false, errors: ['(root): expected mapping, got null'] })
    expect(validateConfig([]).ok).toBe(false)
  })
})

describe('mergeConfig', () => {
  test('deep merges mappings, replaces arrays and ignores null', () => {
    const merged = mergeConfig(defaultConfig(), {
      routing: { strictness: 'nudge' },
      checkers: { languages: ['go'] },
      memory: { ui: { autostart: false } },
      update: null,
      repo: '/src/buracle',
    })
    expect(merged.routing.strictness).toBe('nudge')
    expect(merged.checkers).toEqual({ enabled: true, languages: ['go'] })
    expect(merged.memory).toEqual({ ui: { autostart: false }, exclude: [] })
    expect(merged.update).toEqual({ minReleaseAgeDays: 0 })
    expect(merged.repo).toBe('/src/buracle')
  })

  test('does not mutate its inputs', () => {
    const base = defaultConfig()
    const override = { checkers: { languages: ['go'] } }
    const merged = mergeConfig(base, override)
    merged.checkers.languages.push('rust')
    expect(base.checkers.languages).toEqual(defaultConfig().checkers.languages)
    expect(override.checkers.languages).toEqual(['go'])
  })

  test('undefined and null overrides return the base', () => {
    expect(mergeConfig(defaultConfig(), undefined)).toEqual(defaultConfig())
    expect(mergeConfig(defaultConfig(), null)).toEqual(defaultConfig())
  })

  test('throws on invalid results and non-mappings', () => {
    expect(() => mergeConfig(defaultConfig(), { routing: { strictness: 'loose' } })).toThrow(/routing\.strictness/)
    expect(() => mergeConfig(defaultConfig(), { routng: {} })).toThrow(/routng: unknown key/)
    expect(() => mergeConfig(defaultConfig(), 'oops')).toThrow(/expected a mapping/)
    expect(() => mergeConfig(defaultConfig(), [1])).toThrow(/expected a mapping/)
  })

  test('ignores prototype-polluting keys', () => {
    const merged = mergeConfig(defaultConfig(), JSON.parse('{"__proto__": {"polluted": true}, "routing": {"strictness": "off"}}'))
    expect(merged.routing.strictness).toBe('off')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('mergeConfigLenient', () => {
  test('keeps valid values and drops invalid ones with errors', () => {
    const r = mergeConfigLenient(defaultConfig(), {
      routing: { strictness: 'nope' },
      statusline: { style: 'compact', emoji: 'yes' },
      typo: 1,
      checkers: { languages: ['go', 7] },
    })
    expect(r.config.routing.strictness).toBe('enforce')
    expect(r.config.statusline).toEqual({ style: 'compact', emoji: true })
    expect(r.config.checkers.languages).toEqual(defaultConfig().checkers.languages)
    expect((r.config as unknown as Record<string, unknown>)['typo']).toBeUndefined()
    expect(validateConfig(r.config).ok).toBe(true)
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('routing.strictness'),
      expect.stringContaining('statusline.emoji'),
      'typo: unknown key',
      expect.stringContaining('checkers.languages[1]'),
    ]))
  })

  test('resolves cross-field conflicts by reverting the parent', () => {
    const r = mergeConfigLenient(defaultConfig(), { skills: { sources: [{ name: 'a' }] } })
    expect(r.config.skills).toEqual(defaultConfig().skills)
    expect(r.errors.length).toBeGreaterThan(0)
  })

  test('non-mapping override keeps the base', () => {
    const r = mergeConfigLenient(defaultConfig(), 42)
    expect(r.config).toEqual(defaultConfig())
    expect(r.errors).toEqual(['(root): expected a mapping, got number 42'])
  })

  test('valid override has no errors', () => {
    const r = mergeConfigLenient(defaultConfig(), { harnesses: { omp: { enabled: false } } })
    expect(r.errors).toEqual([])
    expect(r.config.harnesses.omp.enabled).toBe(false)
  })
})

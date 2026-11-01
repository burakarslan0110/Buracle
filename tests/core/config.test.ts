import { describe, expect, test } from 'bun:test'
import { CONFIG_REMOVALS, CONFIG_RENAMES, configSchemaLeaves, defaultConfig, mergeConfig, mergeConfigLenient, migrateConfig, runtimeSnapshotConfig, validateConfig, type ConfigRename } from '../../src/core/config'

describe('config migration (renamed keys)', () => {
  const renames: ConfigRename[] = [{ from: 'perms.enforced', to: 'permissions.enforce', since: '0.9.0' }]

  test('a value under a renamed key moves to its new key and is reported; the old key is gone', () => {
    const r = migrateConfig({ perms: { enforced: false }, routing: { strictness: 'nudge' } }, renames)
    expect(r.value).toEqual({ permissions: { enforce: false }, routing: { strictness: 'nudge' } })
    expect(r.notes).toEqual(['perms.enforced was renamed to permissions.enforce in 0.9.0; its value was used (rename the key in config.yaml)'])
    expect(mergeConfigLenient(defaultConfig(), { perms: { enforced: false } }, []).config.permissions.enforce).toBe(true)
    const merged = mergeConfigLenient(defaultConfig(), { perms: { enforced: false } }, renames)
    expect(merged.config.permissions.enforce).toBe(false)
    expect(merged.errors).toEqual([])
    expect(merged.warnings).toEqual(r.notes)
  })

  test('when the new key is set too, it wins and the old one is reported as ignored', () => {
    const r = migrateConfig({ perms: { enforced: false }, permissions: { enforce: true } }, renames)
    expect(r.value).toEqual({ permissions: { enforce: true } })
    expect(r.notes).toEqual(['perms.enforced was renamed to permissions.enforce in 0.9.0; permissions.enforce is set too, so perms.enforced is ignored (remove it from config.yaml)'])
  })

  test('nothing to migrate leaves the value as it is; the shipped table renames nothing now (the memory model keys left with memory.llm)', () => {
    const raw = { routing: { strictness: 'off' } }
    expect(migrateConfig(raw, renames)).toEqual({ value: raw, notes: [] })
    expect(migrateConfig(42, renames)).toEqual({ value: 42, notes: [] })
    expect(CONFIG_RENAMES).toEqual([])
    expect(migrateConfig({ memory: { reflect: { provider: 'api' } } }).value).toEqual({})
  })

  test('removed keys (the vault memory, the memory switches, budgets, model and embedder, Context Mode) are dropped: quietly at their shipped default, with a note otherwise', () => {
    expect(CONFIG_REMOVALS.map(r => r.key)).toEqual([
      'vault', 'memory.qmd', 'memory.git', 'memory.reflect.model',
      'memory.inject', 'memory.distill',
      'memory.reflect.auto', 'memory.reflect.maxRunsPerDay', 'memory.reflect.maxOpsPerRun', 'memory.reflect.maxSubQueries', 'memory.reflect.maxRounds', 'memory.reflect.maxInputTokens', 'memory.reflect.maxOutputTokens', 'memory.reflect.minIntervalMin',
      'memory.verify', 'memory.heal', 'memory.profile', 'memory.ui.enabled',
      'memory.reflect.provider', 'memory.reflect.api', 'memory.llm', 'memory.embed',
      'contextMode',
    ])
    expect(migrateConfig({ memory: { llm: { provider: 'auto', api: { format: 'openai', url: '', model: '', keyEnv: '' } }, embed: { url: '', model: '', dim: 0, keyEnv: '' } } }, [])).toEqual({ value: {}, notes: [] })
    expect(migrateConfig({ contextMode: { enabled: true, capture: true } }, [])).toEqual({ value: {}, notes: [] })
    expect(migrateConfig({ contextMode: { enabled: false }, routing: { strictness: 'nudge' } }, [])).toEqual({
      value: { routing: { strictness: 'nudge' } },
      notes: ['contextMode was removed in 0.6.0 (Context Mode and its context-mode MCP server are gone; the handoff memory and the compaction restore carry the session state); its value is ignored (remove it from config.yaml)'],
    })
    expect(migrateConfig({ memory: { llm: { provider: 'api', api: { url: 'https://openrouter.ai/api/v1' } } } }, []).notes).toEqual([
      'memory.llm was removed in 0.5.0 (the memory\'s model calls run through a harness with usage headroom; there is no external API); its value is ignored (remove it from config.yaml)',
    ])
    expect(migrateConfig({ memory: { reflect: { model: 'haiku', auto: true } } }, [])).toEqual({ value: {}, notes: [] })
    expect(migrateConfig({ memory: { reflect: { model: 'sonnet' } } }, []).notes).toEqual([
      'memory.reflect.model was removed in 0.5.0 (reflect runs the model of the session\'s own harness); its value is ignored (remove it from config.yaml)',
    ])
    const quiet = migrateConfig({ vault: '~/Documents/Buracle', memory: { git: { autoCommit: true, debounceMin: 10 }, profile: { enabled: true }, distill: { auto: true, promote: 'medium' } } }, [])
    expect(quiet).toEqual({ value: {}, notes: [] })
    // memory.ui.autostart is a live setting again (0.6.0): a value an older config still holds is kept, with no note.
    expect(migrateConfig({ memory: { profile: { enabled: false }, ui: { autostart: false, port: 41800 } } }, [])).toEqual({
      value: { memory: { ui: { autostart: false, port: 41800 } } },
      notes: ['memory.profile was removed in 0.5.0 (the memory has no background jobs any more; its model-assisted capture runs once at the end of a session, within fixed budgets (src/core/memory/budgets.ts)); its value is ignored (remove it from config.yaml)'],
    })
    expect(migrateConfig({ memory: { reflect: { provider: 'api', auto: false, maxRounds: 2 } } })).toEqual({
      value: {},
      notes: [
        'memory.reflect.auto was removed in 0.5.0 (the memory has no background jobs any more; its model-assisted capture runs once at the end of a session, within fixed budgets (src/core/memory/budgets.ts)); its value is ignored (remove it from config.yaml)',
        'memory.reflect.provider was removed in 0.5.0 (the memory\'s model calls run through a harness with usage headroom; there is no external API); its value is ignored (remove it from config.yaml)',
      ],
    })
    const loud = migrateConfig({ vault: '~/Notes', memory: { qmd: { enabled: true } } }, [])
    expect(loud.value).toEqual({})
    expect(loud.notes).toEqual([
      'vault was removed in 0.5.0 (the memory moved from the Obsidian vault to CortexDB under ~/.buracle/brain); its value is ignored (remove it from config.yaml)',
      'memory.qmd was removed in 0.5.0 (CortexDB does the search); its value is ignored (remove it from config.yaml)',
    ])
    const merged = mergeConfigLenient(defaultConfig(), { vault: '~/Notes' })
    expect(merged.errors).toEqual([])
    expect('vault' in merged.config).toBe(false)
  })

  test('a runtime snapshot of another version gives the defaults and says so; version 1 is merged', () => {
    const defaults = defaultConfig()
    const other = runtimeSnapshotConfig({ v: 2, config: { routing: { strictness: 'off' } } }, defaults)
    expect(other.config).toEqual(defaults)
    expect(other.warnings).toEqual(['runtime-config.json has version 2, this Buracle reads version 1: the defaults apply until `buracle install` writes it again'])
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
    expect(c.context).toEqual({ warnPct: 85, criticalPct: 95 })
    expect(c.plan.runaway).toEqual({ perPlan: 30, perChain: 5 })
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
      { key: 'plan.modelSwitch', t: 'enum', values: ['off', 'manual'] }, { key: 'plan.runaway.perPlan', t: 'int', min: 1 }, { key: 'plan.worktreeDir', t: 'str' },
    ]))
    expect(configSchemaLeaves('memory.ui')).toEqual([{ key: 'memory.ui.port', t: 'int', min: 1024, max: 65535 }, { key: 'memory.ui.autostart', t: 'bool' }])
    expect(defaultConfig().memory.ui.autostart).toBe(true)
    const notBool = validateConfig({ ...defaultConfig(), memory: { ui: { port: 41777, autostart: 'yes' }, exclude: [] } })
    expect(notBool.ok ? [] : notBool.errors).toEqual([expect.stringContaining('memory.ui.autostart: expected boolean')])
  })
})

describe('validateConfig', () => {
  test('reports dotted paths for every problem', () => {
    const bad = defaultConfig() as unknown as Record<string, any>
    bad.routing.strictness = 'strict'
    bad.context.warnPct = 120
    bad.plan.runaway.perPlan = 1.5
    bad.harnesses.cursor = { enabled: true }
    delete bad.memory.ui.port
    bad.skills.sources = [{ name: 'x' }]
    const r = validateConfig(bad)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContain('routing.strictness: expected one of enforce | nudge | off, got string "strict"')
    expect(r.errors).toContain('context.warnPct: must be <= 100, got 120')
    expect(r.errors).toContain('plan.runaway.perPlan: expected integer, got number 1.5')
    expect(r.errors).toContain('harnesses.cursor: unknown key')
    expect(r.errors).toContain('memory.ui.port: missing')
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
      'plan.reviews.companion: expected one of off | auto | claude | codex | opencode | omp, got boolean true',
      'plan.questions: expected boolean, got number 1',
    ]))
    const lenient = mergeConfigLenient(defaultConfig(), { plan: { modelSwitch: 'manual', reviews: { changes: false, companion: 'gemini' }, goalVerification: 'off' } })
    expect(lenient.config.plan.modelSwitch).toBe('manual')
    expect(lenient.config.plan.reviews).toEqual({ plan: true, changes: false, goal: true, companion: 'off' })
    expect(mergeConfigLenient(defaultConfig(), { plan: { reviews: { companion: 'codex' } } }).config.plan.reviews.companion).toBe('codex')
    expect(lenient.config.plan.goalVerification).toBe(true)
    expect(lenient.errors).toEqual(['plan.reviews.companion: expected one of off | auto | claude | codex | opencode | omp, got string "gemini"', 'plan.goalVerification: expected boolean, got string "off"'])
  })

  test('cross checks', () => {
    const c = defaultConfig()
    c.context.warnPct = 96
    expect(validateConfig(c)).toEqual({ ok: false, errors: ['context.warnPct: must be lower than context.criticalPct'] })
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
      memory: { ui: { port: 41800 } },
      context: null,
      repo: '/src/buracle',
    })
    expect(merged.routing.strictness).toBe('nudge')
    expect(merged.checkers).toEqual({ enabled: true, timeoutMs: 20000, languages: ['go'] })
    expect(merged.memory).toEqual({ ui: { port: 41800, autostart: true }, exclude: [] })
    expect(merged.context).toEqual({ warnPct: 85, criticalPct: 95 })
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
    expect(r.config.statusline).toEqual({ style: 'compact', emoji: true, monthly: 'estimate' })
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
    const r = mergeConfigLenient(defaultConfig(), { context: { criticalPct: 80 } })
    expect(r.config.context).toEqual({ warnPct: 85, criticalPct: 95 })
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

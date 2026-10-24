import type { Harness } from './events'
import { HARNESSES } from './events'

export type CompanionSetting = 'off' | 'auto' | Harness
export const COMPANION_SETTINGS: readonly CompanionSetting[] = ['off', 'auto', ...HARNESSES]

export interface BuracleConfig {
  version: 1
  repo?: string
  harnesses: Record<Harness, { enabled: boolean }>
  routing: { strictness: 'enforce' | 'nudge' | 'off', skills: 'router' | 'off', reminders: boolean }
  guards: { bash: { extraDeny: string[] }, write: { protect: string[] }, redact: boolean }
  plan: {
    stopGuard: boolean, runaway: { perPlan: number, perChain: number }, autoPause: boolean, planApproval: boolean, resultApproval: boolean, branchIsolation: boolean, worktreeDir: string
    questions: boolean, reviews: { plan: boolean, changes: boolean, goal: boolean, companion: CompanionSetting }, goalVerification: boolean, modelSwitch: 'off' | 'manual', nativePlanMode: 'off' | 'on'
  }
  context: { warnPct: number, criticalPct: number }
  checkers: { enabled: boolean, timeoutMs: number, languages: string[] }
  memory: { ui: { port: number }, exclude: string[] }
  statusline: { style: 'buracle' | 'full' | 'compact', emoji: boolean, monthly: 'estimate' | 'off' }
  skills: { sources: Array<{ name: string, path?: string, git?: string, ref?: string }> }
  update: { minReleaseAgeDays: number }
  permissions: { bypass: boolean, enforce: boolean }
  effort: Record<Harness, string>
  agents: { teams: boolean }
  workflow: { band: boolean, foldAfterSec: number, notifyAfterSec: number, codexNotices: boolean }
  toolchain: { autoInstall: boolean, system: boolean, upgrade: boolean }
  index: { auto: boolean, codegraph: boolean, semble: boolean, minIntervalMin: number, exclude: string[], children: boolean, maxChildren: number }
}

export function defaultConfig(): BuracleConfig {
  return {
    version: 1,
    harnesses: {
      claude: { enabled: true },
      codex: { enabled: true },
      opencode: { enabled: true },
      omp: { enabled: true },
    },
    routing: { strictness: 'enforce', skills: 'router', reminders: true },
    guards: { bash: { extraDeny: [] }, write: { protect: [] }, redact: true },
    plan: {
      stopGuard: true,
      runaway: { perPlan: 30, perChain: 5 },
      autoPause: false,
      planApproval: true,
      resultApproval: true,
      branchIsolation: true,
      worktreeDir: '.worktrees',
      questions: true,
      reviews: { plan: true, changes: true, goal: true, companion: 'off' },
      goalVerification: true,
      modelSwitch: 'off',
      nativePlanMode: 'off',
    },
    context: { warnPct: 85, criticalPct: 95 },
    checkers: { enabled: true, timeoutMs: 20000, languages: ['python', 'typescript', 'javascript', 'go', 'shell', 'dotnet'] },
    memory: {
      ui: { port: 41777 },
      exclude: [],
    },
    statusline: { style: 'buracle', emoji: true, monthly: 'estimate' },
    skills: { sources: [{ name: 'buracle', path: 'canonical/skills' }] },
    update: { minReleaseAgeDays: 0 },
    permissions: { bypass: true, enforce: true },
    effort: { claude: 'auto', codex: 'auto', opencode: 'auto', omp: 'auto' },
    agents: { teams: true },
    workflow: { band: true, foldAfterSec: 8, notifyAfterSec: 120, codexNotices: true },
    toolchain: { autoInstall: true, system: true, upgrade: true },
    index: { auto: true, codegraph: true, semble: true, minIntervalMin: 10, exclude: [], children: true, maxChildren: 8 },
  }
}

type Schema =
  | { t: 'bool' }
  | { t: 'int', min?: number, max?: number }
  | { t: 'str', nonEmpty?: boolean }
  | { t: 'enum', values: readonly string[] }
  | { t: 'lit', value: number }
  | { t: 'arr', of: Schema }
  | { t: 'obj', fields: Readonly<Record<string, Schema>>, optional?: readonly string[] }

const bool: Schema = { t: 'bool' }
const str: Schema = { t: 'str' }
const nonEmpty: Schema = { t: 'str', nonEmpty: true }
const pct: Schema = { t: 'int', min: 0, max: 100 }
const count = (min: number): Schema => ({ t: 'int', min })
const strList: Schema = { t: 'arr', of: str }

const harnessFields: Record<string, Schema> = {}
for (const h of HARNESSES) harnessFields[h] = { t: 'obj', fields: { enabled: bool } }
export const EFFORT_VALUES: Readonly<Record<Harness, readonly string[]>> = {
  claude: ['auto', 'keep', 'low', 'medium', 'high', 'xhigh'],
  codex: ['auto', 'keep', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  opencode: ['auto', 'keep', 'low', 'medium', 'high', 'xhigh', 'max'],
  omp: ['auto', 'keep', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'classifier'],
}
const effortFields: Record<string, Schema> = {}
for (const h of HARNESSES) effortFields[h] = { t: 'enum', values: EFFORT_VALUES[h] }

const CONFIG_SCHEMA: Schema = {
  t: 'obj',
  optional: ['repo'],
  fields: {
    version: { t: 'lit', value: 1 },
    repo: nonEmpty,
    harnesses: { t: 'obj', fields: harnessFields },
    routing: {
      t: 'obj',
      fields: {
        strictness: { t: 'enum', values: ['enforce', 'nudge', 'off'] },
        skills: { t: 'enum', values: ['router', 'off'] },
        reminders: bool,
      },
    },
    guards: {
      t: 'obj',
      fields: {
        bash: { t: 'obj', fields: { extraDeny: strList } },
        write: { t: 'obj', fields: { protect: strList } },
        redact: bool,
      },
    },
    plan: {
      t: 'obj',
      fields: {
        stopGuard: bool,
        runaway: { t: 'obj', fields: { perPlan: count(1), perChain: count(1) } },
        autoPause: bool,
        planApproval: bool,
        resultApproval: bool,
        branchIsolation: bool,
        worktreeDir: nonEmpty,
        questions: bool,
        reviews: { t: 'obj', fields: { plan: bool, changes: bool, goal: bool, companion: { t: 'enum', values: COMPANION_SETTINGS } } },
        goalVerification: bool,
        modelSwitch: { t: 'enum', values: ['off', 'manual'] },
        nativePlanMode: { t: 'enum', values: ['off', 'on'] },
      },
    },
    context: { t: 'obj', fields: { warnPct: pct, criticalPct: pct } },
    checkers: { t: 'obj', fields: { enabled: bool, timeoutMs: count(100), languages: strList } },
    memory: {
      t: 'obj',
      fields: {
        ui: { t: 'obj', fields: { port: { t: 'int', min: 1024, max: 65535 } } },
        exclude: strList,
      },
    },
    statusline: {
      t: 'obj',
      fields: {
        style: { t: 'enum', values: ['buracle', 'full', 'compact'] },
        emoji: bool,
        monthly: { t: 'enum', values: ['estimate', 'off'] },
      },
    },
    skills: {
      t: 'obj',
      fields: {
        sources: {
          t: 'arr',
          of: { t: 'obj', optional: ['path', 'git', 'ref'], fields: { name: nonEmpty, path: nonEmpty, git: nonEmpty, ref: nonEmpty } },
        },
      },
    },
    update: { t: 'obj', fields: { minReleaseAgeDays: count(0) } },
    permissions: { t: 'obj', fields: { bypass: bool, enforce: bool } },
    effort: { t: 'obj', fields: effortFields },
    agents: { t: 'obj', fields: { teams: bool } },
    workflow: { t: 'obj', fields: { band: bool, foldAfterSec: count(0), notifyAfterSec: count(0), codexNotices: bool } },
    toolchain: { t: 'obj', fields: { autoInstall: bool, system: bool, upgrade: bool } },
    index: { t: 'obj', fields: { auto: bool, codegraph: bool, semble: bool, minIntervalMin: count(0), exclude: strList, children: bool, maxChildren: count(0) } },
  },
}

export type ConfigLeaf =
  | { key: string, t: 'bool' }
  | { key: string, t: 'int', min?: number, max?: number }
  | { key: string, t: 'str' }
  | { key: string, t: 'enum', values: readonly string[] }
  | { key: string, t: 'list' }

function leaves(schema: Schema, path: string, out: ConfigLeaf[]): void {
  switch (schema.t) {
    case 'obj':
      for (const [k, sub] of Object.entries(schema.fields)) leaves(sub, path === '' ? k : `${path}.${k}`, out)
      return
    case 'bool': out.push({ key: path, t: 'bool' }); return
    case 'int': out.push({ key: path, t: 'int', ...(schema.min !== undefined ? { min: schema.min } : {}), ...(schema.max !== undefined ? { max: schema.max } : {}) }); return
    case 'str': out.push({ key: path, t: 'str' }); return
    case 'enum': out.push({ key: path, t: 'enum', values: schema.values }); return
    case 'arr': out.push({ key: path, t: 'list' }); return
    case 'lit': return
  }
}

export function configSchemaLeaves(prefix = ''): ConfigLeaf[] {
  const out: ConfigLeaf[] = []
  leaves(CONFIG_SCHEMA, '', out)
  return prefix === '' ? out : out.filter(l => l.key === prefix || l.key.startsWith(`${prefix}.`))
}

interface Issue { path: Array<string | number>; message: string }

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const proto = Object.getPrototypeOf(x) as unknown
  return proto === Object.prototype || proto === null
}

function describe(x: unknown): string {
  if (x === null) return 'null'
  if (Array.isArray(x)) return 'array'
  if (typeof x === 'string') return `string ${JSON.stringify(x.length > 40 ? x.slice(0, 40) + '…' : x)}`
  if (typeof x === 'number' || typeof x === 'boolean') return `${typeof x} ${String(x)}`
  return typeof x
}

function check(schema: Schema, x: unknown, path: Array<string | number>, out: Issue[]): void {
  switch (schema.t) {
    case 'bool':
      if (typeof x !== 'boolean') out.push({ path, message: `expected boolean, got ${describe(x)}` })
      return
    case 'int':
      if (typeof x !== 'number' || !Number.isInteger(x)) { out.push({ path, message: `expected integer, got ${describe(x)}` }); return }
      if (schema.min !== undefined && x < schema.min) out.push({ path, message: `must be >= ${schema.min}, got ${x}` })
      if (schema.max !== undefined && x > schema.max) out.push({ path, message: `must be <= ${schema.max}, got ${x}` })
      return
    case 'str':
      if (typeof x !== 'string') { out.push({ path, message: `expected string, got ${describe(x)}` }); return }
      if (schema.nonEmpty && x.trim() === '') out.push({ path, message: 'must not be empty' })
      return
    case 'enum':
      if (typeof x !== 'string' || !schema.values.includes(x)) out.push({ path, message: `expected one of ${schema.values.join(' | ')}, got ${describe(x)}` })
      return
    case 'lit':
      if (x !== schema.value) out.push({ path, message: `expected ${schema.value}, got ${describe(x)}` })
      return
    case 'arr':
      if (!Array.isArray(x)) { out.push({ path, message: `expected array, got ${describe(x)}` }); return }
      x.forEach((item, i) => check(schema.of, item, [...path, i], out))
      return
    case 'obj': {
      if (!isPlainObject(x)) { out.push({ path, message: `expected mapping, got ${describe(x)}` }); return }
      const optional = schema.optional ?? []
      for (const [k, sub] of Object.entries(schema.fields)) {
        if (!(k in x) || x[k] === undefined) {
          if (!optional.includes(k)) out.push({ path: [...path, k], message: 'missing' })
          continue
        }
        check(sub, x[k], [...path, k], out)
      }
      for (const k of Object.keys(x)) {
        if (!Object.prototype.hasOwnProperty.call(schema.fields, k)) out.push({ path: [...path, k], message: 'unknown key' })
      }
      return
    }
  }
}

function crossChecks(x: Record<string, unknown>, out: Issue[]): void {
  const ctx = x['context']
  if (isPlainObject(ctx) && typeof ctx['warnPct'] === 'number' && typeof ctx['criticalPct'] === 'number' && ctx['warnPct'] >= ctx['criticalPct']) {
    out.push({ path: ['context', 'warnPct'], message: 'must be lower than context.criticalPct' })
  }
  const skills = x['skills']
  const sources = isPlainObject(skills) ? skills['sources'] : undefined
  if (Array.isArray(sources)) {
    const names = new Set<string>()
    sources.forEach((s, i) => {
      if (!isPlainObject(s)) return
      const hasPath = typeof s['path'] === 'string'
      const hasGit = typeof s['git'] === 'string'
      if (hasPath === hasGit) out.push({ path: ['skills', 'sources', i], message: 'needs exactly one of `path` or `git`' })
      if (s['ref'] !== undefined && !hasGit) out.push({ path: ['skills', 'sources', i, 'ref'], message: '`ref` is only valid with `git`' })
      const name = s['name']
      if (typeof name === 'string') {
        if (names.has(name)) out.push({ path: ['skills', 'sources', i, 'name'], message: `duplicate source name ${JSON.stringify(name)}` })
        names.add(name)
      }
    })
  }
}

function issues(x: unknown): Issue[] {
  const out: Issue[] = []
  check(CONFIG_SCHEMA, x, [], out)
  if (isPlainObject(x)) crossChecks(x, out)
  return out
}

function formatPath(path: Array<string | number>): string {
  if (path.length === 0) return '(root)'
  let s = ''
  for (const seg of path) s += typeof seg === 'number' ? `[${seg}]` : (s === '' ? seg : `.${seg}`)
  return s
}

function formatIssue(i: Issue): string {
  return `${formatPath(i.path)}: ${i.message}`
}

function clone<T>(x: T): T {
  if (Array.isArray(x)) return x.map(clone) as unknown as T
  if (isPlainObject(x)) {
    const o: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(x)) o[k] = clone(v)
    return o as T
  }
  return x
}

export function validateConfig(x: unknown): { ok: true, config: BuracleConfig } | { ok: false, errors: string[] } {
  const found = issues(x)
  if (found.length > 0) return { ok: false, errors: found.map(formatIssue) }
  return { ok: true, config: clone(x) as BuracleConfig }
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined || override === null) return clone(base)
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = clone(base)
    for (const [k, v] of Object.entries(override)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      if (v === undefined || v === null) continue
      out[k] = k in out ? deepMerge(out[k], v) : clone(v)
    }
    return out
  }
  return clone(override)
}

export function mergeConfig(base: BuracleConfig, override: unknown): BuracleConfig {
  if (override !== undefined && override !== null && !isPlainObject(override)) {
    throw new Error(`invalid config: expected a mapping at the top level, got ${describe(override)}`)
  }
  const merged = deepMerge(base, override)
  const v = validateConfig(merged)
  if (!v.ok) throw new Error(`invalid config:\n- ${v.errors.join('\n- ')}`)
  return v.config
}

function getAt(x: unknown, path: ReadonlyArray<string | number>): { found: boolean, value: unknown } {
  let cur: unknown = x
  for (const seg of path) {
    if (Array.isArray(cur) && typeof seg === 'number') { if (seg >= cur.length) return { found: false, value: undefined }; cur = cur[seg]; continue }
    if (isPlainObject(cur) && typeof seg === 'string' && Object.prototype.hasOwnProperty.call(cur, seg)) { cur = cur[seg]; continue }
    return { found: false, value: undefined }
  }
  return { found: true, value: cur }
}

function setAt(x: Record<string, unknown>, path: ReadonlyArray<string | number>, value: unknown, remove: boolean): void {
  let cur: unknown = x
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]
    if (seg === undefined) return
    const next: unknown = Array.isArray(cur) && typeof seg === 'number' ? cur[seg] : isPlainObject(cur) && typeof seg === 'string' ? cur[seg] : undefined
    if (next === undefined) return
    cur = next
  }
  const last = path[path.length - 1]
  if (last === undefined) return
  if (isPlainObject(cur) && typeof last === 'string') {
    if (remove) delete cur[last]
    else cur[last] = clone(value)
  } else if (Array.isArray(cur) && typeof last === 'number') {
    cur[last] = clone(value)
  }
}

export interface ConfigRename { from: string; to: string; since: string }

export const CONFIG_RENAMES: readonly ConfigRename[] = [
]

export interface ConfigRemoval { key: string; since: string; why: string; quietWhen?: unknown }

const ALWAYS_ON = 'the memory has no background jobs any more; its model-assisted capture runs once at the end of a session, within fixed budgets (src/core/memory/budgets.ts)'

export const CONFIG_REMOVALS: readonly ConfigRemoval[] = [
  { key: 'vault', since: '0.5.0', why: 'the memory moved from the Obsidian vault to CortexDB under ~/.buracle/brain', quietWhen: '~/Documents/Buracle' },
  { key: 'memory.qmd', since: '0.5.0', why: 'CortexDB does the search', quietWhen: { enabled: false, url: 'http://127.0.0.1:8181' } },
  { key: 'memory.git', since: '0.5.0', why: 'the memory is no longer a git repository', quietWhen: { autoCommit: true, debounceMin: 10 } },
  { key: 'memory.reflect.model', since: '0.5.0', why: 'reflect runs the model of the session\'s own harness', quietWhen: 'haiku' },
  { key: 'memory.inject', since: '0.5.0', why: 'the session-start text has a fixed budget (150 lines, 12 KiB)', quietWhen: { maxLines: 150, maxBytes: 12288 } },
  { key: 'memory.distill', since: '0.5.0', why: ALWAYS_ON, quietWhen: { auto: true, promote: 'medium', maxRunsPerDay: 20, maxInputTokens: 8000, maxOutputTokens: 800, skip5hPct: 75, skip7dPct: 85 } },
  { key: 'memory.reflect.auto', since: '0.5.0', why: ALWAYS_ON, quietWhen: true },
  { key: 'memory.reflect.maxRunsPerDay', since: '0.5.0', why: ALWAYS_ON, quietWhen: 6 },
  { key: 'memory.reflect.maxOpsPerRun', since: '0.5.0', why: ALWAYS_ON, quietWhen: 8 },
  { key: 'memory.reflect.maxSubQueries', since: '0.5.0', why: ALWAYS_ON, quietWhen: 6 },
  { key: 'memory.reflect.maxRounds', since: '0.5.0', why: ALWAYS_ON, quietWhen: 2 },
  { key: 'memory.reflect.maxInputTokens', since: '0.5.0', why: ALWAYS_ON, quietWhen: 6000 },
  { key: 'memory.reflect.maxOutputTokens', since: '0.5.0', why: ALWAYS_ON, quietWhen: 700 },
  { key: 'memory.reflect.minIntervalMin', since: '0.5.0', why: ALWAYS_ON, quietWhen: 60 },
  { key: 'memory.verify', since: '0.5.0', why: ALWAYS_ON, quietWhen: { auto: true, maxRunsPerDay: 4, maxPerRun: 4, maxInputTokens: 8000, maxOutputTokens: 900, minIntervalMin: 60 } },
  { key: 'memory.heal', since: '0.5.0', why: ALWAYS_ON, quietWhen: { auto: true } },
  { key: 'memory.profile', since: '0.5.0', why: ALWAYS_ON, quietWhen: { enabled: true, statements: true } },
  { key: 'memory.ui.enabled', since: '0.5.0', why: 'the brain web UI is always available; it starts only when you run `buracle mem ui`', quietWhen: true },
  { key: 'memory.ui.autostart', since: '0.5.0', why: 'the brain web UI no longer starts with a session; it starts only when you run `buracle mem ui`', quietWhen: true },
  { key: 'memory.reflect.provider', since: '0.5.0', why: 'the memory\'s model calls run through a harness with usage headroom; there is no external API', quietWhen: 'harness' },
  { key: 'memory.reflect.api', since: '0.5.0', why: 'the memory\'s model calls run through a harness with usage headroom; there is no external API', quietWhen: { format: 'openai', url: '', model: '', keyEnv: '', person: false } },
  { key: 'memory.llm', since: '0.5.0', why: 'the memory\'s model calls run through a harness with usage headroom; there is no external API', quietWhen: { provider: 'auto', api: { format: 'openai', url: '', model: '', keyEnv: '', person: false } } },
  { key: 'memory.embed', since: '0.5.0', why: 'the memory search is by words; there is no embedding model or endpoint to configure', quietWhen: { url: '', model: '', dim: 0, keyEnv: '' } },
  { key: 'contextMode', since: '0.6.0', why: 'Context Mode and its context-mode MCP server are gone; the handoff memory and the compaction restore carry the session state', quietWhen: { enabled: true, capture: true } },
]

function quietRemoval(old: unknown, quiet: unknown): boolean {
  if (isPlainObject(old) && isPlainObject(quiet)) {
    return Object.entries(old).every(([k, v]) => Object.prototype.hasOwnProperty.call(quiet, k) && quietRemoval(v, quiet[k]))
  }
  return deepEqual(old, quiet)
}

export function migrateConfig(raw: unknown, renames: readonly ConfigRename[] = CONFIG_RENAMES): { value: unknown, notes: string[] } {
  if (!isPlainObject(raw)) return { value: raw, notes: [] }
  let value: Record<string, unknown> | undefined
  const notes: string[] = []
  for (const r of CONFIG_REMOVALS) {
    const path = r.key.split('.')
    const old = getAt(value ?? raw, path)
    if (!old.found) continue
    value ??= clone(raw)
    if (!(r.quietWhen !== undefined && quietRemoval(old.value, r.quietWhen))) notes.push(`${r.key} was removed in ${r.since} (${r.why}); its value is ignored (remove it from config.yaml)`)
    removePath(value, path)
  }
  for (const r of renames) {
    const from = r.from.split('.')
    const to = r.to.split('.')
    const old = getAt(value ?? raw, from)
    if (!old.found || old.value === undefined || old.value === null) continue
    value ??= clone(raw)
    const target = getAt(value, to)
    if (target.found && target.value !== undefined && target.value !== null) {
      notes.push(`${r.from} was renamed to ${r.to} in ${r.since}; ${r.to} is set too, so ${r.from} is ignored (remove it from config.yaml)`)
    } else {
      setPath(value, to, old.value)
      notes.push(`${r.from} was renamed to ${r.to} in ${r.since}; its value was used (rename the key in config.yaml)`)
    }
    removePath(value, from)
  }
  return { value: value ?? raw, notes }
}

function setPath(x: Record<string, unknown>, path: readonly string[], v: unknown): void {
  let cur = x
  for (const seg of path.slice(0, -1)) {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') return
    const next = cur[seg]
    if (!isPlainObject(next)) cur[seg] = {}
    cur = cur[seg] as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (last !== undefined && last !== '__proto__' && last !== 'constructor' && last !== 'prototype') cur[last] = clone(v)
}

function removePath(x: Record<string, unknown>, path: readonly string[]): void {
  const [head, ...rest] = path
  if (head === undefined || !Object.prototype.hasOwnProperty.call(x, head)) return
  if (rest.length === 0) { delete x[head]; return }
  const next = x[head]
  if (!isPlainObject(next)) return
  removePath(next, rest)
  if (Object.keys(next).length === 0) delete x[head]
}

export const RUNTIME_SNAPSHOT_VERSION = 1

export function runtimeSnapshotConfig(raw: unknown, defaults: BuracleConfig): { config: BuracleConfig, errors: string[], warnings: string[] } {
  if (!isPlainObject(raw)) return { config: clone(defaults), errors: [], warnings: ['runtime-config.json is not an object: the defaults apply'] }
  if (raw['v'] !== RUNTIME_SNAPSHOT_VERSION) {
    return { config: clone(defaults), errors: [], warnings: [`runtime-config.json has version ${describeVersion(raw['v'])}, this Buracle reads version ${RUNTIME_SNAPSHOT_VERSION}: the defaults apply until \`buracle install\` writes it again`] }
  }
  return mergeConfigLenient(defaults, raw['config'])
}

function describeVersion(v: unknown): string {
  return typeof v === 'number' || typeof v === 'string' ? String(v) : describe(v)
}

export function mergeConfigLenient(base: BuracleConfig, override: unknown, renames: readonly ConfigRename[] = CONFIG_RENAMES): { config: BuracleConfig, errors: string[], warnings: string[] } {
  if (override === undefined || override === null) return { config: clone(base), errors: [], warnings: [] }
  if (!isPlainObject(override)) {
    return { config: clone(base), errors: [`(root): expected a mapping, got ${describe(override)}`], warnings: [] }
  }
  const migrated = migrateConfig(override, renames)
  const warnings = migrated.notes
  const merged = deepMerge(base, migrated.value) as Record<string, unknown>
  const errors: string[] = []
  const note = (msg: string) => { if (!errors.includes(msg)) errors.push(msg) }
  for (let round = 0; round < 256; round++) {
    const found = issues(merged)
    if (found.length === 0) return { config: merged as unknown as BuracleConfig, errors, warnings }
    for (const issue of found) {
      note(formatIssue(issue))
      const firstIdx = issue.path.findIndex(seg => typeof seg === 'number')
      let path = firstIdx >= 0 ? issue.path.slice(0, firstIdx) : issue.path
      while (path.length > 0) {
        const prev = getAt(base, path)
        const cur = getAt(merged, path)
        if (prev.found === cur.found && deepEqual(prev.value, cur.value)) { path = path.slice(0, -1); continue }
        setAt(merged, path, prev.value, !prev.found)
        break
      }
      if (path.length === 0) return { config: clone(base), errors, warnings }
    }
  }
  return { config: clone(base), errors, warnings }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]))
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

import type { Harness } from './events'
import { HARNESSES } from './events'
import { harnessTable, harnessesWhere } from './harness/index'

export type CompanionSetting = 'off' | 'auto' | Harness
// A harness whose adapter is still pending has no second-opinion run, so it is no valid setting.
export const COMPANION_SETTINGS: readonly CompanionSetting[] = ['off', 'auto', ...harnessesWhere(p => p.adapterPending !== true && p.companionPending !== true)]

export interface BuracleConfig {
  version: 1
  repo?: string
  harnesses: Record<Harness, { enabled: boolean }>
  routing: { strictness: 'enforce' | 'nudge' | 'off', reminders: boolean }
  guards: { bash: { extraDeny: string[] }, write: { protect: string[] }, redact: boolean }
  plan: {
    stopGuard: boolean, planApproval: boolean, resultApproval: boolean, branchIsolation: boolean
    questions: boolean, reviews: { plan: boolean, changes: boolean, goal: boolean, companion: CompanionSetting }, goalVerification: boolean, modelSwitch: 'off' | 'manual', nativePlanMode: 'off' | 'on'
  }
  checkers: { enabled: boolean, languages: string[] }
  memory: { ui: { autostart: boolean }, exclude: string[] }
  statusline: { style: 'buracle' | 'full' | 'compact', emoji: boolean }
  skills: { sources: Array<{ name: string, path?: string, git?: string, ref?: string }> }
  update: { minReleaseAgeDays: number }
  permissions: { bypass: boolean, enforce: boolean }
  agents: { teams: boolean }
  workflow: { band: boolean, codexNotices: boolean }
  toolchain: { autoInstall: boolean, system: boolean, upgrade: boolean }
  index: { exclude: string[] }
  mcp: { shared: boolean, off: Record<Harness, string[]> }
}

export function defaultConfig(): BuracleConfig {
  return {
    version: 1,
    harnesses: harnessTable(() => ({ enabled: true })),
    routing: { strictness: 'enforce', reminders: true },
    guards: { bash: { extraDeny: [] }, write: { protect: [] }, redact: true },
    plan: {
      stopGuard: true,
      planApproval: true,
      resultApproval: true,
      branchIsolation: true,
      questions: true,
      reviews: { plan: true, changes: true, goal: true, companion: 'off' },
      goalVerification: true,
      modelSwitch: 'off',
      nativePlanMode: 'off',
    },
    checkers: { enabled: true, languages: ['python', 'typescript', 'javascript', 'go', 'shell', 'dotnet'] },
    memory: {
      ui: { autostart: true },
      exclude: [],
    },
    statusline: { style: 'buracle', emoji: true },
    skills: { sources: [{ name: 'buracle', path: 'canonical/skills' }] },
    update: { minReleaseAgeDays: 0 },
    permissions: { bypass: true, enforce: true },
    agents: { teams: true },
    workflow: { band: true, codexNotices: true },
    toolchain: { autoInstall: true, system: true, upgrade: true },
    index: { exclude: [] },
    mcp: { shared: true, off: harnessTable((): string[] => []) },
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
const count = (min: number): Schema => ({ t: 'int', min })
const strList: Schema = { t: 'arr', of: str }

const harnessFields: Record<string, Schema> = {}
for (const h of HARNESSES) harnessFields[h] = { t: 'obj', fields: { enabled: bool } }
const mcpOffFields: Record<string, Schema> = {}
for (const h of HARNESSES) mcpOffFields[h] = strList

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
        planApproval: bool,
        resultApproval: bool,
        branchIsolation: bool,
        questions: bool,
        reviews: { t: 'obj', fields: { plan: bool, changes: bool, goal: bool, companion: { t: 'enum', values: COMPANION_SETTINGS } } },
        goalVerification: bool,
        modelSwitch: { t: 'enum', values: ['off', 'manual'] },
        nativePlanMode: { t: 'enum', values: ['off', 'on'] },
      },
    },
    checkers: { t: 'obj', fields: { enabled: bool, languages: strList } },
    memory: {
      t: 'obj',
      fields: {
        ui: { t: 'obj', fields: { autostart: bool } },
        exclude: strList,
      },
    },
    statusline: {
      t: 'obj',
      fields: {
        style: { t: 'enum', values: ['buracle', 'full', 'compact'] },
        emoji: bool,
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
    agents: { t: 'obj', fields: { teams: bool } },
    workflow: { t: 'obj', fields: { band: bool, codexNotices: bool } },
    toolchain: { t: 'obj', fields: { autoInstall: bool, system: bool, upgrade: bool } },
    index: { t: 'obj', fields: { exclude: strList } },
    mcp: { t: 'obj', fields: { shared: bool, off: { t: 'obj', fields: mcpOffFields } } },
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

export function mergeConfigLenient(base: BuracleConfig, override: unknown): { config: BuracleConfig, errors: string[], warnings: string[] } {
  if (override === undefined || override === null) return { config: clone(base), errors: [], warnings: [] }
  if (!isPlainObject(override)) {
    return { config: clone(base), errors: [`(root): expected a mapping, got ${describe(override)}`], warnings: [] }
  }
  const warnings: string[] = []
  const merged = deepMerge(base, override) as Record<string, unknown>
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

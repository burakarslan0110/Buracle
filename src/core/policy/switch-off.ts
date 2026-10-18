import { normalizePath } from '../events'

export type GuardedKind = 'claude-settings' | 'codex-config' | 'opencode-config' | 'omp-settings' | 'plugin-code' | 'shell-startup' | 'launchd-agent'

export interface GuardedFile { kind: GuardedKind; what: string }

export interface WriteContent { after: string; before?: string }

export interface ConfigParsers {
  jsonc?: (text: string) => unknown
  toml?: (text: string) => unknown
  yaml?: (text: string) => unknown
}

const HOME_PREFIX = /^\/(?:(?:users|home)\/[^/]+|root|var\/root)(?=\/|$)/i

const SHELL_STARTUP: readonly string[] = [
  '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile',
  '.config/fish/config.fish', '.config/fish/fish_variables',
]

export const RELOCATION_VARS: readonly string[] = [
  'BURACLE_HOME', 'BURACLE_CORTEXDB_BIN', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PI_CODING_AGENT_DIR',
]

const WHAT: Readonly<Record<Exclude<GuardedKind, 'plugin-code'>, string>> = {
  'claude-settings': 'a Claude Code settings file (omp reads it too), which can switch off plugins and hooks, Buracle\'s among them',
  'codex-config': 'a Codex config file, which can switch off Codex hooks, Buracle\'s among them',
  'opencode-config': 'an OpenCode config file, which can switch off OpenCode plugins, Buracle\'s among them',
  'omp-settings': 'an omp settings file, which can switch off omp extensions, Buracle\'s among them',
  'shell-startup': 'a shell startup file, which sets the environment every harness and every Buracle hook starts with',
  'launchd-agent': 'a launchd agent, which can set the environment of every app the user starts',
}
const OPENCODE_CODE = 'OpenCode plugin code, which OpenCode loads next to Buracle\'s guard plugin'
const OMP_CODE = 'omp extension code, which omp loads next to Buracle\'s guard extension'

function lower(s: string): string { return s.toLowerCase() }

function homesOf(abs: string, home: string): string[] {
  const out: string[] = []
  const h = typeof home === 'string' && home.startsWith('/') ? lower(normalizePath(home)) : ''
  if (h !== '' && h !== '/') out.push(h)
  const named = HOME_PREFIX.exec(abs)?.[0]
  if (named !== undefined && !out.includes(lower(named))) out.push(lower(named))
  return out
}

function codeFolder(a: string | undefined, b: string | undefined): string | undefined {
  if (a === '.opencode' && (b === 'plugins' || b === 'plugin')) return OPENCODE_CODE
  if (a === '.omp' && (b === 'extensions' || b === 'hooks' || b === 'plugins')) return OMP_CODE
  return undefined
}

export function guardedFile(abs: string, home: string, ancestor = false): GuardedFile | undefined {
  if (typeof abs !== 'string' || !abs.startsWith('/')) return undefined
  const p = lower(normalizePath(abs))
  const segs = p.split('/').slice(1)
  const n = segs.length
  const base = segs[n - 1] ?? ''
  const parent = segs[n - 2] ?? ''
  if (parent === '.claude' && (base === 'settings.json' || base === 'settings.local.json')) return { kind: 'claude-settings', what: WHAT['claude-settings'] }
  if (parent === '.codex' && base === 'config.toml') return { kind: 'codex-config', what: WHAT['codex-config'] }
  if (base === 'opencode.json' || base === 'opencode.jsonc') return { kind: 'opencode-config', what: WHAT['opencode-config'] }
  if (parent === '.omp' && (base === 'config.yml' || base === 'config.yaml' || base === 'settings.json')) return { kind: 'omp-settings', what: WHAT['omp-settings'] }
  for (let i = 0; i + 1 < n; i++) {
    const what = codeFolder(segs[i], segs[i + 1])
    if (what !== undefined) return { kind: 'plugin-code', what }
  }
  for (const h of homesOf(abs, home)) {
    if (!p.startsWith(h + '/')) continue
    const rel = p.slice(h.length + 1)
    if (SHELL_STARTUP.includes(rel) || /^\.config\/fish\/conf\.d\/[^/]+\.fish$/.test(rel)) return { kind: 'shell-startup', what: WHAT['shell-startup'] }
    if (/^library\/launchagents\/[^/]+\.plist$/.test(rel)) return { kind: 'launchd-agent', what: WHAT['launchd-agent'] }
    if (ancestor && ['.config/fish', '.config/fish/conf.d', 'library/launchagents'].includes(rel)) {
      return { kind: rel.startsWith('library') ? 'launchd-agent' : 'shell-startup', what: rel.startsWith('library') ? WHAT['launchd-agent'] : WHAT['shell-startup'] }
    }
  }
  if (/^\/library\/launch(?:agents|daemons)\/[^/]+\.plist$/.test(p)) return { kind: 'launchd-agent', what: WHAT['launchd-agent'] }
  if (ancestor) {
    const holder: Readonly<Record<string, GuardedFile>> = {
      '.claude': { kind: 'claude-settings', what: WHAT['claude-settings'] },
      '.codex': { kind: 'codex-config', what: WHAT['codex-config'] },
      '.opencode': { kind: 'plugin-code', what: OPENCODE_CODE },
      '.omp': { kind: 'omp-settings', what: WHAT['omp-settings'] },
    }
    const hit = holder[base]
    if (hit !== undefined) return hit
    const what = codeFolder(parent, base)
    if (what !== undefined) return { kind: 'plugin-code', what }
  }
  return undefined
}

interface Finding { key: string; text: string }

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

function code(s: string): string {
  const t = s.length > 120 ? `${s.slice(0, 117)}...` : s
  return '`' + t.replace(/`/g, "'") + '`'
}

function show(v: unknown): string {
  try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
}

function truthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && v !== 0 && v !== '' && v !== 'false'
}

function envFindings(env: unknown, where: string): Finding[] {
  const e = obj(env)
  if (e === undefined) return []
  const out: Finding[] = []
  for (const [k, v] of Object.entries(e)) {
    const name = k.toUpperCase()
    if (name === 'BURACLE_HOOK_TIMEOUT_MS') out.push({ key: `${where}:${name}=${show(v)}`, text: `sets ${code(`${where}.${k}`)}, which cuts every Buracle hook short` })
    else if (RELOCATION_VARS.includes(name)) out.push({ key: `${where}:${name}=${show(v)}`, text: `sets ${code(`${where}.${k}`)}, which moves where Buracle or the harness loads from` })
  }
  return out
}

function ompFindings(v: unknown): Finding[] {
  const out: Finding[] = []
  const scan = (o: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [k, val] of Object.entries(o)) {
      if (/^disabled/i.test(k)) {
        const all = /extension|plugin/i.test(k)
        for (const item of Array.isArray(val) ? val : [val]) {
          if (typeof item === 'string' && (/buracle/i.test(item) || (all && /^\s*\*\s*$/.test(item)))) out.push({ key: `omp:${prefix}${k}:${lower(item)}`, text: `lists ${code(item)} in ${code(prefix + k)}, which keeps Buracle's guard extension from loading` })
        }
      } else if (depth === 0) {
        const inner = obj(val)
        if (inner !== undefined) scan(inner, `${k}.`, 1)
      }
    }
  }
  const o = obj(v)
  if (o !== undefined) scan(o, '', 0)
  return out
}

function claudeFindings(v: unknown): Finding[] {
  const s = obj(v)
  if (s === undefined) return []
  const out: Finding[] = []
  if (truthy(s['disableAllHooks'])) out.push({ key: 'disableAllHooks', text: `sets ${code('disableAllHooks')}, which stops every hook, Buracle's guards included` })
  if (truthy(s['allowManagedHooksOnly'])) out.push({ key: 'allowManagedHooksOnly', text: `sets ${code('allowManagedHooksOnly')}, which stops every hook but the managed ones` })
  const plugins = obj(s['enabledPlugins'])
  if (plugins !== undefined) {
    for (const [k, val] of Object.entries(plugins)) {
      if (/^buracle@/i.test(k) && val !== true) out.push({ key: `enabledPlugins:${lower(k)}:${show(val)}`, text: `turns Buracle's plugin off (${code(`enabledPlugins["${k}"]: ${show(val)}`)})` })
    }
  }
  out.push(...envFindings(s['env'], 'env'), ...ompFindings(s))
  return out
}

function codexFeatureFindings(f: unknown, where: string): Finding[] {
  const o = obj(f)
  if (o === undefined) return []
  const out: Finding[] = []
  for (const k of ['hooks', 'codex_hooks']) {
    const v = o[k]
    if (v !== undefined && v !== true) out.push({ key: `${where}.${k}=${show(v)}`, text: `sets ${code(`${where}.${k} = ${show(v)}`)}, which stops every Codex hook, Buracle's guards included` })
  }
  return out
}

function codexFindings(v: unknown): Finding[] {
  const c = obj(v)
  if (c === undefined) return []
  const out: Finding[] = [...codexFeatureFindings(c['features'], 'features')]
  for (const [name, profile] of Object.entries(obj(c['profiles']) ?? {})) out.push(...codexFeatureFindings(obj(profile)?.['features'], `profiles.${name}.features`))
  if (truthy(c['allow_managed_hooks_only'])) out.push({ key: 'allow_managed_hooks_only', text: `sets ${code('allow_managed_hooks_only')}, which stops every hook but the managed ones` })
  for (const [k, val] of Object.entries(obj(c['plugins']) ?? {})) {
    const enabled = obj(val)?.['enabled']
    if (/^buracle@/i.test(k) && enabled !== undefined && enabled !== true) out.push({ key: `plugins.${lower(k)}.enabled=${show(enabled)}`, text: `turns Buracle's plugin off (${code(`plugins."${k}".enabled = ${show(enabled)}`)})` })
  }
  for (const [k, val] of Object.entries(obj(obj(c['hooks'])?.['state']) ?? {})) {
    out.push({ key: `hooks.state.${k}=${show(val)}`, text: `changes the trust state of a Codex hook (${code(`hooks.state."${k}"`)}), which can switch it off` })
  }
  out.push(...envFindings(obj(c['shell_environment_policy'])?.['set'], 'shell_environment_policy.set'))
  return out
}

function namesBuracle(pattern: string): boolean {
  const re = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')
  return re.test('buracle') || /buracle/i.test(pattern)
}

function opencodeFindings(v: unknown): Finding[] {
  const c = obj(v)
  if (c === undefined) return []
  const out: Finding[] = []
  for (const key of ['plugins', 'plugin']) {
    const list = c[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const o = obj(entry)
      const name = typeof entry === 'string' ? entry : Array.isArray(entry) && typeof entry[0] === 'string' ? entry[0] : typeof o?.['package'] === 'string' ? o['package'] : typeof o?.['id'] === 'string' ? o['id'] : undefined
      if (name === undefined) continue
      if (name.startsWith('-') && namesBuracle(name.slice(1))) out.push({ key: `${key}:${lower(name)}`, text: `removes Buracle's plugin (${code(`${key}: "${name}"`)})` })
      else if (o !== undefined && /buracle/i.test(name) && (o['enabled'] === false || o['disabled'] === true)) out.push({ key: `${key}:${lower(name)}:off`, text: `turns Buracle's plugin off (${code(`${key}: ${show(entry)}`)})` })
    }
  }
  for (const key of ['plugin_enabled', 'plugins_enabled']) {
    for (const [k, val] of Object.entries(obj(c[key]) ?? {})) {
      if (/buracle/i.test(k) && val !== true) out.push({ key: `${key}:${lower(k)}=${show(val)}`, text: `turns Buracle's plugin off (${code(`${key}.${k}: ${show(val)}`)})` })
    }
  }
  return out
}

const NAMES = RELOCATION_VARS.join('|')
const SHELL_ASSIGN = new RegExp([
  `(?:^|[\\s;&|(\`])(?:(?:export|readonly|local)\\s+|(?:declare|typeset)\\s+(?:-\\w+\\s+)*)?(?:${NAMES})\\+?=`,
  `\\$\\{(?:${NAMES}):?=`,
  `\\bset\\s+(?:-{1,2}[A-Za-z-]+\\s+)*(?:${NAMES})\\b`,
  `\\bsetenv\\s+(?:${NAMES})\\b`,
  `\\bSETUVAR\\s+(?:--\\w+\\s+)*(?:${NAMES}):`,
  `\\b(?:export|typeset\\s+-\\w*x\\w*|declare\\s+-\\w*x\\w*)\\s+(?:\\w+\\s+)*(?:${NAMES.replace('|HOME|', '|')})\\b`,
].join('|'))
const PLIST_NAMES = new RegExp(`<(?:key|string)>\\s*(?:${NAMES})\\s*</|\\bsetenv\\s+(?:${NAMES})\\b|\\b(?:${NAMES.replace('|HOME|', '|')})\\b`)

const SETTINGS_WORDS: Readonly<Record<'claude-settings' | 'codex-config' | 'opencode-config' | 'omp-settings', RegExp>> = {
  'claude-settings': new RegExp(`disableAllHooks|allowManagedHooksOnly|buracle@|disabled\\w*|"(?:${NAMES}|BURACLE_HOOK_TIMEOUT_MS)"`, 'i'),
  'codex-config': new RegExp(`\\b(?:codex_)?hooks\\b|allow_managed_hooks_only|buracle@|\\b(?:${NAMES})\\b`, 'i'),
  'opencode-config': /buracle|["']-[^"']*\*|["']-\*["']/i,
  'omp-settings': /buracle|disabled\w*\s*["']?\s*:\s*\[?\s*["']?\*/i,
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
}

function lineFindings(text: string, test: (line: string) => boolean, describe: (line: string) => string, comment?: RegExp): Finding[] {
  const out: Finding[] = []
  for (const l of lines(text)) {
    if (comment !== undefined && comment.test(l)) continue
    if (test(l)) out.push({ key: `line:${l}`, text: describe(l) })
  }
  return out
}

function parse(kind: 'claude-settings' | 'codex-config' | 'opencode-config' | 'omp-settings', abs: string, text: string, parsers: ConfigParsers | undefined): { ok: true, value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: undefined }
  const yaml = kind === 'omp-settings' && /\.ya?ml$/i.test(abs)
  const fn = kind === 'codex-config' ? parsers?.toml : yaml ? parsers?.yaml : parsers?.jsonc ?? ((t: string): unknown => JSON.parse(t) as unknown)
  if (typeof fn !== 'function') return { ok: false }
  try { return { ok: true, value: fn(text) } } catch { return { ok: false } }
}

function settingsFindings(kind: 'claude-settings' | 'codex-config' | 'opencode-config' | 'omp-settings', value: unknown): Finding[] {
  switch (kind) {
    case 'claude-settings': return claudeFindings(value)
    case 'codex-config': return codexFindings(value)
    case 'opencode-config': return opencodeFindings(value)
    case 'omp-settings': return ompFindings(value)
  }
}

function findings(file: GuardedFile, abs: string, text: string, parsers: ConfigParsers | undefined): Finding[] {
  switch (file.kind) {
    case 'claude-settings':
    case 'codex-config':
    case 'opencode-config':
    case 'omp-settings': {
      const kind = file.kind
      const r = parse(kind, abs, text, parsers)
      if (r.ok) return settingsFindings(kind, r.value)
      const words = SETTINGS_WORDS[kind]
      return lineFindings(text, l => words.test(l), l => `adds ${code(l)}, which Buracle cannot read as valid settings and which may switch it off`)
    }
    case 'plugin-code':
      return lineFindings(text, l => /buracle/i.test(l), l => `names Buracle (${code(l)}), so it could replace or tamper with Buracle's own guards`)
    case 'shell-startup':
      return lineFindings(text, l => SHELL_ASSIGN.test(l), l => `sets a variable that moves Buracle or a harness (${code(l)}), so every later hook could run something else`, /^#/)
    case 'launchd-agent':
      return lineFindings(text, l => PLIST_NAMES.test(l), l => `sets a variable that moves Buracle or a harness (${code(l)}), so every later hook could run something else`, /^<!--/)
  }
}

function belowCodeFolder(abs: string): string {
  const segs = abs.split('/')
  for (let i = segs.length - 2; i >= 0; i--) {
    if (codeFolder(lower(segs[i] ?? ''), lower(segs[i + 1] ?? '')) !== undefined) return segs.slice(i).join('/')
  }
  return ''
}

export function switchOffChange(file: GuardedFile, abs: string, content: WriteContent, parsers?: ConfigParsers): string | undefined {
  if (file === null || typeof file !== 'object' || content === null || typeof content !== 'object' || typeof content.after !== 'string') return undefined
  if (file.kind === 'plugin-code' && /buracle/i.test(belowCodeFolder(abs))) {
    return 'puts plugin code in a folder that names Buracle, so it could replace Buracle\'s own guards'
  }
  const after = findings(file, abs, content.after, parsers)
  if (after.length === 0) return undefined
  const before = typeof content.before === 'string' ? new Set(findings(file, abs, content.before, parsers).map(f => f.key)) : new Set<string>()
  return after.find(f => !before.has(f.key))?.text
}

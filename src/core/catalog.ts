import type { Harness, HookId } from './events'
import { HARNESSES } from './events'
import type { BuracleConfig } from './config'
import type { Notice } from './notices'
import type { RoutingPolicy } from './policy/routing'
import type { SkillTriggerTable, Triggers } from './policy/skill-router'
import type { StatusLayout } from './status/model'
import type { PricingTable } from './usage'

export type McpTransport = 'stdio' | 'http'
export type PinPolicy = 'latest' | 'hard' | 'soft' | 'monitor'
export type McpRuntime = 'node' | 'bun'
export interface McpPackage {
  registry: 'npm' | 'pypi' | 'none'
  name: string
  version: string
  bin?: string
  extras?: string[]
  runtime?: McpRuntime
  scripts?: boolean
}
export interface McpServerSpec {
  description: string
  transport: McpTransport
  package?: McpPackage
  command?: string
  args?: string[]
  env?: Record<string, string>
  harness_env?: Partial<Record<Harness, Record<string, string>>>
  tool_timeout_sec?: number
  tool_timeout_hard?: boolean
  enabled_tools?: string[]
  disabled_tools?: string[]
  url?: string
  harnesses: Harness[]
  pin: PinPolicy
  pin_reason?: string
  critical: boolean
  routing: string[]
  health?: { tool: string, args: Record<string, unknown> }
}
export interface McpCatalog { servers: Record<string, McpServerSpec> }

export interface MarketplaceSpec { id: string; source: string }
export interface PluginSpec { id: string; enabled: boolean; version?: string }
export interface PluginsCatalog {
  claude: { marketplaces: MarketplaceSpec[]; plugins: PluginSpec[]; retired?: string[] }
  omp: { plugins: PluginSpec[] }
  opencode: { plugins: PluginSpec[] }
}

export interface ToolSpec {
  name: string
  check: string[]
  version_regex: string
  required: boolean
  purpose?: string
  kind?: 'runtime' | 'cli' | 'lsp'
  platforms?: Array<'darwin' | 'win32' | 'linux'>
  brew?: string
  winget?: string
  scoop?: string
  npm?: string
  npm_with?: string[]
  pypi?: string
  go?: string
  dotnet?: string
  rustup?: string
  bins?: string[]
  install?: string
  requires?: string[]
  prefer?: 'toolchain' | 'path'
  lsp?: LspSpec
}
export interface LspSpec {
  id: string
  bin?: string
  args?: string[]
  extensions: Record<string, string>
  root_markers?: string[]
  startup_timeout_ms?: number
  replaces?: string[]
}
export interface ToolsCatalog { tools: ToolSpec[] }

export interface HookFallback { event: string; matcher?: string; timeoutMs?: number; async?: boolean }
export interface HookBinding {
  event: string
  matcher?: string | string[] | Record<string, unknown>
  async?: boolean
  timeoutMs?: number
  also?: HookBinding[]
  fallback?: HookFallback | HookFallback[]
}
export interface HookUnsupported { unsupported: string }

export function hookFallbacks(binding: HookBinding | HookUnsupported | undefined): HookFallback[] {
  if (binding === undefined || binding === null || typeof binding !== 'object' || 'unsupported' in binding) return []
  const fb = binding.fallback
  return fb === undefined ? [] : Array.isArray(fb) ? [...fb] : [fb]
}
export interface HookSpec {
  id: HookId
  name: string
  blocking: 'none' | 'deny' | 'stop'
  failure: 'open' | 'closed'
  bindings: Partial<Record<Harness, HookBinding | HookUnsupported>>
  contract_test: string
  description?: string
}
export interface HooksMatrix { hooks: HookSpec[] }
export type StatuslineCatalog = Partial<Record<Harness, StatusLayout>>

export interface CanonicalFile { path: string; content: string; mode: number }
export interface RuleDoc { id: string; scope: 'always' | 'paths'; file: string; frontmatter: Record<string, unknown>; body: string }
export interface SkillDoc { id: string; dir: string; frontmatter: Record<string, unknown>; body: string; files: CanonicalFile[]; triggers?: Triggers }
export interface AgentDoc { id: string; file: string; frontmatter: Record<string, unknown>; body: string }

export interface CanonicalBundle {
  root: string
  config: BuracleConfig
  mcp: McpCatalog
  plugins: PluginsCatalog
  tools: ToolsCatalog
  hooks: HooksMatrix
  routing: RoutingPolicy
  statusline: StatuslineCatalog
  pricing: PricingTable
  rules: RuleDoc[]
  skills: SkillDoc[]
  agents: AgentDoc[]
  triggers?: SkillTriggerTable
  notices?: Notice[]
  missing: string[]
  warnings: string[]
}

export interface CatalogMcp { id: string; description: string; transport: McpTransport; critical: boolean; routing: string[]; harnesses: Harness[] }
export interface CatalogSkill {
  id: string
  description: string
  userInvocable: boolean
  short?: string
  invocation?: 'explicit' | 'implicit'
  triggers?: Triggers
}

export function catalogMcp(mcp: McpCatalog, harness?: Harness): CatalogMcp[] {
  return Object.keys(mcp.servers).sort().flatMap((id): CatalogMcp[] => {
    const s = mcp.servers[id]
    if (!s || (harness !== undefined && !s.harnesses.includes(harness))) return []
    return [{ id, description: s.description, transport: s.transport, critical: s.critical, routing: [...s.routing], harnesses: [...s.harnesses] }]
  })
}

export function catalogSkills(skills: readonly SkillDoc[]): CatalogSkill[] {
  return [...skills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(s => {
    const entry: CatalogSkill = {
      id: s.id,
      description: typeof s.frontmatter['description'] === 'string' ? s.frontmatter['description'] : '',
      userInvocable: s.frontmatter['user-invocable'] !== false,
    }
    const short = s.frontmatter['short-description']
    if (typeof short === 'string' && short.trim() !== '') entry.short = short.trim()
    const inv = s.frontmatter['invocation']
    if (inv === 'explicit' || inv === 'implicit') entry.invocation = inv
    if (s.triggers !== undefined) entry.triggers = s.triggers
    return entry
  })
}

const ENV_REF = /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/

export function envRef(value: string): string | undefined {
  return ENV_REF.exec(value)?.[1]
}

export function isPackageServer(spec: McpServerSpec): boolean {
  return spec.transport === 'stdio' && spec.command === undefined && spec.package !== undefined && (spec.package.registry === 'npm' || spec.package.registry === 'pypi')
}

export function mcpPackageBin(pkg: McpPackage): string {
  if (pkg.bin !== undefined && pkg.bin.trim() !== '') return pkg.bin
  return pkg.name.split('/').pop() ?? pkg.name
}

export function mcpEnvFor(spec: McpServerSpec, h: Harness): Record<string, string> {
  const merged: Record<string, string> = { ...(spec.env ?? {}), ...(spec.harness_env?.[h] ?? {}) }
  const out: Record<string, string> = {}
  for (const k of Object.keys(merged).sort()) out[k] = merged[k] as string
  return out
}

export function expandMcpCommand(spec: McpServerSpec, vars: { buracle: string, id?: string }): { command: string, args: string[] } {
  if (isPackageServer(spec) && vars.id !== undefined) return { command: vars.buracle, args: ['mcp', 'run', vars.id] }
  const sub = (s: string) => s.split('{version}').join(spec.package?.version ?? '{version}').split('{buracle}').join(vars.buracle)
  return { command: sub(spec.command ?? ''), args: (spec.args ?? []).map(sub) }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}
function isStr(x: unknown): x is string {
  return typeof x === 'string' && x.trim() !== ''
}
function isStrArr(x: unknown): x is string[] {
  return Array.isArray(x) && x.every(v => typeof v === 'string')
}
function unknownKeys(x: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  for (const k of Object.keys(x)) if (!allowed.includes(k)) errors.push(`${at}.${k}: unknown key`)
}

const SERVER_ID = /^[a-z0-9][a-z0-9-]*$/
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?$/
const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const SERVER_KEYS = ['description', 'transport', 'package', 'command', 'args', 'env', 'harness_env', 'tool_timeout_sec', 'tool_timeout_hard', 'enabled_tools', 'disabled_tools', 'url', 'harnesses', 'pin', 'pin_reason', 'critical', 'routing', 'health'] as const
const PACKAGE_KEYS = ['registry', 'name', 'version', 'bin', 'extras', 'runtime', 'scripts'] as const
const PIN_POLICIES: readonly string[] = ['latest', 'hard', 'soft', 'monitor']
const RUNTIMES: readonly string[] = ['node', 'bun']

function validateEnvMap(env: unknown, at: string, errors: string[]): void {
  if (!isObj(env)) { errors.push(`${at}: expected a mapping`); return }
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k)) errors.push(`${at}.${k}: invalid variable name`)
    if (typeof v !== 'string') errors.push(`${at}.${k}: expected string`)
    else if (v.includes('${') && envRef(v) === undefined) errors.push(`${at}.${k}: only whole-value "\${ENV:NAME}" forwarding is supported`)
  }
}

function validateToolList(x: unknown, at: string, errors: string[]): string[] | undefined {
  if (!isStrArr(x) || x.length === 0) { errors.push(`${at}: expected a non-empty list of tool names`); return undefined }
  const bad = x.filter(t => !TOOL_NAME.test(t))
  if (bad.length > 0) errors.push(`${at}: not a tool name: ${bad.map(t => JSON.stringify(t)).join(', ')}`)
  if (new Set(x).size !== x.length) errors.push(`${at}: duplicates`)
  return x
}

export function validateMcpCatalog(x: unknown): string[] {
  const errors: string[] = []
  if (!isObj(x) || !isObj(x['servers'])) return ['servers: expected a mapping of server id → spec']
  unknownKeys(x, ['servers'], '(root)', errors)
  for (const [id, raw] of Object.entries(x['servers'])) {
    const at = `servers.${id}`
    if (!SERVER_ID.test(id)) errors.push(`${at}: server id must match ${SERVER_ID.source}`)
    if (!isObj(raw)) { errors.push(`${at}: expected a mapping`); continue }
    unknownKeys(raw, SERVER_KEYS, at, errors)
    if (!isStr(raw['description'])) errors.push(`${at}.description: required string`)
    const transport = raw['transport']
    if (transport !== 'stdio' && transport !== 'http') errors.push(`${at}.transport: expected stdio | http`)
    const pkg = raw['package']
    const registryPkg = isObj(pkg) && (pkg['registry'] === 'npm' || pkg['registry'] === 'pypi')
    if (pkg !== undefined) {
      if (!isObj(pkg)) errors.push(`${at}.package: expected a mapping`)
      else {
        unknownKeys(pkg, PACKAGE_KEYS, `${at}.package`, errors)
        const reg = pkg['registry']
        if (reg !== 'npm' && reg !== 'pypi' && reg !== 'none') errors.push(`${at}.package.registry: expected npm | pypi | none`)
        if (!isStr(pkg['name'])) errors.push(`${at}.package.name: required string`)
        const ver = pkg['version']
        if (!isStr(ver)) errors.push(`${at}.package.version: required string (latest or an exact version)`)
        else if (registryPkg && ver !== 'latest' && !EXACT_VERSION.test(ver)) errors.push(`${at}.package.version: must be latest or an exact version (got ${JSON.stringify(ver)})`)
        if (pkg['bin'] !== undefined && (!isStr(pkg['bin']) || !BIN_NAME.test(pkg['bin']))) errors.push(`${at}.package.bin: expected an executable name`)
        if (pkg['extras'] !== undefined && (!isStrArr(pkg['extras']) || pkg['extras'].some(e => !/^[A-Za-z0-9._-]+$/.test(e)))) errors.push(`${at}.package.extras: expected a list of extra names`)
        if (pkg['extras'] !== undefined && reg !== 'pypi') errors.push(`${at}.package.extras: only PyPI packages have extras`)
        const runtime = pkg['runtime']
        if (runtime !== undefined && (typeof runtime !== 'string' || !RUNTIMES.includes(runtime))) errors.push(`${at}.package.runtime: expected ${RUNTIMES.join(' | ')}`)
        if (runtime !== undefined && reg !== 'npm') errors.push(`${at}.package.runtime: only npm packages choose a runtime`)
        if (pkg['scripts'] !== undefined && typeof pkg['scripts'] !== 'boolean') errors.push(`${at}.package.scripts: expected boolean`)
        if (pkg['scripts'] !== undefined && reg !== 'npm') errors.push(`${at}.package.scripts: only npm packages have lifecycle scripts to turn off`)
      }
    }
    const command = raw['command']
    const args = raw['args']
    if (command !== undefined && !isStr(command)) errors.push(`${at}.command: expected string`)
    if (args !== undefined && !isStrArr(args)) errors.push(`${at}.args: expected a list of strings`)
    if (transport === 'stdio') {
      if (registryPkg && command === undefined) {
      } else {
        if (!isStr(command)) errors.push(`${at}.command: required for stdio`)
        const text = [typeof command === 'string' ? command : '', ...(isStrArr(args) ? args : [])].join(' ')
        if (!text.includes('{buracle}') && pkg === undefined) errors.push(`${at}.package: stdio servers must name an npm or PyPI package (or run {buracle})`)
        if (registryPkg && isObj(pkg) && pkg['version'] === 'latest') errors.push(`${at}.package.version: a server with its own command needs an exact version (drop command to run the latest release through \`buracle mcp run ${id}\`)`)
        if (registryPkg && !text.includes('{version}')) errors.push(`${at}: command/args must use {version} so the pin is applied`)
      }
      if (raw['url'] !== undefined) errors.push(`${at}.url: only valid for http`)
    }
    if (transport === 'http') {
      const url = raw['url']
      if (!isStr(url) || !/^https:\/\//.test(url)) errors.push(`${at}.url: required https URL for http`)
      if (command !== undefined) errors.push(`${at}.command: only valid for stdio`)
    }
    const env = raw['env']
    if (env !== undefined) validateEnvMap(env, `${at}.env`, errors)
    const hs = raw['harnesses']
    if (!Array.isArray(hs) || hs.length === 0 || !hs.every(h => (HARNESSES as readonly unknown[]).includes(h))) errors.push(`${at}.harnesses: expected a non-empty list of ${HARNESSES.join(' | ')}`)
    else if (new Set(hs).size !== hs.length) errors.push(`${at}.harnesses: duplicates`)
    const harnessEnv = raw['harness_env']
    if (harnessEnv !== undefined) {
      if (!isObj(harnessEnv)) errors.push(`${at}.harness_env: expected a mapping of harness to variables`)
      else {
        if (transport !== 'stdio') errors.push(`${at}.harness_env: only valid for stdio`)
        for (const [h, vars] of Object.entries(harnessEnv)) {
          const hat = `${at}.harness_env.${h}`
          if (!Array.isArray(hs) || !hs.includes(h)) errors.push(`${hat}: not one of this server's harnesses`)
          validateEnvMap(vars, hat, errors)
          if (isObj(vars) && isObj(env)) {
            for (const k of Object.keys(vars)) if (Object.prototype.hasOwnProperty.call(env, k)) errors.push(`${hat}.${k}: also in env (a variable is set either for every harness or per harness)`)
          }
        }
      }
    }
    const timeout = raw['tool_timeout_sec']
    if (timeout !== undefined && !(typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0)) errors.push(`${at}.tool_timeout_sec: expected a positive whole number of seconds`)
    const hard = raw['tool_timeout_hard']
    if (hard !== undefined && typeof hard !== 'boolean') errors.push(`${at}.tool_timeout_hard: expected a boolean`)
    else if (hard === true && timeout === undefined) errors.push(`${at}.tool_timeout_hard: needs tool_timeout_sec`)
    const enabled = raw['enabled_tools'] !== undefined ? validateToolList(raw['enabled_tools'], `${at}.enabled_tools`, errors) : undefined
    const disabled = raw['disabled_tools'] !== undefined ? validateToolList(raw['disabled_tools'], `${at}.disabled_tools`, errors) : undefined
    if (enabled !== undefined && disabled !== undefined) {
      const both = disabled.filter(t => enabled.includes(t))
      if (both.length > 0) errors.push(`${at}.disabled_tools: also in enabled_tools: ${both.join(', ')}`)
    }
    const pin = raw['pin']
    if (typeof pin !== 'string' || !PIN_POLICIES.includes(pin)) errors.push(`${at}.pin: expected ${PIN_POLICIES.join(' | ')}`)
    if (pin === 'latest' && isObj(pkg) && isStr(pkg['version']) && pkg['version'] !== 'latest') errors.push(`${at}.package.version: a latest pin installs the newest release; write version: latest`)
    if ((pin === 'hard' || pin === 'soft') && registryPkg && isObj(pkg) && pkg['version'] === 'latest') errors.push(`${at}.package.version: a ${pin} pin needs an exact version`)
    if (pin === 'soft' && !isStr(raw['pin_reason'])) errors.push(`${at}.pin_reason: required for soft pins`)
    if (typeof raw['critical'] !== 'boolean') errors.push(`${at}.critical: required boolean`)
    if (!isStrArr(raw['routing'])) errors.push(`${at}.routing: expected a list of category ids`)
    const health = raw['health']
    if (health !== undefined && (!isObj(health) || !isStr(health['tool']) || !isObj(health['args']))) errors.push(`${at}.health: expected { tool: string, args: mapping }`)
  }
  return errors
}

function validatePluginList(x: unknown, at: string, errors: string[]): void {
  if (!Array.isArray(x)) { errors.push(`${at}: expected a list`); return }
  const ids = new Set<string>()
  x.forEach((p, i) => {
    const pat = `${at}[${i}]`
    if (!isObj(p)) { errors.push(`${pat}: expected a mapping`); return }
    unknownKeys(p, ['id', 'enabled', 'version'], pat, errors)
    if (!isStr(p['id'])) errors.push(`${pat}.id: required string`)
    else if (ids.has(p['id'])) errors.push(`${pat}.id: duplicate ${JSON.stringify(p['id'])}`)
    else ids.add(p['id'])
    if (typeof p['enabled'] !== 'boolean') errors.push(`${pat}.enabled: required boolean`)
    if (p['version'] !== undefined && !isStr(p['version'])) errors.push(`${pat}.version: expected string`)
  })
}

export function validatePluginsCatalog(x: unknown): string[] {
  const errors: string[] = []
  if (!isObj(x)) return ['(root): expected a mapping']
  unknownKeys(x, ['claude', 'omp', 'opencode'], '(root)', errors)
  const claude = x['claude']
  if (!isObj(claude)) errors.push('claude: expected a mapping')
  else {
    unknownKeys(claude, ['marketplaces', 'plugins', 'retired'], 'claude', errors)
    const mks = claude['marketplaces']
    const mkIds = new Set<string>()
    if (!Array.isArray(mks)) errors.push('claude.marketplaces: expected a list')
    else mks.forEach((m, i) => {
      const at = `claude.marketplaces[${i}]`
      if (!isObj(m)) { errors.push(`${at}: expected a mapping`); return }
      unknownKeys(m, ['id', 'source'], at, errors)
      if (!isStr(m['id'])) errors.push(`${at}.id: required string`)
      else mkIds.add(m['id'])
      if (!isStr(m['source'])) errors.push(`${at}.source: required string`)
    })
    validatePluginList(claude['plugins'], 'claude.plugins', errors)
    const plugins = claude['plugins']
    if (Array.isArray(plugins)) plugins.forEach((p, i) => {
      if (!isObj(p) || !isStr(p['id'])) return
      const at = p['id'].lastIndexOf('@')
      if (at <= 0) errors.push(`claude.plugins[${i}].id: expected <plugin>@<marketplace>`)
      else if (!mkIds.has(p['id'].slice(at + 1))) errors.push(`claude.plugins[${i}].id: unknown marketplace ${JSON.stringify(p['id'].slice(at + 1))}`)
    })
    const retired = claude['retired']
    if (retired !== undefined) {
      if (!Array.isArray(retired)) errors.push('claude.retired: expected a list of <plugin>@<marketplace> ids')
      else retired.forEach((r, i) => {
        if (!isStr(r) || r.lastIndexOf('@') <= 0) errors.push(`claude.retired[${i}]: expected <plugin>@<marketplace>`)
        else if (Array.isArray(plugins) && plugins.some(p => isObj(p) && p['id'] === r)) errors.push(`claude.retired[${i}]: ${r} is also in claude.plugins`)
      })
    }
  }
  for (const h of ['omp', 'opencode'] as const) {
    const sec = x[h]
    if (!isObj(sec)) { errors.push(`${h}: expected a mapping`); continue }
    unknownKeys(sec, ['plugins'], h, errors)
    validatePluginList(sec['plugins'], `${h}.plugins`, errors)
  }
  return errors
}

export function validateToolsCatalog(x: unknown): string[] {
  const errors: string[] = []
  if (!isObj(x) || !Array.isArray(x['tools'])) return ['tools: expected a list']
  unknownKeys(x, ['tools'], '(root)', errors)
  const names = new Set<string>()
  x['tools'].forEach((t, i) => {
    const at = `tools[${i}]`
    if (!isObj(t)) { errors.push(`${at}: expected a mapping`); return }
    unknownKeys(t, ['name', 'check', 'version_regex', 'brew', 'winget', 'scoop', 'npm', 'npm_with', 'pypi', 'go', 'dotnet', 'rustup', 'bins', 'kind', 'platforms', 'install', 'requires', 'required', 'purpose', 'prefer', 'lsp'], at, errors)
    if (t['prefer'] !== undefined && t['prefer'] !== 'toolchain' && t['prefer'] !== 'path') errors.push(`${at}.prefer: expected toolchain | path`)
    if (t['prefer'] === 'toolchain' && t['npm'] === undefined && t['pypi'] === undefined) errors.push(`${at}.prefer: toolchain needs an npm or pypi source`)
    const lsp = t['lsp']
    if (lsp !== undefined) {
      if (!isObj(lsp)) errors.push(`${at}.lsp: expected a mapping`)
      else {
        unknownKeys(lsp, ['id', 'bin', 'args', 'extensions', 'root_markers', 'startup_timeout_ms', 'replaces'], `${at}.lsp`, errors)
        const markers = lsp['root_markers']
        if (markers !== undefined && (!isStrArr(markers) || markers.length === 0 || !markers.every(m => /^(?:\*\.)?[A-Za-z0-9._-]+$/.test(m) && m !== '.' && m !== '..'))) errors.push(`${at}.lsp.root_markers: expected a list of file names (or *.ext)`)
        const replaces = lsp['replaces']
        if (replaces !== undefined && (!isStrArr(replaces) || !replaces.every(r => /^[^@\s]+@[^@\s]+$/.test(r)))) errors.push(`${at}.lsp.replaces: expected a list of <plugin>@<marketplace>`)
        if (!isStr(lsp['id']) || !/^[a-z][a-z0-9-]*$/.test(lsp['id'])) errors.push(`${at}.lsp.id: expected a lower-case id`)
        if (lsp['bin'] !== undefined && !isStr(lsp['bin'])) errors.push(`${at}.lsp.bin: expected string`)
        if (lsp['args'] !== undefined && !isStrArr(lsp['args'])) errors.push(`${at}.lsp.args: expected a list of strings`)
        const ext = lsp['extensions']
        if (!isObj(ext) || Object.keys(ext).length === 0 || !Object.entries(ext).every(([k, v]) => /^\.[A-Za-z0-9]+$/.test(k) && isStr(v))) errors.push(`${at}.lsp.extensions: expected a mapping of .ext to language id`)
        const startup = lsp['startup_timeout_ms']
        if (startup !== undefined && (typeof startup !== 'number' || !Number.isInteger(startup) || startup <= 0)) errors.push(`${at}.lsp.startup_timeout_ms: expected a positive integer`)
      }
    }
    for (const k of ['winget', 'scoop', 'npm', 'pypi', 'go', 'dotnet', 'rustup'] as const) if (t[k] !== undefined && !isStr(t[k])) errors.push(`${at}.${k}: expected string`)
    if (t['npm_with'] !== undefined && !isStrArr(t['npm_with'])) errors.push(`${at}.npm_with: expected a list of package names`)
    if (t['bins'] !== undefined && (!isStrArr(t['bins']) || t['bins'].length === 0)) errors.push(`${at}.bins: expected a non-empty list of executable names`)
    if (t['requires'] !== undefined && (!isStrArr(t['requires']) || t['requires'].length === 0 || t['requires'].some(c => c.trim() === ''))) errors.push(`${at}.requires: expected a non-empty list of command names`)
    if (t['kind'] !== undefined && t['kind'] !== 'runtime' && t['kind'] !== 'cli' && t['kind'] !== 'lsp') errors.push(`${at}.kind: expected runtime | cli | lsp`)
    if (t['platforms'] !== undefined && (!Array.isArray(t['platforms']) || t['platforms'].length === 0 || !t['platforms'].every(p => p === 'darwin' || p === 'win32' || p === 'linux'))) errors.push(`${at}.platforms: expected a list of darwin | win32 | linux`)
    if (!isStr(t['name'])) errors.push(`${at}.name: required string`)
    else if (names.has(t['name'])) errors.push(`${at}.name: duplicate ${JSON.stringify(t['name'])}`)
    else names.add(t['name'])
    if (!isStrArr(t['check']) || t['check'].length === 0) errors.push(`${at}.check: required non-empty argv list`)
    const re = t['version_regex']
    if (!isStr(re)) errors.push(`${at}.version_regex: required string`)
    else {
      try {
        const compiled = new RegExp(re)
        if (!/\((?!\?)/.test(compiled.source)) errors.push(`${at}.version_regex: needs a capture group for the version`)
      } catch {
        errors.push(`${at}.version_regex: invalid regular expression`)
      }
    }
    if (t['brew'] !== undefined && !isStr(t['brew'])) errors.push(`${at}.brew: expected string`)
    if (t['install'] !== undefined && !isStr(t['install'])) errors.push(`${at}.install: expected string`)
    if (t['purpose'] !== undefined && !isStr(t['purpose'])) errors.push(`${at}.purpose: expected string`)
    if (typeof t['required'] !== 'boolean') errors.push(`${at}.required: required boolean`)
  })
  return errors
}

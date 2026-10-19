import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AdapterContext } from '../registry'
import type { CanonicalBundle } from '../../core/catalog'
import { CM_SERVER_ID } from '../../core/context-mode'
import { resolveEffort } from '../../core/effort'
import { pathExistsSync, readTextSync, sha256 } from '../../engine/fsx'
import { getIn, jsoncParse, mdBlockGet } from '../../engine/merge'
import type { RunResult } from '../../engine/proc'
import { detectBinary, run, which } from '../../engine/proc'
import { buildFiles, commandNames } from './build'
import { AGENTS_BLOCK_ID, CONFIG_SCHEMA_URL, MIN_VERSION, PLUGIN_DIR, PLUGIN_ID, TESTED_WITH } from './constants'
import { compareVersions, configTarget } from './install'
import { POINTER_FILE } from './runtime/env'
import { configPermissions, mcpDenyRules, opencodeServers } from './render'
import { resolveArgv, type Env } from '../shared/command'
import { hostLimitsRow } from '../shared/host-limits'

export interface DoctorItem { level: 'ok' | 'warn' | 'error', check: string, detail: string }

export function mcpCommandFindings(servers: Record<string, unknown>, env: Env): Array<{ level: 'ok' | 'warn' | 'error', detail: string }> {
  const errors: string[] = []
  const warnings: string[] = []
  for (const [id, raw] of Object.entries(servers)) {
    const s = obj(raw)
    const argv = Array.isArray(s?.['command']) ? (s['command'] as unknown[]).filter((a): a is string => typeof a === 'string') : []
    if (s?.['type'] !== 'local' || argv.length === 0) continue
    const r = resolveArgv(argv, env)
    if (r.executable !== undefined) continue
    if (r.program !== undefined && !/[\\/]/.test(r.program)) warnings.push(`${id}: \`${r.program}\` is not on PATH`)
    else errors.push(`${id}: ${r.program ?? argv[0]} does not exist or is not executable`)
  }
  const out: Array<{ level: 'ok' | 'warn' | 'error', detail: string }> = []
  if (errors.length > 0) out.push({ level: 'error', detail: `MCP server commands OpenCode cannot start: ${errors.join('; ')}; run \`buracle install opencode\` again (BURACLE_HOME moved or the shim is missing)` })
  if (warnings.length > 0) out.push({ level: 'warn', detail: `MCP package runners not found on PATH: ${warnings.join('; ')}` })
  return out
}

export interface DoctorOptions {
  detect?: () => Promise<{ installed: boolean, version?: string, path?: string }>
  run?: (argv: string[], opts: { timeoutMs: number, cwd?: string }) => Promise<RunResult>
  live?: boolean
}

const CMD_TIMEOUT_MS = 15_000

function obj(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined
}

function readJsonc(path: string): { ok: true, value: unknown } | { ok: false, error: string } | undefined {
  const t = readTextSync(path)
  if (!t.ok) return t.code === 'missing' ? undefined : { ok: false, error: t.error }
  return jsoncParse(t.value)
}

const CLAUDE_AUTH = /anthropic|claude/i
const CLAUDE_AUTH_PLUGIN = /(anthropic|claude)[-_.]?(code[-_.]?)?(auth|oauth|max|pro|subscription)/i

export function claudeSubscriptionSigns(dataDir: string, configFiles: string[]): string[] {
  const signs: string[] = []
  const auth = readJsonc(join(dataDir, 'auth.json'))
  const a = auth?.ok === true ? obj(auth.value) : undefined
  if (a !== undefined) {
    for (const [k, v] of Object.entries(a)) {
      if (CLAUDE_AUTH.test(k) && obj(v)?.['type'] === 'oauth') signs.push(`OAuth credential "${k}" in ${join(dataDir, 'auth.json')}`)
    }
  }
  const dbPath = join(dataDir, 'opencode.db')
  if (pathExistsSync(dbPath)) {
    let db: Database | undefined
    try {
      db = new Database(dbPath, { readonly: true })
      const rows = db.query("SELECT integration_id AS id, json_extract(value, '$.type') AS type FROM credential").all() as Array<{ id: unknown, type: unknown }>
      for (const r of rows) {
        if (typeof r.id === 'string' && CLAUDE_AUTH.test(r.id) && r.type === 'oauth') signs.push(`OAuth credential for integration "${r.id}" in ${dbPath}`)
      }
    } catch {  } finally {
      try { db?.close() } catch {  }
    }
  }
  for (const f of configFiles) {
    const c = readJsonc(f)
    const v = c?.ok === true ? obj(c.value) : undefined
    if (v === undefined) continue
    for (const key of ['plugins', 'plugin']) {
      const list = v[key]
      if (!Array.isArray(list)) continue
      for (const p of list) {
        const spec = typeof p === 'string' ? p : typeof obj(p)?.['package'] === 'string' ? obj(p)?.['package'] as string : undefined
        if (spec !== undefined && CLAUDE_AUTH_PLUGIN.test(spec)) signs.push(`plugin "${spec}" in ${f}`)
      }
    }
  }
  return signs
}

function sameRule(a: unknown, b: { action: string, resource: string, effect: string }): boolean {
  const o = obj(a)
  return o !== undefined && o['action'] === b.action && o['resource'] === b.resource && o['effect'] === b.effect
}

function disablesPlugin(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return undefined
  for (const e of entries) {
    const s = typeof e === 'string' ? e : typeof obj(e)?.['package'] === 'string' ? obj(e)?.['package'] as string : undefined
    if (s === `-${PLUGIN_ID}` || s === '-*' || (s?.startsWith('-') === true && s.endsWith('.*') && PLUGIN_ID.startsWith(s.slice(1, -1)))) return s
  }
  return undefined
}

type Finding = { level: DoctorItem['level'], detail: string }

export function permissionFinding(cfg: { bypass: boolean, enforce: boolean }, mode: unknown): Finding {
  const shown = mode === undefined ? 'unset' : JSON.stringify(mode)
  if (!cfg.bypass) return { level: 'ok', detail: `permissions.bypass is off: OpenCode asks as you configured it (cli.json session.permissions: ${shown})` }
  if (mode === 'autoaccept') return { level: 'ok', detail: 'cli.json session.permissions is autoaccept: no approval prompts; Buracle\'s guards and consent gate still deny' }
  return {
    level: 'warn',
    detail: `cli.json session.permissions is ${shown}, not autoaccept, so OpenCode asks before tool calls; ${cfg.enforce
      ? 'run `buracle install opencode` to restore it (permissions.enforce writes it again)'
      : 'permissions.enforce is off, so Buracle keeps your value'}`,
  }
}

function configuredEfforts(config: unknown): string[] {
  const out: string[] = []
  const providers = obj(obj(config)?.['providers'])
  for (const [p, pv] of Object.entries(providers ?? {})) {
    for (const [m, mv] of Object.entries(obj(obj(pv)?.['models']) ?? {})) {
      const s = obj(obj(mv)?.['settings'])
      if (s !== undefined && ('effort' in s || 'reasoningEffort' in s)) out.push(`${p}/${m}`)
    }
  }
  return out.sort()
}

export function rememberedVariants(env: Record<string, string | undefined> = process.env): string[] {
  const xdg = env['XDG_STATE_HOME']
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : env['HOME'] !== undefined ? join(env['HOME'], '.local', 'state') : undefined
  if (base === undefined) return []
  const r = readJsonc(join(base, 'opencode', 'model.json'))
  const variants = obj(obj(r?.ok === true ? r.value : undefined)?.['variant'])
  return Object.entries(variants ?? {}).filter(([, v]) => typeof v === 'string' && v !== '' && v !== 'default').map(([k, v]) => `${k}#${String(v)}`).sort()
}

export function effortFinding(value: string, config: unknown, remembered: readonly string[]): Finding {
  const r = resolveEffort('opencode', value)
  if ('invalid' in r) return { level: 'warn', detail: `effort.opencode: ${r.invalid}` }
  if ('off' in r) return { level: 'ok', detail: 'effort.opencode is keep: Buracle leaves the models\' default effort to OpenCode' }
  const over = [...configuredEfforts(config).map(m => `${m} (opencode.jsonc)`), ...remembered.map(m => `${m} (picked in the TUI)`)]
  return {
    level: 'ok',
    detail: `default effort ${r.level}: the plugin gives it to every available model that has a ${r.level} variant (no config is written)${over.length > 0 ? `; your own choice wins for ${over.slice(0, 6).join(', ')}${over.length > 6 ? ` and ${over.length - 6} more` : ''}` : ''}`,
  }
}

export function contextModeFindings(canonical: CanonicalBundle, shim: string, entry: unknown, permissions: readonly unknown[]): Finding[] {
  const expected = opencodeServers(canonical, shim).find(([id]) => id === CM_SERVER_ID)?.[1]
  if (expected === undefined) return []
  const platform = obj(expected['environment'])?.['CONTEXT_MODE_PLATFORM']
  const hidden = mcpDenyRules(canonical).filter(r => r.action.startsWith(`${CM_SERVER_ID}_`))
  const problems: string[] = []
  const installed = obj(entry)
  if (installed === undefined) problems.push(`mcp.servers.${CM_SERVER_ID} is missing`)
  else if (typeof platform === 'string') {
    const have = obj(installed['environment'])?.['CONTEXT_MODE_PLATFORM']
    if (have !== platform) problems.push(`mcp.servers.${CM_SERVER_ID} environment.CONTEXT_MODE_PLATFORM is ${have === undefined ? 'unset' : JSON.stringify(have)}, not "${platform}" (context-mode would file OpenCode's sessions under another harness)`)
  }
  const lost = hidden.filter(r => !permissions.some(p => sameRule(p, r)))
  if (lost.length > 0) problems.push(`the permissions deny rules that hide ${lost.map(r => r.action).join(', ')} are missing`)
  if (problems.length > 0) return [{ level: 'warn', detail: `context-mode: ${problems.join('; ')}; run \`buracle install opencode\`` }]
  const runs = typeof platform === 'string' ? `context-mode runs as platform "${platform}"` : 'context-mode is configured'
  return [{ level: 'ok', detail: hidden.length > 0 ? `${runs}; ${hidden.map(r => r.action).join(', ')} are hidden (permissions deny rules)` : runs }]
}

export function commandFindings(ctx: AdapterContext, configDir: string, config: unknown): Finding[] {
  const workflow = commandNames(ctx.canonical).workflow
  const files = workflow.filter(id => pathExistsSync(join(configDir, 'commands', `${id}.md`))).map(id => `commands/${id}.md`)
  const keys = workflow.filter(id => obj(obj(config)?.['commands'])?.[id] !== undefined).map(id => `commands.${id} in the config`)
  const shadow = [...files, ...keys]
  if (shadow.length === 0) return [{ level: 'ok', detail: `the ${workflow.length} workflow commands come from the plugin: ${workflow.map(id => `/${id}`).join(' ')}` }]
  return [{ level: 'warn', detail: `${shadow.join(', ')} ${shadow.length > 1 ? 'shadow' : 'shadows'} Buracle's workflow command of the same name (a command file or config entry wins over a plugin command, so the skill is not attached and the band does not start). Run \`buracle install opencode\` (it removes the files an earlier Buracle wrote) or remove your own.` }]
}

export async function doctor(ctx: AdapterContext, opts: DoctorOptions = {}): Promise<DoctorItem[]> {
  const out: DoctorItem[] = []
  const add = (level: DoctorItem['level'], check: string, detail: string) => { out.push({ level, check, detail }) }
  const exec = opts.run ?? ((argv, o) => run(argv, o))
  const configDir = ctx.paths.opencodeConfigDir()

  const bin = await (opts.detect ?? (() => detectBinary('opencode')))()
  if (!bin.installed || bin.path === undefined) {
    add('warn', 'opencode.binary', 'opencode is not on PATH; install OpenCode v2 (brew install anomalyco/tap/opencode-v2) to use this adapter')
  } else if (bin.version === undefined) {
    add('error', 'opencode.version', `${bin.path}: could not read \`opencode --version\``)
  } else if (compareVersions(bin.version, '2.0.0') < 0) {
    add('error', 'opencode.version', `OpenCode ${bin.version} is v1; Buracle targets v2 (≥ ${MIN_VERSION}). Install anomalyco/tap/opencode-v2`)
  } else if (compareVersions(bin.version, MIN_VERSION) < 0) {
    add('error', 'opencode.version', `OpenCode ${bin.version} is older than ${MIN_VERSION}; run \`opencode upgrade\``)
  } else if (bin.version !== TESTED_WITH) {
    add('warn', 'opencode.version', `OpenCode ${bin.version} (tested with ${TESTED_WITH}); run \`buracle doctor\` again after checking the plugin works`)
  } else {
    add('ok', 'opencode.version', `OpenCode ${bin.version} (tested)`)
  }
  const limits = hostLimitsRow('opencode', bin.installed ? bin.version : undefined, 'tests/adapters/opencode/smoke.test.ts')
  if (limits !== undefined) out.push(limits)

  const target = configTarget(configDir)
  const both = pathExistsSync(join(configDir, 'opencode.json')) && pathExistsSync(join(configDir, 'opencode.jsonc'))
  const parsed = readJsonc(target)
  if (parsed === undefined) {
    add('error', 'opencode.config', `${target} is missing; run \`buracle install opencode\``)
  } else if (!parsed.ok) {
    add('error', 'opencode.config', `${target} does not parse (${parsed.error})`)
  } else {
    const cfg = parsed.value
    const lowerParsed = both && target !== join(configDir, 'opencode.json') ? readJsonc(join(configDir, 'opencode.json')) : undefined
    const lower = lowerParsed?.ok === true ? lowerParsed.value : undefined
    const look = (path: string[]) => { const a = getIn(cfg, path); return a.found || lower === undefined ? a : getIn(lower, path) }
    const missing: string[] = []
    if (getIn(cfg, ['$schema']).value !== CONFIG_SCHEMA_URL) missing.push('$schema')
    if (look(['share']).value !== 'disabled') missing.push('share: disabled')
    for (const [id] of opencodeServers(ctx.canonical, ctx.buracleBin)) {
      if (!look(['mcp', 'servers', id]).found) missing.push(`mcp.servers.${id}`)
    }
    const listOf = (doc: unknown) => { const v = getIn(doc, ['permissions']).value; return Array.isArray(v) ? v : [] }
    const perms = [...(lower !== undefined ? listOf(lower) : []), ...listOf(cfg)]
    const lost = configPermissions(ctx.canonical).filter(r => !perms.some(p => sameRule(p, r)))
    if (lost.length > 0) missing.push(`${lost.length} Buracle permission rule(s)`)
    if (missing.length === 0) add('ok', 'opencode.config', `${target} has the Buracle keys${both ? ' (opencode.json is loaded too; opencode.jsonc wins)' : ''}`)
    else add('warn', 'opencode.config', `${target} lacks: ${missing.join(', ')} (user values are kept; see \`buracle install --dry-run\`)`)
    for (const f of contextModeFindings(ctx.canonical, ctx.buracleBin, look(['mcp', 'servers', CM_SERVER_ID]).value, perms)) add(f.level, 'opencode.context-mode', f.detail)
    const servers: Record<string, unknown> = {}
    for (const [id] of opencodeServers(ctx.canonical, ctx.buracleBin)) servers[id] = look(['mcp', 'servers', id]).value
    for (const f of mcpCommandFindings(servers, process.env)) add(f.level, 'opencode.mcp.command', f.detail)
  }

  const cli = readJsonc(join(configDir, 'cli.json'))
  if (cli?.ok === false) add('error', 'opencode.cli', `cli.json does not parse (${cli.error}); OpenCode falls back to defaults`)
  else {
    const off = disablesPlugin(obj(cli?.ok === true ? cli.value : undefined)?.['plugins'])
    if (off !== undefined) add('warn', 'opencode.cli', `cli.json disables the Buracle status line and workflow band ("${off}")`)
    else add('ok', 'opencode.cli', 'cli.json does not disable the Buracle TUI plugin (built-in footer kept)')
  }
  const permission = permissionFinding(ctx.config.permissions, cli?.ok === true ? getIn(cli.value, ['session', 'permissions']).value : undefined)
  add(permission.level, 'opencode.permissions', permission.detail)

  const effort = effortFinding(ctx.config.effort.opencode, parsed?.ok === true ? parsed.value : undefined, rememberedVariants())
  add(effort.level, 'opencode.effort', effort.detail)

  let hashes: Record<string, string> | undefined
  try {
    hashes = Object.fromEntries((await buildFiles(ctx)).map(f => [f.path, sha256(f.content)]))
  } catch {
    try { hashes = (JSON.parse(readFileSync(join(ctx.repoRoot, 'harness', 'opencode', 'manifest.json'), 'utf8')) as { files?: Record<string, string> }).files } catch { hashes = undefined }
  }
  const expected = Object.entries(hashes ?? {}).filter(([p]) => p.startsWith(`${PLUGIN_DIR}/`) || p.startsWith('agents/') || p.startsWith('commands/'))
  if (expected.length === 0) {
    for (const f of ['index.js', 'tui.js']) {
      const p = join(configDir, PLUGIN_DIR, f)
      add(pathExistsSync(p) ? 'ok' : 'error', `opencode.plugin.${f}`, pathExistsSync(p) ? `${p} present` : `${p} missing; run \`buracle install opencode\``)
    }
  } else {
    const absent: string[] = []
    const stale: string[] = []
    for (const [rel, hash] of expected) {
      const t = readTextSync(join(configDir, rel))
      if (!t.ok) absent.push(rel)
      else if (sha256(t.value) !== hash) stale.push(rel)
    }
    if (absent.length > 0) add('error', 'opencode.files', `missing in ${configDir}: ${absent.join(', ')}; run \`buracle install opencode\``)
    else if (stale.length > 0) add('warn', 'opencode.files', `outdated: ${stale.join(', ')} (run \`buracle install opencode\`)`)
    else add('ok', 'opencode.files', `plugin and ${expected.filter(([p]) => p.startsWith('agents/')).length} agents are current`)
  }
  for (const f of commandFindings(ctx, configDir, parsed?.ok === true ? parsed.value : undefined)) add(f.level, 'opencode.commands', f.detail)
  const pointer = readJsonc(join(configDir, PLUGIN_DIR, POINTER_FILE))
  const pbh = pointer?.ok === true ? obj(pointer.value)?.['buracleHome'] : undefined
  if (pbh === ctx.paths.buracleHome()) add('ok', 'opencode.pointer', `${POINTER_FILE} points at ${String(pbh)}`)
  else add('warn', 'opencode.pointer', `${join(configDir, PLUGIN_DIR, POINTER_FILE)} ${pbh === undefined ? 'is missing' : `points at ${String(pbh)}`}; expected ${ctx.paths.buracleHome()}`)

  const agentsMd = readTextSync(join(configDir, 'AGENTS.md'))
  let block: string | undefined
  try { block = agentsMd.ok ? mdBlockGet(agentsMd.value, AGENTS_BLOCK_ID) : undefined } catch { block = undefined }
  add(block !== undefined ? 'ok' : 'warn', 'opencode.agents-md', block !== undefined ? `managed block "${AGENTS_BLOCK_ID}" present in AGENTS.md` : `no managed Buracle block in ${join(configDir, 'AGENTS.md')}`)

  if (bin.installed && bin.path !== undefined && bin.version !== undefined && compareVersions(bin.version, MIN_VERSION) >= 0) {
    const env = await exec([bin.path, 'service', 'get', 'env', 'BURACLE_HOME'], { timeoutMs: CMD_TIMEOUT_MS })
    const value = env.stdout.trim()
    if (env.code === 0 && value === ctx.paths.buracleHome()) add('ok', 'opencode.service-env', `background service env BURACLE_HOME=${value}`)
    else add('warn', 'opencode.service-env', env.code === 0 ? `service env BURACLE_HOME is ${value === '' ? 'unset' : value} (expected ${ctx.paths.buracleHome()}); the plugin falls back to ${POINTER_FILE}` : `\`opencode service get env\` failed (exit ${env.code})`)
    if (opts.live !== false) {
      const status = await exec([bin.path, 'service', 'status'], { timeoutMs: CMD_TIMEOUT_MS })
      const url = status.stdout.trim()
      if (status.code !== 0 || url === '' || url === 'stopped') {
        add('ok', 'opencode.live', 'background service not running; live plugin check skipped (open OpenCode once, then rerun doctor)')
      } else {
        const list = await exec([bin.path, 'plugin', 'list'], { timeoutMs: CMD_TIMEOUT_MS })
        const active = list.code === 0 && list.stdout.split('\n').some(l => l.trim().startsWith(`${PLUGIN_ID} `))
        add(active ? 'ok' : 'warn', 'opencode.live.plugin', active ? `server plugin "${PLUGIN_ID}" is loaded by the service at ${url}` : `server plugin "${PLUGIN_ID}" is not listed by \`opencode plugin list\` (service ${url}); check ${join(ctx.paths.opencodeDataDir(), 'log')}`)
        const dbg = await exec([bin.path, 'debug', 'config'], { timeoutMs: CMD_TIMEOUT_MS })
        let mcpSeen = false
        try {
          const docs = JSON.parse(dbg.stdout) as unknown
          mcpSeen = Array.isArray(docs) && docs.some(d => getIn(obj(d)?.['info'], ['mcp', 'servers', 'buracle-memory']).found)
        } catch { mcpSeen = false }
        add(mcpSeen ? 'ok' : 'warn', 'opencode.live.config', mcpSeen ? 'the service sees the Buracle MCP servers (`opencode debug config`)' : '`opencode debug config` does not show mcp.servers.buracle-memory')
      }
    }
  }

  const launchers = new Set<string>()
  for (const [, entry] of opencodeServers(ctx.canonical, ctx.buracleBin)) {
    const cmd = Array.isArray(entry['command']) ? entry['command'][0] : undefined
    if (cmd === 'npx' || cmd === 'uvx') launchers.add(cmd)
  }
  for (const l of [...launchers].sort()) add(which(l) !== undefined ? 'ok' : 'warn', `opencode.mcp.${l}`, which(l) !== undefined ? `${l} found` : `${l} not on PATH; MCP servers started with ${l} will fail`)

  const signs = claudeSubscriptionSigns(ctx.paths.opencodeDataDir(), [join(configDir, 'opencode.json'), join(configDir, 'opencode.jsonc')])
  if (signs.length > 0) add('warn', 'opencode.claude-subscription', `Claude subscription auth detected (${signs.join('; ')}). Anthropic permits Pro/Max OAuth only in Claude Code; use an API key, ChatGPT, Copilot or OpenCode Zen/Go in OpenCode`)
  else add('ok', 'opencode.claude-subscription', 'no Claude subscription credentials or auth plugins found')
  return out
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterContext } from '../registry'
import type { BuracleConfig } from '../../core/config'
import { CM_SERVER_ID } from '../../core/context-mode'
import { resolveEffort } from '../../core/effort'
import { mdBlockGet } from '../../engine/merge'
import { detectBinary, run as runProcess, type RunOptions, type RunResult } from '../../engine/proc'
import { TESTED_WITH } from '../../engine/update/tested-with'
import { hostLimitsRow } from '../shared/host-limits'
import { resolveArgv, resolveCommandLine, type Env } from '../shared/command'
import { pathRuleFiles } from '../shared/rules'
import { valueHash } from '../../engine/merge'
import { BYPASS_KEYS, CRITICAL_OMIT_TOOLS_FROM, SUBAGENT_EFFORTS, type McpTable } from './config'
import { AGENTS_BLOCK_ID, codexArtifacts, RULES_FILE } from './generate'
import { CODEX_HOOK_EVENTS, duplicateBuracleHandlers, findBuracleHandlers, type FoundHandler } from './hooks-config'

export const MIN_CODEX = TESTED_WITH.codex.min
export const TESTED_CODEX = TESTED_WITH.codex.tested

export type DoctorLevel = 'ok' | 'warn' | 'error'
export interface DoctorItem { level: DoctorLevel, check: string, detail: string }

export interface DoctorDeps {
  detect: () => Promise<{ installed: boolean, version?: string, path?: string }>
  run: (argv: string[], opts?: RunOptions) => Promise<RunResult>
  env?: () => Env
  probe?: (argv: string[], opts?: RunOptions) => Promise<RunResult>
}

export function defaultDoctorDeps(): DoctorDeps {
  return { detect: () => detectBinary('codex'), run: runProcess, env: () => process.env, probe: runProcess }
}

export const PROBE_COMMAND = 'rm -rf ~'

// On Windows the command is the handler's commandWindows, which cmd.exe runs (/s drops the outer pair of quotes).
export async function guardProbe(command: string, run: NonNullable<DoctorDeps['probe']>, cwd: string, platform: NodeJS.Platform = process.platform): Promise<DoctorItem> {
  const check = 'codex.hooks.probe'
  const payload = JSON.stringify({ session_id: 'buracle-doctor-probe', turn_id: 't0', transcript_path: null, cwd, hook_event_name: 'PreToolUse', model: 'probe', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_use_id: 'probe', tool_input: { command: PROBE_COMMAND } })
  const argv = platform === 'win32' ? ['cmd.exe', '/d', '/s', '/c', `"${command}"`] : ['/bin/sh', '-c', command]
  const r = await run(argv, { stdin: payload, cwd, timeoutMs: 30_000, env: { BURACLE_NO_CAPTURE: '1', BURACLE_NO_MEMORY: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_NOTIFY: '1' } })
  let decision: unknown
  try { decision = rec(rec(JSON.parse(r.stdout) as unknown)['hookSpecificOutput'])['permissionDecision'] } catch { decision = undefined }
  if (decision === 'deny') return { level: 'ok', check, detail: `the PreToolUse hook denies \`${PROBE_COMMAND}\` (H01), started as Codex starts it` }
  const why = r.timedOut ? 'timed out' : `exit ${r.code}${r.stderr.trim() !== '' ? `: ${r.stderr.trim().split('\n')[0]?.slice(0, 200)}` : ''}`
  return { level: 'error', check, detail: `the PreToolUse hook did not deny \`${PROBE_COMMAND}\` (${why}): Codex would run tools unguarded; check \`buracle doctor config\` and ~/.buracle/logs/buracle.log` }
}

export function hookCommandProblems(handlers: readonly FoundHandler[], env: Env): string[] {
  const missing = new Map<string, string[]>()
  const unresolved: string[] = []
  for (const h of handlers) {
    const r = resolveCommandLine(h.command, env)
    if (r.executable !== undefined) continue
    if (r.program === undefined) { unresolved.push(`${h.event}: cannot resolve the program of \`${h.command}\``); continue }
    const events = missing.get(r.program) ?? []
    if (!events.includes(h.event)) events.push(h.event)
    missing.set(r.program, events)
  }
  return [
    ...[...missing].map(([program, events]) => `${events.join(', ')}: ${program} does not exist or is not executable`),
    ...unresolved,
  ]
}

export function mcpCommandProblems(configText: string | undefined, ids: readonly string[], env: Env): { errors: string[], warnings: string[] } {
  const out = { errors: [] as string[], warnings: [] as string[] }
  if (configText === undefined) return out
  let servers: Record<string, unknown>
  try { servers = rec(rec(Bun.TOML.parse(configText) as Record<string, unknown>)['mcp_servers']) } catch { return out }
  for (const id of ids) {
    const s = rec(servers[id])
    if (typeof s['command'] !== 'string') continue
    const args = Array.isArray(s['args']) ? s['args'].filter((a): a is string => typeof a === 'string') : []
    const r = resolveArgv([s['command'], ...args], env)
    if (r.executable !== undefined) continue
    if (r.program !== undefined && !/[\\/]/.test(r.program)) out.warnings.push(`${id}: \`${r.program}\` is not on PATH`)
    else out.errors.push(r.program !== undefined ? `${id}: \`${r.program}\` does not exist or is not executable` : `${id}: the program of \`${s['command']}\` cannot be resolved`)
  }
  return out
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).slice(0, 3).map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function rec(x: unknown): Record<string, unknown> {
  return isObj(x) ? x : {}
}

export interface TrustReport { trusted: string[], untrusted: string[], modified: string[], disabled: string[] }

export function hookTrustReport(hooksJsonPath: string, hooksJsonText: string, configText: string | undefined): TrustReport {
  const out: TrustReport = { trusted: [], untrusted: [], modified: [], disabled: [] }
  let parsed: unknown
  try { parsed = JSON.parse(hooksJsonText) } catch { return out }
  let state: Record<string, unknown> = {}
  if (configText !== undefined) {
    try { state = rec(rec((Bun.TOML.parse(configText) as Record<string, unknown>)['hooks'])['state']) } catch { state = {} }
  }
  for (const h of findBuracleHandlers(parsed, hooksJsonPath)) {
    const s = rec(state[h.key])
    const label = `${h.event}#${h.groupIndex}`
    if (s['enabled'] === false) { out.disabled.push(label); continue }
    const trusted = typeof s['trusted_hash'] === 'string' ? s['trusted_hash'] : undefined
    if (trusted === undefined) out.untrusted.push(label)
    else if (trusted === h.hash) out.trusted.push(label)
    else out.modified.push(label)
  }
  return out
}

function parseToml(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return {}
  try { return Bun.TOML.parse(text) as Record<string, unknown> } catch { return undefined }
}

export function permissionCheck(toml: Record<string, unknown>, cfg: Pick<BuracleConfig, 'permissions'>): DoctorItem {
  const check = 'codex.permissions'
  const live = Object.keys(BYPASS_KEYS).map(k => `${k} = ${toml[k] === undefined ? '(unset)' : JSON.stringify(toml[k])}`).join(', ')
  if (!cfg.permissions.bypass) return { level: 'ok', check, detail: `permissions.bypass is off: Codex asks as configured (${live})` }
  const off = Object.entries(BYPASS_KEYS).filter(([k, v]) => toml[k] === undefined || valueHash(toml[k]) !== valueHash(v)).map(([k]) => k)
  if (off.length === 0) return { level: 'ok', check, detail: `${live}: Codex starts without approval prompts; only the H20 consent rule asks` }
  const old = toml['approval_policy'] === 'never' && off.length === 1 && off[0] === 'approval_policy'
    ? ' approval_policy "never" still runs without approvals, but it turns the H20 consent rule into a refusal, so the consent question never opens in Codex.'
    : ''
  const split = off.length < Object.keys(BYPASS_KEYS).length && old === '' ? ' The two keys are one unit: a no-approval policy with a narrower sandbox refuses every call that needs an approval, MCP tools included.' : ''
  const fix = cfg.permissions.enforce
    ? 'run `buracle install codex` (permissions.enforce writes them again)'
    : 'permissions.enforce is off, so Buracle keeps your values: set both keys yourself, or turn permissions.enforce on and run `buracle install codex`'
  return { level: 'warn', check, detail: `permissions.bypass is on, but Codex does not start in Buracle's no-approval mode (${live}).${old}${split} To fix it, ${fix}.` }
}

export function effortCheck(toml: Record<string, unknown>, cfg: Pick<BuracleConfig, 'effort'>): DoctorItem {
  const check = 'codex.effort'
  const r = resolveEffort('codex', cfg.effort.codex)
  const agents = rec(toml['agents'])
  const live = {
    model: typeof toml['model_reasoning_effort'] === 'string' ? toml['model_reasoning_effort'] : undefined,
    plan: typeof toml['plan_mode_reasoning_effort'] === 'string' ? toml['plan_mode_reasoning_effort'] : undefined,
    sub: typeof agents['default_subagent_reasoning_effort'] === 'string' ? agents['default_subagent_reasoning_effort'] as string : undefined,
  }
  if (live.sub !== undefined && !SUBAGENT_EFFORTS.includes(live.sub)) {
    return { level: 'warn', check, detail: `[agents] default_subagent_reasoning_effort = "${live.sub}" is not a level every Codex model has (${SUBAGENT_EFFORTS.join(', ')}), so spawn_agent fails on the others` }
  }
  if ('invalid' in r) return { level: 'warn', check, detail: `effort.codex: ${r.invalid}` }
  if ('off' in r) return { level: 'ok', check, detail: `effort.codex is keep: Codex's own setting applies (model_reasoning_effort = ${live.model ?? 'unset, the model default'})` }
  if (live.model === r.level && live.plan === r.level) return { level: 'ok', check, detail: `model_reasoning_effort and plan_mode_reasoning_effort = "${r.level}", subagents "${live.sub ?? 'model default'}" (effort.codex ${cfg.effort.codex})` }
  if (live.model !== r.level) {
    const why = isObj(rec(toml['notice'])['model_migrations'])
      ? 'Codex rewrote it when a model migration was accepted ([notice.model_migrations] in config.toml)'
      : 'Codex rewrites it when you accept a model migration or pick a model with /model'
    return { level: 'warn', check, detail: `model_reasoning_effort is ${live.model === undefined ? 'unset' : `"${live.model}"`}, effort.codex wants "${r.level}". ${why}; a value you or Codex set is kept. Pick ${r.level} in /model, or delete the line and run \`buracle install codex\` in a terminal (it asks to put Buracle's value back).` }
  }
  return { level: 'warn', check, detail: `plan_mode_reasoning_effort is ${live.plan === undefined ? 'unset' : `"${live.plan}"`}, effort.codex wants "${r.level}" (Plan mode runs at medium without it); a value you set is kept. Delete the line and run \`buracle install codex\` in a terminal to use Buracle's (it asks to put the value back).` }
}

export function routingCheck(toml: Record<string, unknown>, ctx: Pick<AdapterContext, 'canonical' | 'config'>): DoctorItem {
  const check = 'codex.routing'
  const servers = rec(toml['mcp_servers'])
  const problems: string[] = []
  const hidden = Object.keys(ctx.canonical.mcp.servers).sort().filter(id => {
    const spec = ctx.canonical.mcp.servers[id]
    if (spec === undefined || !spec.critical || !spec.harnesses.includes('codex') || !isObj(servers[id])) return false
    const omit = rec(servers[id])['omit_tools_from']
    return !(Array.isArray(omit) && CRITICAL_OMIT_TOOLS_FROM.every(s => omit.includes(s)))
  })
  if (hidden.length > 0) problems.push(`the tools of ${hidden.join(', ')} can hide behind tool_search or code mode (omit_tools_from lacks ${CRITICAL_OMIT_TOOLS_FROM.join(' or ')})`)
  if (toml['mcp_optional_startup_grace_ms'] !== 0) problems.push(`mcp_optional_startup_grace_ms is ${toml['mcp_optional_startup_grace_ms'] === undefined ? 'unset (1 s)' : JSON.stringify(toml['mcp_optional_startup_grace_ms'])}, so an MCP server still starting misses the first turn`)
  if (ctx.config.routing.strictness === 'enforce' && toml['web_search'] !== 'disabled') problems.push(`web_search is ${toml['web_search'] === undefined ? 'unset (cached)' : JSON.stringify(toml['web_search'])} while routing is enforced, so the built-in web search competes with the web-search MCP server`)
  if (problems.length > 0) return { level: 'warn', check, detail: `${problems.join('; ')}; run \`buracle install codex\` (a value you set yourself is kept)` }
  return { level: 'ok', check, detail: `critical MCP tools are top-level from the first turn${ctx.config.routing.strictness === 'enforce' ? '; the built-in web search is off (routing enforced)' : ''}` }
}

function sameSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sb].every(x => sa.has(x))
}

function listText(x: unknown): string {
  return Array.isArray(x) ? (x.length > 0 ? x.join(', ') : 'empty') : 'not set'
}

export function contextModeCheck(r: RunResult, want: McpTable): DoctorItem {
  const check = 'codex.context-mode'
  const cmd = `\`codex mcp get ${CM_SERVER_ID} --json\``
  if (r.code !== 0) {
    const why = r.timedOut ? 'timed out' : `exit ${r.code}${(r.stderr || r.stdout).trim() !== '' ? `: ${(r.stderr || r.stdout).trim().split('\n')[0]?.slice(0, 200)}` : ''}`
    return { level: 'warn', check, detail: `${cmd} failed (${why})` }
  }
  let live: unknown
  try { live = JSON.parse(r.stdout) } catch { live = undefined }
  if (!isObj(live)) return { level: 'warn', check, detail: `${cmd} did not return a JSON object` }
  const problems: string[] = []
  const done: string[] = []
  for (const key of ['enabled_tools', 'disabled_tools'] as const) {
    const w = want[key]
    if (!Array.isArray(w)) continue
    const l = live[key]
    if (!Array.isArray(l) || !sameSet(l, w)) problems.push(`${key} is ${listText(l)} (Buracle writes ${listText(w)})`)
    else done.push(key === 'enabled_tools' ? `${w.length} tools offered` : `${listText(w)} hidden`)
  }
  const timeout = want['tool_timeout_sec']
  if (typeof timeout === 'number') {
    const l = live['tool_timeout_sec']
    if (l !== timeout) problems.push(`tool_timeout_sec is ${typeof l === 'number' ? l : 'not set (Codex stops a call after 300 s)'} (Buracle writes ${timeout})`)
    else done.push(`calls up to ${timeout} s`)
  }
  const env = rec(rec(live['transport'])['env'])
  for (const [k, v] of Object.entries(rec(want['env']))) {
    if (env[k] !== v) problems.push(`env ${k} is ${typeof env[k] === 'string' ? JSON.stringify(env[k]) : 'not set'} (Buracle writes ${JSON.stringify(v)})`)
    else done.push(`${k}=${String(v)}`)
  }
  if (problems.length > 0) return { level: 'warn', check, detail: `context-mode in Codex's config: ${problems.join('; ')}; run \`buracle install codex\` (Codex ignores a key it cannot read)` }
  return { level: 'ok', check, detail: `context-mode as Buracle writes it: ${done.length > 0 ? done.join(', ') : 'no tool lists, timeout or env to check'}` }
}

export function configLoadCheck(r: RunResult): DoctorItem {
  const check = 'codex.config'
  let report: unknown
  try { report = JSON.parse(r.stdout) } catch { report = undefined }
  const load = rec(rec(rec(report)['checks'])['config.load'])
  if (load['status'] === undefined) {
    const why = r.timedOut ? 'timed out' : `exit ${r.code}${r.stderr.trim() !== '' ? `: ${r.stderr.trim().split('\n')[0]?.slice(0, 160)}` : ''}`
    return { level: 'warn', check, detail: `\`codex doctor --json\` gave no config report (${why})` }
  }
  const details = rec(load['details'])
  if (load['status'] === 'fail') {
    return { level: 'error', check, detail: `Codex cannot load its config, so it does not start: ${String(details['error'] ?? load['summary'] ?? 'unknown error')}${typeof load['remediation'] === 'string' ? ` (${load['remediation']})` : ''}` }
  }
  const warning = typeof details['startup warning'] === 'string' ? details['startup warning'].replace(/\s+/g, ' ').trim() : ''
  if (load['status'] === 'warning' || warning !== '') return { level: 'warn', check, detail: `Codex startup warning: ${warning !== '' ? warning.slice(0, 400) : String(load['summary'] ?? 'see codex doctor')}` }
  return { level: 'ok', check, detail: 'Codex loads its config without warnings' }
}

export function featureEnabled(listing: string, name: string): boolean | undefined {
  for (const line of listing.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] === name && cols.length >= 2) {
      const last = cols[cols.length - 1]
      if (last === 'true') return true
      if (last === 'false') return false
    }
  }
  return undefined
}

export async function codexDoctor(ctx: AdapterContext, deps: DoctorDeps = defaultDoctorDeps()): Promise<DoctorItem[]> {
  const items: DoctorItem[] = []
  const add = (level: DoctorLevel, check: string, detail: string) => { items.push({ level, check, detail }) }
  const codexHome = ctx.paths.codexHome()
  const env: Env = deps.env?.() ?? process.env

  const found = await deps.detect()
  if (!found.installed) {
    add('error', 'codex.version', `codex is not on PATH (needs ${MIN_CODEX} or newer; tested ${TESTED_CODEX}). Install it with \`brew install --cask codex\`.`)
  } else if (found.version === undefined) {
    add('warn', 'codex.version', `could not read \`codex --version\` (${found.path ?? 'codex'})`)
  } else if (compareVersions(found.version, MIN_CODEX) < 0) {
    add('error', 'codex.version', `codex ${found.version} is older than ${MIN_CODEX}; run \`codex update\``)
  } else if (compareVersions(found.version, TESTED_CODEX) > 0) {
    add('warn', 'codex.version', `codex ${found.version} is newer than the tested ${TESTED_CODEX}; hooks and rollout parsing may need a check`)
  } else {
    add('ok', 'codex.version', `codex ${found.version} (minimum ${MIN_CODEX}, tested ${TESTED_CODEX})`)
  }
  const limits = hostLimitsRow('codex', found.installed ? found.version : undefined, 'tests/adapters/codex/smoke.test.ts')
  if (limits !== undefined) items.push(limits)
  add('ok', 'codex.workflow-view', ctx.config.workflow.codexNotices
    ? 'Codex has no surface above the prompt: a workflow that waits, pauses or ends and failing Buracle hooks show as one warning line (workflow.codexNotices); the tmux status line (`buracle statusline codex`, USAGE §6) shows the full bar'
    : 'workflow.codexNotices is off: the tmux status line (`buracle statusline codex`, USAGE §6) is the only live view of a workflow and of failing Buracle hooks')

  const hooksPath = join(codexHome, 'hooks.json')
  const hooksText = readText(hooksPath)
  const configText = readText(join(codexHome, 'config.toml'))
  if (hooksText === undefined) {
    add('error', 'codex.hooks', `${hooksPath} is missing; run \`buracle install codex\``)
  } else {
    let parsed: unknown
    try { parsed = JSON.parse(hooksText) } catch { parsed = undefined }
    if (parsed === undefined) add('error', 'codex.hooks', `${hooksPath} is not valid JSON; Codex ignores it`)
    else {
      const handlers = findBuracleHandlers(parsed, hooksPath)
      const missing = CODEX_HOOK_EVENTS.filter(e => !handlers.some(h => h.event === e))
      if (missing.length > 0) add('error', 'codex.hooks', `Buracle hooks missing for ${missing.join(', ')} in ${hooksPath}; run \`buracle install codex\` (\`--dry-run\` lists conflicts)`)
      else add('ok', 'codex.hooks', `all ${CODEX_HOOK_EVENTS.length} Buracle events are registered`)
      const dups = duplicateBuracleHandlers(handlers, parsed)
      if (dups.length > 0) add('warn', 'codex.hooks', `Buracle handlers registered more than once (they run twice): ${dups.join(', ')}; remove the extra copies from ${hooksPath}`)
      if (handlers.length > 0) {
        const problems = hookCommandProblems(handlers, env)
        const bh = env['BURACLE_HOME']
        if (problems.length > 0) {
          add('error', 'codex.hooks.command', `Codex cannot start Buracle's hooks, so it runs every tool unguarded (hooks fail open): ${problems.join('; ')}. ${bh !== undefined && bh !== '' ? `BURACLE_HOME is ${bh} here; ` : ''}install Buracle again (\`buracle install codex\`) and make sure Codex starts with the same BURACLE_HOME as this shell.`)
        } else {
          add('ok', 'codex.hooks.command', `every Buracle hook command resolves to an executable${bh !== undefined && bh !== '' ? ` (BURACLE_HOME=${bh}; Codex needs it in its environment too)` : ''}`)
        }
      }
      const pre = handlers.find(h => h.event === 'PreToolUse')
      if (pre !== undefined && deps.probe !== undefined) items.push(await guardProbe(pre.command, deps.probe, ctx.paths.home()))
      const t = hookTrustReport(hooksPath, hooksText, configText)
      const pending = [...t.untrusted, ...t.modified]
      if (t.disabled.length > 0) add('warn', 'codex.hooks.trust', `disabled in /hooks: ${t.disabled.join(', ')}`)
      if (pending.length > 0) {
        add('warn', 'codex.hooks.trust', `${pending.length} Buracle hook(s) need approval: open Codex, run /hooks and trust ${pending.join(', ')}${t.modified.length > 0 ? ` (changed since approval: ${t.modified.join(', ')})` : ''}`)
      } else if (t.trusted.length > 0) add('ok', 'codex.hooks.trust', `${t.trusted.length} Buracle hook(s) trusted`)
    }
  }

  const codex = found.path ?? 'codex'
  const feats = found.installed ? await deps.run([codex, 'features', 'list'], { timeoutMs: 15000 }) : { code: -1, stdout: '', stderr: 'codex is not installed', timedOut: false }
  if (feats.code !== 0) add('warn', 'codex.features', `\`codex features list\` failed (exit ${feats.code}): ${(feats.stderr || feats.stdout).trim().slice(0, 200)}`)
  else {
    const hooksOn = featureEnabled(feats.stdout, 'hooks')
    if (hooksOn === false) add('error', 'codex.features', 'hooks are disabled (`[features] hooks = false`); Buracle guards and memory capture do not run')
    else if (hooksOn === undefined) add('warn', 'codex.features', 'the `hooks` feature is not listed by `codex features list`')
    else add('ok', 'codex.features', 'hooks are enabled')
    if (featureEnabled(feats.stdout, 'memories') === true) add('warn', 'codex.memories', 'Codex native memories are on (a value you set; the install keeps it); Buracle keeps its brain as the single memory, so set `[features] memories = false` (`codex features disable memories`)')
  }

  const tables = codexArtifacts({ canonical: ctx.canonical, buracle: ctx.buracleBin, pathRulesDir: '' }).mcpTables
  const expected = Object.keys(tables).map(n => n.slice('mcp_servers.'.length))
  const mcp = found.installed ? await deps.run([codex, 'mcp', 'list', '--json'], { timeoutMs: 15000 }) : { code: -1, stdout: '', stderr: 'codex is not installed', timedOut: false }
  let listed: Set<string> | undefined
  if (mcp.code !== 0) add('warn', 'codex.mcp', `\`codex mcp list --json\` failed (exit ${mcp.code}): ${(mcp.stderr || mcp.stdout).trim().slice(0, 200)}`)
  else {
    let list: unknown
    try { list = JSON.parse(mcp.stdout) } catch { list = undefined }
    if (!Array.isArray(list)) add('warn', 'codex.mcp', '`codex mcp list --json` did not return a JSON array')
    else {
      const byName = new Map(list.map(x => [String(rec(x)['name']), rec(x)] as const))
      listed = new Set(byName.keys())
      const missing = expected.filter(id => !byName.has(id))
      const disabled = expected.filter(id => byName.get(id)?.['enabled'] === false)
      if (missing.length > 0) add('error', 'codex.mcp', `MCP servers missing from Codex: ${missing.join(', ')}`)
      else if (disabled.length > 0) add('warn', 'codex.mcp', `MCP servers disabled in Codex: ${disabled.join(', ')}`)
      else add('ok', 'codex.mcp', `${expected.length} Buracle MCP servers configured`)
    }
  }
  const cmTable = tables[`mcp_servers.${CM_SERVER_ID}`]
  if (found.installed && cmTable !== undefined && listed?.has(CM_SERVER_ID) !== false) {
    items.push(contextModeCheck(await deps.run([codex, 'mcp', 'get', CM_SERVER_ID, '--json'], { timeoutMs: 15000 }), cmTable))
  }
  const mcpProblems = mcpCommandProblems(configText, expected, env)
  if (mcpProblems.errors.length > 0) add('error', 'codex.mcp.command', `MCP server commands that do not resolve to an executable: ${mcpProblems.errors.join('; ')}; run \`buracle install codex\` again (BURACLE_HOME moved or the shim is missing)`)
  if (mcpProblems.warnings.length > 0) add('warn', 'codex.mcp.command', `MCP package runners not found on PATH: ${mcpProblems.warnings.join('; ')}`)

  const agentsPath = join(codexHome, 'AGENTS.md')
  const override = readText(join(codexHome, 'AGENTS.override.md'))
  let block: string | undefined
  let malformed: string | undefined
  try { block = mdBlockGet(readText(agentsPath) ?? '', AGENTS_BLOCK_ID) } catch (e) { malformed = e instanceof Error ? e.message : String(e) }
  if (malformed !== undefined) add('error', 'codex.agents_md', `${agentsPath}: ${malformed}`)
  else if (block === undefined) add('error', 'codex.agents_md', `the Buracle block is missing from ${agentsPath}`)
  else if (override !== undefined && override.trim() !== '') add('warn', 'codex.agents_md', `${join(codexHome, 'AGENTS.override.md')} is non-empty, so Codex ignores AGENTS.md and the Buracle rules`)
  else add('ok', 'codex.agents_md', 'Buracle rules block present in AGENTS.md')

  const rulesDir = join(ctx.paths.buracleHome(), 'rules', 'paths')
  const missingRules = pathRuleFiles(ctx.canonical).filter(r => readText(join(rulesDir, r.file)) === undefined).map(r => r.file)
  if (missingRules.length > 0) add('warn', 'codex.path_rules', `path rules missing in ${rulesDir}: ${missingRules.join(', ')} (the AGENTS.md index points to them); run \`buracle install\``)
  else add('ok', 'codex.path_rules', 'path rules present')

  const agentFiles = ctx.canonical.agents.map(a => join(codexHome, 'agents', `${a.id}.toml`))
  const missingAgents = agentFiles.filter(f => readText(f) === undefined)
  if (missingAgents.length > 0) add('warn', 'codex.agents', `review agents missing: ${missingAgents.join(', ')}`)
  else add('ok', 'codex.agents', `${agentFiles.length} review agents installed`)
  if (readText(join(codexHome, 'rules', RULES_FILE)) === undefined) add('warn', 'codex.rules', `${join(codexHome, 'rules', RULES_FILE)} is missing (execpolicy guard for catastrophic commands)`)
  else add('ok', 'codex.rules', 'execpolicy rules installed')

  const toml = parseToml(configText)
  if (toml === undefined) add('error', 'codex.config', `${join(codexHome, 'config.toml')} is not valid TOML, so Codex does not start`)
  else items.push(permissionCheck(toml, ctx.config), effortCheck(toml, ctx.config), routingCheck(toml, ctx))

  if (found.installed && toml !== undefined) items.push(configLoadCheck(await deps.run([codex, 'doctor', '--json'], { timeoutMs: 60_000 })))
  return items
}

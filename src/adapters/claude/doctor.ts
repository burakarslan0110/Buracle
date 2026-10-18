import { accessSync, constants, statSync } from 'node:fs'
import { join } from 'node:path'
import { catalogSkills } from '../../core/catalog'
import type { BuracleConfig } from '../../core/config'
import { EFFORT_SCALES, resolveEffort } from '../../core/effort'
import { compileTriggers } from '../../core/policy/skill-router'
import { describeIndexState, indexHealth } from '../../core/workspace'
import { readJsonSafeSync } from '../../engine/fsx'
import * as paths from '../../engine/paths'
import { parseVersion, run as runProc, which, type RunOptions, type RunResult } from '../../engine/proc'
import { indexSummary, projectRootFor } from '../../workflow/workspace'
import type { AdapterContext } from '../registry'
import { parseList, samePath, type PluginEntry } from './check'
import { EFFORT_MODELS, HARNESS_REL, MIN_CLAUDE, PLUGIN_ID, TESTED_WITH } from './constants'
import { lastSessionMode } from './hook-route'

export type Finding = { level: 'ok' | 'warn' | 'error', check: string, detail: string }

export interface DoctorDeps {
  which(name: string): string | undefined
  run(argv: string[], opts?: RunOptions): Promise<RunResult>
  now(): number
  env(name: string): string | undefined
  cwd(): string
}

export const defaultDoctorDeps: DoctorDeps = {
  which,
  run: runProc,
  now: () => Date.now(),
  env: name => process.env[name],
  cwd: () => process.cwd(),
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10))
  const pb = b.split(/[.-]/).map(n => parseInt(n, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? (pa[i] as number) : 0
    const y = Number.isFinite(pb[i]) ? (pb[i] as number) : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

export function versionFinding(version: string | undefined): Finding {
  const check = 'claude version'
  if (version === undefined) return { level: 'error', check, detail: '`claude --version` printed no version' }
  if (compareVersions(version, MIN_CLAUDE) < 0) return { level: 'error', check, detail: `${version} is older than the minimum ${MIN_CLAUDE}; update Claude Code` }
  if (compareVersions(version, TESTED_WITH) > 0) {
    return { level: 'warn', check, detail: `${version} is newer than the tested ${TESTED_WITH}; mods may have changed: run \`claude plugin validate --strict harness/claude\` and \`claude plugin test harness/claude\`` }
  }
  return { level: 'ok', check, detail: `${version} (supported ${MIN_CLAUDE}–${TESTED_WITH})` }
}

export function pluginFinding(list: unknown[] | undefined, expectedFolder: string): Finding {
  const check = 'plugin'
  if (list === undefined) return { level: 'error', check, detail: '`claude plugin list --json` failed' }
  const e = list.find(p => p !== null && typeof p === 'object' && (p as PluginEntry).id === PLUGIN_ID) as PluginEntry | undefined
  if (e === undefined) return { level: 'error', check, detail: `${PLUGIN_ID} is not installed; run \`buracle install claude\`` }
  if (e.enabled !== true) return { level: 'error', check, detail: `${PLUGIN_ID} is installed but disabled; run \`claude plugin enable ${PLUGIN_ID}\`` }
  const errors = Array.isArray(e.errors) ? e.errors.map(String) : []
  if (errors.length > 0) return { level: 'error', check, detail: `${PLUGIN_ID} failed to load: ${errors.join('; ')}` }
  if (typeof e.readFromFolder !== 'string') return { level: 'warn', check, detail: `${PLUGIN_ID} runs from a cached copy, not in place from ${expectedFolder}; re-add the marketplace with \`buracle install claude\`` }
  if (!samePath(e.readFromFolder, expectedFolder)) return { level: 'error', check, detail: `${PLUGIN_ID} loads from ${e.readFromFolder}, not from this checkout (${expectedFolder}); run \`buracle install claude\`` }
  return { level: 'ok', check, detail: `${PLUGIN_ID} enabled, read in place from ${e.readFromFolder}` }
}

interface Issue { path?: unknown; message?: unknown }
interface GatingHook { module?: unknown; hook?: unknown; hasCatch?: unknown }

export interface ValidateReport {
  problems: string[]
  uncaught: string[]
  gates: number
}

export function readValidateReport(stdout: string): ValidateReport | undefined {
  let report: Record<string, unknown>
  try {
    report = JSON.parse(stdout) as Record<string, unknown>
    if (report === null || typeof report !== 'object') return undefined
  } catch {
    return undefined
  }
  const sections: Array<Record<string, unknown>> = []
  if (report['manifest'] !== null && typeof report['manifest'] === 'object') sections.push(report['manifest'] as Record<string, unknown>)
  if (Array.isArray(report['contents'])) for (const c of report['contents']) if (c !== null && typeof c === 'object') sections.push(c as Record<string, unknown>)
  const problems: string[] = []
  const gates: GatingHook[] = []
  for (const s of sections) {
    const where = typeof s['file'] === 'string' ? (s['file'] as string).split('/').slice(-2).join('/') : 'manifest'
    for (const e of (Array.isArray(s['errors']) ? s['errors'] : []) as Issue[]) problems.push(`error ${where} ${String(e.path ?? '')}: ${String(e.message ?? '')}`)
    for (const w of (Array.isArray(s['warnings']) ? s['warnings'] : []) as Issue[]) problems.push(`warning ${where} ${String(w.path ?? '')}: ${String(w.message ?? '')}`)
    for (const g of (Array.isArray(s['gatingHooks']) ? s['gatingHooks'] : []) as GatingHook[]) gates.push(g)
  }
  return { problems, uncaught: gates.filter(g => g.hasCatch !== true).map(g => String(g.hook ?? '?')), gates: gates.length }
}

export function validateFinding(r: { code: number, stdout: string, stderr: string }): Finding {
  const check = 'plugin validate'
  const report = readValidateReport(r.stdout)
  if (report === undefined) return { level: 'error', check, detail: `validator failed (exit ${r.code}): ${(r.stderr.trim() || r.stdout.trim()).slice(0, 300)}` }
  const problems = [...report.problems]
  if (report.uncaught.length > 0) problems.push(`gating hooks without .catch: ${report.uncaught.join(', ')}`)
  if (problems.length === 0 && r.code !== 0) problems.push(`the validator exited ${r.code}`)
  if (problems.length > 0) return { level: 'error', check, detail: problems.join('; ') }
  return { level: 'ok', check, detail: `passed (${report.gates} gating hook${report.gates === 1 ? '' : 's'}, all with .catch)` }
}

export function bashHookCommand(hooksJsonText: string): string | undefined {
  let doc: unknown
  try { doc = JSON.parse(hooksJsonText) } catch { return undefined }
  const groups = doc !== null && typeof doc === 'object' ? ((doc as Record<string, unknown>)['hooks'] as Record<string, unknown> | undefined)?.['PreToolUse'] : undefined
  for (const g of Array.isArray(groups) ? groups : []) {
    const m = g !== null && typeof g === 'object' ? (g as Record<string, unknown>)['matcher'] : undefined
    let hit = m === undefined || m === '' || m === '*'
    if (!hit && typeof m === 'string') { try { hit = new RegExp(`^(?:${m})$`).test('Bash') } catch { hit = false } }
    if (!hit) continue
    const list = (g as Record<string, unknown>)['hooks']
    for (const h of Array.isArray(list) ? list : []) {
      const cmd = h !== null && typeof h === 'object' ? (h as Record<string, unknown>)['command'] : undefined
      if (typeof cmd === 'string' && /\bhook claude PreToolUse\b/.test(cmd)) return cmd
    }
  }
  return undefined
}

export const PROBE_COMMAND = 'rm -rf ~'

export async function guardProbeFinding(folder: string, d: Pick<DoctorDeps, 'run'>, shell = '/bin/sh'): Promise<Finding> {
  const check = 'hooks (guard probe)'
  const text = readJsonSafeSync<unknown>(join(folder, 'hooks', 'hooks.json'))
  const cmd = text.ok ? bashHookCommand(JSON.stringify(text.value)) : undefined
  if (cmd === undefined) return { level: 'error', check, detail: `no PreToolUse hook for Bash in ${join(folder, 'hooks', 'hooks.json')}; run \`buracle build\` and \`buracle install claude\`` }
  const payload = JSON.stringify({ session_id: 'buracle-doctor-probe', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: PROBE_COMMAND }, cwd: folder, permission_mode: 'bypassPermissions' })
  const r = await d.run([shell, '-c', cmd.replaceAll('${CLAUDE_PLUGIN_ROOT}', folder)], {
    stdin: payload, timeoutMs: 30_000, cwd: folder,
    env: { BURACLE_NO_CAPTURE: '1', BURACLE_NO_MEMORY: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_NOTIFY: '1' },
  })
  let decision: unknown
  try { decision = ((JSON.parse(r.stdout) as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown> | undefined)?.['permissionDecision'] } catch { decision = undefined }
  if (decision === 'deny') return { level: 'ok', check, detail: `the PreToolUse hook denies \`${PROBE_COMMAND}\` (H01), started as Claude Code starts it` }
  const why = r.timedOut ? 'timed out' : `exit ${r.code}${r.stderr.trim() !== '' ? `: ${r.stderr.trim().split('\n')[0]?.slice(0, 200)}` : ''}`
  return { level: 'error', check, detail: `the PreToolUse hook did not deny \`${PROBE_COMMAND}\` (${why}): Claude Code would run tools unguarded; check \`buracle doctor config\` (shim) and ~/.buracle/logs/buracle.log` }
}

export function statusLineFinding(settingsPath: string): Finding {
  const check = 'statusLine'
  const r = readJsonSafeSync<Record<string, unknown>>(settingsPath)
  if (!r.ok) {
    if (r.code === 'missing') return { level: 'warn', check, detail: `${settingsPath} does not exist; run \`buracle install claude\`` }
    return { level: 'error', check, detail: r.error }
  }
  const sl = r.value !== null && typeof r.value === 'object' ? r.value['statusLine'] : undefined
  const cmd = sl !== null && typeof sl === 'object' ? (sl as Record<string, unknown>)['command'] : undefined
  if (typeof cmd !== 'string') return { level: 'warn', check, detail: 'no statusLine configured; run `buracle install claude`' }
  if (!/\bstatusline claude\b/.test(cmd)) return { level: 'warn', check, detail: `statusLine runs ${JSON.stringify(cmd)}, not Buracle's status line (kept as the user's choice)` }
  return { level: 'ok', check, detail: cmd }
}

function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function commandProgram(command: string): string {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command)
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? ''
}

export function commandsFinding(folder: string, settingsPath: string, which: (name: string) => string | undefined): Finding {
  const check = 'commands'
  const missing: string[] = []
  const launchers: string[] = []
  let count = 0
  const expand = (c: string) => c.replaceAll('${CLAUDE_PLUGIN_ROOT}', folder).replaceAll('${HOME}', paths.home())
  const need = (what: string, path: string) => {
    count++
    if (!executable(path)) missing.push(`${what}: ${path}`)
  }
  const hooks = readJsonSafeSync<Record<string, unknown>>(join(folder, 'hooks', 'hooks.json'))
  const events = hooks.ok && hooks.value !== null && typeof hooks.value === 'object' ? hooks.value['hooks'] : undefined
  const commands = new Set<string>()
  if (events !== null && typeof events === 'object') {
    for (const groups of Object.values(events as Record<string, unknown>)) {
      for (const g of Array.isArray(groups) ? groups : []) {
        const list = g !== null && typeof g === 'object' ? (g as Record<string, unknown>)['hooks'] : undefined
        for (const h of Array.isArray(list) ? list : []) {
          const cmd = h !== null && typeof h === 'object' ? (h as Record<string, unknown>)['command'] : undefined
          if (typeof cmd === 'string') commands.add(cmd)
        }
      }
    }
  }
  for (const cmd of [...commands].sort()) need('hook', expand(commandProgram(cmd)))
  need('plugin bin/buracle', join(folder, 'bin', 'buracle'))
  need('shim (bin/buracle)', paths.shimPath())
  const servers = (file: string, key?: string): Array<[string, unknown]> => {
    const r = readJsonSafeSync<Record<string, unknown>>(join(folder, file))
    const v = r.ok && r.value !== null && typeof r.value === 'object' ? (key !== undefined ? r.value[key] : r.value) : undefined
    return v !== null && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : []
  }
  for (const [label, entries] of [['MCP', servers('.mcp.json', 'mcpServers')], ['LSP', servers('.lsp.json')]] as const) {
    for (const [id, spec] of entries) {
      const cmd = spec !== null && typeof spec === 'object' ? (spec as Record<string, unknown>)['command'] : undefined
      if (typeof cmd !== 'string' || cmd === '') continue
      const program = expand(cmd)
      if (program.includes('/')) need(`${label} ${id}`, program)
      else {
        count++
        if (which(program) === undefined) launchers.push(`${label} ${id}: ${program} is not on PATH`)
      }
      const args = (spec as Record<string, unknown>)['args']
      const launcher = Array.isArray(args) && typeof args[0] === 'string' && args[0].includes('${CLAUDE_PLUGIN_ROOT}') ? expand(args[0]) : undefined
      if (launcher !== undefined && !existsFile(launcher)) missing.push(`${label} ${id} launcher: ${launcher}`)
    }
  }
  const settings = readJsonSafeSync<Record<string, unknown>>(settingsPath)
  const sl = settings.ok && settings.value !== null && typeof settings.value === 'object' ? settings.value['statusLine'] : undefined
  const slCmd = sl !== null && typeof sl === 'object' ? (sl as Record<string, unknown>)['command'] : undefined
  if (typeof slCmd === 'string' && /\bstatusline claude\b/.test(slCmd)) {
    const program = commandProgram(slCmd)
    if (program.includes('/')) need('statusLine', program)
  }
  if (missing.length > 0) return { level: 'error', check, detail: `${missing.join('; ')} is missing or not executable; run \`buracle install claude\`${launchers.length > 0 ? `; ${launchers.join('; ')}` : ''}` }
  if (launchers.length > 0) return { level: 'warn', check, detail: launchers.join('; ') }
  return { level: 'ok', check, detail: `all ${count} hook, MCP, language server and statusLine commands resolve` }
}

function existsFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

function obj(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined
}

export function readJsonObject(path: string): Record<string, unknown> | undefined {
  const r = readJsonSafeSync<unknown>(path)
  return r.ok ? obj(r.value) : undefined
}

function ago(ms: number): string {
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export function permissionFinding(
  cfg: BuracleConfig['permissions'], settings: Record<string, unknown> | undefined, app: Record<string, unknown> | undefined,
  last: { mode: string, at: number, sid: string } | undefined, now: number,
): Finding {
  const check = 'permission mode'
  if (!cfg.bypass) return { level: 'ok', check, detail: 'permissions.bypass is off: Claude Code keeps the permission mode you set' }
  const configured = obj(settings?.['permissions'])?.['defaultMode']
  if (configured !== 'bypassPermissions') {
    const current = configured === undefined ? 'not set (Claude Code then starts in auto mode)' : JSON.stringify(configured)
    const fix = cfg.enforce
      ? 'run `buracle install` to write bypassPermissions back (permissions.enforce), then start a new session'
      : 'permissions.enforce is off, so Buracle keeps this value; set it back yourself, or turn permissions.enforce on and run `buracle install`'
    return {
      level: 'warn', check,
      detail: `~/.claude/settings.json permissions.defaultMode is ${current}, not bypassPermissions (permissions.bypass is on). Claude Code's one-time "make auto mode your default" prompt, /config or its /doctor skill change it; ${fix}`,
    }
  }
  if (last !== undefined && last.mode !== 'bypassPermissions' && last.mode !== 'plan') {
    return {
      level: 'warn', check,
      detail: `bypassPermissions is configured, but the newest session (${last.sid}, ${ago(Math.max(0, now - last.at))}) ran in "${last.mode}": a --permission-mode flag, a managed policy or the session itself changed it`,
    }
  }
  const live = last !== undefined ? `; newest session: ${last.mode}, ${ago(Math.max(0, now - last.at))}` : ''
  const nudge = app?.['hasSeenAutoDefaultNudge'] === true
    ? ''
    : '; Claude Code may still offer once to make auto mode the default: answer "No, keep bypass permissions" (else `buracle install` writes bypassPermissions back)'
  return { level: 'ok', check, detail: `bypassPermissions${live}${nudge}` }
}

export function effortFinding(value: string, settings: Record<string, unknown> | undefined, envLevel: string | undefined): Finding {
  const check = 'effort'
  const r = resolveEffort('claude', value)
  if ('invalid' in r) return { level: 'warn', check, detail: `effort.claude: ${r.invalid}` }
  if (envLevel !== undefined && envLevel.trim() !== '') {
    return { level: 'warn', check, detail: `CLAUDE_CODE_EFFORT_LEVEL=${envLevel.trim()} is set in the environment; it overrides /effort and the settings Buracle writes` }
  }
  const models = obj(settings?.['modelSettings'])
  const live: Array<[string, unknown]> = [['effortLevel', settings?.['effortLevel']], ...EFFORT_MODELS.map((m): [string, unknown] => [m, obj(models?.[m])?.['effortLevel']])]
  const kept = EFFORT_SCALES.claude.persistable
  const dropped = live.filter(([, v]) => typeof v === 'string' && !kept.includes(v))
  if (dropped.length > 0) {
    return { level: 'warn', check, detail: `${dropped.map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')}: Claude Code drops this value from its settings (max lasts one session) and uses its own default; pick one of ${kept.join(', ')}` }
  }
  if ('off' in r) {
    const set = live.filter(([, v]) => typeof v === 'string').map(([k, v]) => `${k} ${String(v)}`)
    return { level: 'ok', check, detail: `effort.claude is keep: Buracle leaves Claude Code's effort alone${set.length > 0 ? ` (${set.join(', ')})` : ''}` }
  }
  const missing = live.filter(([, v]) => v === undefined).map(([k]) => k)
  if (missing.length > 0) return { level: 'warn', check, detail: `effort ${r.level} is not in ~/.claude/settings.json for ${missing.join(', ')}; run \`buracle install\`` }
  const own = live.filter(([, v]) => v !== r.level).map(([k, v]) => `${k} ${String(v)}`)
  return { level: 'ok', check, detail: `${r.level} for every model${own.length > 0 ? `, except the user's own choice (kept): ${own.join(', ')}` : ''}` }
}

export async function indexFinding(folder: string, cfg: BuracleConfig, cwd: string, now: number): Promise<Finding> {
  const check = 'index'
  const servers = obj(readJsonObject(join(folder, '.mcp.json'))?.['mcpServers']) ?? {}
  const tools = (['codegraph', 'semble'] as const).filter(t => cfg.index[t])
  const missing = tools.filter(t => obj(servers[t]) === undefined)
  if (missing.length > 0) return { level: 'error', check, detail: `${join(folder, '.mcp.json')} declares no ${missing.join(' or ')} server; run \`buracle build\` and \`buracle install claude\`` }
  const deferred = tools.filter(t => obj(servers[t])?.['alwaysLoad'] !== true)
  const upfront = deferred.length > 0 ? `${deferred.join(' and ')} load behind tool search (no alwaysLoad); run \`buracle build\`` : undefined
  if (tools.length === 0) return { level: 'ok', check, detail: 'index.codegraph and index.semble are off' }
  const root = await projectRootFor(cwd, paths.oldVaultRoot(), cfg.index.exclude).catch(() => undefined)
  if (root === undefined) {
    return { level: upfront !== undefined ? 'warn' : 'ok', check, detail: upfront ?? `${tools.join(' and ')} load upfront; ${cwd} is not a project, so there is no index to check here` }
  }
  const pi = indexSummary(root, cfg.index, now)
  const states = tools.map(t => `${t} ${describeIndexState(pi[t], now)}`).join(', ')
  const auto = cfg.index.auto ? '' : ' (index.auto is off: run `buracle index ensure`)'
  const level = upfront !== undefined || indexHealth(pi) === 'failed' ? 'warn' : 'ok'
  return { level, check, detail: `${root}: ${states}${auto}${upfront !== undefined ? `; ${upfront}` : `; ${tools.join(' and ')} load upfront`}` }
}

export function routerFinding(ctx: AdapterContext): Finding {
  const check = 'router'
  if (ctx.config.routing.skills === 'off') return { level: 'ok', check, detail: 'routing.skills is off: the prompt router names no skills (memory and MCP lines stay)' }
  let canonical: AdapterContext['canonical']
  try { canonical = ctx.canonical } catch (e) { return { level: 'warn', check, detail: `canonical/ could not be loaded: ${e instanceof Error ? e.message : String(e)}` } }
  if (canonical.triggers === undefined) return { level: 'warn', check, detail: 'canonical/skill-triggers.yaml was not loaded: the router knows only the generated requests ("use the <id> workflow")' }
  const skills = catalogSkills(canonical.skills)
  const compiled = compileTriggers(skills, { ...canonical.routing, strictness: ctx.config.routing.strictness })
  const workflows = skills.filter(s => s.userInvocable && s.invocation === 'explicit')
  const bare = workflows.filter(s => (s.triggers?.ask ?? []).length === 0).map(s => s.id)
  const problems = canonical.warnings.filter(w => w.startsWith('skill-triggers.yaml'))
  const counts = `${skills.filter(s => (s.triggers?.ask ?? []).length > 0).length} of ${skills.length} skills with request phrases, ${compiled.categories.length} MCP categories with triggers`
  if (bare.length > 0 || problems.length > 0) {
    const parts = [...(bare.length > 0 ? [`workflows without request phrases: ${bare.join(', ')}`] : []), ...problems.slice(0, 3)]
    return { level: 'warn', check, detail: `${counts}; ${parts.join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}` }
  }
  return { level: 'ok', check, detail: counts }
}

export async function claudeDoctor(ctx: AdapterContext, deps: Partial<DoctorDeps> = {}): Promise<Finding[]> {
  const d: DoctorDeps = { ...defaultDoctorDeps, ...deps }
  const claude = d.which('claude')
  if (claude === undefined) return [{ level: 'error', check: 'claude version', detail: '`claude` is not on PATH' }]
  const findings: Finding[] = []

  const v = await d.run([claude, '--version'], { timeoutMs: 15_000 })
  findings.push(v.code === 0 ? versionFinding(parseVersion(`${v.stdout}\n${v.stderr}`)) : { level: 'error', check: 'claude version', detail: `\`claude --version\` exited ${v.code}` })

  const folder = join(ctx.repoRoot, HARNESS_REL)
  const list = await d.run([claude, 'plugin', 'list', '--json'], { timeoutMs: 60_000 })
  findings.push(pluginFinding(list.code === 0 ? parseList(list.stdout) : undefined, folder))

  findings.push(validateFinding(await d.run([claude, 'plugin', 'validate', '--strict', '--json', folder], { timeoutMs: 120_000 })))

  if (d.env('BURACLE_DOCTOR_LIVE') === '1') {
    const r = await d.run([claude, '-p', '/buracle-ping', '--no-session-persistence', '--strict-mcp-config'], { timeoutMs: 120_000 })
    findings.push(/\bpong\b/.test(r.stdout)
      ? { level: 'ok', check: 'mod liveness', detail: '`claude -p /buracle-ping` answered pong (no model call)' }
      : { level: 'error', check: 'mod liveness', detail: `no pong from \`claude -p /buracle-ping\` (exit ${r.code}): ${(r.stderr.trim() || r.stdout.trim()).slice(0, 300)}` })
  } else {
    findings.push({ level: 'ok', check: 'mod liveness', detail: 'skipped; set BURACLE_DOCTOR_LIVE=1 to run the zero-cost `claude -p /buracle-ping`' })
  }

  findings.push(await guardProbeFinding(folder, d))
  const settingsPath = join(ctx.paths.claudeDir(), 'settings.json')
  findings.push(statusLineFinding(settingsPath))
  findings.push(commandsFinding(folder, settingsPath, name => d.which(name)))
  const settings = readJsonObject(settingsPath)
  findings.push(permissionFinding(ctx.config.permissions, settings, readJsonObject(ctx.paths.claudeJson()), lastSessionMode(), d.now()))
  findings.push(effortFinding(ctx.config.effort.claude, settings, d.env('CLAUDE_CODE_EFFORT_LEVEL')))
  findings.push(await indexFinding(folder, ctx.config, d.cwd(), d.now()))
  findings.push(routerFinding(ctx))
  return findings
}

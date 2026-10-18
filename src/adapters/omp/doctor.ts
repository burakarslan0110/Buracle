import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { effortConfigValues, resolveEffort } from '../../core/effort'
import { mdBlockGet } from '../../engine/merge'
import { detectBinary, parseVersion, run, which } from '../../engine/proc'
import type { AdapterContext } from '../registry'
import { resolveArgv, type Env } from '../shared/command'
import { checkLink } from './check-link'
import { BUN_MIN_VERSION, OMP_MIN_VERSION, OMP_TESTED_WITH, OMP_THINKING_LEVELS, PACKAGE_NAME, ompCommandSkills, ompThinkingLevel } from './generated'
import { AGENTS_BLOCK_ID, APPROVAL_KEY, ompConfigKeysFor, ompConfigPath, PLAN_AUTOSAVE_DIR_KEY, PLAN_AUTOSAVE_KEY, SHARED_AGENTS_IMPORT, THINKING_KEY } from './install'
import { EXTENSION_PATH } from './build'

export type DoctorFinding = { level: 'ok' | 'warn' | 'error', check: string, detail: string }

function realOr(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(x => parseInt(x, 10))
  const pb = b.split(/[.-]/).map(x => parseInt(x, 10))
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] as number : 0
    const y = Number.isFinite(pb[i]) ? pb[i] as number : 0
    if (x !== y) return x - y
  }
  return 0
}

function getIn(obj: unknown, dotted: string): { found: boolean, value?: unknown } {
  let cur: unknown = obj
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false }
    cur = (cur as Record<string, unknown>)[seg]
  }
  return { found: true, value: cur }
}

export function configFindings(text: string | undefined, expected: Record<string, unknown>, file: string): DoctorFinding[] {
  if (text === undefined) return [{ level: 'warn', check: 'omp config', detail: `${file} is missing; run \`buracle install omp\`` }]
  let doc: unknown
  try { doc = parseYaml(text) } catch (e) {
    return [{ level: 'error', check: 'omp config', detail: `${file} is not valid YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }]
  }
  const off: string[] = []
  for (const [key, want] of Object.entries(expected)) {
    const got = getIn(doc ?? {}, key)
    if (!got.found) off.push(`${key} missing`)
    else if (JSON.stringify(got.value) !== JSON.stringify(want)) off.push(`${key} = ${JSON.stringify(got.value)} (Buracle: ${JSON.stringify(want)})`)
  }
  if (off.length === 0) return [{ level: 'ok', check: 'omp config', detail: `${Object.keys(expected).length} Buracle keys set in ${file}` }]
  return [{ level: 'warn', check: 'omp config', detail: `${file}: ${off.join('; ')}` }]
}

export function mcpCommandFindings(mcpJsonText: string | undefined, env: Env, file: string): DoctorFinding[] {
  if (mcpJsonText === undefined) return [{ level: 'error', check: 'omp mcp', detail: `${file} is missing; run \`buracle build\`` }]
  let servers: Record<string, unknown>
  try {
    const doc = JSON.parse(mcpJsonText) as { mcpServers?: unknown }
    servers = doc.mcpServers !== null && typeof doc.mcpServers === 'object' ? doc.mcpServers as Record<string, unknown> : {}
  } catch {
    return [{ level: 'error', check: 'omp mcp', detail: `${file} is not valid JSON` }]
  }
  const errors: string[] = []
  const warnings: string[] = []
  for (const [id, raw] of Object.entries(servers)) {
    const s = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    if (typeof s['command'] !== 'string') continue
    const args = Array.isArray(s['args']) ? s['args'].filter((a): a is string => typeof a === 'string') : []
    const r = resolveArgv([s['command'], ...args], env)
    if (r.executable !== undefined) continue
    if (r.program !== undefined && !r.program.includes('/')) warnings.push(`${id}: \`${r.program}\` is not on PATH`)
    else errors.push(r.program !== undefined ? `${id}: ${r.program} does not exist or is not executable` : `${id}: cannot resolve the program of \`${s['command']}\``)
  }
  const out: DoctorFinding[] = []
  if (errors.length > 0) out.push({ level: 'error', check: 'omp mcp', detail: `MCP server commands omp cannot start: ${errors.join('; ')}. Install Buracle again and make sure omp starts with the same BURACLE_HOME as this shell.` })
  if (warnings.length > 0) out.push({ level: 'warn', check: 'omp mcp', detail: `MCP package runners not found on PATH: ${warnings.join('; ')}` })
  if (out.length === 0) out.push({ level: 'ok', check: 'omp mcp', detail: `${Object.keys(servers).length} plugin MCP server commands resolve` })
  return out
}

export function sharedAgentsFinding(block: string | undefined, sharedExists: boolean, agentsFile: string): DoctorFinding | undefined {
  if (block === undefined || !sharedExists || block.includes('@~/.agents/AGENTS.md')) return undefined
  return { level: 'warn', check: 'omp AGENTS.md', detail: `~/.agents/AGENTS.md exists, but the Buracle block in ${agentsFile} does not import it, so omp shadows it (one user-level context file); run \`buracle install omp\` to add "${SHARED_AGENTS_IMPORT}"` }
}

function configDoc(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try { return parseYaml(text) } catch { return undefined }
}

export function permissionFinding(doc: unknown, cfg: Pick<AdapterContext['config'], 'permissions'>, file: string): DoctorFinding {
  const want = cfg.permissions.bypass ? 'yolo' : 'write'
  const got = getIn(doc ?? {}, APPROVAL_KEY)
  const check = 'omp permission mode'
  if (got.found && got.value === want) {
    return { level: 'ok', check, detail: want === 'yolo' ? "tools.approvalMode yolo: omp runs tools without asking; Buracle's guards and consent gate still protect" : 'tools.approvalMode write (permissions.bypass is off)' }
  }
  const now = got.found ? `is ${JSON.stringify(got.value)}` : `is not set in ${file}`
  const fix = cfg.permissions.bypass && cfg.permissions.enforce
    ? 'run `buracle install` to write it back (permissions.enforce)'
    : cfg.permissions.bypass ? 'permissions.enforce is off, so Buracle keeps that value; set it back yourself or run `buracle config set permissions.enforce true` and `buracle install`' : 'run `buracle install omp`'
  return { level: 'warn', check, detail: `tools.approvalMode ${now}, not ${want} (permissions.bypass ${cfg.permissions.bypass ? 'on' : 'off'}); ${fix}` }
}

export function userEffortFinding(raw: unknown, cfg: Pick<AdapterContext['config'], 'effort'>, file: string): DoctorFinding | undefined {
  if (raw === undefined || raw === null) return undefined
  const accepted = effortConfigValues('omp')
  if (typeof raw === 'string' && accepted.includes(raw)) return undefined
  const r = resolveEffort('omp', String(raw))
  const why = 'invalid' in r ? r.invalid : `effort.omp takes one of ${accepted.join(', ')}, spelled exactly so`
  const now = ompThinkingLevel(cfg)
  const writes = 'level' in now ? `defaultThinkingLevel ${now.level}` : 'keep' in now ? "omp's own defaultThinkingLevel" : 'no defaultThinkingLevel'
  return {
    level: 'warn', check: 'omp effort',
    detail: `effort.omp ${JSON.stringify(raw)} in ${file} is not used: ${why}. Buracle uses effort.omp ${cfg.effort.omp} instead (${writes}); pick another value with \`buracle config set effort.omp <value>\`, then run \`buracle install\``,
  }
}

function userEffortValue(file: string): unknown {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return undefined }
  try { return getIn(parseYaml(text) ?? {}, 'effort.omp').value } catch { return undefined }
}

export function effortFindings(doc: unknown, cfg: Pick<AdapterContext['config'], 'effort'>, file: string): DoctorFinding[] {
  const check = 'omp effort'
  const out: DoctorFinding[] = []
  const r = ompThinkingLevel(cfg)
  const live = getIn(doc ?? {}, THINKING_KEY)
  const liveText = live.found ? JSON.stringify(live.value) : "not set (omp's default is high)"
  const unusable = live.found && !(typeof live.value === 'string' && OMP_THINKING_LEVELS.includes(live.value))
  const ignored = `defaultThinkingLevel ${liveText} in ${file} is not a level omp accepts (${OMP_THINKING_LEVELS.join(', ')}): omp ignores it and runs at high. Set one with \`omp config set defaultThinkingLevel <level>\``
  if ('invalid' in r) out.push({ level: 'warn', check, detail: `effort.omp: ${r.invalid}; defaultThinkingLevel is ${liveText}` })
  else if ('keep' in r) out.push(unusable ? { level: 'warn', check, detail: `${ignored} (effort.omp is keep)` } : { level: 'ok', check, detail: `effort.omp is keep: omp's own defaultThinkingLevel stays (${liveText})` })
  else if (!live.found) out.push({ level: 'warn', check, detail: `defaultThinkingLevel is not set in ${file} (omp starts at high); run \`buracle install omp\` to write ${r.level} (effort.omp)` })
  else if (live.value === r.level) out.push({ level: 'ok', check, detail: `defaultThinkingLevel ${r.level} (effort.omp)` })
  else if (unusable) out.push({ level: 'warn', check, detail: `${ignored} (effort.omp would write ${r.level})` })
  else out.push({ level: 'ok', check, detail: `defaultThinkingLevel ${JSON.stringify(live.value)} is your own value and stays (effort.omp would write ${r.level})` })
  const role = getIn(doc ?? {}, 'modelRoles.default')
  const suffix = role.found && typeof role.value === 'string' ? /:([a-z]+)$/.exec(role.value)?.[1] : undefined
  if (suffix !== undefined) out.push({ level: 'warn', check: 'omp effort', detail: `modelRoles.default ends in :${suffix}, which overrides defaultThinkingLevel for the default model; drop the suffix to use effort.omp` })
  return out
}

export async function doctor(ctx: AdapterContext): Promise<DoctorFinding[]> {
  const out: DoctorFinding[] = []
  const found = await detectBinary('omp')
  if (!found.installed) return [{ level: 'warn', check: 'omp', detail: 'omp is not on PATH; omp checks skipped' }]
  const ompBin = found.path ?? 'omp'
  if (found.version === undefined) out.push({ level: 'warn', check: 'omp version', detail: '`omp --version` printed no version' })
  else if (compareVersions(found.version, OMP_MIN_VERSION) < 0) out.push({ level: 'error', check: 'omp version', detail: `omp ${found.version} is older than ${OMP_MIN_VERSION}; run \`omp update\`` })
  else if (compareVersions(found.version, OMP_TESTED_WITH) > 0) out.push({ level: 'warn', check: 'omp version', detail: `omp ${found.version} is newer than the tested ${OMP_TESTED_WITH}; the extension API changes often — rerun \`buracle doctor omp\` after the first session` })
  else out.push({ level: 'ok', check: 'omp version', detail: `omp ${found.version} (tested ${OMP_TESTED_WITH})` })

  const bun = which('bun')
  if (bun === undefined) out.push({ level: 'warn', check: 'bun', detail: `bun is not on PATH (omp plugin installs and uninstalls run bun ≥ ${BUN_MIN_VERSION})` })
  else {
    const r = await run([bun, '--version'], { timeoutMs: 10_000 })
    const v = r.code === 0 ? parseVersion(r.stdout) : undefined
    if (v === undefined) out.push({ level: 'warn', check: 'bun', detail: '`bun --version` failed' })
    else if (compareVersions(v, BUN_MIN_VERSION) < 0) out.push({ level: 'error', check: 'bun', detail: `bun ${v} is older than ${BUN_MIN_VERSION}, which omp requires` })
    else out.push({ level: 'ok', check: 'bun', detail: `bun ${v}` })
  }

  const pluginDir = join(ctx.repoRoot, 'harness', 'omp')
  if (!existsSync(join(pluginDir, EXTENSION_PATH))) out.push({ level: 'error', check: 'omp extension', detail: `${join(pluginDir, EXTENSION_PATH)} is missing; run \`buracle build\`` })
  let mcpText: string | undefined
  try { mcpText = readFileSync(join(pluginDir, '.mcp.json'), 'utf8') } catch { mcpText = undefined }
  out.push(...mcpCommandFindings(mcpText, process.env, join(pluginDir, '.mcp.json')))
  const link = await checkLink(pluginDir, ompBin)
  switch (link.state) {
    case 'linked': out.push({ level: 'ok', check: 'omp plugin', detail: `${PACKAGE_NAME} linked to ${pluginDir}` }); break
    case 'absent': out.push({ level: 'error', check: 'omp plugin', detail: `${PACKAGE_NAME} is not linked; run \`buracle install omp\`` }); break
    case 'disabled': out.push({ level: 'warn', check: 'omp plugin', detail: `${PACKAGE_NAME} is linked but disabled (\`omp plugin enable ${PACKAGE_NAME}\`)` }); break
    case 'elsewhere': out.push({ level: 'warn', check: 'omp plugin', detail: `${PACKAGE_NAME} points to ${link.path ?? 'another directory'}, not ${pluginDir}; rerun \`buracle install omp\`` }); break
    default: out.push({ level: 'warn', check: 'omp plugin', detail: link.detail ?? 'could not read `omp plugin list --json`' })
  }

  const agentDir = ctx.paths.ompAgentDir()
  const configFile = ompConfigPath(agentDir)
  let configText: string | undefined
  try { configText = readFileSync(configFile, 'utf8') } catch { configText = undefined }
  const expected = Object.fromEntries(Object.entries(ompConfigKeysFor(ctx, configFile)).filter(([k]) => k !== APPROVAL_KEY && k !== THINKING_KEY && k !== PLAN_AUTOSAVE_KEY && k !== PLAN_AUTOSAVE_DIR_KEY))
  out.push(...configFindings(configText, expected, configFile))
  const userEffort = userEffortFinding(userEffortValue(ctx.paths.userConfigFile()), ctx.config, ctx.paths.userConfigFile())
  if (userEffort !== undefined) out.push(userEffort)
  if (configText !== undefined) {
    const doc = configDoc(configText)
    if (doc !== undefined) out.push(permissionFinding(doc, ctx.config, configFile), ...effortFindings(doc, ctx.config, configFile))
  }

  const agentsFile = join(agentDir, 'AGENTS.md')
  let block: string | undefined
  try { block = mdBlockGet(readFileSync(agentsFile, 'utf8'), AGENTS_BLOCK_ID) } catch { block = undefined }
  const shadow = sharedAgentsFinding(block, existsSync(join(ctx.paths.agentsDir(), 'AGENTS.md')), agentsFile)
  out.push(shadow ?? (block !== undefined
    ? { level: 'ok', check: 'omp AGENTS.md', detail: `Buracle block present in ${agentsFile}` }
    : { level: 'warn', check: 'omp AGENTS.md', detail: `no Buracle block in ${agentsFile}` }))

  const where = await run([ompBin, 'config', 'path'], { timeoutMs: 15_000 })
  const used = where.code === 0 ? where.stdout.trim().split('\n').pop()?.trim() : undefined
  if (used === undefined || used === '') out.push({ level: 'warn', check: 'omp agent dir', detail: '`omp config path` printed nothing' })
  else if (realOr(used) !== realOr(agentDir)) out.push({ level: 'warn', check: 'omp agent dir', detail: `omp uses ${used} but Buracle installs into ${agentDir} (PI_CODING_AGENT_DIR or OMP_PROFILE differs); rerun \`buracle install omp\` in the same environment` })
  else out.push({ level: 'ok', check: 'omp agent dir', detail: agentDir })

  const skillsDir = join(ctx.paths.agentsDir(), 'skills')
  const missingSkills = ompCommandSkills(ctx.canonical).filter(id => !existsSync(join(skillsDir, id, 'SKILL.md')))
  out.push(missingSkills.length === 0
    ? { level: 'ok', check: 'shared skills', detail: `workflow skills present in ${skillsDir}` }
    : { level: 'warn', check: 'shared skills', detail: `${missingSkills.join(', ')} missing in ${skillsDir}; the omp shortcuts (${missingSkills.map(s => `/${s}`).join(' ')}) need them — run \`buracle install\`` })

  if (process.env['CLAUDE_CONFIG_DIR'] !== undefined && process.env['CLAUDE_CONFIG_DIR'] !== '') {
    out.push({ level: 'warn', check: 'CLAUDE_CONFIG_DIR', detail: 'CLAUDE_CONFIG_DIR is exported: omp then also loads everything under the Claude config dir (skills, commands, MCP)' })
  }
  if (!existsSync(ctx.paths.runtimeConfigFile())) {
    out.push({ level: 'warn', check: 'runtime config', detail: `${ctx.paths.runtimeConfigFile()} is missing; the extension uses canonical defaults until \`buracle install\` writes it` })
  }

  const usage = await run([ompBin, 'usage', '--json'], { timeoutMs: 30_000 })
  if (usage.code !== 0) out.push({ level: 'warn', check: 'omp usage', detail: `\`omp usage --json\` exited ${usage.code}${usage.timedOut ? ' (timed out)' : ''}; usage limits need a logged-in provider` })
  else {
    try {
      const j = JSON.parse(usage.stdout) as { reports?: unknown }
      const n = Array.isArray(j.reports) ? j.reports.length : 0
      out.push(n > 0
        ? { level: 'ok', check: 'omp usage', detail: `\`omp usage --json\` works (${n} provider report${n === 1 ? '' : 's'})` }
        : { level: 'warn', check: 'omp usage', detail: '`omp usage --json` works but reports no account (log in to a subscription provider to see 5h/7d windows)' })
    } catch {
      out.push({ level: 'warn', check: 'omp usage', detail: '`omp usage --json` did not print JSON' })
    }
  }
  return out
}

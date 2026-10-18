import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { readLedger } from '../../engine/txn'
import { bunExecutable } from '../../engine/config'
import * as paths from '../../engine/paths'
import { which } from '../../engine/proc'
import type { AdapterContext } from '../registry'
import { OWNER, PACKAGE_NAME, ompCommandSkills, ompLspServers, ompMcpServerIds, ompThinkingLevel } from './generated'
import { OMP_BRAIN_COMMAND, OMP_REMEMBER_COMMAND, OMP_STATUS_ALIAS, OMP_STATUS_COMMAND } from './runtime/commands'
import { ompConfigPath } from './runtime/config'
import { ompPlanSettings } from './runtime/plan-capture'
import { mcpEntry } from './build'
import { ompStatusLine } from './statusline'

export const AGENTS_BLOCK_ID = 'omp'

export { ompConfigPath }

export const STATUS_PRESET = 'custom'

export function userStatusPreset(text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === '') return undefined
  let doc: unknown
  try { doc = Bun.YAML.parse(text) } catch { return undefined }
  const statusLine = doc !== null && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>)['statusLine'] : undefined
  const preset = statusLine !== null && typeof statusLine === 'object' && !Array.isArray(statusLine) ? (statusLine as Record<string, unknown>)['preset'] : undefined
  return preset === undefined || preset === null || preset === STATUS_PRESET ? undefined : String(preset)
}

export const PLAN_AUTOSAVE_KEY = 'plan.autosave'
export const PLAN_AUTOSAVE_DIR_KEY = 'plan.autosaveDir'

export function userPlanAutosave(text: string | undefined, staging: string): boolean {
  if (text === undefined || text.trim() === '') return false
  let doc: unknown
  try { doc = Bun.YAML.parse(text) } catch { return false }
  const p = ompPlanSettings(doc)
  if (p === undefined) return false
  if (p['autosaveDir'] !== undefined) return p['autosaveDir'] !== staging
  return p['autosave'] !== undefined
}

export type OmpKeyContext = Pick<AdapterContext, 'canonical'> & { config?: Pick<AdapterContext['config'], 'permissions' | 'effort' | 'agents'> }

export function ompConfigKeys(ctx: OmpKeyContext, opts: { userPreset?: string, planStaging?: string } = {}): Record<string, unknown> {
  const s = ompStatusLine(ctx.canonical.statusline.omp)
  const set: Record<string, unknown> = { 'statusLine.preset': STATUS_PRESET }
  if (opts.userPreset === undefined) {
    set['statusLine.leftSegments'] = s.left
    set['statusLine.rightSegments'] = s.right
    if (s.showHookStatus !== undefined) set['statusLine.showHookStatus'] = s.showHookStatus
  }
  set['tools.approvalMode'] = ctx.config?.permissions.bypass === false ? 'write' : 'yolo'
  set['tools.xdev'] = false
  const effort = ompThinkingLevel(ctx.config)
  if ('level' in effort) set[THINKING_KEY] = effort.level
  set['memory.backend'] = 'off'
  set[LSP_ON_EDIT_KEY] = true
  set['enabledProviders'] = []
  if (ctx.config?.agents.teams !== false) set[TEAMS_EAGER_KEY] = 'preferred'
  if (opts.planStaging !== undefined) {
    set[PLAN_AUTOSAVE_KEY] = true
    set[PLAN_AUTOSAVE_DIR_KEY] = opts.planStaging
  }
  return set
}

export const THINKING_KEY = 'defaultThinkingLevel'
export const TEAMS_EAGER_KEY = 'task.eager'
export const APPROVAL_KEY = 'tools.approvalMode'
export const LSP_ON_EDIT_KEY = 'lsp.diagnosticsOnEdit'

export function ompKeyPolicy(set: Record<string, unknown>, config: Pick<AdapterContext['config'], 'permissions'> | undefined): { enforce?: string[], soft?: string[] } {
  const policy: { enforce?: string[], soft?: string[] } = {}
  if (config?.permissions.bypass !== false && config?.permissions.enforce === true && set[APPROVAL_KEY] === 'yolo') policy.enforce = [APPROVAL_KEY]
  const soft = [THINKING_KEY, TEAMS_EAGER_KEY, PLAN_AUTOSAVE_KEY, PLAN_AUTOSAVE_DIR_KEY, LSP_ON_EDIT_KEY].filter(k => k in set)
  if (soft.length > 0) policy.soft = soft
  return policy
}

export function ompConfigKeysFor(ctx: OmpKeyContext, configFile: string): Record<string, unknown> {
  let text: string | undefined
  try { text = readFileSync(configFile, 'utf8') } catch { text = undefined }
  const userPreset = userStatusPreset(text)
  const staging = paths.ompPlanStagingDir()
  return ompConfigKeys(ctx, { ...(userPreset !== undefined ? { userPreset } : {}), ...(userPlanAutosave(text, staging) ? {} : { planStaging: staging }) })
}

export const SHARED_AGENTS_IMPORT = 'Shared instructions for every harness (when ~/.agents/AGENTS.md exists): @~/.agents/AGENTS.md'

export function agentsPointer(opts: { commands?: readonly string[] } = {}): string {
  const list = opts.commands ?? []
  const workflows = list.length > 0 ? `workflows are ${list.map(c => `\`/${c}\``).join(', ')} (skills in \`~/.agents/skills\`), ` : ''
  return [
    '## Buracle',
    '',
    `Buracle is active through the \`${PACKAGE_NAME}\` plugin: its always-on rules (working rules, tool routing, memory) load as plugin rules, ${workflows}\`/${OMP_STATUS_COMMAND}\` (or \`/${OMP_STATUS_ALIAS}\`) shows status, \`/${OMP_REMEMBER_COMMAND} <text>\` saves a memory note and \`/${OMP_BRAIN_COMMAND}\` opens the memory web UI. The \`buracle\` CLI is the helper for plans, worktrees, reviews and memory.`,
    '',
    SHARED_AGENTS_IMPORT,
  ].join('\n')
}

export function ompBinary(): string {
  return which('omp') ?? 'omp'
}

export function linkCheckArgv(repoRoot: string, pluginDir: string, ompBin: string, absent = false): string[] {
  const argv = [bunExecutable(), join(repoRoot, 'src', 'adapters', 'omp', 'check-link.ts'), pluginDir, '--omp', ompBin]
  if (absent) argv.push('--absent')
  return argv
}

export function windowsMcpOp(ctx: AdapterContext, agentDir: string): Op {
  const set: Record<string, unknown> = {}
  for (const id of ompMcpServerIds(ctx.canonical)) {
    const spec = ctx.canonical.mcp.servers[id]
    if (spec !== undefined) set[`mcpServers.${JSON.stringify(id)}`] = mcpEntry(id, spec, ctx.buracleBin)
  }
  return { kind: 'json-merge', path: join(agentDir, 'mcp.json'), set, owner: OWNER }
}

export function ompLspFile(): string {
  return join(paths.ompHome(), 'agent', 'lsp.json')
}

export type OmpLspLayout = 'wrapped' | 'flat'

export function ompLspLayout(text: string | undefined): OmpLspLayout {
  if (text === undefined || text.trim() === '') return 'wrapped'
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return 'wrapped' }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return 'wrapped'
  const d = doc as Record<string, unknown>
  const servers = d['servers']
  if (servers !== null && typeof servers === 'object' && !Array.isArray(servers)) return 'wrapped'
  return Object.keys(d).some(k => k !== 'idleTimeoutMs') ? 'flat' : 'wrapped'
}

export function ompLspLayoutOf(file: string = ompLspFile()): OmpLspLayout {
  let text: string | undefined
  try { text = readFileSync(file, 'utf8') } catch { text = undefined }
  return ompLspLayout(text)
}

export function ompLspSet(ctx: Pick<AdapterContext, 'canonical'>, layout: OmpLspLayout = 'wrapped'): Record<string, unknown> {
  return Object.fromEntries(Object.entries(ompLspServers(ctx.canonical)).map(([id, server]) => [layout === 'flat' ? id : `servers.${id}`, server]))
}

export async function installPlan(ctx: AdapterContext): Promise<Plan> {
  const agentDir = ctx.paths.ompAgentDir()
  const pluginDir = join(ctx.repoRoot, 'harness', 'omp')
  if (!existsSync(join(pluginDir, 'package.json'))) {
    throw new Error(`omp: ${pluginDir} is not built (no package.json); run \`buracle build\` first`)
  }
  const omp = ompBinary()
  const commands = ompCommandSkills(ctx.canonical)
  const configFile = ompConfigPath(agentDir)
  const set = ompConfigKeysFor(ctx, configFile)
  const lsp = ompLspSet(ctx, ompLspLayoutOf())
  const ops: Op[] = [
    { kind: 'yaml-merge', path: configFile, set, owner: OWNER, ...ompKeyPolicy(set, ctx.config) },
    { kind: 'md-block', path: join(agentDir, 'AGENTS.md'), id: AGENTS_BLOCK_ID, content: agentsPointer({ commands }), owner: OWNER },
    ...(Object.keys(lsp).length > 0 ? [{ kind: 'json-merge', path: ompLspFile(), set: lsp, owner: OWNER } as Op] : []),
    {
      kind: 'exec',
      argv: [omp, 'plugin', 'link', pluginDir],
      undo: unlinkArgv(omp),
      idempotentCheck: linkCheckArgv(ctx.repoRoot, pluginDir, omp),
      owner: OWNER,
    },
  ]
  if (process.platform === 'win32') ops.splice(ops.length - 1, 0, windowsMcpOp(ctx, agentDir))
  return { id: 'omp', harness: 'omp', ops }
}

export function unlinkArgv(omp: string): string[] {
  return [omp, 'plugin', 'uninstall', PACKAGE_NAME]
}

export async function uninstallPlan(ctx: AdapterContext, opts: { ledger?: Ledger } = {}): Promise<Plan> {
  const agentDir = ctx.paths.ompAgentDir()
  const pluginDir = join(ctx.repoRoot, 'harness', 'omp')
  const omp = ompBinary()
  let ledger: Ledger | undefined = opts.ledger
  if (ledger === undefined) {
    try { ledger = await readLedger() } catch { ledger = undefined }
  }
  const keys = new Set<string>()
  if (ledger !== undefined) {
    for (const [key, entry] of Object.entries(ledger)) if (entry.owner === OWNER) keys.add(key)
  } else {
    const config = ompConfigPath(agentDir)
    for (const key of Object.keys(ompConfigKeysFor(ctx, config))) keys.add(`${config}#${key}`)
    keys.add(`${join(agentDir, 'AGENTS.md')}#md:${AGENTS_BLOCK_ID}`)
    for (const key of Object.keys(ompLspSet(ctx, ompLspLayoutOf()))) keys.add(`${ompLspFile()}#${key}`)
  }
  const ops: Op[] = [...keys].sort().map((path): Op => ({ kind: 'remove', path, owner: OWNER }))
  ops.push({ kind: 'exec', argv: unlinkArgv(omp), idempotentCheck: linkCheckArgv(ctx.repoRoot, pluginDir, omp, true), owner: OWNER })
  return { id: 'omp-uninstall', harness: 'omp', ops }
}

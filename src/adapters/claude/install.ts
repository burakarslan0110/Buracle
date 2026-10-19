import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { RuleDoc } from '../../core/catalog'
import { resolveEffort } from '../../core/effort'
import { harnessMcpToolName } from '../../core/policy/routing'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { LIST_IDENTITY_HASH, readLedger } from '../../engine/txn'
import { bunExecutable } from '../../engine/config'
import { log } from '../../engine/log'
import { isWindows } from '../../engine/platform'
import { run, which } from '../../engine/proc'
import type { AdapterContext } from '../registry'
import { parseList, samePath } from './check'
import { CLAUDE_MANAGED_MARKETPLACES, EFFORT_MODELS, HARNESS_REL, MARKETPLACE_NAME, OWNER, PLUGIN_ID } from './constants'
import { renderClaudeMarkdown, withFrontmatter, type FrontmatterValue } from './render'

export interface InstallDeps {
  claudeBin(): string
  bunBin(): string
  marketplaces(claude: string): Promise<unknown[] | undefined>
  ledger(): Promise<Ledger | undefined>
}

export const defaultInstallDeps: InstallDeps = {
  claudeBin: () => which('claude') ?? 'claude',
  bunBin: () => bunExecutable(),
  async marketplaces(claude) {
    const r = await run([claude, 'plugin', 'marketplace', 'list', '--json'], { timeoutMs: 60_000 })
    return r.code === 0 ? parseList(r.stdout) : undefined
  },
  async ledger() {
    try { return await readLedger() } catch (e) {
      log('warn', 'claude install plan: ownership ledger unreadable; stale rules are not removed', { error: e })
      return undefined
    }
  },
}

function frontmatterEntries(fm: Record<string, unknown>): Array<readonly [string, FrontmatterValue]> {
  const out: Array<readonly [string, FrontmatterValue]> = []
  for (const [k, v] of Object.entries(fm)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out.push([k, v])
    else if (Array.isArray(v)) out.push([k, v.map(x => String(x))])
    else if (v !== null && v !== undefined) out.push([k, JSON.stringify(v)])
  }
  return out
}

export function renderRule(rule: RuleDoc): string {
  const body = renderClaudeMarkdown(rule.body, rule.file)
  const text = Object.keys(rule.frontmatter).length === 0 ? body.replace(/^\n+/, '') : withFrontmatter(frontmatterEntries(rule.frontmatter), body)
  return text.endsWith('\n') ? text : `${text}\n`
}

export function rulesDir(ctx: AdapterContext): string {
  return join(ctx.paths.claudeDir(), 'rules', 'buracle')
}

export function ruleOps(ctx: AdapterContext, ledger: Ledger | undefined): Op[] {
  const root = rulesDir(ctx)
  const rules = [...ctx.canonical.rules].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const ops: Op[] = rules.map(r => ({ kind: 'file', path: join(root, r.scope, `${r.id}.md`), content: renderRule(r), owner: OWNER }))
  const wanted = new Set(ops.map(o => (o as { path: string }).path))
  for (const e of Object.values(ledger ?? {})) {
    if (e.owner !== OWNER || e.kind !== 'file' || e.adopted === true) continue
    if (!(e.path.startsWith(root + sep) || e.path.startsWith(`${root}/`)) || wanted.has(e.path)) continue
    ops.push({ kind: 'remove', path: e.path, owner: OWNER })
  }
  return ops
}

function shellWord(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

const BOTH_SHELLS_PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_./:~-]*$/

/**
 * The status line's command on Windows, where Claude Code runs it in Git Bash or, without Git Bash, in PowerShell.
 * Both parse `<bare program> '<literal>' …` alike (PowerShell refuses a quoted program name), so the program is bun's
 * plain path or bun on PATH, and bun runs the plugin's launcher, not buracle.cmd.
 */
export function windowsCliCommand(ctx: Pick<AdapterContext, 'repoRoot' | 'buracleBin'>, bun: string, args: string): string {
  const fwd = (p: string) => p.replace(/\\/g, '/')
  const launcher = fwd(join(ctx.repoRoot, HARNESS_REL, 'bin', 'buracle.ts'))
  if (launcher.includes("'")) return `${shellWord(fwd(ctx.buracleBin))} ${args}`
  const program = BOTH_SHELLS_PLAIN.test(fwd(bun)) ? fwd(bun) : 'bun'
  return `${program} ${BOTH_SHELLS_PLAIN.test(launcher) ? launcher : `'${launcher}'`} ${args}`
}

export function statusLineOp(ctx: AdapterContext, bun: string = bunExecutable(), windows: boolean = isWindows()): Op {
  const command = (args: string) => (windows ? windowsCliCommand(ctx, bun, args) : `${shellWord(ctx.buracleBin)} ${args}`)
  const set: Record<string, unknown> = { statusLine: { type: 'command', command: command('statusline claude'), padding: 0, refreshInterval: 15 } }
  // The plugin's subagentStatusLine is a POSIX shell line (Git Bash runs it); on Windows the user-level key wins over it and also runs in PowerShell.
  if (windows) set['subagentStatusLine'] = { type: 'command', command: command('statusline claude --subagent') }
  return { kind: 'json-merge', path: join(ctx.paths.claudeDir(), 'settings.json'), set, owner: OWNER }
}

type JsonMergeOp = Extract<Op, { kind: 'json-merge' }>

export const PERMISSION_KEYS = { 'permissions.defaultMode': 'bypassPermissions', skipDangerousModePermissionPrompt: true } as const

export function permissionOps(ctx: AdapterContext): Op[] {
  if (!ctx.config.permissions.bypass) return []
  const op: JsonMergeOp = { kind: 'json-merge', path: join(ctx.paths.claudeDir(), 'settings.json'), set: { ...PERMISSION_KEYS }, owner: OWNER }
  if (ctx.config.permissions.enforce) op.enforce = Object.keys(PERMISSION_KEYS)
  return [op]
}

export function effortKeys(level: string): Record<string, string> {
  const set: Record<string, string> = { effortLevel: level }
  for (const model of EFFORT_MODELS) set[`modelSettings.${model}.effortLevel`] = level
  return set
}

export function effortOps(ctx: AdapterContext): Op[] {
  const r = resolveEffort('claude', ctx.config.effort.claude)
  if (!('level' in r)) return []
  const set = effortKeys(r.level)
  const op: JsonMergeOp = { kind: 'json-merge', path: join(ctx.paths.claudeDir(), 'settings.json'), set, owner: OWNER, soft: Object.keys(set) }
  return [op]
}

export const TEAMS_KEY = 'env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'
export const TEAMS_KEYS = { [TEAMS_KEY]: '1' } as const

export function teamsOps(ctx: AdapterContext): Op[] {
  if (!ctx.config.agents.teams) return []
  return [{ kind: 'json-merge', path: join(ctx.paths.claudeDir(), 'settings.json'), set: { ...TEAMS_KEYS }, owner: OWNER, soft: Object.keys(TEAMS_KEYS) }]
}

export const ENV_KEYS = {
  'env.CLAUDE_CODE_DISABLE_1M_CONTEXT': 'false',
  'env.CLAUDE_CODE_WORKFLOWS': 'true',
  'env.CLAUDE_CODE_AUTO_CONNECT_IDE': 'true',
  'env.CLAUDE_CODE_NO_FLICKER': 'true',
  'env.CLAUDE_CODE_ENABLE_TODO_TOOLS': 'true',
  'env.CLAUDE_CODE_ENABLE_TASKS': 'true',
  'env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP': '0',
  'env.CLAUDE_CODE_TODO_REMINDER_MODE': 'baseline',
  'env.ENABLE_TOOL_SEARCH': 'true',
} as const

export function envOps(ctx: AdapterContext): Op[] {
  return [{ kind: 'json-merge', path: join(ctx.paths.claudeDir(), 'settings.json'), set: { ...ENV_KEYS }, owner: OWNER, enforce: Object.keys(ENV_KEYS) }]
}

export const AUTO_MEMORY_KEY = 'autoMemoryEnabled'

export function autoMemoryOps(ctx: AdapterContext): Op[] {
  return [{ kind: 'json-merge', path: join(ctx.paths.claudeDir(), 'settings.json'), set: { [AUTO_MEMORY_KEY]: false }, owner: OWNER, soft: [AUTO_MEMORY_KEY] }]
}

export function hiddenToolOps(ctx: AdapterContext): Op[] {
  const items: string[] = []
  for (const id of Object.keys(ctx.canonical.mcp.servers).sort()) {
    const s = ctx.canonical.mcp.servers[id]
    if (s === undefined || !s.harnesses.includes('claude')) continue
    for (const tool of s.disabled_tools ?? []) items.push(harnessMcpToolName('claude', id, tool))
  }
  return [{ kind: 'json-list-merge', path: join(ctx.paths.claudeDir(), 'settings.json'), pointer: 'permissions.deny', items, identity: LIST_IDENTITY_HASH, owner: OWNER, format: 'json' }]
}

export type ClaudeExecOp = Extract<Op, { kind: 'exec' }>

export type CleanupKey = NonNullable<Plan['cleanupKeys']>[number]

export function claudeManagesMarketplace(id: string): boolean {
  return CLAUDE_MANAGED_MARKETPLACES.includes(id)
}

export function execOps(ctx: AdapterContext, tools: { claude: string, bun: string, current?: unknown[] }): ClaudeExecOp[] {
  const { claude, bun } = tools
  const checkScript = join(ctx.repoRoot, 'src', 'adapters', 'claude', 'check.ts')
  const check = (...args: string[]) => [bun, checkScript, '--claude', claude, ...args]
  const ops: ClaudeExecOp[] = []

  for (const m of ctx.canonical.plugins.claude.marketplaces) {
    if (claudeManagesMarketplace(m.id)) continue
    ops.push({
      kind: 'exec', owner: OWNER, soft: true,
      argv: [claude, 'plugin', 'marketplace', 'add', m.source],
      undo: check('remove-marketplace', m.id),
      idempotentCheck: check('marketplace', m.id),
    })
  }

  const previous = (tools.current ?? []).find(e => {
    const x = e as { name?: unknown, source?: unknown, path?: unknown }
    return x !== null && typeof x === 'object' && x.name === MARKETPLACE_NAME && x.source === 'directory' && typeof x.path === 'string' && !samePath(x.path, ctx.repoRoot)
  }) as { path: string } | undefined
  ops.push({
    kind: 'exec', owner: OWNER,
    argv: [claude, 'plugin', 'marketplace', 'add', ctx.repoRoot],
    undo: previous !== undefined ? [claude, 'plugin', 'marketplace', 'add', previous.path] : [claude, 'plugin', 'marketplace', 'remove', MARKETPLACE_NAME],
    idempotentCheck: check('marketplace', MARKETPLACE_NAME, '--path', ctx.repoRoot),
  })
  ops.push({
    kind: 'exec', owner: OWNER,
    argv: [claude, 'plugin', 'install', PLUGIN_ID, '--scope', 'user'],
    undo: [claude, 'plugin', 'uninstall', PLUGIN_ID, '--scope', 'user'],
    idempotentCheck: check('plugin', PLUGIN_ID),
  })

  for (const p of ctx.canonical.plugins.claude.plugins) {
    if (!p.enabled) continue
    ops.push({
      kind: 'exec', owner: OWNER, soft: true,
      argv: [claude, 'plugin', 'install', p.id, '--scope', 'user'],
      undo: [claude, 'plugin', 'uninstall', p.id, '--scope', 'user'],
      idempotentCheck: check('plugin', p.id),
    })
  }
  for (const id of ctx.canonical.plugins.claude.retired ?? []) {
    ops.push({
      kind: 'exec', owner: OWNER, soft: true,
      argv: [claude, 'plugin', 'uninstall', id, '--scope', 'user'],
      undo: [claude, 'plugin', 'install', id, '--scope', 'user'],
      idempotentCheck: check('retired', id),
    })
  }
  return ops
}

export function cleanupKeys(ctx: AdapterContext): CleanupKey[] {
  const path = join(ctx.paths.claudeDir(), 'settings.json')
  return [{ path, pointer: 'enabledPlugins' }, { path, pointer: 'extraKnownMarketplaces' }]
}

export const LSP_NEVER_KEY = 'lspRecommendationNeverPlugins'

export function lspRecommendationPlan(ctx: Pick<AdapterContext, 'paths' | 'canonical'>): Plan | undefined {
  const path = ctx.paths.claudeJson()
  if (!existsSync(path)) return undefined
  const items = [...new Set(ctx.canonical.tools.tools.flatMap(t => t.lsp?.replaces ?? []))].sort()
  return { id: 'claude-lsp-hints', harness: 'claude', ops: [{ kind: 'json-list-merge', path, pointer: LSP_NEVER_KEY, items, identity: LIST_IDENTITY_HASH, owner: OWNER, format: 'json' }] }
}

export async function claudeInstallPlan(ctx: AdapterContext, deps: Partial<InstallDeps> = {}): Promise<Plan> {
  const d: InstallDeps = { ...defaultInstallDeps, ...deps }
  const claude = d.claudeBin()
  const [ledger, current] = await Promise.all([d.ledger(), d.marketplaces(claude).catch(() => undefined)])
  const tools: { claude: string, bun: string, current?: unknown[] } = { claude, bun: d.bunBin() }
  if (current !== undefined) tools.current = current
  return {
    id: 'claude',
    harness: 'claude',
    ops: [...ruleOps(ctx, ledger), statusLineOp(ctx, tools.bun), ...permissionOps(ctx), ...effortOps(ctx), ...teamsOps(ctx), ...envOps(ctx), ...autoMemoryOps(ctx), ...hiddenToolOps(ctx), ...execOps(ctx, tools)],
    cleanupKeys: cleanupKeys(ctx),
  }
}

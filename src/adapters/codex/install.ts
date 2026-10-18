import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AdapterContext } from '../registry'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { readLedger } from '../../engine/txn'
import { valueHash } from '../../engine/merge'
import { log } from '../../engine/log'
import { run } from '../../engine/proc'
import { AGENTS_BLOCK_ID, codexArtifacts, OWNER, RULES_FILE, type CodexArtifacts } from './generate'
import { CODEX_HOOK_EVENTS, HOOK_COMMAND_PREFIX, HOOK_GROUP_IDENTITY, LEGACY_HOOK_COMMAND_PREFIX, trustMigration, windowsHookPrefix, type TrustMigration } from './hooks-config'
import { UPDATE_PLAN_TABLE, updatePlanTable } from './config'
import { bypassOp, bypassUnitBlocked } from './trust'

export class HarnessBusyError extends Error {
  readonly exitCode = 2
  readonly code = 'HARNESS_BUSY'
  readonly harness = 'codex'
  constructor(message: string) {
    super(message)
    this.name = 'HarnessBusyError'
  }
}

export const installTestHooks: {
  codexPids?: () => Promise<number[]>
  openFiles?: (pids: readonly number[]) => Promise<Map<number, string[]> | undefined>
} = {}

async function codexPids(): Promise<number[]> {
  if (installTestHooks.codexPids) return installTestHooks.codexPids()
  const r = await run(['pgrep', '-x', 'codex'], { timeoutMs: 3000 })
  if (r.code !== 0) return []
  return r.stdout.split(/\s+/).filter(s => /^\d+$/.test(s)).map(Number).filter(n => n !== process.pid)
}

export function parseLsofFields(out: string): Map<number, string[]> {
  const files = new Map<number, string[]>()
  let cur: string[] | undefined
  for (const line of out.split('\n')) {
    if (line.startsWith('p') && /^p\d+$/.test(line)) {
      cur = []
      files.set(Number(line.slice(1)), cur)
    } else if (line.startsWith('n') && cur !== undefined) cur.push(line.slice(1))
  }
  return files
}

async function openFiles(pids: readonly number[]): Promise<Map<number, string[]> | undefined> {
  if (installTestHooks.openFiles) return installTestHooks.openFiles(pids)
  const r = await run(['lsof', '-n', '-P', '-Fpn', '-p', pids.join(',')], { timeoutMs: 5000 })
  return r.stdout.trim() === '' ? undefined : parseLsofFields(r.stdout)
}

function real(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

const ARG0_LOCK = /\/tmp\/arg0\/codex-arg0[^/]*\/\.lock$/

export async function codexProcessesUsing(codexHome: string): Promise<number[]> {
  const pids = await codexPids()
  if (pids.length === 0) return []
  const files = await openFiles(pids)
  if (files === undefined) return pids
  const home = real(codexHome).replace(/\/+$/, '')
  return pids.filter(pid => {
    const list = files.get(pid)
    if (list === undefined) return true
    if (list.some(f => f === home || f.startsWith(`${home}/`))) return true
    return !list.some(f => ARG0_LOCK.test(f))
  })
}

function forced(ctx: AdapterContext): boolean {
  const f = (ctx as unknown as { force?: unknown }).force
  return f === true || process.env['BURACLE_FORCE'] === '1' || process.env['BURACLE_INSTALL_FORCE'] === '1'
}

export async function assertCodexIdle(ctx: AdapterContext, what: 'install' | 'uninstall' = 'install'): Promise<void> {
  if (forced(ctx)) return
  const home = ctx.paths.codexHome()
  const pids = await codexProcessesUsing(home)
  if (pids.length > 0) {
    throw new HarnessBusyError(`Codex is running against ${home} (pid ${pids.join(', ')}). It rewrites ${join(home, 'config.toml')} itself, so Buracle will not change it now. Quit Codex and run the ${what} again; in a terminal, \`buracle ${what}\` asks whether to change it anyway (BURACLE_FORCE=1 does that without asking).`)
  }
}

export function hooksJsonOps(path: string, a: CodexArtifacts): Op[] {
  return CODEX_HOOK_EVENTS.map((event): Op => ({
    kind: 'json-list-merge',
    path,
    pointer: `hooks.${event}`,
    items: [...(a.hooksFile.hooks[event] ?? [])],
    identity: HOOK_GROUP_IDENTITY,
    owner: OWNER,
    format: 'json',
  }))
}

function tomlTableOp(path: string, name: string, values: Record<string, unknown>, ignore?: string[]): Op {
  return ignore !== undefined ? { kind: 'toml-tables', path, tables: { [name]: values }, owner: OWNER, ignore: { [name]: ignore } } : { kind: 'toml-tables', path, tables: { [name]: values }, owner: OWNER }
}

export const MCP_TABLE_CODEX_KEYS: readonly string[] = ['tools']

export function tuiOps(path: string, a: CodexArtifacts): Op[] {
  return [{ kind: 'toml-tables', path, tables: {}, keys: { 'tui.status_line': a.tui.status_line, 'tui.terminal_title': a.tui.terminal_title }, owner: OWNER }]
}

export function rootKeysOp(path: string, a: Pick<CodexArtifacts, 'rootKeys'>): Op | undefined {
  const keys: Record<string, unknown> = a.rootKeys ?? {}
  return Object.keys(keys).length > 0 ? { kind: 'toml-tables', path, tables: {}, keys: { ...keys }, owner: OWNER } : undefined
}

export function effortOp(path: string, a: CodexArtifacts): Op | undefined {
  if (a.effortKeys === undefined) return undefined
  return { kind: 'toml-tables', path, tables: {}, keys: { ...a.effortKeys }, owner: OWNER, soft: Object.keys(a.effortKeys) }
}

export function teamsOp(path: string, a: CodexArtifacts): Op | undefined {
  if (a.teamsKeys === undefined) return undefined
  return { kind: 'toml-tables', path, tables: {}, keys: { ...a.teamsKeys }, owner: OWNER, soft: Object.keys(a.teamsKeys) }
}

export function memoryOp(path: string, a: CodexArtifacts): Op | undefined {
  if (a.memoryKeys === undefined) return undefined
  return { kind: 'toml-tables', path, tables: {}, keys: { ...a.memoryKeys }, owner: OWNER, soft: Object.keys(a.memoryKeys) }
}

export function compactOp(path: string, a: CodexArtifacts): Op | undefined {
  if (a.compactKeys === undefined) return undefined
  return { kind: 'toml-tables', path, tables: {}, keys: { ...a.compactKeys }, owner: OWNER, soft: Object.keys(a.compactKeys) }
}

export interface ConfigTomlOptions {
  enforce?: boolean
  bypassBlocked?: string
}

export function configTomlOps(path: string, a: CodexArtifacts, opts: ConfigTomlOptions = {}): Op[] {
  const ops: Op[] = Object.entries(a.mcpTables).map(([name, table]) => tomlTableOp(path, name, table, [...MCP_TABLE_CODEX_KEYS]))
  ops.push(...tuiOps(path, a))
  ops.push(tomlTableOp(path, UPDATE_PLAN_TABLE, updatePlanTable()))
  const root = rootKeysOp(path, a)
  if (root !== undefined) ops.push(root)
  const effort = effortOp(path, a)
  if (effort !== undefined) ops.push(effort)
  const teams = teamsOp(path, a)
  if (teams !== undefined) ops.push(teams)
  const memory = memoryOp(path, a)
  if (memory !== undefined) ops.push(memory)
  const compact = compactOp(path, a)
  if (compact !== undefined) ops.push(compact)
  if (a.bypassKeys !== undefined && (opts.enforce === true || opts.bypassBlocked === undefined)) ops.push(bypassOp(path, { enforce: opts.enforce === true }))
  return ops
}

export function tildePath(p: string, home: string): string {
  return p === home ? '~' : p.startsWith(home + '/') ? `~/${p.slice(home.length + 1)}` : p
}

export async function codexUninstallPlan(ctx: AdapterContext, opts: { ledger?: Ledger } = {}): Promise<Plan> {
  await assertCodexIdle(ctx, 'uninstall')
  let ledger: Ledger | undefined = opts.ledger
  if (ledger === undefined) {
    try { ledger = await readLedger() } catch { ledger = undefined }
  }
  const keys = new Set<string>()
  if (ledger !== undefined) {
    for (const [key, entry] of Object.entries(ledger)) if (entry.owner === OWNER) keys.add(key)
  }
  const ops = [...keys].sort().map((path): Op => ({ kind: 'remove', path, owner: OWNER }))
  const rekey = trustRekeyOp(ctx, ledger)
  if (rekey !== undefined) ops.push(rekey)
  return { id: 'codex-uninstall', harness: 'codex', ops }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function trustRekeyOp(ctx: Pick<AdapterContext, 'paths'>, ledger: Ledger | undefined): Op | undefined {
  if (ledger === undefined) return undefined
  const codexHome = ctx.paths.codexHome()
  const hooksPath = join(codexHome, 'hooks.json')
  const configPath = join(codexHome, 'config.toml')
  let parsed: unknown
  let state: Record<string, unknown>
  try {
    parsed = JSON.parse(readFileSync(hooksPath, 'utf8')) as unknown
    const config = Bun.TOML.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    const hooks = config['hooks']
    const st = isObj(hooks) ? hooks['state'] : undefined
    if (!isObj(st)) return undefined
    state = st
  } catch { return undefined }
  const lists = isObj(parsed) && isObj(parsed['hooks']) ? parsed['hooks'] : {}
  const removed: Array<{ event: string, groupIndex: number }> = []
  for (const e of Object.values(ledger)) {
    if (e.owner !== OWNER || (e.kind !== 'json-list' && e.kind !== 'jsonc-list') || resolve(e.path) !== resolve(hooksPath)) continue
    const segs = e.segs ?? []
    const event = segs[1]
    if (segs.length !== 2 || segs[0] !== 'hooks' || event === undefined) continue
    const arr = lists[event]
    if (!Array.isArray(arr)) continue
    const taken = new Set<number>()
    for (const rec of e.items ?? []) {
      if (rec.adopted === true) continue
      const idx = arr.findIndex((x, i) => !taken.has(i) && valueHash(x) === rec.sha256)
      if (idx >= 0) { taken.add(idx); removed.push({ event, groupIndex: idx }) }
    }
  }
  if (removed.length === 0) return undefined
  let best: TrustMigration | undefined
  for (const src of [...new Set([hooksPath, real(hooksPath)])]) {
    const m = trustMigration(src, parsed, removed, state)
    if (best === undefined || m.moves.length + m.drops.length > best.moves.length + best.drops.length) best = m
  }
  if (best === undefined || best.moves.length + best.drops.length === 0) return undefined
  return {
    kind: 'toml-rekey', path: configPath, owner: OWNER,
    drops: best.drops.map(d => ({ table: ['hooks', 'state', d.key], value: d.state })),
    moves: best.moves.map(m => ({ from: ['hooks', 'state', m.from], to: ['hooks', 'state', m.to], value: m.state })),
  }
}

export function hookCommandPrefixFor(ctx: Pick<AdapterContext, 'paths'>, ledger: Ledger | undefined): string {
  const p = ctx.paths
  if (ledger === undefined || resolve(p.buracleHome()) !== resolve(join(p.home(), '.buracle'))) return HOOK_COMMAND_PREFIX
  const hooksPath = resolve(join(p.codexHome(), 'hooks.json'))
  const legacy = JSON.stringify(LEGACY_HOOK_COMMAND_PREFIX).slice(1, -1)
  const ownsLegacy = Object.values(ledger).some(e => e.owner === OWNER && resolve(e.path) === hooksPath
    && (e.items ?? []).some(i => i.adopted !== true && i.id.includes(legacy)))
  return ownsLegacy ? LEGACY_HOOK_COMMAND_PREFIX : HOOK_COMMAND_PREFIX
}

export async function codexInstallPlan(ctx: AdapterContext, opts: { ledger?: Ledger } = {}): Promise<Plan> {
  await assertCodexIdle(ctx)
  const p = ctx.paths
  const codexHome = p.codexHome()
  let ledger: Ledger | undefined = opts.ledger
  if (ledger === undefined) {
    try { ledger = await readLedger() } catch { ledger = undefined }
  }
  const a = codexArtifacts({
    hookCommandPrefix: hookCommandPrefixFor(ctx, ledger),
    ...(process.platform === 'win32' ? { hookCommandPrefixWindows: windowsHookPrefix(ctx.buracleBin) } : {}),
    canonical: ctx.canonical,
    buracle: ctx.buracleBin,
    pathRulesDir: tildePath(join(p.buracleHome(), 'rules', 'paths'), p.home()),
    home: p.home(),
    config: ctx.config,
  })
  const configPath = join(codexHome, 'config.toml')
  const enforce = ctx.config.permissions.enforce === true
  let bypassBlocked: string | undefined
  if (a.bypassKeys !== undefined && !enforce) {
    let text: string | undefined
    try { text = readFileSync(configPath, 'utf8') } catch { text = undefined }
    bypassBlocked = bypassUnitBlocked(text, ledger, configPath)
    if (bypassBlocked !== undefined) log('warn', 'codex install: the no-approval keys are left out (permissions.enforce is off)', { reason: bypassBlocked })
  }
  const ops: Op[] = []
  ops.push(...hooksJsonOps(join(codexHome, 'hooks.json'), a))
  ops.push(...configTomlOps(configPath, a, { enforce, ...(bypassBlocked !== undefined ? { bypassBlocked } : {}) }))
  ops.push({ kind: 'md-block', path: join(codexHome, 'AGENTS.md'), id: AGENTS_BLOCK_ID, content: a.agentsBlock, owner: OWNER })
  const files: Array<{ path: string, content: string }> = [
    ...a.agentFiles.map(f => ({ path: join(codexHome, 'agents', `${f.id}.toml`), content: f.content })),
    { path: join(codexHome, 'rules', RULES_FILE), content: a.rulesFile },
  ]
  for (const f of files) ops.push({ kind: 'file', path: f.path, content: f.content, owner: OWNER })
  return { id: 'codex', harness: 'codex', ops }
}

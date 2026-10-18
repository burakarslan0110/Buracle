import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { AdapterContext } from '../registry'
import { getIn, jsoncParse, parseKeyPath } from '../../engine/merge'
import { pathExistsSync } from '../../engine/fsx'
import { detectBinary } from '../../engine/proc'
import { bunExecutable } from '../../engine/config'
import type { Ledger, Op, Plan } from '../../engine/txn'
import { readLedger } from '../../engine/txn'
import { buildFiles } from './build'
import { AGENTS_BLOCK_ID, MIN_VERSION, OWNER, PLUGIN_DIR } from './constants'
import { POINTER_FILE } from './runtime/env'
import { agentsBlock, cliSet, configSet } from './render'

export const CLI_PERMISSIONS_KEY = 'session.permissions'

export function displayPath(abs: string, homeDir: string): string {
  const a = resolve(abs)
  const h = resolve(homeDir)
  if (a === h) return '~'
  return a.startsWith(h + sep) ? `~/${a.slice(h.length + 1)}` : a
}

export function configTarget(configDir: string): string {
  const jsonc = join(configDir, 'opencode.jsonc')
  const json = join(configDir, 'opencode.json')
  if (pathExistsSync(jsonc)) return jsonc
  if (pathExistsSync(json)) return json
  return jsonc
}

export function configOps(configDir: string, set: Record<string, unknown>): Op[] {
  const target = configTarget(configDir)
  const json = join(configDir, 'opencode.json')
  if (target === json || !pathExistsSync(json)) return [{ kind: 'jsonc-merge', path: target, set, owner: OWNER }]
  let lower: { ok: true, value: unknown } | { ok: false } = { ok: false }
  try { lower = jsoncParse(readFileSync(json, 'utf8')) } catch { lower = { ok: false } }
  const winning: Record<string, unknown> = {}
  const shadowed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(set)) {
    const userSets = key !== '$schema' && (!lower.ok || getIn(lower.value, parseKeyPath(key)).found)
    if (userSets) shadowed[key] = value
    else winning[key] = value
  }
  const ops: Op[] = []
  if (Object.keys(winning).length > 0) ops.push({ kind: 'jsonc-merge', path: target, set: winning, owner: OWNER })
  if (Object.keys(shadowed).length > 0) ops.push({ kind: 'jsonc-merge', path: json, set: shadowed, owner: OWNER })
  return ops
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(x => parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map(x => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

async function ledger(): Promise<Ledger> {
  try { return await readLedger() } catch { return {} }
}

function cliKeys(cliPath: string, owned: Ledger, pluginDir: string, bypass: boolean): Record<string, unknown> {
  const set = cliSet(pluginDir, { bypass })
  let text: string | undefined
  try { text = readFileSync(cliPath, 'utf8') } catch { text = undefined }
  if (text === undefined) return set
  const parsed = jsoncParse(text)
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') return set
  const hasPlugins = Object.prototype.hasOwnProperty.call(parsed.value, 'plugins')
  if (hasPlugins && owned[`${cliPath}#plugins`] === undefined) delete set['plugins']
  return set
}

export interface InstallOptions {
  opencode?: { path: string, version?: string } | null
}

export async function installPlan(ctx: AdapterContext, opts: InstallOptions = {}): Promise<Plan> {
  const configDir = ctx.paths.opencodeConfigDir()
  const buracleHome = ctx.paths.buracleHome()
  const homeDir = ctx.paths.home()
  const shim = ctx.buracleBin
  const owned = await ledger()
  const ops: Op[] = []
  const wanted = new Set<string>()
  const file = (path: string, content: string, owner = OWNER, mode?: number) => {
    wanted.add(path)
    const op: Op = mode !== undefined ? { kind: 'file', path, content, mode, owner } : { kind: 'file', path, content, owner }
    ops.push(op)
  }

  for (const f of await buildFiles(ctx)) {
    if (f.path.startsWith(`${PLUGIN_DIR}/`) || f.path.startsWith('agents/')) {
      file(join(configDir, f.path), f.content, OWNER, f.mode)
    }
  }
  file(join(configDir, PLUGIN_DIR, POINTER_FILE), JSON.stringify({ v: 1, buracleHome, shim }, null, 2) + '\n')

  const pathRulesDir = join(buracleHome, 'rules', 'paths')

  const managedDirs = [join(configDir, 'agents'), join(configDir, 'commands'), join(configDir, PLUGIN_DIR)].map(d => d + sep)
  for (const [key, entry] of Object.entries(owned)) {
    if (entry.owner !== OWNER || entry.kind !== 'file' || entry.pointer !== undefined || key !== entry.path) continue
    if (!managedDirs.some(d => entry.path.startsWith(d)) || wanted.has(entry.path)) continue
    ops.push({ kind: 'remove', path: entry.path, owner: OWNER })
  }

  ops.push(...configOps(configDir, configSet(ctx.canonical, shim)))
  const cliPath = join(configDir, 'cli.json')
  const enforce = ctx.config.permissions.bypass && ctx.config.permissions.enforce ? { enforce: [CLI_PERMISSIONS_KEY] } : {}
  ops.push({ kind: 'jsonc-merge', path: cliPath, set: cliKeys(cliPath, owned, join(configDir, PLUGIN_DIR), ctx.config.permissions.bypass), owner: OWNER, ...enforce })
  ops.push({ kind: 'md-block', path: join(configDir, 'AGENTS.md'), id: AGENTS_BLOCK_ID, content: agentsBlock(ctx.canonical, displayPath(pathRulesDir, homeDir)), owner: OWNER })

  const bin = opts.opencode !== undefined ? opts.opencode : await detectBinary('opencode').then(d => (d.installed && d.path !== undefined ? { path: d.path, ...(d.version !== undefined ? { version: d.version } : {}) } : null))
  if (bin !== null && bin.version !== undefined && compareVersions(bin.version, MIN_VERSION) >= 0) {
    ops.push({
      kind: 'exec',
      argv: [bin.path, 'service', 'set', 'env', 'BURACLE_HOME', buracleHome],
      undo: [bin.path, 'service', 'unset', 'env', 'BURACLE_HOME'],
      idempotentCheck: [bunExecutable(), '-e', SERVICE_ENV_CHECK, bin.path, buracleHome],
      owner: OWNER,
    })
    return { id: 'opencode', harness: 'opencode', ops, cleanupKeys: [{ path: join(configDir, SERVICE_FILE), pointer: '' }] }
  }
  return { id: 'opencode', harness: 'opencode', ops }
}

export const SERVICE_ENV_CHECK = 'const [bin, want] = process.argv.slice(-2); const r = Bun.spawnSync([bin, "service", "get", "env", "BURACLE_HOME"], { stdout: "pipe", stderr: "ignore" }); process.exit(r.exitCode === 0 && r.stdout.toString().trim() === want ? 0 : 1)'

export const SERVICE_FILE = 'service.json'

import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../../engine/paths'
import { run } from '../../engine/proc'

export interface MarketplaceEntry { name?: unknown; source?: unknown; path?: unknown; repo?: unknown; url?: unknown }
export interface PluginEntry { id?: unknown; enabled?: unknown; errors?: unknown; readFromFolder?: unknown; scope?: unknown }

function real(p: string): string {
  try { return realpathSync(p) } catch { return p.replace(/\/+$/, '') }
}

export function samePath(a: string, b: string): boolean {
  return real(a) === real(b)
}

export function parseList(stdout: string): unknown[] | undefined {
  const text = stdout.trim()
  const starts = [0]
  for (let i = text.indexOf('\n['); i >= 0; i = text.indexOf('\n[', i + 1)) starts.push(i + 1)
  for (const s of starts) {
    try {
      const v = JSON.parse(text.slice(s)) as unknown
      if (Array.isArray(v)) return v
    } catch {  }
  }
  return undefined
}

export function marketplaceHolds(list: unknown[], name: string, path?: string): boolean {
  return list.some(m => {
    const e = m as MarketplaceEntry
    if (e === null || typeof e !== 'object' || e.name !== name) return false
    return path === undefined || (typeof e.path === 'string' && samePath(e.path, path))
  })
}

export function pluginInstalled(list: unknown[], id: string): boolean {
  return list.some(p => p !== null && typeof p === 'object' && (p as PluginEntry).id === id)
}

export function buracleInstalledPlugin(id: string, journalDir: string = paths.journalDir()): boolean {
  let names: string[]
  try { names = readdirSync(journalDir).filter(n => n.endsWith('.json')) } catch { return false }
  for (const n of names) {
    try {
      const j = JSON.parse(readFileSync(join(journalDir, n), 'utf8')) as { status?: unknown, execs?: unknown }
      if (j.status !== 'committed' || !Array.isArray(j.execs)) continue
      for (const e of j.execs as Array<{ argv?: unknown, ran?: unknown, undone?: unknown }>) {
        const a = Array.isArray(e.argv) ? e.argv : []
        if (e.ran === true && e.undone !== true && a[1] === 'plugin' && a[2] === 'install' && a[3] === id) return true
      }
    } catch {  }
  }
  return false
}

export const KEPT_EXIT = 3

export function pluginsFrom(list: unknown[], name: string): string[] {
  return list.flatMap(p => {
    const id = p !== null && typeof p === 'object' ? (p as PluginEntry).id : undefined
    return typeof id === 'string' && id.endsWith(`@${name}`) ? [id] : []
  }).sort()
}

async function listing(argv: string[]): Promise<unknown[] | undefined> {
  const r = await run(argv, { timeoutMs: 60_000 })
  const list = r.code === 0 ? parseList(r.stdout) : undefined
  if (list === undefined) process.stderr.write(`check: ${argv.join(' ')} failed (exit ${r.code})\n`)
  return list
}

export async function removeMarketplace(claude: string, name: string): Promise<number> {
  const markets = await listing([claude, 'plugin', 'marketplace', 'list', '--json'])
  if (markets === undefined) return 2
  if (!marketplaceHolds(markets, name)) return 0
  const plugins = await listing([claude, 'plugin', 'list', '--json'])
  if (plugins === undefined) return 2
  const used = pluginsFrom(plugins, name)
  if (used.length > 0) {
    process.stderr.write(`kept the ${name} marketplace: your plugins ${used.join(', ')} come from it (removing it would uninstall them with their data); remove it yourself with \`claude plugin marketplace remove ${name}\` once you no longer need them\n`)
    return KEPT_EXIT
  }
  const r = await run([claude, 'plugin', 'marketplace', 'remove', name], { timeoutMs: 300_000 })
  if (r.stdout !== '') process.stdout.write(r.stdout)
  if (r.stderr !== '') process.stderr.write(r.stderr)
  return r.code
}

export async function check(argv: string[]): Promise<number> {
  const args = [...argv]
  let claude = 'claude'
  const ci = args.indexOf('--claude')
  if (ci >= 0) { claude = args[ci + 1] ?? claude; args.splice(ci, 2) }
  let path: string | undefined
  const pi = args.indexOf('--path')
  if (pi >= 0) { path = args[pi + 1]; args.splice(pi, 2) }
  const [what, name] = args
  if (what === 'remove-marketplace' && name !== undefined) return removeMarketplace(claude, name)
  if (what === 'retired' && name !== undefined) {
    if (!buracleInstalledPlugin(name)) return 0
    const list = await listing([claude, 'plugin', 'list', '--json'])
    if (list === undefined) return 2
    return pluginInstalled(list, name) ? 1 : 0
  }
  if ((what !== 'marketplace' && what !== 'plugin') || name === undefined) {
    process.stderr.write('usage: check.ts [--claude <path>] marketplace <name> [--path <dir>] | plugin <id> | retired <id> | remove-marketplace <name>\n')
    return 2
  }
  const listArgv = what === 'marketplace' ? [claude, 'plugin', 'marketplace', 'list', '--json'] : [claude, 'plugin', 'list', '--json']
  const r = await run(listArgv, { timeoutMs: 60_000 })
  const list = r.code === 0 ? parseList(r.stdout) : undefined
  if (list === undefined) {
    process.stderr.write(`check: ${listArgv.join(' ')} failed (exit ${r.code})\n`)
    return 2
  }
  const ok = what === 'marketplace' ? marketplaceHolds(list, name, path) : pluginInstalled(list, name)
  return ok ? 0 : 1
}

if (import.meta.main) {
  check(process.argv.slice(2)).then(code => process.exit(code), () => process.exit(2))
}

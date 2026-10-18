import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { Harness } from '../core/events'
import { HARNESSES } from '../core/events'
import { sha256 } from './fsx'
import * as paths from './paths'
import { findExecutable } from './platform'
import type { ToolchainState } from './toolchain/state'
import { packageKey, readToolchainState } from './toolchain/state'

export { CM_SERVER_ID } from '../core/context-mode'
export const CM_PACKAGE = 'context-mode'

export type CmPlatform = 'claude-code' | 'codex' | 'opencode' | 'omp'

const PLATFORM: Readonly<Record<Harness, CmPlatform>> = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', omp: 'omp' }

export function cmPlatform(h: Harness): CmPlatform {
  return PLATFORM[h]
}

export function cmHarnessOfPlatform(p: string | undefined): Harness | undefined {
  if (p === undefined) return undefined
  return HARNESSES.find(h => PLATFORM[h] === p.trim())
}

export function cmHome(): string {
  return join(paths.buracleHome(), 'context-mode')
}

function separators(platform: NodeJS.Platform): RegExp {
  return platform === 'win32' ? /[\\/]+/ : /\/+/
}

function projectKey(projectDir: string, platform: NodeJS.Platform): string {
  const dir = platform === 'win32' ? projectDir.replace(/\//g, '\\') : projectDir
  const trimmed = dir.replace(platform === 'win32' ? /\\+$/ : /\/+$/, '')
  const key = trimmed === '' ? dir.slice(0, 1) : trimmed
  return platform === 'darwin' || platform === 'win32' ? key.toLowerCase() : key
}

function projectSlug(projectDir: string, platform: NodeJS.Platform): string {
  const segments = projectDir.split(separators(platform)).filter(s => s !== '')
  const base = (segments[segments.length - 1] ?? '').toLowerCase()
  const slug = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '')
  return slug === '' ? 'root' : slug
}

export function cmStorageRoot(h: Harness, projectDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(cmHome(), h, `${projectSlug(projectDir, platform)}-${sha256(projectKey(projectDir, platform)).slice(0, 12)}`)
}

export function cmProbeRoot(): string {
  return join(cmHome(), 'probe')
}

export function cmSentinelDir(): string {
  return join(cmHome(), 'sentinel')
}

export function cmSessionsDir(root: string): string {
  return join(root, 'sessions')
}

export interface CmPackage {
  root: string
  version: string
  dir: string
}

export function cmPackage(state: ToolchainState = readToolchainState()): CmPackage | undefined {
  const p = state.packages[packageKey('npm', CM_PACKAGE)]
  if (p === undefined) return undefined
  return { root: join(p.dir, 'node_modules', CM_PACKAGE), version: p.version, dir: p.dir }
}

export function cmBun(): string | undefined {
  const own = process.execPath
  if (own !== '' && /^bun(?:\.exe)?$/i.test(basename(own))) return own
  return findExecutable('bun')
}

function realOr(p: string, realpath: (q: string) => string): string {
  try { return realpath(p) } catch { return p }
}

export function cmProjectDir(h: Harness, opts: { claudeProjectDir?: string | undefined, cwd: string, realpath?: (p: string) => string }): string {
  if (h === 'claude' && opts.claudeProjectDir !== undefined && opts.claudeProjectDir.trim() !== '') return opts.claudeProjectDir
  return realOr(opts.cwd, opts.realpath ?? realpathSync)
}

type Env = Record<string, string | undefined>

function definedOnly(env: Env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v
  return out
}

function blank(v: string | undefined): boolean {
  return v === undefined || v.trim() === ''
}

const CODEX_ARG0_DIR = /[\\/]tmp[\\/]arg0[\\/]codex-arg0[^\\/:;]*[\\/]?$/

function withoutCodexArg0(path: string, platform: NodeJS.Platform): string {
  const sep = platform === 'win32' ? ';' : ':'
  return path.split(sep).filter(e => !CODEX_ARG0_DIR.test(e)).join(sep)
}

export function cmServerEnv(env: Env, opts: { cwd: string, realpath?: (p: string) => string, platform?: NodeJS.Platform }): Record<string, string> {
  const out: Env = { ...env }
  const platform = opts.platform ?? process.platform
  const realpath = opts.realpath ?? realpathSync
  const h = cmHarnessOfPlatform(out['CONTEXT_MODE_PLATFORM'])
  const project = h !== undefined ? cmProjectDir(h, { claudeProjectDir: out['CLAUDE_PROJECT_DIR'], cwd: opts.cwd, realpath }) : realOr(opts.cwd, realpath)
  if (h !== undefined) out['CONTEXT_MODE_DIR'] = cmStorageRoot(h, project, platform)
  else if (blank(out['CONTEXT_MODE_DIR'])) out['CONTEXT_MODE_DIR'] = cmProbeRoot()
  if (blank(out['CONTEXT_MODE_MCP_SENTINEL_DIR'])) out['CONTEXT_MODE_MCP_SENTINEL_DIR'] = cmSentinelDir()
  const claudeDir = h === 'claude' && !blank(out['CLAUDE_PROJECT_DIR'])
  if (!claudeDir && (h !== undefined || blank(out['CONTEXT_MODE_PROJECT_DIR']))) {
    out['CONTEXT_MODE_PROJECT_DIR'] = project
    out['PWD'] = project
  }
  if (h === 'omp') delete out['PI_CODING_AGENT_DIR']
  if (h === 'codex') {
    for (const k of Object.keys(out)) {
      const v = out[k]
      if (k.toUpperCase() === 'PATH' && v !== undefined) out[k] = withoutCodexArg0(v, platform)
    }
  }
  return definedOnly(out)
}

export function cmEmptyClaudeConfigDir(): string {
  return join(cmHome(), 'claude-config-empty')
}

const CM_CLAUDE_PLUGIN = 'context-mode@context-mode'

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function cmStaleClaudePlugin(env: Env, opts: { cwd: string }): string[] {
  const homeVar = env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME']
  const home = homeVar !== undefined && homeVar.trim() !== '' ? homeVar : paths.home()
  const set = env['CLAUDE_CONFIG_DIR']
  const root = set === undefined || set.trim() === '' ? resolve(home, '.claude')
    : set.startsWith('~') ? resolve(home, set.replace(/^~[/\\]?/, ''))
    : resolve(opts.cwd, set)
  let doc: unknown
  try { doc = JSON.parse(readFileSync(join(root, 'plugins', 'installed_plugins.json'), 'utf8')) } catch { return [] }
  const entries = isRecord(doc) && isRecord(doc['plugins']) ? doc['plugins'][CM_CLAUDE_PLUGIN] : undefined
  if (!Array.isArray(entries)) return []
  const cache = realOr(join(root, 'plugins', 'cache'), realpathSync)
  const out: string[] = []
  for (const e of entries) {
    const p = isRecord(e) ? e['installPath'] : undefined
    if (typeof p !== 'string' || p === '') continue
    const abs = resolve(opts.cwd, p)
    if (!existsSync(abs) && abs.startsWith(cache + sep)) out.push(p)
  }
  return out
}

export function ensureCmDirs(h: Harness, projectDir: string, platform: NodeJS.Platform = process.platform): void {
  for (const d of [cmSessionsDir(cmStorageRoot(h, projectDir, platform)), cmSentinelDir()]) {
    try { mkdirSync(d, { recursive: true, mode: 0o700 }) } catch {  }
  }
}

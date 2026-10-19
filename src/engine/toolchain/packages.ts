import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { defaultConfig } from '../../core/config'
import { loadConfigSync } from '../config'
import { opsDeps } from '../update/deps'
import { errText } from '../update/output'
import { npmVersions, pypiVersions } from '../update/updates'
import { pickUpdate } from '../update/versions'
import * as paths from '../paths'
import { augmentedPath, exeName, findExecutable, spawnArgv } from '../platform'
import type { ToolSpec } from '../../core/catalog'
import type { InstalledPackage, PackageRegistry } from './state'

export const UV_PYTHON = '3.12'

export interface PackageRequest {
  registry: PackageRegistry
  name: string
  version: string
  extras?: string[]
  bins?: string[]
  with?: string[]
  scripts?: boolean
}

export interface InstallOutcome { ok: true; pkg: InstalledPackage }
export interface InstallFailure { ok: false; error: string }

export function safeName(name: string): string {
  return name.replace(/^@/, '').replace(/[\\/]/g, '__').replace(/[^A-Za-z0-9._-]/g, '_')
}

export function npmPrefix(name: string): string {
  return join(paths.toolchainDir(), 'npm', safeName(name))
}

export function npmStagingPrefix(name: string): string {
  return `${npmPrefix(name)}.staging`
}

export function npmPreviousPrefix(name: string): string {
  return `${npmPrefix(name)}.previous`
}

export function configuredMinAgeDays(): number {
  try {
    return loadConfigSync().config.update.minReleaseAgeDays
  } catch {
    return defaultConfig().update.minReleaseAgeDays
  }
}

export function uvToolDir(): string {
  return join(paths.toolchainDir(), 'uv', 'tools')
}

export function uvBinDir(): string {
  return join(paths.toolchainDir(), 'uv', 'bin')
}

export function toolchainEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: augmentedPath(),
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
    UV_TOOL_DIR: uvToolDir(),
    UV_TOOL_BIN_DIR: uvBinDir(),
    UV_NO_PROGRESS: '1',
    HOMEBREW_NO_AUTO_UPDATE: '1',
    HOMEBREW_NO_ENV_HINTS: '1',
    HOMEBREW_NO_INSTALL_CLEANUP: '1',
    ...extra,
  }
}

function tail(text: string, lines = 4): string {
  return text.trim().split('\n').slice(-lines).join(' / ').slice(0, 400)
}

export interface ReleasePick {
  version: string
  candidate?: string
  latest?: string
  held?: { version: string, ageDays: number }
}

export async function latestVersion(registry: PackageRegistry, name: string, nowMs: number, minAgeDays: number = configuredMinAgeDays()): Promise<ReleasePick | { error: string }> {
  const r = registry === 'npm' ? await npmVersions(name) : await pypiVersions(name)
  if ('error' in r) return r
  const pick = pickUpdate(undefined, r.versions, r.latestTag !== undefined ? { latestTag: r.latestTag, nowMs, minAgeDays } : { nowMs, minAgeDays })
  const version = pick.candidate ?? pick.latest
  if (version === undefined) return { error: `${name}: no release found` }
  const out: ReleasePick = { version }
  if (pick.candidate !== undefined) out.candidate = pick.candidate
  if (pick.latest !== undefined) out.latest = pick.latest
  if (pick.held !== undefined) out.held = { version: pick.held.version, ageDays: pick.held.ageDays }
  return out
}

export function npmBins(prefix: string, name: string): Record<string, string> {
  const dir = join(prefix, 'node_modules', ...name.split('/'))
  let pkg: { bin?: unknown, name?: unknown }
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { bin?: unknown } } catch { return {} }
  const out: Record<string, string> = {}
  const bin = pkg.bin
  const base = typeof pkg.name === 'string' ? pkg.name.split('/').pop() ?? name : name.split('/').pop() ?? name
  if (typeof bin === 'string') out[base] = resolve(dir, bin)
  else if (bin !== null && typeof bin === 'object') {
    for (const [k, v] of Object.entries(bin as Record<string, unknown>)) if (typeof v === 'string') out[k] = resolve(dir, v)
  }
  return out
}

export function npmInstalledVersion(prefix: string, name: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(prefix, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch { return undefined }
}

function pickBins(prefix: string, name: string, wanted: readonly string[] | undefined): Record<string, string> {
  const all = npmBins(prefix, name)
  const bins: Record<string, string> = {}
  for (const b of wanted ?? Object.keys(all)) if (all[b] !== undefined) bins[b] = all[b] as string
  return bins
}

function removeDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }) } catch {  }
}

function prefixVersion(prefix: string, name: string): string | undefined {
  return existsSync(prefix) ? npmInstalledVersion(prefix, name) : undefined
}

export function swapPrefix(live: string, next: string, prev: string): void {
  removeDir(prev)
  const hadLive = existsSync(live)
  if (hadLive) renameSync(live, prev)
  try {
    renameSync(next, live)
  } catch (e) {
    if (hadLive && !existsSync(live)) {
      try { renameSync(prev, live) } catch {  }
    }
    throw e
  }
}

export async function installNpm(req: PackageRequest, version: string, nowIso: string, opts: { timeoutMs?: number } = {}): Promise<InstallOutcome | InstallFailure> {
  const npm = findExecutable('npm')
  if (npm === undefined) return { ok: false, error: 'npm is not installed (install Node.js first)' }
  const live = npmPrefix(req.name)
  const stage = npmStagingPrefix(req.name)
  try {
    rmSync(stage, { recursive: true, force: true })
    mkdirSync(stage, { recursive: true })
    const dependencies: Record<string, string> = { [req.name]: version }
    for (const w of req.with ?? []) {
      const at = w.lastIndexOf('@')
      if (at > 0) dependencies[w.slice(0, at)] = w.slice(at + 1)
      else dependencies[w] = 'latest'
    }
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: `buracle-toolchain-${safeName(req.name).toLowerCase()}`, private: true, dependencies }, null, 2) + '\n')
  } catch (e) {
    removeDir(stage)
    return { ok: false, error: `cannot prepare ${stage}: ${errText(e)}` }
  }
  const fail = (error: string): InstallFailure => { removeDir(stage); return { ok: false, error } }
  const argv = spawnArgv([npm, 'install', '--prefix', stage, '--no-audit', '--no-fund', '--omit=dev', '--loglevel=error', '--no-package-lock', ...(req.scripts === false ? ['--ignore-scripts'] : [])])
  const r = await opsDeps.run(argv, { cwd: stage, env: toolchainEnv(), timeoutMs: opts.timeoutMs ?? 300_000 })
  if (r.code !== 0) return fail(`npm install ${req.name}@${version} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`)
  const installed = npmInstalledVersion(stage, req.name)
  if (installed === undefined) return fail(`npm install ${req.name}@${version} finished but the package is not in ${stage}`)
  if (Object.keys(pickBins(stage, req.name, req.bins)).length === 0) return fail(`${req.name}@${installed} declares none of the expected executables (${(req.bins ?? []).join(', ') || 'any'})`)
  const before = prefixVersion(live, req.name)
  try {
    swapPrefix(live, stage, npmPreviousPrefix(req.name))
  } catch (e) {
    return fail(`cannot put ${req.name}@${installed} in place of ${live} (${errText(e)}); the copy that was there stays`)
  }
  const pkg: InstalledPackage = { registry: 'npm', name: req.name, version: installed, dir: live, bins: pickBins(live, req.name, req.bins), installed_at: nowIso }
  if (before !== undefined) pkg.previous = { version: before }
  return { ok: true, pkg }
}

export function pypiSpec(name: string, extras: readonly string[] | undefined, version: string): string {
  const ex = extras !== undefined && extras.length > 0 ? `[${extras.join(',')}]` : ''
  return version === 'latest' ? `${name}${ex}` : `${name}${ex}==${version}`
}

function uvBins(req: PackageRequest): Record<string, string> {
  const bins: Record<string, string> = {}
  for (const b of req.bins ?? [req.name]) {
    const p = join(uvBinDir(), exeName(b))
    if (existsSync(p)) bins[b] = p
  }
  return bins
}

export async function installPypi(req: PackageRequest, version: string, nowIso: string, opts: { timeoutMs?: number, before?: string } = {}): Promise<InstallOutcome | InstallFailure> {
  const uv = findExecutable('uv')
  if (uv === undefined) return { ok: false, error: 'uv is not installed' }
  mkdirSync(uvToolDir(), { recursive: true })
  mkdirSync(uvBinDir(), { recursive: true })
  const argv = [uv, 'tool', 'install', '--force', '--python', UV_PYTHON, pypiSpec(req.name, req.extras, version)]
  const r = await opsDeps.run(argv, { env: toolchainEnv(), timeoutMs: opts.timeoutMs ?? 600_000 })
  if (r.code !== 0) return { ok: false, error: `uv tool install ${pypiSpec(req.name, req.extras, version)} failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}` }
  const bins = uvBins(req)
  if (Object.keys(bins).length === 0) return { ok: false, error: `uv installed ${req.name} but none of its executables (${(req.bins ?? [req.name]).join(', ')}) is in ${uvBinDir()}` }
  const pkg: InstalledPackage = { registry: 'pypi', name: req.name, version: version === 'latest' ? await uvToolVersion(uv, req.name) ?? 'latest' : version, dir: join(uvToolDir(), req.name), bins, python: UV_PYTHON, installed_at: nowIso }
  if (req.extras !== undefined && req.extras.length > 0) pkg.extras = [...req.extras]
  if (opts.before !== undefined && opts.before !== pkg.version) pkg.previous = { version: opts.before }
  return { ok: true, pkg }
}

export function pypiStillThere(req: PackageRequest): boolean {
  return Object.keys(uvBins(req)).length > 0
}

export async function uvToolVersion(uv: string, name: string): Promise<string | undefined> {
  const r = await opsDeps.run([uv, 'tool', 'list'], { env: toolchainEnv(), timeoutMs: 30_000 })
  if (r.code !== 0) return undefined
  const line = r.stdout.split('\n').find(l => l.startsWith(`${name} `))
  return /\sv?(\d+\.\d+\.\d+[^\s]*)/.exec(line ?? '')?.[1]
}

export async function installPackage(req: PackageRequest, nowMs: number, opts: { minAgeDays?: number, timeoutMs?: number, before?: string } = {}): Promise<InstallOutcome | InstallFailure> {
  let version = req.version
  if (version === 'latest' || version === '') {
    const latest = await latestVersion(req.registry, req.name, nowMs, opts.minAgeDays ?? configuredMinAgeDays())
    if ('error' in latest) return { ok: false, error: latest.error }
    version = latest.version
  }
  const nowIso = new Date(nowMs).toISOString()
  const o: { timeoutMs?: number, before?: string } = {}
  if (opts.timeoutMs !== undefined) o.timeoutMs = opts.timeoutMs
  if (req.registry === 'npm') return installNpm(req, version, nowIso, o)
  if (opts.before !== undefined) o.before = opts.before
  return installPypi(req, version, nowIso, o)
}

export function isNodeScript(entry: string): boolean {
  if (/\.(c|m)?js$/i.test(entry)) return true
  try {
    const head = readFileSync(entry, { encoding: 'utf8' }).slice(0, 128)
    return /^#!.*\bnode\b/.test(head)
  } catch { return false }
}

export function binArgv(entry: string, runner: string | undefined = findExecutable('node')): string[] | undefined {
  if (!isAbsolute(entry) || !existsSync(entry)) return undefined
  if (isNodeScript(entry)) return runner !== undefined ? [runner, entry] : undefined
  return [entry]
}

export function bunBinary(): string | undefined {
  const own = process.execPath
  if (own !== '' && /^bun(?:\.exe)?$/i.test(basename(own))) return own
  return findExecutable('bun')
}

export function toolRequest(t: ToolSpec): PackageRequest | undefined {
  if (t.npm !== undefined) {
    const at = t.npm.lastIndexOf('@')
    const name = at > 0 ? t.npm.slice(0, at) : t.npm
    const req: PackageRequest = { registry: 'npm', name, version: at > 0 ? t.npm.slice(at + 1) : 'latest', bins: t.bins ?? [t.name] }
    if (t.npm_with !== undefined && t.npm_with.length > 0) req.with = [...t.npm_with]
    return req
  }
  if (t.pypi !== undefined) {
    const m = /^([A-Za-z0-9._-]+)(?:\[([A-Za-z0-9._,-]+)\])?(?:==(.+))?$/.exec(t.pypi)
    const req: PackageRequest = { registry: 'pypi', name: m?.[1] ?? t.pypi, version: m?.[3] ?? 'latest', bins: t.bins ?? [t.name] }
    if (m?.[2] !== undefined) req.extras = m[2].split(',')
    return req
  }
  return undefined
}

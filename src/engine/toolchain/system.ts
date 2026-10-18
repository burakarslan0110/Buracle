import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolSpec } from '../../core/catalog'
import { opsDeps } from '../update/deps'
import * as paths from '../paths'
import { exeName, findExecutable, osName, spawnArgv, type OsName } from '../platform'
import { installPackage, toolchainEnv, toolRequest } from './packages'
import type { InstalledPackage, InstalledSystemTool } from './state'

export interface ToolCheck { name: string; status: 'ok' | 'missing' | 'error'; version?: string; path?: string; detail: string }

export function toolApplies(t: ToolSpec, os: OsName = osName()): boolean {
  return t.platforms === undefined || t.platforms.includes(os)
}

export { toolchainBinDirs } from '../paths'

export async function checkTool(t: ToolSpec, timeoutMs = 8000): Promise<ToolCheck> {
  const [cmd, ...args] = t.check
  if (cmd === undefined) return { name: t.name, status: 'error', detail: 'empty check command' }
  const path = findExecutable(cmd, { extra: paths.toolchainBinDirs() })
  if (path === undefined) return { name: t.name, status: 'missing', detail: 'not found' }
  const r = await opsDeps.run(spawnArgv([path, ...args]), { timeoutMs })
  if (r.code === 127) return { name: t.name, status: 'missing', path, detail: 'not found' }
  const text = `${r.stdout}\n${r.stderr}`
  let version: string | undefined
  try { version = new RegExp(t.version_regex, 'm').exec(text)?.[1] } catch { version = undefined }
  if (r.code !== 0 && version === undefined) return { name: t.name, status: 'error', path, detail: `\`${t.check.join(' ')}\` exited ${r.code}${r.timedOut ? ' (timed out)' : ''}` }
  return version !== undefined ? { name: t.name, status: 'ok', version, path, detail: version } : { name: t.name, status: 'ok', path, detail: 'present (version not recognized)' }
}

export type SourceKind = 'brew' | 'winget' | 'scoop' | 'npm' | 'pypi' | 'go' | 'dotnet'

export interface InstallSource { kind: SourceKind; ref: string; label: string }

function missingRequirements(t: ToolSpec, have: (cmd: string) => boolean): string[] {
  return (t.requires ?? []).filter(c => !have(c))
}

export function installSources(t: ToolSpec, os: OsName = osName(), have: (cmd: string) => boolean = c => findExecutable(c) !== undefined): InstallSource[] {
  const out: InstallSource[] = []
  if (missingRequirements(t, have).length > 0) return out
  if (os !== 'win32' && t.brew !== undefined && have('brew')) out.push({ kind: 'brew', ref: t.brew, label: `brew install ${t.brew}` })
  if (os === 'win32' && t.winget !== undefined && have('winget')) out.push({ kind: 'winget', ref: t.winget, label: `winget install ${t.winget}` })
  if (os === 'win32' && t.scoop !== undefined && have('scoop')) out.push({ kind: 'scoop', ref: t.scoop, label: `scoop install ${t.scoop}` })
  if (t.npm !== undefined) out.push({ kind: 'npm', ref: t.npm, label: `npm ${t.npm} (Buracle toolchain)` })
  if (t.pypi !== undefined) out.push({ kind: 'pypi', ref: t.pypi, label: `uv tool ${t.pypi} (Buracle toolchain)` })
  if (t.go !== undefined && have('go')) out.push({ kind: 'go', ref: t.go, label: `go install ${t.go}@latest` })
  if (t.dotnet !== undefined && have('dotnet')) out.push({ kind: 'dotnet', ref: t.dotnet, label: `dotnet tool install ${t.dotnet} (Buracle toolchain)` })
  return out
}

export function installAdvice(t: ToolSpec, os: OsName = osName(), have: (cmd: string) => boolean = c => findExecutable(c) !== undefined): string {
  const needs = missingRequirements(t, have)
  if (needs.length > 0) return `${t.name} needs ${needs.join(' and ')} on PATH; install ${needs.length === 1 ? 'it' : 'them'} first, then run \`buracle install\``
  if (os === 'win32' && t.winget !== undefined) return `winget install --id ${t.winget} -e`
  if (os !== 'win32' && t.brew !== undefined) return `brew install ${t.brew}`
  if (t.npm !== undefined || t.pypi !== undefined) return 'buracle install (installs it into the Buracle toolchain)'
  if (t.install !== undefined) return t.install
  return 'install it with your package manager'
}

export interface SystemInstallResult {
  ok: boolean
  source?: InstallSource
  error?: string
  pkg?: InstalledPackage
  record?: InstalledSystemTool
}

export async function installTool(t: ToolSpec, nowMs: number, opts: { timeoutMs?: number, minAgeDays?: number } = {}): Promise<SystemInstallResult> {
  const sources = installSources(t)
  if (sources.length === 0) return { ok: false, error: `no installer for ${t.name} on this machine; ${installAdvice(t)}` }
  const nowIso = new Date(nowMs).toISOString()
  const errors: string[] = []
  for (const s of sources) {
    if (s.kind === 'npm' || s.kind === 'pypi') {
      const req = toolRequest(s.kind === 'npm' ? { ...t, pypi: undefined } as ToolSpec : { ...t, npm: undefined } as ToolSpec)
      if (req === undefined) continue
      const r = await installPackage(req, nowMs, { ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.minAgeDays !== undefined ? { minAgeDays: opts.minAgeDays } : {}) })
      if (r.ok) return { ok: true, source: s, pkg: r.pkg, record: { via: s.kind === 'npm' ? 'npm' : 'uv', version: r.pkg.version, installed_at: nowIso } }
      errors.push(r.error)
      continue
    }
    const r = await runInstaller(s, opts.timeoutMs ?? 900_000)
    if (r.ok) {
      const found = findExecutable(t.check[0] ?? t.name, { extra: paths.toolchainBinDirs() })
      const record: InstalledSystemTool = { via: s.kind, installed_at: nowIso }
      if (found !== undefined) record.path = found
      return { ok: true, source: s, record }
    }
    errors.push(r.error)
  }
  return { ok: false, error: errors.join('; ') }
}

async function runInstaller(s: InstallSource, timeoutMs: number): Promise<{ ok: true } | { ok: false, error: string }> {
  let argv: string[]
  const env = toolchainEnv()
  switch (s.kind) {
    case 'brew': argv = [findExecutable('brew') ?? 'brew', 'install', s.ref]; break
    case 'winget': argv = [findExecutable('winget') ?? 'winget', 'install', '--id', s.ref, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity']; break
    case 'scoop': argv = [findExecutable('scoop') ?? 'scoop', 'install', s.ref]; break
    case 'go': {
      const gobin = join(paths.toolchainDir(), 'go', 'bin')
      mkdirSync(gobin, { recursive: true })
      env['GOBIN'] = gobin
      argv = [findExecutable('go') ?? exeName('go'), 'install', `${s.ref}@latest`]
      break
    }
    case 'dotnet': {
      const toolPath = join(paths.toolchainDir(), 'dotnet', 'tools')
      mkdirSync(toolPath, { recursive: true })
      argv = [findExecutable('dotnet') ?? exeName('dotnet'), 'tool', 'install', '--tool-path', toolPath, s.ref]
      break
    }
    default: return { ok: false, error: `unsupported installer ${s.kind}` }
  }
  const r = await opsDeps.run(spawnArgv(argv), { env, timeoutMs })
  if (r.code === 0) return { ok: true }
  const text = `${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-3).join(' / ').slice(0, 300)
  return { ok: false, error: `${s.label} failed (exit ${r.code}${r.timedOut ? ', timed out' : ''})${text !== '' ? `: ${text}` : ''}` }
}

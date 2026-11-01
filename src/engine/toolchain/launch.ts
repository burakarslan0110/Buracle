import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { McpCatalog, McpServerSpec } from '../../core/catalog'
import { envRef, mcpPackageBin, validateMcpCatalog } from '../../core/catalog'
import * as paths from '../paths'
import { findExecutable } from '../platform'
import { binArgv, pypiSpec, toolchainEnv, UV_PYTHON } from './packages'
import { packageKey, type ToolchainState } from './state'

export interface LaunchPlan {
  argv: string[]
  env: Record<string, string>
  source: 'toolchain' | 'fallback'
  version?: string
}

export interface LaunchError { error: string }

export function readMcpCatalog(file: string = join(paths.canonicalDir(), 'mcp.yaml')): McpCatalog {
  const raw = parseYaml(readFileSync(file, 'utf8')) as unknown
  const problems = validateMcpCatalog(raw)
  if (problems.length > 0) throw new Error(`${file}: ${problems.slice(0, 3).join('; ')}`)
  return raw as McpCatalog
}

export function serverEnvFor(spec: McpServerSpec, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    const ref = envRef(v)
    if (ref === undefined) out[k] = v
    else if (env[ref] !== undefined) out[k] = env[ref] as string
  }
  return out
}

export function fallbackNpmCache(): string {
  return join(paths.buracleHome(), 'cache', 'npm')
}

export function launchPlan(id: string, spec: McpServerSpec, state: ToolchainState, opts: { node?: string, npx?: string, uvx?: string } = {}): LaunchPlan | LaunchError {
  const pkg = spec.package
  if (spec.transport !== 'stdio' || pkg === undefined || (pkg.registry !== 'npm' && pkg.registry !== 'pypi')) return { error: `${id} is not a package server` }
  const bin = mcpPackageBin(pkg)
  const args = spec.args ?? []
  const env = serverEnvFor(spec)
  const installed = state.packages[packageKey(pkg.registry, pkg.name)]
  const entry = installed?.bins[bin]
  if (installed !== undefined && entry !== undefined) {
    const run = binArgv(entry, opts.node ?? findExecutable('node', { extra: paths.toolchainBinDirs() }))
    if (run !== undefined) return { argv: [...run, ...args], env, source: 'toolchain', version: installed.version }
  }
  const version = pkg.version === '' ? 'latest' : pkg.version
  if (pkg.registry === 'npm') {
    const npx = opts.npx ?? findExecutable('npx', { extra: paths.toolchainBinDirs() })
    if (npx === undefined) return { error: `${id}: neither Buracle's toolchain nor npx can start ${pkg.name} (install Node.js, then run \`buracle install\`)` }
    return {
      argv: [npx, '--yes', `--package=${pkg.name}@${version}`, bin, ...args],
      env: { ...env, npm_config_cache: fallbackNpmCache(), npm_config_update_notifier: 'false', npm_config_fund: 'false' },
      source: 'fallback',
    }
  }
  const uvx = opts.uvx ?? findExecutable('uvx', { extra: paths.toolchainBinDirs() })
  if (uvx === undefined) return { error: `${id}: neither Buracle's toolchain nor uvx can start ${pkg.name} (install uv, then run \`buracle install\`)` }
  return {
    argv: [uvx, '--python', UV_PYTHON, '--from', pypiSpec(pkg.name, pkg.extras, version), bin, ...args],
    env: { ...env, UV_NO_PROGRESS: '1', UV_TOOL_DIR: toolchainEnv()['UV_TOOL_DIR'] as string },
    source: 'fallback',
  }
}

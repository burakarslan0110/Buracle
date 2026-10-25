import { join } from 'node:path'
import type { Adapter } from '../../adapters/registry'
import type { CanonicalBundle } from '../../core/catalog'
import type { PackageRollback, ToolchainOptions, ToolchainResult } from '../toolchain/index'
import type { RunOptions, RunResult } from '../proc'
import { run } from '../proc'
import * as paths from '../paths'
import { defaultFetch, type Fetcher } from './fetch'

export interface CliResult { code: number; stdout: string; stderr: string }

export interface OpsDeps {
  fetch: Fetcher
  run(argv: string[], opts?: RunOptions): Promise<RunResult>
  runCli(argv: string[]): Promise<CliResult>
  adapters(): Promise<Adapter[]>
  repoRoot(): string
  now(): number
  confirm(question: string): Promise<boolean>
  runToolchain(bundle: Pick<CanonicalBundle, 'mcp' | 'tools'>, opts: ToolchainOptions): Promise<ToolchainResult | undefined>
  // Puts back the version each named package held before its last install; undefined: the toolchain lock is taken.
  rollbackToolchain(keys: readonly string[]): Promise<PackageRollback[] | undefined>
}

async function toolchainRun(bundle: Pick<CanonicalBundle, 'mcp' | 'tools'>, opts: ToolchainOptions): Promise<ToolchainResult | undefined> {
  const t = await import('../toolchain/index')
  return opts.install ? t.withToolchainLock(opts.nowMs(), () => t.runToolchain(bundle, opts)) : t.runToolchain(bundle, opts)
}

async function toolchainRollback(keys: readonly string[]): Promise<PackageRollback[] | undefined> {
  const t = await import('../toolchain/index')
  const { readToolchainState } = await import('../toolchain/state')
  return t.withToolchainLock(Date.now(), () => t.rollbackPackages(t.rollbackCandidates(readToolchainState(), keys), Date.now()))
}

async function routerCall(argv: string[]): Promise<CliResult> {
  const main = join(import.meta.dir, '..', '..', 'cli', 'main.ts')
  const r = await run([process.execPath, main, ...argv], { timeoutMs: 300_000, cwd: paths.home() })
  return { code: r.code, stdout: r.stdout, stderr: r.stderr }
}

async function terminalConfirm(question: string): Promise<boolean> {
  const ask = (globalThis as { prompt?: (q: string) => string | null }).prompt
  if (typeof ask !== 'function') return false
  const answer = ask(`${question} [y/N]`)
  return answer !== null && /^(y|yes|e|evet)$/i.test(answer.trim())
}

export const defaultOpsDeps: Readonly<OpsDeps> = {
  fetch: defaultFetch,
  run,
  runCli: routerCall,
  adapters: async () => (await import('../../adapters/registry')).allAdapters(),
  repoRoot: () => paths.repoRoot(),
  now: () => Date.now(),
  confirm: terminalConfirm,
  runToolchain: toolchainRun,
  rollbackToolchain: toolchainRollback,
}

export const opsDeps: OpsDeps = { ...defaultOpsDeps }

import type { Harness } from '../core/events'
import { HARNESSES } from '../core/events'
import type { BuracleConfig } from '../core/config'
import type { CanonicalBundle } from '../core/catalog'
import type { Plan } from '../engine/txn'
import { adapter as claude } from './claude/index'
import { adapter as codex } from './codex/index'
import { adapter as opencode } from './opencode/index'
import { adapter as omp } from './omp/index'

export interface AdapterContext { repoRoot: string; config: BuracleConfig; canonical: CanonicalBundle; paths: typeof import('../engine/paths'); buracleBin: string }
export interface Adapter {
  harness: Harness
  detect(): Promise<{ installed: boolean, version?: string, path?: string }>
  build(ctx: AdapterContext): Promise<Array<{ path: string, content: string, mode?: number }>>
  installPlan(ctx: AdapterContext): Promise<Plan>
  doctor(ctx: AdapterContext): Promise<Array<{ level: 'ok'|'warn'|'error', check: string, detail: string }>>
  hook?(event: string, stdin: string, ctx: AdapterContext): Promise<{ stdout: string, exitCode: number }>
  uninstallPlan?(ctx: AdapterContext): Promise<Plan>
}

export interface HookFailure extends Error { hookResult: { stdout: string, exitCode: number } }

const ADAPTERS: Readonly<Record<Harness, Adapter>> = { claude, codex, opencode, omp }

export function getAdapter(h: Harness): Adapter {
  return ADAPTERS[h]
}

export function allAdapters(): Adapter[] {
  return HARNESSES.map(h => ADAPTERS[h])
}

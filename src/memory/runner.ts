import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Harness } from '../core/events'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import * as paths from '../engine/paths'
import { run } from '../engine/proc'
import { readTelemetry } from '../workflow/session-store'
import { runnerBackoffFile } from './layout'
import { tryLock } from './lock'
import { MEMORY_RUNNER_DIR_PREFIX } from './spawn'

export interface ModelCall {
  model?: string
  maxOutputTokens: number
  timeoutMs: number
}

export interface ModelAnswer { ok: boolean, text: string, error?: string, unavailable?: boolean }

export type ModelRunner = (prompt: string, opts: ModelCall) => Promise<ModelAnswer>

export const RUNNER_TIMEOUT_MS = 300_000

export const MEMORY_RUNNER_ENV = 'BURACLE_MEMORY_RUNNER'

export const RUNNER_CHILD_ENV: Readonly<Record<string, string>> = {
  BURACLE_NO_CAPTURE: '1', BURACLE_NO_MEMORY: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_NOTIFY: '1',
  BURACLE_NO_DISTILL: '1', [MEMORY_RUNNER_ENV]: '1',
}

export const OPENCODE_RUNNER_AGENT = 'buracle-memory-runner'
const OPENCODE_RUNNER_AGENT_FILE = [
  '---',
  'description: "Buracle\'s memory runner: answers one prompt with text only."',
  'mode: "primary"',
  'permissions:',
  '  - { action: "*", resource: "*", effect: "deny" }',
  '---',
  'Answer with text only. You have no tools.',
  '',
].join('\n')

export function runnerModelId(x: unknown): string | undefined {
  return typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@#+[\]-]{0,159}$/.test(x) ? x : undefined
}

export function sessionModel(h: Harness, sid: string): string | undefined {
  try { return runnerModelId(readTelemetry(h, sid)?.modelId) } catch { return undefined }
}

export function runnerArgv(h: Harness, model?: string): string[] {
  const m = runnerModelId(model)
  const withModel = m !== undefined ? ['--model', m] : []
  switch (h) {
    case 'claude': return ['claude', '-p', ...withModel, '--no-session-persistence', '--tools', '']
    case 'codex': return ['codex', 'exec', ...withModel, '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-']
    case 'opencode': return ['opencode', 'run', '--agent', OPENCODE_RUNNER_AGENT, ...withModel]
    case 'omp': return ['omp', '-p', ...withModel, '--no-session', '--no-tools', '--no-skills', '--no-rules', '--no-lsp', '--no-title']
  }
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

export const RUNNER_UNAVAILABLE_BACKOFF_MS = 6 * 3600_000
export const RUNNER_FAILED_BACKOFF_MS = 30 * 60_000
export const RUNNER_REFUSED_BACKOFF_MS = 7 * 86_400_000

type Backoff = Partial<Record<Harness, { until: number, why: string, model?: string }>>

function readBackoff(): Backoff {
  const r = readJsonSafeSync<Backoff>(runnerBackoffFile())
  return r.ok && r.value !== null && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value : {}
}

function withBackoffLock<T>(fn: () => T): T | undefined {
  const lock = `${runnerBackoffFile()}.lock`
  for (let attempt = 0; attempt < 40; attempt++) {
    const release = tryLock(lock, 5_000)
    if (release !== undefined) {
      try { return fn() } finally { release() }
    }
    Bun.sleepSync(5)
  }
  return undefined
}

function writeBackoff(h: Harness, until: number, why: string, model?: string): void {
  try {
    withBackoffLock(() => {
      const b = readBackoff()
      b[h] = { until, why: why.slice(0, 200), ...(model !== undefined ? { model } : {}) }
      atomicWriteSync(runnerBackoffFile(), JSON.stringify(b) + '\n', { mode: 0o600 })
    })
  } catch {  }
}

export function markRunnerUnavailable(h: Harness, nowMs: number, why: string): void {
  writeBackoff(h, nowMs + RUNNER_UNAVAILABLE_BACKOFF_MS, why)
}

export function markRunnerFailed(h: Harness, nowMs: number, why: string, forGood = false, model?: string): void {
  if (forGood) writeBackoff(h, nowMs + RUNNER_REFUSED_BACKOFF_MS, why, model ?? '')
  else writeBackoff(h, nowMs + RUNNER_FAILED_BACKOFF_MS, why)
}

export function runnerUnavailable(h: Harness, nowMs: number, opts: { which?: (bin: string) => string | null, model?: string } = {}): string | undefined {
  const b = readBackoff()[h]
  const sameModel = b?.model === undefined || opts.model === undefined || b.model === opts.model
  if (b !== undefined && typeof b.until === 'number' && nowMs < b.until && sameModel) return typeof b.why === 'string' ? b.why : `${h} is not on PATH`
  const bin = runnerArgv(h)[0] as string
  if ((opts.which ?? onPath)(bin) === null) {
    const why = `${bin} is not on PATH`
    markRunnerUnavailable(h, nowMs, why)
    return why
  }
  return undefined
}

const PERMANENT_REFUSALS: readonly RegExp[] = [
  /free tier can only be used from within opencode/i,
  /\b(unknown|invalid|unsupported) model\b/i,
  /\bmodel\b[^.\n]{0,60}\b(not found|does not exist|is not available|not supported)\b/i,
]

export function runnerRefusesForGood(error: string): boolean {
  return PERMANENT_REFUSALS.some(re => re.test(error))
}

function onPath(bin: string): string | null {
  return Bun.which(bin, { PATH: process.env['PATH'] ?? '' })
}

export function harnessRunner(h: Harness): ModelRunner {
  return async (prompt, opts) => {
    let scratch: string | undefined
    const bin = runnerArgv(h)[0] as string
    if (onPath(bin) === null) {
      markRunnerUnavailable(h, Date.now(), `${bin} is not on PATH`)
      return { ok: false, text: '', error: `${h}: ${bin} is not on PATH`, unavailable: true }
    }
    try {
      let cwd = paths.home()
      if (h === 'opencode') {
        scratch = mkdtempSync(join(tmpdir(), MEMORY_RUNNER_DIR_PREFIX))
        mkdirSync(join(scratch, '.opencode', 'agents'), { recursive: true })
        writeFileSync(join(scratch, '.opencode', 'agents', `${OPENCODE_RUNNER_AGENT}.md`), OPENCODE_RUNNER_AGENT_FILE)
        cwd = scratch
      }
      const r = await run(runnerArgv(h, opts.model), { stdin: prompt, timeoutMs: opts.timeoutMs, cwd, env: { ...RUNNER_CHILD_ENV, PWD: cwd } })
      if (r.code === 127 && /not found/i.test(r.stderr)) {
        markRunnerUnavailable(h, Date.now(), `${bin} is not on PATH`)
        return { ok: false, text: '', error: `${h}: ${bin} is not on PATH`, unavailable: true }
      }
      if (r.code !== 0) {
        const why = (r.stderr || r.stdout).replace(ANSI, '').trim().slice(0, 500)
        return { ok: false, text: '', error: r.timedOut ? `${h}: no answer within ${Math.round(opts.timeoutMs / 1000)} s` : `${h}: ${why || `exit ${r.code}`}` }
      }
      return { ok: true, text: r.stdout.replace(ANSI, '') }
    } catch (e) {
      return { ok: false, text: '', error: `${h}: ${e instanceof Error ? e.message : String(e)}` }
    } finally {
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true })
    }
  }
}

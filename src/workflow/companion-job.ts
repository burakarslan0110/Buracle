import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Harness } from '../core/events'
import type { ReviewRole } from '../core/plan/reviews'
import { REVIEWER_AGENT_ENV } from '../core/policy/companion-fence'
import type { ReviewReport } from '../core/policy/review'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import * as paths from '../engine/paths'
import { RUNNER_CHILD_ENV } from '../memory/runner'
import type { ResolvedSession } from './session-store'

export type CompanionState = 'running' | 'done' | 'failed' | 'cancelled' | 'unavailable'

export interface CompanionAttempt { harness: Harness, startedAt: number, endedAt?: number, error?: string }

export interface CompanionAnchor { fingerprint: string, base?: string, dir?: string, files?: string[] }

export interface CompanionJob {
  v: 1
  id: string
  role: ReviewRole
  agent: string
  caller: Harness
  session: string
  subject: string
  plan?: string
  repo: string
  targets: Harness[]
  timeoutMs: number
  startedAt: number
  deadline: number
  state: CompanionState
  attempts: CompanionAttempt[]
  anchor: CompanionAnchor
  runnerPid?: number
  childPid?: number
  report?: ReviewReport
  reportBy?: Harness
  repaired?: boolean
  error?: string
  collectedAt?: number
}

export interface CompanionRequest { inputs: string, diff?: { text: string, truncated: boolean } }

export const COMPANION_DROP_ENV: readonly string[] = [
  'BURACLE_SESSION_ID', 'BURACLE_HARNESS', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'OPENCODE_SESSION_ID', 'OMP_SESSION_ID',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', REVIEWER_AGENT_ENV,
]

export function companionDir(s: { harness: Harness, sessionId: string }, role: ReviewRole): string {
  return join(paths.sessionDir(s.harness, s.sessionId), 'companion', role)
}

export function jobFile(s: { harness: Harness, sessionId: string }, role: ReviewRole): string {
  return join(companionDir(s, role), 'job.json')
}

export function requestFile(jobPath: string): string {
  return join(jobPath, '..', 'request.json')
}

export function insideSessions(file: string): boolean {
  const rel = relative(paths.sessionsDir(), resolve(file))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && rel.endsWith('job.json')
}

function isJob(x: unknown): x is CompanionJob {
  if (x === null || typeof x !== 'object') return false
  const j = x as Record<string, unknown>
  return j['v'] === 1 && typeof j['id'] === 'string' && typeof j['role'] === 'string' && typeof j['state'] === 'string' && Array.isArray(j['targets']) && Array.isArray(j['attempts'])
}

export function readJobAt(file: string): CompanionJob | undefined {
  const r = readJsonSafeSync<unknown>(file)
  return r.ok && isJob(r.value) ? r.value : undefined
}

export function readJob(s: ResolvedSession, role: ReviewRole): CompanionJob | undefined {
  return readJobAt(jobFile(s, role))
}

export function writeJobAt(file: string, job: CompanionJob): void {
  mkdirSync(join(file, '..'), { recursive: true })
  atomicWriteSync(file, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 })
}

export function readRequest(jobPath: string): CompanionRequest | undefined {
  const r = readJsonSafeSync<CompanionRequest>(requestFile(jobPath))
  return r.ok && r.value !== null && typeof r.value === 'object' && typeof r.value.inputs === 'string' ? r.value : undefined
}

export function writeRequest(jobPath: string, req: CompanionRequest): void {
  mkdirSync(join(jobPath, '..'), { recursive: true })
  atomicWriteSync(requestFile(jobPath), JSON.stringify(req) + '\n', { mode: 0o600 })
}

export function alive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

export function killTree(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return
  for (const target of process.platform === 'win32' ? [pid] : [-pid, pid]) {
    try { process.kill(target, 'SIGTERM') } catch {  }
  }
}

export function childEnv(cwd?: string, agent?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !COMPANION_DROP_ENV.includes(k)) env[k] = v
  Object.assign(env, RUNNER_CHILD_ENV)
  if (cwd !== undefined) env['PWD'] = cwd
  if (agent !== undefined) env[REVIEWER_AGENT_ENV] = agent
  return env
}

export interface ChildResult { code: number, stdout: string, stderr: string, timedOut: boolean }

const OUTPUT_MAX = 4_000_000

async function drain(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (stream === null || stream === undefined) return ''
  const dec = new TextDecoder()
  let acc = ''
  try {
    for await (const chunk of stream) {
      if (acc.length < OUTPUT_MAX) acc += dec.decode(chunk, { stream: true })
    }
    acc += dec.decode()
  } catch {  }
  return acc.length > OUTPUT_MAX ? acc.slice(-OUTPUT_MAX) : acc
}

export async function runChild(argv: string[], o: { cwd: string, stdin: string, env: Record<string, string>, timeoutMs: number, onPid?: (pid: number) => void }): Promise<ChildResult> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(argv, { cwd: o.cwd, env: { ...o.env }, stdin: new TextEncoder().encode(o.stdin), stdout: 'pipe', stderr: 'pipe', detached: process.platform !== 'win32' })
  } catch (e) {
    return { code: 127, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false }
  }
  o.onPid?.(proc.pid)
  let timedOut = false
  let hard: ReturnType<typeof setTimeout> | undefined
  const timer = setTimeout(() => {
    timedOut = true
    killTree(proc.pid)
    hard = setTimeout(() => {
      for (const t of process.platform === 'win32' ? [proc.pid] : [-proc.pid, proc.pid]) { try { process.kill(t, 'SIGKILL') } catch {  } }
    }, 5_000)
  }, Math.max(1_000, o.timeoutMs))
  const [stdout, stderr, code] = await Promise.all([drain(proc.stdout as ReadableStream<Uint8Array>), drain(proc.stderr as ReadableStream<Uint8Array>), proc.exited])
  clearTimeout(timer)
  if (hard !== undefined) clearTimeout(hard)
  return { code: typeof code === 'number' ? code : 1, stdout, stderr, timedOut }
}

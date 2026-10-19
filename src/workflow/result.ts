import { statSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import type { Harness } from '../core/events'
import { resolveSession, type ResolvedSession } from './session-store'

export type ExitCode = 0 | 1 | 2

export interface CmdResult {
  code: ExitCode
  data: Record<string, unknown>
  lines: string[]
  errors: string[]
}

export interface WorkflowCtx {
  cwd: string
  now: number
  env: Record<string, string | undefined>
  cwdGone?: string
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

export function currentDir(env: Record<string, string | undefined> = process.env): { cwd: string, gone?: string } {
  try { return { cwd: process.cwd() } } catch {  }
  const pwd = env['PWD']
  const start = typeof pwd === 'string' && isAbsolute(pwd) ? normalize(pwd) : undefined
  let dir = start ?? (typeof env['HOME'] === 'string' && isAbsolute(env['HOME']) ? env['HOME'] : '/')
  while (!isDir(dir)) {
    const parent = dirname(dir)
    if (parent === dir) { dir = '/'; break }
    dir = parent
  }
  try { process.chdir(dir) } catch {  }
  return { cwd: dir, gone: start ?? '(unknown)' }
}

export function processCtx(): WorkflowCtx {
  const here = currentDir(process.env)
  const ctx: WorkflowCtx = { cwd: here.cwd, now: Date.now(), env: process.env }
  if (here.gone !== undefined) ctx.cwdGone = here.gone
  return ctx
}

export function warnCwdGone(io: { stderr: Writer }, prefix: string, ctx: WorkflowCtx): void {
  if (ctx.cwdGone === undefined) return
  io.stderr.write(`${prefix}: warning: the current directory ${ctx.cwdGone} no longer exists (removed, e.g. by 'buracle worktree cleanup' run from inside it); running from ${ctx.cwd}. cd to the main checkout before the next command.\n`)
}

export function ok(data: Record<string, unknown>, lines: string[], warnings: string[] = []): CmdResult {
  return { code: 0, data, lines, errors: warnings.map(w => `warning: ${w}`) }
}

export function partial(data: Record<string, unknown>, lines: string[], errors: string[]): CmdResult {
  return { code: 2, data, lines, errors }
}

export function fail(error: string, message: string, extra: Record<string, unknown> = {}): CmdResult {
  return { code: 1, data: { ok: false, error, message, ...extra }, lines: [], errors: [message] }
}

export interface Writer { write(chunk: string): void }

export function emit(io: { stdout: Writer, stderr: Writer }, json: boolean, prefix: string, r: CmdResult): number {
  if (json) io.stdout.write(JSON.stringify(r.data, null, 2) + '\n')
  else if (r.lines.length > 0) io.stdout.write(r.lines.join('\n') + '\n')
  for (const e of r.errors) io.stderr.write(`${prefix}: ${e}\n`)
  return r.code
}

export function usageError(usage: string, problems: string[]): CmdResult {
  const msg = problems.join('; ')
  return { code: 1, data: { ok: false, error: 'usage', message: msg }, lines: [], errors: [msg, usage.split('\n')[0] ?? usage] }
}

export const NO_SESSION_HINT =
  'no session: no harness session id was found. Buracle reads it from --session <id> (with --harness <h>), or from ' +
  'BURACLE_SESSION_ID with BURACLE_HARNESS, CLAUDE_CODE_SESSION_ID, CODEX_SESSION_ID/CODEX_THREAD_ID, OPENCODE_SESSION_ID or OMP_SESSION_ID; ' +
  'when several harnesses set them (one started from the shell of another), only the ids of the nearest harness process count. ' +
  "Without a session the stop guard is not protecting this run; continue from the plan file and run 'buracle doctor' to check the harness integration."

export function needSession(flags: { session?: string, harness?: string }, env: Record<string, string | undefined>): ResolvedSession | CmdResult {
  const s = resolveSession(flags, env)
  if (s !== undefined) return s
  let detail = NO_SESSION_HINT
  if (flags.session !== undefined) detail = `invalid or unusable session '${flags.session}' (ids match [A-Za-z0-9._:-], 1-128 chars; pass --harness or BURACLE_HARNESS when the harness cannot be inferred). ` + NO_SESSION_HINT
  return { code: 2, data: { ok: false, error: 'no_session', message: detail }, lines: [], errors: [detail] }
}

export function isResult(x: unknown): x is CmdResult {
  return x !== null && typeof x === 'object' && 'code' in x && 'data' in x && 'lines' in x
}

export function optionalSession(flags: { session?: string, harness?: string }, env: Record<string, string | undefined>): ResolvedSession | undefined {
  return resolveSession(flags, env)
}

export function sessionJson(s: ResolvedSession): { harness: Harness, id: string, source: string } {
  return { harness: s.harness, id: s.sessionId, source: s.source }
}

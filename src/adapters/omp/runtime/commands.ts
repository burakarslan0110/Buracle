import { brainPageArg } from '../../../core/plan/notes'
import type { OmpContext, OmpEphemeralTurnResult, OmpExtensionAPI } from './types'
import { clip } from './util'

export const OMP_REMEMBER_COMMAND = 'remember'
export const OMP_BRAIN_COMMAND = 'brain'
export const OMP_ASIDE_COMMAND = 'aside'
export const OMP_STATUS_COMMAND = 'buracle-status'
export const OMP_STATUS_ALIAS = 'buracle'
export const OMP_PING_COMMAND = 'buracle-ping'
export const OMP_UTILITY_COMMANDS: readonly string[] = [OMP_REMEMBER_COMMAND, OMP_BRAIN_COMMAND, OMP_ASIDE_COMMAND, OMP_STATUS_COMMAND, OMP_STATUS_ALIAS, OMP_PING_COMMAND]

export const OMP_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  'settings', 'security', 'providers', 'setup', 'plan', 'plan-review', 'vibe', 'goal', 'guided-goal', 'loop', 'queue', 'model',
  'models', 'switch', 'fast', 'slow', 'skillful', 'extended-context', 'computer', 'ratchet', 'prewalk', 'modelpreset', 'effort',
  'advisor', 'export', 'trace', 'dump', 'share', 'collab', 'join', 'leave', 'browser', 'copy', 'open', 'todo', 'session', 'jobs',
  'usage', 'stats', 'changelog', 'hotkeys', 'tools', 'context', 'extensions', 'agents', 'git', 'hub', 'branch', 'fork', 'tree',
  'login', 'logout', 'mcp', 'status', 'rewind', 'ssh', 'new', 'fresh', 'clear', 'delete', 'compact', 'shake', 'handoff', 'resume',
  'pin', 'btw', 'tan', 'omfg', 'cleanse', 'retry', 'debug', 'memory', 'rename', 'move', 'wt', 'worktree', 'add-dir', 'remove-dir',
  'dirs', 'exit', 'restart', 'marketplace', 'plugins', 'plugin', 'reload-plugins', 'skills', 'force', 'live', 'record', 'pause',
  'quit', 'q',
])

export type StatusView = 'status' | 'memory' | 'plan' | 'flow'
export const STATUS_USAGE = `Usage: /${OMP_STATUS_COMMAND} [status|memory|plan|flow]`

export function statusViewOf(args: string): StatusView | undefined {
  const what = (args ?? '').trim().toLowerCase()
  if (what === '' || what === 'status') return 'status'
  if (what === 'memory' || what === 'mem') return 'memory'
  if (what === 'plan' || what === 'flow') return what
  return undefined
}

export interface CommandHost {
  cli(): string[] | undefined
  run(argv: string[], opts: { cwd?: string, timeoutMs?: number }): Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>
  status(view: StatusView, ctx: OmpContext): Promise<string[]>
  pane?(view: 'memory' | 'plan', ctx: OmpContext): Promise<boolean>
  report(what: string, e: unknown): void
}

function notify(ctx: OmpContext, text: string, type: 'info' | 'warning' | 'error'): void {
  ctx.ui?.notify?.(text, type)
}

function jsonOf(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text.trim()) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function failure(what: string, r: { code: number, stdout: string, stderr: string, timedOut: boolean }): string {
  const why = r.timedOut ? ' (timed out)' : ''
  const err = (jsonOf(r.stdout)?.['message'] as string | undefined) ?? r.stderr.trim()
  return `${what} failed (exit ${r.code})${why}${err ? `: ${clip(err.trim(), 300)}` : ''}`
}

const NO_CLI = 'The buracle CLI was not found; run `buracle install`'

async function remember(host: CommandHost, args: string, ctx: OmpContext): Promise<void> {
  const text = (args ?? '').trim()
  if (text === '') { notify(ctx, `Usage: /${OMP_REMEMBER_COMMAND} <text>`, 'warning'); return }
  const cli = host.cli()
  if (cli === undefined) { notify(ctx, NO_CLI, 'error'); return }
  const r = await host.run([...cli, 'mem', 'remember', '--json', '--', text], { cwd: ctx.cwd, timeoutMs: 15_000 })
  if (r.code !== 0) { notify(ctx, failure('buracle mem remember', r), 'error'); return }
  const id = jsonOf(r.stdout)?.['id']
  notify(ctx, `Remembered${typeof id === 'string' && id !== '' ? `: ${clip(id, 200)}` : ''}`, 'info')
}

async function brain(host: CommandHost, args: string, ctx: OmpContext): Promise<void> {
  const page = brainPageArg(args ?? '')
  if (page === undefined) { notify(ctx, `Usage: /${OMP_BRAIN_COMMAND} [review]`, 'warning'); return }
  const cli = host.cli()
  if (cli === undefined) { notify(ctx, NO_CLI, 'error'); return }
  const r = await host.run([...cli, 'mem', 'ui', '--open', ...(page === 'review' ? ['--page', 'review'] : []), '--json'], { cwd: ctx.cwd, timeoutMs: 30_000 })
  const out = jsonOf(r.stdout)
  const url = page === 'review' ? out?.['page'] : out?.['url']
  if (r.code === 0 && typeof url === 'string' && url !== '') {
    notify(ctx, `${page === 'review' ? 'Review page' : 'Memory UI'}: ${url}${out?.['started'] === true ? ' (started)' : ''}${out?.['opened'] === true ? ' · opened in the browser' : ''}`, 'info')
    return
  }
  notify(ctx, failure('buracle mem ui', r), 'error')
}

export const PING_ANSWER = 'buracle: pong'

export const ASIDE_USAGE = `Usage: /${OMP_ASIDE_COMMAND} <question>`
export const ASIDE_TIMEOUT_MS = 120_000

export function asidePrompt(question: string): string {
  return `Answer briefly, from this conversation alone, without changing anything: ${question}`
}

function toolOptOutRefused(e: unknown): boolean {
  return /\btools: false\b/.test(e instanceof Error ? e.message : String(e))
}

function errorText(e: unknown): string {
  return clip((e instanceof Error ? e.message : String(e)).trim() || 'unknown error', 300)
}

async function aside(args: string, ctx: OmpContext): Promise<void> {
  const question = (args ?? '').trim()
  if (question === '') { notify(ctx, ASIDE_USAGE, 'warning'); return }
  const run = ctx.runEphemeralTurn
  if (typeof run !== 'function') { notify(ctx, 'aside: this omp has no side-turn API (omp 18.3 or later); use /btw <question>', 'warning'); return }
  const promptText = asidePrompt(question)
  const signal = AbortSignal.timeout(ASIDE_TIMEOUT_MS)
  let r: OmpEphemeralTurnResult
  try {
    try {
      r = await run.call(ctx, { promptText, tools: false, signal })
    } catch (e) {
      if (!toolOptOutRefused(e)) throw e
      r = await run.call(ctx, { promptText, signal })
    }
  } catch (e) {
    notify(ctx, `aside: ${errorText(e)}`, 'error')
    return
  }
  const answer = typeof r?.replyText === 'string' ? r.replyText.trim() : ''
  notify(ctx, answer !== '' ? `aside: ${answer}` : 'aside: no answer', answer !== '' ? 'info' : 'warning')
}

export function registerUtilityCommands(pi: OmpExtensionAPI, host: CommandHost): void {
  const safe = (name: string, fn: (args: string, ctx: OmpContext) => Promise<void>) => async (args: string, ctx: OmpContext): Promise<void> => {
    try {
      await fn(args, ctx)
    } catch (e) {
      host.report(`/${name}`, e)
      try { notify(ctx, `/${name} failed; see ~/.buracle/logs/buracle.log`, 'error') } catch {  }
    }
  }
  const status = async (args: string, ctx: OmpContext): Promise<void> => {
    const view = statusViewOf(args)
    if (view === undefined) { notify(ctx, STATUS_USAGE, 'warning'); return }
    if ((view === 'memory' || view === 'plan') && host.pane !== undefined && await host.pane(view, ctx)) return
    const lines = await host.status(view, ctx)
    notify(ctx, lines.join('\n'), 'info')
  }
  pi.registerCommand(OMP_REMEMBER_COMMAND, {
    description: 'Save a note to the Buracle memory inbox (no model turn)',
    handler: safe(OMP_REMEMBER_COMMAND, (args, ctx) => remember(host, args, ctx)),
  })
  pi.registerCommand(OMP_BRAIN_COMMAND, {
    description: 'Open the Buracle memory web UI (starts it when it is not running); /brain review opens the plan and change review page',
    handler: safe(OMP_BRAIN_COMMAND, (args, ctx) => brain(host, args, ctx)),
  })
  pi.registerCommand(OMP_ASIDE_COMMAND, {
    description: 'Ask a side question without touching the session (read-only)',
    handler: safe(OMP_ASIDE_COMMAND, aside),
  })
  pi.registerCommand(OMP_STATUS_COMMAND, {
    description: 'Buracle status: status, memory, plan or flow',
    handler: safe(OMP_STATUS_COMMAND, status),
  })
  pi.registerCommand(OMP_STATUS_ALIAS, {
    description: `Buracle status (alias of /${OMP_STATUS_COMMAND})`,
    handler: safe(OMP_STATUS_ALIAS, status),
  })
  pi.registerCommand(OMP_PING_COMMAND, {
    description: 'Buracle: liveness check (no model call)',
    handler: safe(OMP_PING_COMMAND, async (_args, ctx) => { notify(ctx, PING_ANSWER, 'info') }),
  })
}

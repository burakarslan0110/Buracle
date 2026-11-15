import { brainPageArg } from '../../../core/plan/notes'
import { clip } from '../../shared/pi-family/util'
import type { PiContext, PiExtensionAPI } from './types'

export const PI_REMEMBER_COMMAND = 'remember'
export const PI_BRAIN_COMMAND = 'brain'
export const PI_UTILITY_COMMANDS: readonly string[] = [PI_REMEMBER_COMMAND, PI_BRAIN_COMMAND]

type Run = { code: number, stdout: string, stderr: string, timedOut: boolean }

/** What the commands take from outside: the Buracle CLI and a way to run it. */
export interface PiCommandHost {
  cli(): string[] | undefined
  run(argv: string[], opts: { cwd?: string, timeoutMs?: number }): Promise<Run>
  report(what: string, e: unknown): void
}

const NO_CLI = 'The buracle CLI was not found; run `buracle install`'

function jsonOf(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text.trim()) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function failure(what: string, r: Run): string {
  const err = (jsonOf(r.stdout)?.['message'] as string | undefined) ?? r.stderr.trim()
  return `${what} failed (exit ${r.code})${r.timedOut ? ' (timed out)' : ''}${err ? `: ${clip(err.trim(), 300)}` : ''}`
}

async function remember(host: PiCommandHost, args: string, ctx: PiContext): Promise<void> {
  const text = (args ?? '').trim()
  if (text === '') { ctx.ui.notify(`Usage: /${PI_REMEMBER_COMMAND} <text>`, 'warning'); return }
  const cli = host.cli()
  if (cli === undefined) { ctx.ui.notify(NO_CLI, 'error'); return }
  const r = await host.run([...cli, 'mem', 'remember', '--json', '--', text], { cwd: ctx.cwd, timeoutMs: 15_000 })
  if (r.code !== 0) { ctx.ui.notify(failure('buracle mem remember', r), 'error'); return }
  const id = jsonOf(r.stdout)?.['id']
  ctx.ui.notify(`Remembered${typeof id === 'string' && id !== '' ? `: ${clip(id, 200)}` : ''}`, 'info')
}

async function brain(host: PiCommandHost, args: string, ctx: PiContext): Promise<void> {
  const page = brainPageArg(args ?? '')
  if (page === undefined) { ctx.ui.notify(`Usage: /${PI_BRAIN_COMMAND} [review]`, 'warning'); return }
  const cli = host.cli()
  if (cli === undefined) { ctx.ui.notify(NO_CLI, 'error'); return }
  const r = await host.run([...cli, 'mem', 'ui', '--open', ...(page === 'review' ? ['--page', 'review'] : []), '--json'], { cwd: ctx.cwd, timeoutMs: 30_000 })
  const out = jsonOf(r.stdout)
  const url = page === 'review' ? out?.['page'] : out?.['url']
  if (r.code === 0 && typeof url === 'string' && url !== '') {
    ctx.ui.notify(`${page === 'review' ? 'Review page' : 'Memory UI'}: ${url}${out?.['started'] === true ? ' (started)' : ''}${out?.['opened'] === true ? ' · opened in the browser' : ''}`, 'info')
    return
  }
  ctx.ui.notify(failure('buracle mem ui', r), 'error')
}

/**
 * Registers `/remember <text>` (a memory note) and `/brain [review]` (the Buracle Console). They run in the extension
 * without a model turn. A host without `registerCommand` gets none; a handler that throws is reported, never raised.
 */
export function registerPiCommands(pi: PiExtensionAPI, host: PiCommandHost): boolean {
  if (typeof pi.registerCommand !== 'function') return false
  const guard = (what: string, fn: (args: string, ctx: PiContext) => Promise<void>) => async (args: string, ctx: PiContext): Promise<void> => {
    try { await fn(args, ctx) } catch (e) { host.report(what, e) }
  }
  pi.registerCommand(PI_REMEMBER_COMMAND, { description: 'Save a note to the Buracle memory: /remember <text>', handler: guard('/remember', (a, c) => remember(host, a, c)) })
  pi.registerCommand(PI_BRAIN_COMMAND, { description: 'Open the Buracle Console: /brain [review]', handler: guard('/brain', (a, c) => brain(host, a, c)) })
  return true
}

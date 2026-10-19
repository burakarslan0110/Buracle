import type { CommandIO } from '../router'
import { boolFlag, parseCommandArgs, strFlag } from '../../workflow/args'
import { NOTIFY_TYPES, notify } from '../../workflow/notify'
import { NOTIFY_LIST_LIMIT, notifyList, notifyRead } from '../../workflow/notify-inbox'
import { emit, optionalSession, processCtx, usageError, warnCwdGone, type WorkflowCtx } from '../../workflow/result'

export const name = 'notify'
export const summary = 'Send a desktop notification and record it; list and mark the recorded ones'
export const usage = `Usage: buracle notify <type> "<title>" "<message>" [--plan <path>] [--json]
       buracle notify list [--unread] [--limit <n>] [--json]
       buracle notify read <id>… | --all [--json]

  <type>  ${NOTIFY_TYPES.join(' | ')}

Shows a desktop notification (skipped when BURACLE_NO_NOTIFY=1) and appends the notification, with
an id, to ~/.buracle/state/notifications.jsonl. A notification is not memory: nothing goes into the
brain. Best effort: a delivery failure is reported as a warning and never fails the command once the
record is written.

  list    the recorded notifications, newest first (default ${NOTIFY_LIST_LIMIT}); * marks an unread one
  read    mark notifications read (the brain web UI's bell shows the same list and the same marks;
          ~/.buracle/state/notifications-read.json keeps them)`

function runInbox(argv: string[], io: CommandIO, ctx: WorkflowCtx): number {
  const parsed = parseCommandArgs(argv, { unread: 'bool', limit: 'string', all: 'bool' })
  const [sub, ...rest] = parsed.positional
  const prefix = `buracle notify ${sub ?? ''}`.trimEnd()
  const problems = [...parsed.errors]
  if (sub === 'list') {
    if (rest.length > 0) problems.push(`unexpected argument '${rest[0]}'`)
    if (parsed.flags['all'] !== undefined) problems.push('--all applies to \'notify read\' only')
    const raw = strFlag(parsed.flags, 'limit')
    const limit = raw === undefined ? undefined : /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) problems.push('--limit must be a whole number from 1 to 500')
    if (problems.length > 0) return emit(io, io.flags.json, prefix, usageError(usage, problems))
    return emit(io, io.flags.json, prefix, notifyList({ unread: boolFlag(parsed.flags, 'unread'), ...(limit !== undefined ? { limit } : {}) }, ctx))
  }
  if (parsed.flags['unread'] !== undefined || parsed.flags['limit'] !== undefined) problems.push('--unread and --limit apply to \'notify list\' only')
  if (problems.length > 0) return emit(io, io.flags.json, prefix, usageError(usage, problems))
  return emit(io, io.flags.json, prefix, notifyRead(rest, boolFlag(parsed.flags, 'all')))
}

export async function runNotify(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const first = argv.find(a => !a.startsWith('-'))
  if (first === 'list' || first === 'read') return runInbox(argv, io, ctx)
  const parsed = parseCommandArgs(argv, { plan: 'string', session: 'string', harness: 'string' })
  const problems = [...parsed.errors]
  if (parsed.positional.length > 3) problems.push(`unexpected argument '${parsed.positional[3]}' (quote the title and the message)`)
  if (problems.length > 0) return emit(io, io.flags.json, 'buracle notify', usageError(usage, problems))
  const [type, title, message] = parsed.positional
  const sflags: { session?: string, harness?: string } = {}
  const sid = strFlag(parsed.flags, 'session')
  const h = strFlag(parsed.flags, 'harness')
  if (sid !== undefined) sflags.session = sid
  if (h !== undefined) sflags.harness = h
  const plan = strFlag(parsed.flags, 'plan')
  const r = await notify(type, title, message, plan !== undefined ? { plan } : {}, ctx, optionalSession(sflags, ctx.env))
  return emit(io, io.flags.json, 'buracle notify', r)
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, 'buracle notify', ctx)
  return runNotify(argv, io, ctx)
}

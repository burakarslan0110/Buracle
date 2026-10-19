import { FLOW_CATALOG, FLOW_WORKFLOWS } from '../../core/flow/catalog'
import { parseCommandArgs, strFlag, type FlagKind } from '../../workflow/args'
import { flowEndCmd, flowPhaseCmd, flowStartCmd, flowStatusCmd, flowStepCmd } from '../../workflow/flow'
import { emit, isResult, needSession, optionalSession, processCtx, usageError, warnCwdGone, type CmdResult, type WorkflowCtx } from '../../workflow/result'
import type { CommandIO } from '../router'

export const name = 'flow'
export const summary = 'Record and show the progress of a running workflow (start, phase, step, end)'
export const usage = `Usage: buracle flow start <workflow> [--title "<t>"] [--json]
       buracle flow phase <phase> [--note "<text>"] [--json]
       buracle flow step "<text>" [--done <n>] [--total <m>] [--json]
       buracle flow end [--outcome done|failed|cancelled] [--json]
       buracle flow status [--json]

  start   the workflow begins (idempotent while it is the one running; a workflow the
          person starts begins a new run, one a skill loads inside another nests:
          requirements > research)
  phase   the running workflow enters a phase (a catalogued workflow takes only its
          own phase ids, below; any other workflow takes any kebab-case id)
  step    what it is doing now, with an optional count (--done 2 --total 5)
  end     the running workflow ended (default outcome: done)
  status  the record and the live view; exit 0 without a session (--json: nulls)

Phases of the catalogued workflows:
${FLOW_WORKFLOWS.map(id => `  ${id.padEnd(13)} ${(FLOW_CATALOG[id]?.phases ?? []).map(p => p.id).join(' ')}`).join('\n')}

Session (every subcommand): --session <id> wins (harness from --harness or the environment);
otherwise the ids each harness sets, as for 'buracle plan'. The writers exit 2 without a
session. The record: ~/.buracle/sessions/<harness>/<session>/flow.json.

Exit codes: 0 ok · 1 error (usage, nothing running for phase/step) · 2 no session.`

const SESSION: Record<string, FlagKind> = { session: 'string', harness: 'string' }
const SPECS: Record<string, Record<string, FlagKind>> = {
  start: { title: 'string', ...SESSION },
  phase: { note: 'string', ...SESSION },
  step: { done: 'string', total: 'string', ...SESSION },
  end: { outcome: 'string', ...SESSION },
  status: SESSION,
}
const ALL: Record<string, FlagKind> = Object.assign({}, ...Object.values(SPECS)) as Record<string, FlagKind>

export async function runFlow(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const parsed = parseCommandArgs(argv, ALL)
  const [sub, ...pos] = parsed.positional
  const out = (r: CmdResult) => emit(io, io.flags.json, `buracle flow${sub !== undefined ? ` ${sub}` : ''}`, r)
  if (sub === undefined) return out(usageError(usage, ['missing subcommand']))
  const spec = SPECS[sub]
  if (spec === undefined) return out(usageError(usage, [`unknown subcommand '${sub}'`]))
  const problems = [...parsed.errors]
  for (const f of Object.keys(parsed.flags)) if (spec[f] === undefined) problems.push(`--${f} does not apply to 'flow ${sub}'`)
  const maxPos = sub === 'start' || sub === 'phase' ? 1 : sub === 'step' ? Infinity : 0
  if (pos.length > maxPos) problems.push(`unexpected argument '${pos[maxPos as number] ?? ''}'`)
  if (problems.length > 0) return out(usageError(usage, problems))
  const flags = parsed.flags
  const sflags: { session?: string, harness?: string } = {}
  const sid = strFlag(flags, 'session')
  const h = strFlag(flags, 'harness')
  if (sid !== undefined) sflags.session = sid
  if (h !== undefined) sflags.harness = h

  if (sub === 'status') return out(flowStatusCmd(ctx, optionalSession(sflags, ctx.env)))
  const s = needSession(sflags, ctx.env)
  if (isResult(s)) return out(s)
  switch (sub) {
    case 'start': {
      const o: { workflow?: string, title?: string } = {}
      if (pos[0] !== undefined) o.workflow = pos[0]
      const title = strFlag(flags, 'title')
      if (title !== undefined) o.title = title
      return out(flowStartCmd(o, ctx, s))
    }
    case 'phase': {
      const o: { phase?: string, note?: string } = {}
      if (pos[0] !== undefined) o.phase = pos[0]
      const note = strFlag(flags, 'note')
      if (note !== undefined) o.note = note
      return out(flowPhaseCmd(o, ctx, s))
    }
    case 'step': {
      const o: { text?: string, done?: string, total?: string } = { text: pos.join(' ') }
      const done = strFlag(flags, 'done')
      const total = strFlag(flags, 'total')
      if (done !== undefined) o.done = done
      if (total !== undefined) o.total = total
      return out(flowStepCmd(o, ctx, s))
    }
    default: {
      const outcome = strFlag(flags, 'outcome')
      return out(flowEndCmd(outcome !== undefined ? { outcome } : {}, ctx, s))
    }
  }
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, 'buracle flow', ctx)
  return runFlow(argv, io, ctx)
}

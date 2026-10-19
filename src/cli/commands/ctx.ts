import { isAbsolute, resolve } from 'node:path'
import { cmParseEvents, type CmEvent } from '../../core/context-mode'
import { HARNESSES, isHarness, type Harness } from '../../core/events'
import { formatTokens } from '../../core/status/format'
import { cmProjectDir } from '../../engine/context-mode'
import { isValidSessionId } from '../../engine/paths'
import { parseCommandArgs, strFlag } from '../../workflow/args'
import type { CommandIO } from '../router'

export const name = 'ctx'
export const summary = 'Context Mode: session capture and restore for the hooks and plugins, and what it kept out of the context'
export const usage = `Usage: buracle ctx session <op> --harness <h> --session <id> [--project-dir <dir> | --cwd <dir>] [options] [--json]
       buracle ctx stats [--harness <h>] [--cwd <dir>] [--session <id>] [--pid <n>] [--json]
       buracle ctx smoke [--json]

Session ops (Buracle's Claude Code and Codex hooks, the OpenCode plugin and the omp extension call them):
  capture    record the events on stdin ({"events": [...]}) or in --input <file>
  snapshot   record the events given the same way, then store context-mode's snapshot before a
             compaction (--json: {"ok", "snapshot", "text"}; text: the restore text it will need)
  restore    the restore text after a compaction or on resume (--json: {"ok", "text"})
  startup    open the session and drop sessions older than 7 days

  --project-dir <dir>  the project folder exactly as the session's context-mode server keys its store
  --cwd <dir>          the folder to derive it from instead (Claude Code: CLAUDE_PROJECT_DIR when set,
                       else the real path of the folder; default: the current folder)
  --input <file>       read the events from this file; a file Buracle wrote into
                       ~/.buracle/context-mode/tmp is deleted after reading
  --source compact|resume   restore: why it is shown (default compact)
  --max-bytes <n>      restore, snapshot: the size of the restore text (default 2400)

The ops fail open: while contextMode.enabled or contextMode.capture is off, under
BURACLE_NO_CAPTURE=1, without context-mode in the toolchain, or when anything fails, they do
nothing, say why on stderr ({"ok": false, "skipped": "<why>"} with --json) and exit 0.

stats    what context-mode kept out of the context in this project, per harness (from the stats
         file its server writes; --session or --pid picks one server, else the freshest within 15 min)
smoke    check that the installed context-mode works with Buracle's session bridge

Exit codes: 0 ok · 1 usage error or a failed smoke test · 2 smoke: context-mode is not installed.`

const SPEC = {
  harness: 'string', session: 'string', 'project-dir': 'string', cwd: 'string', input: 'string', source: 'string', 'max-bytes': 'string', pid: 'string',
} as const

function fail(io: CommandIO, what: string, problems: readonly string[]): number {
  io.stderr.write(`buracle ${what}: ${problems.join('; ')}\nRun 'buracle ctx --help' for the usage.\n`)
  return 1
}

function projectDirFor(h: Harness, cwd: string | undefined): string {
  return cmProjectDir(h, { claudeProjectDir: h === 'claude' ? process.env['CLAUDE_PROJECT_DIR'] : undefined, cwd: resolve(cwd ?? process.cwd()) })
}

async function readEvents(io: CommandIO, input: string | undefined, what: string): Promise<CmEvent[]> {
  let text: string | undefined
  if (input !== undefined) {
    const { takeCmInput } = await import('../../adapters/shared/context-mode/client')
    text = takeCmInput(input)
    if (text === undefined) { io.stderr.write(`buracle ${what}: cannot read --input ${input}\n`); return [] }
  } else {
    text = await io.stdin.text()
  }
  if (text.trim() === '') return []
  try {
    return cmParseEvents(JSON.parse(text) as unknown)
  } catch {
    io.stderr.write(`buracle ${what}: the events are not JSON; nothing recorded\n`)
    return []
  }
}

async function runSession(op: string | undefined, pos: readonly string[], flags: Record<string, string | boolean>, io: CommandIO): Promise<number> {
  const { CM_OPS, cmRunOp } = await import('../../adapters/shared/context-mode/session')
  const what = `ctx session${op !== undefined ? ` ${op}` : ''}`
  const problems: string[] = []
  if (op === undefined) problems.push('missing op (capture, snapshot, restore or startup)')
  else if (!(CM_OPS as readonly string[]).includes(op)) problems.push(`unknown op '${op}'`)
  if (pos.length > 0) problems.push(`unexpected argument '${pos[0]}'`)
  const h = strFlag(flags, 'harness')
  if (!isHarness(h)) problems.push(h === undefined ? '--harness is required' : `unknown harness '${h}'`)
  const sid = strFlag(flags, 'session')
  if (!isValidSessionId(sid)) problems.push(sid === undefined ? '--session is required' : 'invalid --session id')
  const source = strFlag(flags, 'source') ?? 'compact'
  if (source !== 'compact' && source !== 'resume') problems.push('--source takes compact or resume')
  const maxRaw = strFlag(flags, 'max-bytes')
  const maxBytes = maxRaw !== undefined ? Number(maxRaw) : undefined
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1)) problems.push('--max-bytes takes a positive whole number')
  const given = strFlag(flags, 'project-dir')
  if (given !== undefined && strFlag(flags, 'cwd') !== undefined) problems.push('give --project-dir or --cwd, not both')
  if (given !== undefined && !isAbsolute(given)) problems.push('--project-dir must be an absolute path')
  if (problems.length > 0 || op === undefined || !isHarness(h) || !isValidSessionId(sid)) return fail(io, what, problems)
  const projectDir = given ?? projectDirFor(h, strFlag(flags, 'cwd'))
  const events = op === 'capture' || op === 'snapshot' ? await readEvents(io, strFlag(flags, 'input'), what) : []
  const outcome = await cmRunOp({
    op: op as (typeof CM_OPS)[number],
    target: { harness: h, sessionId: sid, projectDir },
    events,
    source: source === 'resume' ? 'resume' : 'compact',
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  })
  if (outcome.skipped !== undefined) io.stderr.write(`buracle ${what}: skipped: ${outcome.skipped}\n`)
  if (io.flags.json) {
    io.stdout.write(JSON.stringify(outcome) + '\n')
  } else if (op === 'restore') {
    if (outcome.text !== undefined && outcome.text !== '') io.stdout.write(outcome.text + '\n')
  } else if (outcome.ok) {
    const done = op === 'capture' ? `recorded ${outcome.rows ?? 0} row(s)`
      : op === 'snapshot' ? (outcome.snapshot !== undefined ? 'snapshot stored' : 'nothing to snapshot')
        : `session opened; ${outcome.removed ?? 0} old session(s) removed`
    io.stdout.write(`${done}\n`)
  }
  return 0
}

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 1) return 'just now'
  if (min < 120) return `${min} min ago`
  return `${Math.round(min / 60)} h ago`
}

async function runStats(pos: readonly string[], flags: Record<string, string | boolean>, io: CommandIO): Promise<number> {
  const problems: string[] = []
  if (pos.length > 0) problems.push(`unexpected argument '${pos[0]}'`)
  const h = strFlag(flags, 'harness')
  if (h !== undefined && !isHarness(h)) problems.push(`unknown harness '${h}'`)
  const pidRaw = strFlag(flags, 'pid')
  const pid = pidRaw !== undefined ? Number(pidRaw) : undefined
  if (pid !== undefined && (!Number.isInteger(pid) || pid < 1)) problems.push('--pid takes a process id')
  for (const f of ['project-dir', 'input', 'source', 'max-bytes']) if (flags[f] !== undefined) problems.push(`--${f} does not apply to 'ctx stats'`)
  if (problems.length > 0) return fail(io, 'ctx stats', problems)
  const { readCmStats } = await import('../../adapters/shared/context-mode/stats')
  const sessionId = strFlag(flags, 'session')
  const harnesses: readonly Harness[] = h !== undefined && isHarness(h) ? [h] : HARNESSES
  const now = Date.now()
  const out: Record<string, unknown> = {}
  const lines: string[] = []
  for (const x of harnesses) {
    const s = readCmStats(x, projectDirFor(x, strFlag(flags, 'cwd')), { ...(sessionId !== undefined ? { sessionId } : {}), ...(pid !== undefined ? { pid } : {}), nowMs: now })
    out[x] = s ?? null
    lines.push(s === undefined
      ? `${x}: no context-mode numbers for this project (its server writes them while it runs)`
      : `${x}: kept out ${size(s.keptOut)} of ${size(s.totalProcessed)} (${s.reductionPct}%) in ${s.totalCalls} tool call(s), about ${formatTokens(s.tokensSaved)} tokens (updated ${ago(now - s.updatedAt)})`)
  }
  io.stdout.write(io.flags.json ? JSON.stringify(out) + '\n' : lines.join('\n') + '\n')
  return 0
}

async function runSmoke(pos: readonly string[], flags: Record<string, string | boolean>, io: CommandIO): Promise<number> {
  if (pos.length > 0 || Object.keys(flags).length > 0) return fail(io, 'ctx smoke', ['ctx smoke takes no arguments'])
  const { cmSmokeTest } = await import('../../adapters/shared/context-mode/smoke')
  const r = await cmSmokeTest()
  if (io.flags.json) io.stdout.write(JSON.stringify(r) + '\n')
  else if (r.ok) io.stdout.write(`context-mode ${r.version ?? '?'} works with Buracle's session bridge (${r.ms} ms)\n`)
  else io.stdout.write([`context-mode${r.version !== undefined ? ` ${r.version}` : ''} does not work with Buracle's session bridge:`, ...r.problems.map(p => `  - ${p}`)].join('\n') + '\n')
  if (r.ok) return 0
  return r.root === undefined ? 2 : 1
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const parsed = parseCommandArgs(argv, SPEC)
  if (parsed.errors.length > 0) return fail(io, 'ctx', parsed.errors)
  const [sub, ...pos] = parsed.positional
  switch (sub) {
    case 'session': {
      const [op, ...more] = pos
      return runSession(op, more, parsed.flags, io)
    }
    case 'stats': return runStats(pos, parsed.flags, io)
    case 'smoke': return runSmoke(pos, parsed.flags, io)
    default: return fail(io, 'ctx', [sub === undefined ? 'missing subcommand (session, stats or smoke)' : `unknown subcommand '${sub}'`])
  }
}

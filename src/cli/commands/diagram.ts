import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { CommandIO } from '../router'
import { boolFlag, parseCommandArgs } from '../../workflow/args'
import { DIAGRAM_TIMEOUT_MS, drawDiagram } from '../../workflow/diagram'
import { emit, fail, ok, processCtx, usageError, warnCwdGone, type WorkflowCtx } from '../../workflow/result'

export const name = 'diagram'
export const summary = 'Draw a Mermaid diagram as box drawing for a terminal or a chat reply'
export const usage = `Usage: buracle diagram [<file>|-] [--ascii] [--json]

Reads Mermaid source from <file>, or from stdin when no file is given or the file is -, and prints
the drawing with Unicode box characters (--ascii: plain ASCII only). A \`\`\`mermaid fence around
the source is dropped.

Supported diagrams: flowchart (or graph), sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram.
Start the source with that header and write one statement per line.

Exit 1 with the error on stderr when the source cannot be drawn: an empty source, an unknown or
unsupported header (gantt, pie, …), or a drawing that does not finish within ${DIAGRAM_TIMEOUT_MS / 1000} s (split it).
A source with a valid header but an unfinished statement (A -->) is drawn in part and exits 0.
A drawing wider than 100 columns prints a warning on stderr and still exits 0.`

const MAX_WIDTH = 100
const PREFIX = 'buracle diagram'

export async function runDiagram(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const parsed = parseCommandArgs(argv, { ascii: 'bool' })
  const problems = [...parsed.errors]
  const [file, extra] = parsed.positional
  if (extra !== undefined) problems.push(`unexpected argument '${extra}'`)
  const fromStdin = file === undefined || file === '-'
  if (fromStdin && io.stdin.isTTY) problems.push('pipe Mermaid source on stdin or name a file')
  if (problems.length > 0) return emit(io, io.flags.json, PREFIX, usageError(usage, problems))
  let source: string
  if (fromStdin) source = await io.stdin.text()
  else {
    try {
      source = readFileSync(isAbsolute(file) ? file : join(ctx.cwd, file), 'utf8')
    } catch (e) {
      return emit(io, io.flags.json, PREFIX, fail('unreadable', `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
  const r = await drawDiagram(source, { ascii: boolFlag(parsed.flags, 'ascii') })
  if (!r.ok) return emit(io, io.flags.json, PREFIX, fail(r.reason, r.error))
  const warnings = r.width > MAX_WIDTH ? [`the drawing is ${r.width} columns wide (over ${MAX_WIDTH}); a top-down layout (flowchart TD) is narrower`] : []
  return emit(io, io.flags.json, PREFIX, ok({ ok: true, text: r.text, width: r.width, warnings }, [r.text], warnings))
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, PREFIX, ctx)
  return runDiagram(argv, io, ctx)
}

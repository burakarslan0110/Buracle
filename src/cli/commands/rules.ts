import type { CommandIO } from '../router'
import { boolFlag, parseCommandArgs } from '../../workflow/args'
import { rulesLint } from '../../workflow/rules'
import { emit, processCtx, usageError, warnCwdGone, type WorkflowCtx } from '../../workflow/result'

export const name = 'rules'
export const summary = 'Lint rules (size budget, references, routing list)'
export const usage = `Usage: buracle rules lint [<rules-dir>] [--strict] [--json]

Checks canonical/rules (or <rules-dir>):
  always/*.md  no frontmatter; at most 200 lines each; at most 500 lines and 7,500 words together
  paths/*.md   frontmatter paths: ["<glob>", …] only, with valid globs
  all rules    no Buracle placeholders or harness blocks (rules are not rendered), documented
               'buracle' commands only, no relative links (rules are installed elsewhere)
  routing list the routing table (| Need | Use first | Fallback |) names only MCP servers of
               mcp.yaml and tools of tools.yaml, and every server routing.yaml routes to (the
               data files next to <rules-dir>, else canonical/)
Exit 0 clean · 1 errors · 2 warnings with --strict`

export async function runRules(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const parsed = parseCommandArgs(argv, { strict: 'bool' })
  const [sub, ...rest] = parsed.positional
  const prefix = `buracle rules${sub !== undefined ? ` ${sub}` : ''}`
  const problems = [...parsed.errors]
  if (sub !== 'lint') problems.push(sub === undefined ? 'missing subcommand (lint)' : `unknown subcommand '${sub}'`)
  if (rest.length > 1) problems.push(`unexpected argument '${rest[1]}'`)
  if (problems.length > 0) return emit(io, io.flags.json, prefix, usageError(usage, problems))
  return emit(io, io.flags.json, prefix, rulesLint(rest[0], boolFlag(parsed.flags, 'strict'), ctx))
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, 'buracle rules', ctx)
  return runRules(argv, io, ctx)
}

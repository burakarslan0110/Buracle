import type { CommandIO } from '../router'
import { boolFlag, parseCommandArgs, strFlag } from '../../workflow/args'
import { DEFAULT_LIMIT, MAX_LIMIT, skillsFind } from '../../workflow/skill-find'
import { skillsAdd, skillsRemove, skillsUpdate } from '../../workflow/skill-install'
import { skillsLint, skillsList, skillsNew } from '../../workflow/skills'
import { emit, processCtx, usageError, warnCwdGone, type WorkflowCtx } from '../../workflow/result'

export const name = 'skills'
export const summary = 'Lint, list, scaffold, find, install or update skills'
export const usage = `Usage: buracle skills <subcommand> [--json]

  list                      every skill with its source (skills.sources, installed third-party skills
                            and the project's .agents/skills)
  new <id> [--source <n>]   scaffold <source>/<id>/SKILL.md and evals/cases.json (default source: buracle)
  lint [<dir>…] [--strict]  check skills: frontmatter keys and limits, placeholders and the
                            \\{{…}} escape, harness blocks, documented 'buracle' commands in code, MCP ids,
                            {{skill:x}}/{{agent:x}} targets, relative links, evals/cases.json.
                            Default: every configured source; or skill folders / folders of skills
                            (folders under .agents/skills are linted as project skills).
                            Exit 0 clean · 1 errors · 2 warnings with --strict
  find <need…> [--limit <n>]
                            one call that finds a skill for a need: the installed and shipped skills
                            that match, then the skills.sh registry's candidates (default ${DEFAULT_LIMIT}, at most
                            ${MAX_LIMIT}) with their SKILL.md description and tool grants, the repository's
                            license, stars, last push and archived flag (GitHub API; GITHUB_TOKEN raises
                            its limit) and the registry's Socket and Snyk risk ratings, each with its
                            \`skills add\` line. Nothing is cloned or run. Exit 1 when skills.sh is unreachable
  add <source> [--skill <id>[,<id>]] [--all] [--id <id>] [--ref <ref>] [--force] [--dry-run] [--no-claude-link]
                            install a third-party skill for every harness: <source> is owner/repo,
                            owner/repo/path/to/skill, owner/repo@ref, a GitHub URL (also .../tree/<ref>/<path>),
                            any git URL, or a local folder. The skill is linted (portable rules) and audited
                            (scripts, shell pipes, secrets, injection wording), copied to ~/.agents/skills/<id>
                            (Codex, OpenCode, Oh My Pi) and linked from ~/.claude/skills/<id> (Claude Code).
                            A source with several skills lists them: pick with --skill or take --all.
                            Exit 0 installed · 1 nothing installed · 2 a choice is needed or some failed
  remove <id>               remove a skill \`add\` installed (its folder and the Claude Code link)
  update [<id>] [--force] [--dry-run]
                            re-fetch the git sources of installed skills and reinstall what changed upstream;
                            a copy with local edits is kept unless --force`

export async function runSkills(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const parsed = parseCommandArgs(argv, { strict: 'bool', source: 'string', skill: 'string', all: 'bool', id: 'string', ref: 'string', force: 'bool', 'dry-run': 'bool', 'no-claude-link': 'bool', limit: 'string' })
  const [sub, ...rest] = parsed.positional
  const prefix = `buracle skills${sub !== undefined ? ` ${sub}` : ''}`
  const problems = [...parsed.errors]
  const subs = ['lint', 'list', 'new', 'find', 'add', 'remove', 'update']
  if (sub === undefined || !subs.includes(sub)) problems.push(sub === undefined ? `missing subcommand (${subs.join(', ')})` : `unknown subcommand '${sub}'`)
  const only = (flag: string, ...where: string[]) => { if (parsed.flags[flag] !== undefined && (sub === undefined || !where.includes(sub))) problems.push(`--${flag} applies to '${where.map(w => `skills ${w}`).join("' and '")}' only`) }
  only('strict', 'lint')
  only('source', 'new')
  only('skill', 'add')
  only('all', 'add')
  only('id', 'add')
  only('ref', 'add')
  only('force', 'add', 'update')
  only('dry-run', 'add', 'update')
  only('no-claude-link', 'add')
  only('limit', 'find')
  if (sub === 'list' && rest.length > 0) problems.push(`unexpected argument '${rest[0]}'`)
  if ((sub === 'new' || sub === 'add' || sub === 'remove' || sub === 'update') && rest.length > 1) problems.push(`unexpected argument '${rest[1]}'`)
  if ((sub === 'add' || sub === 'remove') && rest.length === 0) problems.push(sub === 'add' ? 'a source is required (owner/repo, a git URL or a folder)' : 'a skill id is required')
  if (sub === 'find' && rest.join(' ').trim() === '') problems.push('say what the skill should do: buracle skills find <need…>')
  let limit: number | undefined
  if (sub === 'find' && strFlag(parsed.flags, 'limit') !== undefined) {
    const raw = strFlag(parsed.flags, 'limit') as string
    limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) problems.push(`--limit must be a whole number from 1 to ${MAX_LIMIT}`)
  }
  if (problems.length > 0) return emit(io, io.flags.json, prefix, usageError(usage, problems))
  if (sub === 'list') return emit(io, io.flags.json, prefix, await skillsList(ctx))
  if (sub === 'new') return emit(io, io.flags.json, prefix, skillsNew(rest[0], strFlag(parsed.flags, 'source')))
  if (sub === 'find') return emit(io, io.flags.json, prefix, await skillsFind(rest.join(' '), limit !== undefined ? { limit } : {}, ctx))
  if (sub === 'add') {
    const skill = strFlag(parsed.flags, 'skill')
    const opts = {
      ...(strFlag(parsed.flags, 'id') !== undefined ? { id: strFlag(parsed.flags, 'id') as string } : {}),
      ...(strFlag(parsed.flags, 'ref') !== undefined ? { ref: strFlag(parsed.flags, 'ref') as string } : {}),
      ...(skill !== undefined ? { skill: skill.split(',').map(s => s.trim()).filter(s => s !== '') } : {}),
      all: boolFlag(parsed.flags, 'all'), force: boolFlag(parsed.flags, 'force'), dryRun: boolFlag(parsed.flags, 'dry-run'), noClaudeLink: boolFlag(parsed.flags, 'no-claude-link'),
    }
    return emit(io, io.flags.json, prefix, await skillsAdd(rest[0] as string, opts, ctx))
  }
  if (sub === 'remove') return emit(io, io.flags.json, prefix, skillsRemove(rest[0]))
  if (sub === 'update') return emit(io, io.flags.json, prefix, await skillsUpdate(rest[0], { force: boolFlag(parsed.flags, 'force'), dryRun: boolFlag(parsed.flags, 'dry-run') }, ctx))
  return emit(io, io.flags.json, prefix, skillsLint(rest, boolFlag(parsed.flags, 'strict'), ctx))
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, 'buracle skills', ctx)
  return runSkills(argv, io, ctx)
}

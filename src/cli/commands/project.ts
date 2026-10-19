import type { CommandIO } from '../router'
import { boolFlag, parseCommandArgs } from '../../workflow/args'
import { projectCheck, projectSync } from '../../workflow/project'
import { emit, optionalSession, processCtx, usageError, warnCwdGone, type CmdResult, type WorkflowCtx } from '../../workflow/result'

export const name = 'project'
export const summary = 'Per-project agent files: AGENTS.md, skill links, the path-rule index, the project brain, .git/info/exclude'
export const usage = `Usage: buracle project init|sync [--adopt [--move] [--dry-run]] [--auto] [--quiet] [--json]
       buracle project check [--json]

init and sync run the same idempotent steps in the current repository (init is the first-run name):
  - checks AGENTS.md (never writes it: without one, run the project-rules skill);
  - links .agents/skills/<id> into .claude/skills/<id> (relative symlinks; existing files or
    directories are left alone and reported; stale links into .agents/skills are removed). A
    .claude/skills that already links to .agents/skills counts as linked; a .agents, .claude or
    skills folder that is a symlink leading outside the repository is refused and never written
    through;
  - reports the drift 'check' finds (path rules missing from the AGENTS.md index, a CLAUDE.md
    that does not import AGENTS.md) as warnings;
  - sets up project memory through the memory module when it is available: the project's
    CortexDB brain with its core pages, and the Claude Code autoMemoryDirectory an older
    Buracle wrote into .claude/settings.local.json taken back (only a value the ownership
    ledger proves is Buracle's);
  - keeps local-only paths out of git via .git/info/exclude (a managed block shared by every
    checkout of the repository; never .gitignore).
  --adopt     also take in the skills that exist only in .claude/skills (a SKILL.md whose name
              matches the folder, with a description): each gets a local link
              .agents/skills/<id> -> ../../.claude/skills/<id> (kept out of git), so Codex sees
              it; tracked files stay as they are. Copies that exist on both sides are compared:
              identical ones are reported, different ones are listed and left alone. The adopted
              skills are linted afterwards (findings never block).
  --move      with --adopt: move each Claude-only folder into .agents/skills and link it back,
              and replace identical Claude copies with links. A tracked folder becomes a
              symlink, which teammates without Buracle and Windows checkouts without symlinks
              do not follow; ask before you use it.
  --dry-run   with --adopt: report what would change and write nothing.
  --auto      the session-start step (hook H28): only link .agents/skills into .claude/skills
              and update .git/info/exclude, under the repository lock (skipped when another
              command holds it); no AGENTS.md checks, no memory, never touches a real folder.
  --quiet     print nothing (the exit code still tells).

check is read-only: it compares every .claude/rules/**/*.md (README excluded) with the root
AGENTS.md '## Scoped rules' list (each rule listed once, with globs equal to its 'paths:'
frontmatter, which must parse; every listed file exists; gitignored rules are reported apart),
checks that every .agents/skills/<id> is linked into .claude/skills, that CLAUDE.md or
CLAUDE.local.md imports AGENTS.md (a CLAUDE.md that is a symlink to AGENTS.md counts), and that
no agent folder is a symlink leading outside the repository. 'buracle project sync --check' is the
same command.
Exit 0 ok · 1 error · 2 the user must act (sync: missing AGENTS.md, link or settings conflicts, a
tracked settings file, not a git repo; check: drift, with the fix in each message).`

const FLAGS = { adopt: 'bool', move: 'bool', 'dry-run': 'bool', auto: 'bool', quiet: 'bool', check: 'bool' } as const

function quiet(r: CmdResult): CmdResult {
  return { ...r, lines: [], errors: r.code === 1 ? r.errors : [] }
}

export async function runProject(argv: string[], io: CommandIO, ctx: WorkflowCtx): Promise<number> {
  const parsed = parseCommandArgs(argv, FLAGS)
  const [sub, ...rest] = parsed.positional
  const problems = [...parsed.errors]
  const f = parsed.flags
  if (sub !== 'init' && sub !== 'sync' && sub !== 'check') problems.push(sub === undefined ? 'missing subcommand (init, sync or check)' : `unknown subcommand '${sub}'`)
  if (rest.length > 0) problems.push(`unexpected argument '${rest[0]}'`)
  const adopt = boolFlag(f, 'adopt')
  if (!adopt && (boolFlag(f, 'move') || boolFlag(f, 'dry-run'))) problems.push('--move and --dry-run need --adopt')
  if (boolFlag(f, 'auto') && adopt) problems.push('--auto and --adopt cannot be combined')
  const check = sub === 'check' || boolFlag(f, 'check')
  if (check && (adopt || boolFlag(f, 'auto'))) problems.push('check is read-only: drop --adopt and --auto')
  if (sub === 'check' && boolFlag(f, 'check')) problems.push('--check is the same as the check subcommand')
  if (sub === 'init' && boolFlag(f, 'check')) problems.push('--check goes with sync')
  const prefix = `buracle project${sub !== undefined ? ` ${sub}` : ''}`
  if (problems.length > 0) return emit(io, io.flags.json, prefix, usageError(usage, problems))
  const r = check
    ? await projectCheck(ctx)
    : await projectSync(sub as 'init' | 'sync', ctx, optionalSession({}, ctx.env), {
      ...(boolFlag(f, 'auto') ? { auto: true } : {}),
      ...(adopt ? { adopt: { move: boolFlag(f, 'move'), dryRun: boolFlag(f, 'dry-run') } } : {}),
    })
  return emit(io, io.flags.json, prefix, boolFlag(f, 'quiet') ? quiet(r) : r)
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const ctx = processCtx()
  warnCwdGone(io, 'buracle project', ctx)
  return runProject(argv, io, ctx)
}

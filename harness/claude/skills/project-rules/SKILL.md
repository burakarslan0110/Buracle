---
name: project-rules
description: "Create, refresh or audit a repository's agent guidance so Claude Code, Codex, OpenCode and omp follow the same verified instructions: the root AGENTS.md, optional nested AGENTS.md files for subprojects, and path-scoped rules for specific file types. Discovers commands and conventions from the code (package scripts, CI jobs, linter and test configs, test layout), runs commands before documenting them, keeps every file short, then runs `buracle project sync` and `buracle project check`. Use when the user asks to set up, write, update, slim down or check AGENTS.md, CLAUDE.md or project rules."
when_to_use: "The repo has no agent guidance, or it is stale, bloated or contradicts the code; after tooling changes such as a new package manager, test runner or linter (\"write an AGENTS.md\", \"set up the project rules\", \"update the instructions\", \"slim down the rules\")."
argument-hint: "[audit | <subdirectory>]"
---

# Project rules

Write the smallest set of repository instructions that stops agents from making real mistakes in
this codebase. Every command and path in them is verified here and now.

## What you produce

| File | Purpose | Budget |
|---|---|---|
| `AGENTS.md` (repo root) | Shared instructions. All four harnesses read it natively. | ≤150 lines, ≤12 KB |
| `<subdir>/AGENTS.md` | Only for a subproject with its own commands or rules (a monorepo package). | ≤60 lines |
| `.claude/rules/<slug>.md` | Rules for one kind of file, scoped with `paths:` globs. Claude Code loads one when it reads a matching file; the other harnesses reach it through the index in `AGENTS.md`. | ≤80 lines each |
| `CLAUDE.md` | Only when one already exists: `@AGENTS.md` plus notes for Claude Code. Codex, OpenCode and omp read the `AGENTS.md` next to it instead, so these notes reach Claude Code alone; personal notes go into the gitignored `CLAUDE.local.md`. | ≤20 lines |

- **The index is mandatory.** Codex and OpenCode read only `AGENTS.md` files, and omp does not
  read `.claude/rules/`. The `## Scoped rules` list in the root `AGENTS.md` is how they find path
  rules. At each session start Buracle also lists the rules the index lacks (hook H28), which is
  how gitignored private rules reach them; a tracked rule still belongs in the index.
- **Buracle keeps the links.** Hook H28 links `.agents/skills/<id>` into `.claude/skills` when a
  session starts in any harness and after an edit, so Claude Code sees project skills another
  harness created. `buracle project check` reports what is out of step and exits 2 until it is fixed.
- **CLAUDE.md can hide AGENTS.md.** By default Claude Code reads `CLAUDE.md` and
  `CLAUDE.local.md` *instead of* `AGENTS.md` whenever either exists in the working directory or
  above. Then one of them must import it with the line `@AGENTS.md`: add the line to `CLAUDE.md`,
  or create a one-line `CLAUDE.md` when only the personal `CLAUDE.local.md` exists. Otherwise do
  not create a `CLAUDE.md`. A `CLAUDE.md` that is a symlink to `AGENTS.md` already routes; leave
  it, because writing to it writes `AGENTS.md`. A `.claude/CLAUDE.md` hides `AGENTS.md` as well,
  from Claude Code and from omp, and needs the line `@../AGENTS.md` (imports resolve from the
  importing file's folder, so `@AGENTS.md` there finds nothing).
- Do not create `.agents/rules/` copies of path rules; two copies drift apart.

## Ground rules

1. **Verified or labeled.** Document a command only after it ran here (exit code recorded) or CI
   runs it verbatim. Otherwise label it `(not verified: <reason>)`.
2. **Every line must prevent a mistake.** Cut generic advice, anything a linter or formatter
   already enforces, anything obvious from the code, and volatile facts (counts, dates, versions
   the repo does not pin).
3. **One home per fact.** Repo-wide → root `AGENTS.md`. One file type → path rule. One subtree →
   nested `AGENTS.md`. Claude Code-only → `CLAUDE.md`; personal → `CLAUDE.local.md`.
4. **Respect human text.** Never silently drop or rewrite guidance a person wrote. Show the change
   and get approval first (phase 5 gate).
5. **Leave managed blocks alone.** Text between `<!-- buracle:<id>:start -->` and
   `<!-- buracle:<id>:end -->` belongs to the buracle CLI.
6. **Neutral wording.** Shared files name commands, paths and MCP servers, never one harness's
   tool names ("search with `rg`", not "use the Grep tool").
7. **English guidance** (agents follow it most reliably), written by the four principles of the
   *Plain language* rule (ISO 24495-1). Keep identifiers, UI strings and error messages verbatim.
   Talk to the user in their language.
8. **No secrets.** Environment variable names are fine; values never.

## Tools for discovery

| Question | Use |
|---|---|
| How or where is X done (errors, config, logging, auth)? | `semble` MCP `search` (intent), then read the top hits; `find_related` for siblings |
| Entry points, module boundaries, who calls what, how widespread a helper is | `codegraph` MCP (`codegraph_explore`) |
| Every file matching a pattern; exact counts | `rg --files -g '<glob>'`, `rg -c '<pattern>'` |
| What a framework recommends at the version in the lockfile | `context7` MCP: `resolve-library-id`, then `query-docs` |
| Past decisions about this repo's conventions | `buracle-memory`: `memory_search`, then `memory_get` |
| A page the repo's own docs link to | `web-fetch` MCP |

Read files with your file-read tool, in narrow ranges. Never `grep -r`, `find … | xargs grep` or
`cat` dumps. An empty search result is not proof of absence: rephrase once or switch tools.
MCP tools may be deferred. Load the semble, codegraph, context7 and buracle-memory tools with
ToolSearch before concluding that they are unavailable.

## Progress

Buracle shows the run live, in the workflow band above the prompt and in the status line. Keep it
current with `buracle flow`; the calls are cheap and best effort, so a failing one never stops the run.

- Start: `buracle flow start project-rules --title "<repo name>"` (harmless when a hook already started
  it).
- Each phase: `buracle flow phase <id>` as phases 1-8 begin: `inventory`, `discover`, `verify`, `audit`,
  `write`, `validate`, `sync`, `report`. A phase you skip (audit in create mode) needs no call.
- End: `buracle flow end --outcome done` after the report.

## Phases

Track the phases with `TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any).

### 1. Inventory

- `buracle flow start project-rules --title "<repo name>"`, then `buracle flow phase inventory`.
- Run `git rev-parse --show-toplevel` and `git status --porcelain`. If guidance files have
  uncommitted edits, build on them and say so.
- Run `ls -l AGENTS.md CLAUDE.md CLAUDE.local.md .claude .claude/CLAUDE.md .claude/skills` to see which of them are
  symlinks, and `buracle project check --json` for the drift Buracle already sees.
- `buracle skills list --json` lists skills of kind `claude-only`: they live only in
  `.claude/skills`, so Codex cannot see them. Offer `buracle project sync --adopt`, which adds a
  local link and changes no tracked file. Ask with `AskUserQuestion` before `--adopt --move`: it turns
  each tracked folder into a symlink that teammates without Buracle and Windows checkouts without
  symlinks do not follow.
- List existing guidance in one call:
  `rg --files --hidden -g 'AGENTS.md' -g 'CLAUDE.md' -g '**/.claude/rules/**' -g '**/.agents/**' -g '**/.cursor/rules/**' -g '.github/copilot-instructions.md' -g 'GEMINI.md' -g 'CONTRIBUTING.md'`.
  `CLAUDE.local.md` is usually gitignored, so `rg` skips it: check for it directly with
  `ls CLAUDE.local.md`.
- Quick memory pass (`/buracle:memory`): at most 3 `memory_search` queries such as
  `conventions`, `test command`, `<repo name> decision`.
- Pick the mode: **create** (no guidance yet), **refresh** (guidance exists), **audit** (the user
  asked only for a review: write nothing but the report).

### 2. Discover

`buracle flow phase discover`. Follow [references/discovery.md](references/discovery.md). Record every
fact as
`claim — evidence (file:line or command)`:

- toolchain, runtime versions and package manager (the lockfile decides);
- commands: install, build, typecheck, lint, format, all tests, one test file, e2e, dev server;
- the CI gate: the exact commands CI runs;
- test layout: framework, location, naming, fixtures, required services;
- layout: entry points, packages, generated or vendored directories nobody edits by hand;
- conventions that differ from ecosystem defaults: at least 3 instances in current code and no
  strong counterexample, or it is not a convention;
- traps: steps that fail in non-obvious ways (codegen before build, env files, ports, services).

### 3. Verify

- `buracle flow phase verify`.
- Run each command you plan to document, narrowest useful form first (one test file before the
  whole suite). Record `command → exit code, duration, first error line`.
- Never run deploys, publishes, releases, migrations against non-local databases, or anything
  that changes remote state. Read an ambiguous script (`bun run sync`) before running it; ask if
  still unsure.
- A command that fails because of the environment (service down, missing secret) gets its
  prerequisite documented, not a guess. Do not change the repo to make commands pass; report it.

### 4. Audit (refresh and audit modes)

`buracle flow phase audit`. Run the checks in [references/audit.md](references/audit.md) on every
guidance file. Report each
finding as `path:line — problem — evidence — proposed fix`. In audit mode, jump to phase 8.

### 5. Write

`buracle flow phase write`. Use [references/templates.md](references/templates.md).

- Root `AGENTS.md` sections, in this order, skipping empty ones: one-paragraph summary, Commands,
  Layout, Conventions, Testing, Gotchas, Scoped rules, Project tools.
- Path rule: `.claude/rules/<slug>.md`, quoted globs in `paths:`, a first line that says what it
  covers, then imperative bullets with the reason wherever the reason is not obvious.
- Index every path rule under `## Scoped rules` as
  `` - `.claude/rules/<slug>.md` — `<glob>` — <purpose> `` below the line
  "Read the matching rule before editing those files."
- Existing `CLAUDE.md`: reduce it to `@AGENTS.md` plus notes for Claude Code; move shared content
  into `AGENTS.md`. When `CLAUDE.md` is a symlink to `AGENTS.md`, leave it as it is.
- A file headed `GENERATED FILE ... DO NOT EDIT` with a `Source:` line belongs to that generator:
  change the source, never the file.
- Other agents' files (`.cursor/rules`, `.github/copilot-instructions.md`, `GEMINI.md`): fold their
  useful, verified content into `AGENTS.md`. Delete them only if the user agrees.
- Project-specific MCP servers or CLIs: read every project config that declares servers,
  `.mcp.json` (Claude Code), `.codex/config.toml` `[mcp_servers.*]` (Codex, only in a trusted
  project) and `opencode.json`/`opencode.jsonc` `mcp` (OpenCode); omp reads all three. Smoke-test
  one read-only call in the current harness and put the result in the report only, since health
  goes stale. Under `## Project tools` add one line each: what it is for and when to consult it.
  In the report, name per server the harnesses that cannot reach it; offer to add the missing
  declaration only with `AskUserQuestion`, and say it is a second copy to keep in step. Buracle's global
  servers are already covered by its routing card; do not list them.

**Approval gate.** When you would change or remove human-written content, show a compact summary
(sections added, removed and changed; line counts before → after; anything dropped and why) and
ask with `AskUserQuestion`: apply, adjust, or cancel. A brand-new file in create mode needs no gate.

### 6. Validate

- `buracle flow phase validate`.
- `wc -l -c` every written file and compare with the budgets.
- Every path mentioned exists. Every glob matches at least one file
  (`rg --files -g '<glob>' | head -n 1`). Rule frontmatter parses as YAML; Claude Code loads a
  rule with broken frontmatter as if it had no `paths` (that is, everywhere).
- Every command is in your verification log or carries a `(not verified: …)` label.
- `buracle project check --json` exits 0: every rule under `.claude/rules/` (nested folders too,
  `README.md` excluded) is in the index with the same globs, every listed file exists, every
  project skill is linked, and `CLAUDE.md` imports `AGENTS.md`. Fix each finding it prints until it
  does; a gitignored rule stays out of the index.
- No `TODO`, `TBD` or `FIXME`; no secrets; no harness tool names; no dates.
- Read the root `AGENTS.md` as a newcomer: could you install, build, run one test, and avoid every
  listed trap with only this file?

### 7. Sync

`buracle flow phase sync`, then `buracle project sync --json`.

- **Exit 0:** note what it changed (skill links, the project's memory core pages, `.git/info/exclude`
  entries; it never touches `.gitignore`). Buracle repeats the link step by itself at every session
  start (H28); this run makes it happen now.
- **Exit 2:** it needs the user; relay its message. If the project was never initialized, run
  `buracle project init --json`, then sync again.
- **Exit 1:** report the error. Never hand-create `.claude/skills` links or edit
  `.claude/settings.local.json`; the CLI owns them.

### 8. Report

`buracle flow phase report`, then report, and close with `buracle flow end --outcome done`:

- Files written, with line and byte counts.
- Verification log (command → exit code) and the not-verified list with reasons.
- Audit findings: fixed, deferred, or rejected by the user.
- The `buracle project sync` and `buracle project check` results.
- Project MCP servers: the smoke-test result and the harnesses each one does not reach.
- Follow-ups: a recurring procedure you noticed → `/new-skill`; a rule whose effect
  should be measured → `/ab-test`.

The guidance files are the record; do not copy them into memory. Write a `gotcha` memory only for a
verified trap that does not belong in the repo, such as one specific to this machine.

## Failure handling

| Situation | Do |
|---|---|
| Not a git repository | Work in the current directory; `buracle project sync` may refuse, report it. |
| Large monorepo | Root plus top-level packages only. For many packages, launch one read-only explorer per package with the `Agent` tool; each returns facts with evidence, then merge their results. |
| Two competing conventions | Prefer the one in recently added files (`git log --diff-filter=A --since=6.months --name-only --format=`); ask if still unclear. |
| Guidance contradicts the code | Ask which one is right; never pick silently. |
| A command needs credentials or services | Document the prerequisite and the variable names, never the values. |
| The user wants the guidance in another language | Say once that agents follow English more reliably; then do what they choose. |

## Example

A path rule for SQL migrations, `.claude/rules/sql-migrations.md`:

```markdown
---
paths: ["db/migrations/**/*.sql"]
---
Applies to SQL migration files.
- Never edit a migration that is already on `main`; add a new file instead.
- Name files `YYYYMMDDHHMM_<verb>_<object>.sql`; the runner applies them in name order.
- Check with `bun run db:migrate --dry-run` before committing.
```

Its index line in the root `AGENTS.md`:

```markdown
- `.claude/rules/sql-migrations.md` — `db/migrations/**/*.sql` — migration naming and immutability
```

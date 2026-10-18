# buracle command reference

Every command accepts `--json`, `--verbose` and `--help`. Exit codes everywhere: 0 ok, 1 error,
2 partial success or user action needed. The `plan` subcommands that use this session's binding
(`register`, `prepare-native`, `status`, `set`, `pause`, `resume`, `complete`, `approve-result`, `verify`, `review`, `unregister`) resolve the
session as described in SKILL.md and exit 2 without one. With `--lane <slug>` (every one but `prepare-native`) they use a plan lane's own binding
instead: the lead session's id plus `.lane-<slug>`, for the lane worktree `<slug>` the lead made with
`buracle worktree create <slug> --lane` (it records the lead's session), from any checkout of the repository. `worktree`, `review-scope` and `notify`
use the session when there is one and also work without it.

## plan: the plan file and its state machine

```text
buracle plan init --type feature|bugfix|build --title "<t>" [--slug <s>] [--dir <d>] [--json]
buracle plan capture [--title "<t>"] [--file <path>] [--draft] [--harness <h>] [--json]
buracle plan validate <path> [--strict] [--json]
buracle plan register <path> [--phase plan|implement|verify] [--json]
buracle plan prepare-native <path> | --cancel [--json]
buracle plan status [--json]
buracle plan set status <PENDING|APPROVED|IN_PROGRESS|COMPLETE|VERIFIED>
buracle plan set phase <plan|implement|verify|done>
buracle plan set approved <true|false>
buracle plan set iterations <n>
buracle plan set rounds <n>
buracle plan set worktree <true|false>
buracle plan pause [--kind discussion|decision|manual] [--reason "<r>"]
buracle plan resume
buracle plan complete
buracle plan approve-result
buracle plan verify
buracle plan review start --role plan|changes|goal [--handle <id>] [--provider <harness>]
buracle plan review done --role plan|changes|goal --verdict pass|needs_changes|incomplete
buracle plan review status [--json]
buracle plan review companion start --role plan|changes|goal [--on auto|claude|codex|opencode|omp] [--input <file>|-] [--goal "<expected behavior>"] [--slug <s>] [--timeout-min <n>] [--json]
buracle plan review companion collect --role <r> [--wait <seconds>] [--json]
buracle plan review companion cancel --role <r> [--json]
buracle plan unregister
buracle plan audit [<path>] [--base <ref>] [--slug <s>] [--json]
buracle plan notes [<path>] [--kind plan|code|all] [--slug <s>] [--done <id>[,<id>…]] [--json]
```

| Command | Effect | Output and exit |
|---|---|---|
| `init` | Writes a skeleton to `docs/plans/YYYY-MM-DD-<slug>.md` (type `build`: `docs/builds/…`). Does not register it. | `{path, slug}` |
| `capture` | Saves a plan by hand, the way the hooks save a plan the user approves in a harness's own plan mode (H12): the text on stdin or from `--file`, written to `docs/plans/YYYY-MM-DD-<slug>.md` as type `Plan`, status `SAVED`, approved (`--draft`: approved false); never overwrites (`-2`, `-3`, …). The harness comes from `--harness` or the session. Does not register it. | `{path, slug, title, created, approved, harness}` · exit 1 for an empty plan or no harness |
| `validate` | Checks the plan format | 0 valid · 1 errors · 2 warnings (only with `--strict`) |
| `register` | Binds the plan to this session (the stop guard and status line read this binding) | 2 without a session; `--phase done` only for a VERIFIED plan (exit 1) |
| `prepare-native` | `plan.nativePlanMode`: binds this session's registered Feature plan (phase `plan`, `PENDING`, not approved) once to the coming plan mode, so H12 writes the plan the user approves when leaving plan mode into that file under its own frontmatter; a file changed in between is left alone and the plan saved beside it. `--cancel` drops the binding. No `--lane` | `{path, harness, enter}` (`enter`: how this harness enters plan mode) · `--cancel`: `{cancelled}` · exit 2 with `reasons` when refused (the switch or `plan.planApproval` off, another plan, not a Feature plan, not in its plan phase or not `PENDING`, already approved) · exit 1 without a registered plan |
| `status` | The current binding | `{plan: {path, slug, type, status, phase, approved, …} \| null, status, phase, tasks: {done, total}, interaction, session, native?}`; `interaction` is `{state: running\|paused, kind?, since, reason?}`; `native` is `{path, preparedAt}` while `prepare-native` binds the plan; `reviews?` lists the plan's review records (`[{role, agent, state, startedAt, handle?, verdict?, companion?, …}]`); `lanes?` (plain `status` only) lists the plan lanes bound under this session (`[{lane, session, plan, type, status, phase, interaction}]`) |
| `set status` / `set phase` / `set approved` | Moves the state machine; never edit these fields in the file by hand. `set status COMPLETE` is `complete`; `set status VERIFIED` and `set phase done` are `verify` | refuses with a reason (exit 2), e.g. `phase implement` before approval |
| `set iterations` / `set rounds` | Sets the plan's counter: `iterations` for Feature and Bugfix plans, `rounds` for Build | exit 1 for the other type's counter |
| `set worktree` | Sets the `worktree` flag (`worktree create` already sets it on the registered plan) | |
| `pause` | Records a pause; the stop guard lets the turn end. The user's bare "continue" keeps a `decision` or `manual` pause, except three decision pauses it answers: the stop guard's runaway question (reason `runaway: …`), a goal-build hand-back (`build hand-back: …`) and the model-switch pause after plan approval (`model switch: …`) | |
| `resume` | Clears any pause | |
| `complete` | Status `COMPLETE`: implementation done, verification pending | refuses with a reason when it cannot |
| `approve-result` | Records the user's explicit approval of the verified result (Feature, Bugfix) and ends the pause | needs status `COMPLETE`; refuses Build plans |
| `verify` | Status `VERIFIED`, phase `done`; the stop guard releases | needs status `COMPLETE`, approval, every task ticked and a filled `## Evidence` section (Feature: also `## DoD Audit`, plus `## E2E Results` when the plan names `SC-n` scenarios; Bugfix: also `## RED Evidence`); Feature and Bugfix: also the result approval while `plan.resultApproval` is on; refuses with the reasons |
| `review start` / `review done` / `review status` | Records a reviewer launched in the background with its agent handle (named in the compaction and restore texts, so it is collected, not relaunched), then the collected report with its verdict, anchored to the plan text (`plan`, `goal`) or to the reviewed files (`changes`); `status` says whether each is still fresh | `set approved true` (plan, goal), `approve-result` and `verify` (changes) warn when the review is stale or missing |
| `review companion start` / `collect` / `cancel` | A second opinion (`plan.reviews.companion`, `off` by default; `--on` overrides it): the same review, read-only, on another installed harness, in the background, once per plan and role, for at most `--timeout-min` minutes (default 20). `--input` passes the reviewer's input lines (`-`: stdin); `--goal` reviews a bugfix diff that has no plan (`--role changes`). `collect` waits up to `--wait` seconds (at most 600), prints the report and records it with the plan's reviews; `cancel` stops it. No `--lane` | `{state, job?, report?, review?}`; `state` is `running`, `done`, `unavailable`, `failed`, `cancelled`, `off` or `none` |
| `unregister` | Removes the session binding; the file stays. With `--lane` it also works after the lane worktree is gone (`worktree cleanup` of a lane already ends its binding) | |
| `audit` | Compares the plan's Files lists (the session's plan without a path) with the diff review-scope picks: a Create, Modify or Test path the diff misses, a Delete or Rename that did not happen, a changed path no task and no `## Deviations` line names, an `## Inventory` row whose task is missing or unticked; findings of unticked tasks are info | 0 the diff matches · 2 warnings · 1 error |
| `notes` | The open notes the user pinned in the review page (`buracle mem ui --page review`): plan notes on a passage of `<path>` (a file under `docs/plans`, `docs/builds` or `docs/prd`; without a path the session's plan) and code notes on the changed lines of the diff `review-scope` picks (`--slug` as there). `--done` marks the notes you applied; pass the same `<path>` when no plan is bound to the session. No notes is never an approval | `{doc, branch, checkout, page, open, notes: [{id, kind, …}]}` · 0 ok · 1 error (`not_found` for an unknown id) |

Plan file format, in short: YAML frontmatter `created`, `status`, `approved`, `worktree`, `type`
(`Feature`, `Bugfix`, `Build`, `Plan`), and `iterations` or `rounds`; then `# Title`, `## Tasks`
and `### Task N: …` blocks, each with `**Objective:**`, `**Files:**` (verbs `Create`, `Modify`,
`Delete`, `Rename`, `Test` plus a path), `**Definition of Done:**` and a `- [ ] Task N done` line.
No `TBD`, `TODO` or `FIXME` in task blocks; LF line endings.

Pause kinds: `decision` (you need the user's choice), `manual` (the user must do something by
hand), `discussion` (the user wants to talk, or asked you to stop or wait).

## worktree: isolated branches for plans

```text
buracle worktree create <slug> [--prefix plan-build|goal-build|bugfix] [--base <branch>] [--lane] [--json]
buracle worktree branch <slug> [--prefix plan-build|goal-build|bugfix] [--base <ref>] [--json]
buracle worktree detect [--json]
buracle worktree diff <slug> [--json]
buracle worktree sync <slug> [--json]
buracle worktree cleanup <slug> [--force|--discard]
buracle worktree status [--json]
```

| Command | Effect | Output and exit |
|---|---|---|
| `create` | New worktree on branch `<prefix>/<slug>` (default prefix `plan-build`; the goal-build workflow uses `--prefix goal-build`) from the base branch (`--base` picks it explicitly); sets `worktree: true` on this session's registered plan | `{path, branch}`; without a session it still exits 0 and warns that no plan was marked |
| `create --lane` | A parallel agent's own worktree (the *Parallel agents* rule). It marks no plan and never counts as the plan's worktree (`detect`, `review-scope`). Without `--base` it starts from the branch checked out where it runs, also inside the plan worktree, so `sync <lane>` squash-merges the lane into the plan worktree's branch | `{path, branch, base, lane: true, parent?, plan: null}` |
| `branch` | Switches this checkout to the first free name of `<prefix>/<slug>`, `-2`, `-3` … from HEAD (uncommitted changes come along; with `--base` git refuses rather than overwrite them) and records the base, so `review-scope` diffs the branch against it. On the recorded branch it changes nothing; for this session's plan it switches back to the plan's branch. Refuses inside a Buracle worktree | `{created, switched, branch, base, baseCommit}`; exit 1 with an `error` code (`switch_failed`, `inside_worktree`, `branch_taken`, …) |
| `detect` | Is the current directory in a plan worktree, and does this session's plan have one? | `{inWorktree, path, branch, base, lane?}` |
| `diff` | Summary of the worktree's changes against its base | |
| `sync` | Squash-merges the worktree branch into the base; the base checkout's local changes are stashed and restored, plan files never | 0 merged · 1 nothing merged · 2 merged, but stashed local changes were not restored |
| `cleanup` | Removes the plan worktree and its branch; for a lane worktree it also ends the lane's plan binding and the lead's record of the lane's reviewers | no flag after a `sync` that exited 0 or 2; `--force` for a branch squash-merged outside the CLI; `--discard` deletes unmerged work (user's explicit yes only) |
| `status` | Every plan worktree of the repository, and which one is this session's | |

## review-scope: what a review must read

```text
buracle review-scope [--slug <s>] [--base <ref>] [--json]
```

Output `{mode, base_ref, diff_range, warning?}`. `mode` is `worktree`, `branch` or
`working-tree`, depending on where the changes live. Use `diff_range` verbatim
(`git diff <diff_range>`, `git diff --stat <diff_range>`) and pass `base_ref` and `diff_range` to
review agents. A `warning` means the range may be wrong or empty: resolve it before reviewing.
The base is the worktree's base branch, else the base `worktree branch` recorded for the current branch, else the closest of origin/HEAD's branch,
`init.defaultBranch`, `main`, `master`, `develop` and `trunk`; `--base <ref>` replaces it (exit 1
for a ref that does not exist), for example when the warning says HEAD is the default branch.

## notify: get the user's attention

```text
buracle notify <info|plan_approval|prd_approval|attention_needed|verification_complete> "<title>" "<message>" [--plan <path>]
```

A desktop notification, recorded in `~/.buracle/state/notifications.jsonl`; nothing goes into
memory. Best effort: a failure never blocks the work. Text in the user's language, no secrets.

## project: per-repository setup

```text
buracle project init [--json]
buracle project sync [--adopt [--move] [--dry-run]] [--json]
buracle project check [--json]
```

Checks `AGENTS.md`, links `.agents/skills/*` into `.claude/skills/` (Claude Code does not read
`.agents/`), creates the project's brain with its core pages (and takes back an
`autoMemoryDirectory` an older Buracle wrote into `.claude/settings.local.json`), and adds
local-only entries to `.git/info/exclude` (never
`.gitignore`). `init` the first time in a repository; `sync` after changing `AGENTS.md` or project
skills. Exit 2: the user must act (no `AGENTS.md`, a link or settings conflict, a tracked settings
file, which Buracle never writes to); relay the message. Never create those links or settings by
hand. `--adopt` also takes in the skills that exist only in `.claude/skills` (a local link from
`.agents/skills/<id>`, kept out of git) and `--dry-run` shows what it would change; `--move` moves
such a folder into `.agents/skills`, which turns a tracked folder into a symlink, so run it only
after the user agrees. `check` is read-only: path rules missing from the AGENTS.md index, skills
not linked into `.claude/skills`, a CLAUDE.md that does not import AGENTS.md; exit 2 names the fix
for each.

## skills and rules: authoring checks

```text
buracle skills list [--json]
buracle skills new <id>
buracle skills lint [<dir>…] [--json]
buracle rules lint [--json]
```

`list` shows every skill and its source. `new` scaffolds a skill folder and prints its path.
`skills lint` checks frontmatter, placeholders, harness blocks, documented `buracle`
commands, MCP ids and relative links (a SKILL.md may be any length); `rules lint` checks budgets, frontmatter, documented
commands and the routing list (the tooling routing table against `mcp.yaml`, `tools.yaml` and
`routing.yaml`). Exit 0 means clean. Give `skills lint` a project skill's folder
(`buracle skills lint .agents/skills/<id> --json`) to lint that skill with the portable profile: no
placeholders, no harness blocks.

## mem: memory CLI twins

```text
buracle mem search ["<query>"] [--layer project|person|all] [--type K]… [--since D] [--until D] [--file PATH]… [--tag T]… [--about A]… [--around <id>]
buracle mem get <id>…
buracle mem write --type K --title "<claim>" --summary "<one line>" --body "<text>" [--layer person]
buracle mem update <id> --patch '<json>' [--expected-version N]
buracle mem remember "<text>"
buracle mem status [--json]
buracle mem backup [--project <slug> | --person] [--list]
buracle mem restore <id> (--project <slug> | --person | --all)
buracle mem export [--project <slug> | --person] [--type K]… [--out <file>]
buracle mem import <file|-> [--project <slug>] [--dry-run]
```

The same operations as the `buracle-memory` MCP tools `memory_search`, `memory_get`,
`memory_write`, `memory_update` and `memory_status`, over the current project's brain and the
person brain; `remember` stores a capture, which a later session files with `memory_update`
(`move`). Prefer the MCP tools; use these when the server is unavailable. `search` filters
work without a query (`--file` lists the memories that cite a path, `--around <id>` what was
recorded before and after one). `backup`, `restore`, `export` and `import` run only when the user
asks: `restore` puts a backup's copy of a brain back (the file it replaces is backed up first),
`export` writes one brain's live memories as JSON lines with secrets masked, and `import` writes
such a file through `memory_write` (duplicates skipped, every memory unverified). `buracle doctor memory`
checks the CortexDB binary, the brains and that no project's memory reaches another.

## flow: live workflow progress

```text
buracle flow start <workflow> [--title "<t>"] [--json]
buracle flow phase <phase> [--note "<text>"] [--json]
buracle flow step "<text>" [--done <n>] [--total <m>] [--json]
buracle flow end [--outcome done|failed|cancelled] [--json]
buracle flow status [--json]
```

Records the running workflow for the band above the prompt and the status lines. The session is
resolved as for `plan`; without one, `status` prints `null` and exits 0 and the others exit 2.
Starting the workflow that is already running is harmless; a workflow started inside another (requirements,
then research) stacks on top of it, and `end` ends the top one. Each workflow skill names its phase
ids. The calls are best effort: a failing one never blocks the workflow.

## index: code indexes

```text
buracle index [status] [--cwd <dir>] [--json]
buracle index ensure [--cwd <dir>] [--json]
```

`ensure` builds the missing codegraph index and refreshes the existing ones (codegraph sync, a semble
warm-up) for the project at `--cwd`: its git top level, or the folder that holds a project manifest.
Session starts already run it in the background; run it yourself when codegraph says the project has
no index, then retry. It writes only `.codegraph/` (kept out of git through `.git/info/exclude`) and
the semble cache. `status` shows when each index was last built or refreshed.

## usage: rate-limit headroom

```text
buracle usage [--json]
```

Usage windows (5-hour and 7-day: percent used and reset time) and a calendar-month estimate built
from local logs. The monthly figure is an estimate at list prices, not a bill.

## Maintenance commands

These belong to the user. Run the read-only ones when diagnosing; run the others only on request.

| Command | Effect | Read-only |
|---|---|---|
| `buracle` (in a terminal) | The main menu: the logo, a status line and the choices install, update, health check, memory and detailed view; the detailed view shows what is installed, its versions, updates and problems, and its keys run the commands below | yes |
| `buracle doctor [<topic>]` | Health checks: harness versions, plugin and mod loaded, Codex hook trust, MCP handshakes, the memory store (CortexDB) and indexes, required tools; a harness topic (`claude`, `codex`, …) also runs the liveness probes | yes |
| `buracle update --check` | Lists available updates (Buracle repo, skill sources, MCP pins, plugins, harnesses, tools) and caches the result | yes |
| `buracle update --yes [<kind>\|<name>…]` | Applies updates, each from its own source, then installs again; in a terminal `buracle update` applies at once too, without `--yes` | no |
| `buracle build [--check]` | Regenerates `harness/` from `canonical/` in the Buracle repo; `--check` only reports differences | `--check` only |
| `buracle install [<harness>…] [--dry-run]` | Builds, then installs into the harness configs (every installed one, or those named), with backup and rollback, and installs the toolchain; `--dry-run` shows the plan | `--dry-run` only |
| `buracle rollback [txn]` | Undoes the last (or the given) install transaction | no |
| `buracle rollback toolchain [<package>…]` | Puts back the version each toolchain package held before its last install or update | no |

---
name: buracle
description: "How to use the `buracle` helper CLI that Buracle workflows call instead of ad-hoc shell: plan state and the stop guard (`buracle plan …`, with `plan pause` as the only escape hatch), isolated worktrees, review diff scope, notifications, usage limits, memory CLI twins, workflow progress, code indexes, project sync, skill and rule lint, and `buracle doctor` for health checks. Covers JSON output, exit codes (0 ok, 1 error, 2 needs user action) and session resolution. Use whenever a step needs one of these commands, when a buracle command fails, or when the stop guard keeps your turn going."
when_to_use: "Creating, registering or moving a plan; pausing to ask the user; creating or merging a worktree; computing a review diff; notifying the user; checking rate-limit headroom; diagnosing Buracle."
user-invocable: false
---

# buracle CLI

`buracle` is on PATH in every harness. It owns the state machines that workflows rely on (plans,
worktrees, review scope), so call it instead of re-creating its logic with git or shell, and
never edit its state files by hand.

## Rules

- Add `--json` whenever you need the result, and parse the JSON, never the human text. Every
  command answers `--help`.
- Exit codes: **0** ok · **1** error (read stderr, fix the cause, retry at most once) · **2**
  partial success or user action needed (relay the message to the user).
- Use only the subcommands on this page. If one you need does not exist, say so; do not guess.
- Never edit `~/.buracle/` files or session state. The CLI owns them and the write guard blocks
  edits there.
- Commands that change the installation (`buracle install`, `buracle update`,
  `rollback`, `uninstall`) run only when the user asks for them.

## Session resolution

The session comes from `--session <id>` (with `--harness <h>`), else from the ids your harness puts
into your shell: `BURACLE_SESSION_ID` with `BURACLE_HARNESS`, `CLAUDE_CODE_SESSION_ID`,
`CODEX_SESSION_ID` or `CODEX_THREAD_ID` (a Codex subagent resolves to its parent run's session),
`OPENCODE_SESSION_ID`, `OMP_SESSION_ID`. When one harness was started from another's shell, both
sets of ids are present and the harness process you run under decides. Normally pass neither flag.

The `plan` subcommands that read or change this session's binding (`register`, `prepare-native`, `status`, `set`,
`pause`, `resume`, `complete`, `approve-result`, `verify`, `review`, `unregister`) exit 2 without a session. `worktree`,
`review-scope` and `notify` use the session when there is one and work without it (`worktree create`
then warns that it marked no plan). Never invent an id and never borrow another session's id.
Without a session, continue from the plan file, tell the user once that the stop guard is not
protecting this run, and suggest `buracle doctor`.

## What to call when

| Situation | Command |
|---|---|
| New plan file | `buracle plan init --type feature\|bugfix\|build --title "<t>" --json` → `{path, slug}` |
| Check a plan's format | `buracle plan validate <path> --json` (exit 0 ok, 1 errors, 2 warnings with `--strict`) |
| Bind the plan to this session | `buracle plan register <path> --phase plan\|implement\|verify --json` (the phase its state implies: `plan` until approved, `verify` once `COMPLETE`; a locked goal-build run takes no `--phase`, so the phase its run file records stays) |
| Plan a registered feature plan in the harness's own plan mode (`plan.nativePlanMode`, as `/plan-build` says) | `buracle plan prepare-native <path> --json` (exit 2 with `reasons` when refused; `--cancel` drops the binding) |
| Where am I? (also after a compaction) | `buracle plan status --json` → `{plan, phase, status, tasks: {done, total}, interaction}` |
| Move the plan along | `buracle plan set status <S>`, `buracle plan set phase <p>`, `buracle plan set approved true` |
| Raise the iteration or round counter | `buracle plan set iterations <n>` (Feature, Bugfix) or `buracle plan set rounds <n>` (Build) |
| You need a real decision from the user | `buracle plan pause --kind decision --reason "<question>"`, then ask |
| The user answered, or said "continue" after a stop | `buracle plan resume` (a bare "continue" answers no open decision or manual step: ask again; it does answer the runaway question, a goal-build hand-back and the model-switch pause) |
| A reviewer runs in the background, or its report was triaged | `buracle plan review start --role plan\|changes\|goal --handle <id>`, then `buracle plan review done --role <r> --verdict <v>` |
| A whole workflow runs as a plan lane | the lead: `buracle worktree create <slug> --lane`, and the plan file in the lead's checkout; the lane: every `buracle plan` command with `--lane <slug>` |
| Planned work against the actual diff (end of implement, start of verify) | `buracle plan audit [<path>] --json` (exit 2 on warnings: planned work missing, unplanned changes, open Inventory rows) |
| The user pinned notes in the review page (before an approval, before finishing a change) | `buracle plan notes [<path>] [--kind plan\|code] --json`, then `buracle plan notes [<path>] --done <id>[,<id>]` for the ones you applied (no notes is never an approval) |
| All tasks implemented | `buracle plan complete` |
| The user approved the verified result | `buracle plan approve-result` |
| Verification passed, with evidence | `buracle plan verify` |
| Abandon the plan in this session | `buracle plan unregister` (the file stays) |
| Isolated branch for a plan | `buracle worktree detect --json`, else `buracle worktree create <slug> [--prefix plan-build\|goal-build\|bugfix] --json` |
| A new branch in this checkout instead of a worktree | `buracle worktree branch <slug> [--prefix plan-build\|goal-build\|bugfix] --json` (records its base for the review) |
| Diff to review | `buracle review-scope --slug <slug> --json` |
| User attention needed | `buracle notify <type> "<title>" "<message>" [--plan <path>]` |
| Before an expensive fan-out | `buracle usage --json` |
| Memory without the MCP server | `buracle mem search\|get\|write\|update\|remember\|status` (`mem search` also filters without a query: `--type`, `--since`, `--until`, `--file`, `--tag`, `--around <id>`; `buracle mem --help` lists them all) |
| Back up, restore or move a brain (only when the user asks) | `buracle mem backup [--list]`, `buracle mem restore <id> --project <slug>`, `buracle mem export [--out <file>]`, `buracle mem import <file> [--dry-run]` |
| Show a workflow's progress (the band above the prompt, the status line) | `buracle flow start <workflow>`, `buracle flow phase <id>`, `buracle flow end --outcome done` (the workflow skills say when) |
| codegraph reports that the project has no index | `buracle index ensure --cwd <project root>`, then retry |
| New repository, or AGENTS.md or project skills changed | `buracle project init --json` / `buracle project sync --json` |
| Agent guidance drifted (path rules, skill links, CLAUDE.md import)? | `buracle project check --json` (read-only; exit 2 names each fix) |
| Skills that exist only in `.claude/skills` | `buracle project sync --adopt --dry-run --json`, then without `--dry-run` (`--move` only after the user agrees) |
| Authoring skills and rules | `buracle skills list\|new\|lint`, `buracle rules lint` |
| Something in Buracle misbehaves | `buracle doctor` or `buracle doctor <harness>` (read-only) |

The workflow skill in charge (`/plan-build`, `/goal-build`, `/bugfix`) decides when each
transition happens. Arguments, outputs and exit codes for every command:
[references/commands.md](references/commands.md). Ready-made sequences:
[references/recipes.md](references/recipes.md).

## Plans and the stop guard

Status moves `PENDING → APPROVED → IN_PROGRESS → COMPLETE → VERIFIED`; `SAVED` marks a captured
native plan. While a registered plan is not `VERIFIED`, the stop guard blocks the end of your turn
and names the next action. During the plan phase it also blocks while the plan file is missing or
has validation errors; clear the `--strict` warnings too, with `buracle plan validate <path>
--strict`, before asking for approval. Phase `done` belongs to a
VERIFIED plan only: `buracle plan set phase done` runs the same checks as `buracle plan verify`.

- **Pause before you ask.** Before a question that may end your turn (approval, a material
  decision, a step only the user can do), record it:
  `buracle plan pause --kind decision --reason "<question>"` (`--kind manual` when the user must do
  something by hand). Then ask with `AskUserQuestion`. After the answer, `buracle plan resume`.
- **Escape hatch:** while a registered plan is not VERIFIED, the stop guard keeps your turn going. The only way out is a pause: `buracle plan pause` (before a real question or a hand-back), or the user saying "stop", "wait" or "hold on" (or the same in their language), which Buracle records as a pause (run `buracle plan pause --kind discussion` too). The user's "continue" or `buracle plan resume` ends it. Use it for real waits, never to dodge remaining work.
- **No routine questions.** In an approved run, never ask "should I continue?" or "should I keep
  waiting?". The question guard rejects them; keep working, or wait on the job with `TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any) and
  your harness's background facilities.
- **Approval belongs to the user.** Run `buracle plan set approved true` only after the user
  approves in answer to the approval question ("approve", "yes", "ok", "lgtm", or the same in their
  language). Outside that question, a bare "ok" is an acknowledgment, not approval.
  The only exceptions are the ones the workflow skill defines: a build run locks its own contract,
  and a plan-build plan approves itself when `plan.planApproval` is off.
- **Verified means evidence.** Run `buracle plan verify` only after the checks ran in this session
  and passed. It refuses a plan without a filled `## Evidence` section (Feature: also
  `## DoD Audit`, and `## E2E Results` when the plan has `SC-n` scenarios; Bugfix: also
  `## RED Evidence`), but the content is yours to make true.
- **Stop words.** "stop", "wait", "hold on" (Buracle also recognizes them in the user's language):
  run `buracle plan pause --kind discussion --reason "<their words>"` (harmless if the prompt hook
  already recorded it), give a status of at most five lines, end the turn. "Continue", "go on",
  "pick up where you left off": check `buracle plan status --json` and run `buracle plan resume` if
  `interaction.state` is still `paused`. "Cancel", "drop it": confirm with `AskUserQuestion`, then
  `buracle plan unregister`.
- **Do not fight the guard.** It gives up after repeated blocks without progress and lets the turn
  end if it fails. If it keeps blocking you, do the action it names, or pause with a clear reason
  and ask.

## Worktrees and review scope

- `buracle worktree create <slug> [--prefix plan-build|goal-build|bugfix] --json` → `{path, branch}` with branch
  `<prefix>/<slug>` (default prefix `plan-build`); it also sets `worktree: true` on the registered plan.
  Work inside `path`. Run `buracle worktree detect --json` first to reuse an existing one.
- `buracle worktree sync <slug> --json` squash-merges into the base. **0** merged · **2** merged
  but the user's stashed local changes were not restored (tell them to check `git stash list`;
  never pop or drop it yourself; plan files are never stashed, so the plan keeps its state) ·
  **1** nothing merged (read the error; never clean up in this state).
- `buracle worktree cleanup <slug>` after a sync that exited 0 or 2 needs no flag. `--force` is
  only for a branch squash-merged outside the CLI that cleanup cannot recognize as merged.
  `--discard` deletes unmerged work: only after the user's explicit yes.
- Never run raw `git worktree add` or `git worktree remove` for plan worktrees; the CLI keeps the
  session binding and the repository lock.
- `buracle review-scope [--slug <s>] [--base <ref>] --json` → `{mode, base_ref, diff_range,
  warning?}`. Pass `base_ref` and `diff_range` to reviewers verbatim (`git diff <diff_range>`).
  When `warning` is present, stop and resolve it before reviewing: the diff may be empty or have
  the wrong base. If it says no default branch was found, or that HEAD is the default branch, run
  it again with `--base <ref>` (the branch or commit the work started from). Never assemble a range
  by hand.

## Notifications and usage

- `buracle notify plan_approval|prd_approval|attention_needed|verification_complete|info "<title>" "<message>" [--plan <path>]`
  sends a desktop notification and records it (notifications are not memory). Send
  `plan_approval` right before waiting for a plan's approval, `prd_approval` when a PRD waits for
  review, `attention_needed` when only the user can unblock you, `verification_complete` at the
  end, and `info` sparingly for milestones in long autonomous runs. Write in the language the user
  writes in, keep titles short, never include secrets. A failed notification never blocks the work.
- `buracle usage --json` reports the 5-hour and 7-day windows (percent used, reset time) and a
  monthly estimate. Check it before a fan-out (three or more subagents, an ab-test batch, a long loop).
  At 75% or more of the 5-hour window, or 85% or more of the 7-day window, tell the user and
  prefer the cheaper path.

## Failure handling

| Symptom | Do |
|---|---|
| `buracle: command not found` | Stop and tell the user Buracle is not installed or not on PATH (`buracle install`). Never imitate the CLI with shell or by editing state. |
| Exit 2 with "no session" | See *Session resolution*. |
| Exit 1 | Read stderr, fix the input, retry at most once, then report the message. |
| Output is not valid JSON | Re-run with `--json`; if it persists, report it as a Buracle bug. |
| `plan complete` or `plan verify` refuses | Read the reason (unticked tasks, a missing evidence section) and fix that; never work around it. |
| The stop guard repeats the same message | `buracle plan status --json`; do the action it names, or pause with a reason. |
| An MCP server, hook or memory misbehaves | `buracle doctor` (read-only); report the failing checks. |

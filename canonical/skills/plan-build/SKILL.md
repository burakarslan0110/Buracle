---
name: plan-build
description: >-
  Plan-driven development through a plan file in docs/plans/: explore and clarify, write and
  review the plan, get approval, implement task by task with TDD, then verify with real
  evidence until the plan is VERIFIED. Covers features and bugfixes (behavior contract,
  reproduce first, root-cause fix). Also pauses, resumes or continues an existing plan.
  Run only when the user explicitly asks for plan-build.
when_to_use: >-
  The user invokes plan-build by name, passes a docs/plans/*.md file, or asks to write a plan and
  implement it, or to continue a plan.
invocation: explicit
argument-hint: "<task | docs/plans/<file>.md | pause | resume> [--worktree | --new-branch | --current-branch]"
mcp: [semble, codegraph, context7, web-search, web-fetch, grep, chrome-devtools, buracle-memory, context-mode]
short-description: Plan, approve, TDD-implement and verify work through a plan file
---

# Plan-build

Drive one unit of work through three phases (plan, implement, verify) around a Markdown plan file. The plan file is the source of truth, the `buracle` CLI owns its state machine, and Buracle's stop guard keeps an approved run going until it is VERIFIED.

## Ground rules

1. **The plan file decides.** Re-read it when a phase starts, after a compaction, and after any pause. Progress exists only as `- [x] Task N done` lines.
2. **State moves only through `buracle plan …`.** Never hand-edit `status`, `approved` or `phase`; raise `iterations` with `buracle plan set iterations <n>`. Edit the body freely.
3. **No production code before approval.** The plan phase reads, searches and writes the plan, nothing else.
4. **Test first.** A task with behavior starts with a failing test, then the smallest code that passes it.
5. **Evidence or it didn't happen.** Claim only what you ran, with the command and its result. Checks you could not run go under `## Unverified`.
6. **Approved means autonomous.** Never ask "should I continue?" or "should I keep waiting?". The stop guard blocks ending the run before VERIFIED; the only escape is a pause (see *Talking to the user*). The one planned stop is the result review at the end of verify ([references/verify.md](references/verify.md) V8); `plan.modelSwitch: manual` adds one right after approval ([references/plan.md](references/plan.md) P9).
7. **Use the routed tool** (*Tool routing* below). Buracle may deny shell code search or built-in web tools while the matching MCP server is healthy. When a call is denied, switch to the tool the denial names.

## Start: route by state

Strip `--worktree`, `--new-branch` or `--current-branch` from the request text: the flag answers the isolation question of [references/plan.md](references/plan.md) P4, and P9 applies it.

1. Classify the request:
   - `pause`, or the user asks you to stop or wait: run `buracle plan pause --kind discussion --reason "<their words>"`, give a status of at most 5 lines, end the turn.
   - `resume`, or the user says to continue: run `buracle plan resume`, then step 2.
   - A plan path (a PRD is handled in the next bullet): read its frontmatter. A captured native plan (`SAVED` or type `Plan`) goes straight to step 3. Otherwise run `buracle plan validate <path>` (fix errors before implementing from it), then `buracle plan register <absolute path> --phase <p>` with the phase its state implies (`plan` while `approved: false`, `verify` when `COMPLETE`, otherwise `implement`), then step 3.
   - A PRD path (`docs/prd/*.md`, frontmatter `type: prd`), alone or inside the request: requirements input, not a plan. Treat it as the task description in step 2; [references/plan.md](references/plan.md) P2 says how to carry it into the plan.
   - Abandon (`abandon`, or the user cancels the plan): confirm with {{ask_user}}, then `buracle plan unregister` and `buracle flow end --outcome cancelled`. The file stays as it is.
   - A task description: step 2.
2. Run `buracle plan status --json`. After a resume, route the bound plan in step 3. For a new task, if an unfinished plan is already bound to this session, ask with {{ask_user}}: continue that plan, or start the new one (`buracle plan unregister` first; the old plan can be resumed later by its path).
3. Route by the plan's frontmatter:

| State | Next |
|---|---|
| No plan; new or changed behavior | [references/plan.md](references/plan.md) |
| No plan; something that used to work is broken | [references/bugfix-plan.md](references/bugfix-plan.md) |
| `approved: false` (status `PENDING`) | The plan reference for its type; resume at the first unfinished step |
| `approved: true`; status `APPROVED`, `IN_PROGRESS` or `PENDING` | [references/implement.md](references/implement.md) |
| `COMPLETE` | [references/verify.md](references/verify.md) (Feature) or [references/bugfix-verify.md](references/bugfix-verify.md) (Bugfix) |
| `VERIFIED` | Done. Summarize its `## Evidence` section and change nothing. |
| `SAVED` or type `Plan` | A captured native plan. Start [references/plan.md](references/plan.md) with it as input; never execute it directly. |
| type `Build` | Not a plan-build plan. Point the user to {{skill:goal-build}}. |

Bug or feature? A bug is existing behavior that broke ("it broke", "it no longer works", an error, a crash, wrong output, a regression). Ask once with {{ask_user}} only when it is genuinely unclear. A vague idea without a clear outcome belongs in {{skill:requirements}}; suggest that instead of planning.

Read the phase reference in full before acting on it, and again after a compaction. `<slug>` is the value `buracle plan init` printed (`buracle plan status --json` shows it too).

## Phases at a glance

**Plan.** `buracle plan init --type feature|bugfix --title "<title>" --json`, then `buracle plan register <path> --phase plan`. Explore, clarify, write, then `buracle plan validate <path> --strict` until exit 0, then {{agent:plan-build-review}}, then the approval gate, which first folds in the notes the user pinned to the plan in the review page (`buracle plan notes <path> --kind plan --json`). Exit: `buracle plan set approved true`, `buracle plan set status APPROVED`, `buracle plan set phase implement`, then the chosen isolation: `buracle worktree create <slug> --json` or `buracle worktree branch <slug> --json`. A planning turn cannot end (unless paused) while the plan has validation errors; clear the `--strict` warnings yourself. With `plan.nativePlanMode: on`, a feature plan is written in the harness's own plan mode and approved on leaving it ([references/native-plan.md](references/native-plan.md)).

**Implement.** `buracle plan set status IN_PROGRESS`, mirror open tasks into {{todo}}, then per task: RED test, minimal code, GREEN, refactor, tick the box, next task. Record departures from the plan in `## Deviations`. Exit: full checks, every `buracle plan audit --json` warning cleared or explained (a `## Deviations` line, or a file the user changed named in the report), `buracle plan complete`, `buracle plan set phase verify`, then straight into verify.

**Verify.** `buracle review-scope --json` and `buracle plan audit --json`, {{agent:changes-review}} in the background, tests, types, lint and build, then the review triage and its fixes. Only then, on the final code: the real program exercised on every changed surface, E2E scenarios, a DoD audit, and a final regression. Pass: the user's notes on the changed lines (`buracle plan notes --kind code --json`), the user's result review (`buracle plan approve-result`), the worktree merge with post-merge checks (if any; [references/verify.md](references/verify.md) V9), then `buracle plan verify`. Fail: record the gaps, add fix tasks, raise `iterations` by one, back to implement.

## Progress

Buracle shows the run live, in the workflow band above the prompt and in the status line. Keep it current with `buracle flow`; the calls are cheap and best effort, so a failing one never stops the run.

- Start or resume: `buracle flow start plan-build --title "<plan title>"` (harmless when a hook already started it).
- Each phase: `buracle flow phase <id>` with `plan`, `approve` (the approval gate), `implement`, `verify`. Every phase reference makes this call at its start.
- End: `buracle flow end --outcome done` after `buracle plan verify`; `--outcome cancelled` when the plan is abandoned or its worktree discarded.

## Talking to the user

Reply and write the plan in the language of the user's prompt. Keep the markers Buracle reads (listed in the *Plain language* rule; `## Inventory` and `## Deviations` among them, which the validator and `buracle plan audit` read by these English names), commands and identifiers verbatim; every other heading and sentence follows the user's language.

**Escape hatch:** while a registered plan is not VERIFIED, the stop guard keeps your turn going. The only way out is a pause: `buracle plan pause` (before a real question or a hand-back), or the user saying "stop", "wait" or "hold on" (or the same in their language), which Buracle records as a pause (run `buracle plan pause --kind discussion` too). The user's "continue" or `buracle plan resume` ends it.

**Pause before you ask.** Once a plan is registered, before any question that may end your turn (plan approval, a material decision, a step only the user can do), run `buracle plan pause --kind decision --reason "<the question>"` (use `--kind manual` for a user action). Then ask with {{ask_user}}: 2 to 4 concrete options, your recommendation first. If {{ask_user}} is unavailable, ask in plain text with numbered options and end the turn. After the answer, run `buracle plan resume` and act on it.

Not questions: progress updates, waiting for a build, choosing between equivalent internals. Decide, record the choice if it matters, keep going. If Buracle denies a question as routine, don't rephrase it; decide and continue.

Go by the meaning of the reply, in whatever language it comes:

| User says | Means | Do |
|---|---|---|
| approve, yes, ok, lgtm | approve (as the answer to the approval question) | resume, run the approval steps |
| change, fix, add, remove, no | revise | edit the plan, re-validate, ask again |
| stop, wait, pause, hold on | pause | `buracle plan pause --kind discussion`, short status, end the turn |
| continue, go on, resume | resume, but no answer to an open decision or manual step (Buracle keeps that pause) | `buracle plan resume`, continue where the plan says; with an open decision, ask it again |
| done, finished | manual step finished | check the result, resume |
| cancel, abandon, drop it | abandon | confirm, then `buracle plan unregister` |

Any other message during a run is steering: answer briefly, fold it into the plan (record a Deviation if scope changes) and keep working. If Buracle reports the run as paused, answer and wait for the user to say "continue".

## Tool routing

Follow *Tool routing (strict)* in your rules (it lists the fallbacks): semble for code by intent (`find_related` for similar code), codegraph for callers and blast radius, `rg` for exact strings, context7 for library APIs at the installed version, web-search then web-fetch for web facts, grep for public usage of an API, buracle-memory (`memory_search`, then `memory_get`) for earlier decisions, chrome-devtools for web UIs, context-mode (`ctx_batch_execute`, `ctx_execute`) for long test, build and log output, printing the counts and every failure.

Read the line ranges you need, not whole large files. An empty search result is not proof of absence: rephrase once or switch tools. If a server is down, use the fallback and say so in the report.
<!-- harness:omp -->
omp has no chrome-devtools server: wherever this skill says chrome-devtools, use omp's built-in browser tool.
<!-- /harness -->

## Lanes and documents

Work that splits runs in parallel per the *Parallel agents* rule: you are the lead, each lane is an agent you launch with {{spawn_agent}}, and you integrate.

| Phase | Lanes | Mode | Each lane returns | Then you |
|---|---|---|---|---|
| plan (P3) | 2 to 4 explorers: the code map of the touched modules; the tests, fixtures and commands; the docs and prior decisions in memory; outside facts and prior art | read-only | `path:line` facts and the exact commands | write the plan from the reports |
| implement (I1) | one lane per group of unticked tasks whose files do not overlap and that wait for no unfinished task | editing; with 2 or more lanes, each in `buracle worktree create <slug>-<n> --lane` | the commits on its branch, the RED and GREEN output, the `Verify:` result | `buracle worktree sync <slug>-<n>` in plan order, the full checks after every merge, the ticks |
| verify (V1 to V5) | the changes review in the background; one lane per non-UI `SC-n` scenario when there are 2 or more | read-only | the JSON report; the scenario's command → result | run V2 yourself meanwhile, fix in V3, then the DoD audit (V6) and the final regression (V7) on all the evidence |

Tasks that share files or build on each other stay in your session, in order. Only you write the plan file.

**Parallel plans.** Independent features or fixes can each run as a whole workflow (plan-build, goal-build, bugfix) in a plan lane:

1. Per lane: `buracle worktree create <slug> --lane --json` (it records your session as the lane's owner). The lane's plan file stays in your checkout, never in the lane worktree: `worktree sync` refuses a worktree with uncommitted changes, and `plan verify` rewrites the file's header after the merge. Create it from your checkout (`buracle plan init --type feature|bugfix|build --title "<t>" --slug <slug> --json`), or let the lane create it with `--dir <your checkout>/docs/plans` (`plan init` takes no `--lane`). Then brief the lane with the workflow, the task, the worktree path, the plan file's absolute path and the rule: register that path with `--lane <slug>` and pass `--lane <slug>` on every other `buracle plan` command, change code only in that worktree (the plan file is the one exception), skip `buracle flow`, launch no agents, ask the user nothing.
2. The lane keeps its own binding (`buracle plan register <path> --lane <slug>`), so yours stays as it is; `buracle plan status --json` lists each lane under `lanes`. No stop guard holds a lane: check its report and its plan.
3. At a gate (plan approval, a goal-build lock, a real question, the result review) the lane pauses its own binding and returns `blocked` with its plan path. A goal-build lock is the run's own commitment, but `buracle plan set approved true` is still yours to run. You run the reviewers on its plan or diff (recorded with `--lane <slug>` too, so your compaction texts name them), ask the user where the gate needs them, record the result with the same `--lane <slug>` (`buracle plan set approved true --lane <slug>`, `buracle plan approve-result --lane <slug>`), and continue the lane or brief a new one.
4. Merge each lane in dependency order with `buracle worktree sync <slug>` and run the checks after every merge. Then `buracle plan verify --lane <slug>` while the lane worktree still exists (it needs the lane's worktree metadata, not its plan file), and only then `buracle worktree cleanup <slug>`.

Write the plan and the final report per the *Plain language* rule, in the language of the user's prompt: the main message first, and a flow diagram when the change touches more than two modules. The user approves the plan file itself; the final report goes in the reply.

## Review agents

Launch reviewers with {{spawn_agent}} and pass inputs as labeled lines. In the input blocks of this skill, the first line names the agent to launch and the remaining lines are its prompt. Run reviewers in the background when the harness supports it and meanwhile keep to work that does not edit files under review; collect the final message before deciding anything.

```text
{{agent:changes-review}}
plan_file: /abs/repo/docs/plans/2026-10-08-rate-limit.md
slug: rate-limit
base_ref: main
diff_range: main...HEAD
worktree_path: /abs/repo/.worktrees/rate-limit
changed_files: src/middleware/rate-limit.ts, src/server.ts, tests/middleware/rate-limit.test.ts
audit: clean (buracle plan audit: 3 changed paths, 0 warnings)
test_commands: bun test; bunx tsc --noEmit
evidence: Task 1 Verify `bun test tests/middleware/rate-limit.test.ts` → 6 pass, 0 fail
Return only your JSON report.
```

Leave out lines that don't apply (`worktree_path` outside worktree runs). A reviewer that runs in the background gets a record right after the launch, `buracle plan review start --role plan|changes --handle <the agent's id or session id>`, so that after a compaction you collect it instead of launching a second one (the restore text names it). After the triage, `buracle plan review done --role <role> --verdict <pass|needs_changes|incomplete>` anchors it; a later warning from `buracle plan set approved true`, `approve-result` or `verify` that it is stale means a re-run when the change added a task, behavior or code path. `plan.reviews.plan` and `plan.reviews.changes` (`buracle config get plan`) can switch a reviewer off; the phase references say what replaces it. The final message must be one JSON object: `verdict` (`pass` or `needs_changes`), `summary` (starting with the reviewed file's path), `findings` (`severity` `must_fix`, `should_fix` or `suggestion`, with `category`, `title`, `evidence`, `suggested_fix`, optional `file` and `line`), optional `goal_score` (0–100), and from the changes review `truths` (`verified`, `failed` or `unverified`, with `evidence`). Missing, malformed, or about another file: relaunch once; if it fails again, review against the same concerns yourself and say so. Check every finding against the code before acting. Fix `must_fix`. Fix `should_fix` or record why not under `## Review Notes`. Apply cheap in-scope suggestions.

**Second opinion** (`reviews.companion` in `buracle config get plan`, `off` by default): right after a reviewer starts, run `buracle plan review companion start --role plan|changes --input -` with the reviewer's input lines (all but the first) on stdin, as a heredoc. It runs the same review read-only on another installed harness, in the background, once per plan and role. Before the triage, `buracle plan review companion collect --role <role> --wait 90 --json` (again while it says `running`). Triage its findings like the reviewer's and weigh both equally; it records itself. When it says `unavailable` or `failed`, go on without it and write one line under `## Review Notes`.

## When things go wrong

- `buracle: command not found`: stop and tell the user Buracle is not installed or not on PATH. Never imitate the CLI by editing session state by hand.
- A `buracle plan …` command exits 2 with "no session": continue from the plan file, tell the user once that the stop guard is not protecting this run, and suggest `buracle doctor`.
- `buracle plan validate` exits 1 (errors) or 2 (warnings under `--strict`): fix and re-run until exit 0.
- `buracle plan complete` or `buracle plan verify` refuses: read the reason (usually unticked tasks or a missing evidence section) and fix that; never work around it (`plan set phase done` runs the same check).
- The same failure three times, or blocked on something only the user can provide: `buracle notify attention_needed "<title>" "<blocker>" --plan <path>`, pause with `--kind decision`, explain the blocker and offer options (new approach / accept as a known issue / stop).
- Context filling up: keep checkboxes, Deviations and evidence current in the plan; it is your memory across a compaction.

## Done means

`buracle plan verify` succeeded and the plan holds complete `## Evidence` (ending with the final regression, plus the post-merge checks after a worktree merge), `## E2E Results` and `## DoD Audit` sections (a Bugfix plan instead: `## Evidence` with the RED proof, the fix-location check, the symptom re-run and the final regression), plus `## Unverified`. Then:

1. `buracle notify verification_complete "<title>" "<one line>" --plan <path>`, then `buracle flow end --outcome done`
2. Memory: up to three memories worth keeping beyond this plan, with `memory_write` (decisions with their rationale, non-obvious gotchas, procedures that took real effort). Run `memory_search` first and update instead of duplicating. Never store secrets, logs or plan state.
3. Final report:

```text
**<title>**: VERIFIED · iterations: <n>
Changed: <files, grouped by area>
Evidence: <surface: command → result>, one per line
E2E: SC-1 pass · SC-2 pass
Review: <fixed> / <declined, with reasons> / <follow-ups>
Unverified: <items, or "none">
Merge: <squash-merged into main, post-merge checks green | kept at plan-build/<slug> | on branch plan-build/<slug> | not isolated>
```

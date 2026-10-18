# Implement phase

Outcome: every task ticked with its DoD proven, full checks green, status COMPLETE, and verification started in the same run. You do not stop to check in with the user; the stop guard keeps the run alive until VERIFIED.

## I0. Setup (also the resume point after a compaction)

1. `buracle plan status --json`. Confirm the plan is approved. If it is not, go back to the plan reference: never write production code for an unapproved plan. If `phase` is not `implement`, run `buracle plan set phase implement`.
2. Mark the phase: `buracle flow phase implement`. Re-read the whole plan file.
3. Worktree runs (`worktree: true` in the frontmatter): `buracle worktree detect --json`. If you are not inside it, find it with `buracle worktree status --json`, or create it with `buracle worktree create <slug> --json` if it does not exist. All edits and commands happen under that path. The plan file stays at its registered path; keep ticking boxes there.
   - **If create or detect fails**, read the `error` code in its JSON (`path_in_use`, `path_exists`, `branch_checked_out`, `inside_worktree`, `locked`, …), fix what it names and retry once. Still failing: `buracle plan pause --kind decision --reason "<code>: <message>"` and ask: fix it by hand / switch to a new branch (`buracle worktree branch <slug> --json`, then `buracle plan set worktree false` and the `## Assumptions` isolation line from [plan.md](plan.md) P9) / stop. Never edit in the main checkout while the plan says `worktree: true`.
   - Branch runs (the `## Assumptions` isolation line names a new branch): compare `git branch --show-current` with the branch on that line. Same branch: carry on. Another branch: `git switch <that branch>` (commit or stash first if git refuses). Do not re-run `buracle worktree branch` for this: without this session's plan binding it cannot tell the run's branch apart and creates a new `-2` branch.
4. `buracle plan set status IN_PROGRESS` unless it already is.
5. Your plan/todo tool where available (`update_plan` in Codex, the todo tool in Oh My Pi; OpenCode v2 has none): one item per unticked task, in plan order. The plan stays authoritative; the todo list is your working view of it.

## I1. Task loop

Repeat for each unticked task, in order. When 2 or more unticked tasks have no file in common and wait for no unfinished task, run them as lanes instead (SKILL.md, *Lanes and documents*): each lane runs steps 2 to 8 in its own `--lane` worktree and commits there; you sync each lane, run the full checks after every merge, then do step 9 for its tasks. A lane whose worktree cannot be created does not start: run its tasks yourself, in order. Never run an editing lane in the shared checkout. The tasks that remain follow the loop below.

1. Mark the task in progress in your plan/todo tool where available (`update_plan` in Codex, the todo tool in Oh My Pi; OpenCode v2 has none) and re-read its card.
2. Prepare with the routed tools: codegraph for callers of anything shared you will change (they must keep working), context7 for every library call you will write, semble `find_related` for the local pattern to follow.
3. **RED.** Write the test for the first DoD behavior and run only that test. It must fail because the behavior is missing, not because of a typo, an import error or a wrong path. Keep the key failing line.
4. **GREEN.** Write the smallest code that makes it pass. Run the test, then the tests of every module you touched.
5. **Refactor** names and duplication while green, then re-run the same tests. On a hot path (a request handler, a render, a polling loop, a CLI inner loop), check that expensive work (parsing, I/O, serialization, a heavy import) does not repeat while its input is unchanged.
6. Repeat steps 3 to 5 for the remaining DoD behaviors.
7. **Prove.** Run the task's `Verify:` command. If the task changes something you can run (a CLI, an endpoint, a page), exercise it once for real now instead of leaving everything to verification.
8. **Diagnostics.** Fix type and lint errors in touched files; Buracle's edit checker may already have reported them.
9. **Tick.** Change the task's line to `- [x] Task N done` immediately and complete its item in your plan/todo tool where available (`update_plan` in Codex, the todo tool in Oh My Pi; OpenCode v2 has none). In a worktree run, commit the task on the worktree branch: `git add <task files>` and `git commit -m "task N: <title>"`. Outside a worktree, commit only if the user asked for commits.
10. Move to the next task without checking in.

Exceptions:

- **Nothing testable** (the DoD says so: config, docs, pure wiring): skip RED and GREEN and produce the evidence the DoD names instead.
- **User action task:** `buracle notify attention_needed "<title>" "<what to do>" --plan <path>`, then `buracle plan pause --kind manual --reason "<exactly what the user must do>"`, then ask with your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi) (or in plain text, ending the turn). When the user confirms ("done", "finished", in any language), check the result yourself, run `buracle plan resume`, tick the task and continue.

## I2. When reality differs from the plan

- **Tactical** (same goal, small detour: an extra helper file, a renamed internal function, a new test fixture): do it, add the path to the task's Files, and append a line to `## Deviations` (create the section the first time):
  `- Task 3: split parsing into src/parse/header.ts — the original file passed 800 lines (files: src/parse/header.ts)`
- **Material** (changes user-visible behavior, scope, a public API or schema, adds a dependency, or makes a DoD impossible): `buracle plan pause --kind decision --reason "<the question>"`, present the options with your recommendation through your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi), apply the answer to the affected tasks and DoD, record a Deviation, then `buracle plan resume`.
- **Extra work outside the scope:** do not do it. List it under `## Follow-ups`.
- **A shortcut you accept on purpose** (a limit that is fine for now): mark it in the code with a `SHORTCUT:` comment that names the limit and what should trigger the upgrade, in the project's comment style (`// SHORTCUT: in-memory only; move to Redis when we run more than one instance`). Where the project allows no such comments, write the same line under `## Deviations`. Verification collects them.

Keep the `## Deviations` and `## Inventory` headings in English, as written here: `buracle plan audit` reads them.

## I3. Waiting and long commands

Run slow builds and test suites in the background when the harness supports it, and do independent work meanwhile. Poll the job; never ask whether to keep waiting. If a command hangs, stop it, find out why from its output or logs, and retry once with a timeout.

## I4. Bugfix plans (type Bugfix)

The task loop applies with these overrides:

- **Task 1 stops at RED.** It leaves a test that fails on the unfixed code with the Actual symptom from the behavior contract, and writes no production code. Record the proof under `## RED Evidence` (the command and the key failing lines), then tick the task. Verification relies on that record.
- **Task 2 turns it GREEN** by changing code at the root cause the plan names. If you find the cause elsewhere, that is a material deviation: pause and ask, because the approval was given for a different cause.
- **Task 3 is the quality gate:** full suite, type check, lint, build, and the original reproduction from the plan.
- **No exemptions.** The "nothing testable" exception does not apply to bugfix plans. The only exception is one the approved plan already documents (a test that is technically impossible).
- **Scope of test runs:** Tasks 1 and 2 run scoped tests only; the full suite belongs to Task 3.
- Remove every `BURACLE-DEBUG` line before ticking Task 2.

## I5. Finish the implementation

1. `buracle plan status --json` must show every task done.
2. `buracle plan audit --json` compares the tasks' Files with the diff (codes in [verify.md](verify.md) V0). Clear every warning: do the missing work, or add the path to its task's Files with a `## Deviations` line, or leave out a path the user changed and say so. Every `## Inventory` row must name a ticked task or a reason for dropping it.
3. Run the full test suite, the type check, lint and the build once. Fix what you broke. A failure counts as pre-existing only if you reproduce it on the base revision (the base branch, or `HEAD` when your changes are uncommitted) in a throwaway checkout: `git worktree add --detach "${TMPDIR:-/tmp}/base-<slug>" <base>`, run the same command there, then `git worktree remove --force` that path. Record it under `## Deviations` and leave it alone.
4. `buracle plan complete` (status COMPLETE).
5. `buracle plan set phase verify`.
6. Continue in the same run with [verify.md](verify.md) for a Feature plan or [bugfix-verify.md](bugfix-verify.md) for a Bugfix plan.

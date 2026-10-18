# Verify phase (feature)

Outcome: the plan is VERIFIED on evidence you produced in this phase, or it goes back to implement with the gaps written down. Tests passing is necessary, never sufficient: the real program must show the behavior.

Order matters: finish every code fix (review findings included) before you record runtime and E2E evidence, then prove the final tree once more. Evidence about code that changed afterwards is no evidence.

## V0. Setup

1. `buracle plan status --json`: status COMPLETE. If `phase` is not `verify`, run `buracle plan set phase verify`. Mark the phase: `buracle flow phase verify`. Re-read the whole plan.
2. Worktree run: work and run commands under the worktree path (`buracle worktree detect --json`).
3. Scope: `buracle review-scope --json` (add `--slug <slug>` in a worktree run). It returns `mode`, `base_ref`, `diff_range` and possibly `warning`. A `warning` means the diff is probably wrong or empty (uncommitted worktree changes, wrong base): resolve it before anything else, because every later check reads this diff. When the warning says no default branch was found, or that HEAD is the default branch, re-run it with `--base <ref>` naming the branch or commit this run started from (a branch made with `buracle worktree branch` records its base, so review-scope already uses it); never assemble a range by hand.
4. Plan against diff: `buracle plan audit --json` (same `--slug` and `--base` as step 3) compares every task's Files with the diff. Exit 0: the diff matches. Exit 2: each warning is one of these:
   - `unimplemented`: a planned Create or Modify path the diff does not change, or a Test path that does not exist. An existing Test path the diff leaves alone is only `info`: fine when the task only runs that test, a gap when the task was to extend it.
   - `delete-pending`: a Delete path still exists, or the diff does not delete it.
   - `rename-mismatch`: a Rename whose old path still exists, whose new path is missing, or that the diff does not show.
   - `unplanned`: a changed path that no task and no `## Deviations` line names.
   - `inventory-open`: an `## Inventory` row whose task is missing or not ticked.

   Work that is missing is a gap (V8). A file you changed without a reason on record gets a Deviation entry, or you undo your own change. Never revert a file this run did not change: in `working-tree` mode the diff can include the user's own edits. Name those in the report and leave them out of `changed_files`.
5. Your plan/todo tool where available (`update_plan` in Codex, the todo tool in Oh My Pi; OpenCode v2 has none): one item per step V1 to V10.

## V1. Launch the changes review

Launch changes-review with your subagent tool (`spawn_agent` in Codex, `subagent` in OpenCode, `task` in Oh My Pi), in the background when the harness supports it, using the input block from SKILL.md (*Review agents*): `plan_file`, `slug`, `base_ref`, `diff_range`, `worktree_path` (worktree runs), `changed_files`, `audit` (the V0 audit result: "clean", or its warning lines), `test_commands` (the checks you run in V2, V4 and V5), `evidence` (the task `Verify:` results you already have), and `user_request` if you still have it verbatim. Record it at once: `buracle plan review start --role changes --handle <the agent's id or session id>`. With `reviews.companion` not `off`, start the second opinion too (SKILL.md, *Review agents*, `--role changes`). Run V2 while they work; collect the reports in V3.

**Review off** (`reviews.changes: false` in `buracle config get plan`; a Bugfix plan ignores it, see [bugfix-verify.md](bugfix-verify.md) BV1): do not launch it. In V3, review the diff yourself against the concerns in changes-review's instructions (plan deviations, correctness, regressions, error handling, security, tests, docs) and add "independent review off (plan.reviews.changes)" under `## Unverified`.

## V2. Automated checks

Run each check and record it in `## Evidence`, one row each:

| Check | Command | Result |
|---|---|---|
| Test suite | `bun test` | pass, 212 tests, 0 skipped |

- Full test suite, type check, lint or format check, and the build (the production build if the project has one).
- Every task's `Verify:` command.
- Diff hygiene, using `rg` scoped to the changed files: no `BURACLE-DEBUG`, no stray debug prints, no tests you focused or skipped (`.only`, `.skip`, `xit`, skip markers), no commented-out code blocks, no secrets, no new `TODO` or `FIXME`.
- Size: a changed source file over about 800 lines gets a note; over 1,000 lines, split it or justify it.
- Docs: if user-facing behavior, CLI flags, configuration or an API changed, the README, docs or help text changed with it.
- Coverage, only where it already exists: when the change touches a critical path (business logic, security, data integrity, error handling) and the project has a coverage command, run it and compare the changed files with the base revision (in a throwaway checkout, as in [implement.md](implement.md) I5). A drop on a critical path is a gap. There is no numeric target, and you never add coverage tooling for this.
- Hot paths, by reading: for each changed file on a hot path (a request handler, a render, a polling loop, a CLI inner loop), expensive work (parsing, I/O, serialization, a heavy import) must not repeat while its input is unchanged. Note what you find; fix it in V3 together with the review findings, or record why not under `## Review Notes`.
- Over-engineering, by reading: an abstraction with one implementation, a dependency the standard library already covers, configuration for a value that never changes, or code nobody asked for. Note it; simplify it in V3 together with the review findings, or record why not under `## Review Notes`.
- Shortcuts: `rg -n "SHORTCUT:"` over the changed files. Each marker names its limit and what should trigger the upgrade; a marker without both is a gap. List every marker under `## Follow-ups`.

A pass means exit code 0 and output that says what you expected: the test count did not drop and nothing was silently skipped.

## V3. Review triage

Collect the changes-review report (wait for it if it is still running) and validate it (SKILL.md, *Review agents*); collect the second opinion too when one runs. Then, for both reports alike:

- Check each finding against the code before acting; reviewers can be wrong.
- **In scope** (the file is listed in the plan's tasks or Deviations, or this run changed the line): fix every `must_fix` and `should_fix` now, together with your hot-path and over-engineering notes from V2, then re-run the focused tests and the V2 checks the fix touches.
- **Out of scope:** do not fix it; list it under `## Follow-ups`.
- **Truths:** a `failed` truth is a gap until fixed. Every `unverified` truth must be settled by your own evidence: note which V4, V5 or V6 row will settle it, or run the check the reviewer named. A truth nobody settles goes to `## Unverified`.
- Decline a finding only when it is wrong or conflicts with the approved plan, and write the reason under `## Review Notes`.
- **Scoped re-review:** when a fix added a function, an API or a code path, launch changes-review once more with `changed_files` set to the files those fixes touched and `focus: the fixes for <finding titles>`, and triage it the same way. The second opinion does not run again.
- Record the collected review once the fixes are in: `buracle plan review done --role changes --verdict <pass|needs_changes|incomplete>`. It anchors the review to the files it covered; `buracle plan approve-result` and `buracle plan verify` warn when one of them changes afterwards or a new file joins the diff. On that warning, re-run the scoped review for the change, or say in the report why it needs none.

From here on the code is final. A later fix (a failing scenario, a DoD gap) sends you back through V2 and V3 for the files it touched.

## V4. Run the real program

For each changed surface, collect the evidence that matches it:

| Changed surface | Evidence that counts |
|---|---|
| Library or internal function | a test through the public API, plus one direct call from a script or REPL showing the result |
| CLI | the exact command with realistic arguments: output and exit code, plus one error case |
| HTTP API | server started on the new code; `curl -i` each endpoint: status, body, headers; plus one invalid request |
| Web UI | chrome-devtools: open the page, perform the flow, check DOM text and console errors, take a screenshot; plus one empty or error state |
| Background job or worker | trigger it; check its effect (row, file, message) and its logs |
| Config, build or CI | run the command that consumes it (build, CI script locally, deploy dry run) |
| Data migration | run it on a copy or fixture; check counts and a sample; run the rollback if there is one |
| Docs only | render and link check |

**Prove you are running the new code.** Before starting a server, check that its port is free (`lsof -i :<port>`, or `netstat -ano` on Windows): a busy port means an old process would answer. Stop it if this run started it, otherwise use another port. Rebuild and restart, then confirm through something only the new code produces (a new field, a log line, a version string). Evidence from a stale process is no evidence.

Never point at production or shared environments without the user's explicit permission.

## V5. E2E scenarios

Run each `SC-n` scenario from the plan against the running program; UI scenarios go through chrome-devtools, one at a time in your own session. With 2 or more non-UI scenarios, give each to a read-only lane with the program's address and the scenario text (SKILL.md, *Lanes and documents*), and check one of their transcripts yourself. Record the outcome:

```markdown
## E2E Results
| Scenario | Result | Evidence |
|---|---|---|
| SC-1 | pass | 100× 200, then 429 with Retry-After: 37; key B 200 (curl transcript in Evidence) |
```

A failing scenario is in scope: fix it (then V2 and V3 for the touched files) and re-run, at most twice in this phase. After that it becomes a gap.

## V6. DoD audit

Check every DoD bullet of every task, and the plan's "Done when" lines, against the evidence you now hold. Add one row per mitigation in `## Risks` (the code or check that shows it is in place; an accepted risk or "None." needs no row) and one row per `## Inventory` row (the test or run that shows the old behavior still works where its task keeps it):

```markdown
## DoD Audit
| Task | Result | Evidence or gap |
|---|---|---|
| 1 | met | Evidence rows 1–3, SC-1 |
| Risk: the migration is reversible | met | Evidence row 6: the down migration restores all 120 rows |
```

Then settle each `unverified` truth from V3 with the row that covers it, or move it to `## Unverified`.

## V7. Final regression

Prove the final tree: the full test suite, the type check, lint and the build, each as an `## Evidence` row. You may reuse a V2 row instead of running the check again only when no file changed after it: `git status --porcelain` and `git diff --stat` print the same as when that row was recorded. A V4 or V5 row recorded before a later fix that touched its surface is re-run, or marked "superseded" with the new row next to it.

## V8. Decide

Everything in V2 to V7 green: the user's code notes and the result review below, then V9. Otherwise loop back to implement:

1. Add or extend `## Gaps` with one line per failure, prefixed with the iteration: `- Iteration 1: SC-2 fails, 429 missing Retry-After (Evidence row 7)`.
2. Append fix tasks at the end of `## Tasks` (`### Task N: Fix …`, with Files and a DoD that ends in `Verify:`).
3. Raise `iterations` by one: `buracle plan set iterations <n>`.
4. `buracle plan set status IN_PROGRESS`, then `buracle plan set phase implement`.
5. Continue with [implement.md](implement.md). No user prompt is needed.

If the same gap survives three iterations, or closing it needs a product decision: `buracle notify attention_needed "<title>" "<gap>" --plan <path>`, `buracle plan pause --kind decision --reason "<gap>"`, then ask: try a different approach / accept it as a known issue (it moves to `## Unverified`) / stop.

### The user's code notes

The user may pin notes to changed lines in the review page (`/brain review`). Before the result review, and again after the user answers it, run `buracle plan notes --kind code --json` (add `--slug <slug>` in a worktree run). Each open note is a required change at its file and lines; a note on a file this run did not change is a question for the user. Fix each one, re-run the checks the fix touches and record them in `## Evidence`, then mark it with `buracle plan notes --done <id>[,<id>]`. No notes is never an approval. This check always runs before V9: the merge removes the worktree the notes point at.

### The result review

While `plan.resultApproval` is on (the default), the user reviews the verified result before anything is merged or marked verified. This is the one planned stop between the approved plan and VERIFIED; `buracle plan verify` refuses until the approval is recorded.

1. `buracle plan pause --kind decision --reason "result review"` and `buracle notify plan_approval "<title>" "Ready for your review" --plan <path>`.
2. Show at most 15 lines: what changed, the checks that passed (command → result), the runtime evidence, `## Unverified`, and the review findings you declined. In a worktree run, put the V9 merge choice into the same structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi) call.
3. Ask with your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi): approve the result (recommended) / request changes / I will test it first.
   - Approve: `buracle plan approve-result` (it ends the pause), then V9 and V10.
   - Request changes (in the reply, or as notes on the review page; read them as above): `buracle plan resume`. Make a small in-scope fix, re-run the checks it touches and record them in `## Evidence`; send anything larger through the loop back above. Then ask again from step 1.
   - Test first: keep the pause and end the turn; ask again when the user reports back.

Only an explicit approval of this result counts. A bare "continue", silence or green checks are no approval, and Buracle keeps the pause on a bare "continue".

## V9. Worktree merge

Worktree runs only, before marking anything verified (a run on a branch made with `buracle worktree branch` has nothing to merge; the report names the branch):

1. Commit everything in the worktree; `git -C <worktree> status --porcelain` must print nothing.
2. If the result review already took the merge choice, act on it. Otherwise `buracle plan pause --kind decision --reason "merge decision"`, show the summary from `buracle worktree diff <slug> --json` and ask with your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi): squash-merge into the base, then remove the worktree and its branch (recommended) / keep the worktree for manual review / discard the work. Then `buracle plan resume`.
3. Squash-merge: `buracle worktree sync <slug> --json`, then act on the exit code:
   - **0**: merged. Run the post-merge checks below, then `buracle worktree cleanup <slug>` (after this sync it needs no `--force`).
   - **2**: merged, but local changes stashed before the merge (never the plan file) could not be restored. Do not pop or drop the stash. Tell the user their earlier local changes are in `git stash list` and need a manual `git stash pop`. Run the post-merge checks and clean up as for 0.
   - **1**: nothing merged. Read the error (conflict, dirty base, lock). If the base moved on, merge it into the worktree branch (`git -C <worktree> merge <base>`; never rebase), resolve conflicts in files this run changed, re-run the checks and retry once; otherwise pause and ask. Never clean up in this state.
4. **Post-merge checks**, in the main checkout, because the base may have moved on: the full test suite, the type check, lint, the build, and one smoke run of a changed entry point (run the CLI command, start the server and send one request, or load the page). Record each as an `## Evidence` row marked post-merge. A failure is fixed on the base branch as a separate commit (`fix: post-merge regression from plan-build/<slug>`), then every post-merge check runs again. Do not verify before all of them are green.
5. Keep: leave the worktree; the report names the branch and path. Discard: confirm a second time, then `buracle worktree cleanup <slug> --discard`, `buracle plan unregister` and `buracle flow end --outcome cancelled`. A discarded plan is not VERIFIED.

## V10. Mark verified

Only when `## Evidence` (with the final regression, and the post-merge rows after a merge), `## E2E Results` and `## DoD Audit` are complete and green, or the user accepted the listed gaps:

1. Write `## Unverified`: each check you could not run, why, and the risk it leaves. Write "none" if there is nothing.
2. `buracle plan verify`
3. Notification, memories and the final report: SKILL.md, *Done means*.

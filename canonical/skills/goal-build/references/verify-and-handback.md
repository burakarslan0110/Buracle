# Phases 6–7: verify and hand back

Outcome: an honest record of what was proven, then one of four outcomes reported to the user. Only the done outcome marks the run VERIFIED.

## 6. Verify

Run this phase for the done, round-limit and not-achievable outcomes: the code is finished even when a criterion is not. Skip it only for the blocked outcome, where the artifact is half built by design.

**Verification off** (the lock printed `goalVerification off`, and the `Switches:` line under `## Assumptions` says so): a criteria-only build. Skip this phase. Write "Verification: disabled (plan.goalVerification)" under `## Unverified`, keep the status `COMPLETE` (never `buracle plan set phase verify`, never `buracle plan verify`, which refuses such a run), and hand back as *Done with verification off* in phase 7. The report says that nothing beyond the criteria was checked. A worktree run keeps its worktree (it merges only when a build verifies); the report names its branch and path, and the user decides about the merge.

- Done (every criterion passed in the last judge round): you already ran `buracle plan set phase verify`.
- Round limit or not achievable: run only `buracle flow phase verify`, never `buracle plan set phase verify`. In phase verify the stop guard asks for `buracle plan verify`, which refuses a run with a failing criterion; the pause in phase 7 is this run's exit.

Mark the phase: `buracle flow phase verify`.

1. **Profile.** Record it as the first row of `## Evidence`. It decides how the artifact is exercised, never whether code is checked:

   | Profile | What changed | Layers that run |
   |---|---|---|
   | Minimal | no code: documents, designs, research | Criteria, Docs; rendering, links and fact checks replace the suite and the build |
   | API | code with a CLI, a server or a library, no UI | every layer except the browser walk of User paths |
   | Full | code with a UI or another user-facing entry point | every layer |

2. `buracle review-scope --json` (add `--slug <slug>` in a worktree run). A `warning` means the diff is probably wrong or empty; resolve it first.
3. Launch {{agent:changes-review}} with {{spawn_agent}}, in the background when the harness supports it, and record it at once (`buracle plan review start --role changes --handle <id>`); with `reviews.companion` not `off`, start the second opinion too (`--role changes`; SKILL.md, *Review agents*). With `reviews.changes` off at the lock, do not launch it: review the diff yourself against changes-review's concerns, and the Review layer goes under `## Unverified` as "independent review off (plan.reviews.changes)".

   ```text
   {{agent:changes-review}}
   plan_file: <absolute run file path>
   slug: <slug>
   base_ref: <from review-scope>
   diff_range: <from review-scope>
   worktree_path: <worktree path; worktree runs only>
   changed_files: <every path in ## Files Touched, the untracked files it names included>
   test_commands: <suite, types, lint, build>
   evidence: <the last judge round's ruling lines, one per criterion>
   Return only your JSON report.
   ```

4. Prove each layer and record it in `## Evidence` (Layer | Command or method | Result), every command as the command plus `pass` or `fail`, never as prose. A layer you cannot run goes under `## Unverified` with the reason and the risk it leaves, never into `## Evidence` as passed.

   | Layer | Required evidence |
   |---|---|
   | Criteria | the last judge round, every row ruled |
   | Tests | the full suite |
   | Static checks | types, lint, build |
   | Sweeps | the least-that-works and shortcut sweeps below |
   | Runs at all | start the program and read its logs for errors; run the primary path with real input; where it processes external data, fetch that data independently and compare |
   | User paths | for a UI, a browser walk with chrome-devtools for each user-facing flow, console clean, on the target `## Live Target` names (the *Browser automation* path rule has the details); for a CLI or API, the same paths at the command or endpoint. Cover the edges too: empty, invalid, stale, error, boundary |
   | Review | changes-review collected and triaged |
   | Docs | README, help text or docs updated for every changed behavior, or "no doc impact" |
   | Regression | the full suite again after the last fix |

   Sweeps over the changed files:
   - **Least that works:** an abstraction with one implementation, a dependency the standard library already covers, configuration for a value that never changes, boilerplate nobody asked for: remove it.
   - **Shortcuts:** `rg -n '(#|//) ?SHORTCUT:' <changed files>`. Every marker this run added names its ceiling and the trigger for upgrading it; list the open ones in the report.
   - **Size:** a changed production file over 800 lines is worth a split; over 1000, flag it in the report.

5. Review triage (the second opinion's findings too, collected first): check each finding against the code. In-scope findings (paths in `## Files Touched`) at `must_fix` or `should_fix` get fixed; then re-assert the live target's identity, re-run the affected layers and re-judge the criteria they touch. A finding on a file outside the ledger is mention-only, whatever its severity: list it under `## Follow-ups` and never fix it in this run (it may be the user's own edit). The one exception is a file this run changed but did not record: add it to `## Files Touched`, then triage the finding. Record declined findings with the reason under `## Review Notes`. A `failed` truth blocks the done outcome until fixed; settle each `unverified` truth with a row from `## Evidence`, or list it under `## Unverified`. A fix that added a function, an API or a code path gets one scoped re-review (`changed_files` = the fixed files). Then `buracle plan review done --role changes --verdict <verdict>`; `buracle plan verify` warns when a reviewed file changes afterwards.
6. The user's notes on the changed lines: `buracle plan notes --kind code --json` (add `--slug <slug>` in a worktree run). Fix each open note on a path in `## Files Touched`, re-run the layers it affects, re-judge the criteria it touches, and mark it with `buracle plan notes --done <id>[,<id>]`; a note on any other file goes into the report as a question. This runs before the worktree merge in phase 7, which removes the worktree the notes point at. No notes is never an approval.
7. Write `## Unverified`: every check that could not run, the reviewer that did not answer, the layer the profile skipped, each with its reason. "None." is valid when it is true. Then walk the layer table once more: each layer has a row in `## Evidence` or in `## Unverified`. `buracle plan verify` checks the verdicts and that `## Unverified` exists; this walk is yours.

## 7. Hand back

Mark the phase: `buracle flow phase handback`.

| Outcome | When |
|---|---|
| done | every criterion passes and verification is complete |
| round limit | four judge rounds used and criteria still fail |
| blocked | the next step needs something outside the session |
| not achievable | every criterion still failing meets the not-achievable conditions ([build-and-judge.md](build-and-judge.md), step 7), and no closable criterion is left |

**Done:**

1. Worktree run: merge as described in *Worktree merge* below, before anything is marked verified.
2. `buracle plan verify`. It refuses while any criterion is not `pass`, a row of the criteria table is not a `C<n>` row, or `## Unverified` is missing; a refusal means you are not at done.
3. `buracle notify verification_complete "<title>" "<one line>" --plan <path>`, then `buracle flow end --outcome done`
4. Memory: up to three memories worth keeping, with `memory_write` (decisions with their rationale, non-obvious gotchas). Run `memory_search` first and update instead of duplicating; never store secrets or logs.
5. Deliver the report.

**Worktree merge** (done outcome, worktree runs only). The user chose "separate worktree, squash-merged and removed when the build verifies" in phase 1, so this step needs no new question.

1. Commit everything in the worktree; `git -C <worktree> status --porcelain` prints nothing.
2. `buracle worktree sync <slug> --json`, then act on the exit code:
   - **0**: merged. Re-run the full test suite in the main checkout, then `buracle worktree cleanup <slug>` (after this sync it needs no `--force`). Never verify over a red base: fix it there, or hand back as blocked.
   - **2**: merged, but local changes stashed before the merge (never the run file) could not be restored. Do not pop or drop the stash. Tell the user their earlier local changes are in `git stash list` and need a manual `git stash pop`. Run the post-merge suite and clean up as for 0.
   - **1**: nothing merged. Read the error. If the base moved on, merge it into the worktree branch (`git -C <worktree> merge <base>`; never rebase), resolve conflicts in files this run changed, re-run the checks and retry once. Still failing: hand back as blocked with the error. Never clean up in this state.

**Done with verification off** (every criterion passed in the last judge round):

1. `buracle plan pause --kind decision --reason "build hand-back: done, verification off"`. The run stays bound at COMPLETE; this pause is how it ends.
2. `buracle notify verification_complete "<title>" "Done, verification off: <one line>" --plan <path>`, then `buracle flow end --outcome done`.
3. Memory as in *Done*, step 4.
4. Deliver the report with the outcome `done, verification off`, and end the turn.
5. If the user then says "continue", run `buracle plan resume`. No round is left to do: make the fix or change their message asks for, re-judge the criteria it touches, add the rows to `## Evidence`, and hand back with the same pause again (step 1). A new goal is a new run.

**Round limit, blocked, not achievable:**

1. Phase 6 has run (not for blocked).
2. `buracle plan pause --kind decision --reason "build hand-back: <outcome>"`
3. `buracle notify attention_needed "<title>" "<outcome>: <one line>" --plan <path>`, then `buracle flow end --outcome failed`
4. Deliver the report with the exact next step: what would unblock the run, or which different approach you would try. End the turn.
5. If the user then says "continue", run `buracle plan resume` and `buracle flow start goal-build --title "<goal title>"`, and do one more round per explicit request; past the fourth round, each extra round needs that request. A criterion the user rewrites is judged in the next round.

**After VERIFIED.** A problem the user raises later (a bug report, a screenshot) is new work on a closed run: fix it, re-run the layers the fix affects, re-judge the criteria it touches, and append the new rows to `## Evidence` and to your report. The status stays VERIFIED, because a verified run cannot be reopened. A change larger than a fix is a new run.

**Report:** lead with the oracle, then the evidence. A failed oracle is the headline, whatever else passed.

```text
**<goal title>**: <outcome> · rounds <n>/4
| Criterion | Result | Evidence |
|---|---|---|
| C4 (oracle) | pass | <the oracle signal itself> |
| C1 | pass | <one line> |
False pass: <the risk from phase 1>, ruled out by <the evidence that shows it did not happen>
Rounds: <R1 closed C1, C3; R2 closed C2 …>
Tasks changed: <added, split, dropped, and why>
Criteria changed: <who changed which, the before and after, and why, or "none">
Assumptions: <list>
Verification: profile <Minimal|API|Full> · <the checks with pass or fail> · review <findings closed> · docs <files, or "no doc impact">
Shortcuts: <open SHORTCUT markers and oversized files, or "none">
Unverified: <the ## Unverified section, verbatim, or "none">
Artifact: <where it is> · <the command to see it>
Merge: <squash-merged into <base> | worktree kept at <path> on its branch | on branch <the branch of the isolation line> | not isolated>
Next: <only for outcomes other than done>
```

## Export: a portable brief

When the user wants the run continued in a fresh session, by another agent or on a machine without Buracle, hand back a brief instead of running it. Without Buracle there is no run file and no stop guard, so the goal condition moves into the prompt.

<!-- harness:claude -->
Put this line first: `/goal Every acceptance criterion below passes a judge reading the finished artifact.` Claude Code's `/goal` keeps the session working until the condition holds; `/goal clear` drops it.

<!-- /harness -->
<!-- harness:codex -->
Put this line first: `/goal Every acceptance criterion below passes a judge reading the finished artifact.` Codex's `/goal` keeps the goal attached to the chat; `/goal clear` removes it.

<!-- /harness -->
<!-- harness:omp -->
Put this line first: `/goal Every acceptance criterion below passes a judge reading the finished artifact.` Oh My Pi's goal mode keeps the session working toward it (setting `goal.enabled`, on by default); `/goal drop` ends it.

<!-- /harness -->
<!-- harness:opencode -->
OpenCode has no goal command, so the brief's first sentence states the condition, and nothing else holds the session open.

<!-- /harness -->
```text
Build <the goal>.

Work in rounds. A round is: do every open task, then judge every criterion.

Tasks to start from; add, split or drop them as the work teaches you something:
1. …

Acceptance criteria, judged only at the end of a round, pass or fail, no scores (C<n> (oracle) is the one that proves the goal):
1. …

Judge from the finished artifact, not from your reasoning about it. Rule each criterion with one line of evidence; pass a criterion whose evidence meets what it asks, and do not raise the bar mid-judge. A failing criterion becomes next round's tasks. Do not judge before every task is done, do not ask me to approve anything between rounds, and after four rounds stop and tell me what will not close.
```

Add the reference and its re-obtain command only when the run has one. Leave out architecture, file layout and stack unless the user demanded them.

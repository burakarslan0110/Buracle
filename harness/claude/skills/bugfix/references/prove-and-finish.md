# Prove, quality gate, finish

## Prove

1. Re-run the original reproduction from Investigate against the real program, not only the new test. The expected behavior must now appear.
2. Collect the evidence that matches the surface:

   | Surface | Evidence that counts |
   |---|---|
   | Library or internal function | the RED test passing, plus one direct call from a script or REPL |
   | CLI | the exact command with realistic arguments: output and exit code |
   | HTTP API | server started on the fixed code; `curl -i`: status and body |
   | Web UI | chrome-devtools: perform the steps, check DOM text and console errors, take a screenshot |
   | Background job or worker | trigger it; check its effect and its logs |
   | Build or configuration | run the command that consumes it |

3. **Prove you are running the fixed code.** Rebuild and restart first, then confirm the running program has the fix (a new output, a log line, a version string). In a worktree run, start it from the worktree path.
4. Check one neighbouring case the fix could break, such as empty input or the previous happy path.
5. **The symptom persists while the RED test passes:** the test sits below the user's entry point. Move the assertion up to the entry point the user hits (the route, the command, the page), then redo RED, the fix and Prove.
6. Production or shared environments only with the user's explicit permission. When the program cannot run here (the build is broken, a service is down), name the blocker and the command that clears it, as in the *Environment blocker* protocol of [investigate.md](investigate.md); do not finish the fix without this proof.

## Quality gate

1. Run the full test suite once, then the type check, lint and the build. Keep each command with its result for the report.
2. **Unrelated failures:** reproduce them on the unmodified code in a throwaway checkout (`git worktree add --detach "${TMPDIR:-/tmp}/base-<slug>" HEAD`, run the same command, then `git worktree remove --force` that path). Pre-existing failures are reported, never silently fixed or hidden.
3. **Diff checks:** `git diff --stat`, then read the diff. It holds only the fix, the test and any sibling fixes with the same root cause.
   - The root-cause file appears in `git diff --name-only`. If it does not, the fix sits at a symptom: go back to the fix.
   - Symptom patterns in the lines you added: `git diff -U0 -- <the fix's files> | rg -n '^\+.*(try\s*[:{]|catch\s*\(|except\b|return (None|null|undefined|\[\]|\{\})|console\.(log|error)|print\()'`. Justify every match in one line or revert it. Scope the command to the fix's files when the tree had changes before the run.
   - `rg -n "BURACLE-DEBUG"` finds nothing. No stray prints, commented-out code, focused or skipped tests, or secrets.
   - Least that works: no abstraction, dependency or boilerplate the fix did not strictly need. A deliberate shortcut carries a `SHORTCUT:` comment that names its ceiling and the trigger for upgrading it; list those markers in the report (`git diff -U0 | rg -n '(#|//) ?SHORTCUT:'`).
4. **Changes review** for every proven fix, a one-line fix included, whatever `plan.reviews.changes` says (that switch is for feature work; a fix always gets its review):
   - `buracle review-scope --json` gives `base_ref`, `diff_range` and possibly a `warning` (resolve a warning first; if the fix is already committed on the default branch, add `--base <commit before the fix>`; in a worktree run, add `--slug <slug>`; on a branch made with `buracle worktree branch`, review-scope already diffs against its recorded base).
   - Launch the reviewer with the `Agent` tool, in the background when the harness supports it, while you run step 1; the block's first line names the agent and the rest is its prompt. There is no plan file, so pass `goal` instead:

     ```text
     `buracle:changes-review`
     goal: <Given / When / Actual / Expected>; root cause: <path:line — statement>
     base_ref: <from review-scope>
     diff_range: <from review-scope>
     worktree_path: <worktree path; worktree runs only>
     changed_files: <from git diff --name-only <diff_range>, plus untracked files>
     test_commands: <suite, types, lint, build>
     evidence: <RED output before the fix; the Prove results>
     user_request: <the user's words, verbatim>
     Return only your JSON report.
     ```

   - Second opinion: when `buracle config get plan` shows `reviews.companion` not `off`, also run `buracle plan review companion start --role changes --goal "<the goal line>" --input -` with the other lines of that block on stdin, as a heredoc. It runs the same review read-only on another installed harness. Collect it before the triage (`buracle plan review companion collect --role changes --wait 90 --json`, again while it says `running`) and triage its findings with the same rules, weighed equally. When it says `unavailable` or `failed`, carry on and say so in the report's Review line.
   - Its final message must be one JSON object: `verdict` (`pass` or `needs_changes`), `summary` (starting with "goal"), `findings` (each with `severity` `must_fix`, `should_fix` or `suggestion`, plus `category`, `title`, `evidence`, `suggested_fix` and optional `file` and `line`), optional `goal_score` (0–100), and `truths` (each `verified`, `failed` or `unverified`, with `evidence`). If it is missing or malformed, relaunch once, then review the diff yourself and say so. Check each finding against the code; fix `must_fix` and `should_fix` in code this fix touched; list everything else (including its sibling-pattern suggestions) as follow-ups. A `failed` truth means the bug is not fixed yet. Re-run the affected checks.
5. **Docs:** did the fix change documented behavior, a flag, a default or an error message the docs quote? Update those docs in the same change, or record "no doc impact".

## Finish

1. Remove all instrumentation and confirm that `git status --porcelain` lists only intended changes. Then read the notes the user pinned to the changed lines in the review page (`/brain review`): `buracle plan notes --kind code --json` (add `--slug <slug>` in a worktree run). Fix each open note, re-run the checks it touches, and mark it with `buracle plan notes --done <id>[,<id>]`. Read them again after the end question; new notes count as Request changes. No notes is never an approval.
2. **End question.** Unless the user already said what they want, ask once with `AskUserQuestion`. The question carries what you ran:

   ```text
   Bug: <one line>
   Root cause: <path:line — statement>
   Fix: <one line>
   Tests: <the RED test>, full suite <passed/total>
   Review: <changes-review: n findings, all resolved | no reviewer answer: the diff reviewed by hand>
   E2E: <command or steps> → <the observation that proves the fix>
   ```

   Options:
   - **Commit as `fix: <summary>`** (recommended on a `bugfix/<slug>` branch and in a worktree). The commit holds the test and the fix together: `git commit -m "fix: <summary>" -m "Root cause: <path:line> — <statement>"`, so `git log` carries the confirmed cause.
   - **Leave uncommitted** (not offered in a worktree run, whose work must be merged).
   - **Request changes:** the user describes the problem. It is new evidence: go back to Investigate, *Trace to the source*, then RED onward; the review re-runs on the files changed since the last one.
   - **Explain the fix in more detail** (the first time you ask only): the causal chain from the trigger to the root cause, why that boundary is the right place to fix, what the diff does line by line, and the alternatives you rejected. Change no code, then ask again without this option.
3. **Worktree run: merge.** In the worktree, stage everything (`git -C <worktree> add -A`) and make one commit as above, so that `git -C <worktree> status --porcelain` prints nothing. Make exactly one: the squash takes its subject and its `Root cause:` body from a single commit. With several commits the subject falls back to `fix: <slug>` and only the `Root cause:` lines are kept. Then `buracle worktree sync <slug> --json`. Act on the exit code:
   - **0**: merged. Run the full suite in the main checkout. When it fails there, fix it on the base branch and re-run; never report success over a red base. Then `buracle worktree cleanup <slug>` (no `--force` needed after this sync).
   - **2**: merged, but the base checkout's own uncommitted changes could not be restored. Do not pop or drop the stash; tell the user their changes are in `git stash list` and need a manual `git stash pop`. Run the suite and clean up as for 0.
   - **1**: nothing merged. Read the error. If the base moved on, merge it into the worktree branch (`git -C <worktree> merge <base>`; never rebase), re-run the checks and sync once more. Still failing: report it as blocked and keep the worktree.

   No stop guard holds a bugfix run, so finish the merge in the same turn as the answer.
4. **Memory.** When the root cause was non-obvious, write one `gotcha` memory with `memory_write`: the symptom, the root cause at `file:line`, the fix, and the test that guards it. Run `memory_search` first and update instead of duplicating. Never store secrets or logs.
5. Optionally notify: `buracle notify verification_complete "Fix: <symptom>" "<one line>"`.
6. **Report:**

   ```text
   **Fix: <symptom>**
   Root cause: <path:line — statement>
   RED: <test name> failed with <symptom> before the fix
   Fix: <files and a one-line description>
   E2E: <command or steps> → <observed expected behavior>
   Checks: suite <passed/total> · types · lint · build
   Review: <changes-review: n findings, all resolved | no reviewer answer: the diff reviewed by hand>
   Docs: <files updated | no doc impact>
   Unverified: <items, or "none">
   Follow-ups: <look-alikes, pre-existing failures, open SHORTCUT markers, or "none">
   Follow-up (architectural): <only when real: what would have prevented this bug>
   Branch/commit: <the bugfix/<slug>[-n] branch Setup printed @ <sha> | squash-merged into <base> @ <sha> | current branch, uncommitted>
   ```

   The `E2E:` line is mandatory. If you could not run it, write `E2E: not run — <reason>` and do not call the bug fixed. When the user chose the static path in Investigate, add `Repro: never executed (the user chose a static investigation)`.

   The architectural follow-up answers one question: what would have prevented this bug? Name it only when the answer is structural (no clean test seam, hidden coupling, validation missing at the boundary the bad data crossed, a repeated near miss in this area). For a typo, an off-by-one or a wrong default, leave the line out.

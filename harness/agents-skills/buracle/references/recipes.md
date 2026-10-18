# buracle recipes

Short sequences for situations that recur in every workflow. The workflow skill in charge decides
*when*; these show *how*.

## Ask the user a real question during an approved run

1. `buracle plan pause --kind decision --reason "Redis or an in-process LRU for the price cache?"`
2. `buracle notify attention_needed "Decision needed" "Price cache: Redis or LRU?" --plan <path>`
   (in the language the user writes in)
3. Ask with your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi): 2–4 concrete options, your recommendation first. End the turn.
4. After the answer: `buracle plan resume`. Record the choice in the plan; if it is a lasting
   decision, also as a `decision` memory.

For a step only the user can do (log in, create a key, press a button), use `--kind manual` and
say exactly what to do and how to report back ("done").

## The user says "stop" or "wait", later "continue"

The same holds when they say it in their own language.

1. `buracle plan pause --kind discussion --reason "<their words>"`.
2. Reply with a status of at most five lines (done, in progress, next) and end the turn.
3. On "continue", "go on" or "pick up where you left off": `buracle plan status --json`;
   if `interaction.state` is `paused` with kind `discussion`, run `buracle plan resume`; then
   continue where the plan says. A `decision` or `manual` pause stays: a bare "continue"
   answers neither, so ask the open question again or check the manual step first. Three
   decision pauses are the exception, because "continue" is their answer: the stop guard's
   runaway question (reason `runaway: …`), a goal-build hand-back (`build hand-back: …`) and the
   model-switch pause after plan approval (`model switch: …`). Buracle resumes those itself.

## Pick up after a compaction or in a new session

1. `buracle plan status --json` gives the plan path, phase, status, `tasks.done/total` and the
   interaction state.
2. Read the plan file: the first unticked `- [ ] Task N done` is where work continues.
3. If `interaction.state` is `paused`, do not resume on your own: answer what is pending, or ask.
4. If the session-start memory points at a handoff for this branch, read it with `memory_get` first.

## Worktree lifecycle

1. `buracle worktree detect --json`: if `inWorktree` is true for this plan, keep using it.
2. Otherwise `buracle worktree create <slug> --json` (the goal-build workflow adds `--prefix goal-build`) and
   work inside the returned `path`; the registered plan gets `worktree: true`.
3. Commit inside the worktree as tasks finish; `git -C <path> status --porcelain` must be empty
   before a merge.
4. With the user's go-ahead to merge: `buracle worktree sync <slug> --json`.
   - 0: merged. Run the test suite in the main checkout, then `buracle worktree cleanup <slug>`
     (no flag needed after this sync).
   - 2: merged, but the user's earlier local changes are still in `git stash list`. Tell them;
     do not pop or drop the stash. Plan files are never stashed, so the plan keeps its state.
     Then test and clean up as for 0.
   - 1: nothing merged. Read the error (conflict, dirty base, lock), fix the cause, retry once,
     otherwise pause and ask. Never clean up in this state.
5. Discarding work needs the user's explicit yes: `buracle worktree cleanup <slug> --discard`.

## Review a change

1. `buracle review-scope --slug <slug> --json`.
2. `warning` present: stop. Check `git status`, the current branch and the base the warning names;
   fix the cause and run review-scope again. When no default branch was found, or HEAD is the
   default branch, add `--base <ref>` naming the branch or commit the work started from.
3. `git diff --stat <diff_range>` lists the changed files.
4. Launch the reviewer with your subagent tool (`spawn_agent` in Codex, `subagent` in OpenCode, `task` in Oh My Pi); the block's first line names the agent and the rest is
   its prompt, for example:

   ```text
   changes-review
   plan_file: /abs/repo/docs/plans/2026-10-08-rate-limit.md
   base_ref: <base_ref>
   diff_range: <diff_range>
   changed_files: <from the --stat output>
   Return only your JSON report.
   ```

5. Check every finding against the code before acting on it.

## Finish a plan

1. Every task ticked; `buracle plan validate <path> --json` exits 0.
2. `buracle plan complete`.
3. Run the verification the workflow requires and record each command with its result.
4. Feature and Bugfix plans, while `plan.resultApproval` is on: show the user the result,
   `buracle plan pause --kind decision --reason "result review"`, ask, and after their explicit
   approval run `buracle plan approve-result` (it ends the pause). `plan verify` refuses until then.
5. All checks passed: `buracle plan verify`. A refusal names what is missing; fix that.
6. `buracle notify verification_complete "<title>" "<one line>" --plan <path>`.

## Before a fan-out

1. `buracle usage --json`.
2. At 75% or more of the 5-hour window, or 85% or more of the 7-day window: tell the user, and
   prefer fewer subagents, fewer runs or a smaller scope.
3. Editing lanes that run at the same time get one worktree each: `buracle worktree create <slug>-<n> --lane --json`
   (run it inside the plan worktree when the run has one) and pass the returned `path` in the lane's
   brief. When the lane reports: `buracle worktree diff <slug>-<n>`, read the diff, then
   `buracle worktree sync <slug>-<n>`, run the checks, and `buracle worktree cleanup <slug>-<n>`.

## Diagnose Buracle itself

1. `buracle doctor` (or `buracle doctor <harness>`).
2. Report the failing checks with their messages. Fixes that change the installation
   (`buracle install`, `buracle update --yes`) wait for the user's go-ahead.

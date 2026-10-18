# Verify phase (bugfix)

Outcome: proof that the bug is gone for the reason the plan names, that the guarding test really fails without the fix, and that nothing around it broke. Then VERIFIED, or back to implement with the gaps written down.

As in [verify.md](verify.md): every code fix, review findings included, lands before the symptom re-run, and the final tree is proven once more at the end.

## BV0. Setup

Same as [verify.md](verify.md) V0: status COMPLETE, phase `verify`, `buracle flow phase verify`, re-read the plan, `buracle review-scope --json` (with `--slug <slug>` in a worktree run), resolve any `warning`, run `buracle plan audit --json` and explain every changed file. Track BV1 to BV9 in your plan/todo tool where available (`update_plan` in Codex, the todo tool in Oh My Pi; OpenCode v2 has none).

## BV1. Launch the changes review

Launch changes-review with your subagent tool (`spawn_agent` in Codex, `subagent` in OpenCode, `task` in Oh My Pi) as in [verify.md](verify.md) V1, and add `focus: the fix at <root-cause path:line> and the Unchanged behaviors of the behavior contract`, with the `## RED Evidence` lines in `evidence`. Bugfixes always get a review: `plan.reviews.changes` does not apply here. Record it with `buracle plan review start` and, after BV4, `buracle plan review done` as in [verify.md](verify.md) V1 and V3. Continue with BV2 and BV3 while it runs.

## BV2. Prove the fix is real

1. **Green now.** Run the reproducing test from Task 1 on its own. It passes.
2. **Red without the fix.** Accept the `## RED Evidence` recorded during Task 1 if the test has not changed since. Otherwise prove it in a throwaway checkout, never by reverting the fix in the working copy:
   - `git worktree add --detach "${TMPDIR:-/tmp}/red-<slug>" <base_ref>`
   - copy in only the test files (plus any new fixtures they need), install dependencies there if the runner needs them, and run the test: it must fail with the Actual symptom of the behavior contract;
   - `git worktree remove --force "${TMPDIR:-/tmp}/red-<slug>"`.
3. **Fix at the named cause.** The root-cause file from the plan appears in `git diff --name-only <diff_range>`. If it does not, the cause moved during implementation: that must already be a recorded Deviation; otherwise it is a gap.
4. **No symptom patching.** Read the diff for: special cases keyed on the reproduction input, broad catch blocks that swallow the error, sleeps or retries added to hide a race, a null check at the crash site that ignores why the value is null, or a test edited to accept the wrong output. Any of these is a gap.
5. **Instrumentation gone.** `rg -n "BURACLE-DEBUG"` across the repository finds nothing.
6. **Unchanged behavior.** Every test the behavior contract names under Unchanged passes.

Record each item as a row in `## Evidence`.

## BV3. Quality checks

Full test suite, type check, lint and build, recorded in `## Evidence` with the same rules as [verify.md](verify.md) V2, including the diff hygiene checks.

## BV4. Review triage

Collect and triage the changes-review report exactly as in [verify.md](verify.md) V3. After any fix, re-run BV2 items 1 and 6 and the BV3 checks the fix touches before you go on.

## BV5. Re-run the original symptom

Run the reproduction recorded in the plan's `## Root Cause` section against the real program, using the evidence table and the port check in [verify.md](verify.md) V4; UI reproductions go through chrome-devtools. Rebuild and restart first, and confirm the running program contains the final fix. Record before and after:

```markdown
| Check | Command | Result |
|---|---|---|
| Original symptom | `curl -s localhost:3000/invoices/42/total` | before: 20.00 · after: 35.00 |
```

This step is mandatory. A passing unit test alone does not verify a bugfix.

## BV6. Final regression

As [verify.md](verify.md) V7: the full suite, type check, lint and build on the final tree, each as an `## Evidence` row (reuse a BV3 row only when no file changed after it), and re-run BV5 if a fix landed after it.

## BV7. Decide

All green: the user's code notes and the result review of [verify.md](verify.md) V8 (the plan, the RED proof, the fix and the symptom re-run), then BV8; a fix a note asks for re-runs BV5. Otherwise loop back exactly as in [verify.md](verify.md) V8 (`## Gaps` line, fix tasks, `iterations` plus one, `buracle plan set status IN_PROGRESS`, `buracle plan set phase implement`, then [implement.md](implement.md)), including the three-iteration escalation.

## BV8. Worktree merge

Worktree runs only: [verify.md](verify.md) V9, with its post-merge checks (the smoke run is the BV5 reproduction).

## BV9. Mark verified

1. Write `## Unverified` (or "none").
2. `buracle plan verify`
3. Memory: when the root cause was non-obvious, write one `gotcha` memory with `memory_write`: the symptom, the root cause at `file:line`, the fix, and the test that guards it. Run `memory_search` first and update instead of duplicating.
4. Notification and final report as in SKILL.md, *Done means*, with three extra lines:

```text
Root cause: <path:line — statement>
RED proof: <test> failed with <symptom> on <base_ref>
Symptom re-run: <command> → before <x>, after <y>
```

# Phases 1–3: goal, run file, lock

Outcome: a validated, reviewed and locked run file whose criteria anyone could rule pass or fail from evidence. No production code before the lock.

## 1. Goal and scope

1. If the session is in a read-only plan mode, ask the user to leave it first: this workflow writes its own run file. Then mark the phase: `buracle flow phase goal`.
2. Restate the goal as an end state in one to three sentences: what exists or works when the build is done. You will show it to the user together with your questions, or alone if you have none.
3. `buracle config get plan` prints the switches as JSON; this run uses `branchIsolation`, `questions`, `reviews.goal`, `reviews.changes`, `reviews.companion` and `goalVerification`. If the command fails, use the shipped defaults (all on).
4. Research just enough to write criteria you can judge, about ten calls at most: `memory_search` for earlier work on the area; semble and codegraph for what already exists; context7 for what the installed libraries can do; web-search and web-fetch for outside facts.
5. Reference: a named, obtainable thing to compare the result with (a URL, a screenshot, an existing screen, another tool's output, a benchmark). Obtain it now, in this phase, and write under `## Reference` the exact command, URL or path that obtains it again; it must be comparable side by side with what you will build.
   - The user named one: use it.
   - The user named none, but a genuine A/B exists: pick the most useful one you can reach yourself and say in one line which you took and why. Ask only when the candidates would send the build somewhere genuinely different.
   - No genuine A/B: write "None." and say so in one line. Never invent a comparison.
   - A rewrite or migration: capture the "before" state now, before the first edit (`git show <base>:<path>`, a saved screenshot path, a recorded command output). Once editing starts it is gone.
6. Clarify. This is the only planned conversation, so make it count: at most three questions per round and two rounds, through `AskUserQuestion`. Keep asking until you have:
   - **an oracle:** one observable signal that would convince the user the goal is met;
   - **evidence for every criterion:** what you will run or look at to rule it;
   - **a false-pass risk:** a believable way the result could look finished while being wrong.

   Never ask how to build it; that is your job. If isolation is on and the goal text carried no `--worktree`, `--new-branch` or `--current-branch` flag, include: "Where should the build run?" with the options separate worktree, squash-merged into the base and removed when the build verifies (recommended) / new branch `goal-build/<slug>` / current branch. Unanswered questions become assumptions under `## Assumptions`. Before a batch: `buracle notify attention_needed "<goal title>" "Input needed: <n> questions"`.

   **Questions off** (`questions: false`): ask nothing. Derive the oracle, the evidence per criterion and the false-pass risk yourself, take the isolation default (a worktree while isolation is on), and record each under `## Assumptions`, marked "decided without asking (plan.questions off)". Only a blocker is still asked: a missing credential or access, or a destructive or irreversible scope.
7. Evidence that can only arrive after this session (a nightly job, a third-party review, data still being collected): say so to the user now. Keep that criterion visible, and expect a blocked hand-back for it rather than spending rounds waiting.

## 2. Draft the run file

1. Mark the phase: `buracle flow phase contract` (it covers phases 2 and 3). `buracle plan init --type build --title "<goal title>" --json` prints `{path, slug}`. Then `buracle plan register <absolute path> --phase plan`. From here on, pause before any question that could end your turn.
2. Fill the file and keep the frontmatter and layout the CLI produced (its task layout wins over the example below). The markers the validator reads stay exactly as shown (`## Tasks`, `### Task N:`, `**Objective:**`, the checkbox line, `## Acceptance Criteria` with its `C1`, `C2`, … rows, `(oracle)` and the `pass` or `fail` verdicts, `**False pass:**`, `## Evidence`; the full list is in the *Plain language* rule), and so does `## Unverified`, which `buracle plan verify` reads. Write every other heading, the task titles and all prose in the language of the user's prompt. Under `## Assumptions`, write the switches this run follows as one line from phase 1's `buracle config get plan`, keys and values verbatim (`Switches: reviews.changes on, goalVerification on`). Write it now, before the review: an edit after `buracle plan review done` makes the lock warn that the review is stale.

Criteria rules:

- At least three criteria, each one sentence that someone else could rule pass or fail by looking at evidence.
- Draft them from the goal, the oracle and the false-pass risk of phase 1. A criterion that traces back to none of them was invented after the fact; drop it.
- No scores or adjectives ("fast", "clean", "intuitive"): state the measurement instead ("p95 under 200 ms on `bench/list.ts`").
- No compound criteria: split "A and B" into two. The split rule outranks any count: seven or eight criteria after a split are right, and merging or dropping a real criterion to reach a number lowers the bar. More than ten usually means the goal is several runs; say so instead of trimming.
- No restated tasks: "Task 2 is done" is not a criterion.
- At least one measurable criterion when the domain allows it.
- Exactly one criterion marked `(oracle)`.
- Under the table, one `**False pass:**` line names the believable false positive and the criterion that catches it.
- `## Out of Scope` lists what the user named that this build deliberately leaves out ("None." when nothing).

Task rules:

- Size each task as the largest slice you can finish and verify in one go: a working screen, a working endpoint, a path fixed end to end, a section that reads through. Safe means bounded, verified and reversible, not small; a task that adds one more helper or config file moves no criterion. Use as many tasks as the dependencies need, at least three; name the criteria each serves in its Objective.
- Same card format as plan-build plans (Objective, Files, a Definition of Done ending in `Verify:`, the checkbox line). The validator requires only the Objective and the checkbox on build cards, but goal-build-review and changes-review rely on Files and the Definition of Done to judge scope and proof. Keep the cards short.
- No `TBD`, `TODO` or `FIXME`.

```markdown
---
created: 2026-10-08
status: PENDING
approved: false
worktree: false
type: Build
rounds: 0
---
# Offline mode for the notes app

## Goal
Notes can be created and edited with no network and reach the server once the connection returns.

## Reference
None.

## Acceptance Criteria
| # | Criterion | Evidence | Status |
|---|---|---|---|
| C1 | With the network disabled in the browser, a new note can be created and survives a reload. | chrome-devtools: offline emulation, create, reload, snapshot | open |
| C2 | An edit made offline reaches the server within 10 s of going online. | server log line and `GET /notes/:id` body | open |
| C3 | `bun test` passes, including new sync-queue tests. | test run output | open |
| C4 (oracle) | A note created offline appears in a second browser profile after reconnecting. | screenshots of both profiles | open |

**False pass:** the list only looks saved because the service worker serves a cached copy; C1's reload and C4's second profile catch it.

## Out of Scope
- Attachments offline; the user named them for a later run.

## Tasks

### Task 1: Queue writes while offline

**Objective:** Writes go to a persistent queue while offline (serves C1, C2).

**Files:**
- Create: `src/sync/queue.ts`
- Test: `tests/sync/queue.test.ts`

**Definition of Done:**
- Queued writes survive a page reload.
- Verify: `bun test tests/sync/queue.test.ts`

- [ ] Task 1 done

## Assumptions
- Last write wins on conflicts; the user named no conflict policy.
- Switches: reviews.changes on, goalVerification on
```

3. `buracle plan validate <path> --strict --json`. Exit 1 means errors, exit 2 means warnings; fix them and re-run until exit 0.

## 3. Review and lock

**Review off** (`reviews.goal: false`): do not launch it. Check the criteria yourself against the concerns in goal-build-review's instructions (binary, observable, one claim each, no restated task, an oracle that matches the goal, a caught false pass), fix what you find, add "independent review off (plan.reviews.goal)" under `## Unverified`, and go to step 3.

1. Launch the reviewer with the `Agent` tool:

   ```text
   buracle:goal-build-review
   plan_file: <absolute run file path>
   user_request: <the user's original words, verbatim>
   clarifications: <each question with its answer; every assumption>
   notes: oracle is <Cn>; false pass: <the line>; reference: <name, or none>
   Return only your JSON report.
   ```

2. Record it at once when it runs in the background (`buracle plan review start --role goal --handle <id>`), and with `reviews.companion` not `off` start the second opinion (`--role goal`; SKILL.md, *Review agents*). Then validate and triage the report, the second opinion's too (SKILL.md, *Review agents*). The criteria, the oracle and the reference freeze at the lock, so fix every finding about them before locking, whatever its severity: categories starting with `criterion_`, plus `outcome_uncovered`, `no_end_to_end_check`, `oracle_mismatch`, `false_pass_uncaught` and `reference_unobtainable`. A criterion's `suggested_fix` is complete replacement wording; use it when it is right. Task findings (`task_gap`, `task_order`, `task_too_large`) follow the usual rule: fix `must_fix` and `should_fix`. A `contract_size` finding holds only for too few criteria or tasks; one that asks you to merge or drop a real criterion, or to cut tasks the dependencies need, is declined with the split rule as the reason, under `## Review Notes`. Once the fixes and the review notes are in, record the result with `buracle plan review done --role goal --verdict <verdict>`: it anchors the run-file text, so any later edit makes the lock warn.
3. Read the notes the user pinned to the draft in the review page: `buracle plan notes <path> --kind plan --json`. Fold each open note into the run file (a note on a criterion changes it now, before the lock) and mark it with `buracle plan notes --done <id>[,<id>]`. Then re-validate with `--strict`.
4. Lock the contract. This is your commitment, not a human sign-off:
   - `buracle plan set approved true`, then `buracle plan set status APPROVED` (a warning that the run file changed after goal-build-review was collected means a re-run when the change touched a criterion). The first fixes this run's switches and prints them (`Locked for this run: reviews.changes on, goalVerification on`); the stop guard and `buracle plan verify` follow them, and a later change of the config does not alter the locked run. If they differ from the `Switches:` line, the config changed after phase 1: correct the line to what it printed.
   - `buracle plan set phase implement`
   - Worktree chosen: `buracle worktree create <slug> --prefix goal-build --json` (branch `goal-build/<slug>`; it also sets `worktree: true` on the run file), then do all code work under the returned path; the run file stays where it is registered.
   - New branch: `buracle worktree branch <slug> --prefix goal-build --json`. It switches to `goal-build/<slug>` (or `-2` and so on when that name is taken) from the current HEAD, brings uncommitted changes along and records the base, so the review diffs only this run's work. Record the branch it prints as one line under `## Assumptions`, the name verbatim (`Isolation: new branch goal-build/offline-mode-2`): a later or compacted session finds the run's branch there.
   - Either command exits non-zero: read the `error` code, fix the cause and retry once. Still failing: pause with `--kind decision` and ask: retry after a manual fix / the other isolation / current branch / stop.
5. `buracle notify info "<title>" "Build locked: <n> criteria, <m> tasks" --plan <path>`. Post the criteria table and the task titles in the chat as information, not as a question, and start round 1 immediately ([build-and-judge.md](build-and-judge.md)).

After the lock, a criterion changes only when the user rewrites it, or when it turns out impossible to judge in its current wording (no evidence could ever settle it either way, found while judging, not while failing). In the second case make the smallest rewording that rules the same bar and log the old and new wording in `## Rounds`; a rewording that is easier to pass is not this. The oracle is exempt from both: you never reword it, and a user who rewrites it is defining a new goal, so offer a new run. An oracle you find undecidable means phase 1 never established one: hand back and say so.

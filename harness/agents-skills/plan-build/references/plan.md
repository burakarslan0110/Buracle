# Plan phase (feature)

Outcome: an approved plan in which every task has a known location, a chosen approach and a command that proves it. No production code in this phase.

## P1. Preconditions

1. If the session is in a read-only plan mode, ask the user to leave it first: this workflow writes its own plan file.
2. Mark the phase: `buracle flow phase plan`.
3. Read the switches once: `buracle config get plan` prints them as JSON. This phase uses `planApproval`, `branchIsolation`, `questions`, `reviews.plan`, `reviews.companion`, `modelSwitch` and `nativePlanMode`; verify uses `reviews.changes`. If the command fails, use the shipped defaults (every switch on, `reviews.companion`, `modelSwitch` and `nativePlanMode` off) and mention that in the approval message. `nativePlanMode: on`: after P2, continue with [native-plan.md](native-plan.md), which moves P3 to P7 into the harness's plan mode.
4. Memory pass, at most three queries: `memory_search` for the feature area, the modules you expect to touch, and key terms in the user's own words (any language works). `memory_get` at most three useful hits. They are leads to check against the code, not facts.

## P2. Frame the work and create the plan file

1. Restate the request in one to three sentences: what will exist, for whom, and how anyone can tell it works. If you cannot, the request is too vague: suggest `/requirements` (Codex: `$requirements`) and stop.
2. Look for special shapes:
   - **Replacement or migration:** add an `## Inventory` table (keep that heading in English; the validator and `buracle plan audit` read it) that maps every replaced function, endpoint, flag or behavior to the task that keeps it, or to the reason it is dropped. Nothing disappears silently. Use three columns: the replaced item, the task that keeps it written as `Task N`, and the reason when it is dropped:

     ```text
     | Replaced | Kept by | Reason if dropped |
     |---|---|---|
     | `GET /v1/limits` | Task 2 | |
     | `--legacy-keys` flag | | unused since 2024, removed with notice in CHANGELOG |
     ```

   - **Wide refactor:** expand, migrate, contract. Add the new path beside the old one, move callers in batches, delete the old path last.
   - **Builds on a VERIFIED plan:** write a new plan and link the old one in `## Context`.
   - **From an approved PRD** (`docs/prd/*.md`): link it in `## Context`. Its Must requirements become "Done when" lines of the Goal, its *Out of scope* list becomes Scope → Out, and its open questions are answered in P4 or recorded under `## Assumptions`. Do not re-ask what the PRD already settled.
   - **More than about 12 tasks:** propose sequential plans and ask which part comes first.
3. `buracle plan init --type feature --title "<short title>" --json` prints `{path, slug}`. Then `buracle plan register <absolute path> --phase plan`. From here on, write findings into the plan as you go: the file survives a compaction, your context does not.

## P3. Explore (read-only)

Keep going until every future task has a location, an approach and a verification command. When the change touches more than one area, run steps 1 to 7 as 2 to 4 read-only lanes (SKILL.md, *Lanes and documents*) and merge their `path:line` facts yourself.

1. Current behavior and entry points: semble `search` with the intent in plain words, then read the best hits.
2. Structure: codegraph for every symbol you expect to change (callers, callees, implementations). Callers you could break need test coverage in the plan.
3. Patterns to copy: semble `find_related` on the closest existing feature.
4. Exact names (routes, flags, config keys, error strings): `rg`.
5. Libraries: read the installed version from the lockfile or manifest, then context7 `resolve-library-id` and `query-docs` for that version. Never write signatures or defaults from memory.
6. Outside facts (protocols, services, release notes): web-search, then web-fetch the primary source. Thin docs: grep for real-world usage.
7. How to test, type-check, lint, build and run the program (package scripts, Makefile, CI config). Record the exact commands in `## Context`.

## P4. Clarify

Ask only when the answer changes the plan: behavior the user would notice, scope edges, compatibility or data risk, a real trade-off between valid approaches. Never ask what the code can tell you.

- At most three questions per round and two rounds, batched into one structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi) call per round. Pause before asking (SKILL.md, *Talking to the user*), then announce the batch: `buracle notify attention_needed "<title>" "Input needed: <n> questions" --plan <path>`.
- Each question offers 2 to 4 options that name real files, symbols or behaviors. Put your recommendation first and mark it "(recommended)".
- If `branchIsolation` is on and the request carried no `--worktree`, `--new-branch` or `--current-branch` flag, add: "Where should implementation run?" with the options separate worktree (recommended) / new branch `plan-build/<slug>` from the current branch / current branch.
- No answer, or "you decide" (in any language): take your recommendation and record it under `## Assumptions`.
- **Questions off** (`questions: false`): ask nothing here. Take your recommendation for every open point, the isolation included (a worktree while `branchIsolation` is on), and record each under `## Assumptions`, marked "decided without asking (plan.questions off)". Only a blocker is still asked: a missing credential or access, or a destructive or irreversible scope.

## P5. Choose the approach

- Exactly one approach goes into the plan. Record up to five **Key decisions**, each with its reason and the price you accept for it. Mention a rejected alternative in one line only when the user would expect it.
- Follow the existing architecture and conventions. Add a dependency only when it removes real work, and name it with an exact version checked through context7 or the package registry.
- Touch the fewest files that do the job.

## P6. Write the plan

Fill the file that `buracle plan init` created and keep its frontmatter and layout. If its task layout differs from the example below, the CLI's layout wins. The markers the validator reads stay exactly as shown (`## Tasks`, `### Task N:`, `**Objective:**`, `**Files:**`, `**Definition of Done:**`, `Verify:`, the checkbox line, `## E2E Scenarios`, `## Evidence`, `## DoD Audit`, `## E2E Results`; the full list is in the *Plain language* rule), and so do `## Inventory` and `## Deviations`, which the validator and `buracle plan audit` read by these English names. Write every other heading, the task titles and all prose in the language of the user's prompt.

```markdown
---
created: 2026-10-08
status: PENDING
approved: false
worktree: false
type: Feature
iterations: 0
---
# Rate-limit the public API

## Goal
API clients get HTTP 429 instead of overloading the server when one key sends more than 100 requests per minute.
Done when:
- A key that sends 101 requests within 60 s gets 429 with `Retry-After` on the 101st.
- Requests from other keys are unaffected.

## Context
- Requests enter at `src/server.ts:41` (`createServer`); middleware order is set at `src/server.ts:58`.
- Commands: tests `bun test` · types `bunx tsc --noEmit` · run `bun run dev` (port 3000).

## Scope
- In: a fixed-window limit per API key on `/api/*`.
- Out: per-IP limits, shared storage across instances.

## Approach
An in-memory counter as middleware in front of the router.
Key decisions:
- Fixed window over sliding window: simple and enough for the stated limit; the price is short bursts at window edges.

## Tasks

### Task 1: Count requests per API key

**Objective:** Middleware counts requests per key in 60 s windows and rejects the 101st with 429.

**Files:**
- Create: `src/middleware/rate-limit.ts`
- Modify: `src/server.ts`
- Test: `tests/middleware/rate-limit.test.ts`

**Definition of Done:**
- Requests 1 to 100 in a window pass; the 101st gets 429 with `Retry-After`.
- A request without a key gets 401 and is not counted.
- Expired windows are dropped, so memory does not grow with old keys.
- Verify: `bun test tests/middleware/rate-limit.test.ts`

- [ ] Task 1 done

## E2E Scenarios
**SC-1: Burst from one key** (priority high; covers Task 1)

| Step | Action | Expected |
|---|---|---|
| 1 | Send 100 `GET /api/items` with key A | all 200 |
| 2 | Send one more with key A | 429 with `Retry-After` |
| 3 | Send one with key B | 200 |

## Risks
- A restart resets counters. Accepted for a single instance (see Scope).

## Assumptions
- 100 requests per minute per key, as stated in the request.
```

Optional sections, when they earn their place:

- **`## File Structure`** for 4 or more tasks: one line per file the plan creates or changes, with its single responsibility (`` `src/middleware/rate-limit.ts` (create): counts requests per key; no I/O ``). It fixes the split into files before the tasks do.
- **`## Constraints`** for exact project-wide values every task must honor: a version floor, a required format, an exact string, a platform requirement. One value per line, copied verbatim; tasks point to it instead of repeating it, and the reviewers get it as their checklist. A paragraph of explanation belongs in `## Context`, not here.

Task rules:

- **Vertical slices.** After each task the code builds, the tests pass, and something observable works where possible. Order tasks by dependency.
- **Files** lists every path the task touches, one per line, with one verb: Create, Modify, Delete, Rename or Test; a rename reads ``- Rename: `old/path.ts` -> `new/path.ts` ``. A path named in an Objective, DoD or `Verify:` line must appear in some task's Files too; a path the task only points at is written as `path:line`.
- **Definition of Done** bullets are checkable facts, not qualities: "returns 429 with Retry-After", not "handles limits well". The last bullet is `Verify:` followed by the command that proves the task.
- **Edge sweep.** For each task, consider failure paths, empty and boundary input (including non-ASCII text and locale-sensitive casing, such as the Turkish dotted and dotless i), timeouts and cancellation, and concurrency. Add a DoD bullet for each one that applies.
- **Tests.** Extend existing test files and helpers. One test per behavior, no quotas, never assertions on source text. A task with nothing testable (config, docs, pure wiring) says in its DoD which evidence replaces the test.
- **User-only steps** (create an API key, change an external console): a task of their own whose Objective starts with `User action:` and states exactly what the user must do.
- **E2E scenarios:** one per user-visible flow the plan changes, numbered SC-1, SC-2 and so on. Purely internal work may have none; say so in one line.
- **No `TBD`, `TODO` or `FIXME`** anywhere in the plan. Decide, or ask.
- **One fact, one place.** Tasks point to `## Context` instead of repeating it.

## P7. Self-check and validate

1. Read the plan as the implementer would. Could you carry out every task without asking anything? Are names and paths spelled identically everywhere?
2. Run `buracle plan validate <path> --strict --json`. Exit 1 means errors, exit 2 means warnings. Fix them and re-run until exit 0. Besides the format, it checks:
   - `files-incomplete` (warning): a path an Objective, DoD or `Verify:` line names that no task's Files lists. Add it under the verb that fits (`Test:` for a test file the task runs but does not change), or write it as `path:line` when the task only points at it; never delete the mention to silence it. A script a `Verify:` command only runs (`bun scripts/check.ts`, `./scripts/smoke.sh`) needs no Files line.
   - `vague-placeholder` (warning in a task card, info elsewhere): filler such as "handle edge cases", "appropriate error handling", "implement later" or "similar to Task 2". Name the exact cases, values, files or steps.
   - `inventory-unmapped` (warning): an `## Inventory` row with no `Task N` and no reason, or one that names a task the plan does not have.
   - `identifier-drift` (info, never fails): two backticked names that differ only in case, underscores or one or two letters, such as `clearLayers` and `clear_layers`. Fix real drift; ignore it when both names exist.

## P8. Plan review

**Review off** (`reviews.plan: false`): do not launch it. Check the plan yourself against the concerns in plan-build-review's instructions (requirement gaps, scope creep, risky assumptions, missing tasks and tests, weak DoD, task order), fix what you find, and add "independent review off (plan.reviews.plan)" under `## Unverified`. Then go to step 3.

1. Launch the reviewer with your subagent tool (`spawn_agent` in Codex, `subagent` in OpenCode, `task` in Oh My Pi):

   ```text
   plan-build-review
   plan_file: <absolute plan path>
   user_request: <the user's original words, verbatim>
   clarifications: <each question with its answer; every assumption you made>
   constraints: <the lines of ## Constraints; leave this line out when the plan has none>
   Return only your JSON report.
   ```

   With `reviews.companion` not `off`, start the second opinion now (SKILL.md, *Review agents*, `--role plan`).
2. Handle the result as described in SKILL.md, *Review agents* (with the `buracle plan review start` and `done` records); collect the second opinion first and triage both reports the same way.
3. Re-validate with `--strict`. Launch the reviewer a second time only if you restructured tasks, or when `buracle plan set approved true` warns that the plan changed after the collected review and the change added a task or behavior.

## P9. Approval gate

Mark the phase: `buracle flow phase approve`.

**Approval off** (`planApproval: false`): run *On approval* below, then `buracle notify info "<title>" "Plan self-approved: <n> tasks" --plan <path>`.

**Approval on:**

1. `buracle notify plan_approval "<title>" "<one-line summary>" --plan <path>`. When the web UI runs it prints `Review page: <url>`: there the user reads the rendered plan and pins notes to passages.
2. `buracle plan pause --kind decision --reason "plan approval"`
3. **Fold in the user's notes:** `buracle plan notes <path> --kind plan --json`. Apply each open note to the plan, or say in the summary why you did not; re-validate after an edit; then mark each applied note with `buracle plan notes --done <id>[,<id>]`. No notes is never an approval.
4. Show a summary of at most 15 lines: goal, the approach in two lines, numbered task titles, E2E scenario names, assumptions, review findings (fixed and declined), the notes you applied, the plan path and the review page URL from step 1. Ask with your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi): "Approve this plan?" with the options Approve (recommended) / Request changes. A free-text answer counts too; see the phrase table in SKILL.md.
5. Changes requested, in the reply or as new notes on the review page: run step 3 again, edit, re-validate, re-run the reviewer only if tasks changed materially (record it again with `buracle plan review done`), then ask again.

**On approval:**

1. Approval on: read the notes again, `buracle plan notes <path> --kind plan --json`. An open note was pinned while you waited, so the answer is not an approval yet: run steps 3 and 5 of the approval gate (apply, re-validate, mark done), say what you changed, and ask again. Only an approval with no open notes goes on.
2. `buracle plan resume` (only if you paused for the approval question)
3. `buracle plan set approved true`, then `buracle plan set status APPROVED`
4. `buracle plan set phase implement`
5. Apply the isolation the request's flag named (`--worktree`, `--new-branch`, `--current-branch`; it wins over the `branchIsolation` toggle and needs no question), else the answer from P4:
   - Worktree: `buracle worktree create <slug> --json` (it also sets `worktree: true` on the registered plan), then do all code work under the returned path from now on. The plan file stays at its registered path.
   - New branch: `buracle worktree branch <slug> --json`. It switches to `plan-build/<slug>` started from the current HEAD, or to `plan-build/<slug>-2` (and so on) when that name is taken, brings your uncommitted changes along, and records the base, so the review later diffs only this run's work. Use the branch it prints, and record it in the plan as one line under `## Assumptions` with the branch name verbatim (`Isolation: new branch plan-build/rate-limit-2`): a later or compacted session finds the run's branch there.
   - Current branch, or isolation off: nothing to do.
   - **When isolation fails** (either command exits non-zero): read the `error` code, fix the cause and retry once. Still failing: pause with `--kind decision` and ask: retry after a manual fix / the other isolation / current branch / stop. Never continue in the current checkout without the user's answer.
6. **Model switch** (`modelSwitch: manual`, the user approved this plan, you are the lead, not a plan lane): `buracle plan pause --kind decision --reason "model switch: switch to the implementation model, then say continue"`. Tell the user in one line how to switch:
   **Codex:** run `/model`, pick the model and its reasoning effort for the implementation, then say "continue".
   **OpenCode:** open the model list with `/models` (or ctrl+x m), pick the model for the implementation, then say "continue".
   **Oh My Pi:** run `/model` (or `/switch`), pick the model for the implementation, then say "continue". Oh My Pi can also switch by itself at the first edit (`/prewalk`, or the `prewalk.enabled` setting).
   Then end the turn. The user's "continue" ends this pause; when their message means go on in other words, run `buracle plan resume`. Approval off, or a plan lane: no pause, keep the current model.
7. Continue at once with [implement.md](implement.md). Do not end the turn, except for the model-switch pause of step 6.

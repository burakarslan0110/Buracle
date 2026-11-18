---
title: Use cases
description: Which command to use when, six sessions from the first prompt to the verified result, and the habits that keep runs short.
order: 3
---

Each case below is one session: what you type, what the agent does at each step and which files and branches appear. The [workflows](workflows.md) page explains each loop in detail.

The examples use `/` to start a skill. In Codex, type `$plan-build`, and in Pi, type `/skill:plan-build`.

## Which command when

| Situation | Command | What you get |
|---|---|---|
| A small, clear change | Ask for it, no command | The change, under the same guards and memory |
| The problem or the scope is still unclear | `/requirements <idea>` | An approved PRD in `docs/requirements/` and the command for the next step |
| A change across several modules that you want to approve first | `/plan-build <task>` | A reviewed plan in `docs/plan-build/`, test-first tasks, a run of the real program, your sign-off and `VERIFIED` |
| You can state the end state as pass/fail criteria | `/goal-build <goal>` | A locked contract in `docs/goal-build/`, up to four judged build rounds and a verified hand-back |
| One behavior is broken and you want proof of the fix | `/bugfix <symptom>` | The root cause as `file:line`, a test that fails for that reason, the fix and a run of the real program |
| You need to understand code before you change it | `/inspect <question>` | An answer with `file:line` evidence. Nothing changes |
| You need outside facts, versions or a comparison | `/research <question>` | A research note that cites a source for each finding |
| The repository has no agent guidance | `/project-rules` | An `AGENTS.md` built from commands the agent ran, synced to every harness |
| You suspect unused code | `/dead-code` | A ranked report and a staged removal plan. Nothing is deleted |
| A rule should hold from now on | Say "from now on, …" | A preference memory that every harness loads |
| A recurring task has no skill yet | `/find-skill <need>` or `/new-skill` | An audited skill installed for every harness, or a new one |
| You want to read a plan or a diff and leave notes | `/brain review` | The review page of the [Console](console.md#review-page) |

## Six cases

### A feature with a fuzzy scope

You know the reports page needs saved searches, but you have not decided who shares them or what they store. Start with `/requirements`, then hand the approved PRD to `/plan-build`.

```text
you:    /requirements saved searches for the reports page
agent:  Reads the reports code with semble and codegraph, and earlier decisions in the memory.
agent:  Picks a research tier and checks the facts it needs (context7, web search).
agent:  Asks a few questions, one round at a time, then shows two or three approaches in a table.
you:    the second one
agent:  Confirms the scope: requirements R1 to R6 and the list of what is out of scope.
        + docs/requirements/2026-11-18-saved-searches.md
agent:  The PRD is on the review page (localhost:41777/review). Approve, request changes or stop?
you:    approve
agent:  Next step, for you to run:
        /plan-build Implement the approved PRD docs/requirements/2026-11-18-saved-searches.md
you:    /plan-build Implement the approved PRD docs/requirements/2026-11-18-saved-searches.md --worktree
agent:  Explores the code, writes the plan and validates it. plan-build-review checks it.
        + docs/plan-build/2026-11-18-saved-searches.md
agent:  Shows the goal, the tasks and the review findings. Approve this plan?
you:    approve
agent:  Creates the worktree .worktrees/saved-searches on the branch plan-build/saved-searches.
agent:  Task 1: RED, the new test fails. GREEN, it passes. The same for every task.
agent:  Verify: changes-review, tests, types, lint, build, the real program, then SC-1 and SC-2.
agent:  Approve the result, request changes or test it first?
you:    approve
agent:  Squash-merges into main and runs the checks again there.
        Saved searches: VERIFIED
```

The requirements workflow writes no code and never starts the next workflow itself. It prints the command, and you run it.

### A bug users can see

The invoice total leaves out the last line item. `/bugfix` proves the cause before it changes anything.

```text
you:    /bugfix invoice total skips the last line item
agent:  Where should I work? Current branch, new branch bugfix/invoice-last-item or a worktree?
you:    new branch
agent:  Switches to bugfix/invoice-last-item.
agent:  Investigate: runs the failing case and reads the whole output.
        Root cause: src/billing/total.ts:27, sumItems stops at items.length - 1. Confidence: high.
agent:  RED: a test at the public entry point fails with the wrong total.
agent:  Fix: the loop visits every index. The RED test and the module's tests pass.
agent:  Prove: runs the original case on the real program. The total now includes the last item.
agent:  Quality gate: the full suite, types, lint, build and changes-review on the diff.
agent:  Commit as "fix: include the last line item in invoice totals"?
you:    commit
agent:  Report: the root cause, the RED proof, the E2E check and the branch with its commit.
```

A plain "fix this" also works, without the workflow. Use `/bugfix` when you want the root cause and the proof on record.

### A goal you can measure

Search is slow, and you know when it is fast enough. `/goal-build` turns that into criteria and builds until each one passes.

```text
you:    /goal-build search p95 under 200 ms on the seed data
agent:  Restates the goal as an end state and reads the search code and the memory.
agent:  Asks what proves the goal (the oracle), what evidence settles each criterion,
        how the result could look done while it is wrong, and where the build runs.
you:    the benchmark script on the seed data is the oracle, and use a worktree
agent:  Drafts the contract: the goal, a reference, criteria C1 to C4 and the tasks.
        + docs/goal-build/2026-11-18-search-p95.md
agent:  goal-build-review checks every criterion. The agent fixes the findings and locks the contract.
        Locked for this run: reviews.changes on, goalVerification on
agent:  Creates the worktree .worktrees/search-p95 on the branch goal-build/search-p95.
agent:  Round 1: builds every open task, then judges each criterion on the running program.
        C1 pass · C2 pass · C3 fail · C4 pass
agent:  Round 2: the failing criterion becomes new tasks. Judged again, all four pass.
agent:  Verify: changes-review, the full checks and your notes from the review page.
agent:  Squash-merges into main.
        Search p95: done · rounds 2/4 · VERIFIED
```

All the questions come before the lock. After it, the agent talks to you only to hand back or when a blocker needs you.

### A codebase you just joined

Set the repository up once, then ask questions before you change anything.

```text
you:    buracle project sync        (in a terminal, in the repository)
        Checks for an AGENTS.md, links .agents/skills into .claude/skills and sets up the project's brain.
you:    /project-rules
agent:  Reads the package scripts, the CI jobs, the linter and test configs and the test layout.
agent:  Runs each command before it writes it down, or marks it "(not verified: <reason>)".
        + AGENTS.md
        + .claude/rules/<slug>.md    (only for a file type that needs rules of its own)
agent:  Runs buracle project sync and buracle project check.
you:    /inspect how does the token refresh work?
agent:  States one claim to test, finds the code with semble and follows the callers with codegraph.
agent:  Answers with file:line evidence for each step of the path and a confidence. No file changes.
```

### Spring cleaning

The dead-code audit reports and plans. The removal is a separate run that you start.

```text
you:    /dead-code
agent:  Collects candidates from the project's analyzers, an rg-based script and codegraph.
agent:  Checks each candidate against independent signals and rules out a public role
        (an API, an entry point, config, a registry).
agent:  Report: the counts per verdict, each candidate with its evidence and a removal plan in batches.
        git status shows the same files as before the audit.
you:    save it
        + docs/dead-code/2026-11-18-src.md
you:    /plan-build remove batch 1 from docs/dead-code/2026-11-18-src.md
agent:  Writes a plan for the batch and asks you to approve it, then removes and checks task by task.
```

### Switching agents mid-task

The memory belongs to the project and to you, so a rule you give one harness reaches the others.

```text
In Claude Code:
you:    From now on, use pnpm in this repo.
agent:  Saves it at once as a preference memory, in your words.

In Codex, the next day:
you:    $plan-build add CSV export to the reports page
agent:  The session opens with the project memory, and the pnpm preference is in it.
agent:  The plan's commands use pnpm.
you:    /brain
agent:  Runs buracle mem ui --open. The Console shows the memory in region 4, You & preferences.
```

## Best practices

- Run `buracle project sync` and `/project-rules` once in each repository. Every harness then follows the same `AGENTS.md`.
- Start fuzzy work with `/requirements`, and hand the PRD to `/plan-build` or `/goal-build`.
- Use `/bugfix` for one broken behavior and `/plan-build` for a change across modules. Use `/goal-build` when you can write pass/fail criteria.
- Let plan-build and goal-build work in a worktree. It is the recommended answer while branch isolation is on, and your checkout stays as it was until the merge.
- Read the diff on the review page before you approve the result, and pin your notes to the lines there. The agent reads every open note before it asks for an approval.
- Answer an approval question with a clear "approve". A bare "continue" never approves a plan or a result.
- Say "from now on …" once, and every harness follows it.
- Ask another harness for a second opinion with `buracle config set plan.reviews.companion auto`.
- Ask with `/inspect` before you change code you do not know. It reads and changes nothing.

## Choose where the work runs

With branch isolation on (`plan.branchIsolation`, the default), plan-build, goal-build and bugfix ask where to work. Add a flag to the request to answer in advance. The run's branch is named after the workflow: `plan-build/<slug>`, `goal-build/<slug>` or `bugfix/<slug>`.

| Flag | What the agent does | Pick it when |
|---|---|---|
| `--worktree` | Creates the folder `.worktrees/<slug>` on the run's branch. At the end the work is squash-merged into the base branch | You want your checkout untouched, or you run other work in parallel |
| `--new-branch` | Switches your checkout to the run's branch, started from the current commit. Uncommitted changes come along | You want the work on its own branch without a second folder |
| `--current-branch` | Works on the branch you are on | The change is small and your tree is clean |

`/plan-build add CSV export to the reports page --worktree` starts the run with no isolation question. For bugfix, the agent recommends by risk: the current branch for a one-line fix on a clean tree, a worktree for a fix across several modules or a dirty tree.

At the end of a plan-build worktree run, the agent asks whether to squash-merge it into the base branch, keep it for your review or discard it. After a merge it runs the tests, types, lint, build and a smoke run again on the base branch.

## Pause, resume or drop a run

While a plan-build or goal-build run is registered and not `VERIFIED`, the [stop guard](workflows.md#the-stop-guard) keeps the agent's turn going. These messages control the run:

| You send | What happens |
|---|---|
| "stop", "wait" or "hold on" ("dur", "bekle") | Buracle Stack records a pause. The agent finishes the current step, stops what the session started in the background, says where it stopped and waits |
| "continue" ("devam") or `/plan-build resume` | The run goes on from where the plan stands |
| "cancel", "abandon" or "drop it" ("iptal", "vazgeç") | The agent stops and confirms with you before it discards anything. The plan file stays |

Buracle Stack reads these words only when they are the whole message. "Stop the server" is an ordinary request, and the agent acts on its meaning.

"Continue" answers no open question. A plan approval, a result review or a decision the agent asked you about stays open until you answer it. Invoking `/goal-build` again also resumes a paused goal-build run. A bugfix run has no plan file, so no stop guard holds it: on "stop" the agent reports the phase, the root cause so far and the changed files.

## Ask another agent for a second opinion

A second harness can review the same plan, contract or diff. Run this yourself, because an agent cannot change the review switches:

```sh
buracle config set plan.reviews.companion auto
```

| Value | Reviewer |
|---|---|
| `off` | None (the default) |
| `auto` | Another installed harness. It prefers one whose model comes from a different family than the session's |
| `claude`, `codex`, `opencode`, `omp`, `qwen`, `pi`, `agy` | That harness |

The second opinion runs read-only in the background, once per plan and review. It covers the plan review, the goal-build contract review and the changes review, and bugfix's changes review too. Its findings go through the same triage as the reviewer's and weigh the same. When it is unavailable or fails, the run goes on without it and the plan (`## Review Notes`) or the bugfix report says so. The switch is also in the Console's [settings](console.md#settings).

## Switch the model after approval

Plan with one model and implement with another:

```sh
buracle config set plan.modelSwitch manual
```

After you approve a plan-build plan, the run pauses. Open the harness's model picker (`/model`, in OpenCode `/models` or ctrl+x m, in Oh My Pi `/model` or `/switch`), pick the model for the implementation and say "continue". In Codex, also pick the reasoning effort. Oh My Pi can switch on its own at the first edit, with `/prewalk` or the `prewalk.enabled` setting. With plan approval off, the run does not pause and keeps the current model.

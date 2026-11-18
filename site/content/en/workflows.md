---
title: Workflows
description: The three ways to work with an agent, the four Buracle Stack workflows with their phases and loops, and the other commands you can start.
order: 2
---

Open your harness in a project and work the way you already do. Every way of working below runs under the same [guards](guards.md) and the same [memory](memory.md).

- A direct request. Ask for the change, and the agent works on it without a workflow.
- The harness's own plan mode. When you approve a plan there, Buracle Stack saves it to `docs/plan-build/`. OpenCode has no approval step, so it saves a draft. See [plan mode per harness](harnesses.md#plan-mode).
- A Buracle Stack workflow. It starts only when you call it by name.

## Start a workflow

Type the workflow and your request, for example `/plan-build add CSV export to the reports page`. Codex starts skills with `$` (`$plan-build`) and Pi with `/skill:` (`/skill:plan-build`). The other harnesses use `/`.

## The four workflows

| Workflow | Use it when | What you get |
|---|---|---|
| `/plan-build` | You want a reviewed plan approved before any code is written | A plan in `docs/plan-build/`, a failing test before each change, reviews, a run of the real program and your sign-off |
| `/goal-build` | The end state is clear and the path is found by building | A locked contract in `docs/goal-build/` with at least three pass/fail criteria, up to four build rounds judged on running evidence, and a final verification |
| `/bugfix` | One behavior is broken and you want proof that it is fixed | The failure reproduced, the root cause as `file:line`, a failing test, the fix and an end-to-end check |
| `/requirements` | The problem or the scope is still unclear | A few rounds of questions and an approved PRD in `docs/requirements/`, ready to hand to plan-build or goal-build |

`/plan-build` also takes `pause`, `resume` or the path of an existing plan, such as `/plan-build docs/plan-build/2026-11-17-csv-export.md`.

The [workflow switches](console.md#settings) decide how they run: which approvals they ask for, which reviews run, whether they ask questions and whether another harness gives a second opinion.

## How each workflow runs

Each workflow moves through its phases in order and loops back when a check fails. Plan-build, goal-build and bugfix start every behavior change with a failing test and send the result to an independent review. Requirements writes no code at all. [Use cases](flows.md) shows each one as a full session.

### plan-build

Use it when you want a reviewed plan approved before any code. Case: [a feature with a fuzzy scope](flows.md#a-feature-with-a-fuzzy-scope).

1. Plan. The agent explores the code, asks up to three questions per round (two rounds at most) and writes the plan to `docs/plan-build/`.
2. Plan review. `buracle plan validate` checks the format, and the plan-build-review agent checks coverage, risks, task order and tests.
3. Your approval. You approve the plan, or pin notes to it on the review page and ask for changes.
4. Build. Each task starts with a failing test (RED), then the smallest code that passes it (GREEN).
5. Verify. changes-review, tests, types, lint and build, then the real program on every changed surface, the E2E scenarios and a final regression.
6. Your sign-off. You approve the result, ask for changes or test it first. A worktree run is merged after your approval.
7. `VERIFIED`. `buracle plan verify` checks the evidence sections and closes the run.

When a check fails, the agent adds fix tasks to the plan and goes back to Build. When the same gap survives three iterations, it pauses and asks you.

### goal-build

Use it when the end state is clear and the path is found by building. Case: [a goal you can measure](flows.md#a-goal-you-can-measure).

1. Goal and oracle. The agent restates the goal and finds the oracle, the one signal that proves it. All its questions come in this phase.
2. Contract. At least three pass/fail criteria and the tasks, in `docs/goal-build/`.
3. Review and lock. The goal-build-review agent checks every criterion, then the agent locks the contract. After the lock, a criterion changes only when you rewrite it or when it cannot be judged as written.
4. Build round. The agent builds every open task.
5. Judge. Each criterion is ruled pass or fail on evidence from the running program. Missing evidence counts as a fail, and the oracle is judged last.
6. Verify. changes-review and the full checks. `plan.goalVerification` can turn this phase off.
7. Hand back. A report with one outcome: done (`VERIFIED`), round limit, blocked or not achievable.

Failing criteria become the next round's tasks. After four judge rounds the agent hands back, whatever the state.

### bugfix

Use it when one behavior is broken and you want proof that it is fixed. Case: [a bug users can see](flows.md#a-bug-users-can-see).

1. Reproduce. The agent runs the failing case and reads the whole output.
2. Root cause. It names the cause as `file:line`, with what the code does and what it should do.
3. RED. A test at the entry point you use fails for the reported reason.
4. Fix at the source. The change goes into the code that creates the bad state.
5. Prove. The original case runs again on the real program.
6. Quality gate. The full suite, types, lint, build and changes-review.
7. Finish. You choose to commit, ask for changes or get an explanation. A worktree run is squash-merged here.

A test that passes before the fix means the root cause is wrong, so the agent goes back to the investigation. It does the same when the test still fails after the fix (it reverts its edit first) and when you ask for changes. Bugfix has no plan file, so the stop guard does not hold it open.

### requirements

Use it when the problem or the scope is still unclear. Case: [a feature with a fuzzy scope](flows.md#a-feature-with-a-fuzzy-scope).

1. Understand. The agent restates the idea and grounds it in the code and the memory.
2. Research. The agent picks a tier: skip, quick (a few facts it checks itself), standard or deep (through the `/research` skill).
3. Ideate. Three to five directions in prose, when you have not named a solution yet.
4. Clarify. Questions on the audience, the core flow, the constraints and the success signal.
5. Propose. Two or three approaches in a table, with effort and risks. You pick one.
6. Converge. What is in and out of scope, and requirements R1 to Rn, each with a priority.
7. PRD and your approval. The PRD goes to `docs/requirements/` and onto the review page for your notes.
8. Hand off. The agent prints the `/plan-build` or `/goal-build` command, and you run it.

When you ask for changes, the agent edits the PRD in place and asks again. After three rounds it asks whether to keep going. No code is written before the approval.

## Where the work happens

With branch isolation on (`plan.branchIsolation`, the default), plan-build, goal-build and bugfix ask where to work. A flag after the request answers that question in advance:

| Flag | Where the work happens |
|---|---|
| `--worktree` | A new worktree on its own branch |
| `--new-branch` | A new branch in your checkout |
| `--current-branch` | The branch you are on |

When work in a worktree is verified, plan-build offers to squash-merge it into the base branch, keep it for your review or discard it. Goal-build squash-merges it when the build is verified, and bugfix when the fix is proven. [Choose where the work runs](flows.md#choose-where-the-work-runs) says when to pick each flag.

## The stop guard

While a plan is registered and not yet `VERIFIED`, the stop guard keeps the agent's turn going, so an approved run does not stop halfway. Before the agent asks you a real question or hands work back, it records a pause with `buracle plan pause`.

To pause the run yourself, send a message that is only "stop", "wait" or "hold on" (in English or Turkish). Say "continue" or run `/plan-build resume` to go on. [Pause, resume or drop a run](flows.md#pause-resume-or-drop-a-run) lists every control word. You can turn the guard off with `buracle config set plan.stopGuard false`. An agent cannot change that setting.

## Check the diff against the plan

`buracle plan audit` compares the files the plan lists with the diff. It reports planned work that is missing and changes that no task planned, and exits with code 2 when it finds any.

## Other commands

| Command | What it does |
|---|---|
| `/research <question>` | Researches with cited sources: web search, full page reads, library docs, public code and the memory |
| `/inspect <question>` | Traces one question through the code that runs and answers with `file:line` evidence. It changes nothing |
| `/dead-code` | Finds unused files and exports, checks each one against independent signals and returns a staged removal plan. It deletes nothing |
| `/project-rules` | Writes or refreshes `AGENTS.md` and path rules from commands it ran, then runs `buracle project sync` and `buracle project check` |
| `/new-skill` | Turns a procedure you repeat into a skill, or improves an existing one |
| `/find-skill <need>` | Finds a skill for a need and installs it for every harness after an audit |
| `/ab-test` | Measures whether a skill or rule change alters agent behavior, with paired runs in throwaway config folders |
| `/brain` | Opens the [Buracle Stack Console](console.md), and `/brain review` opens its review page |
| `/remember <text>` | Saves the text to the memory as a capture |
| `/aside <question>` | Asks a side question without touching the session |
| `/buracle-status` | Shows the plan, workflow and memory status |

The last four are not native commands in every harness. See [commands per harness](harnesses.md#commands-per-harness).

## Rules and your language

Four short rules load in every session, under 8 KB together, and `buracle rules lint` checks that limit. Longer guidance sits in skill references that the agent reads when it needs them.

Plans, PRDs and reports follow your language. Only the markers Buracle Stack reads, such as `VERIFIED`, stay in English.

---
title: Console
description: The Buracle Stack Console, a local web page for the memory, plan reviews and the workflow settings.
order: 5
---

The Buracle Stack Console is a web page on your own machine, at `http://localhost:41777`. It shows the memory as a brain, lets you review plans and changes, and holds the workflow settings.

## Open it

- In a harness, run `/brain`. In a terminal, run `buracle mem ui --open`, or pick Memory in the `buracle` menu.
- `/brain review` or `buracle mem ui --page review --open` opens the review page.

The Console listens on 127.0.0.1 only. When port 41777 is taken it uses the next free port, and `buracle mem ui --port N` picks one.

## When it runs

With `memory.ui.autostart` on (the default), the install and every harness session start the Console. It stays up while at least one harness session is open. When the last session ends, or shows no activity for 2 hours, the Console stops within about a minute.

| To | Do |
|---|---|
| Stop it until the next session starts | `buracle mem ui --stop` |
| Start it only by hand | `buracle config set memory.ui.autostart false` |
| Keep it from starting by itself at all | Set `BURACLE_NO_AUTOSTART=1` |
| Change how long an unused Console waits | Set `BURACLE_UI_IDLE_MS` (in milliseconds, 30 minutes by default) |

`BURACLE_UI_IDLE_MS` applies to a Console that has not seen a harness session, for example one you started with `buracle mem ui`.

## Views and keys

The main view draws the brain of a project or your person brain, with seven regions for the kinds of memory. The Brain selector switches between them.

| Key | View |
|---|---|
| `/` | Search: matching memories light up in the brain |
| `1` to `7` | A region and its memories: Plans & decisions, Knowledge & ideas, Discoveries & references, You & preferences, Skills & procedures, Warnings & gotchas, Memories & events |
| `G` | The network view of how memories link to each other |
| `H` | Brain health: the brain file and its buckets, CortexDB and the memory server, captures to file, the model's usage headroom, backups (with Back up now) and removing a project from the brain |
| `S` | Settings |
| `T` | Light or dark theme |
| `Esc` | Close the open panel |

Open a memory to manage it. An edit is stored as a new version of the same memory and counts as your own words. Retire takes a memory out of use but keeps it, Restore puts it back, and Delete permanently removes it.

## Review page

The review page lists the plans, goal-build contracts, PRDs and dead-code audits of your registered projects, and the changes the agent made in each checkout and worktree. A plan that waits for your approval is marked.

1. Pick a document or a checkout.
2. In a document, select a passage. In a diff, click a line number, or Shift-click a second one for a range.
3. Write your note and save it with `Ctrl+Enter`.

The agent reads every open note before it asks for your approval and before it finishes a change, and it marks each note it applied. Files whose names look like secrets are not shown.

## Settings

Press `S`. The workflow switches decide how plan-build, goal-build and bugfix run on every harness. A change goes into `~/.buracle/config.yaml` at once and applies the next time a workflow reads it. You can also change a switch with `buracle config set <key> <value>`.

| Switch | Key | Default |
|---|---|---|
| Ask for your approval of a plan before building | `plan.planApproval` | `true` |
| Ask for your approval of the verified result | `plan.resultApproval` | `true` |
| Build on a branch of its own, in a worktree | `plan.branchIsolation` | `true` |
| Ask clarifying questions while planning | `plan.questions` | `true` |
| Independent review of the plan | `plan.reviews.plan` | `true` |
| Independent review of the changes | `plan.reviews.changes` | `true` |
| Independent review of a goal-build contract | `plan.reviews.goal` | `true` |
| Second opinion from another harness | `plan.reviews.companion` | `off` (or `auto`, `claude`, `codex`, `opencode`, `omp`, `qwen`, `pi`, `agy`) |
| Verify a goal-build after its criteria pass | `plan.goalVerification` | `true` |
| Pause after approval to switch the model | `plan.modelSwitch` | `off` (or `manual`) |
| Plan in the harness's own plan mode | `plan.nativePlanMode` | `off` (or `on`) |

An agent cannot change the approval, review and verification switches. A running goal-build keeps the values of `plan.goalVerification` and `plan.reviews.changes` it locked with its contract, so a change applies to the next run.

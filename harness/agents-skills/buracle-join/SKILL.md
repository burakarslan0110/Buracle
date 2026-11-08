---
name: buracle-join
description: "Join a plan's task board as a worker: claim the next open task of a plan-build or goal-build run that another session leads, implement it with TDD in its own lane worktree, report it done, and take the next one. The lead merges and ticks the plan. Run only when the user asks to join a board. The user starts it with /buracle-join (Codex: $buracle-join). When to use: The user invokes /buracle-join <slug> ($buracle-join <slug> in Codex) in a terminal of the same repository, or accepts Buracle's offer at session start that a board has tasks ready for a worker."
disable-model-invocation: true
metadata:
  short-description: "Take and finish tasks of a shared plan board as a worker"
---

# Join a task board

You are a worker on a task board. The lead session published the open tasks of an approved plan; every Buracle session of this repository (Claude Code, Codex, OpenCode, Oh My Pi) can take one. You implement one task at a time in your own lane worktree, report it, and take the next. You never touch the main checkout, the plan file or the plan's state: the lead merges, runs the checks and ticks the boxes. When the lead opened your pane with `buracle work spawn`, the pane closes once no task is open and you hold none, and at `buracle work close`.

## Loop

1. **Claim.** Run `buracle work join <slug> --json` (`--task <n>` for a specific task). It claims the first open task whose dependencies are merged and whose files overlap no active task, creates or resumes the lane worktree `<slug>-t<n>`, and prints the card: `task` (objective, files, Definition of Done), `worktree` (path, branch, base), `constraints` (the plan's `## Constraints`, verbatim), `context` (the plan's `## Context`: commands and entry points) and `plan` (the plan file's path). Read `constraints` and `context` first and honor every constraint. Open the plan file read-only when the card is not enough.
   - `nothing_to_claim`: every open task waits for a dependency or shares a file with an active task. Tell the user and stop; do not take a task by other means.
   - `max_workers`, `usage_low`, `lead_cannot_join`, `already_claimed`: the message says what to do.
2. **Work in the worktree.** `cd` to the printed path for every command and edit. The hooks deny edits outside it, and a shell write outside it is forbidden too. Follow the plan-build implement loop for the task (its I1 steps 2 to 8): prepare with the routed tools (codegraph for callers, context7 for library calls, semble for the local pattern), RED test, minimal GREEN code, refactor, every Definition of Done bullet, then the task's `Verify:` command. Skip I1 step 9: you tick no box and keep no plan todo; commit on the lane branch instead (`git add <files>`, `git commit -m "task <n>: <title>"`).
3. **Lease.** Your claim is a lease (5 minutes by default) that the hooks renew on every prompt and tool call. A command that runs longer than a few minutes goes to the background, and you poll it; a foreground command that outruns the lease lets the task go stale and another worker takes the worktree. If a hook says your task was reassigned, stop at once and claim another with `buracle work join <slug>`.
4. **A question for the user.** Run `buracle work ask "<question>"` first: the task shows as waiting on the board, the lead gets a note, the terminal pane gets a notification (OSC; under tmux `allow-passthrough on` is needed; cmux and herdr are notified too) and its mark: a tmux pane gets the title `Task <n> needs you` and the bell flag, herdr shows the agent as blocked, cmux a notification; with `plan.board.muxOnAsk` `focus` the multiplexer also switches to your pane. Then ask the user with your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi). When the answer arrives, run `buracle work resume` (the hooks do it at the question tool's result or at your next prompt as well) and go on.
5. **Report.** With the worktree committed and `Verify:` green, run `buracle work done --verify "<command → result>"`. The report carries the branch, the commits beyond the base and your evidence; the lead merges in dependency order and runs the checks.
6. **Next task.** Run `buracle work join <slug> --json` again. When nothing is left, tell the user and stop. `buracle work release` without a task leaves the board, so the session edits the repository again; with a task it gives the task back (the worktree stays).

## Rules

- Never run `buracle plan …` or `buracle flow …`: the plan file, its state and the stop guard belong to the lead.
- Never edit the main checkout or another lane's worktree, and never merge your own branch: `buracle work merge` is the lead's.
- Never launch agents from a worker session.
- Notes travel through the board: `buracle work note "<text>"` reaches the lead at its next prompt or wait; `buracle work inbox` shows notes left for you (the hooks deliver them too).
- The stop guard holds your turn while a task is claimed: end it only with `buracle work done`, `buracle work ask` (then the question) or `buracle work release`.
- `buracle work status --json` shows the whole board at any time.

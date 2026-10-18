---
name: goal-build
description: "Goal-and-loop workflow for a clear end state whose path is found while building: agree on a goal, tasks sized as the largest slices you can finish and verify, and at least 3 pass/fail acceptance criteria (one of them the oracle), have them reviewed, lock the contract, then build in rounds judged on running evidence (at most four), verify and hand back. Tracked in docs/builds/. Run only when the user explicitly asks for goal-build."
when_to_use: "The user invokes goal-build by name, or names an end state and asks you to find the way there, working in a loop until it is done."
argument-hint: "<goal: the end state you want> [--worktree | --new-branch | --current-branch]"
disable-model-invocation: true
---

# Goal-build

Turn a clear goal into a locked contract of acceptance criteria, then work toward it in rounds: build every open task, then judge every criterion on a running artifact. Tasks can be reshaped between rounds; the criteria stay fixed. The run file lives in `docs/builds/` and moves through `buracle plan …` like a plan-build plan.

Pick another workflow when the idea is still vague (`/requirements`), when something that used to work is broken (`/bugfix`), or when the user wants to approve a task list before any code (`/plan-build`).

## Ground rules

1. **Criteria are the contract.** Tasks serve criteria. After the lock, tasks may be added, split or dropped; criteria change only when the user rewrites one, or when one turns out impossible to judge in its current wording (then make the smallest rewording that rules the same bar and log it), never because one fails. You never reword the oracle; a user who rewrites it starts a new run.
2. **Ask everything up front.** All questions happen in phase 1. After the lock, the only reasons to talk to the user are a hand-back or a blocker that only they can clear.
3. **Judge on evidence from the running thing.** Missing or ambiguous evidence is a fail. The oracle is judged last, from its own signal and never from a proxy, and it is never relaxed.
4. **At most four judge rounds.** Then hand back, whatever the state.
5. **Evidence or it didn't happen.** Record commands and results; checks you could not run go under `## Unverified`, never into `## Evidence`. `buracle plan verify` refuses while a criterion is not `pass` or `## Unverified` is missing ("None." counts).
6. **State moves only through `buracle plan …`.** Never hand-edit `status`, `approved` or `phase`; raise `rounds` with `buracle plan set rounds <n>`. Edit the body freely.
7. **Use the routed tool** (table below). When Buracle denies a call, switch to the tool the denial names.

## Stopping early: the single escape

An active build keeps going until hand-back.

**Escape hatch:** while a registered plan is not VERIFIED, the stop guard keeps your turn going. The only way out is a pause: `buracle plan pause` (before a real question or a hand-back), or the user saying "stop", "wait" or "hold on" (or the same in their language), which Buracle records as a pause (run `buracle plan pause --kind discussion` too). The user's "continue" or `buracle plan resume` ends it.

- The user asks you to stop, wait or pause (in any language): Buracle records the pause. Run `buracle plan pause --kind discussion --reason "user asked to stop"` as well (harmless if already paused), give a status of at most five lines (round, criteria passing, work in progress), and end the turn.
- You must stop (a hand-back or a blocker): `buracle plan pause --kind decision --reason "build hand-back: <why>"`, report, end the turn. The prefix lets the user's "continue" end this pause.
- Resume: the user says "continue", or invokes `/goal-build` again. Run `buracle plan resume`, re-read the run file, and continue the current round.

Nothing else is an escape: no timers, no repeated stop attempts, no "should I continue?" questions.

## Phases

| # | Phase | Reference | Exit gate |
|---|---|---|---|
| 1 | Goal and scope | [goal-and-contract.md](references/goal-and-contract.md) | Goal restated; oracle, evidence per criterion and false-pass risk known |
| 2 | Draft the run file | [goal-and-contract.md](references/goal-and-contract.md) | `buracle plan validate <path> --strict` exits 0 |
| 3 | Review and lock | [goal-and-contract.md](references/goal-and-contract.md) | goal-build-review handled; `approved: true`; round 1 starts without a question |
| 4 | Build round | [build-and-judge.md](references/build-and-judge.md) | All of the round's tasks ticked; `buracle plan complete` |
| 5 | Judge | [build-and-judge.md](references/build-and-judge.md) | Every criterion ruled with evidence; `rounds` raised by one |
| 6 | Verify | [verify-and-handback.md](references/verify-and-handback.md) | `## Evidence` and `## Unverified` complete |
| 7 | Hand back | [verify-and-handback.md](references/verify-and-handback.md) | `buracle plan verify` (done), or a pause and a report (any other outcome) |

The loop is 4, 5, then back to 4 with the failing criteria turned into tasks, until every criterion passes (go to 6), the round limit is reached or no closable criterion is left (go to 6, then 7 without `buracle plan verify`), or a blocker ends it (go to 7). Read each reference in full when you enter its phase.

## Progress

Buracle shows the run live, in the workflow band above the prompt and in the status line. Keep it current with `buracle flow`; the calls are cheap and best effort, so a failing one never stops the run.

- Start or resume: `buracle flow start goal-build --title "<goal title>"` (harmless when a hook already started it).
- Each phase: `buracle flow phase <id>` with `goal` (phase 1), `contract` (phases 2 and 3), `build` (every round), `judge`, `verify`, `handback`. The references make these calls where each phase starts.
- End: `buracle flow end --outcome done` for the done outcome, `--outcome failed` for the other hand-back outcomes (when the user then asks for another round, start the flow again).

## Start: route by state

Strip `--worktree`, `--new-branch` or `--current-branch` from the goal text: the flag answers phase 1's "Where should the build run?" question.

Run `buracle plan status --json`, then:

| Situation | Go to |
|---|---|
| The user passed a `docs/builds/*.md` path | `buracle plan register <absolute path> --phase plan` while `approved: false`; otherwise `buracle plan register <absolute path>` without `--phase`, so the CLI keeps the phase the run file records; then route it by the rows below |
| The request names a PRD (`docs/prd/*.md`, frontmatter `type: prd`) | Phase 1, with the PRD's problem, Must requirements and *Out of scope* list as the goal input; cite the PRD path under `## Goal` and do not re-ask what it settled |
| A new goal while an unfinished plan or run is bound | Ask with `AskUserQuestion`: continue the bound one (a plan-build plan continues in `/plan-build`), or start the new goal after `buracle plan unregister` |
| Nothing bound | Phase 1 with the user's goal |
| The bound run is paused | `buracle plan resume` (invoking goal-build again counts as "continue"), then route by the rows below |
| `approved: false` | Phases 2 and 3: finish the draft, the validation or the review |
| `approved: true`, status `APPROVED` or `IN_PROGRESS` | Phase 4, current round |
| Status `COMPLETE`, phase `implement` | Phase 5, judge |
| Phase `verify` | Phase 6 |
| `VERIFIED` | Done: summarize the last report and change nothing |

Re-read the run file and the reference of the phase you land in. Do the same after every compaction.

## Key commands

- `buracle plan init --type build --title "<goal title>" --json` prints `{path, slug}` for a file under `docs/builds/`.
- `buracle plan register <absolute path> --phase plan` while drafting; without `--phase` for a locked run (it keeps the recorded phase).
- `buracle plan validate <path> --strict --json`
- `buracle plan set approved true`, `buracle plan set status APPROVED|IN_PROGRESS`, `buracle plan set phase implement|verify`, `buracle plan set rounds <n>`
- `buracle plan complete` when a round's tasks are done; `buracle plan verify` only for the done outcome.
- `buracle plan pause --kind discussion|decision --reason "<r>"`, `buracle plan resume`
- `buracle plan notes [<path>] [--kind plan|code] [--slug <slug>] --json` lists the user's open notes from the review page; `--done <id>[,<id>]` marks the ones you applied.
- `buracle review-scope --json`; `buracle worktree create <slug> --prefix goal-build --json` (branch `goal-build/<slug>`); `buracle worktree branch <slug> --prefix goal-build --json` (a new branch in this checkout that records its base); `buracle worktree diff|sync|cleanup <slug>`
- `buracle notify info|attention_needed|verification_complete "<title>" "<message>" --plan <path>`

## Talking to the user

Reply and write the run file in the language of the user's prompt. Keep the markers Buracle reads (listed in the *Plain language* rule; `## Unverified` among them, which `buracle plan verify` reads), commands and identifiers verbatim; every other heading and sentence follows the user's language.

Phase 1 is the only planned conversation. Ask with `AskUserQuestion`: 2 to 4 concrete options, your recommendation first; if it is unavailable, ask in plain text with numbered options. Once the run file is registered, pause before any question that could end your turn (`buracle plan pause --kind decision --reason "<question>"`), and run `buracle plan resume` after the answer.

Go by the meaning of the reply, in whatever language it comes:

| User says | Do |
|---|---|
| stop, wait, pause, hold on | pause as described above, short status, end the turn |
| continue, go on | `buracle plan resume`, continue the current round |
| a new or reworded criterion | the user may rewrite any criterion but the oracle: update the table, log the before and after in `## Rounds`, re-judge it in the next judge pass |
| a rewritten oracle | a new goal: say so in one line and offer a new run (phase 1, after `buracle plan unregister`) |
| you decide, either is fine | take your recommendation; record it under `## Assumptions` |

Any other message during a run is steering: answer briefly, apply it to tasks (not criteria, unless it rewrites one) and keep working. The user can also steer without a message: by editing the run file, or by pinning notes on the review page (`/brain review`); you read both at the start of every round. If Buracle reports the run as paused, answer and wait for the user to say "continue".

## Tool routing

| Need | Use | Fallback |
|---|---|---|
| Find code by intent | semble `search`; similar code: `find_related` | `rg` |
| Callers, callees, blast radius | codegraph (`codegraph_explore`) | `rg` on the symbol |
| Exact identifiers and strings | `rg` | none |
| Library API at the installed version | context7: `resolve-library-id`, then `query-docs` | web-fetch on the official docs |
| Web facts, error messages, references to compare against | web-search, then web-fetch | none |
| How public projects solve the same thing | grep (public code search) | web-search |
| Earlier decisions and gotchas | buracle-memory: `memory_search`, then `memory_get` | `buracle mem search "<q>"` |
| Judging or testing a web UI | chrome-devtools | the repo's Playwright setup |
| Long test, build or log output | context-mode: `ctx_batch_execute` or `ctx_execute`, printing the counts and every failure | the shell, output narrowed |

An empty search result is not proof of absence: rephrase once or switch tools. If a server is down, use the fallback and say so in the hand-back.

## Lanes and documents

A build round is made for parallel work per the *Parallel agents* rule: you are the lead, each lane is an agent you launch with the `Agent` tool, and you integrate.

| Phase | Lanes | Mode | Each lane returns | Then you |
|---|---|---|---|---|
| contract (2) | 2 to 4 explorers, as in plan-build's plan phase: the code map, the tests and commands, memory and docs, outside facts | read-only | `path:line` facts and the exact commands | write the tasks and criteria |
| build (4) | one lane per group of open tasks whose files do not overlap and that wait for no open task | editing; with 2 or more lanes, each in `buracle worktree create <slug>-<n> --lane --prefix goal-build` | the commits on its branch, the test output, the `Verify:` result, the paths it touched | `buracle worktree sync`, the checks after every merge, the ticks and `## Files Touched` |
| judge (5) | one lane per non-UI criterion, after you started the artifact and proved it is this round's code; briefed with the judge rules (artifact only, two verdicts, no proxy) | read-only | pass or fail with the command and its key output | judge the UI criteria one at a time yourself, then the oracle last |
| verify (6) | the changes review in the background | read-only | the JSON report | run the checks meanwhile, then triage |

Lanes never write the run file. Tasks that share files or build on each other stay in your session, in order.

The contract, the run file and the hand-back follow the *Plain language* rule, in the language of the user's prompt: the hand-back opens with the outcome, then the criteria table with its verdicts and the evidence per row, and a diagram of the built flow when more than two modules took part.

## Review agents

Launch `buracle:goal-build-review` (phase 3) and `buracle:changes-review` (phase 6) with the `Agent` tool, inputs as labeled lines, ending with "Return only your JSON report." In the input blocks of this skill, the first line names the agent to launch and the remaining lines are its prompt. Run the changes review in the background when the harness supports it. The final message must be one JSON object: `verdict` (`pass` or `needs_changes`), `summary` (starting with the path of the file it reviewed), `findings` (each with `severity` `must_fix`, `should_fix` or `suggestion`, plus `category`, `title`, `evidence`, `suggested_fix` and optional `file` and `line`), optional `goal_score` (0–100), and, from the changes review, `truths` (each `verified`, `failed` or `unverified`, with `evidence`). Missing, malformed, or about another file: relaunch once, then review against the same concerns yourself and say so. Check every finding against the run file or the code before acting. Record a background reviewer right after the launch (`buracle plan review start --role goal|changes --handle <id>`), so that after a compaction you collect it instead of launching it again, and `buracle plan review done --role <role> --verdict <verdict>` after the triage. `plan.reviews.goal`, `plan.reviews.changes` and `plan.goalVerification` (read in phase 1, fixed at the lock) can switch a reviewer or the verification phase off; the references say what replaces each. **Second opinion** (`reviews.companion`, `off` by default): right after a reviewer starts, run `buracle plan review companion start --role goal|changes --input -` with the reviewer's input lines (all but the first) on stdin, as a heredoc. It runs the same review read-only on another installed harness, once per run and role; collect it before the triage with `buracle plan review companion collect --role <role> --wait 90 --json` (again while it says `running`), triage its findings like the reviewer's and weigh both equally. It records itself. When it says `unavailable` or `failed`, go on without it and write one line under `## Review Notes`.

## When things go wrong

- `buracle: command not found`: stop and tell the user Buracle is not installed or not on PATH. Never edit session state by hand.
- A `buracle plan …` command exits 2 with "no session": continue from the run file, tell the user once that the stop guard is off for this run, suggest `buracle doctor`.
- `buracle plan validate` exits 1 or 2: fix and re-run until exit 0. Never merge or drop a real criterion to fix a count warning.
- `buracle plan verify` refuses a `fail` or `open` criterion: the run is not done. Judge again, or at the round limit (or with no closable criterion left) pause and hand back; never edit a verdict to get past it. A row it cannot read: rewrite it as `| C<n> | … | <verdict> |`, keeping its verdict.
- The same criterion fails twice with the same approach: change the approach, not the criterion.
- Context filling up: make sure checkboxes, the criteria table, `## Rounds` and `## Files Touched` are current. The run file is your memory across a compaction; context pressure never justifies a tick, a pass or a hand-back.

## Done means

The hand-back report has been delivered and the run is either VERIFIED (done) or paused with a named outcome. See [verify-and-handback.md](references/verify-and-handback.md) for the report format, the notification and the memories to write.

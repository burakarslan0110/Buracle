# Phases 4–5: build rounds and judging

Outcome per round: every open task done, then every criterion ruled pass or fail with evidence you can point at. Rounds repeat until all criteria pass or the run must be handed back.

## 4. Build round

1. **Start of the round.** Mark the phase: `buracle flow phase build --note "round <r>"`. Re-read the whole run file; the user may have edited it, and a criterion they rewrote replaces yours. Then read the notes the user pinned in the review page since the last round: `buracle plan notes --json` (notes on the run file, and on this run's changed lines; add `--slug <slug>` in a worktree run). Fold each into this round's tasks; a note that rewrites a criterion other than the oracle is a criterion change, logged in `## Rounds` with the before and after. Mark each applied note with `buracle plan notes --done <id>[,<id>]`. Worktree run: `buracle worktree detect --json` (again after every compaction or resume), and do all work from the path it prints. Branch run (the `## Assumptions` isolation line names a new branch): when `git branch --show-current` prints another branch, `git switch <that branch>` (commit or stash first if git refuses); never run `buracle worktree branch` again for it. `buracle plan set status IN_PROGRESS`. In {{todo}}, add one item per unticked task.
2. **For each open task** (when 2 or more open tasks have no file in common and wait for no open task, run them as lanes instead, SKILL.md *Lanes and documents*; each lane does the steps below except the tick and `## Files Touched`, which you do after syncing it):
   - Prepare with the routed tools: codegraph for the blast radius of shared code you will change, context7 for every library call, semble `find_related` for the local pattern to follow.
   - Behavior you can test: write a failing test, then the smallest code that passes it, then tidy up while green. Before the assertion, name the production change that would make it fail; if you cannot, the test only detects change, so test the observable behavior instead. Then a mutation check: a wrong constant, a wrong branch, a missing side effect, an empty return and a missing validation should each fail some test. Prose, design, research and config are exempt; say so in one line.
   - Run the task's `Verify:` command. Only when it is green, change its line to `- [x] Task N done` and complete its item in {{todo}}.
   - Add each path you touched to `## Files Touched` (repo-relative, one line with a short reason; create the section the first time).
   - Worktree run: commit on the worktree branch (`git commit -m "round <r>, task <n>: <title>"`). Outside a worktree, commit only if the user asked for commits.
3. **A red command keeps the task open.** Record it in `## Rounds` as the command and its status (`bun test tests/sync.test.ts: fail, 2 of 14`), never as prose such as "mostly passing". Never tick the task, and never narrow the command until it goes green.
4. **Name only what the file says.** Before you name a task number in a message, read it from the run file's checkboxes; when your sentence and the file disagree, the file is right.
5. **A task waiting on a long job inside this session** (a slow test run, a data build) stays open and unticked. You may work a later task meanwhile; say so in the same sentence ("Task 4 is still running; working on Task 5"). Nothing renumbers, and `buracle plan complete` waits for it. Run long jobs as the core *Autonomy* rule says.
6. **Standing stop conditions.** Each halts the task and gets one line in `## Rounds`:
   - The behavior the objective names is ambiguous and the artifact cannot settle it: record the reading you took and why, so the judge and the report carry it.
   - Verification failed twice on the same task with different fixes: the diagnosis is wrong. Re-read the failure from the top instead of trying a third fix.
   - The task needs a change outside anything this run touched or was asked to touch: record it, and treat it as scope growth (the core *Questions and approvals* rule).
7. **Tasks are flexible; criteria are fixed.** When you learn something, add, split or drop tasks and log each change as one line in `## Rounds`, for example `R2: split Task 3; parsing and rendering fail for different reasons`.
   - Two tiny tasks in a row (a helper, a wrapper, a config file) mean the round stopped moving criteria: before adding a third, name the criterion the next task closes.
   - Dropping a task that a criterion's evidence needs is a criterion change: keep the task.
8. **Processes.** Keep the handles of the servers and watchers this run starts, reuse them across judge and verify, and stop them when they are no longer needed. Never stop one the user or another session started.
9. **Blocked from outside** (a credential, an external service, a decision only the user can make): finish everything else first, then hand back with the blocked outcome ([verify-and-handback.md](verify-and-handback.md)). A filling context window is never such a blocker: re-read the run file and continue.
10. **All tasks ticked:** `buracle plan complete`, then judge.

## 5. Judge

Mark the phase: `buracle flow phase judge --note "round <r>"`.

1. **Get a running artifact** for criteria that rule on runtime behavior (otherwise say in the round line that the evidence is static). On a worktree run, start everything from the path `buracle worktree detect --json` prints: a server started in the base checkout serves code this round did not write, and its verdicts look well evidenced while being wrong. The first tier that yields a target wins:

   | Tier | Target | Move on when |
   |---|---|---|
   | 1 | A running server, but only one that serves from the run's checkout | nothing suitable is listening |
   | 2 | The documented dev server, started in the background when the harness supports it, health polled for up to 60 s | no documented start command |
   | 3 | The built and installed artifact (a mobile or desktop app, an extension, a CLI binary), installed the way the project's docs say. When it applies, it beats tier 2: a dev server serves the source, not what the user opens | no documented build-and-install path |
   | 4 | A remote preview or deployment the user already authorized, with the project's own command | no authorized target |
   | 5 | None: rule what static evidence settles, and mark the rest fail with the missing evidence | |

   The first time, write a `## Live Target` section: the tier, the start command, the identity check and the browser driver you settled on. Later rounds and phase 6 reuse it instead of repeating dead ends.
2. **Prove it is this round's code.** A recorded target is a cached resolution, not a fresh artifact: restart or rebuild after building, then confirm a version string, a new log line or a changed response, on every judge pass.
3. **Reference.** If the run has one, obtain it again with the command under `## Reference` (never from memory) and put both side by side with their labels stripped.
4. **Collect the evidence that matches the criterion:**

   | Criterion is about | Evidence that settles it |
   |---|---|
   | something visual | a screenshot at the viewport the criterion names (`resize_page` or `emulate` in chrome-devtools); when the browser tool cannot set a viewport, say so in the round line |
   | an interaction | a snapshot, the click or input, and a second snapshot showing the new state |
   | prose | the passage itself, read |
   | code behavior | the command, benchmark or test the criterion names, actually run |

5. **Rule every criterion** pass or fail with one line of evidence you can point at right now: the command and its key output, a test name, a screenshot path, a URL. With 2 or more non-UI criteria, give each to a read-only lane with the artifact's address, the criterion's check and the rules below (SKILL.md, *Lanes and documents*), check one lane's evidence yourself, and judge the UI criteria one at a time in your own session.
   - **Judge from the artifact only:** not from your build reasoning, your intentions or how hard the work was.
   - **Calibrated:** pass a criterion whose evidence meets what it asks. Raising the bar mid-judge is not rigor; a loosely written criterion is a lesson for the next run.
   - **Two verdicts only.** "Partial", "mostly", "should", "probably" and "close enough" are not verdicts: look at the artifact again and rule. Missing or ambiguous evidence is a fail.
   - **Every criterion, every pass.** A criterion that passed earlier and fails now goes back to `fail`: the table shows the truth, not the best round.
   - **The oracle last, from its own signal.** A proxy is not its evidence: a green suite is not the walkthrough, a 200 is not the flow, a word count is not the piece landing. When the other criteria pass and the oracle fails, write in the round line that the round built good work aimed at the wrong thing.

   ```text
   C2: pass. curl -s localhost:3000/notes/7 returned {"text":"offline edit"} 6 s after reconnecting; server log 12:04:11 "sync applied 3".
   C4: fail. The second profile shows no note after 30 s; console "409 conflict" (screenshot tmp/r2-c4.png).
   ```

6. **Record.** Update the Status column of the criteria table. Raise `rounds` by one (`buracle plan set rounds <n>`). Add one row to `## Rounds` (create it the first time):

   ```markdown
   ## Rounds
   | Round | Passing | Failing | Note |
   |---|---|---|---|
   | R1 | C1, C3 | C2, C4 | sync fires before the auth token is refreshed |
   ```

7. **Next step.** Every criterion passes: run `buracle plan set phase verify` and go to verification ([verify-and-handback.md](verify-and-handback.md)). Otherwise, first prepare the next round in every case: turn each failing criterion that is still closable into one or more new or reopened tasks (untick a card, or add one with Files and a DoD), then `buracle plan set status IN_PROGRESS`. When a criterion has failed twice with the same approach, the new task must try a genuinely different one. Then:
   - `rounds` below 4: start the next round.
   - `rounds` has reached 4, or the extra round the user asked for is spent: verify, then hand back with the round-limit outcome.
   - A failing criterion is **not achievable** only when all three hold: two genuinely different mechanisms were tried (not the same one with better parameters); the blocker is concrete and checkable by someone else (the API cannot do it, required hardware is missing, two criteria contradict); and it is not "not yet" (slow progress, a hard problem and a full context window do not count). Your own conviction is not proof. Then stop that criterion only: leave it `fail` with `not achievable: <blocker>` in its Evidence cell, log the blocker and the two failed approaches in `## Rounds`, and keep working every criterion that is still closable. Only when no closable criterion is left: verify, then hand back with the not-achievable outcome.

   Because the next round is already prepared, a later "continue" starts real work instead of re-judging.

Between rounds, do not ask the user anything. The next round starts in the same turn.

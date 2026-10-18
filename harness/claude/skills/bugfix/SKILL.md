---
name: bugfix
description: "Plan-less bug workflow that owns one defect end to end: reproduce it first, trace the root cause to file:line, write a failing test, fix at the source, prove the fix on the real program, then pass the quality gate. With branch isolation on it asks where to work: the current branch, a bugfix/<slug> branch or a worktree squash-merged once the fix is proven; no plan file. Run only when the user explicitly asks for bugfix."
when_to_use: "The user invokes bugfix by name or explicitly asks for this workflow (\"solve it with bugfix\", \"use the bugfix workflow\"), bringing a failing test, an error message, a crash or a regression. A plain \"fix this\" is handled directly, without this workflow."
argument-hint: "<bug: symptom, failing test, error or steps> [--worktree | --new-branch | --current-branch]"
disable-model-invocation: true
---

# Bugfix

Own one defect from report to proven fix without a plan file. Use `/plan-build` instead when the user wants a reviewed plan and an approval gate before code, and `/goal-build` for new behavior.

No plan is registered, so no stop guard holds this run open: you keep it going yourself until *Done means* is satisfied or a real blocker stops you.

## Ground rules

1. **See it fail first.** Run the failing test, command or steps before forming any theory, and read the whole output.
2. **Name the root cause.** No fix until you can write `file:line`, what that code does, what it should do, and why.
3. **Red before green.** A test that fails with the reported symptom exists before the fix. If a test is truly impossible, an exact reproduction command serves as the failing check, and the report says why.
4. **Fix where the fault starts,** in the code that creates the bad state, not where it surfaces.
5. **Proven means run.** Done requires the original symptom re-run on the real program, not only the new test passing.
6. **The bug stays yours.** Size or difficulty never hands it to another workflow. Stop only for a real blocker, and name the step that clears it. If the investigation shows the "bug" is missing behavior or a quality gap, say so and keep going toward the end state the user asked for when it is safely inferable; ask only when the new reading needs a product decision.
7. **Competing hypotheses run in parallel.** When the investigation leaves two or more plausible root causes, give each to a read-only lane whose job is to refute it (*Lanes*), and keep the one that survives with `file:line` evidence. The fix itself stays in your session.
8. **Report per the *Plain language* rule,** in the language of the user's prompt: the outcome first, and a `sequenceDiagram` of the failure path when the cause sits more than one call away from the symptom.

## Lanes

Lanes follow the *Parallel agents* rule; each is a read-only agent you launch with the `Agent` tool. RED, the fix and the proof stay in your session, because one variable changes at a time.

| Phase | Lanes | Each lane returns | Then you |
|---|---|---|---|
| investigate | one refuter per plausible root cause, when there are 2 or more; it reads code and runs the reproduction, but never edits files or adds `BURACLE-DEBUG` lines | refuted or survived, with `file:line` and command → result | keep the cause that survives |
| gate | the changes review in the background while you run the full suite; one lane per unrelated failure that reruns it on the base commit in a detached checkout | the JSON report; "fails the same way" or not, with the output | triage and report pre-existing failures |

## Setup

1. `TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any): Investigate · RED · Fix · Prove · Quality gate · Finish. Start the progress record: `buracle flow start bugfix --title "<symptom>"` (see *Progress*).
2. Where to work. Strip `--worktree`, `--new-branch` or `--current-branch` from the bug text; a flag is the answer. Without one, read `buracle config get plan` once (assume the shipped defaults when it fails). If `branchIsolation` is `true` and `questions` is not `false`, ask once with `AskUserQuestion`, recommending by risk (a one-line fix on a clean tree: current branch; a fix that touches several modules or a dirty tree: worktree). Isolation off and no flag: work on the current branch without asking. Questions off (`plan.questions: false`): take the recommendation by risk without asking and name it in the report. `<slug>` is two to four kebab-case words from the symptom.
   - **Current branch:** nothing to set up.
   - **New branch:** `buracle worktree branch <slug> --prefix bugfix --json` before editing. It switches to `bugfix/<slug>` (or `-2` and so on when that name is taken) from the current HEAD and records the base, so the review diffs only this fix. Uncommitted changes come along; mention them in the report. Use the branch it prints from here on, in the commit and the report.
   - **Worktree, squash-merged once the fix is proven:** `buracle worktree create <slug> --prefix bugfix --json`, then make every edit and run every command under the `path` it prints. Its warning that no plan was marked, or that the session's plan was left untouched, is expected: bugfix has no plan file. The merge happens in Finish.
3. Memory pass: `memory_search` for the error text and the module, at most three queries; `memory_get` at most three hits. A matching gotcha is a lead, not a verdict.

## Progress

Buracle shows the run live, in the workflow band above the prompt and in the status line. Keep it current with `buracle flow`; the calls are cheap and best effort, so a failing one never stops the run.

- Start: `buracle flow start bugfix --title "<symptom>"` in Setup (harmless when a hook already started it).
- Each phase: `buracle flow phase <id>` as its section begins, with `investigate`, `red`, `fix`, `prove`, `gate`, `finish`.
- End: `buracle flow end --outcome done` after the report; `--outcome failed` when a blocker stops the run; `--outcome cancelled` when the user drops it.

## 1. Investigate

`buracle flow phase investigate`, then follow [references/investigate.md](references/investigate.md). Exit gate: a reproduction that fails reliably (ideally in under 30 seconds) and a root-cause statement with high or medium confidence, for example:

```text
src/billing/total.ts:27 — sumItems loops while i < items.length - 1, so the last line item is never added; the loop must visit every index. Introduced in a1b2c3d. Confidence: high.
```

## 2. RED

- `buracle flow phase red`.
- Write the test at the public entry point the user hits (route, CLI command, exported function), in the existing test file and style of that module.
- Assert the expected behavior and run only that test. It must fail **with the reported symptom**: the same wrong value or the same error.
  - It fails for another reason (an import, a typo, missing setup): fix the test setup and run it again.
  - It **passes** on the current code: the test does not encode the bug, or the root cause is wrong. Do not bend the test until it fails, and write no fix: go back to Investigate with this as new evidence.
  - It cannot run at all (an environment blocker): follow the blocker protocol in [references/investigate.md](references/investigate.md). No fix without an observed RED.
- Keep the command and the key failing lines for the report.

## 3. Fix at the source

- `buracle flow phase fix`.
- Change the code at the root cause, minimally. Touching a shared function: list its callers with codegraph and run their tests too.
- Forbidden: special cases keyed on the reproduction input; catching and swallowing the error; sleeps or retries that hide a race; a null check at the crash site that ignores why the value is null; editing the test to accept the wrong result; unrelated refactors.
- Same flaw elsewhere? Run semble `find_related` on the faulty code. Fix copies that share the root cause; list other look-alikes as follow-ups.
- The RED test passes now, and so do the tests of every module you touched.
- **RED still fails after the fix:** the root cause is not proven. Revert this edit with the edit tools (never `git checkout --` or `git restore` on a file that may also hold the user's changes), re-run the original reproduction, and go back to Investigate with the new evidence. Never stack a second patch on an unproven one.

## 4. Prove

`buracle flow phase prove`, then re-run the original reproduction against the real program and collect the evidence that matches its surface: [references/prove-and-finish.md](references/prove-and-finish.md), *Prove*. When the symptom persists there while the RED test passes, the test sits below the user's entry point: move it up and redo RED, the fix and Prove.

## 5. Quality gate

`buracle flow phase gate`, then the full suite, type check, lint, build, the diff checks (the root-cause file is in the diff, symptom patterns are justified, `rg -n "BURACLE-DEBUG"` finds nothing), and a changes review of every proven fix: [references/prove-and-finish.md](references/prove-and-finish.md), *Quality gate*.

## 6. Finish

`buracle flow phase finish`, then one end question (commit, request changes, or explain), the worktree merge when you work in one, an optional `gotcha` memory, and the report with its mandatory `E2E:` and `Docs:` lines: [references/prove-and-finish.md](references/prove-and-finish.md), *Finish*. Close with `buracle flow end --outcome done`.

## Talking to the user

Reply in the language the user writes in. Ask only where to work (Setup), for missing reproduction details, an environment blocker, a fix that needs a product decision, and the end question in Finish. `plan.questions: false` drops only the where-to-work question; the others stop the run on a real blocker or a decision that is the user's, so they stay. Use `AskUserQuestion` with 2 to 4 concrete options, your recommendation first; if it is unavailable, ask in plain text with numbered options and end the turn.

Go by the meaning of the reply, in whatever language it comes:

| User says | Do |
|---|---|
| stop, wait, hold on | stop after the current step; report the phase, the root cause so far and the files changed |
| continue, go on | continue from the current phase |
| you decide | take your recommendation and say so in the report |
| "stop guessing", "is that not happening?", "think it through" (a complaint about guessing, not a request to halt) | a hypothesis was treated as a finding: name the claim you had not proven, and go back to Investigate, *Trace to the source* |

Never ask whether to continue between phases; just continue.

## Tool routing

| Need | Use | Fallback |
|---|---|---|
| Where an error is raised, exact strings | `rg` | none |
| Code by intent, other paths producing the same data | semble `search`; look-alikes: `find_related` | `rg` |
| Who called this with bad input, what returned it, blast radius | codegraph (`codegraph_explore`) | `rg` on the symbol |
| Library behavior at the installed version | context7: `resolve-library-id`, then `query-docs` | web-fetch on the official docs |
| Known issues for an error message, fixed versions | web-search, then web-fetch the issue or changelog | none |
| Correct usage in public code | grep (public code search) | web-search |
| Earlier gotchas and decisions | buracle-memory: `memory_search`, then `memory_get` | `buracle mem search "<q>"` |
| Reproducing or proving a UI bug | chrome-devtools | the repo's Playwright setup |
| Long test, build or log output | context-mode: `ctx_batch_execute` or `ctx_execute`, printing every failure and error with its full message | the shell, output narrowed |

Use codegraph whenever the path leaves the code you have already read; skip it while the defect is confined to one function you fully understand. An empty search result is not proof of absence. If a server is down, use the fallback and say so in the report.

## When things go wrong

- **Cannot reproduce:** [references/investigate.md](references/investigate.md), *Cannot reproduce*. Never ship a fix for a bug you have not seen fail, unless the user explicitly accepts a speculative fix; label it as one in the report.
- **The environment blocks the reproduction** (an expired login, a private registry, a service only the user has): the *Environment blocker* protocol in [references/investigate.md](references/investigate.md). Never reason around it; only the user may choose to go on without running it.
- **Root cause in a dependency:** confirm it with context7 and web-search (a known issue, fixed in a newer version?). If a patch-level upgrade within the project's constraints fixes it, propose it and upgrade after the user agrees. Otherwise work around it at your boundary, cover the workaround with a test, and link the upstream issue.
- **The proper fix needs a redesign:** it is still your bug. Explain the root cause, propose the proper fix and a minimal safe alternative with their trade-offs, ask once, then carry out the choice.
- **Flaky reproduction:** make it deterministic first (fixed seed, fake clock, forced ordering), or raise its rate until it is debuggable ([references/investigate.md](references/investigate.md), *Reproduce first*).
- **Unrelated failures in the full suite:** check them on the unmodified code in a throwaway worktree. Report pre-existing failures; never fix or hide them silently.
- **`buracle` missing:** the workflow still runs; skip the `buracle` steps and note it in the report.

## Done means

The reproducing test passed after failing for the right reason, the original symptom is gone on the real program, the quality gate is green, instrumentation is removed, the docs match the fixed behavior (or the report says "no doc impact"), a worktree run is merged into its base with the suite green there, and the user has the report with its `E2E:` and `Docs:` lines.

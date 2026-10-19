# Plan phase (bugfix)

Outcome: an approved bugfix plan built on a bug you have seen fail and a root cause you can point at. No production code in this phase; temporary instrumentation is allowed and must be marked.

Bugfix plans are stricter than feature plans: a reproducing test always comes first, the fix lands where the fault starts, and nothing is exempt from the RED step.

## B1. Preconditions

Same as [plan.md](plan.md) P1: no read-only plan mode, `buracle flow phase plan`, read the switches once with `buracle config get plan`, then a memory pass. Search memory for the exact error text and the module name first; a matching gotcha is a lead, not a verdict.

## B2. Behavior contract

Before investigating, pin down what "fixed" means:

- **Given:** the state or setup.
- **When:** the action that triggers the bug.
- **Actual:** the wrong behavior, with the exact symptom (message, value, status code).
- **Expected:** the correct behavior.
- **Unchanged:** behaviors that must stay as they are, each with the existing test that guards it or the new test you will add.

If the report has no reproducible When or Actual, ask the user once with {{ask_user}} for the missing pieces: exact steps, input, versions, logs. Offer the specific items you need as options. Pause first and announce the batch as in [plan.md](plan.md) P4 (`buracle notify attention_needed …`).

If `branchIsolation` is on and the request carried no `--worktree`, `--new-branch` or `--current-branch` flag, ask [plan.md](plan.md) P4's "Where should implementation run?" question once, with the same options and together with the missing pieces when you ask for those; P9 applies the answer. No answer: take the recommendation and record it under `## Assumptions`.

**Questions off** (`questions: false`): ask neither question here. Take the isolation default and record it as in [plan.md](plan.md) P4, and go straight to B4 to reproduce from what the report gives. The blocker questions of B4 (cannot reproduce, an environment blocker) are still asked: a fix for a bug you have not seen fail is never planned.

Before you lock the contract, probe it once for sibling cases of the same bug, the bugfix form of the Edge sweep in [plan.md](plan.md) P6:

1. **Boundary input** on the same code path: empty, zero, negative, the maximum length, exactly at a limit, whitespace only, duplicates, non-ASCII text and locale-sensitive casing (the Turkish dotted and dotless i).
2. **Cancel or abort:** when the user can start the broken action, does cancelling it break too, or does it already work?
3. **Concurrency:** does the bug show only when two callers run the path at once, or only alone?

Each sibling you find either joins Expected (so the Task 1 test covers it) or goes under `## Assumptions` with the reason it is out of scope. The reproducing test catches only what the contract names.

## B3. Create the plan file

`buracle plan init --type bugfix --title "Fix: <symptom>" --json`, then `buracle plan register <absolute path> --phase plan`. Write the behavior contract into `## Behavior Contract` immediately and add findings as you go.

## B4. Reproduce first

1. Run exactly what was reported: the failing test, the CLI command, the HTTP request, or the UI steps through chrome-devtools (navigate, act, read the console and network). Read the complete output; the first error is usually the cause and later ones are fallout.
2. Save the exact command line; verification re-runs it.
3. Minimize: the smallest input and fastest command that still fails, ideally under 30 seconds.
4. Flaky or timing-dependent: make it deterministic (fixed seed, fake clock, forced ordering, a barrier inside a test) before going further.
5. Cannot reproduce: compare environments (runtime and dependency versions, config, environment variables, data). Still nothing: pause (`buracle plan pause --kind decision --reason "cannot reproduce"`) and ask for what is missing. Never plan a fix for a bug you have not seen fail.
6. Environment blocker (a service is down, a credential is missing): name it together with the exact command or step that unblocks it, pause with `--kind manual`, and ask.

## B5. Trace to the root cause

Work backwards from the symptom to the place where the bad value or state is first created.

1. `rg -n "<exact error text>"` finds where it is raised. Open that frame.
2. codegraph from the failing frame: callers (who passed the bad input?) and callees (what returned it?). Repeat one layer at a time.
3. semble `search` for other code that produces or transforms the same data.
4. History: `git log -S'<symbol>' --oneline`, `git log -L :<function>:<file>`, `git blame -L <from>,<to> <file>`. A recent change near the symptom is a strong lead. With a known good and bad commit, run `git bisect` in a throwaway worktree (`git worktree add --detach "${TMPDIR:-/tmp}/bisect-<slug>" <bad-commit>`, then `git bisect reset` and `git worktree remove --force` on that path when done), never in the user's checkout.
5. Libraries: context7 for the installed version's documented behavior; web-search the exact error message for known issues and fixed versions.
6. When reading is not enough (async code, timing, UI state), add temporary logging that contains the marker `BURACLE-DEBUG`, so it can be found and removed later.
7. Hypotheses: write one to three, the most likely first, each with the observation that would disprove it. Run the cheapest disproving check first and change one thing at a time.
8. Root-cause statement (required), with confidence:

   ```text
   src/billing/total.ts:27 — sumItems loops while i < items.length - 1, so the last line item is never added; the loop must visit every index. Introduced in a1b2c3d ("refactor totals"). Confidence: high.
   ```

   High: changing that line changes the reproduction. Medium: the trace is consistent but untested. Low: keep investigating; do not plan yet.
9. Compare with a working example: find code that does the same job correctly (semble `search` for the intent, `find_related` on the faulty code), list every difference between the two, and test the differences you cannot rule out by reading. "That cannot matter" is not a reason to skip one.
10. Same flaw elsewhere: semble `find_related` on the faulty code. Copies with the same root cause belong in the fix; other look-alikes go under `## Follow-ups`.

## B6. Write the plan

Fill the file from `buracle plan init` and keep its frontmatter and layout (the CLI's layout wins over this example). Sections: Behavior Contract, Root Cause (statement plus evidence: reproduction command, output excerpt, trace), Context (files with `path:line`, and the test and run commands), Tasks, then Risks and Assumptions when there are any. The task rules of [plan.md](plan.md) P6 apply (Files, DoD, `Verify:`, no placeholders).

**Defense in depth:** when the bad value crossed layers on its way to the symptom (an entry point, the business logic, a storage or environment guard), add a `Defense in depth:` line under `## Root Cause` that names each layer and the check it gets. The fix still starts at the root cause; the extra checks go into Task 2, with their files in its Files list and a DoD bullet each.

Every bugfix plan has the same three tasks:

1. **Reproduce in a failing test.** The test goes through the public entry point the user hits (route, CLI command, exported function), in the existing test file and style for that module. DoD: it fails on the current code with the Actual symptom.
2. **Fix at the root cause.** Files include the root-cause file. DoD: the Task 1 test passes, the tests named under Unchanged pass, and no `BURACLE-DEBUG` line remains.
3. **Quality gate.** DoD: full suite, type check, lint and build pass, and the B4 reproduction now shows the Expected behavior.

If the user must act (provide credentials, seed a database), add a separate task where it is needed, with an Objective that starts with `User action:`. If a test is technically impossible, Task 1 names the exact command that demonstrates the failure and explains why no test can; that exception is the only one.

```markdown
---
created: 2026-10-08
status: PENDING
approved: false
worktree: false
type: Bugfix
iterations: 0
---
# Fix: invoice totals drop the last line item

## Behavior Contract
- **Given:** an invoice with three line items (10.00, 10.00, 15.00)
- **When:** `GET /invoices/42/total` is called
- **Actual:** the total is 20.00
- **Expected:** the total is 35.00
- **Unchanged:** empty invoices still total 0.00 (`tests/invoice.test.ts`, "empty invoice"); discounts still apply after summing (new test in Task 1)

## Root Cause
`src/billing/total.ts:27` — `sumItems` stops one index early, so the last item is never added. Introduced in a1b2c3d. Confidence: high.
Reproduction: `bun test tests/invoice.test.ts -t "three items"` → `expected 35, received 20`.

## Context
- `sumItems` lives at `src/billing/total.ts:20-35`; its only caller is `src/routes/invoices.ts:58`.
- Commands: tests `bun test` · types `bunx tsc --noEmit` · run `bun run dev` (port 3000).

## Tasks

### Task 1: Reproduce the dropped item in a failing test

**Objective:** A test through `GET /invoices/:id/total` shows the third item missing from the total.

**Files:**
- Test: `tests/invoice.test.ts`

**Definition of Done:**
- The new test fails on the current code with `expected 35, received 20`.
- Verify: `bun test tests/invoice.test.ts -t "three items"`

- [ ] Task 1 done

### Task 2: Sum every line item in sumItems

**Objective:** The loop in `sumItems` visits every item.

**Files:**
- Modify: `src/billing/total.ts`

**Definition of Done:**
- The Task 1 test and the tests named under Unchanged pass.
- No `BURACLE-DEBUG` line remains in the repository.
- Verify: `bun test tests/invoice.test.ts`

- [ ] Task 2 done

### Task 3: Quality gate

**Objective:** The whole project is green and the original request now returns the right total.

**Files:**
- Test: `tests/invoice.test.ts`

**Definition of Done:**
- Full suite, type check, lint and build pass.
- `curl -s localhost:3000/invoices/42/total` returns `35.00`.
- Verify: `bun test`

- [ ] Task 3 done
```

## B7. Validate, review, approve

Follow [plan.md](plan.md) P7 to P9 unchanged: `buracle plan validate <path> --strict` until exit 0, {{agent:plan-build-review}} launched with {{spawn_agent}} (add `notes: check the root cause at <path:line> against the code, and that Task 1 reproduces the Actual symptom`; `reviews.plan: false` replaces it with your own check, as in P8), then the approval gate and the on-approval steps, the model-switch pause included. Continue with [implement.md](implement.md); its bugfix rules apply.

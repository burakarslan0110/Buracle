# Investigate

Exit gate: (1) a reproduction that fails reliably, and (2) a root-cause statement at `file:line` with high or medium confidence. No production code changes yet; temporary instrumentation is allowed and must be marked.

## Reproduce first

1. Run exactly what was reported:
   - a failing test: the project's runner on that file or test name;
   - a CLI: the exact command and arguments;
   - an HTTP endpoint: `curl -i` with the same method, headers and body;
   - a web UI: chrome-devtools, performing the steps while reading the console and network requests;
   - a CI failure: the failing job's log first (`gh run view <run-id> --log-failed` when gh is set up), then the same command locally. A local pass against a CI failure is itself a finding (environment or mocking drift), and the local output is your baseline either way.
2. Read the complete output. The first error is usually the cause; later ones are often fallout.
3. Save the command line; Prove re-runs it. For long output, capture it with `set -o pipefail` and `<command> 2>&1 | tee "${TMPDIR:-/tmp}/fix-<slug>.log"`, then read the file in ranges. Sweep the capture once for what sits above the failure: `rg -n -i "warn|error|exception|traceback|ignored|swallowed" "${TMPDIR:-/tmp}/fix-<slug>.log"`. One warning line often names the cause.
4. Minimize: the smallest input and the fastest command that still fail, ideally under 30 seconds.
5. Flaky or timing-dependent: make it deterministic before going further (fixed seed, fake clock, forced ordering, a barrier inside a test). When it stays rare, raise its rate until it is debuggable: loop the trigger 50 to 100 times, or run copies in parallel. A 1% failure is not a reproduction.

### Cannot reproduce

- Compare environments: runtime and dependency versions (lockfile), configuration and environment variables, data, operating system.
- Ask the user once with `AskUserQuestion` for the missing pieces, offering the specific items you need as options: exact steps, input data, versions, logs or a screenshot.

### Environment blocker

The reproduction cannot run because the environment blocks it: an expired cloud login, dependencies behind a private registry, a credential or service only the user has.

1. Try at most one quick workaround (an already provisioned virtual environment, a cached install). One, not a research project.
2. Then stop and ask with `AskUserQuestion`, also while `plan.questions` is off (a blocker is always asked). Name the exact blocker and the exact command that clears it, and offer two options: "Unblocked: re-run the reproduction" (recommended) and "Continue without running it (static investigation, lower confidence)".
3. For an interactive login, tell the user they can run it in this session as `! <command>`, or in another terminal and reply when it is done.
4. Once unblocked, re-run the reproduction and continue from the top of this section.

Only the user may choose the static path. Reading code while you wait is fine; concluding from it without ever running is not. When the user chose the static path, the report carries `Repro: never executed (the user chose a static investigation)`.

## Trace to the source

Work backwards from the symptom to the place where the bad value or state is first created.

1. `rg -n "<exact error text>"` finds where the error is raised; open that frame.
2. codegraph from the failing frame: its callers (who passed the bad input?) and callees (what returned the bad value?). Step back one layer at a time.
3. semble `search` for other code that produces or transforms the same data.
4. History: `git log -S'<symbol or literal>' --oneline`, `git log -L :<function>:<file>`, `git blame -L <from>,<to> <file>`. A recent change near the symptom is a strong lead. With a known good and a known bad commit, bisect in a throwaway worktree, never in the user's checkout:
   - `git worktree add --detach "${TMPDIR:-/tmp}/bisect-<slug>" <bad-commit>`
   - inside it: `git bisect start <bad-commit> <good-commit>`, then `git bisect run <reproduction command>`
   - afterwards: `git bisect reset` there, then `git worktree remove --force "${TMPDIR:-/tmp}/bisect-<slug>"`.
5. Libraries: context7 for the documented behavior of the installed version; web-search the exact error message for known issues and the versions that fixed them.
6. When reading is not enough (async code, timing, UI state), add temporary logging that contains the marker `BURACLE-DEBUG`: the inputs entering the suspect function, the branch taken, intermediate values, the values returned at layer boundaries. Every such line goes before Finish.
7. Unknown caller: when shared code is reached from many places and you do not know which one passes the bad input, log the call stack under the marker, for example `console.error("BURACLE-DEBUG", { args, stack: new Error().stack })` (Python: `traceback.print_stack()`), run the reproduction, and trace upward from the caller it names.

### Performance regressions

Value logging is the wrong tool here. Measure first: a timing harness, a profiler, or the query plan (`EXPLAIN`), giving the current time against the expected one on the same workload. Then bisect on that measurement (step 4), and fix second.

## Hypotheses

- Write one to three hypotheses, the most likely first, each with the observation that would disprove it.
- Run the cheapest disproving check first and change one thing at a time.
- Two hypotheses disproved: step back one layer in the call chain and look again, rather than guessing a third patch.

## Root-cause statement

```text
<path>:<line> — <function or construct> does <X>; it should do <Y>, because <Z>.
Evidence: <reproduction output, trace, commit>. Confidence: high | medium.
```

- **High:** you can point at the line, and changing it changes the reproduction.
- **Medium:** the trace is consistent but not yet tested by a change.
- **Low:** keep investigating; do not fix yet.

Also write the behavior as a contract for the report and the test: **Given** the setup, **When** the action, **Actual** the wrong result, **Expected** the right result.

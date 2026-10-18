---
name: ab-test
description: "Measure whether a change to a skill, rule, AGENTS.md section or routing policy really changes agent behavior. Defines falsifiable cases, runs paired baseline and candidate trials in throwaway config directories (never hiding or renaming the user's real skills or settings), captures tool-use evidence such as whether the agent loaded the skill or called context7, then scores pass rates and reports per-case deltas. Use when the user asks to benchmark, evaluate, A/B test or compare a skill or rule change, or to check that agents really use an MCP server or skill. The user starts it with /ab-test (Codex: $ab-test). When to use: After editing a skill's description or body, a rule or the routing policy, before keeping the change; when a skill seems never to trigger (\"benchmark this\", \"compare before and after\", \"does the skill trigger\", \"is context7 really called\")."
metadata:
  short-description: "Paired before/after evals of skills and rules with tool-use evidence"
---

# A/B test

Answer one question with evidence: does the candidate change agent behavior compared with the
baseline, on cases that could have failed?

## Contract

- **Isolation.** Never rename, move, hide or edit anything in the user's real setup: `~/.claude`,
  `~/.codex`, `~/.config/opencode`, `~/.omp`, `~/.agents`, `~/.buracle` (which holds the memory),
  or the repository under test. Every arm runs with its own throwaway config directories, and every run
  gets a fresh working directory under a temp root.
- **Only the target differs.** Same harness version, model, effort, prompts, fixtures and run
  count in both arms.
- **Evidence, not claims.** A case passes on observable output: tool calls in the transcript,
  files produced, exit codes. What the agent says about itself does not count.
- **Cost is real.** Every trial is a full agent run on the user's plan. Budget it and get
  approval before large batches.
- **Honest reporting.** Small samples are noisy; say so. Never round "unclear" up to "improved".

`<skill-dir>` below means this skill's folder:
**Codex, OpenCode and Oh My Pi:** `~/.agents/skills/ab-test`
If that path does not exist, use the folder that holds this SKILL.md.

## Progress

Buracle shows the run live, in the workflow band above the prompt and in the status line. Keep it
current with `buracle flow`; the calls are cheap and best effort, so a failing one never stops the run.

- Start: `buracle flow start ab-test --title "<target>"` (harmless when a hook already started it).
- Each phase: `buracle flow phase <id>` as phases 1-8 begin: `frame`, `cases`, `budget`, `arms`,
  `smoke`, `run`, `score`, `report`.
- During the run: `buracle flow step "trials" --done <finished> --total <planned>` each time you poll
  the results file.
- End: `buracle flow end --outcome done` after the report; `--outcome failed` when the batch cannot
  finish (for example, the usage window ran out).

## Phases

Track the phases with your plan/todo tool where available (`update_plan` in Codex, the todo tool in Oh My Pi; OpenCode v2 has none).

### 1. Frame

`buracle flow start ab-test --title "<target>"`, then `buracle flow phase frame`. State the target
(`skill:<id>`, `rule:<path>`, `routing`, or an `AGENTS.md` section), the baseline (a git ref, or
"without the target"), the candidate (working tree or ref), the harness(es), and a hypothesis with a
threshold, for example: "With the new description, history questions in the user's language trigger
`memory_search` in at least 2 of 3 runs; the baseline in at most 1." Ask with your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi) only for
what you cannot infer.

### 2. Cases

`buracle flow phase cases`. Reuse the target skill's `evals/cases.json` when it exists. Otherwise write
3–8 cases following [references/cases.md](references/cases.md):

- prompts that should trigger the target, at least one in the user's language;
- near misses that look similar but must not trigger it;
- behavior cases: the expected MCP server, CLI command or file;
- an outcome that needs judgment ("the report separates verified from unverified commands") goes
  into the case's `rubric`, a list of plain-language expectations that a model grader scores
  (phase 7).

Each case must be able to fail on the baseline. Settle the set during the smoke run (phase 5):
replace a case both arms pass, fix one that cannot run. **After the first comparison run the cases
are frozen.** A case both arms pass stays as a control. A later change needs a reason that does not
depend on which arm should win, goes into a fresh `--out`, and the old results are kept. The runner
records the sha256 of the cases, the profile and every fixture, and `summarize` refuses arms that
ran different ones.

### 3. Budget

`buracle flow phase budget`. Trials = cases × runs × arms (defaults: 3 runs, 2 arms). Run
`buracle usage --json`. Ask before running when trials exceed 30, the 5-hour window is at 75% or
more, or the 7-day window is at 85% or more. Show the trial count and the per-run timeout in the
question.

### 4. Build the arms

`buracle flow phase arms`, then follow [references/isolation.md](references/isolation.md) for the
harness:

- Make a temp root: `mktemp -d "${TMPDIR:-/tmp}/buracle-bench-<slug>-XXXXXX"`.
- Put each variant there without touching the working tree. Baseline from git:
  `git archive <ref> <paths> | tar -x -C <root>/baseline`. For a canonical Buracle skill or rule,
  `<paths>` is `harness/`, the committed rendered output.
- Candidate: copy the working-tree files. A canonical Buracle skill or rule must be rendered
  first, in a copy so neither the repo nor `~/.buracle` changes:
  `rsync -a --exclude .git <repo>/ <root>/candidate/repo/`, then
  `BURACLE_HOME=<root>/candidate/buracle bun <root>/candidate/repo/src/cli/main.ts build`; use
  `<root>/candidate/repo/harness/`.
- Give each arm its own config environment (`CLAUDE_CONFIG_DIR`, or `HOME` plus `CODEX_HOME`,
  `XDG_CONFIG_HOME`/`XDG_DATA_HOME` or `PI_CODING_AGENT_DIR`) and a `BURACLE_HOME` inside the
  arm: it holds the arm's brain, so trial sessions never reach the real memory. Point
  `BURACLE_CORTEXDB_BIN` at the installed CortexDB binary when cases need memory
  ([references/isolation.md](references/isolation.md)).
- Credentials reach arms only through environment variables, for example
  `--env CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s buracle-bench-claude -w)"`.
  Never write them into the temp root, the repo or memory. Copy a harness login file only with
  the user's explicit consent, into the arm, and delete it with the temp root.

### 5. Smoke run

`buracle flow phase smoke`. One case, one run, per arm: add `--case <id> --runs 1`. Open the raw
`stdout.txt` and check that the run authenticated, the right variant loaded (skill listed, plugin
loaded, rule present), and every probe matches the real event format. Profiles other than Claude
Code's are unverified starting points; fix their patterns now, not after 30 runs.

### 6. Run

`buracle flow phase run`, then:

```bash
bun <skill-dir>/scripts/run.ts run --cases <cases.json> \
  --profile <skill-dir>/scripts/profiles/claude.json \
  --arm baseline --runs 3 --out <root>/results \
  --env CLAUDE_CONFIG_DIR=<root>/baseline/claude --env BURACLE_HOME=<root>/baseline/buracle \
  --env CLAUDE_CODE_OAUTH_TOKEN="$(…)"
```

Then the same command with `--arm candidate` and the candidate's environment. The runner strips
your own session's ids from the child environment, gives every run a fresh working directory, and
appends one JSON line per run to `<root>/results/results.jsonl`. Flags, variables and the record
format: [references/runner.md](references/runner.md). Start batches longer than a few minutes in
the background and poll the results file; do not sleep in a loop. After each poll, report the count:
`buracle flow step "trials" --done <finished> --total <planned>`.

### 7. Score

`buracle flow phase score`.

- Cases with a `rubric` first get a blind model grade:
  `bun <skill-dir>/scripts/run.ts grade <root>/results --profile <skill-dir>/scripts/profiles/<harness>.json`
  plus the grader's own throwaway config and credentials (`--env`, as for an arm, so its session
  never reaches the real hooks or memory) and its pinned model (`--append-arg`). Each run is graded
  once, under an opaque id, from a copy of its transcript and files with the arm names removed; the
  grader quotes evidence and fails what it cannot prove. A grader that returns no valid answer is a
  grader error, counted apart; fix the grader profile and run `grade --regrade`.
- Then run
  `bun <skill-dir>/scripts/run.ts summarize <root>/results --baseline baseline --candidate candidate`.
  It prints pass rates, per-case deltas with a class (improved, regressed, both-pass, both-fail,
  unclear), probe counts, metrics with their spread (min, max, standard deviation), the cases whose
  runs disagreed, and caveats. It exits 2 when the arms ran different cases, run counts, profiles
  or fixtures, or when a graded case has ungraded runs in either arm (grade both arms, not one);
  `--allow-mixed` turns that into a caveat for a report that must say so.
- Read the transcripts (`stdoutPath`) of every case that changed class, of every non-unanimous
  case and of every failure you cannot explain. Every claim in the report needs a transcript line,
  a file or an exit code behind it; a model grade is a judgment and is reported as one.

### 8. Report and clean up

`buracle flow phase report`. Write the result up with [references/verdict.md](references/verdict.md):
verdict, per-case table, tool-use evidence, cost and time, caveats, a recommendation (keep, revise or
revert) and at most three next edits. If the result is a durable finding, save it with `memory_write`
as type `knowledge` (layer `project`, sources: the cases file and the numbers). Delete the temp root
unless the user wants the transcripts; never copy transcripts into the repo or memory. Close with
`buracle flow end --outcome done`.

## Claude Code: `claude plugin eval`

For plugin-level questions in Claude Code ("does the Buracle plugin make Claude call context7 for
library questions?"), the built-in evaluator can replace phases 4–7 (mark the evaluation itself with
`buracle flow phase run`):

- `claude plugin eval <plugin dir> --runs 3 --json <file> --no-publish [--max-cost-usd <n>]` runs
  the plugin's eval suite and adds a no-plugin baseline arm automatically, with `tool_used` graders
  for skill and MCP checks.
- Cases live in the plugin's eval directory (`evals/**/case.yaml`, or `prompt.md` plus
  `graders/*.md`). `claude plugin eval init --bare <name>` writes a blank case.
- `harness/claude` is generated: evaluate a copy (the baseline and candidate renders from
  phase 4) and write cases into the copy, never into the generated tree.
- Plugin MCP servers do not start without recorded mocks; routing cases need
  `--allow-real-servers` (the servers then run as the user).
- Always pass `--no-publish`; otherwise the report may be uploaded to claude.ai. Ask before passing
  `--trust-plugin`.
- For before and after, evaluate a baseline copy and a candidate copy and compare their scores.
  For other harnesses, or for skill- and rule-level comparisons, use the runner.

## Failure handling

| Symptom | Likely cause | Do |
|---|---|---|
| Every run fails at start | No credentials in the throwaway config | Fix the credential environment (isolation.md), smoke again. |
| A probe never matches | Pattern does not fit this harness's events | Inspect the smoke stdout; fix the profile. |
| Both arms pass every case | Cases do not discriminate | Before the first comparison run: harder prompts or closer near misses. After it: keep them as controls and put new cases into a fresh `--out`. |
| `summarize` exits 2 | The arms ran different cases, run counts, profiles or fixtures, or only some runs of a graded case were graded | Rerun both arms from the frozen set into a fresh `--out`, or run `grade` without `--arm` and `--case`; `--allow-mixed` only to report the mix. |
| Grader errors | The grader output holds no valid JSON, or it timed out | Read `grading/<id>/grader-stdout.txt`, fix the grader profile, then `grade --regrade`. |
| Both arms fail a case | Target not loaded, or the case is impossible | Check the transcript for the skill list or the plugin load. |
| Rate limit mid-batch | Usage window exhausted | Stop, summarize the partial results, mark the report incomplete. |
| The agent under test cannot write in its work dir | Admin-managed policy still applies | Ask the user for an allowed location, or use read-only cases. |
| A run outlives its timeout | A child kept the output pipe open | The runner gives up after a grace period and marks `streamsLeftOpen`; report leftover processes, never kill unrelated ones. |

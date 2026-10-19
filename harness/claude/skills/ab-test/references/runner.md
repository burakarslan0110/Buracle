# `scripts/run.ts`: the benchmark runner

A small, generic runner: it spawns a command per case N times, keeps the output, and scores it
with regex probes and, for judged cases, a blind model grade. It knows nothing about any harness;
profiles carry the harness specifics. Bun only, no npm dependencies. `run.ts` is the entry point;
`lib.ts`, `summarize.ts`, `grade.ts` and the grader prompt `grader.md` sit next to it.
`bun <skill-dir>/scripts/run.ts --help` prints the same reference.

## `run`

```bash
bun <skill-dir>/scripts/run.ts run --cases <cases.json> --profile <profile.json> \
  --arm <name> --out <dir> [--runs 3] [options]
```

| Option | Meaning |
|---|---|
| `--cases <file>` | Cases file (required) |
| `--profile <file>` | Harness profile; optional when every case has its own `argv` |
| `--arm <name>` | Arm label such as `baseline` or `candidate` (required) |
| `--out <dir>` | Output directory shared by all arms of one benchmark (required) |
| `--runs <n>` | Runs per case, default 3 |
| `--timeout-ms <ms>` | Overrides every case's timeout (otherwise case, then profile, then 600000) |
| `--concurrency <n>` | Parallel runs, default 1, max 8. Runs share the user's rate limits; keep it low. |
| `--case <glob>` | Only matching case ids (repeatable) |
| `--tag <tag>` | Only cases with the tag (repeatable) |
| `--set key=value` | Template variable (repeatable). Never put secrets here; values are logged in `meta.jsonl`. |
| `--env KEY=VALUE` | Child environment override, applied last (repeatable). Values are never logged. |
| `--append-arg <value>` | Appended to every argv; the next token is taken verbatim (`--append-arg --model --append-arg sonnet`) |
| `--keep-session-env` | Keep the caller's session variables (normally stripped) |
| `--dry-run` | Print the expanded command of run 1 for each case and exit; nothing runs |

**Template variables** in argv, cwd, env values, stdin and prompts: `{prompt}`, `{case}`, `{run}`,
`{arm}`, `{out}`, `{work}`, `{cases_dir}`, plus every `--set` key. Unknown variables stay as they
are and produce a warning (except inside prompts).

**Order.** Runs are scheduled run-major (run 1 of every case, then run 2 …) so drift such as a
nearing rate limit spreads evenly across cases.

**Working directory.** Every run gets `<out>/<arm>/<case>/run-<n>/work`, a copy of the case's
fixture or an empty folder, optionally a fresh git repo. The command runs there unless the case or
profile sets `cwd`. The runner refuses to start when any of these folders already exists, so
results never mix; use a new `--out` or another arm name.

**Environment.** The child inherits the runner's environment minus the caller's session
variables (`BURACLE_SESSION_ID`, `BURACLE_HARNESS`, `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`,
every `CLAUDE_CODE_*`, `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `OPENCODE_SESSION_ID`, `OMP_SESSION_ID`). Then the
profile's `env`, the case's `env` and `--env` apply, in that order.

**Timeouts.** At the timeout the runner sends SIGTERM, then SIGKILL 5 s later. If a grandchild
keeps the output pipe open after the command exits, the runner stops reading after 5 s and sets
`streamsLeftOpen`.

**Exit codes:** 0 all runs executed (pass or fail is data, not an error) · 1 bad input or I/O
error · 2 some runs could not start (command not found, bad cwd).

## Output

```text
<out>/results.jsonl                      one record per run, appended by every arm
<out>/meta.jsonl                         one line per invocation: cases, profile, runs, flags
<out>/grades.jsonl                       one line per graded run (grade); the newest grade wins
<out>/grading/<id>/                      what one grader run read (blinded transcript, work/) and printed
<out>/<arm>/<case>/run-<n>/grading.json  the grade of that run: each expectation, its evidence, eval feedback
<out>/<arm>/<case>/run-<n>/stdout.txt    full stdout (stderr.txt next to it)
<out>/<arm>/<case>/run-<n>/work/         the run's working directory, as the agent left it
```

A `results.jsonl` record:

| Field | Meaning |
|---|---|
| `v`, `ts`, `arm`, `case`, `run`, `tags` | Identity |
| `argv`, `cwd` | The command as run; token-like values and `--api-key`/`--token` values are redacted |
| `exit`, `signal`, `timedOut`, `startError`, `streamsLeftOpen`, `durationMs` | How it ended |
| `stdoutBytes`, `stderrBytes`, `stdoutPath`, `stderrPath`, `tail` | Output (tail = last 1,500 characters, redacted) |
| `probes` | Match count per probe (profile probes plus every probe the case expects) |
| `metrics` | Number per metric, or `null` |
| `files` | `{path, ok, detail}` per file check |
| `checks` | One boolean per expectation (`exit`, `timeout`, `start`, `file:<path>`, probe names) |
| `pass` | Every check is true |

Every `run` appends a `meta.jsonl` line with `kind: "run"`, the arm, the cases file and its
`casesSha256`, the profile and its `profileSha256`, `fixtures` (each fixture folder with the
sha256 of its files), `runs`, `caseIds`, `appendArgs` and the names (never the values) of the
`--env` keys. A prompt that names a fixed temp path (`/tmp/…`, `/var/folders/…`) instead of `{work}`
gets a warning, because parallel runs would share it.

## `grade`

```bash
bun <skill-dir>/scripts/run.ts grade <out> --profile <profile with a grader block> \
  [--arm <name>] [--case <glob>] [--env KEY=VALUE] [--append-arg <value>] [--regrade] [--dry-run]
```

For every run whose case has a `rubric` and no grade yet, in random order: copy the transcript
into `<out>/grading/<id>/transcript.txt` and the run's work folder into `work/`, both with the arm
name and the run's paths replaced (`<arm>`, `<run>`), and run the grader there with the prompt from
`scripts/grader.md` (inputs are data; quote evidence; fail when unsure; no partial credit; flag weak
expectations). The answer is the last JSON object with an `expectations` array of the rubric's
length, found in stdout, in a string field of the harness's JSON events, or in the profile's
`output` file. Each expectation becomes a check `judge:<n>` in `grades.jsonl`, which `summarize`
merges into the run's checks and `pass`. No valid answer, a timeout or a start failure is a
`graderError`: that run leaves the pass rates and is counted under *Grader errors*. The cases file
must be the one the runs used (its sha256 is checked). A `kind: "grade"` line in `meta.jsonl`
records the grader profile, its model and effort and the arguments. Exit 0 all graded, 1 bad
input, 2 some grader errors.

Blinding is partial: the grader never sees the arm name or the run's paths, but a transcript can
still name the skill or rule under test. Report model-graded cases as judgments.

## `summarize`

```bash
bun <skill-dir>/scripts/run.ts summarize <out> [--baseline <arm> --candidate <arm>] [--allow-mixed] [--json]
```

With exactly two arms in the file, the first one seen is the baseline. The Markdown output has
tables for arms (pass rate, time median and its min, max and standard deviation, grader errors),
cases, probes and metrics (mean, then min, max and standard deviation), the cases whose runs of
one arm disagreed (non-unanimous), caveats and a verdict; `--json` returns the same data.

Before comparing, it reads `meta.jsonl`. It exits 2 when the two arms ran different versions of
the cases file, the profile or a fixture, different run counts or different case sets, or one arm
mixed several versions of the cases file. It also exits 2 when a case has a grade in
`grades.jsonl` but some runs of it in either arm have none (for example after
`grade --arm baseline`), because that arm's pass rate would mix model grades with scripted checks.
`--allow-mixed` compares anyway and lists each difference as a caveat. Different `--append-arg` values only add a caveat, because they are often
the declared variant (a plugin folder); make sure the model and effort are the same.

Per case, Δ = candidate pass rate − baseline pass rate, classified as:

| Class | Rule |
|---|---|
| `improved` | Δ ≥ +0.5 |
| `regressed` | Δ ≤ −0.5 |
| `both-pass` | Both rates ≥ 0.66 (the case does not discriminate) |
| `both-fail` | Both rates ≤ 0.34 (target not loaded, or the case is impossible) |
| `unclear` | Anything else: add runs before concluding |

Verdict on the mean Δ over paired cases: ≥ +0.40 clear gain · ≥ +0.15 likely gain · between
−0.15 and +0.15 no measurable effect · otherwise regression. Any regressed case is flagged
separately. With 3 runs, one run moves a pass rate by 0.33; the summary prints the step size so
the report can call differences below it noise.

## Example

```bash
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/buracle-bench-memory-XXXXXX")
RUN=<skill-dir>/scripts/run.ts
CASES=<buracle repo>/canonical/skills/memory/evals/cases.json
PROFILE=<skill-dir>/scripts/profiles/claude.json
TOKEN="$(security find-generic-password -s buracle-bench-claude -w)"
CORTEXDB="$(ls "$HOME"/.buracle/toolchain/cortexdb/*/cortexdb-mcp | tail -n 1)"
for ARM in baseline candidate; do
  bun "$RUN" run --cases "$CASES" --profile "$PROFILE" --arm "$ARM" --runs 3 --out "$ROOT/results" \
    --env CLAUDE_CONFIG_DIR="$ROOT/$ARM/claude" --env BURACLE_HOME="$ROOT/$ARM/buracle" \
    --env BURACLE_CORTEXDB_BIN="$CORTEXDB" --env CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" \
    --append-arg --plugin-dir --append-arg "$ROOT/$ARM/plugin" \
    --append-arg --model --append-arg sonnet
done
bun "$RUN" summarize "$ROOT/results" --baseline baseline --candidate candidate
```

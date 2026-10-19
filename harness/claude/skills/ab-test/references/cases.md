# Cases and profiles

A **cases file** says what to ask and what must be observable. It is harness-neutral, so one file
serves every harness. A **profile** says how one harness is run and how its output reveals tool
use. The runner joins them.

## Cases file

```json
{
  "target": "skill:memory",
  "notes": "Seed the arm's brain (BURACLE_HOME=<arm>/buracle) with one decision memory so retrieval cases have something to find.",
  "cases": [
    {
      "id": "past-decision",
      "prompt": "What did we decide last time about the caching layer?",
      "tags": ["trigger"],
      "expect": { "skill:memory": true, "mcp:buracle-memory": ">=1" },
      "allowTimeout": true,
      "timeoutMs": 120000
    },
    {
      "id": "writes-agents-md",
      "prompt": "Set up agent guidance for this repository and verify the commands.",
      "fixture": "fixtures/tiny-bun-repo",
      "git": true,
      "expect": { "skill:project-rules": true },
      "files": [ { "path": "AGENTS.md", "exists": true, "matches": "bun test" } ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `target` | What the file evaluates (informational) |
| `notes` | Anything an arm needs prepared |
| `id` | Unique; letters, digits, `.`, `_`, `-` |
| `prompt` | The user message. Template variables such as `{arm}` are expanded. |
| `tags` | Free labels; `--tag` filters on them |
| `expect` | Probe name → condition, plus optional `exit` |
| `files` | Checked after the run, relative to the run's working directory: `exists` (default `true`) and optional `matches` (a regex over the file's text) |
| `fixture` | Folder, relative to the cases file, copied fresh into every run's working directory |
| `git` | `true` makes the working directory a git repo with one commit |
| `allowTimeout` | A timeout alone does not fail the case, and the exit check is skipped for timed-out runs |
| `rubric` | Plain-language expectations a model grader scores after the run (`run.ts grade`); each becomes a check `judge:<n>` |
| `argv`, `cwd`, `env`, `stdin`, `timeoutMs`, `probes` | Per-case overrides of the profile |

### Conditions

| Value | Passes when the probe count is |
|---|---|
| `true` | at least 1 |
| `false` | 0 |
| a number `n` | exactly `n` |
| `">=n"`, `"<=n"`, `">n"`, `"<n"`, `"==n"`, `"!=n"` | as written |

`exit` takes an exit code, `"nonzero"` or `"any"`. Without an `exit` expectation a run must exit 0.
A timeout fails the case unless `allowTimeout` is set. A command that cannot start always fails.

## Probe vocabulary

| Probe | Counts |
|---|---|
| `skill:<id>` | Loads of the skill (Claude: the Skill tool; Codex: reads of `skills/<id>/SKILL.md`) |
| `mcp:<server>` | Calls to any tool of the MCP server, by id from `canonical/mcp.yaml` |
| `tool:<name>` | Calls of a built-in tool by its harness name (Claude: `WebSearch`, `WebFetch`, `Bash`) |
| `cmd:<text>` | Shell commands containing the text, e.g. `cmd:buracle plan status` (no quotes in the text) |
| `any_tool` | All tool calls |

A profile defines each probe as a regex. An entry ending in `:*` is a family: the part of the
probe name after the colon replaces `{arg}` in the pattern (regex-escaped). A case may define its
own probes with the same syntax.

## Profiles (`scripts/profiles/<harness>.json`)

```json
{
  "harness": "claude",
  "argv": ["claude", "-p", "{prompt}", "--output-format", "stream-json", "--verbose"],
  "cwd": "{work}",
  "env": {},
  "timeoutMs": 300000,
  "probes": { "mcp:*": "\"name\":\"mcp__(?:plugin_[A-Za-z0-9_-]+_)?{arg}__" },
  "metrics": { "cost_usd": "\"total_cost_usd\":([0-9.eE+-]+)" }
}
```

- A probe is a regex string, or `{ "pattern": "…", "stream": "stdout" | "stderr" | "both",
  "flags": "i" }`. Matching is global; the count is the number of matches.
- A metric's first capture group in its last match is recorded as a number.
- Unknown keys (`status`, `usage`) are documentation for you; the runner ignores them.
- `grader` (optional) is the read-only judge for `run.ts grade`: `argv` with `{prompt}` (the grader
  prompt from `scripts/grader.md`) and `{grade_dir}` (its working directory, holding
  `transcript.txt` and `work/`), optional `env`, `timeoutMs`, `output` (a file the answer is read
  from instead of stdout, such as Codex's `-o` file), and `model` and `effort` (recorded with every
  grade). The runner sets `BURACLE_HOME` to a folder under `grading/` and `BURACLE_NO_CAPTURE=1`
  unless `env` or `--env` sets them.

Shipped profiles: `claude.json` follows Claude Code's stream-json events. `codex.json`,
`opencode.json` and `omp.json` are **unverified starting points**; confirm or rewrite their
patterns on the smoke run, and keep the fixed version with the benchmark's notes.

## Writing cases that measure something

- **One behavior per case.** A case that checks three things fails for unclear reasons.
- **Falsifiable.** The baseline must be able to fail. The smoke run tells you when it cannot.
- **Near misses.** Same vocabulary, different job: "run the tests" against "benchmark the skill";
  "what does this function do" against "what did we decide about this function".
- **The user's language.** Trigger prompts in English and in the user's own language, typed the way
  the user types.
- **Do not name the skill** in a trigger prompt unless you are testing explicit invocation.
- **Deterministic graders first:** probes, files, exit codes. When a judgment is unavoidable, write
  it as the case's `rubric`: one observable outcome per entry ("the report lists each command with
  its exit code"), never "the answer is good". The grader fails what it cannot prove, so an
  expectation that a lazy run could pass is a weak one; the grader says so in `eval_feedback`.
- **Freeze before comparing.** Change cases only during the smoke run. After the first comparison
  run a both-pass case is a control, and a correction needs a reason independent of the winner and
  a fresh `--out`.
- **Bound the cost.** Trigger cases need only the first few tool calls: set `allowTimeout` and a
  short `timeoutMs` (60–120 s).
- **Seed what a case needs:** files in the fixture; memories in the arm's brain (`buracle mem write`
  under the arm's `BURACLE_HOME`).

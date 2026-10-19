# Trigger and behavior evals (`evals/cases.json`)

Every new or reworked skill should ship an `evals/cases.json`. The cases are harness-neutral: they
say what to ask and what must be observable. {{skill:ab-test}} runs them in throwaway configurations, once without
the change and once with it, and compares pass rates. The full format, including fixtures and
per-harness profiles, is in the ab-test skill's `references/cases.md`.

## Minimal file

```json
{
  "target": "skill:<id>",
  "notes": "What these cases check and anything the arm needs seeded.",
  "cases": [
    {
      "id": "user-language-trigger",
      "prompt": "<a request in the user's language, typed the way they type>",
      "tags": ["trigger", "<language code, e.g. tr>"],
      "expect": { "skill:<id>": true },
      "allowTimeout": true
    },
    {
      "id": "en-trigger",
      "prompt": "<an English request with different wording>",
      "tags": ["trigger"],
      "expect": { "skill:<id>": true },
      "allowTimeout": true
    },
    {
      "id": "near-miss",
      "prompt": "<shares vocabulary with the trigger but needs a different job>",
      "tags": ["negative"],
      "expect": { "skill:<id>": false },
      "allowTimeout": true
    },
    {
      "id": "behavior",
      "prompt": "<a request where the skill must call a specific tool>",
      "tags": ["behavior"],
      "expect": { "skill:<id>": true, "mcp:buracle-memory": ">=1" }
    }
  ]
}
```

## Fields

| Field | Meaning |
|---|---|
| `id` | Unique, letters, digits, `.`, `_`, `-` |
| `prompt` | The user message |
| `tags` | Free labels (`trigger`, `negative`, `behavior`, a language code such as `tr`); the runner can filter on them |
| `expect` | Probe name → condition, plus optional `exit` |
| `files` | Checks on files after the run: `{ "path": "AGENTS.md", "exists": true, "matches": "bun test" }` |
| `fixture` | A folder (relative to the cases file) copied fresh into each run's working directory |
| `git` | `true` turns the working directory into a git repo with one commit |
| `allowTimeout` | A timeout alone does not fail the case; use it for trigger cases with short timeouts |

Probe names: `skill:<id>` (the skill was loaded), `mcp:<server>` (any tool of that MCP server was
called), `cmd:<text>` (a shell command containing the text), `tool:<name>` (a built-in tool by its
harness name), `any_tool`. Conditions: `true` (at least once), `false` (never), a number (exactly),
or `">=n"`, `"<=n"`, `">n"`, `"<n"`, `"==n"`, `"!=n"`. `exit` takes a number, `"nonzero"` or
`"any"`; without it the run must exit 0.

## Writing good cases

- Write prompts the way the user writes: short, often in their own language, sometimes mixed with
  English terms.
- Do not name the skill in a trigger prompt; that tests explicit invocation, not routing.
- Near misses share words with the triggers but need a different job ("run the tests" against
  "benchmark the skill").
- One behavior per case. Prefer probes, files and exit codes over judgment.
- Trigger cases only need the first few tool calls: set `allowTimeout` and keep the timeout short
  to save quota.

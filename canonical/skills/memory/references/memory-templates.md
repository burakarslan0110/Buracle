# Memory shapes

`memory_write` fills in the id (`<kind>-<slug of the title>`), the timestamps, the provenance
(harness, model, session, branch, commit), the version, the review state and the history. You
supply the fields below and a body in the shape for the memory's kind. Follow the tool's schema
when its field names differ from this page.

## Titles and summaries

The title is a claim someone could check, in one sentence. The summary adds the most useful detail
in one line under 140 characters; search results and the session-start text show only these two.

| Weak | Strong |
|---|---|
| "Cache" | "Use an in-process LRU for the price cache; Redis only for sessions" |
| "Bug in hooks" | "Codex SessionEnd hooks are killed after 3 seconds" |
| "Testing notes" | "Integration tests need `docker compose up -d db` before `bun test`" |
| "User preference" | "The user wants commit messages in English and replies in their own language" |

## Fields

| Field | Rule |
|---|---|
| `type` | `decision`, `gotcha`, `procedure`, `knowledge`, `reference`, `preference` |
| `layer` | `project` by default; `person` when it holds in every project (a `preference` defaults to `person`) |
| `sources` | `path`, `path:line`, short commit SHA, URL; at least one for `decision`, `gotcha` and `knowledge`. A reader can check the cited files |
| `tags` | a few topic words (`memory`, `search`); they group memories in the brain view |
| `about` | tools, libraries or concepts it concerns: `bun`, `sqlite` |
| `importance` | 1 to 5 (default 3) when a memory matters more or less than usual for recall |
| `supersedes` | ids of the memories this one replaces (they stop showing up) |
| `pin` | `true` only for what every session must see at start |
| `review` | `ok` when you verified every claim in this session; otherwise leave the default `pending` |
| `origin` | `explicit` only when the user said the claim in this conversation; the default for you is `inferred`. An inferred write never replaces an explicit, pinned or verified memory |
| `confidence` | 0 to 1, how sure you are (explicit memories are 1) |

State your confidence in the body when it is not high: "Confidence: medium (inferred from the
config, not run)".

## `decision`

```markdown
## Context
<The problem and the constraints, 2-4 lines.>

## Decision
<What was chosen, stated so it can be followed.>

## Alternatives
- <Option>: <why not>

## Consequences
<What this makes easy, what it makes hard, what would make us revisit it.>
```

## `gotcha`

```markdown
## Symptom
<What you see: the error text, the wrong output.>

## Root cause
<file:line and the mechanism.>

## Fix
<What resolved it; the commit if there is one.>

## How to spot it next time
<The tell-tale sign, or the check that catches it early.>
```

## `procedure`

```markdown
## When
<The situation that calls for it.>

## Steps
1. `<command>`: <what to check in the output>

## Verify
<The command or observation that proves it worked.>
```

When a procedure becomes long or keeps recurring, suggest turning it into a skill.

## `knowledge`

```markdown
## Claim
<The fact, stated plainly.>

## Evidence
<Where it was observed; how to re-check it.>

## Limits
<Where it does not hold, or when it may change.>
```

## `reference`

```markdown
## What and where
<What it is and where it lives: URL, wiki page, dashboard, ticket.>

## When to use it
<The question it answers.>
```

## `preference`

```markdown
<The preference in one or two imperative lines: "Reply in the user's language; keep code,
commands and commit messages in English.">

Said on <date> in <project or "every project">: "<the user's words, short>"
```

When the user states it again, add the new evidence with `memory_update` `append` instead of
writing a second memory.

## Core pages (`core`, updated in place)

A project that was set up by an older Buracle has `core-brief`, `core-architecture`, `core-conventions`,
`core-commands`, `core-glossary` and `core-progress`. Update one with `memory_update`; `memory_write`
refuses the `core` kind, and Buracle no longer creates these pages, so a project without them keeps the
same facts as ordinary `knowledge` and `decision` memories.

| Page | Holds |
|---|---|
| `core-brief` | What the project is, who it is for, what "done" looks like, in a few lines |
| `core-architecture` | A short map of the main parts and how data flows, citing `path:line` or codegraph symbols |
| `core-conventions` | Rules learned in sessions that AGENTS.md does not state yet, with the evidence |
| `core-commands` | Build, test, lint and run commands, and what to check in their output |
| `core-glossary` | Project terms, one line each |
| `core-progress` | Milestones reached, the current focus, open threads; newest first |

An update of a core page:

```json
{
  "id": "core-progress",
  "expected_version": 4,
  "patch": {
    "summary": "Memory moved to CortexDB; the brain web UI is next",
    "append": "- 2026-10-13: memory on CortexDB (one file per project); next: the brain web UI",
    "sources": ["src/memory/store.ts"]
  },
  "reason": "progress after the memory move"
}
```

On `core-commands` and `core-architecture` the part between `<!-- buracle:detected:start -->`
and `<!-- buracle:detected:end -->` was written by an older Buracle from the repository; nothing
rewrites it now, so keep it when you replace the `body` and write outside it.

## Updating instead of duplicating

- Correction: fix the `title`, `summary` or `body` and say why in `reason` (a history line is
  kept for you). The memory is `pending` again unless the same patch sets `review: ok`.
- A new decision replaces an old one: write the new memory with `supersedes`, or set
  `superseded_by` on the old one.
- Two memories hold the same claim: `merge_into` the better one; tags and sources move over.
- The fact is no longer true and nothing replaces it: `status: deprecated` with a one-line
  `reason`.

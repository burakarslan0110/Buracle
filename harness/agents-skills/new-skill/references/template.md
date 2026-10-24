# Skill template

## Notation used in this file

Installed copies of skills are rendered per harness, and rendering replaces every Buracle
placeholder with that harness's tool name. This file therefore spells placeholders with guillemets:

| In this file | Write in the real SKILL.md |
|---|---|
| `«ask_user»` | the name `ask_user` in double curly braces |
| `«todo»` | the name `todo` in double curly braces |
| `«spawn_agent»` | the name `spawn_agent` in double curly braces |
| `«skill:<id>»` | `skill:` plus the skill id, in double curly braces |
| `«agent:<id>»` | `agent:` plus the agent id, in double curly braces |
| `«harness:claude»` … `«/harness»` | an HTML comment holding `harness:claude` (or `codex`, `opencode`, `omp`), then the harness-only text, then an HTML comment holding `/harness`; one space inside each comment delimiter |

Double curly braces mean two `{` before the name and two `}` after it, with no spaces. For a real,
unrendered example, open a canonical source in the Buracle repo, for instance
`canonical/skills/ab-test/SKILL.md` (placeholders and harness blocks) or
`canonical/skills/dead-code/SKILL.md` (a script path per harness).

## Canonical SKILL.md (Buracle repo or personal skills source)

```markdown
---
name: <id>
description: >-
  <What it does, in one or two sentences.> <When to use it: the situations and the phrases users
  type, in English.> <What it is not for, if a neighboring skill exists.>
when_to_use: >-
  <Optional: a short list of situations.>
invocation: implicit
argument-hint: "<arguments, if any>"
mcp: [<server ids the body uses>]
short-description: <at most 80 characters>
---

# <Title>

<Purpose in one or two sentences: what it changes and what it leaves alone.>

## Done means

- <Observable evidence: a command and its exit code, a file, a tool result.>

## Ground rules

1. <A constraint specific to this procedure, with the reason.>

## Phases

Track the phases with «todo».

### 1. <Phase name>

- <Imperative step that names the exact tool: the `<server>` MCP tool or `buracle <subcommand>`.>
- Gate: <what must be true before the next phase>.

### 2. <Phase name>

- <Step.> Ask with «ask_user» only when <condition>.

## Failure handling

| Situation | Do |
|---|---|
| <Likely failure> | <Recovery, or what to report> |

## Example

<A short, realistic run: the request, the key steps, the result.>
```

Field rules (CONTRACTS §8.1):

- `name` equals the folder name: kebab-case, at most 64 characters.
- `description` plus `when_to_use`: at most 1,024 characters together. Routing depends on them.
- `invocation`: `explicit` makes the skill user-started only (adapters map it to each harness's
  switch); `implicit` lets the agent pick it up.
- `mcp`: ids from `canonical/mcp.yaml` (`context7`, `codegraph`, `semble`, `web-search`,
  `web-fetch`, `grep`, `chrome-devtools`, `buracle-memory`); `[]` when none.
- `short-description`: at most 80 characters (shown in Codex's skill list).

## Calling a bundled script

Scripts live in `scripts/` and are called by absolute path, which differs per harness. Define it
once with harness-only blocks and reuse it:

```markdown
`<skill-dir>` below means this skill's folder:
«harness:claude»
`${CLAUDE_SKILL_DIR}`
«/harness»
«harness:codex»
`~/.agents/skills/<id>`
«/harness»
«harness:opencode»
`~/.agents/skills/<id>`
«/harness»
«harness:omp»
`~/.agents/skills/<id>`
«/harness»
If that path does not exist, use the folder that holds this SKILL.md.

Run `bun <skill-dir>/scripts/<name>.ts --json`.
```

Script conventions: `#!/usr/bin/env bun`, a header comment with usage, `--help`, `--json`, exit
codes 0 ok / 1 error / 2 needs user action, no npm dependencies (Bun built-ins and `node:` modules
are fine), deterministic output (sorted), writes only to paths passed in, never touches the
network unless that is the script's purpose.

## Project skill (`<project>/.agents/skills/<id>/`)

Nothing renders project skills, so they use the portable subset and plain wording:

```markdown
---
name: <id>
description: <what it does and when to use it, at most 1,024 characters>
disable-model-invocation: true
---
```

- Keep `disable-model-invocation: true` only for user-started skills; Claude Code, OpenCode and omp
  honor it. For Codex, add `agents/openai.yaml`:

  ```yaml
  interface:
    display_name: "<Title>"
    short_description: "<at most 80 characters>"
  policy:
    allow_implicit_invocation: false
  ```

- Word tool use generically: "ask the user, with your structured question tool if you have one",
  "track the steps in your todo list", "hand independent work to a subagent if your harness has
  them". No placeholders and no harness-only blocks.
- After adding or renaming one, run `buracle project sync --json` so Claude Code sees it through
  `.claude/skills`.

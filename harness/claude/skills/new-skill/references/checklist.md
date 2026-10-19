# Skill quality checklist

Walk this list after `buracle skills lint --json` exits 0. Lint checks structure; this list checks
whether the skill will actually be picked and followed.

## Structure

- [ ] Folder name equals `name`: kebab-case, at most 64 characters, not used by another source
      (`buracle skills list --json`).
- [ ] Frontmatter parses as YAML (use folded `>-` blocks for long text) and holds only the
      canonical keys: `name`, `description`, `when_to_use`, `invocation`, `argument-hint`, `mcp`,
      `short-description`.
- [ ] `description` plus `when_to_use` at most 1,024 characters; `short-description` at most 80.
- [ ] `mcp` lists exactly the MCP servers the body tells the agent to use, by id.
- [ ] SKILL.md stays focused (aim for about 2,000 words; there is no hard limit, long procedures
      belong in references). References are one level deep, linked by relative path, and every
      link resolves.

## Description (this decides whether the skill is ever used)

- [ ] Says what it does **and** when to use it; the "when" part carries the triggers.
- [ ] Contains the phrases users really type, in English; phrases in the user's language are in
      `canonical/skill-triggers.yaml` (Buracle repo) or in `when_to_use` (elsewhere).
- [ ] Names what it is not for when a neighboring skill is close.
- [ ] Concrete nouns and verbs; no adjectives like "powerful" or "comprehensive".
- [ ] Explicit skills say the user starts them; implicit skills name the situations.

## Body

- [ ] Purpose in at most two sentences.
- [ ] Plain language (ISO 24495-1): the outcome first, one term for one thing, short sentences, outcomes and constraints instead of micro-steps the agent can decide itself.
- [ ] A "Done means" list of observable evidence.
- [ ] Numbered phases, each ending with a gate or an output.
- [ ] Every external step names its tool: the MCP server (and tool) or the exact command.
- [ ] Only documented `buracle` subcommands (`/buracle:buracle` lists them).
- [ ] Failure handling for the failures that will really happen.
- [ ] One short, realistic example.
- [ ] Self-contained: no "as discussed above"; the skill runs in fresh sessions.
- [ ] No restated global rules: they are already loaded everywhere.
- [ ] No secrets, no user-specific absolute paths (use `~` or variables), no dates.

## Portability

- [ ] No harness tool names outside harness-only blocks.
- [ ] Placeholders only in the five allowed forms (`ask_user`, `todo`, `spawn_agent`,
      `skill:<id>`, `agent:<id>`, each in double curly braces).
- [ ] Harness-only blocks only where behavior truly differs; when a step needs a per-harness value
      (such as a script path), every harness gets a block.
- [ ] Project skills contain no placeholders and no harness-only blocks at all.

## Scripts

- [ ] `bun <script> --help` prints usage and exits 0.
- [ ] Exit codes 0 ok, 1 error, 2 needs user action; machine-readable output with `--json`.
- [ ] No npm dependencies; writes only to paths it is given; safe to run twice.

## Evals

- [ ] At least three triggers (one or more in the user's language), two near misses, one behavior case.
- [ ] Each case can fail without the skill; none names the skill in the prompt unless it tests
      explicit invocation.

## Anti-patterns

| Anti-pattern | Why it hurts | Instead |
|---|---|---|
| Description says what, not when | The skill never triggers | Add situations and real phrases |
| "Use the appropriate tool" | The agent improvises with shell | Name the MCP server or command |
| One huge SKILL.md | Harnesses may re-attach only the first few thousand tokens after compaction | Phases in `references/` |
| Restating global rules | Wasted context; drifts from the rules | Rely on the rules |
| Harness tool names in the body | Wrong or missing tools in other harnesses | Placeholders |
| Invented `buracle` subcommands | Fails at run time | A script, or report the gap |
| Two skills with overlapping triggers | Both trigger less reliably | Merge, or sharpen the boundary in both descriptions |
| "Done" without evidence | The agent declares success early | A "Done means" list |
| Steps that ask the user routine questions | Stalls autonomous runs | Decide and record; ask only real decisions |

## Iteration signals

| Symptom | Likely cause | Fix |
|---|---|---|
| The skill never triggers | The description says what, not when; no trigger phrases | Add situations and real phrases (the user's language goes into `canonical/skill-triggers.yaml`), then run the trigger cases |
| It triggers on near misses | The description is broad or overlaps another skill | Name what it is not for; sharpen the boundary in both descriptions |
| The agent skips a step | The step sits deep in a long body or has no gate | Move it into a numbered phase with a check the agent must show |
| The agent improvises a tool | The step does not name the MCP server or command | Name it; add a script for fragile steps |
| It fills the context | The body holds detail every run does not need | Move the detail into `references/` and link it from the phase that needs it |
| It asks the user routine questions | The skill does not say what to decide alone | State the default; ask only for real decisions |

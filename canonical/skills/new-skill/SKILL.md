---
name: new-skill
description: >-
  Capture a repeatable procedure as a Buracle skill, or improve an existing one. Picks the right
  home (global skills in the Buracle repo's canonical/skills or a configured skills git source;
  project-only skills in .agents/skills), writes SKILL.md in the canonical format with
  references/, scripts/ and trigger evals, lints it with `buracle skills lint`, and explains how
  publishing reaches every harness. Use when the user wants to turn a workflow into a skill, edit,
  split or rename a skill, or fix a skill that triggers too often or never.
when_to_use: >-
  A multi-step procedure was done more than once or took real effort and will recur; an existing
  skill misfires, has grown too long or misses a step ("turn this into a skill", "create a new
  skill", "update the skill").
invocation: implicit
argument-hint: "<skill id or the procedure to capture>"
mcp: [buracle-memory, semble]
short-description: Capture a repeatable procedure as a canonical Buracle skill
---

# New skill

A skill is a procedure an agent loads on demand. It earns its place when it makes a recurring task
faster, safer or more consistent than working it out from scratch each time.

## 1. Skill, rule, memory, or nothing?

| What you have | Where it goes |
|---|---|
| A multi-step procedure started by an intent ("cut a release", "rotate the keys") | A skill: continue here |
| A constraint for every task, or for certain files | A rule: global ones in Buracle's `canonical/rules/`; project ones via {{skill:project-rules}} |
| A fact, a decision or a trap | A memory ({{skill:memory}}) |
| A one-off task | Nothing |

If an existing skill already covers most of it, extend that skill. Two skills with overlapping
descriptions both trigger less reliably.

## 2. Pick the home

| Scope | Location | Wording |
|---|---|---|
| Global, part of Buracle | `<buracle repo>/canonical/skills/<id>/`; the repo path is `repo:` in `~/.buracle/config.yaml` | Canonical format with placeholders |
| Global, the user's own skills repo | The `path` (or the checkout of the `git` URL) of an entry under `skills.sources` in `~/.buracle/config.yaml` | Canonical format with placeholders |
| One project only | `<project>/.agents/skills/<id>/` | Plain neutral wording and **no placeholders**: nothing renders project skills, so a placeholder would reach the model verbatim |

`buracle skills list --json` shows the existing ids and the source each one comes from. If the
scope is unclear, ask with {{ask_user}}: every project, or this project only.

## 3. Phases

Track the phases with {{todo}}.

**Progress.** Buracle shows the run live, in the workflow band above the prompt and in the status
line. Start it with `buracle flow start new-skill --title "<skill id>"`, mark each phase below with
the `buracle flow phase <id>` call next to its name (`capture`, `overlap`, `design`, `write`, `evals`,
`lint`, `test`, `publish`), and close with `buracle flow end --outcome done` once it is published or
the user has the publish steps. The calls are cheap and best effort; a failing one never stops the work.

1. **Capture** (`buracle flow phase capture`). If you just did the procedure in this session, take it
   from there: the commands that worked, their order, what failed and how you fixed it, how you proved
   the result. Otherwise ask at most three questions with {{ask_user}}: when should it fire (example
   requests, including some in the user's language), what does "done" look like, and what must never
   happen. Then a quick memory pass: `memory_search` for `procedure` and `gotcha` memories on the topic;
   they become steps and pitfalls.
2. **Check overlap** (`buracle flow phase overlap`). Read the descriptions of the two or three
   closest skills from `buracle skills list --json`. The list also names skills Buracle does not
   manage: `claude-only` (a project skill only in `.claude/skills`, which Codex cannot see) and
   `unmanaged` (a folder placed by hand in `~/.agents/skills` or `~/.claude/skills`), each with the
   harnesses that see it. A `claude-only` skill that already covers the procedure is a migration,
   not a new skill: `buracle project sync --adopt` links it for Codex and changes no tracked file;
   `--adopt --move` moves the folder into `.agents/skills`, so ask with {{ask_user}} first. Ask
   `semble` (`search`) for scripts or helpers the repository already has, so the skill calls them
   instead of re-implementing them.
3. **Design** (`buracle flow phase design`). Settle before writing:
   - id: kebab-case, at most 64 characters, equal to the folder name;
   - invocation: `explicit` for long workflows with side effects that the user starts on purpose,
     `implicit` for utilities the agent should pick up by itself;
   - inputs, numbered phases with gates, the evidence that proves "done", failure handling;
   - the MCP servers it needs, by id from `canonical/mcp.yaml`: `context7`, `codegraph`,
     `semble`, `web-search`, `web-fetch`, `grep`, `chrome-devtools`, `buracle-memory`, `context-mode`;
   - the buracle CLI calls it makes: only documented subcommands ({{skill:buracle}});
   - which steps are deterministic or fragile enough to deserve a script.
4. **Write** (`buracle flow phase write`). For a skill in the Buracle repo, scaffold with
   `buracle skills new <id>` and check the path it prints. Otherwise create the folder by hand. Fill
   it from [references/template.md](references/template.md):
   - **Description** = what it does + when to use it (situations and trigger phrases) + what it is
     not for. Together with `when_to_use`, at most 1,024 characters; `short-description` at most 80.
     Write it in English. Trigger phrases in the user's language: for a skill in the Buracle repo they
     go into that skill's entry in `canonical/skill-triggers.yaml` (the prompt router's vocabulary,
     so skill prose stays English); elsewhere, add them to `when_to_use`.
   - **Body:** purpose, outputs and "done" criteria, ground rules, numbered phases with gates,
     failure handling, one short example. Imperative mood, written by the four principles of the
     *Plain language* rule (ISO 24495-1): the outcome first, one term for one thing, steps the agent
     can act on. State outcomes and constraints, and leave the agent room to choose how. Aim for
     2,000 words or fewer; move long procedures into `references/<topic>.md` and link them by
     relative path.
   - **Neutral tool wording.** Refer to harness tools only through Buracle's placeholders: the
     names `ask_user`, `todo`, `spawn_agent`, `skill:<id>` and `agent:<id>`, each wrapped in double
     curly braces (two `{` before the name, two `}` after it). Never write a harness tool name.
     Each adapter expands the placeholders for its harness. Harness-only blocks (an HTML comment
     opening `harness:` plus the harness name, closed by `/harness`) are for behavior that truly
     differs; the exact syntax is in [references/template.md](references/template.md).
   - **Name the tool** for every external step: the MCP server or the exact command, never "use an
     appropriate tool".
   - **Scripts:** Bun TypeScript without npm dependencies; `--help`; JSON output; exit codes
     0 ok, 1 error, 2 needs user action; they write only to paths they are given.
5. **Evals** (`buracle flow phase evals`). Write `evals/cases.json` as described in
   [references/evals.md](references/evals.md): at least three prompts that should trigger the skill
   (one in the user's language), two near misses that should not, and one behavior case (the
   expected MCP call, CLI call or file). Every case must be able to fail without the skill.
6. **Lint** (`buracle flow phase lint`). Run `buracle skills lint --json` and fix every finding for
   this skill until it exits 0. A project skill is linted by its path,
   `buracle skills lint .agents/skills/<id> --json`, which also enforces the portable profile (no
   placeholders, no harness blocks). Either way, walk [references/checklist.md](references/checklist.md).
7. **Test** (`buracle flow phase test`). Quick check: read the description against each eval prompt.
   Would you pick this skill? Real check: measure triggering and behavior with {{skill:ab-test}}
   (old against new description, or without against with the skill).
8. **Publish** (`buracle flow phase publish`). Ask with {{ask_user}}: commit and sync now, or leave
   it to the user. Then run or
   print the steps for the home:
   - **Buracle repo:** `git add canonical/skills/<id>`, then
     `git commit -m "skill(<id>): <what it does>"`, then `buracle install` (it builds and installs into
     every installed harness). Claude Code picks it up after `/reload-plugins` or a restart; Codex,
     OpenCode and omp see it in new sessions through `~/.agents/skills`.
   - **Personal skills repo:** commit and push there, then `buracle update --check` and
     `buracle update --yes`; the update fast-forwards the checkout, lints, builds and installs the
     skill into every harness.
   - **Project skill:** commit `.agents/skills/<id>/`. Buracle links it into `.claude/skills` for
     Claude Code by itself, after the edit and at the next session start in any harness; run
     `buracle project sync --json` to see the link now, then `buracle project check` (exit 0 means
     every skill is linked and the path-rule index is in step).

   Never push without the user's go-ahead.

## Editing an existing skill

- Keep its `invocation` value, and the scripts, references and evals it already has, unless the
  user asks for a change; say so in the report when one changes. Turning `explicit` into
  `implicit` lets the model pick up a workflow with side effects by itself, because the prompt
  router then lists it for a YES/NO evaluation.
- Scale the test to the change: a wording-only edit needs lint; a description, `when_to_use` or
  trigger change (also its entry in `canonical/skill-triggers.yaml`) needs the trigger cases with
  {{skill:ab-test}}; a change of phases or outputs needs its behavior cases.
- A skill that misfires: find the symptom in the iteration signals of
  [references/checklist.md](references/checklist.md) before you rewrite it.

## Done means

- `buracle skills lint --json` exits 0.
- The frontmatter parses, `name` equals the folder, relative links resolve, every script answers
  `--help`.
- `evals/cases.json` holds trigger, near-miss and behavior cases.
- The skill is published, or the user has the exact publish steps.

## Failure handling

| Situation | Do |
|---|---|
| `buracle skills new` scaffolds outside the chosen home | Leave the scaffold alone, tell the user, create the folder by hand from the template. |
| Lint reports a rule you cannot satisfy | Quote the finding and ask whether to change the design; never weaken the check. |
| A step of the procedure was never verified | Run it once now, or mark it in the skill as needing confirmation. |
| The skill needs a buracle subcommand that does not exist | Do not invent it. Put the logic in a script under `scripts/`, or report the missing command. |
| The user wants the skill text in another language | Say once that agents follow English instructions more reliably; keep trigger phrases in the user's language either way (phase 4). |

## Example

The user says "Turn the release steps we just did into a skill." `buracle skills list --json` shows
no `release` skill. The session's steps were: bump the version, `bun test`, `git tag`,
`git push --tags`. Result: `canonical/skills/release/` with `invocation: explicit` (it pushes tags),
phases with a confirmation gate before the push, and `evals/cases.json` with "cut a release" and the
same request in the user's language as triggers and "bump the dependency versions" and "write release
notes for the last sprint" as near misses. Lint is clean, and the commit and `buracle install` steps are
offered.

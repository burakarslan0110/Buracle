# Buracle · Claude Code plugin

This folder is Buracle's Claude Code side. `buracle build` generates it from `canonical/` and
`src/`; do not edit it by hand. The plugin has two layers:

- **Command hooks** (`hooks/hooks.json`) are the backbone: guards, the consent gate, the plan stop
  guard, memory, compaction, file checks and code indexes. They always run: in the terminal, the
  desktop app, VS Code and `claude -p`. Each runs the plugin's launcher in exec form,
  `bun ${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts hook claude <Event>` (`command` plus `args`, no shell), so
  it starts the same way under sh, Git Bash and PowerShell; the launcher runs the runtime the shim
  `buracle install` wrote runs, else the checkout. bun must be on Claude Code's PATH, as for the MCP
  servers (the desktop app reads it from the shell profile). PreToolUse sets `onFailure: "block"`:
  when the hook cannot start or times out, the tool call is blocked, not run unguarded.
- **The mod** (`hooks/register.tsx`) is the experience layer: it adds only what a mod alone can do
  and never repeats the hooks' work. If the mod fails or is turned off, the hooks keep guarding.

Tested Claude Code version: **2.1.302**. After a Claude Code update, run `buracle doctor claude`;
it runs the validation and the tests again.

## Install

`buracle install` installs the plugin from the local marketplace (the repository is read in place,
no version needed):

```sh
claude plugin marketplace add <buracle repository>
claude plugin install buracle@buracle --scope user
```

For a single session while developing: `claude --plugin-dir harness/claude`.

## Command hooks

| Event | Hooks |
|---|---|
| SessionStart | H07 restores the plan state (after a compaction), H13 memory index, H15 capability card, H16 session upkeep, H17 profile warning and the one-time notices of this version (at startup), H21 code indexes (in the background) |
| UserPromptSubmit | H10 pause/continue intents and the `memory_search` reminder for history questions, H20 consent the user gives in their own words, H05 context warning |
| PreToolUse | Bash/Monitor/PowerShell: H01 destructive-command guard (denies when it fails), H20 consent gate, H03 `grep -r` advice; write tools: H02 write guard (denies when it fails); WebSearch/WebFetch: H03 routing; AskUserQuestion: H09; SubagentHandback: H19 checks a review agent's handed-back report (auto mode) and denies an invalid one once; every answer that does not deny a main-agent call carries the H05 context warning once per band |
| PostToolUse | Write tools: H04 file checks; ExitPlanMode: H12 saves the plan under `docs/plans/`; TodoWrite and the task tools: open work for the handoff note; shell, web and MCP tools: H14 spool (in the background) |
| PostToolUseFailure | Buracle's MCP tools: H24 (two failures in a row and the server is down for the session) |
| PreCompact / PostCompact | H06 handoff note (without one, the open todos stay in the session's record for H07) / H14 compaction summary |
| Stop | H08 + H11 stop guard (until the plan is VERIFIED), H14 answer excerpt |
| SubagentStop | H19 validates the review agents' JSON report (skipped for a reviewer that already handed back through SubagentHandback) |
| SessionEnd | H14 memory finalizer, H16 upkeep |

In Buracle's review agents (`buracle:*-review`) the shell is read-only (rg, git diff/log/show,
`buracle review-scope` …); commands that change anything are denied.

**Consent gate (H20).** Every harness runs without approval prompts (`permissions.bypass`);
commands that are hard to undo or reach outside the machine (push, force push, `reset --hard`,
rebase, amend, branch delete, `git clean`, `--no-verify`, publishing, database drops, recursive
deletes) run only when the user allowed them in this session: in their own words ("push it", "yes,
delete it") or by answering the question the denial told the agent to ask.

## The mod

| Mod event | What it does |
|---|---|
| `ui.render` AbovePrompt | **The workflow band**: the running slash workflow (`/plan-build`, `/goal-build`, `/bugfix`, `/requirements`, `/research`, …) as a live phase chain above the prompt, with the plan's progress, the build round and acceptance criteria, the current step and running review agents. A nested run shows its breadcrumb (`prd › research`). It folds `workflow.foldAfterSec` after the run ends; `workflow.band: false` turns it off. It yields to surveys and to an agent's transcript, and sizes itself to the band (3 rows from 96 columns, 2 from 56, 1 from 24). |
| `command.run` `/buracle:<workflow>`, `turn.start` | Record the start in `flow.json` (H25 flow.track), so the band shows at once; the command runs as typed. |
| `tool.call` Skill, Agent, TodoWrite, TaskCreate, TaskUpdate | Feed the band: a workflow skill the model loaded (nested), subagents (a background one until its turn ends), the todo in progress. |
| `tool.call` Bash/Monitor/PowerShell | In an interactive session, asks right away about a command the consent gate would stop ("Allow once", "Allow for this session", "Refuse") and writes the answer to the consent record the command hook reads. Tracks commands and their results for the turn receipt and the loop alarms; a `buracle flow` or `buracle plan` command refreshes the band. |
| `tool.call` write tools | Track edits for the turn receipt (file, +/− lines) and the "same change undone and redone" alarm; an edit of the bound plan file refreshes the band. |
| `tool.call` read and MCP tools | With `guards.redact` on, mask secrets (keys, tokens) in tool output before the model reads it. |
| `turn.complete` | The turn receipt: a toast for unverified changes, a failed check or a success claim without evidence; after an edit-only turn, the suggestion "run the checks …" (Tab takes it); a native notification when a turn longer than `workflow.notifyAfterSec` ends. |
| `session.start` | Registers the commands; in a session that holds an unfinished run, suggests continuing it. |
| `session.measure` | One toast per context threshold (85%, 95%). |
| `session.compact` | The summary keeps the active plan, the running workflow, decisions with their reasons, rejected approaches, verification commands and results, touched files and background work (the hook writes the handoff note). |
| `tool.describe` | Critical Buracle MCP tools (memory, codegraph, semble, context7 …) are listed up front, never deferred. |

**Commands:** `/buracle-ping` (`pong` without a model call), `/buracle-status [status|memory|plan|flow]`
(the plugin's `buracle` skill holds the name `/buracle`), `/remember <text>` (a memory capture
the next harness files), `/brain` (opens the brain web UI in the browser), `/aside <question>` (a read-only side
question that leaves the session untouched). When Claude Code refuses a name, the command is
registered as `/buracle-<name>` instead (`/buracle-remember`, `/buracle-brain`, `/buracle-aside`).
The mod answers only the names Claude Code accepted; a refused name goes to its owner unchanged.

**Panes:** memory (`buracle-memory`) and plan (`buracle-plan`, also the band's "details").

The status line is not the mod's: `buracle statusline claude` draws it (two lines: model, context
bar, 5-hour and 7-day usage; Buracle and Claude Code versions and, while it runs, the memory web UI link).

## Files it reads and writes

- Reads: `~/.buracle/state/runtime-config.json` (settings), `state/memory-ui.json` (the web UI's
  address, while it runs), `state/memory/status/_global.json` (memory pane), `sessions/claude/<session>/state.json`
  (plan), `sessions/claude/<session>/flow.json` (the band) and the bound plan file.
- Writes: `~/.buracle/sessions/claude/<session>/consent.json` (consent),
  `sessions/claude/<session>/flow.json` (workflow starts), a memory capture (`/remember`).

The command hooks also write `sessions/claude/<session>/{state.json,telemetry.json,work.json}`,
`state/memory/spool/`, handoff memories in the project's brain (`~/.buracle/brain`) and
`docs/plans/` in the project; `buracle flow` and `buracle plan` keep `flow.json` current.
`BURACLE_HOME` moves these paths. `BURACLE_NO_CAPTURE=1` turns memory capture off,
`BURACLE_NO_AUTOSTART=1` the background indexes. Nothing starts the web UI by itself: it runs after `buracle mem ui`.

## Known limits

- The band, the consent dialog and the suggestions do not show in the VS Code panel or in
  `claude -p`; there the consent gate denies and the agent asks the user itself. The hooks run
  everywhere, and `buracle flow status` shows the running workflow anywhere.
- On machines with managed settings, Claude Code's built-in `cc-plugin-sec-default` mod may skip
  some events of user mods (`skill.prompt` among them, which is why the band does not depend on
  it); Buracle's guards and memory live in the command hooks and are not affected.

## Verify

```sh
claude plugin validate --strict --json harness/claude   # no errors, no warnings; every gating hook has a .catch
claude plugin test harness/claude                       # tests/register.test.tsx, tests/band.test.tsx
tsc -p harness/claude          # once the plugin was loaded (.claude-plugin/types)
```

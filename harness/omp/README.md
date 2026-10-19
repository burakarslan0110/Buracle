# buracle-omp

Buracle's plugin package for Oh My Pi (omp). `buracle build` **generates** this directory from `canonical/`
and `src/adapters/omp/`; do not edit it by hand. Change the sources and run `buracle build`;
`buracle build --check` confirms that nothing drifted.

## Install

`buracle install omp` does the following, as one transaction that can be rolled back:

- `omp plugin link <repo>/harness/omp`: the package is linked as `~/.omp/plugins/node_modules/buracle-omp`.
  The link follows the checkout, so `git pull` and `buracle build` need no reinstall: run `/reload-plugins`
  for rules, commands, agents and MCP servers, and restart omp for the extension code.
- `~/.omp/agent/config.yml`: only these keys are written; every other setting stays as you have it.
  - `statusLine`: preset `custom`, the segment lists and `showHookStatus`.
  - `tools.approvalMode: yolo` with `permissions.bypass` (`write` without it): omp runs tools without asking,
    while the extension's guards still deny dangerous calls (H01, H02) and hold hard-to-undo ones for your
    consent (H20). While `permissions.enforce` is on, a changed value is written back on the next install
    or sync (with a warning; uninstall restores the value it replaced), and `buracle doctor omp` reports it.
  - `tools.xdev: false`: MCP tools are top-level tools the model sees, not `xd://` devices it must look up.
  - `defaultThinkingLevel` from config `effort.omp` (`auto` writes `xhigh`, `keep` writes nothing). A level
    you set yourself is kept. A `:level` suffix on `modelRoles.default` overrides it (`buracle doctor omp` says so).
  - `memory.backend: off` and `enabledProviders: []`.
- `~/.omp/agent/AGENTS.md`: a short managed block that points to the plugin (the rules ship in the plugin).

Skills are not in this package: omp reads the shared neutral render in `~/.agents/skills` itself.

## Contents

- `extensions/buracle.js`: the extension, one file (src/core plus the omp runtime). It runs the tool guards (H01,
  H02, H03 with the semble and codegraph root check, H09, H20), the usage ledger with its reminders and
  deny-once gates (H24), file checks (H04), the context warning (H05), the compaction note and restore
  (H06, H07), the stop guard and the turn-end routing check (H08, H11, H23), intents and the prompt router
  (H10, H22), the memory index, capability card and workspace lines (H13, H15, H21), session capture and the
  finalizer (H14), maintenance (H16), the profile guard (H17), telemetry and the status texts (H18:
  `buracle.budget`, `buracle.mem`, and the status band below the editor), the review-report check of the
  review agents (H19), workflow tracking (H25), profile signals (H26) and Context Mode's session bridge (H27:
  prompts and tool events into context-mode's session store, a snapshot before compaction, a restore after
  it); the guards also judge every context-mode call. When a handler fails, the tool call is allowed and the
  error goes to the log; only the H01 and H02 guards fail closed.
- The running workflow shows above the editor (widget `buracle.flow`, `workflow.band`): its phases, progress
  and current step.
- Extension commands (no model turn): `/buracle-status [status|memory|plan|flow]` (alias `/buracle`),
  `/remember <text>` (a note in the memory inbox), `/brain` (starts and opens the memory web UI) and
  `/buracle-ping` (answers `buracle: pong`); `/aside <question>` asks a read-only side question (one side
  turn of the model, never added to the session, like omp's own `/btw`).
- `rules/`: always-on rules, and path rules injected when matching files are edited (TTSR): `buracle-backend.md`, `buracle-blazor.md`, `buracle-browser-automation.md`, `buracle-core.md`, `buracle-dotnet.md`, `buracle-explain.md`, `buracle-frontend.md`, `buracle-go.md`, `buracle-memory.md`, `buracle-mobile.md`, `buracle-python.md`, `buracle-tooling.md`, `buracle-typescript.md`.
- `commands/`: one workflow command per user-invocable skill: `/ab-test`, `/bugfix`, `/dead-code`, `/find-skill`, `/goal-build`, `/inspect`, `/new-skill`, `/plan-build`, `/project-rules`, `/requirements`, `/research`, `/security-audit`.
- `agents/`: read-only review agents `changes-review`, `goal-build-review`, `plan-build-review`.
- `.mcp.json`: pinned MCP servers `buracle-memory`, `codegraph`, `context-mode`, `context7`, `grep`, `semble`, `web-fetch`, `web-search`. `chrome-devtools` is left out because omp drops browser MCP servers while its built-in browser is on.

## Version

Verified with omp 18.10.1; needs at least 18.8.0. `buracle doctor omp` checks the version, the link and the settings.

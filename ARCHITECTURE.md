# Buracle Stack architecture

A short map for contributors: where code lives, how one source becomes the configuration of seven harnesses (Claude
Code, Codex CLI, OpenCode, Oh My Pi, Qwen Code, Pi and AGY CLI), and which invariants hold it together.
The user guide is at [stack.buracle.dev](https://stack.buracle.dev) (source in `site/` on the `dev` branch), [COMPATIBILITY.md](COMPATIBILITY.md) lists what each harness supports and
[AGENTS.md](AGENTS.md) has the rules for changing code. The "DESIGN §n" and "CONTRACTS §n" notes that comments cite are
not in this repository; the code and tests are the reference.

## Layers

| Layer | Holds | Rule |
| --- | --- | --- |
| `canonical/` | Skills, rules, review agents and YAML data (`hooks.yaml`, `mcp.yaml`, `tools.yaml`, `routing.yaml`, `statusline.yaml`, `buracle.yaml`, `skill-triggers.yaml`, `notices.yaml`, `tips.yaml`) | Names no harness. Its one generated file is `skills/buracle/references/commands.md` |
| `src/core/` | Pure logic: guards, routing, plan and flow state, harness profiles, status rendering, memory formats, redaction | No IO, clock or randomness; relative imports only (`tests/core/purity.test.ts`). Copied unchanged into the Claude plugin |
| `src/engine/` | IO: paths, files, processes, git, config, the transaction engine, toolchain, install and update | Every write into a harness folder goes through `src/engine/txn.ts` |
| `src/adapters/` | One folder per harness, plus `shared/` (the hook pipeline and common code) | An adapter decodes its host's payloads and encodes its answers; decisions come from `core` and the pipeline |
| `src/workflow/` | Plans, flows, worktrees, review scope, project sync, lint, the session store, the second opinion | |
| `src/memory/` | The Brain on CortexDB: store, MCP server, capture, handoff, backup, the Console (`src/memory/ui/`) | Prefixed ids live in `src/memory/store.ts` only |
| `src/usage/` | Per-harness usage collectors and status bars | |
| `harness/` | Generated output listed in `harness/.manifest.json`; not committed on any branch | Never edited by hand |

The CLI is `src/cli/main.ts` (a thin entry), `src/cli/router.ts` and one module per command in `src/cli/commands/`.

## The four pillars

Skills. A skill is a folder under `canonical/skills/` with a `SKILL.md` and optional `references/`, `scripts/` and
`evals/`. The text is the same for every harness, with no placeholders or harness-only blocks (`buracle skills lint`
rejects them). The build renders each skill once into `harness/agents-skills/<id>`, and `buracle install` writes it to
`~/.agents/skills/<id>`, which Codex, OpenCode, Oh My Pi, Qwen Code and Pi read themselves. AGY CLI reads only its own
skills folder, so the install links each skill into it. Claude Code reads the plugin's bundled copy.

Hooks. `canonical/hooks.yaml` lists 26 hooks (`H01` to `H28`; `H26` and `H27` are retired and ids are never reused).
Each names what it does, whether it can block, whether it fails open or closed, and its binding per harness. Every
harness runs the same pipeline behind them.

MCP. `canonical/mcp.yaml` declares each server: how to launch it, its API-key variable and its routing category. A
server ships to every harness unless it says `except: [<harness>]` or `harnesses: [...]`. Each entry runs
`buracle mcp run <id>`, a thin forwarder (context7, semble, web-search and web-fetch share one backend per machine,
chrome-devtools starts lazily, codegraph runs once per session). `canonical/routing.yaml` and the routing hooks decide
which tool answers which question.

Brain. One CortexDB file serves every harness through the `buracle-memory` MCP server and `buracle mem`.

Rules and review agents travel with them. `canonical/rules/always/` loads in every session and stays under 8,000 bytes
(`buracle rules lint`); `canonical/rules/paths/` loads when the agent first touches a matching file. Review agents in
`canonical/agents/` share text through `{{include:review-shared#<part>}}`, expanded by `resolveAgents`
(`src/adapters/shared/agents.ts`). Qwen Code, Pi and AGY CLI get no rule files or review agents yet.

## Events and the shared pipeline

`src/core/events.ts` defines seven events: `sessionStart`, `prompt`, `preTool`, `postTool`, `stop`, `preCompact` and
`sessionEnd`. A harness profile maps them to native events; an event the host lacks maps to `null`, and
`src/adapters/shared/host-limits.ts` records the gap and the fallback (AGY CLI has no `preCompact` or `sessionEnd`).

`src/adapters/shared/pipeline/` has one file per event. Each function takes a typed input and a `PipelineDeps` object
and returns a typed decision. It never reads a native payload or writes a native answer. Adapters call it two ways:

- Command hooks (Claude Code, Codex, Qwen Code, AGY CLI): the host runs `buracle hook <harness> <event>`; the adapter
  (`src/adapters/<harness>/hook.ts`) decodes the JSON, calls the pipeline and prints the answer. `dispatchHook`
  (`src/cli/commands/hook.ts`) catches every error. The Claude Code and Codex hooks read `harness/hook-data.json`.
- In-process runtimes (OpenCode, Oh My Pi, Pi): a plugin or extension inside the host makes the same calls
  (`src/adapters/opencode/runtime/plugin.ts`, `src/adapters/omp/runtime/extension.ts`,
  `src/adapters/pi/runtime/extension.ts`; Oh My Pi and Pi share `src/adapters/shared/pi-family/`). The build bundles
  each runtime with Bun.

A denial reads `Buracle Stack H<nn>: <reason>`. Hooks fail open: a step that throws is logged and skipped. The exceptions are
the guards (`H01`, `H02`, `H20`) on `PreToolUse` of the command-hook harnesses (`GUARD_EVENTS` in
`src/engine/hook-fail.ts`), which deny when they cannot run.

## HarnessProfile

A harness is data first. `src/core/harness/<id>.ts` exports one `HarnessProfile` (type in `profile.ts`), listed in
`index.ts`. The `Harness` type, tool tables, labels and everything below derive from it: identity and config folder,
how skills are read and invoked, how plan mode is entered, how MCP tool names are spelled, the canonical-to-native event
map, and the native tool names by kind. Code outside `src/core/harness/` never switches on a harness name. When a field
is missing, add it to the type.

To add a harness:

1. A profile file and its line in `src/core/harness/index.ts`.
2. A minimum version in `src/engine/update/min-versions.ts` and any gaps in `host-limits.ts`.
3. An adapter in `src/adapters/<id>/` implementing `Adapter` from `src/adapters/registry.ts` (`detect`, `build`,
   `installPlan`, `doctor`, and `hook` or an in-process runtime), kept thin.
4. Bindings in `canonical/hooks.yaml` and `canonical/statusline.yaml`, and an `except:` in `canonical/mcp.yaml` for any
   server it should not get.

For a command-hook harness the shared wiring lives in `src/adapters/shared/command-host/` (`commandDeps`, `runFrame`
and the common events), with the codec in `shared/claude-dialect.ts` for Claude-shaped hosts. Qwen Code and AGY CLI use
it. `tests/adapters/parity.test.ts` fails until everything is consistent.

## Transactions and the ownership ledger

Every write into a harness folder is a `Plan` (`{ id, harness, ops }`) applied by `applyPlans()` in `src/engine/txn.ts`.
Ops include `file`, the JSON, JSONC and YAML merges, `toml-tables`, `md-block`, `symlink`, `remove` and `exec`, and each
names its `owner`. A transaction takes a lock, backs up what it will touch under `~/.buracle/backups/<txn>`, journals,
writes atomically, verifies, and records each path in the ledger `~/.buracle/state/owned.json`.

The ledger protects user files. A file that is not in the ledger, or whose hash changed since Buracle Stack wrote it, becomes a
conflict and the user's version stays. Uninstall removes only what the ledger shows Buracle Stack wrote. An unreadable ledger
stops the run. A failed transaction rolls back, and a journal a crash left unfinished is repaired by `repairUnsettled()`
before `buracle install` or `buracle update` write anything. Every path comes from `src/engine/paths.ts`, which honors
`HOME` and `BURACLE_HOME`, so tests and dev builds stay out of the real folders.

Install builds the generated files, copies the checkout to a frozen runtime under `~/.buracle/runtime/<id>` and checks
it, installs the toolchain, then applies the core plan, the skills plan and one plan per detected harness
(`src/engine/update/install-core.ts`). A failing harness rolls back alone. Hooks and the CLI run the frozen runtime, so a
checkout edit reaches them at the next install.

## The Brain

One CortexDB file, `~/.buracle/brain/brain.db`, holds every memory. The person is scope `user` (user id `person`) and
each project is scope `global` with its slug as namespace. `memory_id` is global, so `src/memory/store.ts` alone
prefixes it (`u/<id>`, `p/<slug>/<id>`). CortexDB must be 2.137.0 or newer (`CORTEXDB_MIN_VERSION` in
`src/engine/toolchain/cortexdb.ts`).

A memory has a kind, title, summary, body, tags, cited files, entities, importance, `origin` (`explicit` or `inferred`)
and `confidence`. Native fields handle `ttl_seconds` (sessions 45 days, handoffs 14), `supersedes` and `review_status`.
`src/core/memory/redact.ts` masks secrets on every write path. An inferred write never changes an explicit, pinned or
verified memory; it is stored beside it, marked as contradicting.

Capture is small. Adapters append redacted entries to a session spool file and start no process. The files a session
touched come from git. At session end one detached, bounded `buracle mem finalize` (`src/memory/finalize.ts`) writes the
session memory, files stated preferences, asks a harness CLI with usage headroom for durable findings (validated as a
whole) and settles up to three older sessions. It ends with CortexDB's `sweep_expired` and drops old records, stale
spools and dead locks. A backup is a copy of the whole file (`src/memory/backup.ts`), taken at a session end when the
newest is over a day old; the newest ten are kept. Nothing else runs in the background.

## Generation and drift

`buracle build` runs every adapter's generator over `canonical/` and `src/core/` and writes `harness/<harness>/`,
`harness/agents-skills/` and `harness/hook-data.json`, plus the committed command reference and the local
`docs/reference/`. Output is deterministic and every file is listed in `harness/.manifest.json`; only listed files are
deleted as stale. `harness/` is committed on no branch, and `buracle install` and `buracle update`
build it first in a checkout that has none.

`buracle build --check` writes nothing. It builds twice into temporary roots and fails unless the trees are identical and
the manifest is exact; it also compares a local `harness/` and the committed command reference. Every CLI run refreshes
`$BURACLE_HOME/state/runtime-config.json`, so point `HOME` and `BURACLE_HOME` at a temp folder in development. CI runs
the three release checks on macOS arm64 and Linux x64; `AGENTS.md` has the commands and the branch model.

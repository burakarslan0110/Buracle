# Buracle architecture

This is the contributor's map of Buracle: where each kind of code lives, how one source of truth becomes the
configuration of four harnesses (Claude Code, Codex CLI, OpenCode and Oh My Pi), and which invariants hold the pieces
together. [README.md](README.md) is the user's guide, [COMPATIBILITY.md](COMPATIBILITY.md) says what each harness
supports, and [AGENTS.md](AGENTS.md) holds the rules for changing the code. The design notes and the written
contracts the code comments cite as "DESIGN §n" and "CONTRACTS §n" are not part of this repository; the code and its
tests are the reference.

## Layers

| Layer | Holds | Rule |
| --- | --- | --- |
| `canonical/` | The one source of truth: skills, rules, review agents and YAML data (`hooks.yaml`, `mcp.yaml`, `tools.yaml`, `routing.yaml`, `statusline.yaml`, `buracle.yaml`, `skill-triggers.yaml`, `notices.yaml`, `tips.yaml`) | Names no harness; rule and skill text is the same for every harness. The only generated file is `canonical/skills/buracle/references/commands.md`, a command summary the build writes from the CLI help |
| `src/core/` | Pure logic: guards, routing, plan and flow state, the harness profiles, status rendering, memory formats and redaction | No IO, no clock, no randomness, relative imports only (`tests/core/purity.test.ts`). The build copies it unchanged into the Claude plugin |
| `src/engine/` | IO: paths, files, processes, git, logging, config and canonical loaders, the transaction engine, merging, the toolchain, install and update | Every write into a harness folder goes through `src/engine/txn.ts` |
| `src/adapters/` | One folder per harness (generator, installer, doctor, hook handlers or runtime) and `shared/` (the hook pipeline and everything two adapters would otherwise duplicate) | An adapter decodes its host's payloads and encodes its host's answers; decisions come from `core` and the pipeline |
| `src/workflow/` | Plans, flows, worktrees, review scope, project sync, skill and rule lint, the session store, the second opinion (companion) | |
| `src/memory/` | The Brain on CortexDB: store, MCP server, capture, handoff, backup, the Buracle Console (`src/memory/ui/`) | The prefixed ids live in `src/memory/store.ts` only |
| `src/usage/` | Per-harness usage collectors and the status line bars | |
| `harness/` | Generated output, committed, listed in `harness/.manifest.json` | Never edited by hand |

The CLI is `src/cli/main.ts`, a thin entry, plus `src/cli/router.ts` and one module per command in
`src/cli/commands/`.

## The four pillars

Each pillar has one canonical form and one way into every harness.

**Skills.** A skill is a folder under `canonical/skills/` with a `SKILL.md`, optional `references/`, `scripts/` and
`evals/`. The text is harness-neutral: no render placeholders, no harness-only blocks (`buracle skills lint` rejects
both), and where a fact differs per harness it is one short labelled sentence. The build renders each skill once into
`harness/agents-skills/<id>`. `buracle install` writes that copy to `~/.agents/skills/<id>`, which Codex, OpenCode and
Oh My Pi read natively. Claude Code reads the same text from the Buracle plugin's bundled skills. Which harness reads
which folder, and how a user starts a skill (`/<id>`, `$<id>`, `@<id>`), is data in the harness profile.

**Hooks.** `canonical/hooks.yaml` lists 27 hooks (`H01` ... `H28`; an id is never reused). Each names what it does, whether
it can block, whether it fails open or closed, and its binding per harness: the native event and a matcher. Behind the
bindings every harness runs the same code, the shared pipeline described below.

**MCP.** `canonical/mcp.yaml` declares the servers: how to launch each, its API-key variable, and which routing category
it answers. A server ships to every harness unless it says `except: [<harness>]`, or names the few it belongs to with
`harnesses: [...]`. Install writes each harness's own MCP entry. A server entry runs `buracle mcp run <id>`, a thin
forwarder: servers with a shared backend (context7, semble, web-search, web-fetch) connect to one backend per machine
on the first real call, chrome-devtools starts lazily as a child, and codegraph runs once per session. Which tool an
agent should use for which question is `canonical/routing.yaml` plus the routing hooks.

**Brain.** One CortexDB file serves every harness through the `buracle-memory` MCP server and the `buracle mem` CLI;
see [The Brain](#the-brain).

Rules and review agents travel with them. Rules in `canonical/rules/always/` load in every session and stay under
8,000 bytes together (`buracle rules lint` enforces it); detail lives in skill references the model reads on demand.
`canonical/rules/paths/` rules load when the agent first touches a matching file. Review agents in `canonical/agents/`
share their common text through `{{include:review-shared#<part>}}` lines that `resolveAgents`
(`src/adapters/shared/agents.ts`) expands in every generator.

## Events and the shared pipeline

`src/core/events.ts` defines seven canonical events: `sessionStart`, `prompt`, `preTool`, `postTool`, `stop`,
`preCompact` and `sessionEnd`, with typed inputs and decisions (`ToolCall` and `PreDecision`, `StopInput` and
`StopDecision`, and so on). A harness profile maps them to the host's native events; a canonical event a host lacks
maps to `null`, and `src/adapters/shared/host-limits.ts` records the gap and the fallback.

`src/adapters/shared/pipeline/` has one file per event plus `health.ts` and `types.ts`. Each function takes a typed
input and a `PipelineDeps` object (the harness, the pure core, the environment, a `step` wrapper, lazy memory entry
points) and returns a typed decision. It never reads a native payload and never writes a native answer: that stays in
the adapter. Two shapes of adapter call it:

- **Command hooks** (Claude Code, Codex CLI). The host starts `buracle hook <harness> <event>` for every event. The
  adapter (`src/adapters/claude/hook.ts` and its siblings, `src/adapters/codex/hook.ts`) decodes the JSON payload, calls
  the pipeline and prints the host's answer. `dispatchHook` (`src/cli/commands/hook.ts`) catches every error. The
  command hooks read `harness/hook-data.json`, the part of `canonical/` they need.
- **In-process runtimes** (OpenCode, Oh My Pi). A plugin or extension loaded inside the host holds the same calls:
  `src/adapters/opencode/runtime/plugin.ts` with `host.ts`, and `src/adapters/omp/runtime/extension.ts` with `host.ts`.
  The build bundles each runtime with Bun, and the bundle is generated output.

A denial reads `Buracle H<nn>: <reason>` in every harness. Hooks fail open: a step that throws is logged and skipped. The
exceptions are the guards (`H01`, `H02`, `H20`) on the `PreToolUse` event of the two command-hook harnesses
(`GUARD_EVENTS` in `src/engine/hook-fail.ts`): when a guard cannot run, it answers with a deny so a broken Buracle
never leaves a call unguarded.

## HarnessProfile

A harness is data first. `src/core/harness/<id>.ts` exports one `HarnessProfile` (the type is in
`src/core/harness/profile.ts`) and `src/core/harness/index.ts` lists them. The `Harness` type, the harness order, the
tool tables, the labels and everything below is derived from the profiles:

- identity: label, binary name, how to tell a running host from its process, whether its runtime is `command` or
  `inprocess`, its config folder and the variables that relocate it;
- skills: which folders it reads, how a skill is invoked, how prose names a skill and how the model loads one;
- plan mode: how the model enters it and whether leaving it is an approval the hooks can see;
- MCP: how the host spells tool names (`mcp__server__tool`, plugin prefixes) and which client names identify it;
- events: the canonical-to-native map and the native events a `hooks.yaml` binding may name;
- tools: native tool name to kind (`bash`, `edit`, `patch`, `ask_user`, `agent`, ...).

Code outside `src/core/harness/` never switches on a harness name; it asks the profile. A missing profile field is
added to the type, not worked around with a literal.

Adding a harness takes:

1. a profile file and its line in `src/core/harness/index.ts`;
2. a minimum version in `src/engine/update/min-versions.ts` and any gaps in `src/adapters/shared/host-limits.ts`;
3. an adapter in `src/adapters/<id>/` that implements `Adapter` from `src/adapters/registry.ts` (`detect`, `build`,
   `installPlan`, `doctor`, and `hook` or an in-process runtime) and its line in the registry, written thin because
   decisions come from the pipeline;
4. bindings for it in `canonical/hooks.yaml` and `canonical/statusline.yaml`, and an `except:` on any server it should
   not get in `canonical/mcp.yaml`.

The parity tests (`tests/adapters/parity.test.ts`) fail until each of these is consistent.

## Transactions and the ownership ledger

Every write into a harness's folder is a `Plan` (`{ id, harness, ops }`) applied by `applyPlans()` in
`src/engine/txn.ts`. An op is a `file`, a `json-merge` / `jsonc-merge` / `yaml-merge`, `toml-tables`, an `md-block`, a
`symlink`, a `remove`, an `exec` (with its undo) and a few list and rekey merges; every op names its `owner`. A
transaction takes a lock, backs up what it will touch under `~/.buracle/backups/<txn>`, journals, writes atomically,
verifies and records every written path in the ownership ledger `~/.buracle/state/owned.json`.

The ledger keeps user files safe. A file that exists but is not in the ledger, or whose hash changed since Buracle wrote
it, becomes a conflict and Buracle keeps the user's version. Uninstall removes only what the ledger proves Buracle
wrote. An unreadable ledger stops the run; nothing writes an empty one. A failed transaction rolls itself back. A
journal left `applying` or `rollback-failed` by a crash is finished by `repairUnsettled()` before `buracle install` or
`buracle update` write anything, and when it cannot be finished they stop with a message. Every path comes from
`src/engine/paths.ts`, which honors `HOME` and `BURACLE_HOME`; that is how tests and development builds stay out of the
real folders.

Install runs in this order: build the generated files, copy the checkout to a frozen runtime under
`~/.buracle/runtime/<id>` and check the copy, install the toolchain, then apply the core plan, the skills plan and one
plan per detected harness, each its own transaction (`src/engine/update/install-core.ts` composes them). A harness that
fails rolls back alone. Hooks and the CLI run the frozen runtime, so a checkout edit reaches them at the next install.

## The Brain

One CortexDB file, `~/.buracle/brain/brain.db`, holds every memory. CortexDB's own buckets separate the scopes: the
person is scope `user` with user id `person`, and each project is scope `global` with its slug as the namespace. A
`memory_id` is global in CortexDB, so `src/memory/store.ts` is the only place that prefixes it: `u/<id>` for the person
and `p/<slug>/<id>` for a project. Everything above the store sees plain ids. One `cortexdb-mcp` child serves a
terminal. The required CortexDB is 2.137.0 or newer (`CORTEXDB_MIN_VERSION` in `src/engine/toolchain/cortexdb.ts`); the
install otherwise takes the latest release after it passes the memory check, with the brain backed up first.

A memory has a kind, title, summary, body, tags, cited files, `about` entities, importance and the two fields that
separate fact from inference: `origin` (`explicit` or `inferred`) and `confidence`. Native CortexDB fields do the
bookkeeping: `ttl_seconds` (sessions 45 days, handoffs 14), `supersedes`, `importance`, `review_status`, entities and
relations for graph retrieval. Secrets are masked by one module, `src/core/memory/redact.ts`, on every write path. An
inferred write never changes an explicit, pinned or verified memory; it is stored beside it, marked as contradicting.

Capture is small. The adapters append redacted entries to a session spool file and start no process for it: the
prompt, the turn or stop, a compaction and a note. The files a session touched come from git (`git diff --name-only` since the
session started, plus untracked files). When a session ends, one detached, bounded `buracle mem finalize`
(`src/memory/finalize.ts`) writes the session memory, files the preferences the user stated, asks a harness CLI with
usage headroom for the durable findings (validated as a whole before anything is written) and settles up to three
older sessions. `buracle mem capture` runs the same code on demand.

What is swept, and when: `finalize` ends by calling CortexDB's `sweep_expired`, which deletes the session and handoff
memories whose time has run out (a time to live only hides a row until then); it also drops old redaction and session
records, stale spools and dead locks. A brain backup is a copy of the whole file (`src/memory/backup.ts`); a session end
takes one when the newest is over a day old and keeps the newest ten. Nothing else runs in the background: no timers and
no start-up jobs.

## Generation and drift

`buracle build` runs every adapter's generator over `canonical/` and `src/core/` and writes `harness/<harness>/`,
`harness/agents-skills/` and `harness/hook-data.json`. Output is deterministic (no timestamps, stable key order) and
every file is listed in `harness/.manifest.json`; only listed files are ever deleted as stale. It also writes the command
summary skill reference and `docs/reference/` (local, outside git). `buracle build --check` compares instead of writing
and fails on any drift, so CI proves that the committed `harness/` is what `canonical/` and `src/` produce. Because every
CLI run refreshes `$BURACLE_HOME/state/runtime-config.json`, which installed harnesses read, development runs point `HOME`
and `BURACLE_HOME` at a temp folder.

The three release checks (typecheck, drift check, tests) run in CI on macOS arm64 and Linux x64; `AGENTS.md` has the
commands and the branch model.

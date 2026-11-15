# Harness and platform compatibility

Buracle generates configuration for four harnesses (Claude Code, Codex CLI, OpenCode and Oh My Pi) and runs on macOS and
native Linux. MCP, hooks, skills and the command line are four separate integration mechanisms: no harness supports
all of them the same way, and a capability a harness lacks is written down (and, in the code, recorded with a fallback)
instead of failing silently. Windows and WSL are not supported.

## How to read the labels

| Label | Meaning |
| --- | --- |
| **verified here** | Executed on the development machine (macOS, Apple silicon, Bun 1.4.3) by a test or script. |
| **CI definition** | A job in [.github/workflows/ci.yml](.github/workflows/ci.yml) is written to run it on that operating system. |
| **unverified** | Reasoned from the code and the harness documentation only. Nobody has run it. |

## Capabilities by harness

Buracle needs at least these versions (`src/engine/update/min-versions.ts`): Claude Code 2.1.290, Codex CLI 0.154.0,
OpenCode 2.0.20, Oh My Pi 18.8.0. Below them `buracle doctor` reports an error, the install leaves an older Codex
alone, and it skips the OpenCode service step. A newer release needs no check of its own. The limits below are recorded, with their fallback, in
`src/adapters/shared/host-limits.ts` and pinned by `tests/adapters/parity.test.ts`.

Every harness maps its native hooks onto the seven canonical events (session start, prompt, before a tool, after a
tool, stop, before compaction, session end) defined in `src/core/events.ts`, and every harness runs the same shared
pipeline behind them (`src/adapters/shared/pipeline/`). What differs is how the host calls Buracle and what it can show.

| Capability | Claude Code | Codex CLI | OpenCode | Oh My Pi |
| --- | --- | --- | --- | --- |
| MCP servers (the catalog in `canonical/mcp.yaml`) | all but `lsp` (Claude Code has its own LSP) | all | all | all but `chrome-devtools` and `lsp` (omp has its own browser and LSP) |
| Hooks | command hooks, plus in-process mod events | command hooks, trust-hashed by Codex | in-process plugin; no stop veto, no subagent-stop, no approval event | in-process extension |
| Skills | the plugin's bundled copy | `~/.agents/skills` | `~/.agents/skills` | `~/.agents/skills` |
| Rules | `~/.claude/rules` | `AGENTS.md` block plus path rules delivered on the first matching edit | `AGENTS.md` block plus path rules delivered on the first matching edit | native conditional rules plus an `AGENTS.md` pointer |
| Review agents | 3 | 3 (TOML) | 3 | 3 |
| Status line | native `statusLine` plus a band | partial: native items only | TUI plugin | extension |
| Command-line twin of every memory tool | yes (`buracle mem`) | yes | yes | yes |

Always-loaded rules are about 7 to 8 KB in every harness (`tests/adapters/always-loaded.test.ts` keeps each under 8,000
bytes of rendered output).

Recorded limits that matter for memory and the hooks:

- **Codex**: a hook cannot ask the user itself, so the destructive-command guard (H20) relies on Codex's own approval
  prompt, which never appears in `codex exec`, `--yolo` or `-a never` sessions (the denial explains it). The
  footer shows only Codex's own items. `compact_prompt` steers only local compaction, so the memory handoff carries
  the state over when a provider compacts on the server.
- **OpenCode**: no plugin hook runs before a session stops, so the stop guard re-prompts afterwards, with caps. Leaving
  the plan agent is not an approval, so the plan is captured as a draft. OpenCode's todo tool (`todowrite`) is
  experimental, so Buracle turns it on (`experimental.todo` in `opencode.jsonc`) and carries its open items into the
  handoff memory.
- **Oh My Pi**: a second opinion cannot hold bash to read-only commands, so it runs with read, grep and glob only.
- **Claude Code**: the hooks are plain `bun <plugin>/bin/buracle.ts hook claude <Event>` commands with no shell. They
  need `bun` on the `PATH` of the process that launches Claude Code; a GUI-launched Claude without Bun makes
  the guarded PreToolUse calls fail closed with a message that names `buracle doctor`.

The README's [Host limits](README.md#host-limits) table lists every recorded limit.

What a memory-enabled terminal runs: the Bun MCP server (`buracle mcp memory`) and one CortexDB child over a single
brain file. Session start, a prompt and a tool call start no detached process beyond the hook process itself; session
end starts one bounded `buracle mem finalize` child. The Buracle Console runs while a harness session is open, and
stops after its last one (see the README).

## Platforms

| | macOS (arm64 here; x64 ships) | Linux (x64 in CI; arm64 ships) |
| --- | --- | --- |
| Install | `scripts/install.sh` (bash); Homebrew advice for missing tools | `scripts/install.sh`; names the distribution's own command (apt-get, dnf, yum, pacman, apk, zypper) for a missing tool and never runs `sudo` |
| Shim | POSIX shell script, absolute Bun path baked in | the same |
| Claude hook command | exec form, no shell | exec form, no shell |
| Codex hook command | `sh -c`, `"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle"` | the same |
| MCP launch | `bun … mcp run <id>` hands the process to the server (`execve`), one process per server | the same |
| Atomic state writes | rename | rename |
| Console page | `open` | `xdg-open` |
| Typecheck, build check, tests | **verified here**; CI definition | CI definition |
| Generated hook and MCP commands executed | **verified here**: Claude exec form, Codex `sh -c`, the memory MCP entry of all four harnesses (`tests/adapters/hook-wire.test.ts`, `tests/adapters/mcp-wire.test.ts`) | CI definition (same tests, `checks` job) |
| Install scripts | **verified here** (parsed, run against stubs in `tests/engine/install-script.test.ts`); CI definition: `posix-install` job | CI definition: `posix-install` job |
| Real harness binaries started in CI | no | no |
| linux-arm64, darwin-x64 | CortexDB ships binaries; not exercised anywhere | |

## Known gaps, stated plainly

- Only macOS on Apple silicon is executed by hand. Every Linux cell above is a CI definition or unverified.
- Oh My Pi is not installed on the development machine: its adapter is verified by tests only, never against the real
  binary.
- Node is found on `PATH` plus a fixed list of directories. A Node installed by nvm, fnm, volta or mise is missed when
  a harness starts with a minimal `PATH`. Run `buracle install` from the shell where Node works, or put Node on the
  harness's `PATH`.
- No native Windows host and no WSL: paths, shells and guards assume POSIX.
- CortexDB must be 2.137.0 or newer (the release that added `sweep_expired` and `review_status`); below it
  `buracle doctor` reports an error. A new CortexDB release is installed after a SHA-256 check against the hash the
  release publishes and after it passes the memory check, with the brains backed up first. The real binary was last
  exercised against 2.151.1.

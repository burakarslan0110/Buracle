# Harness and platform compatibility

Buracle generates configuration for seven harnesses (Claude Code, Codex CLI, OpenCode, Oh My Pi, Qwen Code, Pi and AGY
CLI) and runs on macOS and native Linux. No harness supports MCP, hooks, skills and the command line in the same way. A
missing capability is recorded in `src/adapters/shared/host-limits.ts` with its fallback (see the README's
[Host limits](README.md#host-limits)). Windows and WSL are not supported.

Labels: **verified here** means run on the development machine (macOS, Apple silicon, Bun 1.4.3) by a test or script;
**CI definition** means a job in [.github/workflows/ci.yml](.github/workflows/ci.yml) is written to run it;
**unverified** means reasoned from code and docs only.

## Capabilities by harness

Minimum versions (`src/engine/update/min-versions.ts`): Claude Code 2.1.290, Codex CLI 0.154.0, OpenCode 2.0.20, Oh My
Pi 18.8.0, Qwen Code 0.26.1, Pi 1.5.2, AGY CLI 1.5.9. Below them `buracle doctor` reports an error, the install leaves an
older Codex alone and skips the OpenCode service step. All harnesses map their hooks onto the seven events of
`src/core/events.ts` and run the shared pipeline.

| Capability | Claude Code | Codex CLI | OpenCode | Oh My Pi |
| --- | --- | --- | --- | --- |
| MCP servers (`canonical/mcp.yaml`) | all but `lsp` | all | all | all but `chrome-devtools` and `lsp` |
| Hooks | command hooks, plus mod events | command hooks, trust-hashed by Codex | in-process plugin; no stop veto, subagent-stop or approval event | in-process extension |
| Skills | plugin copy | `~/.agents/skills` | `~/.agents/skills` | `~/.agents/skills` |
| Rules | `~/.claude/rules` | `AGENTS.md` block plus path rules on first matching edit | the same | native conditional rules plus an `AGENTS.md` pointer |
| Review agents | 3 | 3 (TOML) | 3 | 3 |
| Status line | native plus a band | native items only | TUI plugin | extension |

| Capability | Qwen Code | Pi | AGY CLI |
| --- | --- | --- | --- |
| MCP servers | all but `lsp` | all but `lsp` | all but `lsp` |
| Hooks | command hooks in `~/.qwen/settings.json` | in-process extension | command hooks in `hooks.json`; no compaction or end-of-conversation event |
| Skills | `~/.agents/skills` | `~/.agents/skills` | links in AGY's skills folder |
| Rules, review agents | none installed | none installed | none installed |
| Status line | a command | widget and footer entry | a command |

Every harness has the CLI twin of each memory tool (`buracle mem`). Always-loaded rules stay under 8,000 bytes
(`tests/adapters/always-loaded.test.ts`).

Limits that matter most:

- Codex: a hook cannot ask the user, so guard H20 relies on Codex's approval prompt, which never appears in
  `codex exec`, `--yolo` or `-a never` sessions (the denial explains it). The footer shows only Codex's own items.
- OpenCode: no hook runs before a session stops, so the stop guard re-prompts afterwards, with caps. Leaving the plan
  agent is no approval, so the plan is captured as a draft. Buracle turns on the experimental todo tool
  (`experimental.todo` in `opencode.jsonc`) and carries its open items into the handoff memory.
- Oh My Pi: a second opinion cannot hold bash to read-only commands, so it gets read, grep and glob only.
- AGY CLI: the memory context comes in at session start and is captured at every Stop.
- Claude Code: hooks are `bun <plugin>/bin/buracle.ts hook claude <Event>` commands with no shell, so `bun` must be on
  the `PATH` of the process that launches Claude Code. Without it, guarded PreToolUse calls fail closed with a message
  that names `buracle doctor`.

A memory-enabled terminal runs the Bun MCP server (`buracle mcp memory`) and one CortexDB child over a single brain file.
Session start, a prompt and a tool call start no detached process. Session end starts one bounded `buracle mem finalize`.
The Buracle Console runs while a harness session is open.

## Platforms

| | macOS (arm64 here; x64 ships) | Linux (x64 in CI; arm64 ships) |
| --- | --- | --- |
| Install | `scripts/install.sh`; Homebrew advice for missing tools | `scripts/install.sh`; prints the distribution's command (apt-get, dnf, yum, pacman, apk, zypper), never runs `sudo` |
| Hook commands | Claude exec form; Codex `sh -c` | the same |
| MCP launch | `bun … mcp run <id>` hands the process to the server (`execve`) | the same |
| Console page | `open` | `xdg-open` |
| Typecheck, build check, tests | **verified here**; CI definition | CI definition |
| Generated hook and MCP commands executed | **verified here** (`tests/adapters/hook-wire.test.ts`, `mcp-wire.test.ts`) | CI definition |
| Install scripts | **verified here** against stubs (`tests/engine/install-script.test.ts`); CI `posix-install` job | CI `posix-install` job |
| Real harness binaries in CI | no | no |
| linux-arm64, darwin-x64 | CortexDB ships binaries; not exercised | |

## Known gaps

- Only macOS on Apple silicon is run by hand; every Linux cell is a CI definition or unverified.
- Oh My Pi is not installed on the development machine, so its adapter is verified by tests only. Checks that need a
  login or a real model (`agy`, `qwen -p`) run only with `BURACLE_LIVE_SMOKE=1`.
- Node is found on `PATH` plus a fixed list of directories. One installed by nvm, fnm, volta or mise is missed when a
  harness starts with a minimal `PATH`: run `buracle install` from a shell where Node works, or put Node on that `PATH`.
- CortexDB must be 2.137.0 or newer (it added `sweep_expired` and `review_status`); below it `buracle doctor` reports an
  error. A new release is installed after a SHA-256 check and the memory check, with the brains backed up first. The
  real binary was last exercised against 2.151.1.

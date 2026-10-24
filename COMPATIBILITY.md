# Harness and platform compatibility

Buracle generates configuration for four harnesses and runs on macOS, Linux and Windows. MCP, hooks, skills and the
command line are four separate integration mechanisms: no harness supports all of them the same way, and a
capability a harness lacks is written down (and, in the code, recorded with a fallback) instead of failing silently.

## How to read the labels

| Label | Meaning |
| --- | --- |
| **verified here** | Executed on the development machine (macOS, Apple silicon, Bun 1.4.3) by a test or script during the 0.6 work. |
| **CI definition** | A job in [.github/workflows/ci.yml](.github/workflows/ci.yml) runs it on that operating system. The 0.6 branch was not pushed, so the job has been parsed and reviewed but not executed. |
| **unverified** | Reasoned from the code and the harness documentation only. Nobody has run it. |

## Capabilities by harness

Versions are the ones Buracle was last checked against (`src/engine/update/tested-with.ts`): Claude Code 2.1.302,
Codex CLI 0.162.1, OpenCode 2.0.30, Oh My Pi 18.10.1. Newer hosts are reported by `buracle doctor`; the limits below
are recorded, with their fallback, in `src/adapters/shared/host-limits.ts` and pinned by `tests/adapters/parity.test.ts`.

| Capability | Claude Code | Codex CLI | OpenCode | Oh My Pi |
| --- | --- | --- | --- | --- |
| MCP servers (the catalog in `canonical/mcp.yaml`) | yes | yes | yes | yes, except the Chrome DevTools and LSP servers |
| Hooks | command hooks on 12 events, plus in-process mod events | command hooks on 11 events, trust-hashed by Codex | in-process plugin triggers; no stop veto, no subagent-stop, no approval event | in-process extension events |
| Skills | plugin skills | `~/.agents/skills` | `~/.agents/skills` | `~/.agents/skills` |
| Rules | `~/.claude/rules` | `AGENTS.md` block plus path rules read on first edit | path rules read on first edit | native conditional rules |
| Review agents | 3 | 3 (TOML) | 3 | 3 |
| Status line | native `statusLine` plus a band | partial: native items plus a tmux bar | TUI plugin | extension |
| Command-line twin of every memory tool | yes (`buracle mem`) | yes | yes | yes |

Recorded limits that matter for memory and the hooks:

- **Codex**: a hook cannot ask the user itself, so the destructive-command guard (H20) relies on Codex's own approval
  prompt, which never appears in `codex exec`, `--yolo` or `-a never` sessions (the denial explains it). The
  footer shows only Codex's own items. `compact_prompt` steers only local compaction, so the memory handoff carries
  the state over when a provider compacts on the server.
- **OpenCode**: no plugin hook runs before a session stops, so the stop guard re-prompts afterwards, with caps. Leaving
  the plan agent is not an approval, so the plan is captured as a draft. OpenCode 2.x has no todo tool, so the
  handoff memory carries the plan without todos.
- **Oh My Pi**: a second opinion cannot hold bash to read-only commands, so it runs with read, grep and glob only.
- **Claude Code**: the hooks are plain `bun <plugin>/bin/buracle.ts hook claude <Event>` commands with no shell. They
  need `bun` on the `PATH` of the process that launches Claude Code; a GUI-launched Claude without Bun makes
  the guarded PreToolUse calls fail closed with a message that names `buracle doctor`.

What a memory-enabled terminal runs in 0.6 (one session, `buracle mcp memory`): the Bun MCP server and one
CortexDB child over a single brain file. In a single project, session start, a prompt and a tool call start no
detached process beyond the hook process itself; session end starts one bounded `buracle mem finalize` child. The brain web UI runs only when
you start it with `buracle mem ui`.

## Platforms

| | macOS (arm64 here; x64 ships) | Linux (x64 in CI; arm64 ships) | Windows (x64 in CI; arm64 ships) |
| --- | --- | --- | --- |
| Install | `scripts/install.sh` (bash); Homebrew advice for missing tools | `scripts/install.sh`; names the distribution's own command (apt-get, dnf, yum, pacman, apk, zypper) for a missing tool and never runs `sudo` | `scripts/install.ps1`; winget or scoop |
| Shim | POSIX shell script, absolute Bun path baked in | the same | `buracle.cmd` (fails closed for guard hooks like the shell shim), a shell twin for Git Bash |
| Claude hook command | exec form, no shell | exec form, no shell | exec form, no shell |
| Codex hook command | `sh -c`, `"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle"` | the same | `commandWindows`: `cmd /d /s /c` with the absolute `buracle.cmd` |
| MCP launch | `bun … mcp run <id>` hands the process to the server (`execve`), one process per server | the same | no process replacement exists: the launcher stays resident as a parent of each server |
| Atomic state writes | rename | rename | rename with a bounded retry on `EPERM`, `EBUSY` and `EACCES` |
| Typecheck, build check, tests | **verified here**; CI definition | CI definition | CI definition (60 s per-test timeout) |
| Generated hook and MCP commands executed | **verified here**: Claude exec form, Codex `sh -c`, the memory MCP entry of all four harnesses (`tests/adapters/hook-wire.test.ts`, `tests/adapters/mcp-wire.test.ts`) | CI definition (same tests, `checks` job) | CI definition: Codex `commandWindows` and the omp Windows entry are skipped here and run in the Windows job |
| Install scripts | **verified here** (parsed, run against stubs in `tests/engine/install-script.test.ts`); CI definition: `posix-install` job | CI definition: `posix-install` job | CI definition: `windows-install` job runs the real `install.ps1`, installs the four harnesses and probes every MCP server (push only) |
| `cmd.exe` shim logic | n/a | n/a | the generated script is checked by an interpreter of its statements here (`tests/engine/cmd-shim-logic.test.ts`); **unverified** under a real `cmd.exe` |
| Real harness binaries started in CI | no | no | no: the smoke tests skip when a binary is absent, and the Windows job installs the harnesses without starting one |
| linux-arm64, darwin-x64, win32-arm64 | CortexDB ships binaries; not exercised anywhere | | |

## Known gaps, stated plainly

- Only macOS on Apple silicon was executed during the 0.6 work. Every Linux and Windows cell above is a CI definition
  or unverified.
- The Oh My Pi project template `harness/omp/.mcp.json` launches through `/bin/sh`. On Windows `buracle install` writes a
  separate user-level `mcp.json` with Windows commands; whether the template entries clash with it is unverified.
- Node is found on `PATH` plus a fixed list of directories. A Node installed by nvm, fnm, volta or mise is missed when
  a harness starts with a minimal `PATH`. Run `buracle install` from the shell where Node works, or put Node on the
  harness's `PATH`.
- Windows kills only the direct child of an index run or language server; grandchildren can outlive it.
- The Windows `openInBrowser` call for `buracle mem ui --open` goes through plain `cmd /c start` and its quoting is untested.
- A new CortexDB release is installed after a SHA-256 check against the hash the release publishes, and the previous
  version is kept; the engine behaviour Buracle relies on was verified on CortexDB 2.139.0 only.

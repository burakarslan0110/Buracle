---
title: Update and repair
description: How to update Buracle Stack, read buracle doctor, fix common problems and uninstall.
order: 10
---

`buracle update` updates Buracle Stack, your skills and the toolchain, each part from its own source. `buracle doctor` tells you what is broken and how to fix it.

## Update

```sh
buracle update
```

In a terminal, `buracle update` checks every part and applies what is new, one step at a time. Without a terminal it only checks, and `--yes` applies.

| Command | What it does |
|---|---|
| `buracle update --check` | Only compares with the newest releases, and the status line shows how many updates wait |
| `buracle update self` | Fetches the Buracle Stack checkout, fast-forwards it and runs `buracle install` |
| `buracle update skills` | The skill sources and the skills you added with `buracle skills add` |
| `buracle update mcp` | The MCP server packages of the toolchain |
| `buracle update tools` | The Homebrew tools, the language servers and the other toolchain packages |
| `buracle update codegraph` | One part, by name |

After an update that changed Buracle Stack or a skill source, it rebuilds and installs again, and the MCP handshake runs again for each server that moved. If that install fails, the hooks keep the old runtime and the checkout goes back to its previous commit. A part whose check failed is reported as not checked, never as up to date.

`update.minReleaseAgeDays` holds back npm and PyPI releases younger than that many days. The default is 0, so new releases are used at once.

## Health checks

```sh
buracle doctor
```

In a terminal the report shows one line per section with its counts. Under each line it lists only the warnings and errors, each with its fix. `--all` shows every row, the passing ones too.

| Topic | What it checks |
|---|---|
| `config` | `~/.buracle/config.yaml`, the `buracle` command, PATH and the memory folder |
| `runtime` | The frozen runtime the hooks run, hook failures in the last 24 hours and stale locks |
| `tools` | The CLI tools and the toolchain packages |
| `claude`, `codex`, `opencode`, `omp`, `qwen`, `pi`, `agy` | One harness: its version, its adapter's checks and, for Claude Code and Codex, a real run of the guard hook |
| `mcp` | Starts each MCP server and runs its handshake within 30 seconds |
| `lsp` | Starts each language server and runs its handshake |
| `memory` | CortexDB, the project and person brains, owed captures and the memory server |
| `index` | The codegraph and semble indexes of the current project |

`buracle doctor <topic>` runs one section. With a harness name it checks `config`, `runtime` and that harness. The exit code is `0` when all is well, `1` for errors and `2` for warnings.

## Common problems

| Problem | Fix |
|---|---|
| Every tool call is denied with "its guard hook could not run" | Run `buracle doctor`, then `buracle install`. The log is `~/.buracle/logs/buracle.log` |
| Claude Code's guarded calls fail closed | Put `bun` on the PATH of the process that starts Claude Code, because its hooks run as `bun` commands |
| Codex skips the Buracle Stack hooks | Open Codex and approve them once with `/hooks`. `buracle doctor codex` lists the hooks still pending |
| Codex is older than its minimum version | Update Codex, then run `buracle install codex` |
| OpenCode windows that were open during the install miss Buracle Stack | Restart them. The install restarted OpenCode's background service once |
| A Node.js from nvm, fnm, volta or mise is not found | Run `buracle install` from a shell where `node` works, or put Node on the PATH the harness starts with |
| The install script stops at Prerequisites | Run the command it prints, then run the script again |
| "Bun was installed but is not on PATH" | Open a new terminal and run the script again |
| Bun is too old | Run `bun upgrade` |
| The status line shows the `hooks` alarm | Run `buracle doctor runtime`, then `buracle install` |
| Port 41777 is taken | The Console uses the next free port, and `buracle mem ui` prints the address |

## Uninstall

```sh
buracle uninstall --dry-run
buracle uninstall
```

`buracle uninstall` removes only what the ownership ledger shows Buracle Stack wrote and what still holds Buracle Stack's content. It also stops the Console, takes out the PATH lines the install added and removes the system tools it downloaded.

What stays:

- the memory in `~/.buracle/brain`, always, even with `--purge-state`
- values you changed, and values that were yours before Buracle Stack
- `~/.buracle/config.yaml`
- the toolchain packages in `~/.buracle/toolchain`, unless you add `--purge-state`
- files in your projects, such as the `.codegraph/` index and the `.claude/skills` links, which it lists with how to remove them
- tools installed with Homebrew

`--purge-state` also deletes the rest of `~/.buracle`: the state, sessions, logs, install backups and journals, the toolchain and the frozen runtimes. When any step failed, it deletes nothing, so the records stay for a retry.

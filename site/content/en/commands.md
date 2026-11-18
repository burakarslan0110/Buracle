---
title: Commands
description: The buracle commands grouped by when you need them, each with a one-line example and its result.
order: 9
---

Run `buracle` in a terminal to open a menu: Install or repair (`i`), Update (`u`), Health check (`d`), Memory (`m`, opens the Console) and Quit (`q`). The commands below are the ones you run yourself, grouped by when you need them. Every command takes `--json` and `--help`, and `buracle help <command>` explains one. The skills you start inside a harness, such as `/plan-build`, are on the [Use cases](flows.md) page.

## First setup

| Example | Result |
|---|---|
| `buracle install` | Sets up every harness it finds, or repairs it, and prints a summary per section |
| `buracle install --dry-run` | Prints the diff of every change and writes nothing |
| `buracle install codex opencode` | Sets up or repairs only Codex and OpenCode |
| `buracle project sync` | In a repository: checks for an `AGENTS.md`, links `.agents/skills` into `.claude/skills` and sets up the project's brain |
| `buracle doctor` | Checks every part and lists only the problems, each with its fix |

Without a terminal, `buracle install` applies only with `--yes`. The [Install](install.md) page covers the install script and the first steps. To give `context7` an API key, see [MCP servers](#mcp-servers) below.

## Every day

| Example | Result |
|---|---|
| `buracle config get plan` | Prints the workflow switches with their effective values, defaults included |
| `buracle config set plan.reviews.companion auto` | Turns on the second opinion from another harness |
| `buracle config unset plan.reviews.companion` | Puts the default back |
| `buracle mem ui --open` | Opens the [Buracle Stack Console](console.md) in your browser |
| `buracle usage` | Shows the 5-hour and 7-day usage windows each harness reports, with their reset times |
| `buracle update --check` | Compares every part with its newest release. The status line shows how many updates wait |
| `buracle update` | Applies what is new, one step at a time, and installs again when Buracle Stack itself changed |

`buracle config` reads and writes `~/.buracle/config.yaml`. Keys that change a harness's own settings (`permissions.*`, `agents.teams`, `harnesses.*`, `routing.strictness`, `mcp.off.*`) reach the harness at the next `buracle install`. An agent cannot change the guards, the approvals or the reviews, so you run those `config set` commands yourself. [Update and repair](update.md#update) lists the update kinds.

## When something is wrong

| Example | Result |
|---|---|
| `buracle doctor` | One line per section, then only the warnings and errors, each with its fix |
| `buracle doctor codex` | Checks the config, the runtime and Codex |
| `buracle doctor runtime` | Checks the frozen runtime the hooks run, hook failures in the last 24 hours and stale locks |
| `buracle doctor memory --all` | Shows every memory check, the passing ones too |
| `buracle install` | Restores what is missing or changed, without pulling a new version |
| `buracle install codex` | Repairs Codex alone |
| `buracle uninstall --dry-run` | Lists what an uninstall would remove and writes nothing |

The exit code is the same for every command: `0` success, `1` error, `2` partial success or something you need to do. [Update and repair](update.md#common-problems) lists common problems with their fixes, and [Uninstall](update.md#uninstall) says what an uninstall keeps.

## Memory

| Example | Result |
|---|---|
| `buracle mem search "release process"` | The memories of this project and of you that match |
| `buracle mem remember "we pin Bun in .bun-version"` | A capture, filed into the right kind later |
| `buracle mem status` | The brain file with its buckets, the counts per region and the last write and capture |
| `buracle mem capture` | Runs the session-end capture for the newest session of this project now |
| `buracle mem backup` | Copies the whole brain file into `~/.buracle/brain/backups/<id>/` and keeps the newest 10 copies |
| `buracle mem restore <id> --project <slug>` | Restores one project's bucket from a backup and leaves the others alone |

Each memory tool of the agents has a CLI twin. [Memory from the command line](memory.md#memory-from-the-command-line) lists them.

## MCP servers

| Example | Result |
|---|---|
| `buracle mcp list` | Every server, its state in each harness and the command that starts it |
| `buracle mcp status` | Every running Buracle Stack MCP process, with its role, sessions, memory and uptime |
| `buracle mcp disable chrome-devtools --harness codex` | Turns the server off in Codex alone |
| `buracle mcp enable chrome-devtools --harness codex` | Turns it on again |
| `buracle mcp stop` | Stops the shared backends now. The next call starts them again |
| `buracle mcp key` | Shows where each API key comes from |

Pipe a key in, so it stays out of your shell history:

```sh
pbpaste | buracle mcp key context7
```

On Linux, use `wl-paste` or `xclip -o` in place of `pbpaste`. [Tools](tools.md#manage-the-servers) says what each server does.

## Projects and skills

| Example | Result |
|---|---|
| `buracle project check` | Compares the path rules, the skill links and `CLAUDE.md` with `AGENTS.md` and reports drift. It changes nothing |
| `buracle index status` | Shows the state of the project's code indexes and the last error |
| `buracle skills list` | Every skill with its source |
| `buracle skills find "terraform plan review"` | The installed and shipped skills that match, then registry candidates with license, freshness and risk ratings |
| `buracle skills add owner/repo --dry-run` | The audit of the skill (scripts, shell pipes, secrets, injection wording), with nothing installed |
| `buracle skills add owner/repo` | Copies the skill to `~/.agents/skills/<id>` and links it into `~/.claude/skills/<id>`, so every harness reads it |
| `buracle skills update` | Fetches the installed skills again and reinstalls what changed upstream |
| `buracle skills remove <id>` | Removes a skill that `add` installed |

In a harness, `/find-skill <need>` runs the same search, audit and install for you.

## Used by your agents

Your agents and hooks use more commands: `plan`, `flow`, `worktree`, `review-scope`, `rules`, `index`, `usage`, `hook`, `statusline`, `lsp` and `consent`. `buracle help --all` lists them all. A few help when you check on a run yourself:

| Example | Result |
|---|---|
| `buracle plan audit` | Compares the files the plan lists with the diff. It exits with code 2 when planned work is missing or a change was not planned |
| `buracle worktree status` | Every plan worktree of the repository |
| `buracle worktree diff saved-searches` | The commits, files and stats of that worktree's branch against its base |
| `buracle lsp check` | Starts each language server and runs its handshake |

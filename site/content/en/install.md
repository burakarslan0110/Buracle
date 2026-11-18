---
title: Install
description: What you need, the one install command, what it changes on your machine and what to do right after it.
order: 1
---

One command installs Buracle Stack and sets up every supported harness it finds on your machine:

```sh
curl -fsSL https://stack.buracle.dev/install.sh | bash
```

## Requirements

- macOS or Linux, on x64 or arm64. Windows and WSL are not supported.
- At least one harness: [Claude Code](https://code.claude.com/docs/en/quickstart), [Codex CLI](https://developers.openai.com/codex/cli), [OpenCode](https://opencode.ai), [Oh My Pi](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent), [Qwen Code](https://github.com/QwenLM/qwen-code), [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) or [AGY CLI](https://antigravity.google).
- git and curl.
- On Linux, also unzip while Bun is missing, and libatomic1 while Node.js is missing.

Bun 1.4 or newer runs Buracle Stack, and the script installs it when it is missing. The script never runs sudo or a package manager. When a tool is missing, it stops and prints the command that installs it: `xcode-select --install` on macOS, or the line for your distribution's package manager (apt-get, dnf, yum, pacman, apk or zypper) on Linux.

## What the script does

1. Checks git, curl and Bun, and installs Bun if needed.
2. Clones the `main` branch into `~/buracle`, or pulls it when that checkout already exists.
3. Runs `bun install --frozen-lockfile` in the checkout.
4. Hands over to `buracle install --script`, which prints a short summary per section.

You can read [the script](https://github.com/burakarslan0110/Buracle-Stack/blob/main/scripts/install.sh) before you run it. `BURACLE_CHECKOUT` changes the checkout folder and `BURACLE_HOME` changes `~/.buracle`.

## What buracle install does

- Builds the harness files from the checkout and copies a frozen runtime into `~/.buracle/runtime/<id>`. The copy goes live only after a check: a Claude Code hook and a Codex hook must deny `rm -rf ~` and let `ls` through.
- Installs the toolchain into `~/.buracle/toolchain`: every MCP server package and language server, plus missing system tools through Homebrew. When Homebrew cannot install Node.js, uv, ripgrep or jq, it downloads a pinned version, checks it against a pinned sha256 and unpacks it into `~/.buracle/toolchain/system`.
- Writes each harness's config as its own transaction, with a backup, a journal, an ownership ledger and a rollback of that harness alone if a step fails.
- Creates `~/.buracle/config.yaml`, the memory folder `~/.buracle/brain` and the `buracle` command in `~/.local/bin`, and adds that folder to your PATH when it is missing.
- Starts the [Buracle Stack Console](console.md) and runs the checks of `buracle doctor`.

Values you changed by hand stay as they are, and the install reports them as conflicts. Items you deleted stay deleted. Before a rare step, such as writing the config of a harness that is running, the install asks you in the terminal. The answer is no unless you say yes.

## First steps

1. Run `/reload-plugins` in every open Claude Code session. New sessions load the changes by themselves.
2. Sign in to the other harnesses once: `codex login`, `opencode auth login`, `omp login`, and the sign-in of Qwen Code, Pi and AGY CLI.
3. Follow the next steps the install prints. They can ask you to approve the hooks once with `/hooks` in Codex, or to restart OpenCode windows and omp sessions that were open during the install.
4. Run `buracle project sync` in each project. It checks for an `AGENTS.md`, links `.agents/skills` into `.claude/skills`, keeps local-only paths out of git through `.git/info/exclude` and sets up the project's brain.
5. If the repository has no agent guidance yet, run `/project-rules` in a harness. It finds the real commands and conventions in the code, runs the commands to check them and writes an `AGENTS.md` that every harness follows.

Codex starts skills with `$` and Pi with `/skill:`, so the last step is `$project-rules` in Codex and `/skill:project-rules` in Pi.

## Logs

| Log | Path |
|---|---|
| Each install run | `~/.buracle/logs/install-<date>.log` (only your user can read it) |
| Hooks and the CLI | `~/.buracle/logs/buracle.log` |

## Repair

Run the install command again. It pulls `main` into the existing checkout, and `buracle install` restores what is missing or changed. Run `buracle install` on its own to repair without pulling, or `buracle install codex` to repair one harness. To see what is wrong before you repair, run `buracle doctor`. [Update and repair](update.md) covers health checks and the uninstall.

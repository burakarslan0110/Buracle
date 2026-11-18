<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/buracle-dark.svg">
    <img src="assets/buracle-light.svg" alt="Buracle Stack" width="736">
  </picture>
</p>

<p align="center"><b>English</b> · <a href="README.tr.md">Türkçe</a></p>

<div align="center">

### One engineering setup, one memory, every coding agent

Buracle Stack is the layer that brings your coding agents together: the same skills, MCP servers, hooks and guards, one memory they all share, and workflows that finish with proof.

macOS · Linux, on x64 and arm64

```sh
curl -fsSL https://stack.buracle.dev/install.sh | bash
```

[![CI](https://github.com/burakarslan0110/Buracle-Stack/actions/workflows/ci.yml/badge.svg)](https://github.com/burakarslan0110/Buracle-Stack/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/burakarslan0110/Buracle-Stack?color=6D28D9&label=version)](https://github.com/burakarslan0110/Buracle-Stack/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-A21CAF.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/bun-%E2%89%A5%201.4-B45309.svg)](https://bun.sh)

[Guide](https://stack.buracle.dev) · [Install](https://stack.buracle.dev/install/) · [Workflows](https://stack.buracle.dev/workflows/) · [Memory](https://stack.buracle.dev/memory/) · [Commands](https://stack.buracle.dev/commands/)

</div>

<p align="center">
  <a href="https://stack.buracle.dev"><img src="https://stack.buracle.dev/media/preview.gif" alt="Buracle Stack in 40 seconds: seven coding agents lock onto one layer, a decision saved in Codex is recalled in Claude Code, sessions are distilled into a knowledge graph, and a plan-build loop runs to VERIFIED" width="720"></a>
</p>

<p align="center"><img src="https://stack.buracle.dev/assets/logos/claude-code.svg" alt="Claude Code" title="Claude Code" height="36"> <img src="https://stack.buracle.dev/assets/logos/codex.svg" alt="Codex CLI" title="Codex CLI" height="36"> <img src="https://stack.buracle.dev/assets/logos/opencode.svg" alt="OpenCode" title="OpenCode" height="36"> <img src="https://stack.buracle.dev/assets/logos/oh-my-pi.svg" alt="Oh My Pi" title="Oh My Pi" height="36"> <img src="https://stack.buracle.dev/assets/logos/qwen-code.svg" alt="Qwen Code" title="Qwen Code" height="36"> <img src="https://stack.buracle.dev/assets/logos/pi.svg" alt="Pi" title="Pi" height="36"> <img src="https://stack.buracle.dev/assets/logos/agy.svg" alt="AGY CLI" title="AGY CLI" height="36"></p>

## What it does

You may use Claude Code today, Codex tomorrow and OpenCode for a side project. Each one has its own config format, its own skills folder and its own memory, so they drift apart. Buracle Stack keeps one setup and writes it into Claude Code, Codex CLI, OpenCode, Oh My Pi, Qwen Code, Pi and AGY CLI.

- One setup: skills, rules, MCP servers, hooks and status lines live in `canonical/`. `buracle install` writes each agent's own format and keeps a backup, a journal and a rollback for every agent it touches.
- One memory: a local CortexDB file with a brain for each project and one for you. A decision you make in one agent is there in the next.
- Workflows with proof: `/requirements` turns a fuzzy idea into an approved PRD. `/plan-build`, `/goal-build` and `/bugfix` start each behavior change with a failing test, get an independent review and end when the result is proven.
- Guards: hooks deny catastrophic commands, ask before hard-to-undo ones and mask secrets, so the agents can run without approval prompts.
- Tools: nine MCP servers and six language servers, with routing that sends each question to the right one.
- The Buracle Stack Console: a local web page for the memory, plan reviews and workflow settings.

## Install

You need macOS or Linux (Windows and WSL are not supported), git, curl and at least one of the seven agents. Buracle Stack sets up every agent it finds.

```sh
curl -fsSL https://stack.buracle.dev/install.sh | bash
```

The script installs Bun if needed, clones `main` into `~/buracle` and runs `buracle install`. It never runs sudo or a package manager. Running it again updates and repairs. You can [read the script](scripts/install.sh) before you run it, and the [install guide](https://stack.buracle.dev/install/) lists every requirement.

## First steps

1. Run `/reload-plugins` in any open Claude Code session, and sign in to the other agents once.
2. Run `buracle project sync` in each project. It checks for an `AGENTS.md`, links the project's skills and sets up the project's brain.
3. Ask your agent for work as usual, or start a workflow: `/plan-build add rate limiting to the API`. In Codex, type `$plan-build`; in Pi, `/skill:plan-build`.

`buracle update` brings the newest version, `buracle doctor` shows problems with their fixes, and `buracle uninstall` removes only what Buracle Stack wrote. Your memory stays.

## Documentation

The guide at [stack.buracle.dev](https://stack.buracle.dev) has an English and a Turkish edition.

| Page | What it covers |
|---|---|
| [Install](https://stack.buracle.dev/install/) | Requirements, what the install changes, the first steps |
| [Workflows](https://stack.buracle.dev/workflows/) | The four workflows, the stop guard, worktrees and the other commands |
| [Memory](https://stack.buracle.dev/memory/) | The brain, what a session loads and saves, backups and privacy |
| [Console](https://stack.buracle.dev/console/) | The local web page and the workflow settings |
| [Guards](https://stack.buracle.dev/guards/) | What is denied, what asks first, your own patterns |
| [Tools](https://stack.buracle.dev/tools/) | MCP servers, language servers and the toolchain |
| [Harnesses](https://stack.buracle.dev/harnesses/) | What each agent gets, host limits and minimum versions |
| [Commands](https://stack.buracle.dev/commands/) | The `buracle` command |
| [Update](https://stack.buracle.dev/update/) | Updating, health checks, uninstalling and common problems |

[ARCHITECTURE.md](ARCHITECTURE.md) explains the design and [COMPATIBILITY.md](COMPATIBILITY.md) lists what was verified on each agent.

## Built on open source

Buracle Stack installs and connects these projects. Each keeps its own license, and every name and logo belongs to its owner. The [Open source](https://stack.buracle.dev/credits/) page lists all of them.

| Project | What it does in Buracle Stack | License |
|---|---|---|
| [CortexDB](https://github.com/liliang-cn/cortexdb) | Stores the memory: one brain file with a bucket per project and one for you | MIT |
| [Context7](https://github.com/upstash/context7) | Current library and framework docs | MIT |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | Symbols, callers and the impact of a change | MIT |
| [Semble](https://github.com/MinishLab/semble) | Semantic code search | MIT |
| [Open-WebSearch](https://github.com/Aas-ee/open-webSearch) | Web search without an API key | Apache-2.0 |
| [Fetcher MCP](https://github.com/jae-jae/fetcher-mcp) | Reads web pages in a headless browser | MIT |
| [Grep by Vercel](https://grep.app) | Code examples from public GitHub repositories | Hosted service |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Drives a Chrome browser | Apache-2.0 |
| [Bun](https://github.com/oven-sh/bun) | Runs Buracle Stack | MIT |
| [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) | Draws the diagrams on the Console's review page | MIT |

The language servers are Pyright, typescript-language-server, gopls, rust-analyzer, csharp-ls and Eclipse JDT LS. The toolchain adds ripgrep, ast-grep, jq, GitHub CLI, Ruff, ShellCheck, golangci-lint, tmux, uv and Node.js.

## Development

```sh
bun install
bunx tsc --noEmit -p .
T=$(mktemp -d) && HOME=$T BURACLE_HOME=$T/.buracle bun src/cli/main.ts build --check
bun test
```

CI runs these on macOS (arm64) and Linux (x64). Work lands on `dev`, and every passing push that changes the released files publishes the next version on `main`. Read [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md) before you send a change. If you find a bug or miss a feature, [open an issue](https://github.com/burakarslan0110/Buracle-Stack/issues).

## License

[MIT](LICENSE).

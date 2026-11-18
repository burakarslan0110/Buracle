---
title: Open source
description: The open source projects, harnesses and services Buracle Stack installs, connects to or builds on, with what each one does here and its license.
order: 11
---

Buracle Stack is MIT licensed, and it builds on the projects below. Each project keeps its own license, and the install fetches the ones it installs from their own sources. Project names, logos and marks belong to their owners. They appear here to credit the projects and to name the products Buracle Stack works with.

## MCP servers

| Project | What it is | How Buracle Stack uses it | License |
|---|---|---|---|
| [Context7](https://github.com/upstash/context7) | Upstash's service for current library documentation | The `context7` server (`@upstash/context7-mcp`): library and framework docs at the version you use | MIT |
| [CodeGraph](https://github.com/colbymchenry/codegraph) | A local, pre-indexed code graph that agents query over MCP | The `codegraph` server and the index builder: symbols, callers, callees and impact | MIT |
| [Semble](https://github.com/MinishLab/semble) | Semantic code search for agents that runs on the CPU | The `semble` server and the index builder: code search by intent | MIT |
| [Open-WebSearch](https://github.com/Aas-ee/open-webSearch) | A multi-engine web search server that needs no API key | The `web-search` server, with DuckDuckGo as the default engine | Apache-2.0 |
| [Fetcher MCP](https://github.com/jae-jae/fetcher-mcp) | A server that reads web pages through headless Chromium | The `web-fetch` server: pages as Markdown, HTML or text, rendered with their JavaScript | MIT (the npm manifest says ISC) |
| [grep.app](https://grep.app) | Vercel's code search over public GitHub repositories | The `grep` server, through the remote endpoint `https://mcp.grep.app` | Hosted service |
| [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) | A live Chrome browser for coding agents | The `chrome-devtools` server, with an isolated profile and no usage statistics | Apache-2.0 |

## Memory

| Project | What it is | How Buracle Stack uses it | License |
|---|---|---|---|
| [CortexDB](https://github.com/liliang-cn/cortexdb) | Local-first agent memory with a knowledge graph in one SQLite file | The engine under the shared memory: one `brain.db` with a bucket per project and one for you, served by `buracle-memory` | MIT |

## Language servers

| Project | What it is | How Buracle Stack uses it | License |
|---|---|---|---|
| [Pyright](https://github.com/microsoft/pyright) | Microsoft's type checker and language server for Python | Python diagnostics and navigation | MIT |
| [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server) | A language server for TypeScript and JavaScript around tsserver | TypeScript and JavaScript diagnostics and navigation, installed with TypeScript 6 | Apache-2.0 |
| [gopls](https://github.com/golang/tools) | The official Go language server | Go diagnostics and navigation, when Go is installed | BSD-3-Clause |
| [rust-analyzer](https://github.com/rust-lang/rust-analyzer) | The Rust compiler front end for editors | Rust diagnostics and navigation, when a Rust toolchain is installed | MIT OR Apache-2.0 |
| [csharp-ls](https://github.com/razzmatazz/csharp-language-server) | A Roslyn-based language server for C# | C# diagnostics and navigation, when the .NET SDK is installed | MIT |
| [Eclipse JDT LS](https://github.com/eclipse-jdtls/eclipse.jdt.ls) | The Eclipse-based Java language server | Java diagnostics and navigation, with Java 21 or newer | EPL-2.0 |

Claude Code and Oh My Pi run these servers through their own LSP support, and Codex and OpenCode reach them through the `lsp` bridge.

## Runtimes and tools

| Project | What it is | How Buracle Stack uses it | License |
|---|---|---|---|
| [Bun](https://github.com/oven-sh/bun) | A JavaScript runtime, bundler, test runner and package manager | Runs Buracle Stack's CLI and its command hooks | MIT |
| [Node.js](https://github.com/nodejs/node) | A JavaScript runtime built on V8 | Runs the npm MCP servers and language servers | MIT |
| [uv](https://github.com/astral-sh/uv) | A Python package and project manager | Installs `semble` on Python 3.12 | Apache-2.0 OR MIT |
| [Git](https://git-scm.com) | Distributed version control | Projects, worktrees and the diff a review reads | GPL-2.0 |
| [Homebrew](https://github.com/Homebrew/brew) | A package manager for macOS and Linux | Installs missing system tools when it is present | BSD-2-Clause |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | Recursive regex search that respects `.gitignore` | Exact-text search for agents and scripts (`rg`) | Unlicense OR MIT |
| [ast-grep](https://github.com/ast-grep/ast-grep) | Structural code search, lint and rewrite | Syntax-aware search and rewrites | MIT |
| [jq](https://github.com/jqlang/jq) | A command-line JSON processor | JSON in skills and scripts | MIT |
| [GitHub CLI](https://github.com/cli/cli) | GitHub's command-line tool | Pull requests and issues (`gh`) | MIT |
| [tmux](https://github.com/tmux/tmux) | A terminal multiplexer | An extra status line for Codex and OpenCode | ISC |
| [Ruff](https://github.com/astral-sh/ruff) | A Python linter and formatter | The check after a Python edit, in projects that configure it | MIT |
| [ShellCheck](https://github.com/koalaman/shellcheck) | Static analysis for shell scripts | The check after an edit of a `.sh` or `.bash` file | GPL-3.0 |
| [golangci-lint](https://github.com/golangci/golangci-lint) | A runner for many Go linters | The check after a Go edit, in projects with a `.golangci` config | GPL-3.0 |

The checks after an edit also run ESLint, go vet, gofmt and `dotnet format`, which come with the project or with its language toolchain. Buracle Stack does not install them.

## Libraries in Buracle Stack's code

| Project | What it is | How Buracle Stack uses it | License |
|---|---|---|---|
| [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid) | Renders Mermaid diagrams as SVG | Draws the Mermaid blocks of plans and PRDs on the Console's review page | MIT |
| [elkjs](https://github.com/kieler/elkjs) | Automatic graph layout | Lays out those diagrams (a dependency of beautiful-mermaid) | EPL-2.0 |
| [entities](https://github.com/fb55/entities) | HTML and XML entity encoding | A dependency of beautiful-mermaid | BSD-2-Clause |
| [jsonc-parser](https://github.com/microsoft/node-jsonc-parser) | A parser for JSON with comments | Edits harness settings files in place and keeps their comments and layout | MIT |
| [yaml](https://github.com/eemeli/yaml) | A YAML parser and stringifier | Reads `canonical/` and writes `~/.buracle/config.yaml` with its comments kept | ISC |
| [TypeScript](https://github.com/microsoft/TypeScript) | A typed language that compiles to JavaScript | Type-checks Buracle Stack's own source | Apache-2.0 |

## Harnesses it works with

| Project | What it is | How Buracle Stack plugs in | License |
|---|---|---|---|
| [Claude Code](https://github.com/anthropics/claude-code) | Anthropic's coding agent for the terminal, IDE and desktop | A plugin with skills, rules, agents, MCP servers, hooks and a status line | Proprietary |
| [Codex CLI](https://github.com/openai/codex) | OpenAI's coding agent that runs in the terminal | `hooks.json`, `config.toml`, an `AGENTS.md` block and skills | Apache-2.0 |
| [OpenCode](https://opencode.ai) | An open source terminal coding agent for many model providers | Server and TUI plugins that run the shared hook pipeline | MIT |
| [Oh My Pi](https://github.com/can1357/oh-my-pi) | A terminal coding agent with subagents, plan mode and LSP | An omp plugin with an extension | MIT |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | The Qwen team's terminal coding agent | Hooks and MCP in its settings, a `QWEN.md` block, review agents and commands | Apache-2.0 |
| [Pi](https://github.com/earendil-works/pi) | A minimal terminal coding agent | An extension, an `AGENTS.md` block and MCP in `mcp.json` | MIT |
| [AGY CLI](https://antigravity.google) | The terminal agent of Google Antigravity | `hooks.json`, `mcp_config.json` and a `buracle` plugin | Proprietary |

[Harnesses](harnesses.md) says what each one gets.

## Services

| Service | What it is | How Buracle Stack uses it |
|---|---|---|
| [skills.sh](https://skills.sh) | A public registry of agent skills | `buracle skills find` lists its candidates with their risk ratings |
| [GitHub](https://github.com) | Code hosting | Buracle Stack's repository and releases, and the license and freshness data `buracle skills find` shows |

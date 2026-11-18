---
title: Tools
description: What each of the nine MCP servers adds and where it comes from, how they are shared and managed, the context7 key, the toolchain, the language servers and the checks after each edit.
order: 7
---

Buracle Stack installs nine MCP servers and six language servers, and its routing hooks send each question to the tool made for it.

## MCP servers

Every server below reaches every harness, with two exceptions: `chrome-devtools` skips Oh My Pi, which has a browser tool of its own, and `lsp` goes only to Codex and OpenCode. The [Open source](credits.md) page lists every upstream project Buracle Stack uses.

### buracle-memory

buracle-memory is the shared brain. Every harness searches, reads and writes the same [memory](memory.md) through six tools: `memory_search`, `memory_get`, `memory_write`, `memory_update`, `memory_status` and `memory_context`. A session sees only the current project's bucket and yours.

- Routing sends it: "Why did we pick SQLite for the cache last time?"
- Upstream: Buracle Stack's own server (`buracle mcp memory`, MIT), on [CortexDB](https://github.com/liliang-cn/cortexdb) (MIT).

### context7

context7 returns current docs and code examples for the library version your project uses, so the agent stops guessing APIs. It resolves a library name to a Context7 ID, then queries the docs for that ID, with a version in the query when the version matters.

- Routing sends it: "How do I tag cache entries in Next.js 15?"
- Upstream: [Context7](https://github.com/upstash/context7) by Upstash, MIT. Buracle Stack runs the npm package `@upstash/context7-mcp`, and the docs come from Upstash's hosted service.

### codegraph

codegraph keeps a local graph of the symbols in the current repository, with their callers, callees and impact, so every change comes with its blast radius. One `codegraph_explore` call returns the source of the relevant symbols and the call paths between them. A file watcher keeps the index current while the server runs.

- Routing sends it: "Who calls sumItems, and what breaks if I change it?"
- Upstream: [CodeGraph](https://github.com/colbymchenry/codegraph) by colbymchenry, MIT. Buracle Stack runs the npm package `@colbymchenry/codegraph` with its telemetry and update check turned off.

### semble

semble finds code by what it does. It runs on the CPU with no API key, searches local folders or git URLs and finds code similar to a known location (`find_related`).

- Routing sends it: "Where do we parse dates from user input?"
- Upstream: [Semble](https://github.com/MinishLab/semble) by MinishLab, MIT. Buracle Stack installs `semble[mcp]` from PyPI with uv, on Python 3.12, with Hugging Face telemetry turned off.

### web-search

web-search searches the web with no API key and no sign-in. DuckDuckGo is the default engine, and results come back with a title, a URL and a description.

- Routing sends it: "What changed in the latest Bun release?"
- Upstream: [Open-WebSearch](https://github.com/Aas-ee/open-webSearch) by Aas-ee, Apache-2.0. Buracle Stack runs the npm package `open-websearch`.

### web-fetch

web-fetch reads a page in a headless Chromium through Playwright and returns its main content as Markdown, HTML or plain text, so pages that need JavaScript work too. `fetch_urls` reads several pages at once.

- Routing sends it: "Read the migration notes at this URL."
- Upstream: [Fetcher MCP](https://github.com/jae-jae/fetcher-mcp) by jae-jae, MIT (the npm manifest says ISC). Buracle Stack runs the npm package `fetcher-mcp` and gives each call up to 180 seconds.

### grep

grep finds real usage in public GitHub code, with literal or regular-expression searches filtered by language, repository or path.

- Routing sends it: "How do other projects configure Vitest workspaces?"
- Upstream: [grep.app](https://grep.app) by Vercel, a hosted service. Buracle Stack connects to its remote MCP endpoint `https://mcp.grep.app` and installs nothing.

### chrome-devtools

chrome-devtools drives a real Chrome: navigation, clicks and typing, screenshots and page snapshots, console messages, network requests, performance traces and Lighthouse audits.

- Routing sends it: "Why does the checkout page log an error after I click Pay?"
- Upstream: [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) by Google's Chrome DevTools team, Apache-2.0. Buracle Stack runs it with an isolated profile and with usage statistics and CrUX lookups turned off.

### lsp

lsp gives Codex and OpenCode the diagnostics, hover, definitions, references and symbols of the six [language servers](#toolchain). Claude Code and Oh My Pi reach the same servers through their own LSP support.

- Routing sends it: "Does this file still have type errors after the edit?"
- Upstream: Buracle Stack's own bridge (`buracle lsp mcp`, MIT). The language servers are listed under [Toolchain](#toolchain).

## Routing

With `routing.strictness` at `enforce` (the default), a harness's built-in web search and web fetch are denied while the matching MCP server is healthy, and the denial names the tool to use. `nudge` allows the call with a note, and `off` turns routing off. A server that cannot start is marked down for 10 minutes, and routing lets the built-in tool through until then.

## Shared servers

Each session runs a thin forwarder per server. `context7`, `semble`, `web-search` and `web-fetch` share one backend per machine:

- the first real call starts the backend,
- a session with no call for 10 minutes lets go of it,
- the backend stops 60 seconds after its last session ends.

`chrome-devtools` starts on its first call and stops after 10 idle minutes. `buracle config set mcp.shared false` gives every session its own copy of each server again.

## Manage the servers

| Command | What it does |
|---|---|
| `buracle mcp list` | Every server, its state in each harness and the command that starts it |
| `buracle mcp status` | Every running Buracle Stack MCP process, with its role, sessions, memory and uptime |
| `buracle mcp disable <id>` | Turns a server off in every harness, or in one with `--harness <h>` |
| `buracle mcp enable <id>` | Turns it on again, the same way |
| `buracle mcp stop [<id>]` | Stops the shared backends now. The next call starts them again |

After `disable`, the harness's next session lists none of the server's tools, and routing allows the built-in tool it stood in for.

## The context7 key

`context7` answers more requests with an API key from [context7.com/dashboard](https://context7.com/dashboard). Pipe it in, so it stays out of your shell history:

```sh
pbpaste | buracle mcp key context7
```

On Linux, use `wl-paste` or `xclip -o` in place of `pbpaste`. The key goes into `~/.buracle/secrets/mcp-keys.json`, which only your user can read. A `CONTEXT7_API_KEY` in a session's environment wins over the stored key. `buracle mcp key` shows where each key comes from, and `buracle mcp key context7 --clear` removes the stored one.

## Code indexes

`codegraph` and `semble` read an index of the project. When the codegraph server starts in a project without an index, it starts a build and waits up to 4 seconds for it. While the server runs, it keeps the index current. In a folder that holds several projects, the agent runs `buracle index ensure --cwd <project>` for the one it works on.

| Command | What it does |
|---|---|
| `buracle index status` | Shows the state of the project's indexes and the last error |
| `buracle index ensure` | Builds what is missing and refreshes what exists |
| `buracle index rebuild` | Builds the codegraph index from scratch |

Your home folder, `~/.buracle` and the folders in `index.exclude` are never indexed.

## Toolchain

The toolchain also brings `rg`, `ast-grep`, `jq`, `gh`, `tmux`, `ruff`, `shellcheck`, `golangci-lint` and the six language servers:

| Language server | Language | Needs |
|---|---|---|
| pyright | Python | |
| typescript-language-server | TypeScript and JavaScript | |
| gopls | Go | Go |
| rust-analyzer | Rust | A Rust toolchain (cargo) |
| csharp-ls | C# | The .NET SDK |
| jdtls | Java | Java 21 or newer |

Claude Code and Oh My Pi run these servers through their own LSP support. Codex and OpenCode reach them through the `lsp` MCP server. Qwen Code, Pi and AGY CLI get no language servers. `buracle lsp check` starts each server and runs its handshake.

## Checks after each edit

After an edit, the matching checker runs and its findings go back to the agent: ruff for Python, eslint for TypeScript and JavaScript, go vet, gofmt and golangci-lint for Go, shellcheck for shell scripts and `dotnet format` for C#. Each checker uses the project's own config. A checker that is not installed is named once per session, with how to install it. `buracle config set checkers.enabled false` turns the checks off, and `checkers.languages` picks the languages.

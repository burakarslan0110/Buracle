# Logo and source manifest

Logos and facts for the Buracle Stack launch site and video. `SOURCES.json` holds the same data. Every SVG was parsed, sanitized (no scripts, no event attributes, no remote references, embedded rasters at most 200 KB) and normalized to a natural `viewBox` without `width` or `height`. A `-mono.svg` file paints with `currentColor`.

## Trademarks

The logos identify the products Buracle Stack works with. Every mark belongs to its owner. Showing a mark does not mean the owner endorses or sponsors Buracle Stack. Use each mark unchanged, at a readable size, next to the product's name, and follow the owner's brand guidelines where one is linked. The Simple Icons and Lobe Icons licenses cover only the path data, not the trademark.

## Logos

| id | Name | Kind | Logo | Mono | On a dark page | Logo source | Logo license | Project license |
|---|---|---|---|---|---|---|---|---|
| `claude-code` | Claude Code | harness | `claude-code.svg` | `claude-code-mono.svg` | visible as is | [link](https://github.com/simple-icons/simple-icons/blob/develop/icons/claudecode.svg) | CC0-1.0 path data via Simple Icons (source code.claude.com); trademark of Anthropic PBC | Proprietary (© Anthropic PBC, Commercial Terms of Service) |
| `codex` | Codex CLI | harness | `codex.svg` | `codex-mono.svg` | visible as is | [link](https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.103.0/icons/codex-color.svg) | MIT via Lobe Icons (@lobehub/icons-static-svg 1.103.0); Codex and OpenAI are trademarks of OpenAI | Apache-2.0 |
| `opencode` | OpenCode | harness | `opencode.svg` | `opencode-mono.svg` | visible (white mark on its own dark tile) | [link](https://github.com/anomalyco/opencode/blob/dev/packages/identity/mark.svg) | From the project repository (MIT); the mono file is the same mark as Simple Icons path data (CC0); trademark of its owners | MIT |
| `oh-my-pi` | Oh My Pi (omp) | harness | `oh-my-pi.svg` | `oh-my-pi-mono.svg` | visible as is | [link](https://omp.sh/favicon.svg) | From the project site; identical to packages/collab-web/public/favicon.svg in the MIT repository; mark of its owners | MIT |
| `qwen-code` | Qwen Code | harness | `qwen-code.svg` | `qwen-code-mono.svg` | visible but dim (#082DFF blue on near-black); use mono on very dark backgrounds | [link](https://github.com/QwenLM/qwen-code/blob/main/packages/desktop/bootstrap/qwen-code-logo.svg) | From the project repository (Apache-2.0); Qwen is a trademark of Alibaba Cloud | Apache-2.0 |
| `pi` | Pi | harness | `pi.svg` | `pi-mono.svg` | visible as is | [link](https://pi.dev/logo-auto.svg) | From the project site (the logo the MIT repository's README embeds); mark of Earendil Works | MIT |
| `agy` | AGY CLI (Google Antigravity) | harness | `agy.svg` | `agy-mono.svg` | visible as is | [link](https://antigravity.google/favicon.svg) | From the official site favicon, with its light/dark background disc removed; mono file via Lobe Icons (MIT); Antigravity is a trademark of Google LLC | Proprietary (Google) |
| `context7` | Context7 | mcp | `context7.svg` | `context7-mono.svg` | glyph visible; the black tile blends in. Use context7-wordmark-dark.svg for a wordmark on dark | [link](https://github.com/upstash/context7/blob/master/public/context7-icon.svg) | From the project repository (MIT); Context7 and Upstash are trademarks of Upstash, Inc. | MIT |
| `codegraph` | CodeGraph | mcp | `codegraph.svg` | `codegraph-mono.svg` | NOT visible (dark strokes); use codegraph-mono.svg | [link](https://github.com/colbymchenry/codegraph/blob/main/site/public/favicon.svg) | From the project repository (MIT; same file as the site favicon); mark of its author | MIT |
| `semble` | Semble | mcp | `semble.svg` | – | visible (raster illustration) | [link](https://github.com/MinishLab/semble/blob/main/assets/images/semble_logo.png) | From the project repository (MIT); raster logo downscaled to 320 px and wrapped in SVG (no vector original exists); mark of MinishLab | MIT |
| `open-websearch` | Open-WebSearch | mcp | none | – | n/a | – | No logo: the repository has none and its site (open-web-search.vercel.app) answered HTTP 402 | Apache-2.0 |
| `fetcher-mcp` | Fetcher MCP | mcp | `fetcher-mcp.svg` | – | visible as is | [link](https://github.com/jae-jae/fetcher-mcp/blob/main/icon.svg) | From the project repository (MIT); mark of its author | MIT (GitHub; the npm manifest says ISC) |
| `grep-app` | Grep by Vercel (grep.app MCP) | mcp | `grep-app.svg` | `grep-app-mono.svg` | NOT visible (black stroke); use grep-app-mono.svg | [link](https://grep.app) | Mark (rounded frame and cursor) cut from the inline header SVG of grep.app, wordmark left out; no license stated; Grep and Vercel are trademarks of Vercel Inc. | Proprietary hosted service (Vercel); MCP endpoint https://mcp.grep.app |
| `chrome-devtools-mcp` | Chrome DevTools MCP | mcp | `chrome-devtools-mcp.svg` | – | visible as is | [link](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/Images/src/devtools.svg) | DevTools icon from the devtools-frontend repository (BSD-3-Clause); Chrome and Chrome DevTools are trademarks of Google LLC | Apache-2.0 |
| `cortexdb` | CortexDB | engine | `cortexdb.svg` | – | visible (own dark tile) | [link](https://github.com/liliang-cn/cortexdb/blob/main/docs/favicon.svg) | From the project repository (MIT; same file as the docs site favicon); mark of its author | MIT |
| `bun` | Bun | runtime | `bun.svg` | – | visible as is | [link](https://bun.com/logo.svg) | From the official site (press kit at https://bun.com/press-kit); trademark of Oven | MIT |
| `nodejs` | Node.js | runtime | `nodejs.svg` | `nodejs-mono.svg` | visible as is | [link](https://github.com/nodejs/nodejs.org/blob/main/apps/site/public/static/logos/jsIconGreen.svg) | From the nodejs.org repository; Node.js is a trademark of the OpenJS Foundation (see nodejs.org/about/branding) | MIT |
| `uv` | uv | runtime | `uv.svg` | `uv-mono.svg` | visible as is | [link](https://github.com/astral-sh/uv/blob/main/docs/assets/logo-letter.svg) | From the project repository (Apache-2.0 OR MIT); trademark of Astral Software | Apache-2.0 OR MIT |
| `ripgrep` | ripgrep | tool | none | – | n/a | – | No logo: the project has no official mark | Unlicense OR MIT |
| `ast-grep` | ast-grep | tool | `ast-grep.svg` | `ast-grep-mono.svg` | dim (#2f4f6d on near-black); use ast-grep-mono.svg | [link](https://github.com/ast-grep/ast-grep.github.io/blob/main/website/public/favicon.svg) | From the project website repository (MIT); mark of its authors | MIT |
| `jq` | jq | tool | `jq.svg` | `jq-mono.svg` | NOT visible (dark gray); use jq-mono.svg | [link](https://github.com/jqlang/jq/blob/master/docs/public/icon.svg) | From the project repository (MIT); the site's dark-mode invert style was removed | MIT |
| `github-cli` | GitHub CLI | tool | `github-cli.svg` | `github-cli-mono.svg` | NOT visible (#181717); use github-cli-mono.svg | [link](https://github.com/simple-icons/simple-icons/blob/develop/icons/github.svg) | CC0-1.0 path data via Simple Icons (source github.com/logos); GitHub and the Invertocat are trademarks of GitHub, Inc. | MIT |
| `ruff` | Ruff | tool | `ruff.svg` | `ruff-mono.svg` | visible as is | [link](https://github.com/simple-icons/simple-icons/blob/develop/icons/ruff.svg) | CC0-1.0 path data via Simple Icons (source astral.sh/ruff); trademark of Astral Software | MIT |
| `shellcheck` | ShellCheck | tool | `shellcheck.svg` | – | visible as is | [link](https://github.com/koalaman/shellcheck/blob/master/doc/shellcheck_logo.svg) | From the project repository (GPL-3.0 repository; contains two embedded rasters of 120 KB and 47 KB); mark of its author | GPL-3.0 |
| `golangci-lint` | golangci-lint | tool | `golangci-lint.svg` | – | visible as is | [link](https://github.com/golangci/golangci-lint/blob/main/docs/static/images/logo-circle.svg) | From the project repository (GPL-3.0 repository); the site uses logo-nocircle.svg in dark mode | GPL-3.0 |
| `tmux` | tmux | tool | `tmux.svg` | `tmux-mono.svg` | visible (dark gray screen is faint); mono also available | [link](https://github.com/tmux/tmux/blob/master/logo/tmux-logomark.svg) | From the project repository, logo/LICENSE (ISC, © 2015 Jason Long); mono file via Simple Icons (CC0) | ISC |
| `pyright` | Pyright (Python) | lsp | `pyright.svg` | `pyright-mono.svg` | visible as is | [link](https://www.python.org/community/logos/) | Python logo from python.org (python-logo-only.svg); Pyright has no logo of its own; Python is a trademark of the PSF (PSF Trademark Usage Policy); mono via Simple Icons (CC0) | MIT |
| `typescript` | TypeScript (typescript-language-server) | lsp | `typescript.svg` | `typescript-mono.svg` | visible as is | [link](https://www.typescriptlang.org/branding/) | ts-logo-512.svg from the official TypeScript design assets; trademark of Microsoft; mono via Simple Icons (CC0) | Apache-2.0 |
| `go` | Go (gopls) | lsp | `go.svg` | `go-mono.svg` | visible as is | [link](https://go.dev/images/go-logo-blue.svg) | From go.dev; the Go logo is a trademark of Google LLC (see go.dev/brand) | BSD-3-Clause |
| `rust` | Rust (rust-analyzer) | lsp | `rust.svg` | `rust-mono.svg` | NOT visible (black); use rust-mono.svg | [link](https://github.com/simple-icons/simple-icons/blob/develop/icons/rust.svg) | CC-BY-SA-4.0 path data via Simple Icons; Rust is a trademark of the Rust Foundation (Rust media guide) | MIT OR Apache-2.0 |
| `csharp` | C# (csharp-ls) | lsp | `csharp.svg` | – | visible as is | [link](https://github.com/dotnet/brand/blob/main/logo/language-icons/csharp-72.svg) | From the dotnet/brand repository (CC0-1.0); C# and .NET are trademarks of Microsoft | MIT |
| `java` | Java (Eclipse JDT LS) | lsp | `java.svg` | `java-mono.svg` | NOT visible (black); use java-mono.svg | [link](https://github.com/simple-icons/simple-icons/blob/develop/icons/openjdk.svg) | BSD-3-Clause path data via Simple Icons (OpenJDK Duke); the Java cup logo is an Oracle trademark and is not used; Java and OpenJDK are trademarks of Oracle | EPL-2.0 |

## Projects

| id | What it is | How Buracle Stack uses it | Links |
|---|---|---|---|
| `claude-code` | Anthropic's agentic coding tool for the terminal, IDE and desktop. | Target harness: Buracle Stack ships a Claude Code plugin with skills, rules, agents, MCP servers, command hooks and a status line. | [home](https://code.claude.com/docs/en/overview) · [repo](https://github.com/anthropics/claude-code) |
| `codex` | OpenAI's lightweight coding agent that runs locally in the terminal. | Target harness: AGENTS.md rules, skills, MCP servers, command hooks and an optional tmux status line. | [home](https://developers.openai.com/codex) · [repo](https://github.com/openai/codex) |
| `opencode` | Open-source terminal coding agent that works with models from many providers. | Target harness: rules, skills, MCP servers and an in-process plugin that runs the shared hook pipeline. | [home](https://opencode.ai) · [repo](https://github.com/anomalyco/opencode) |
| `oh-my-pi` | Terminal coding agent with subagents, plan mode, LSP and DAP built in. | Target harness: rules, skills, MCP servers and an in-process extension that runs the shared hook pipeline. | [home](https://omp.sh) · [repo](https://github.com/can1357/oh-my-pi) |
| `qwen-code` | Open-source AI coding agent for the terminal from the Qwen team. | Target harness: QWEN.md rules block, path rules, skills, review agents, commands, MCP servers and command hooks. | [home](https://qwenlm.github.io/qwen-code-docs/en/users/overview) · [repo](https://github.com/QwenLM/qwen-code) |
| `pi` | Minimal terminal coding agent built on a unified LLM API and agent toolkit. | Target harness: AGENTS.md rules block, path rules, skills, MCP servers and an in-process extension for the hooks. | [home](https://pi.dev) · [repo](https://github.com/earendil-works/pi) |
| `agy` | Google's agent-first development platform; AGY CLI is its terminal agent. | Target harness: rules, skills, MCP servers, a buracle-companion agent and command hooks read from hooks.json. | [home](https://antigravity.google) |
| `context7` | Upstash service that serves current library documentation to AI agents. | MCP server `context7` (@upstash/context7-mcp): up-to-date library and framework docs; routing category library-docs. | [home](https://context7.com) · [repo](https://github.com/upstash/context7) |
| `codegraph` | Local, pre-indexed code knowledge graph that agents query over MCP. | MCP server `codegraph` (@colbymchenry/codegraph, `codegraph serve --mcp`): symbols, callers and impact; also the code graph CLI and index builder. | [home](https://colbymchenry.github.io/codegraph/) · [repo](https://github.com/colbymchenry/codegraph) |
| `semble` | Fast, accurate semantic code search for agents that runs on CPU. | MCP server `semble` (PyPI semble[mcp], installed with uv): semantic code search over local or remote repositories; also the CLI and index builder. | [home](https://minish.ai/packages/semble/introduction/) · [repo](https://github.com/MinishLab/semble) |
| `open-websearch` | Multi-engine web search MCP server, CLI and daemon that needs no API keys. | MCP server `web-search` (npm open-websearch): web search without an API key, DuckDuckGo by default; routing category web-search. | [home](https://github.com/Aas-ee/open-webSearch) · [repo](https://github.com/Aas-ee/open-webSearch) |
| `fetcher-mcp` | MCP server that fetches web pages through a headless Playwright browser. | MCP server `web-fetch` (npm fetcher-mcp): fetch and extract web pages with a headless browser; routing category web-fetch. | [home](https://github.com/jae-jae/fetcher-mcp) · [repo](https://github.com/jae-jae/fetcher-mcp) |
| `grep-app` | Vercel's code search over about a million public GitHub repositories. | Remote HTTP MCP server `grep` (https://mcp.grep.app): real-world usage examples from public GitHub code; routing category code-examples. | [home](https://grep.app) |
| `chrome-devtools-mcp` | Gives coding agents a live Chrome browser through DevTools. | MCP server `chrome-devtools` (npm chrome-devtools-mcp, isolated profile, no usage statistics): drive and inspect Chrome; every harness except Oh My Pi. | [home](https://developer.chrome.com/docs/devtools/agents) · [repo](https://github.com/ChromeDevTools/chrome-devtools-mcp) |
| `cortexdb` | Local-first agent memory with a knowledge graph in one SQLite file. | The memory engine: one brain.db with a bucket per project and one for the person, served to every harness by the buracle-memory MCP server. | [home](https://liliang-cn.github.io/cortexdb/) · [repo](https://github.com/liliang-cn/cortexdb) |
| `bun` | Fast all-in-one JavaScript runtime, bundler, test runner and package manager. | Buracle Stack runtime (required). | [home](https://bun.com) · [repo](https://github.com/oven-sh/bun) |
| `nodejs` | JavaScript runtime built on V8. | Runs the npm MCP servers and language servers of the toolchain (required). | [home](https://nodejs.org) · [repo](https://github.com/nodejs/node) |
| `uv` | Very fast Python package and project manager written in Rust. | Installs the PyPI MCP servers of the toolchain (semble) on Python 3.12 (required). | [home](https://docs.astral.sh/uv) · [repo](https://github.com/astral-sh/uv) |
| `ripgrep` | Recursive regex search that respects .gitignore. | Exhaustive exact-match search (rg, required). | [home](https://github.com/BurntSushi/ripgrep) · [repo](https://github.com/BurntSushi/ripgrep) |
| `ast-grep` | CLI for structural code search, lint and rewriting, written in Rust. | Structural code search and rewrite (optional). | [home](https://ast-grep.github.io) · [repo](https://github.com/ast-grep/ast-grep) |
| `jq` | Command-line JSON processor. | JSON processing in skills and scripts (required). | [home](https://jqlang.org) · [repo](https://github.com/jqlang/jq) |
| `github-cli` | GitHub's official command-line tool. | GitHub pull requests and issues (gh, optional). | [home](https://cli.github.com) · [repo](https://github.com/cli/cli) |
| `ruff` | Very fast Python linter and formatter written in Rust. | Python linter the file checks (H04) run in projects that configure ruff (optional). | [home](https://docs.astral.sh/ruff) · [repo](https://github.com/astral-sh/ruff) |
| `shellcheck` | Static analysis tool for shell scripts. | Shell script linter the file checks (H04) run on .sh and .bash files (optional). | [home](https://www.shellcheck.net) · [repo](https://github.com/koalaman/shellcheck) |
| `golangci-lint` | Fast runner for many Go linters. | Go linter the file checks (H04) run in projects with a .golangci config (optional). | [home](https://golangci-lint.run) · [repo](https://github.com/golangci/golangci-lint) |
| `tmux` | Terminal multiplexer. | Extra status line for Codex and OpenCode (optional, macOS and Linux). | [home](https://github.com/tmux/tmux) · [repo](https://github.com/tmux/tmux) |
| `pyright` | Microsoft's static type checker and language server for Python. | Python language server (pyright-langserver, required). | [home](https://github.com/microsoft/pyright) · [repo](https://github.com/microsoft/pyright) |
| `typescript` | Language server for TypeScript and JavaScript that wraps tsserver. | TypeScript and JavaScript language server (required, installed with typescript@6). | [home](https://www.typescriptlang.org) · [repo](https://github.com/typescript-language-server/typescript-language-server) |
| `go` | The official Go language server. | Go language server (optional; needs Go). | [home](https://go.dev/gopls) · [repo](https://github.com/golang/tools) |
| `rust` | Rust compiler front-end for IDEs. | Rust language server (optional; needs a Rust toolchain). | [home](https://rust-analyzer.github.io) · [repo](https://github.com/rust-lang/rust-analyzer) |
| `csharp` | Roslyn-based language server for C#. | C# language server (optional; needs the .NET SDK). | [home](https://www.nuget.org/packages/csharp-ls/) · [repo](https://github.com/razzmatazz/csharp-language-server) |
| `java` | Eclipse-based Java language server. | Java language server (optional; needs Java 21 or newer). | [home](https://github.com/eclipse-jdtls/eclipse.jdt.ls) · [repo](https://github.com/eclipse-jdtls/eclipse.jdt.ls) |

## Key capabilities (MCP servers and the engine)

**Context7**

- Resolves a library name to a Context7 library ID (resolve-library-id)
- Returns current docs and code examples for a library ID (query-docs)
- Accepts a version in the query to pin docs to a release
- Also ships a ctx7 CLI and agent skills that work without MCP

**CodeGraph**

- One explore call returns the relevant symbols' source and the call paths between them
- Callers, callees and impact radius of a symbol before an edit
- Full-text symbol search backed by SQLite FTS5
- File watcher keeps the index in sync as code changes
- Rust parsing kernel covering 20+ languages, fully local

**Semble**

- Indexes a typical repo in about half a second and answers in milliseconds on CPU
- Returns only the relevant chunks, far fewer tokens than grep plus read
- Searches local paths, git URLs or several repos together
- Finds code similar to a known location (find_related)
- No API keys, GPU or external service needed

**Open-WebSearch**

- Searches many engines: DuckDuckGo, Bing, Brave, Exa, Startpage, Baidu and others
- No API keys or sign-in required
- Structured results with title, URL and description
- Fetches article content (GitHub READMEs, CSDN, Juejin, generic pages as Markdown)
- HTTP proxy support and a long-lived local daemon

**Fetcher MCP**

- Renders JavaScript-heavy pages in headless Chromium via Playwright
- Extracts the main content with the Readability algorithm
- Returns Markdown, HTML or plain visible text
- Fetches many URLs in parallel (fetch_urls)
- Blocks images, fonts and media to save bandwidth

**Grep by Vercel (grep.app MCP)**

- Searches about a million public GitHub repositories
- Literal text or regular-expression queries
- Filters by language, repository and file path
- Returns ranked code snippets in a fraction of a second

**Chrome DevTools MCP**

- Records performance traces and turns them into actionable insights
- Inspects network requests and console messages with source-mapped stacks
- Takes screenshots and page snapshots
- Automates clicks, typing and navigation with Puppeteer and waits for results

**CortexDB**

- Stores preferences, decisions and project facts and recalls them before the next prompt
- Everything lives in one SQLite file on the local machine
- Knowledge graph with ontology constraints, inference and history (SPARQL, Cypher)
- Works without an embedding model; one can be added for semantic search
- Live web view of the graph, recalls and changes; a gRPC server can share one brain

## Extra files

- `context7`: `context7-wordmark-light.svg`, `context7-wordmark-dark.svg`
- `ast-grep`: `ast-grep-wordmark.svg`
- `golangci-lint`: `golangci-lint-nocircle.svg`

## Contact sheets

`logos-dark.png` (#05060a) and `logos-light.png` (#f4f5f9) show each logo in its original colors (left) and its mono file (right).

---
name: reviewer
description: >-
  Read-only reviewer for the golden test. Launch it from {{skill:alpha}} after implementation.
access: read-only
tools: [read, search, bash-readonly, mcp:docs, mcp:codex-only]
model: { claude: sonnet, codex: inherit, opencode: inherit, omp: inherit }
output: json
---
You review changes. Ask nothing; use {{ask_user}} never.

Return only JSON.

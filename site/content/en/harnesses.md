---
title: Harnesses
description: What each of the seven harnesses gets, its commands and plan mode, the events behind the hooks, the recorded host limits and the minimum versions.
order: 8
---

All seven harnesses get the same 26 hooks, the same skills, the same memory and the same guards. They differ in how Buracle Stack plugs into each one and in what the host lets a plugin do.

## What each harness gets

| Harness | Plugs in as | Skills | Status and progress | Tips | Hard-to-undo commands |
|---|---|---|---|---|---|
| Claude Code | A plugin with a mod | The plugin's own copy | Band, panes, status line | Spinner | Claude Code dialog |
| Codex CLI | `hooks.json`, `config.toml`, an `AGENTS.md` block, exec-policy rules | `~/.agents/skills` | Native items, one-line notices | None | Codex's approval prompt |
| OpenCode | Server and TUI plugins | `~/.agents/skills` | Band, footer | Home screen | TUI dialog, question tool |
| Oh My Pi | An omp plugin with an extension | `~/.agents/skills` | Widget, pane, native preset | None | omp's select dialog |
| Qwen Code | Hooks and MCP in `~/.qwen/settings.json`, plus a `QWEN.md` block, path rules, review agents and commands in `~/.qwen` | `~/.agents/skills` | Status line command | Loading phrases | The denial tells the agent what to ask |
| Pi | An extension, an `AGENTS.md` block and MCP in `mcp.json` | `~/.agents/skills` | Widget band, footer | Working message | Pi's select dialog |
| AGY CLI | `hooks.json`, `mcp_config.json` and a `buracle` plugin with rules and review agents, in `~/.gemini/config` | Links in AGY's skills folder | Status line command | None | The denial tells the agent what to ask |

Every harness gets the four always-on rules and the path rules. Every harness except Pi also gets the three review agents (plan-build-review, changes-review and goal-build-review). Pi has no subagents, so its reviews run in the main session.

Buracle Stack switches off the built-in memory of Claude Code, Codex and Oh My Pi, so the shared brain is the only memory.

## Commands per harness

Codex starts a skill with `$` (`$plan-build`), Pi with `/skill:` (`/skill:plan-build`) and every other harness with `/`. Four utility commands run without a model turn where the host allows it:

| Command | Claude Code | Codex CLI | OpenCode | Oh My Pi | Qwen Code | Pi | AGY CLI |
|---|---|---|---|---|---|---|---|
| `/brain` | Yes | `buracle mem ui --open` | Yes | Yes | Yes | Yes | `buracle mem ui --open` |
| `/remember` | Yes | `buracle mem remember` | Yes | Yes | Yes | Yes | `buracle mem remember` |
| `/aside` | Yes | Codex's `/side` | Yes | Yes | Qwen Code's `/btw` | None | Ask in the chat |
| `/buracle-status` | Yes | `buracle plan status`, `buracle mem status` | Yes | Yes | Yes | `buracle plan status`, `buracle mem status` | `buracle plan status`, `buracle mem status` |

In Codex and AGY CLI the rules teach the agent these commands, so you can type `/remember <text>` and the agent runs the CLI twin.

## Plan mode

| Harness | What happens to a plan from its plan mode |
|---|---|
| Claude Code | Saved to `docs/plan-build/` when you approve it |
| Codex CLI | Saved when you choose to implement it |
| OpenCode | Saved as a draft when the session leaves the plan agent, because OpenCode has no approval step |
| Oh My Pi | Saved when you approve it |
| Qwen Code | Saved when you approve it |
| Pi | Pi has no plan mode |
| AGY CLI | AGY has a plan mode (`--mode plan`) but no approval step the hooks can see |

With `plan.nativePlanMode` set to `on`, plan-build plans a feature inside the harness's plan mode, and leaving it with an approval approves the plan.

## The seven events

Every harness maps its native hooks onto the same seven events, and one shared pipeline decides what each hook does:

| Event | When |
|---|---|
| Session start | A session opens |
| Prompt | You send a message |
| Before a tool | Before each tool call (the guards run here) |
| After a tool | After each tool call (masking and the checks after an edit run here) |
| Stop | The agent is about to end its turn (the stop guard runs here) |
| Before compaction | Before the conversation is compacted |
| Session end | A session closes (the memory capture runs here) |

AGY CLI has no compaction event and no session-end event. Its memory context comes in at session start and its capture runs at every stop.

## Host limits

Where a host lacks something Buracle Stack needs, [`src/adapters/shared/host-limits.ts`](https://github.com/burakarslan0110/Buracle-Stack/blob/main/src/adapters/shared/host-limits.ts) records it with the fallback. `buracle doctor <harness> --all` lists the records for one harness.

| Record | Harness | What the host lacks | Fallback |
|---|---|---|---|
| `codex.consent-dialog` | Codex | A hook cannot ask the user, and `codex exec`, `--yolo` and `-a never` show no approval prompt | The denial tells the agent what to ask |
| `codex.background-wait` | Codex | Nothing wakes a turn when a background command ends | The stop guard holds the turn |
| `codex.quiet-stop-feedback` | Codex | A Stop hook continues a turn only with a block | The stop guard's reason goes in that prompt |
| `codex.commands-without-turn` | Codex | No custom slash commands | `$memory`, the CLI twins and Codex's `/side` |
| `codex.live-exec-mask` | Codex | `write_stdin` polls of a running command reach no hook | Every completed shell and MCP result is masked |
| `codex.failed-mcp-mask` | Codex | PostToolUse runs only for a successful call | Every successful result is masked |
| `codex.live-panes` | Codex | Hooks get no pane, widget or dialog | `buracle mem status`, `buracle plan status` and one-line notices (`workflow.codexNotices`) |
| `codex.custom-status-line` | Codex | The footer shows only Codex's own items | Buracle Stack picks the native items |
| `codex.summary-keep-list` | Codex | Remote compaction ignores `compact_prompt` | The handoff memory carries the state |
| `opencode.consent-dialog` | OpenCode | The dialog needs the TUI plugin, which web, desktop, the API and `opencode run` do not load | The denial tells the agent to ask with the `question` tool |
| `opencode.approved-plan-capture` | OpenCode | The plan agent has no approval tool or event | A draft plan when the session leaves the plan agent |
| `opencode.native-plan-approval` | OpenCode | Leaving the plan agent is no approval | The plan is filled in as a draft and plan-build asks you to approve it |
| `opencode.goal-command` | OpenCode | No native goal command | The goal-build brief states the condition first |
| `opencode.quiet-stop-feedback` | OpenCode | No plugin hook runs before a session stops | A capped re-prompt after the session stops |
| `opencode.stop-veto` | OpenCode | No hook can hold a session that is about to stop | A capped re-prompt after the session stops |
| `opencode.subagent-stop-hold` | OpenCode | No subagent-stop hook | A note asks the agent to continue the reviewer once |
| `opencode.rate-windows` | OpenCode | No quota API, so the usage windows come from response headers | The 5-hour and 7-day segments stay empty until a response carries them |
| `omp.companion-shell` | Oh My Pi | Print mode cannot hold bash to read-only commands | The second opinion gets read, grep and glob only |
| `qwen.readonly-shell` | Qwen Code | Tool lists name tools, not command patterns, so the shell cannot be held to read-only commands | The second opinion gets read, grep, glob and list tools only, and review agents run under the guard hooks |
| `agy.no-compaction-event` | AGY CLI | No event before or after compaction | The memory context comes in at session start, and the context size is watched before each model call |
| `agy.commands-without-turn` | AGY CLI | No custom command runs without a model turn | Workflows are `/<id>` skills, and the rules name the CLI twins of `/remember`, `/brain`, `/aside` and `/buracle-status` |
| `agy.no-subagent-result` | AGY CLI | A hook gets no subagent result, so there is no review report check (H19) | The review steps check the report themselves |
| `agy.no-session-end` | AGY CLI | No end-of-conversation event, only a Stop per turn | The memory is captured at every Stop |
| `pi.no-subagents` | Pi | No subagent tool, so no review agents | No agents are installed, H19 is not bound and reviews run in the main session |
| `pi.no-path-rules` | Pi | No rule scoped to file paths | The `AGENTS.md` block names the rules and H03 hands one over at the first edit of a matching file |

## Minimum versions

Below these versions `buracle doctor` reports an error, and the install skips the harness or the step that needs the newer version. A Codex older than its minimum is left alone, because it could not load the config Buracle Stack writes.

| Claude Code | Codex CLI | OpenCode | Oh My Pi | Qwen Code | Pi | AGY CLI |
|---|---|---|---|---|---|---|
| 2.1.290 | 0.154.0 | 2.0.20 | 18.8.0 | 0.26.1 | 1.5.2 | 1.5.9 |

The list lives in [`src/engine/update/min-versions.ts`](https://github.com/burakarslan0110/Buracle-Stack/blob/main/src/engine/update/min-versions.ts).

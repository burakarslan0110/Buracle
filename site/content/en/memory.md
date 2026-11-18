---
title: Memory
description: How the shared memory works, what a session loads and saves, how backups work and how to keep things out of it.
order: 4
---

Every harness shares one memory. It is one [CortexDB](https://github.com/liliang-cn/cortexdb) file, `~/.buracle/brain/brain.db`, with a bucket for each project and one for you, the person brain. Each harness reaches it through the `buracle-memory` MCP server, and a session sees only the current project's bucket and yours. A decision saved in Codex is there when you open the same project in Claude Code.

## What a session starts with

When a session starts, the agent gets:

- your preferences from the person brain,
- the most important memories of the project,
- a handoff, when work on the same branch was cut off in the last 24 hours,
- a health line when something in the memory is wrong.

Building this start text only reads the memory. It starts no process and writes nothing.

## What gets saved

- A preference you state as a lasting rule ("always", "never", "from now on") is saved at once, in your words.
- Before the harness compacts a conversation, the plan and todo state go into a handoff memory, so the next turn can pick up the work.
- When a session ends, one `buracle mem finalize` run writes the session memory. It then asks the model of the harness you used for the decisions, gotchas, procedures and preferences worth keeping.
- Confident findings are stored as inferred memories, and the rest wait as captures to be filed later. A finding never changes a memory you wrote: it is stored beside it and marked as contradicting.
- `/remember <text>` saves a capture by hand.

`buracle mem capture` does the session-end work on demand, and `buracle mem doctor` lists sessions whose capture is still owed. Nothing else runs in the background.

## The memory graph

The memories are linked to each other and to your code, so the memory is a graph as well as a list. Each memory links to the files it cites in `sources`, to the topics in its `about` field and to its tags. It also links to other memories: the one it replaces (supersedes), one it disagrees with and was stored beside (contradicts), one whose id it names, and memories whose text is close enough to count as similar.

Agents use these links when they search:

| Search | What it finds |
|---|---|
| `memory_search` with `files: ["src/billing/total.ts"]` | Every memory that cites the file or its folder, with no query needed |
| `memory_search` with `about: ["CortexDB"]` | Memories about a topic, and memories linked to it even when their words differ |
| `memory_search` with `around: <id>` | What the same brain recorded just before and just after a memory |

The [Console](console.md) draws the same graph. Press `G` for the network view, or open a region with `1` to `7`: its memories appear with the files, tags and topics they share, plus the memories of other regions they link to. A node grows with the memory's importance and with how often agents recalled it.

## How long memories last

| Memory | Kept |
|---|---|
| Session memories | 45 days |
| Handoffs | 14 days |
| Decisions, gotchas, procedures, knowledge, preferences | Until you retire or delete them |

You can edit, retire, restore or delete any memory in the [Console](console.md).

## Backups

- `buracle mem backup` copies the whole brain file into `~/.buracle/brain/backups/<id>/` and keeps the newest 10 copies.
- When a session ends and the newest backup is more than a day old, one more copy is taken.
- `buracle mem backup --list` shows the backups, newest first, with the buckets each one holds.
- `buracle mem restore <id> --all` puts the whole file back. `--project <slug>` or `--person` restores one bucket and leaves the others alone.

A restore first saves the current brain as a backup of its own. The brain stays on your machine and nothing is synced.

## Model calls and usage limits

The session-end capture uses the CLI of a harness you already have, so it needs no API key and calls no external API. The session's own harness goes first, then another harness you used this week. A harness is used only while its 5-hour usage is under 75% and its weekly usage is under 85%. When the model fails, hits a rate limit or returns an invalid answer, nothing is written.

## Privacy

- Keys, tokens and passwords are masked before anything is written.
- Text inside `<private>...</private>` is never stored.
- Projects listed in `memory.exclude` are never captured or recalled. The list takes absolute or `~` paths, globs, bare folder names or the `owner/repo` of the `origin` remote. Your person memory still applies there.
- With `BURACLE_NO_CAPTURE=1` in a harness's environment, its sessions record nothing.

```sh
buracle config set memory.exclude '[~/work/client-project]'
```

## Memory from the command line

Each of the six memory tools has a CLI twin, so you and every harness can reach the memory from a terminal.

| MCP tool | CLI twin |
|---|---|
| `memory_search` | `buracle mem search "<query>"` |
| `memory_get` | `buracle mem get <id>` |
| `memory_write` | `buracle mem write --type <kind> --title "<claim>" --summary "<one line>"` |
| `memory_update` | `buracle mem update <id> --patch '<json>'` |
| `memory_status` | `buracle mem status` |
| `memory_context` | `buracle mem context` |

`buracle mem --help` lists the rest: `remember`, `capture`, `backup`, `restore`, `doctor` and `ui`.

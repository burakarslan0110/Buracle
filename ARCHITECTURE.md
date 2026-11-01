# Buracle architecture: audit and target design

This document records why Buracle's memory was simplified in 0.6 and what the result looks like. Part 1 is the
audit of 0.5.0, with numbers measured on macOS (Apple silicon, Bun 1.4.3) against a real CortexDB 2.139.0 binary.
Part 2 is the target architecture and the reason for every component that was removed or kept. The harness and
platform matrix is in [COMPATIBILITY.md](COMPATIBILITY.md); upgrading and rolling back is in
[MIGRATION.md](MIGRATION.md).

## Part 1: audit of 0.5.0

### What a terminal cost

One memory-enabled session (`buracle mcp memory`) held three processes: the Bun MCP server plus one CortexDB
child for the project brain and one for the person brain. Four parallel sessions held twelve processes. The memory
UI server was a fourth, machine-wide process: 61 MB idle, 135 MB after the first embedding request, because it
loaded the bundled static embedding model (105,879 rows by 256 dimensions) and served it to CortexDB over
`POST /v1/embeddings`. Memory reads and writes therefore depended on a resident UI process whenever the model
was installed.

| Measurement (0.5.0) | Value |
| --- | --- |
| Processes, 1 session / 4 sessions | 3 / 12 |
| RSS, 1 session / 4 sessions (32-memory brain) | 173-192 MB / 495-565 MB |
| UI server RSS, idle / after the first embedding | 61 MB / 135 MB |
| PreToolUse hook, median wall time / peak RSS | 51 ms / 52 MB |
| `buracle --version`, median / peak RSS | 12 ms / 16.5 MB |
| Runtime / development dependencies | 2 / 2 (7 packages, 32 MB in `node_modules`) |
| Embedding model download / on disk | 108 MB / 27 MB |

### Where the weight came from

1. **A background-maintenance layer** that CortexDB makes unnecessary. Session start launched four detached Bun
   processes (a kick, a UI server, an index run and a sweep) plus seven git calls. The first prompt of a session
   launched a detached tick that opened up to five project brains, distilled queued sessions, ran an LLM
   reflection per brain, and spawned verifier and repair jobs. A rate-limited tick parked a process asleep for up
   to six hours. Session end ran another detached chain (profile, distil, reflect twice, verify, tick).
2. **Re-implementations of CortexDB features.** Buracle called five CortexDB tools (`memory_save`, `memory_get`,
   `memory_list_all`, `memory_search`, `memory_delete`) and used none of its buckets. The layer was a file: one
   database per project plus one for the person. Expiry sweeping, duplicate scanning, re-ranking, recall counting
   and the memory graph were all client-side, over a full listing of the brain (capped at 20,000 rows) on every
   write and every filtered search. CortexDB provides native TTL, supersede, importance, review status, BM25
   ranking with recall counts, and entity/relation graph retrieval.
3. **An embedding subsystem** (model installer, tokenizer, quantised matrix, HTTP route, status and repair
   steps, UI panel) used only to switch a CortexDB search from lexical to hybrid.
4. **Per-event process starts.** Every hook event starts one Bun process (about 50 ms). Parsing the YAML
   configuration cost about 15 ms of it on every event. Every captured tool call added an asynchronous
   process.
5. **An extra always-on MCP server** (Context Mode) per terminal and a detached full-CLI child per captured
   event while it was enabled.

### Cross-platform findings

Confirmed defects: no honest Linux system-tool path (installer advice was Homebrew-only), a Windows `.cmd` shim
that did not fail closed the way the POSIX shim does, plain `rename` for atomic writes on Windows, and POSIX-only
smoke tests. CI ran typecheck, the build check and the tests on three operating systems, but never executed a
generated hook command or MCP entry on any of them. The full list is in [COMPATIBILITY.md](COMPATIBILITY.md).

## Part 2: target architecture

Buracle's memory is now a thin product layer over CortexDB's own structure. Everything CortexDB already does is
left to CortexDB; Buracle keeps only what is specific to coding agents.

### The store

- **One CortexDB file**, `~/.buracle/brain/brain.db`, opened by one `cortexdb-mcp` child per terminal (it was up to
  two). CortexDB runs in its lexical (FTS5, BM25) mode: no embedding model, no vector index, no HTTP endpoint.
- **CortexDB's own buckets** carry the two scopes: the person is scope `user` with user id `person`; a project is
  scope `global` with the project slug as its namespace. `memory_id` is a global key in CortexDB (the same id in
  another namespace overwrites the first row), so Buracle prefixes the stored id in one place, the store gateway:
  `u/<id>` for the person and `p/<slug>/<id>` for a project. Everything above the gateway still sees plain ids.
- **Native fields replace client-side code**: `ttl_seconds` expires sessions (45 days) and handoffs (14 days) inside
  CortexDB instead of a sweep; `supersedes` retires a replaced memory from search; `importance` and `review_status`
  carry the priority and the verified/unverified state; `entities` and `relations` on save, with `entity_names` and
  `retrieval_mode: graph` on search, carry the relationship memory (people, services, decisions, files).
- **Decisions and their history** are ordinary memories of kind `decision` linked by `supersedes`; the older one
  stays readable (status `any`) and is hidden from normal recall.

### What a memory records

Each memory keeps its kind, title, summary, body, tags, cited files, `about` entities, importance, who wrote it
(`author`), and the two fields that separate fact from inference: `origin` (`explicit`: stated by the user, or
written with the CLI by hand; `inferred`: concluded by a model or an agent) and `confidence` (0 to 1; 1 for
explicit statements). Secrets are redacted by one function in every write path (write, update, spool, capture,
export). A new memory starts unverified unless it was verified against the code or a primary source.

### Quality rules

- **Duplicates**: a write that closely matches an existing memory returns the candidates and writes nothing unless
  forced; capture compares titles and appends new evidence to a close match instead of adding a copy.
- **Contradictions**: an inferred write never changes an explicit, pinned or verified memory. It is stored beside the
  protected one, marked as contradicting it, and the tool result says so; only a human (or an explicit update)
  resolves the conflict.
- **Failed inference**: the whole model reply is validated (schema, kinds, lengths, confidence) before any candidate
  is written. A failed, rate-limited or invalid run writes nothing; its retry state lives in the session record, not
  in the brain.

### AI-assisted capture, on demand

```
hooks append redacted events to the session spool          (no model, no process beyond the hook)
        |
session end: one detached, single-flight, bounded `buracle mem finalize`
        |   1. deterministic session memory from the spool (native ttl)
        |   2. explicit preference statements become person memories (origin explicit, confidence 1)
        |   3. one harness-CLI call distils decisions, gotchas, procedures and knowledge (origin inferred)
        |   4. at most three other stale spools are settled, then the child exits
`buracle mem capture` runs the same code path by hand
```

The model call goes through the CLI of a harness that has usage headroom (the session's own first). There is no
local model, no API key and no resident service. Agents write explicit memories directly through the MCP tools
(`memory_write`, `memory_update`) or the CLI twins.

### Processes

| | 0.5.0 | 0.6 |
| --- | --- | --- |
| Per terminal | Bun MCP server + up to 2 CortexDB children | Bun MCP server + 1 CortexDB child |
| Session start | 8 processes spawned: memory kick, UI server, index refresh, repair job, tick, 3 CortexDB readers (3 still running 3 s later) | none |
| Each prompt | a detached tick (first prompt) | none |
| Tool call | hook process + an asynchronous capture process | hook process + the same asynchronous capture |
| Session end | detached chain: profile, distil, 2 reflections, verify, tick | one bounded `mem finalize` |
| Brain web UI | started by sessions, resident, serves embeddings | only when you run `buracle mem ui`; stops by itself |
| Timers | parked wake-up process up to 6 h | none |

### Components removed and kept

| Component | Decision | Why |
| --- | --- | --- |
| Embedding model, installer, `/v1/embeddings`, status and repair steps | removed | CortexDB works lexically; the graph and filters give the structure, and the model cost 27 MB on disk, a 108 MB download and a resident UI process |
| Context Mode server and bridge | removed | one more MCP server and a detached full-CLI child per captured event, for a saving the owner did not need |
| tick, kick, sweep, heal, reflect, verify, settle, curate, evidence, repo scan, jobs log | removed | background upkeep that re-implemented CortexDB features or ran model calls nobody asked for |
| Profile claims store and verification | removed | explicit preferences are now person memories like any other |
| Per-project and per-person database files | replaced by one file with buckets | one child per terminal; CortexDB's own isolation |
| Client-side expiry, supersede bookkeeping, recall counting | replaced by CortexDB fields | native, and they work for every client of the file |
| MCP server, session context, handoff, spool, finalize | kept (shrunk) | the product-specific behaviour |
| Runner and model choice for the harness CLI | kept | the review companion and capture both use them |
| Brain web UI | kept, on demand | browsing, graph, provenance, edit, retire and delete |
| Backup, export, import, vault import | kept | the owner's data must stay portable and recoverable |
| Hook layer per harness | kept, thinner | real lifecycle differences between harnesses need adapters |

### Concurrency

CortexDB opens its file in WAL mode with a 5 s busy timeout, and an in-process queue orders writes; processes meet at
SQLite's lock. Buracle adds a short per-bucket write lock around read-check-write sequences (duplicate check,
supersede), one machine-wide lock around the model call, and an exclusive lock plus resumable marker for the
one-time migration. Limits: a recall updates counters, so two simultaneous recalls can lose one count; a
network-mounted home directory is not supported by SQLite's WAL mode.

### Migration

0.5.0 keeps `brain/person.db` and `brain/projects/<slug>.db`. The first memory command, MCP start, `buracle install`
or `buracle update` on a machine with those files runs the migration described in [MIGRATION.md](MIGRATION.md): it
backs the files up first, copies every memory into the new buckets (idempotent, resumable), verifies the counts, moves
the old files aside instead of deleting them, and removes the obsolete embedding model.

## Part 3: results

### How it was measured

macOS on Apple silicon, Bun 1.4.3, CortexDB 2.139.0, a brain of 32 memories written by Buracle 0.5.0 itself (24 in a
project, 8 for the person). The 0.5.0 numbers come from the untouched 0.5.0 commit and the 0.6 numbers from the final tree,
run back to back on the same machine, which also carried its normal desktop load, so every latency below is a median over
30 interleaved runs (a 0.5.0 run and a 0.6 run alternate, so noise hits both). "RSS" is the resident memory of the Bun
server and its CortexDB children, sampled 3 seconds after a search. The measuring scripts were session-local and are not
part of the repository.

| Measurement | 0.5.0 | 0.6 |
| --- | --- | --- |
| Processes, 1 memory session | 3 | 2 |
| RSS, 1 memory session | 186.6 MB | 139.3 MB |
| Processes, 4 concurrent sessions | 12 | 8 |
| RSS, 4 concurrent sessions | 566.1 MB | 357.9 MB |
| RSS, 4 sessions that each wrote 4 and read 12 memories | 659 MB (12 processes) | 522 MB (8 processes) |
| Brain web UI, idle RSS | 60.4 MB | 33.6 MB |
| Brain web UI, after its first requests | 132.4 MB (the embedder loads) | 36.0 MB |
| Brain file on disk (32 memories) | 1,024 KB | 688 KB |
| Processes a session start spawns / leaves running | 8 / 3 (UI server, repair job, CortexDB reader) | 0 / 0 |
| Other hook events: spawned | PreCompact 1, session end 2 | PreCompact 1 (a CortexDB reader inside the hook for the handoff), session end 2 (the one finalize child and its reader) |
| PreToolUse hook, median / p90 wall time | 54 / 57 ms | 38 / 40 ms |
| PreToolUse hook, peak RSS | 52.4 MB | 39.9 MB |
| PostToolUse hook, median | 49 ms | 33 ms |
| UserPromptSubmit hook, median | 84 ms | 63 ms |
| Claude status line command, median | 49 ms | 45 ms |
| `buracle --version`, median | 11 ms | 11 ms |

The hook gain comes from keeping the YAML parser and the configuration parse off the hook path: an installed machine has
the merged configuration recorded by `buracle install`, and the hook reads that instead. Without the recorded
snapshot a hook falls back to the old parse and costs what it did in 0.5.0.

### Footprint and size

| | 0.5.0 | 0.6 |
| --- | --- | --- |
| Runtime / development dependencies | 2 / 2 | 3 / 2 |
| `node_modules` | 32 MB, 7 packages | 43 MB, 10 packages |
| Embedding model in the toolchain | 27 MB on disk, 108 MB download | none |
| CortexDB binary | 31 MB | 31 MB |
| Source (`src/`) | 99,938 lines, 495 files | 90,333 lines, 459 files |
| Tests | 73,722 lines, 334 files | 67,038 lines, 317 files |
| Hooks defined / MCP servers in the catalog | 28 / 10 | 27 / 9 |
| Modules in the memory folder | 48 | 35 |
| `bun test` | 6,262 pass, 219.6 s | 5,832 pass, about 200 s |

The dependency count did not fall: both runtime dependencies of 0.5.0 (`yaml`, `jsonc-parser`) are still used, and
there was no dependency to remove once the embedder, which was hand-written, went. 0.6 adds a third, `beautiful-mermaid`
(with `elkjs` and `entities`), which draws the diagrams of `buracle diagram` and the review page; that is the 11 MB
`node_modules` grew by. The 0.6 source also gained code (the
migration, the Brain UI edit and relations, the capture rules), so the net reduction is smaller than the deleted
amount. Fewer tests pass than before because the tests of deleted features went with them.

### What was verified, and how

- **Migration** on a brain written by the real 0.5.0 code: every field of all 32 memories equals the 0.5.0 export; a
  second run changes nothing; a migration killed with SIGKILL at 60, 150 and 300 ms (and at twelve other moments in
  the unit-level sweep) resumes to the same result as a clean run; the verified backup is taken first.
- **Concurrency**: four sessions each wrote project and person memories and found all 48 of the others' within the
  run; four sessions writing the same claim at once stored exactly one copy.
- **Brain UI API**: a scripted 35-step sequence on the migrated brain lists memories with scope, provenance, confidence
  and timestamps; returns relations and the graph; corrects (version +1, `origin: explicit`), retires, restores and
  deletes with the next read reflecting each; refuses a missing token, a cross-origin write and a stale version; and the
  server stops with no child left. The same flows were exercised in a real browser (edit, retire, the Health panel,
  a phone-width layout), with no console errors.
- **Spawn census**: each Claude hook event (session start, prompt, tool calls, compaction, stop, session end) was fired with a
  sample payload in an installed sandbox whose project was a copy of this repository, while every process on the machine
  was sampled every 25 ms until 3.5 s after the hook returned. 0.5.0 spawned 8 processes at session start; 0.6 spawns none,
  and its only other spawns are the handoff's CortexDB reader (inside the compaction hook) and, at session end, the one
  finalize child with its reader.
- **Teardown**: closing all sessions leaves no process; the UI server's CortexDB readers exit within 250 ms of a
  SIGTERM; `buracle uninstall` removes 47 changes, stops the UI, leaves `brain.db` untouched and leaves no process.
- **Against the real engine**: the memory tests also run against the real CortexDB binary (`BURACLE_CORTEXDB_SMOKE`):
  651 pass, 0 fail. That run is what exposed that CortexDB 2.139.0 refuses an accepted memory without a reviewer, which
  the fake used by the normal suite had not enforced; both are fixed and the fake now enforces the rule.

### Known limits and remaining work

- Only macOS was executed. Linux and Windows are covered by the CI definition and by portable-API review
  ([COMPATIBILITY.md](COMPATIBILITY.md)); nothing was pushed, so the CI jobs have been parsed, not run.
- A tool call that the capture hook records still costs one short hook process (about 40 ms). Narrowing those hooks, or
  reading the harness transcript once at the end of the session instead, would remove it; it was left alone because it
  changes what the capture sees.
- A session start no longer starts a background index run at all. codegraph brings its own index up to date when its
  server starts (checked: a file added while no server ran was in the index right after the next start), the launcher of
  that server builds the first index of a project that has none, and semble re-indexes when it searches. In a folder that
  holds several projects no server is started for the children, so their indexes are built on demand (`buracle index
  ensure --cwd <project>`, which the context line tells the agent to run), not in the background; the pre-warming of
  semble at session start is gone too, so the first semble search of a session pays for its own indexing.
- The Bun memory server is the largest part of a terminal's memory (it holds the runtime and a cache of the brain's
  listing). It was not tuned.
- The third-party MCP servers (codegraph, semble, context7, the web servers) are untouched and are the heaviest
  processes of a terminal.
- Rows written before 0.6 keep their `expires` date as data: they are hidden when it passes but the engine does not drop
  them. A recall updates counters, so two simultaneous recalls can lose one count.
- CortexDB's behaviour was verified on 2.139.0 only; the first read of a brain in a process lists the whole file
  (capped at 20,000 rows).
- The first commit of this work (Remove Context Mode, embeddings and background maintenance) states its size as "~13k source
  lines and ~25k test lines fewer". Measured against 0.5.0 the net change at that commit was about 11.6k fewer source lines
  and 8.3k fewer test lines; the table above has the final figures.

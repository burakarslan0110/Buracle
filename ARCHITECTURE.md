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
| Session start | 4 detached Bun processes + 7 git calls | none from memory (workspace index runs as before) |
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

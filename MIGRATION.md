# Upgrading from Buracle 0.5 to 0.6

0.6 simplifies the memory: one CortexDB file instead of one per project and one for the person, no embedding model,
no background upkeep, no Context Mode. Your memories move with you. This page tells you what happens to them, how to
check it, how to go back, and which commands and settings changed. The reasons are in
[ARCHITECTURE.md](ARCHITECTURE.md).

## What happens when you upgrade

Run `buracle update` (or install 0.6 the way you installed 0.5). The first thing that reads the memory afterwards
(`buracle install`, `buracle update`, any `buracle mem` command, or the MCP server starting in a session) finds the
0.5 files and migrates them. You do not have to run anything, but you can:

```sh
buracle mem migrate --dry-run   # what would move, per file; changes nothing
buracle mem migrate             # do it now
buracle mem migrate --status    # where it stands
```

The migration is built to be interrupted and run again:

1. **Lock.** One process migrates; others wait up to 5 seconds (`BURACLE_MIGRATE_WAIT_MS`) and then report
   `migrating` instead of reading half-migrated data. A session start prints a short "being migrated" notice.
2. **Backup first.** Every 0.5 file (`brain/person.db`, `brain/projects/*.db`, `brain/absorbed/*.db`) is copied with
   `VACUUM INTO` to `brain/backups/pre-migrate-<utc>/`, and each copy is opened and its row count checked. If any
   backup fails, nothing is changed.
3. **Copy.** Every memory is read from a scratch copy of its file (CortexDB never opens your originals) and written
   into `brain/brain.db` under its bucket: the person is scope `user`, a project is scope `global` with its slug as
   the namespace. Ids, text, tags, sources, importance, authorship, review state, timestamps, history, recall counters
   and supersede links are kept. A memory that already exists in the new file is only replaced when the 0.5 copy is
   newer, so running the migration twice, or after a crash, ends in the same state.
4. **Progress marker.** `state/memory/migration.json` records each file as it finishes. A killed migration resumes
   from it (tested by killing a real migration at twelve different moments).
5. **Verify, then move aside.** Per-bucket counts are checked. Only then are the 0.5 files moved (never deleted) to
   `brain/legacy-0.5/`, the retired state folders (`upkeep`, `distinct`, `sweep.json`, `heal.json`, `reflect`,
   `verify`, `jobs.jsonl`, `profile`, `distill`, `scan`) moved to `state/memory/legacy-0.5/`, and the obsolete
   embedding model (`toolchain/embed`, 27 MB) removed.
6. **Profile claims.** The explicit preferences you stated in 0.5 (`profile/claims.json`) become person-level
   `preference` memories with `origin: explicit`. Notes, usage, environment and style claims, and claims you dropped,
   are not converted. They stay in `state/memory/legacy-0.5/`.

Absorbed projects (`brain/absorbed/*.db`) were already folded into their target project in 0.5; they are backed up and
moved aside as archives and not imported again.

Check the result:

```sh
buracle mem migrate --status    # complete, with the counts per bucket
buracle mem status              # your project and the person
buracle doctor memory           # brain file, backups, leftover legacy files
```

## Going back

Everything the migration replaced is still on disk until you delete it.

```sh
buracle mem migrate --rollback          # puts the 0.5 files back; keeps the new file as brain.db.rolled-back
buracle mem migrate --rollback --force  # also deletes the new brain.db
buracle rollback                        # returns the installed runtime to the previous one (0.5)
```

`--rollback` restores `brain/person.db` and `brain/projects/*.db` from `brain/legacy-0.5/` (or from the verified
pre-migration copies if that folder is gone) and puts the retired state folders back. It takes the same lock as
the migration, so it waits for one that is running. If you used 0.6 after migrating, memories written since then live only in the new file; export them first
with `buracle mem export --project <slug> --out file.jsonl` and `buracle mem export --person --out person.jsonl`
and import them into 0.5 with `buracle mem import`.

By hand, with no Buracle at all: stop your sessions, then copy the files out of
`~/.buracle/brain/backups/pre-migrate-<utc>/` back into `~/.buracle/brain/` (`person.db` next to a `projects/` folder).

When you are sure, reclaim the space:

```sh
buracle mem migrate --purge-legacy      # deletes brain/legacy-0.5 and the pre-migrate copies of that migration
```

`--purge-legacy` leaves older pre-migrate copies from earlier runs and any `brain.db.rolled-back` a rollback set aside;
delete those by hand when you no longer need them.

Backups taken by 0.5 (`brain/backups/<id>`) are still listed by `buracle mem backup --list` and `buracle mem restore`
restores them bucket by bucket (`--project <slug>`, `--person`, or `--all`). New backups copy the whole file.

## Commands and settings that changed

| 0.5 | 0.6 |
| --- | --- |
| `buracle mem sweep`, `reflect`, `verify`, `heal`, `jobs`, `tick`, `kick`, `profile` | removed: nothing runs in the background, and CortexDB expires sessions and handoffs itself |
| `buracle mem distill` | folded into `buracle mem capture [--session ID --harness H] [--pending]`, the on-demand twin of what a session end runs |
| a session start brings the brain UI up | removed: `buracle mem ui` starts it on demand and it stops by itself when idle |
| `buracle mem ui --for-session` | removed |
| embedding model, `BURACLE_NO_EMBED`, `CORTEXDB_EMBED_*` | removed: the search is lexical (CortexDB FTS5/BM25) plus graph and filters; the CortexDB child never receives `OPENAI_*` or `CORTEXDB_*` variables from your shell |
| Context Mode server, hook H27, `buracle ctx`, the `contextMode` config block | removed (a `config.yaml` that still holds the default block loads quietly); hook id H27 is retired, not reused |
| one file per project plus `person.db` | `brain/brain.db`; `buracle mem backup --project/--person` is not available because a backup copies the whole file (use `buracle mem export --project <slug>` for one project) |
| `buracle mem write` | new `--origin explicit|inferred` and `--confidence 0..1`; a hand-written memory is `explicit`, an agent's MCP write is `inferred` unless it says otherwise |
| status JSON `v: 2` | `v: 3` (no upkeep queue, distill queue or core-page counters; adds `last_capture`) |
| Claude Code status line refreshed every 15 s | every 60 s |
| a session start builds or refreshes the project's codegraph and semble indexes in the background | a session start starts no index run: codegraph updates its own index when its server starts (the launcher builds the first one), semble re-indexes when it searches, and in a folder of several projects the agent builds the index it needs with `buracle index ensure --cwd <project>` |
| Linux: Homebrew-only advice for missing tools | the distribution's own command (apt-get, dnf, yum, pacman, apk, zypper); Buracle never runs `sudo` or a package manager itself |

Behaviour that changed for the better but can surprise you:

- Session memories (kind `session`) now carry a 45-day time to live and handoffs 14 days, enforced by CortexDB. Rows
  written before 0.6 keep their `expires` date as data: they are hidden when it passes but are not dropped by the engine.
- An inferred write (an agent or the end-of-session distillation) never changes a memory that is explicit, pinned or
  verified. It is stored beside it, marked as contradicting, and the tool result names the conflict.
- The model call of a session-end capture is validated as a whole before anything is written. A failed, rate-limited
  or malformed reply leaves the memory untouched and is retried by a later session end or `buracle mem capture --pending`.

## If something looks wrong

- `buracle mem migrate --status` shows `failed` with the last error; fix the cause and run `buracle mem migrate` again.
- A `migrating` error from a tool means another terminal holds the lock; wait a few seconds or look at
  `buracle doctor memory`.
- Files listed as "could not move (a process still holds them)" are still migrated; close the sessions that hold them
  and run `buracle mem migrate` once more to move them aside.
- The migrated brain is never deleted by anything but `--rollback --force` and `--purge-legacy`.

---
name: dead-code
description: >-
  Report-only dead-code audit. Collects candidate unused files and exports from the project's own
  analyzers, a bundled rg-based script and a read-only codegraph snapshot, checks every candidate
  against independent signals (codegraph references, exact and dynamic-usage search, analyzers),
  rules out a public role (API, entry points, config, registries), and returns a ranked report with
  evidence and a staged removal plan. Never deletes or edits code.
when_to_use: >-
  The user invokes it or asks for an unused or dead code audit ("find the dead code", "find unused
  code", "cleanup report", "dead code audit").
invocation: explicit
argument-hint: "[path or package to audit]"
mcp: [codegraph, semble, context7, buracle-memory]
short-description: Report-only dead-code audit with two-signal evidence and a removal plan
---

# Dead code: audit, report only

Find code that is probably unused, back every claim with independent evidence, and give the user a
ranked report plus a removal plan. **This workflow never deletes, moves or edits code**, even when a
candidate looks obvious. Removal is a separate change that the user starts afterwards.

## Rules

1. **Read-only.** No edits, deletions, formatting, installs or git writes in the project, and never
   `codegraph init` yourself. The one write allowed is `buracle index ensure --cwd <project root>` when
   codegraph reports no index: it touches only Buracle's index (`.codegraph/`, which Buracle keeps out of
   git, and the semble cache). Use analyzer flags that do not write caches. The working tree must be
   unchanged at the end (Phase 6).
2. **Two families minimum.** A candidate becomes `remove-candidate` only with evidence from at least two
   of the counting families G, T and A (table below), no unresolved dynamic-usage explanation, and the
   boundary review B resolved: no public or framework role. B is a precondition, never one of the two.
   Never claim certainty: write "likely unused" and show the evidence.
3. **Candidates are not findings.** The helper script and analyzers only propose; independent evidence
   is what makes the report worth trusting.
4. **Never install tools.** A missing analyzer goes under *Not checked*.
5. **Route tools strictly.** Structure: codegraph `codegraph_explore`. Intent and look-alikes: semble
   `search` and `find_related`. Exact text: `rg`. Syntax shapes: `ast-grep` in search mode only (never
   `--rewrite` or `-U`). Framework conventions: context7 at the installed version. Past decisions:
   `memory_search`. Never `grep -r` or `find … | xargs grep`.
6. Reply in the user's language. Keep paths, symbols and commands verbatim.

### Signal families

| Family | Evidence that counts | Typical source |
|---|---|---|
| **G** graph | no callers, importers or blast radius for the symbol or module | `codegraph_explore`, language-server references |
| **T** text | no word-bounded mention outside the definition in code, strings, config, tests or docs, and no dynamic-usage site that could reach it | helper script, `rg -w`, quoted-name search |
| **A** analyzer | the project's own compiler, linter or dead-code tool reports it unused | knip, `tsc --noUnused*`, ruff F401/F841, vulture, staticcheck U1000, deadcode |
| **B** boundary (precondition, not counted) | not a public or conventional entry: absent from package exports, bin, main, `__all__`, documented API, route, command, plugin or DI registries, and not a framework convention file | manifests, registries, framework docs |

The helper script and manual `rg` are the same family (T) and count once; the graph snapshot script
and `codegraph_explore` are the same family (G) and count once. Git history is supporting context
only, never one of the two families. Per-language analyzer commands with no-write flags,
dynamic-usage patterns and framework conventions are in [references/signals.md](references/signals.md).

## Progress

Buracle shows the run live, in the workflow band above the prompt and in the status line. Keep it
current with `buracle flow`; the calls are cheap and best effort, so a failing one never stops the run.

- Start: `buracle flow start dead-code --title "<scope>"` in Phase 0 (harmless when a hook already started
  it).
- Each phase: `buracle flow phase <id>` as Phases 1-5 begin: `collect`, `check`, `classify`, `plan`,
  `report`.
- End: `buracle flow end --outcome done` after the Phase 6 check.

## Phase 0: Preflight

1. `buracle flow start dead-code --title "<scope>"`. Snapshot the tree with
   `git status --porcelain=v1 -uall` and `git rev-parse --short HEAD`. Keep both outputs in your working
   notes, not in a project file. Outside git, say that the unchanged-tree proof is unavailable and avoid
   every command that might write.
2. Run `buracle worktree detect --json` so the report names the checkout you audited.
3. Memory pass, at most 3 queries: `memory_search` for "dead code", "unused", "keep" and the area name.
   A note such as "looks unused but is loaded by the plugin registry" is a lead to verify, not a verdict.
4. Scope: the argument path, else the repository root. For a large repository (thousands of source files)
   with no scope given, offer 2-4 scopes with {{ask_user}}, recommended first.
5. Map the boundaries before collecting candidates: manifests (`package.json` main, module, exports, bin, scripts;
   `pyproject.toml` scripts and entry points; `go.mod` and `main` packages), framework (from dependencies),
   generated and vendored directories, test layout, and whether this is a library (public API matters) or
   an application.

Track Phases 0-6 with {{todo}}.

## Phase 1: Collect candidates

1. `buracle flow phase collect`. Run the helper script from the project root. It is read-only and
   needs only `bun` and `rg`.
<!-- harness:claude -->
   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/candidates.ts" --root . --scope <path>
   ```
<!-- /harness -->
<!-- harness:codex -->
   ```bash
   bun "$HOME/.agents/skills/dead-code/scripts/candidates.ts" --root . --scope <path>
   ```
<!-- /harness -->
<!-- harness:opencode -->
   ```bash
   bun "$HOME/.agents/skills/dead-code/scripts/candidates.ts" --root . --scope <path>
   ```
<!-- /harness -->
<!-- harness:omp -->
   ```bash
   bun "$HOME/.agents/skills/dead-code/scripts/candidates.ts" --root . --scope <path>
   ```
<!-- /harness -->
   If that path does not exist, use the `scripts/` folder next to this SKILL.md.
   Options: `--mode exports|files|all`, `--lang ts,js,py,go`, `--exclude '<glob>'` (repeatable),
   `--include-tests`, `--limit <n>` (default 100), `--json`, `--help`.
   Exit codes: 0 ok, 1 error, 2 finished with warnings (read them, results may be incomplete).
   Hints, strongest first: `unreferenced`, `test-only`, `docs-config-only`, `local-only`. `local-only`
   means the code is used inside its own file, so at most its `export` is unnecessary.
2. Take a graph snapshot of everything the codegraph index says nothing reaches, with the index's
   health. It opens the index read-only, never runs `codegraph init` or sync, and needs the codegraph
   toolchain Buracle installs.
<!-- harness:claude -->
   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/graph-candidates.ts" --root . --scope <path> --json
   ```
<!-- /harness -->
<!-- harness:codex -->
   ```bash
   bun "$HOME/.agents/skills/dead-code/scripts/graph-candidates.ts" --root . --scope <path> --json
   ```
<!-- /harness -->
<!-- harness:opencode -->
   ```bash
   bun "$HOME/.agents/skills/dead-code/scripts/graph-candidates.ts" --root . --scope <path> --json
   ```
<!-- /harness -->
<!-- harness:omp -->
   ```bash
   bun "$HOME/.agents/skills/dead-code/scripts/graph-candidates.ts" --root . --scope <path> --json
   ```
<!-- /harness -->
   Options: `--exclude '<glob>'`, `--include-exported`, `--include-tests`, `--limit <n>`, `--help`.
   Its rows are G evidence for the candidates of step 1 and nominate symbols the text script cannot
   see (non-exported functions, methods, common names); a nomination is a candidate, not a finding.
   Exit 2 means a warning: no index (run `buracle index ensure --cwd <project root>` once), no SDK, an
   index that is partial, stale or has unresolved references, or only the raw unreferenced list. Copy
   each warning into *Not checked* or lower the confidence of the G rows.
3. Run every project analyzer that is already installed and configured, with the no-write flags from
   [references/signals.md](references/signals.md). Record anything missing.
4. Merge and de-duplicate by path and name. Check at most 40 items, preferring those that several
   sources agree on and `unreferenced` hints. List the rest under *Not checked (budget)*.
5. Read the text script's `dynamic-usage hints`. Each one is a place where a name or path is built at runtime.
   No candidate that such a site could reach may become `remove-candidate` until you have read the site.

If the script cannot run (no `bun` or `rg`), collect candidates with analyzers and manual `rg` and say so.

## Phase 2: Check each candidate

`buracle flow phase check`. Collect evidence family by family; stop as soon as the verdict is clear.
Candidates are independent: with more than ten of them, split the list into lanes of about ten and
check each lane with a read-only agent launched by {{spawn_agent}} (the *Parallel agents* rule),
briefed with the evidence families below, the tool routing and "return one row per candidate with
the family, the command and the `path:line` evidence". Run at most 4 lanes at once, run
`buracle usage --json` first when you need 3 or more, and re-check two rows of every lane yourself
before you rank.

- **G:** a row of the graph snapshot, or `codegraph_explore` with a query that names the symbol and
  its file, for example "callers and importers of `formatLegacy` in src/util/format.ts". Read the
  blast-radius section and the staleness banner. No index: run `buracle index ensure --cwd <project root>` once and retry; if that fails, G is
  `unchecked`.
<!-- harness:claude -->
  If a language-server tool is available, a find-references result on the symbol also counts as G.
<!-- /harness -->
- **T:** `rg -n -w --hidden -g '!.git' '<name>'` across the whole repository, plus the quoted forms
  `rg -n -F "'<name>'"` and `rg -n -F '"<name>"'` for lookups by string. For a module, search its import
  specifier (`rg -n -F '/<stem>'`). Open every hit outside the definition.
- **A:** did an analyzer from Phase 1 flag it?
- **B:** check the manifests and registries mapped in Phase 0. Run semble `search` (content `all`) on the
  concept to find wiring by configuration or convention, and `find_related` on the definition to spot a
  duplicate that may be the live version.
- **History (optional):** `git log -S'<name>' --oneline -n 5` shows when the last use disappeared.

For each candidate record: families satisfied, families contradicted, and the exact commands used.

## Phase 3: Classify and rank

`buracle flow phase classify`. Assign exactly one status:

| Status | Meaning |
|---|---|
| `remove-candidate` | at least two of G, T and A agree, dynamic sites resolved, B resolved (no public role) |
| `drop-export` | two families show no other file uses it, but its own file does: remove the `export` or make it private, keep the code |
| `test-only` | production code that only tests or fixtures use; deleting it means the user accepts losing those tests |
| `test-definition` | a definition inside a test file that nothing calls; reported apart, since it is test hygiene, not production code |
| `referenced` | an analyzer or the graph snapshot nominated it, but a live consumer contradicts it (`path:line`); kept in the report so the analyzer configuration can be tuned |
| `public-surface` | exported API, entry point, documented or registered: needs a deprecation path, not deletion |
| `keep-uncertain` | only one family, or a dynamic or convention explanation you could not rule out |
| `excluded` | generated, vendored, migrations, fixtures or examples: out of scope |
| `unchecked` | a required check could not run: name the check |

Rank `remove-candidate` items by evidence strength (families in agreement), then by payoff (lines
removed), then by risk. Follow them with `drop-export`, `test-only`, `public-surface`, `keep-uncertain`,
`test-definition` and `referenced`.

## Phase 4: Removal plan

`buracle flow phase plan`. Group `remove-candidate` and `drop-export` items into small batches, lowest
risk first. For each batch
give the items, the order of edits, and the commands the user should run afterwards (typecheck, build,
tests, lint, and the helper script again for those names). Put `test-only` and `public-surface` items
in a "needs your decision" section with options: delete the tests too, keep, or deprecate first.
Suggest running larger plans through {{skill:plan-build}}. Never execute any part of the plan yourself.

## Phase 5: Report

`buracle flow phase report`. Write the report in the conversation using
[references/audit-template.md](references/audit-template.md), per the *Plain language* rule, in the
language of the user's prompt: the verdict counts first, then the candidates with the evidence per
row, and the removal plan as batches with checkboxes. Save it to a Markdown file only when the user
asks (suggest `docs/cleanup/YYYY-MM-DD-<scope>.md`).

If you found a non-obvious reason why code that looks dead is alive (loaded by name from config, a
framework convention), offer to save it as one `gotcha` memory with `memory_write` after the report.

## Phase 6: Postflight

Run `git status --porcelain=v1 -uall` again. It must match the Phase 0 snapshot. If anything changed
(an analyzer cache, for example), list the paths in the report's *Worktree* section and ask before
removing them. Do not delete anything on your own. Then `buracle flow end --outcome done`.

## Done when

- Every `remove-candidate` shows at least two of G, T and A, each with its command and `path:line`
  evidence, and a resolved B review.
- Every dynamic-usage hint that could reach a reported item has been read and addressed.
- The report has *Not checked*, *Commands run* and *Worktree* sections.
- The worktree matches the Phase 0 snapshot and nothing was deleted.

## When things go wrong

| Problem | Response |
|---|---|
| codegraph says the project has no index (or the snapshot script exits 2 with "no codegraph index") | run `buracle index ensure --cwd <project root>` once, then retry |
| codegraph down, or still no index | continue with T, A and B; mark G `unchecked`; lower the confidence of affected items |
| semble down | use `rg` for boundary discovery and say so |
| script exits 1 | fix the arguments; if `rg` is missing, report it and collect candidates with analyzers only |
| script exits 2 | use the results, copy its warnings into *Not checked* |
| far too many candidates | narrow `--scope` or report the top 40 and list the remainder as unchecked |
| the user asks to delete mid-audit | finish or stop the audit first; deletion is a separate change ({{skill:plan-build}} or a direct request) |
| memory says "keep X" | treat it as a family-B contradiction until current code disproves it |

## Example

User: `{{skill:dead-code}} src/util` ("find the dead code under src/util").

1. Snapshot, `buracle worktree detect --json`, memory finds nothing relevant.
2. Script: `formatLegacy` (`unreferenced`), `onlyTests` (`test-only`), `usedLocally` (`local-only`).
   knip also reports `formatLegacy` as an unused export.
3. `formatLegacy`: G no callers (graph snapshot and codegraph), T zero mentions, A knip; B resolved:
   not in `package.json` exports. Result: `remove-candidate`, three families.
4. Report row: `1 · remove-candidate · src/util/format.ts:2 formatLegacy · G T A, B ok · 3 lines · low risk`.
   Removal plan batch 1 lists the deletion and `bun run typecheck && bun test` as verification.
5. Postflight `git status` is identical. Nothing was edited.

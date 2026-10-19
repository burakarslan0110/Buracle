# Cleanup audit template

Fill every section. Write in the user's language; keep paths, symbols and commands verbatim. Keep the
audit scannable: one table row per item, details only for items that need them.

```markdown
# Dead-code audit: <scope>
<date> · commit <short sha> · checkout <path or worktree> · mode: report only (nothing was changed)

## Summary
- Candidates: <n> (helper script <a>, graph snapshot <g>, analyzers <b>) · checked: <m> · not checked: <k>
- remove-candidate <x> · drop-export <y> · test-only <z> · public-surface <p> · keep-uncertain <q> · test-definition <t> · referenced <r>
- Graph index: <state, stale or not, pending references> (from `graph-candidates.ts`)
- Likely removable: about <lines> lines in <files> files

## Ranked findings
| # | Status | Item | Families | Size | Risk | Note |
|---|---|---|---|---|---|---|
| 1 | remove-candidate | `src/util/format.ts:2` `formatLegacy` | G T A, B ok | 3 lines | low | last caller removed in a1b2c3d |
| 2 | drop-export | `src/util/format.ts:3` `usedLocally` | T A | 0 lines | low | keep the code, drop `export` |
| 3 | test-only | `src/util/format.ts:5` `onlyTests` | G T | 4 lines | medium | used by tests/format.test.ts:1 |

## Evidence
### 1. `formatLegacy` (`src/util/format.ts:2`)
- G: `codegraph_explore` "callers and importers of formatLegacy in src/util/format.ts" → no callers,
  empty blast radius, index fresh.
- T: `rg -n -w --hidden -g '!.git' formatLegacy` → only the definition line.
- A: `./node_modules/.bin/knip --reporter compact` → listed under unused exports.
- B (precondition): not in `package.json` exports or bin; no registry or convention role.
- Dynamic sites checked: `src/plugins/load.ts:14` loads only from `src/plugins/`, so it cannot reach this file.
- History: `git log -S'formatLegacy' --oneline -n 5` → a1b2c3d removed the last call.

(Repeat for every remove-candidate. For other statuses one line of evidence is enough.)

## Contradicted candidates
| Item | Nominated by | Live consumer |
|---|---|---|
| `src/api/hooks.ts:12` `onSave` | knip, graph snapshot | `src/plugins/registry.ts:40` registers it by name |

(Status `referenced`: kept so the analyzer or index configuration can be tuned.)

## Test definitions
- `tests/helpers/old.ts:3` `makeLegacyFixture`: defined in a test file, nothing calls it (test hygiene).

## Removal plan (not executed)
### Batch 1: low risk
- Items: #1, #4
- Edits, in order: delete `formatLegacy` from `src/util/format.ts`; delete `src/util/orphan.ts`.
- Verify afterwards: `<typecheck command>`, `<test command>`, `<lint command>`, then the helper script
  with `--scope src/util` to confirm nothing new became unreferenced.
### Batch 2: drop exports
- …
### Needs your decision
- `onlyTests` (test-only): delete it with its tests / keep / mark deprecated first.
- `VERSION` (public-surface, documented in docs/usage.md): keep, or deprecate in the next release.

Larger batches can run through the plan-build workflow; nothing has been changed yet.

## Not checked
- <candidate or area> — <reason: budget, no codegraph index, knip not installed, script warning …>

## Commands run
- `<command>` → <one-line result>

## Worktree
- Before: `git status --porcelain=v1 -uall` → <clean, or the listed paths>
- After: identical (or: list each new or changed path and the command that caused it)
```

## Writing rules

- Rank strictly: status order first, then evidence strength, payoff and risk.
- Every `remove-candidate` row needs at least two of the letters G, T and A, a resolved B and an
  *Evidence* subsection.
- Use "likely unused", never "dead" or "confirmed".
- The removal plan names commands that exist in this project (from `package.json` scripts, a Makefile or
  the README). If you cannot find them, say which kind of check the user should run.
- Do not paste whole files or long tool outputs; quote the deciding line with `path:line`.

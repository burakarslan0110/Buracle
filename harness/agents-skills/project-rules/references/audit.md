# Audit checklist for existing guidance

Run every check on every guidance file (root and nested `AGENTS.md`, `CLAUDE.md`,
`CLAUDE.local.md`, `.claude/rules/**`, and other agents' instruction files). Start with
`buracle project check --json`: it tests checks 9 to 12 mechanically and exits 2 while any of them
fails. Report each finding as:

`path:line — check — evidence — proposed fix`

| # | Check | How to test | Typical fix |
|---|---|---|---|
| 1 | **Size** | `wc -l -c`. Root `AGENTS.md` >150 lines or >12 KB; a nested one >60 lines; a rule >80 lines; root plus the deepest nested chain >24 KB (Codex stops reading project docs at 32 KiB combined). | Cut filler, move file-type detail into path rules. |
| 2 | **Stale paths** | Each path mentioned: does it exist? | Fix or delete the line. |
| 3 | **Stale commands** | Each command: still in a manifest, Makefile or CI? Does it run (phase 3)? | Replace with the verified command. |
| 4 | **Contradictions** | Compare guidance with manifests, CI and configs ("use npm" next to `bun.lock`), and the files with each other. | Ask which is right, keep one. |
| 5 | **Duplication** | The same instruction in two or more files. | One home per fact (SKILL.md ground rule 3). |
| 6 | **Filler** | Generic advice ("write clean code", "be careful"), restated lint rules, motivational text. | Delete. |
| 7 | **Unexplained absolutes** | "NEVER touch X" with no reason. | Add the reason in a few words, or delete if no one knows it. |
| 8 | **Harness leakage** | One harness's tool names in shared files (Grep tool, TodoWrite, apply_patch, AskUserQuestion). | Neutral verbs plus the command or MCP server. |
| 9 | **Misplaced scope** | File-type detail in the root file; subtree detail at the root; a `.claude/rules/**/*.md` without `paths:` (Claude loads it always, other harnesses only through the index). | Move to a path rule, a nested `AGENTS.md`, or the root `AGENTS.md`. |
| 10 | **Dead globs** | `rg --files -g '<glob>' \| head -n 1` prints nothing. Unquoted globs that start with `*` or contain `{` break the YAML. | Fix the glob, quote it, or delete the rule. |
| 11 | **Index parity** | Every `.claude/rules/**/*.md` (nested folders too, `README.md` excluded) appears once in the root `## Scoped rules` list with globs equal to its `paths:`, and every listed file exists. A gitignored rule stays out of the tracked index; Buracle lists it for the other harnesses at session start. | Add, fix or remove index lines. |
| 12 | **CLAUDE.md routing** | A `CLAUDE.md` or `CLAUDE.local.md` exists but does not import `@AGENTS.md`, so Claude Code never reads `AGENTS.md`. A `CLAUDE.md` that is a symlink to `AGENTS.md` (or the reverse) is routed. A `.claude/CLAUDE.md` without `@../AGENTS.md` hides `AGENTS.md` from Claude Code and from omp. | Add `@AGENTS.md` (`@../AGENTS.md` in `.claude/CLAUDE.md`); move shared content; personal notes into `CLAUDE.local.md`. |
| 13 | **Secrets and personal data** | Tokens, keys, passwords, private hostnames with credentials, personal emails. | Remove; tell the user to rotate anything real. |
| 14 | **Volatile facts** | Dates, counts, "currently", "new", versions the repo does not pin. | Delete or replace with a pointer to the source of truth. |
| 15 | **Other agents' files** | `.cursor/rules`, `.github/copilot-instructions.md`, `.windsurfrules`, `GEMINI.md`. | Fold verified content into `AGENTS.md`; delete only with the user's consent (other tools may use them). |
| 16 | **Managed blocks** | `<!-- buracle:<id>:start -->` … `<!-- buracle:<id>:end -->` present. | Never edit inside. Report malformed pairs to the user. |
| 17 | **Language** | Mixed languages that make rules ambiguous. | English guidance; identifiers and messages verbatim. |
| 18 | **Generated files and links** | A guidance file headed `GENERATED FILE ... DO NOT EDIT` with a `Source:` line; a guidance file or `.claude`/`.agents` folder that is a symlink (`ls -l`), above all one that leads outside the repository. | Edit the generator's source, never the file. Leave an in-repository alias as it is; report an outside link to the user. |

## Severity

- **Fix now:** 2, 3, 4, 12, 13, 18 (wrong or dangerous guidance).
- **Fix in this pass:** 1, 5, 8, 9, 10, 11 (guidance that misleads or never loads).
- **Propose:** 6, 7, 14, 15, 17 (quality; show them in the approval summary).

## Example findings

```text
AGENTS.md:12 — stale command — package.json has no "test:unit"; CI runs `bun test` — replace with `bun test`
CLAUDE.md:1 — CLAUDE.md routing — no @AGENTS.md import; Claude Code reads only CLAUDE.md here — add `@AGENTS.md`, move lines 3-40 to AGENTS.md
.claude/rules/react.md:2 — dead glob — `src/ui/**/*.jsx` matches nothing; components are .tsx — use `src/ui/**/*.tsx`
```

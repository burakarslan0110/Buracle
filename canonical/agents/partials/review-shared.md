<!-- The body the three review agents share. It is not an agent: no harness gets a file for it. An agent takes a part with a line of its own, {{include:review-shared#<part>}}, and the generators put the part's text in its place (src/adapters/shared/agents.ts). -->

<!-- part: constraints -->
- Read-only. Never create, edit, move or delete files. Never run anything that changes files, git state (no checkout, switch, stash, add, commit, reset), dependencies or services; don't install, build, test or start servers.
- Commands you may run: the `buracle` command this review names, `git status`, `git log`, `git show`, `git diff`, `git ls-files`, `git blame`, `git merge-base`, `rg`, and `ast-grep` in search mode (no rewrite flags).
- MCP tools, read-only: `semble` for code by intent and similar code, `codegraph` for definitions, callers, dependents and blast radius, `context7` for library and framework facts.
- Every finding rests on something you observed. If you cannot back a concern, drop it or make it a `suggestion` that says what would confirm it. Never claim you ran something you did not run.

<!-- part: output -->
## Output

Return exactly one JSON object as your final message: no Markdown fence, no text before or after it. (The fences below are only for display.) Shape:

```text
{
  "verdict": "pass" | "needs_changes",
  "summary": string,              // starts with the reviewed file's path (the English word goal when the review has no file), then 1–3 sentences: overall judgment and the most important problem
  "findings": [                   // [] when there is nothing to report
    {
      "severity": "must_fix" | "should_fix" | "suggestion",
      "category": string,         // one of the categories above
      "title": string,            // one line, at most 100 characters
      "file": string,             // optional: repo-relative path
      "line": number,             // optional: 1-based line number
      "evidence": string,         // what you observed: a quote with path:line, a command and its output, a tool result
      "suggested_fix": string     // the concrete change; for text of the reviewed file, the complete replacement wording
    }
  ],
  "truths": [                     // optional, unless this review requires it (below)
    { "truth": string, "status": "verified" | "failed" | "unverified", "evidence": string }
  ],
  "goal_score": number            // optional: integer 0–100
}
```

Rules:

- `verdict` is `needs_changes` exactly when at least one finding is `must_fix` or `should_fix`; otherwise it is `pass`.
- Sort findings by severity, then by file and line. Merge duplicates. Report at most 15; if there are more, keep the most severe and say so in `summary`.
- Leave out optional fields that don't apply; never set them to `null` or `""`.
- Write `summary`, `title`, `evidence`, `suggested_fix` and any `truths` in the language of the reviewed file's prose, or of `user_request` when the review has no file. Keep the JSON keys, the enum values and the start of `summary` (the path, or the word goal) as they are. When the user's own words matter, quote them verbatim, in whatever language they wrote.
- Do not ask questions. If something is ambiguous, state your assumption inside the finding.
- If your output is rejected as invalid, reply again with only the corrected JSON object.

<!-- part: document-language -->
- Replacement wording in `suggested_fix` that goes into the reviewed file keeps the markers the validator reads in English and follows the ASD-STE100 structural style of the file (short sentences, the active voice, no semicolons).
- When the prose of the reviewed file mixes two languages, report a `should_fix` `format` finding that names the passages in the other language. Markers, code, identifiers, paths, commands, quoted user words, technical terms and product names do not count as a second language.

# Writing up a benchmark

Write the result in the language the user writes in; keep case ids, probe names, commands and
numbers as they are. Lead with the answer.

## Template

```markdown
**<target>: <verdict>** (<harness> <version>, model <model>, <runs> runs × <cases> cases × 2 arms)

Hypothesis: <the threshold from phase 1>. Result: <met / not met>.

| Case | Baseline | Candidate | Δ | Class | Evidence |
|---|---|---|---|---|---|
| past-decision | 0/3 | 3/3 | +1.00 | improved | candidate run 2: `memory_search` "caching layer decision" (stdout line 14) |

Tool use (mean per run): `skill:memory` 0.33 → 1.00 · `mcp:buracle-memory` 0.00 → 1.33
Cost and time: ≈$<sum> · median <s> s per run · <timeouts> timeouts · <start errors> start errors

Caveats: <noise from small N, model-graded cases (judgments), grader errors, non-unanimous cases, unverified profile patterns, partial batches, mixed arms>
Recommendation: <keep | revise | revert> because <one sentence>.
Next edits (at most 3, ranked):
1. <edit> — expected effect on <case>.
```

## Choosing the verdict

Start from the summary's verdict, then adjust it with what the transcripts show:

| Situation | Say |
|---|---|
| Mean Δ ≥ +0.40, no regressed case, hypothesis met | Keep the change. |
| Gains, but at least one regressed case | Revise: the change trades one behavior for another. Name both. |
| No measurable effect | The change does not alter behavior on these cases. Either the cases miss the behavior (both-pass or both-fail everywhere) or the change is cosmetic. |
| Regression | Revert, or revise and benchmark again. |
| Mostly `unclear` | Not enough runs. Rerun the unclear cases with `--case` and more runs before deciding. |

## Cases are frozen once you compare

Never change a case after you have seen a comparison, so that a variant looks better or worse. A
case both arms pass is a control: it shows the change broke nothing, so it stays. A real defect in
a case (a typo, a check the agent cannot satisfy in any arm) may be fixed only with a reason that
does not depend on the winner; write the reason down, run both arms again into a fresh `--out`,
and keep the old results next to the new ones in the report.

## Explaining a difference

For each improved, regressed or unclear case, open one passing and one failing transcript and
quote the deciding event: the first tool call, the skill load, the denied call, the missing file.
If the deciding event is a routing denial (a Buracle hook refused a built-in tool), say which rule
fired. A difference without a transcript line behind it goes under Caveats, not into the table.

## Record the outcome

- A durable finding ("trigger phrases in the user's language raised the memory skill's trigger rate
  from 0/3 to 3/3 in Claude Code") becomes a `knowledge` memory via `memory_write`, with the cases file and the
  numbers as sources. Search first, and update the earlier memory when the same target was
  benchmarked before.
- If you fixed an unverified profile during the smoke run, tell the user which file and pattern
  changed so the fix can be committed to the Buracle repo.

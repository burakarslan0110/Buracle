# Research note template

Write the note in the user's language. Keep it as short as the question allows; a quick lookup may be
five lines. Omit sections that do not apply, except *Sources*.

```markdown
## Research: <question>
As of <YYYY-MM-DD> · depth <quick|standard|deep> · tools: <memory, context7, web-search, web-fetch, grep>
· fallbacks: <none | which>

**Answer.** <two to five sentences that answer the question directly, with [n] citations>

**Confidence:** high | medium | low (<one-line reason>)

### Findings
1. <claim, with version or date where relevant> [1][3]
2. <claim> [2]

### Options compared
| Option | Fits because | Costs and risks | Maturity (version, last release) | Sources |
|---|---|---|---|---|
| A | … | … | v2.4.1, 2026-09 | [1][4] |

### Recommendation
<Only when asked for or needed by a decision: the choice, and the condition that would flip it.>

### Conflicts and uncertainty
- <Source [2] says X, source [5] says Y; [2] is the newer primary source, so X. Settled by …>

### Not checked
- <What was out of budget, unreachable or deliberately skipped>

### Sources
[1] <title> · <publisher or repository> · <URL> · <published, updated or version> · accessed <YYYY-MM-DD>
[2] memory <memory id> "<title>" (updated <YYYY-MM-DD>)
[3] context7 <libraryId> ("<topic>")
[4] code github.com/<owner>/<repo>/blob/<ref>/<path> (via grep)
```

## Memory payload (Phase 6)

`memory_write` arguments for a durable finding:

```json
{
  "type": "knowledge",
  "layer": "person",
  "title": "<claim in the form '<library> <version>: <behavior>'>",
  "summary": "<one line that helps a future search>",
  "body": "<the Answer and Findings sections, with the citation list and the confidence>",
  "sources": ["https://…", "https://…"],
  "tags": ["<topic>"],
  "about": ["<library>"]
}
```

- One fact or decision per memory. The title is a claim, not a topic.
- Include versions and the as-of date in the body so staleness is visible.
- Use `layer: "project"` when the finding only matters for this repository.
- Pass `review: "ok"` only when every claim in the memory rests on a primary source you read in this
  run; otherwise the memory stays `review: pending` until a later session verifies it (checking it
  is the harness's job, never the user's).

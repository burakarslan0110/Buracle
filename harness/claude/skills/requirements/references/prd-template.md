# PRD template

Write the PRD in the language of the user's prompt, per the *Plain language* rule. Translate the
section titles; keep their order. Keep the frontmatter keys and values in English so tools can read
them. Delete the guidance in angle brackets.

```markdown
---
type: prd
title: <claim-style title, e.g. "Teams can share saved searches">
status: draft
approved: false
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
research: <skip|quick|standard|deep>
handoff: <plan-build|goal-build|bugfix|undecided>
harness: <claude|codex|opencode|omp: the session's harness from `buracle plan status --json`; leave the line out without a session>
tags: [prd]
---
# <Title>

## Summary
<Two or three sentences: the problem, what the PRD decides, and the next step. A reader who reads
only this knows what they approve.>

## Problem
<Two to five sentences: who has the problem, what hurts, how they cope today, why now. Evidence with
citations: issue links, quotes, numbers, `path:line`.>

## Users and core flows
- **Primary user:** <role and context>
- **Secondary user:** <if any>

1. <Flow name>: <trigger> → <steps the user takes> → <outcome the user sees>
2. …

## Goals and success signals
- G1: <outcome> · signal: <observable or measurable sign that it worked>

## Scope
### In
- <capability>
### Out of scope
- <capability someone might expect> (<reason, or "later">)

## Requirements
| ID | Requirement (observable) | Priority | Notes |
|---|---|---|---|
| R1 | When <actor> <does something>, <observable result>. | Must | <links to flow or goal> |

## Constraints and context
<What exists today, with `path:line`; hard constraints such as platforms, compatibility, performance,
compliance. Describe, do not design.>

## Decisions
- D1: <decision>, because <reason>. Rejected: <alternative> (<why>).

## Assumptions and open questions
- A1: <assumed default and where it came from, e.g. "user said 'you choose'">
- Q1: <question deferred to the next workflow> · owner: <user | plan-build | goal-build>

## Research
<Tier and date. Two to six findings that shaped this PRD, each with [n].>
[1] <title> · <URL or context7 id or memory id> · <date or version>

## Hand-off
Recommended next step: <the plan-build, goal-build or bugfix command printed in Phase 8>, because <reason>.
```

## Self-review (fix every failure before showing the PRD)

1. **No implementation design.** Requirements and flows say what the user can do and see, not which
   tables, endpoints or files to create. Existing interfaces that must stay compatible go under
   *Constraints and context*. A technology, vendor or platform the user required (a stack, a
   provider) is a constraint, not design: it stays, under *Constraints and context*.
2. **Every requirement is observable** and has a priority. No vague words ("fast", "intuitive",
   "robust") without a number or a check.
3. **Scope is explicit.** *Out of scope* lists what someone could reasonably expect, or says why it is
   empty.
4. **Evidence is cited.** Statements about current code have `path:line`; external facts have `[n]`;
   assumptions say where they came from.
5. **No placeholders.** No `TBD`, `TODO`, `FIXME` or leftover angle-bracket guidance. Unresolved items
   are *Open questions* with an owner.
6. **Consistent.** Every flow is covered by at least one requirement; every Must requirement traces to a
   flow or goal; the title, slug and hand-off match the content.
7. **Readable in five minutes.** The summary answers what the reader approves. Cut repetition; state
   each fact once and point to it elsewhere.

## After approval

Set `status: approved`, `approved: true` and today's `updated`. If the user later changes direction,
write a new PRD and set the old one's `status: superseded` with a line pointing to the new file.

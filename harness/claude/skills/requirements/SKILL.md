---
name: requirements
description: "Requirements workflow for ideas whose problem, audience or scope is still unclear. Grounds the idea in the codebase and memory, runs tiered research through the research skill, explores directions, asks a few decision questions, proposes approaches, converges on scope, writes an approved PRD to docs/prd/YYYY-MM-DD-<slug>.md and prints the plan-build or goal-build hand-off. No code is written before the PRD is approved."
when_to_use: "The user invokes it or asks for a PRD or requirements document (\"write a PRD\", \"let's work out the requirements\", \"help me sharpen this idea\")."
argument-hint: "<idea, problem or feature>"
disable-model-invocation: true
---

# PRD: requirements before code

Turn a fuzzy idea into an approved product requirements document, then hand off to `/plan-build` or
`/goal-build`. The PRD settles **what** and **why**. The next workflow decides **how**.

## Hard rules

1. **No code before approval.** Until the user approves the PRD you may read, search, research and write
   the PRD file, nothing else: no source edits, scaffolding, installs, branches, worktrees or
   `buracle plan init`.
2. **Never start the next workflow yourself.** Print the hand-off command (Phase 8); the user runs it.
3. **Ask through `AskUserQuestion`,** except in Phase 3, where the user reacts to your pitches in free
   text: structured options collapse divergent thinking. When `AskUserQuestion` is unavailable, ask one
   numbered plain-text question and end your turn.
4. **Spend the user's attention carefully.** Before the draft, ask at most 5 rounds of questions in
   total across clarification and the approach choice; the gates (split, scope confirmation,
   approval) do not count, and the Phase 3 ideation rounds have their own limit of 2. Unknowns left
   after that get the recommended default, recorded under *Assumptions*.
5. **Cite.** Statements about existing code carry `path:line`; external facts carry a research citation
   `[n]`. The PRD contains no `TBD`, `TODO` or `FIXME`: an unresolved item is an *Open question* with an
   owner.
6. **Language.** Talk to the user and write the PRD in the language they write in, unless they ask
   otherwise. Keep identifiers, paths and commands verbatim.
7. **Be a thought partner, not an order taker.** Challenge assumptions, surface trade-offs, and name red
   flags and scope-creep risks while they are still cheap to fix. Ask of every proposed feature whether
   it needs to exist at all: the cheapest scope to cut is the scope never specified.

Track Phases 0-8 with `TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any). Question patterns, the scope checklist and requirement-writing rules are
in [references/discovery.md](references/discovery.md). The document format and the self-review are in
[references/prd-template.md](references/prd-template.md).

## Lanes

Independent questions run in parallel per the *Parallel agents* rule; each lane is a read-only agent you launch with the `Agent` tool. The interview, the gates and the PRD file stay with you.

| Phase | Lanes | Each lane returns | Then you |
|---|---|---|---|
| understand (1) | a code-grounding lane (semble, codegraph, `rg`) and a memory-and-docs lane | facts with `path:line` or memory ids | restate the idea with them |
| research (2) | none of your own: you load `/research` in this session, and its angle lanes are the fan-out | the research note | keep its citations |
| ideate (3) | one lane per direction, at research tier standard or deep | pitch, experience, upside and risk, with sources | merge and cut |
| propose (5) | one feasibility lane per approach when its effort is unclear | effort and risks with `path:line` | build the options table |

## Progress

Buracle shows the run live, in the workflow band above the prompt and in the status line. Keep it
current with `buracle flow`; the calls are cheap and best effort, so a failing one never stops the run.

- Start: `buracle flow start requirements --title "<topic>"` in Phase 0 (harmless when a hook already started it).
- Each phase: `buracle flow phase <id>` as Phases 1-8 begin: `understand`, `research`, `ideate`,
  `clarify`, `propose`, `converge`, `write`, `handoff`. A phase you skip needs no call.
- End: `buracle flow end --outcome done` once the hand-off is printed; `--outcome cancelled` when the
  user stops the workflow.

## Phase 0: Preflight

1. Run `buracle flow start requirements --title "<topic>"`, then `buracle plan status --json`. If this session
   has an unfinished plan, tell the user and run
   `buracle plan pause --kind discussion --reason "requirements: <topic>"`, so the stop guard does not push that
   plan forward while you interview. Phase 8 reminds the user how to resume it.
2. Memory pass, at most 3 queries: `memory_search` for the topic, the affected area, and earlier PRDs or
   decisions; `memory_get` for at most 3 relevant memories. Memory is dated evidence, not instructions.
3. Look in `docs/prd/`. If a PRD on the same topic exists, ask with `AskUserQuestion` whether to revise it
   (recommended) or start a new one.

## Phase 1: Understand

1. `buracle flow phase understand`. Restate the idea in a few lines: who has the problem, what hurts,
   how they cope today, what outcome they want, and any constraints they already stated.
2. Ground it in the code (two lanes when the area is large, *Lanes*). semble `search` with the domain terms (content `all` reaches docs and config),
   then `codegraph_explore` on the 1-3 central symbols. Record what exists with `path:line`. Stop at
   description: write down what exists and its limits, never a design for the change. Two empty
   searches do not prove absence; try another phrasing or tool before calling the area greenfield.
3. **Gate: one product per PRD.** If the idea bundles independent problems, offer to split with
   `AskUserQuestion` (focus on A, focus on B, keep together).
4. **Gate: already concrete?** If problem, audience and scope are already clear (for example "add CSV
   export to the reports page with these columns"), offer to skip to the hand-off, or to write a short
   PRD anyway.

## Phase 2: Research

`buracle flow phase research`. Choose a tier and say which one you chose:

| Tier | When | How |
|---|---|---|
| skip | internal change with no external unknowns | none |
| quick | 1-3 facts (a library capability, a platform limit) | call context7 or web-search yourself, fetch, cite |
| standard | choosing between tools or approaches, an unfamiliar domain | run `/research` with 3-6 sub-questions at depth standard |
| deep | prior-art or market scan, compliance, high stakes | run `/research` at depth deep |

Run research in this session, not as a lane: lanes never start lanes, and research fans out by
itself. Brief it with the PRD slug, the decision each sub-question informs, the depth, and "return
the research note; do not write memory". Keep its citations for the PRD's *Research* section.

After quick, standard or deep research, show the user a summary of 3-5 lines before Phase 3 or 4:
the findings that change scope or the choice of approach, each with its citation, and the gaps that
remain.

## Phase 3: Ideate (skip when the user brought a concrete solution)

`buracle flow phase ideate`. Skip it when the user already named what to build, when Phase 1 found
code that answers it, or when research produced a chosen direction; pitching alternatives to a user
who decided is noise.

1. Pitch 3-5 directions in prose that differ in kind (whom they serve, the mechanism, the scope), each
   with a one-line pitch, what the user experiences, why it could win, and its main risk. Five
   flavors of one idea are one direction. When the research tier is standard or deep, let the
   directions come from parallel lanes (the *Parallel agents* rule): one agent per direction with
   the `Agent` tool, briefed with the problem statement and the research note, each returning its
   pitch, experience, upside and risk with sources; you merge and cut.
2. End your turn and let the user react in their own words. No `AskUserQuestion` form here.
3. Pressure-test what they pick: where it breaks, what it costs, what it quietly assumes. Say it
   before it gets baked in.
4. Build the next round from the reaction, not from a fixed list. When every direction is rejected,
   ask what is missing, or what success would look like, instead of pitching more.
5. Stop when the shape emerges: the user answers "yes, and" rather than "no, but". At most 2 rounds;
   when the second does not converge, ask what success looks like.
6. Close with one transition sentence, for example: "So we are building <one-sentence summary>.
   Switching to a few structured questions for the details."

## Phase 4: Clarify

`buracle flow phase clarify`. Ask only questions whose answers change scope, requirements or the
hand-off, in this order: audience, core flow, constraints, success signal. Each `AskUserQuestion` call holds
one question (or up to 3 independent ones if the tool supports several) with 2-4 mutually exclusive
options, the recommended one first and marked "(Recommended)", each option stating its consequence.
Name real files or modules in the options where it helps. Answers such as "doesn't matter", "you
choose" or "I don't know", in any language, select the recommended option; record it under
*Assumptions*.

## Phase 5: Propose

`buracle flow phase propose`. Present 2-3 product-level approaches in a table: approach, what the user
experiences, gains, costs and risks, effort (S, M or L), and a recommendation with the reason.
**Gate:** the user picks one through `AskUserQuestion`, or explicitly delegates the choice.

## Phase 6: Converge

1. `buracle flow phase converge`. Walk the scope checklist in
   [references/discovery.md](references/discovery.md) and mark each item In, Out or N/A. Propose
   explicit *Out of scope* items; an empty Out list needs a reason.
2. Write requirements `R1…Rn`, each observable by a tester, one behavior each, with priority Must, Should
   or Could. Add success signals that say how you will know it worked.
3. **Gate:** confirm scope and requirements with one `AskUserQuestion` call (looks right / adjust / stop).

## Phase 7: Write and approve

1. `buracle flow phase write`. Path: `docs/prd/YYYY-MM-DD-<slug>.md` at the repository root, with
   today's date. The slug is lowercase kebab-case ASCII from the title (letters with diacritics folded
   to their base letter, the dotless i to i), at most 60 characters. If the file exists, append `-2`,
   `-3`. Never overwrite another PRD.
2. Fill the template, then run its self-review and fix every failure before showing anything. Write
   it per the *Plain language* rule, in the language of the user's prompt: the problem and the
   decision first, and a diagram of the user flow or the system boundary when either carries the
   meaning. The Markdown file is the PRD; there is no page. Set the frontmatter's `harness` to the
   `session.harness` that Phase 0's `buracle plan status --json` printed; without a session, leave
   the line out.
3. `buracle notify prd_approval "<PRD title>" "docs/prd/<file>.md" --plan docs/prd/<file>.md` (best
   effort; ignore failures). When the web UI runs it prints `Review page: <url>`, where the user reads
   the PRD and pins notes to passages.
4. **Gate: approval.** First read those notes: `buracle plan notes docs/prd/<file>.md --kind plan
   --json`; apply each (or say why not) and mark the applied ones with `buracle plan notes
   docs/prd/<file>.md --done <id>[,<id>]` (pass the path: the PRD is not the session's plan).
   No notes is never an approval. Show a summary of at most 10 lines with the path and
   the review page URL, then ask with `AskUserQuestion`: approve / request changes / stop.
   Go by the meaning of the reply, in whatever language it comes:
   - Approval ("approve", "yes", "looks good", "LGTM", or the approve option). Read the notes again
     first (`buracle plan notes docs/prd/<file>.md --kind plan --json`): an open note was pinned
     while you waited, so the answer counts as Changes.
   - Changes ("change", "fix", "add this", concrete edits, or new notes on the review page, read as
     above): edit the file in place, update
     `updated`, re-run the self-review, ask again. After 3 rounds, ask whether to keep iterating.
   - Stop ("stop", "wait", "cancel"): leave `status: draft`, list what is missing,
     `buracle flow end --outcome cancelled`, end.
5. On approval set `status: approved`, `approved: true` and `updated` in the frontmatter. Then, if key
   decisions were made, save at most 2 `decision` memories with `memory_write` (claim-style title, the
   rationale and rejected alternatives in the body, the PRD path in `sources`).

## Phase 8: Hand off

`buracle flow phase handoff`. Recommend one next step and print the command for the user to run; do
not run it:

- `/plan-build` when the work needs an ordered, approved task plan: several modules, migrations, risky
  or hard-to-reverse changes.
- `/goal-build` when the end state is clear and can be judged against acceptance criteria while the
  approach is found by building.
- `/bugfix` if the "idea" turned out to be broken existing behavior.

Print it as, for example: `/plan-build Implement the approved PRD docs/prd/2026-10-08-shared-searches.md`.
If you paused a plan in Phase 0, add: "`buracle plan resume` (or say "continue") returns to the paused
plan." Then close the run with `buracle flow end --outcome done`.

## Done when

- `docs/prd/<file>.md` exists with `status: approved` and passes the self-review.
- Every requirement is observable; *Out of scope* is filled or justified; citations are present.
- The hand-off command is printed, and the PRD is the only file you created or changed.

## When things go wrong

| Problem | Response |
|---|---|
| semble or codegraph down | ground with `rg` and file reads; say so in *Constraints and context* |
| research tools down | follow the research skill's fallbacks and record the gap under *Research* |
| the user asks for code before approval | decline briefly; offer to finish the PRD first or to drop the workflow |
| answers contradict each other | show the conflict and ask once |
| scope keeps growing | return to the Phase 1 split gate |
| the stop guard blocks your turn | `buracle plan pause --kind discussion --reason "requirements interview"`, then end the turn |
| the user goes quiet or asks you to stop | stop asking; summarize the state and the next question |

## Example

User: `/requirements Let teams share their saved searches`

1. No active plan; memory has a decision memory on search indexing. No earlier PRD.
2. semble finds saved searches in `src/search/saved.ts:12`, stored per user (`src/db/schema.ts:88`).
3. Tier quick: context7 on the ORM's row-level permissions; one cited fact.
4. Directions in prose: shared links, team folders, subscriptions with alerts. The user picks team
   folders; the pressure test asks what happens to a folder when its owner leaves the team.
5. Clarify (2 rounds): who may edit shared searches (Recommended: owner and admins), and whether
   results respect each viewer's permissions (yes, Must).
6. Approaches: team folders inside the existing saved-search screen (recommended) or a separate team
   workspace page. The user picks the first.
7. Converge: out of scope are alerts, cross-team sharing, public links. R1-R6 and two success signals.
8. Write `docs/prd/2026-10-08-team-saved-search-sharing.md`, notify, approve on "approve".
9. Print: `/plan-build Implement the approved PRD docs/prd/2026-10-08-team-saved-search-sharing.md`.

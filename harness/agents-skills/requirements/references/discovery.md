# PRD discovery guide

Detail for Phases 1-6. Read the section for the phase you are in.

## 1. Understand: the facts to pin down

Answer these for yourself before asking the user anything; ask only about the gaps that matter.

- **Who:** the primary user (role, skill level, how often they hit the problem) and any secondary user.
- **Pain:** what goes wrong today, how often, how badly. Prefer evidence: an issue, a log line, a quote,
  a number the user gave.
- **Workaround:** what people do now. A cheap workaround lowers the priority; a painful one raises it.
- **Outcome:** what is true for the user when this is done, in their words.
- **Constraints:** deadline, platforms, compatibility, data, budget, compliance.
- **Why now:** the trigger. It often reveals the real scope.

### Grounding in the codebase

- semble `search` with the user's own words, then with the domain terms you find in the code.
- `codegraph_explore` on the central symbols for structure and blast radius ("how does X reach Y").
- `rg -n -w` for exact names the user mentions (routes, settings, table names).
- Write findings as facts with `path:line`: "Saved searches are stored per user
  (`src/db/schema.ts:88`) and have no sharing field." Stop there: no design, no file plan.

## 2. Research: briefing the research skill

Use this shape when you run the research skill:

```text
Research for PRD <slug>. Depth: <standard|deep>.
Decision this informs: <one line>.
Sub-questions:
1. <question> (informs: <requirement or decision>)
2. …
Constraints: <stack and versions from the manifest, platforms>.
Return the research note with citations. Do not write memory.
```

Bring back only what changes the PRD: facts that alter scope, requirements, constraints or the choice of
approach. Everything else stays in the research note.

## 3. Ideate: directions that differ in kind

A good set varies at least one of these per direction:

- **Who it serves:** the end user, an admin, an integrator.
- **Mechanism:** automation, a new view, a notification, an API, an import or export.
- **Scope:** the smallest useful slice versus a broader platform move.

Format each direction as:

```text
B. Team folders: saved searches live in shared folders per team.
   User experience: open the team folder, run or copy a search.
   Could win because: matches how teams already organize work.
   Main risk: permission rules for mixed-access results.
```

Do not rank them yet. Ask in prose which ones appeal and why; the "why" is the most useful answer.

Then pressure-test the pick in a few lines:

```text
Team folders break when the owner leaves the team: who inherits the searches?
They cost a permission model for mixed-access results.
They assume teams already exist as an entity in the product; today they do not (`src/db/schema.ts:88`).
```

Ideation goes wrong in three ways: pitching alternatives after the user already decided, pitching
variations of one idea, and rounds that never converge (then ask what success looks like).

## 4. Clarify: questions worth asking

Ask a question only if each answer leads to a different PRD. Good questions:

- name the trade-off, not the feature ("Results should respect each viewer's permissions, or the
  owner's?");
- offer 2-4 mutually exclusive options, the recommended one first with "(Recommended)";
- state each option's consequence in a few words;
- mention real code where it helps ("today `src/search/saved.ts` filters by owner only").

Avoid questions about implementation (frameworks, tables, file layout), questions you can answer from the
code or research, and open "anything else?" questions.

Replies to recognize, in whatever language they come:

| Reply | Meaning |
|---|---|
| "doesn't matter", "you choose", "up to you", "I don't know" | take the recommended option; record it as an assumption |
| "both", "all of them" | the user wants a combination; ask once which one is Must |
| "stop", "wait" | stop asking and wait |
| "continue", "go on" | continue with the next step |

## 5. Propose: approaches at product level

Compare approaches by what the user gets and what it costs, not by code structure:

| Approach | User experience | Gains | Costs and risks | Effort |
|---|---|---|---|---|
| Share from the existing saved-search screen | same screen, new "share with team" toggle | small change, familiar UI | permission edge cases in mixed teams | M |
| Separate "shared with me" area | dedicated page for everything shared | flexible, room for cross-team sharing later | more UI, existing searches need a move | L |

Recommend one and name the condition that would change your recommendation.

## 6. Converge: scope checklist

Mark each line In, Out or N/A for this PRD. Turn every Out that someone might reasonably expect into an
explicit *Out of scope* item with a reason.

- Identity and permissions: who can see, create, edit, delete.
- Data lifecycle: creation, editing, deletion, retention, export, migration of existing data.
- Empty, loading and error states; partial failure.
- Limits and scale: sizes, rates, concurrency, pagination.
- Notifications and feedback to the user.
- Localization: the languages the product ships in, date and number formats, locale-sensitive casing
  (the Turkish dotted and dotless i, for example).
- Accessibility: keyboard use, screen readers, contrast.
- Surfaces: web, mobile, CLI, public API.
- Observability: logs, metrics, audit trail.
- Security and privacy: personal data, secrets, abuse cases.
- Compatibility: existing users, stored data, APIs, configuration.
- Rollout: feature flag, migration, rollback.
- Documentation and support.
- Admin and operations tooling.
- Offline or degraded network.
- Cost: infrastructure and third-party usage.

## 7. Requirements that a tester can check

- One observable behavior per requirement: "When a team member opens a shared search, results include
  only records they can access."
- Name the actor and the trigger; avoid "should be fast", "user-friendly", "robust".
- Put numbers on quality requirements when they matter: "Search results appear within 2 s for 10k
  records."
- Priority: **Must** (the release fails without it), **Should** (important, can slip), **Could** (nice to
  have).
- Success signals describe the outcome in use: "At least 3 teams share a search in the first month."
- Leave implementation to the next workflow: no tables, endpoints or file names as requirements, unless
  an existing interface must stay compatible (then it is a constraint).
- A technology the user states as a requirement (a stack, a vendor, a platform) is a constraint and
  stays, under *Constraints and context*; it is not implementation design.

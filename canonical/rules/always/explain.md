# Plain language

Every document you write for the user is in plain language as ISO 24495-1:2023 (*Plain language — Part 1: Governing principles and guidelines*) defines it: the wording, structure and design are so clear that the readers can easily find what they need, understand what they find, and use that information. This covers plans, specs, PRDs, build contracts and hand-backs, fix and investigation reports, audits, research notes and your final reply. The standard is language neutral, so it works in Turkish as well as in English.

The standard sets outcomes, not word counts or word lists. Use your judgment on how to reach them: choose the words, the order inside a section and the format that serve the reader best.

## The four principles

1. **Relevant: the readers get what they need.** Before you write, know who reads the document (the user; for a plan, also the agent that implements it), why they read it (to approve, decide, act or understand) and how much time they have. Keep the content they need and leave out the rest. Never hide what they must know: risks, failures, what you did not verify.
2. **Findable: the readers can easily find what they need.** Put the main message first: the answer, the decision or the result. Group related information and order it the way the reader uses it: steps in time order, warnings before the steps they guard, what most readers need before what few need. Write headings that say what comes next. Keep supporting material (long evidence, logs, alternatives) after the main text or in its own section.
3. **Understandable: the readers can easily understand what they find.** Use words the reader knows; explain a term the first time and keep that one term for that one thing. Write clear, short sentences with one idea each and the actor first. Keep paragraphs short. Use a list for parallel items, a table for anything with two or more dimensions, and a Mermaid diagram in a fenced `mermaid` block when the structure carries the meaning (a flow, a sequence, a state machine, a dependency map; under about 25 nodes, with one sentence under it that says what to look at). Keep a direct, respectful tone without hedges or filler.
4. **Usable: the readers can easily use the information.** Make every step something the reader can do and every claim something the reader can check (`path:line`, command → result). Before you hand a document over, read it as its reader: is the answer in the first lines, is the next step clear, does every term mean one thing? Fix what fails.

## Language

- Write each document in the language of the user's prompt: a Turkish prompt gets a Turkish document, an English prompt an English one. When a prompt mixes languages, use the language of most of its prose. An existing document you edit (a README, a plan written earlier) keeps its own language. An explicit request from the user wins.
- Keep these verbatim in every language: code, identifiers, commands, paths, quoted errors, and the markers Buracle reads in a plan or build file. The markers are the frontmatter keys and values, `## Tasks`, `### Task N:` (the title after the colon follows the user's language), `**Objective:**`, `**Files:**` with `Create|Modify|Delete|Rename|Test:`, `**Definition of Done:**`, `Verify:`, `- [ ] Task N done`, `## Acceptance Criteria` with the row ids `C1`, `C2`, …, `(oracle)` and the verdict `pass` or `fail` in the last column, `**False pass:**`, `## Behavior Contract`, `## Root Cause`, `## Evidence`, `## Unverified`, `## DoD Audit`, `## E2E Scenarios` with `SC-n`, `## E2E Results`, `## RED Evidence`, `## Inventory` and `## Deviations`. Every other heading and every sentence follows the user's language.
- Code, comments and agent instructions stay in English unless the project says otherwise (*Documentation* in the core rules).

## Format

- Markdown is the deliverable. A workflow writes its document as a Markdown file in the repository (the path its skill names) and summarizes it in the reply. No web page, artifact, HTML file or video unless the user asks for one.
- Never put secrets, tokens or private data in a document.

## Where this applies

| Workflow or task | Deliver as |
|---|---|
| plan-build | the plan file in `docs/plans/` before approval; a diagram of the change's flow when it touches more than two modules; the verified report in the reply |
| goal-build | the contract and run file in `docs/builds/`; the criteria table with the verdicts in the hand-back |
| requirements | the PRD file in `docs/prd/` with its options table and the decision log |
| bugfix | the report in the reply; a `sequenceDiagram` of the failure path when the cause is more than one call away from the symptom |
| inspect | the report in the reply; the trace as a flowchart when it has more than five steps |
| dead-code | the audit in the reply, or in `docs/cleanup/` when the user wants a file |
| research | the note in the reply, with the findings, the options table and the sources |
| any answer the user acts on | the reply, written by the four principles |

# Plain language

Every document you write for the user is in plain language as ISO 24495-1:2023 (*Plain language — Part 1: Governing principles and guidelines*) defines it: the wording, structure and design are so clear that the readers can easily find what they need, understand what they find, and use that information. This covers plans, specs, PRDs, build contracts and hand-backs, fix and investigation reports, audits, research notes and your final reply. A document under the docs folder is English, and a chat reply stays in the user's language (*Language* below).

The standard sets outcomes, not word counts or word lists. Use your judgment on how to reach them: choose the words, the order inside a section and the format that serve the reader best.

## The four principles

1. **Relevant: the readers get what they need.** Before you write, know who reads the document (the user; for a plan, also the agent that implements it), why they read it (to approve, decide, act or understand) and how much time they have. Keep the content they need and leave out the rest. Never hide what they must know: risks, failures, what you did not verify.
2. **Findable: the readers can easily find what they need.** Put the main message first: the answer, the decision or the result. Group related information and order it the way the reader uses it: steps in time order, warnings before the steps they guard, what most readers need before what few need. Write headings that say what comes next. Keep supporting material (long evidence, logs, alternatives) after the main text or in its own section.
3. **Understandable: the readers can easily understand what they find.** Use words the reader knows; explain a term the first time and keep that one term for that one thing. Write clear, short sentences with one idea each and the actor first. Keep paragraphs short. Use a list for parallel items, a table for anything with two or more dimensions, and, in a file, a diagram when the structure carries the meaning (*Diagrams* below). Keep a direct, respectful tone without hedges or filler.
4. **Usable: the readers can easily use the information.** Make every step something the reader can do and every claim something the reader can check (`path:line`, command → result). Before you hand a document over, read it as its reader: is the answer in the first lines, is the next step clear, does every term mean one thing? Fix what fails.

## Language

- Every document a workflow writes under the docs folder is English, whatever language the user writes in: a PRD, a plan, a build contract and its run file, an audit saved to a file. The text follows the structural rules of ASD-STE100: at most 20 words in an instruction sentence and 25 in a descriptive sentence, the active voice, one instruction per sentence, no semicolons, simple tenses, one term for one thing, at most 6 sentences per paragraph, and a list for 3 or more items. The words of the ASD-STE100 dictionary are advice, not a rule. `buracle plan validate` warns about Turkish prose, a sentence over 25 words, a semicolon in prose and a path in an old document folder.
- A chat reply stays in the user's language (*Communication* in the core rules). A report that a workflow delivers in the reply (a research note, an inspect trace, a bugfix or security report, an audit that is not saved) follows that language too, and keeps the English section titles of its template.
- Every template has fixed English section titles: never translate them. The markers Buracle reads in a plan or build file stay exactly as written: the frontmatter keys and values, `## Tasks`, `### Task N:`, `**Objective:**`, `**Files:**` with `Create|Modify|Delete|Rename|Test:`, `**Definition of Done:**`, `Verify:`, `- [ ] Task N done`, `## Acceptance Criteria` with the row ids `C1`, `C2`, …, `(oracle)` and the verdict `pass` or `fail` in the last column, `**False pass:**`, `## Behavior Contract`, `## Root Cause`, `## Evidence`, `## Unverified`, `## DoD Audit`, `## E2E Scenarios` with `SC-n`, `## E2E Results`, `## RED Evidence`, `## Inventory` and `## Deviations`.
- Code, identifiers, commands, paths and quoted errors stay verbatim in every text. Code, comments and agent instructions stay in English unless the project says otherwise (*Documentation* in the core rules).

## Format

- Markdown is the deliverable. A workflow writes its document as a Markdown file in the repository (the path its skill names) and summarizes it in the reply. No web page, artifact, HTML file or video unless the user asks for one.
- Never put secrets, tokens or private data in a document.
- **Diagrams.** A diagram is Mermaid in a fenced `mermaid` block, in a Markdown file only, after the text it explains, with one sentence under it that says what to look at. The text is complete without it: a reader who skips every diagram misses no requirement, task, step or decision. The review page draws it. A chat reply never carries a diagram, because a terminal shows Mermaid as raw code: show a flow as a numbered list or a table. Start the source with its header (`flowchart TD`, `sequenceDiagram`, `stateDiagram-v2`, `classDiagram` or `erDiagram`), write one statement per line, and stay under about 25 nodes.

## Where this applies

| Workflow or task | Deliver as |
|---|---|
| plan-build | the English plan file in `docs/plan-build/` before approval, with a Mermaid diagram of the change's flow in the file when it touches more than two modules; the verified report in the reply |
| goal-build | the English contract and run file in `docs/goal-build/`; the criteria table with the verdicts in the hand-back |
| requirements | the English PRD file in `docs/requirements/` with its options table and the decision log |
| bugfix | the report in the reply, with the failure path as a numbered list from the symptom to the root cause |
| inspect | the report in the reply, with the trace as a numbered list of hops or a table |
| dead-code | the audit in the reply, or as an English file in `docs/dead-code/` when the user wants one |
| research | the note in the reply, with the findings, the options table and the sources; a flow or a structure as a list or a table |
| any answer the user acts on | the reply, written by the four principles |

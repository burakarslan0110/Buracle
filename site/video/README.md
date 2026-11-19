# Launch film

The 40-second Buracle Stack launch film, as a [HyperFrames](https://hyperframes.heygen.com) project. One
composition (`index.html`) renders both languages: the root variable `lang` is `en` (the default) or `tr`.
Only the headlines and the plain-language lines (the layer modules, "your projects", the distillation header, the
outcome pills, the query, the three workflow cards, the route labels and the tagline) change with the language. Memory
titles stay English in both, because the brain writes them in English. Project terms, commands and their output stay
English in both: Plan, Review, Approve, RED, GREEN, Verify, VERIFIED, repro, root cause, proof, criteria, rounds, judged,
research, PRD, approved, about, cites, tag, DENIED, ASK, MASKED, MCP, the memory card, file names, commands, settings,
statuses and harness names.

The film tells one idea: Buracle Stack is the layer that brings coding agents together. It walks the landing page in
its order, then ends on the install command. Seven scenes of 4 to 9 s each (round 5 was 55 s with nine scenes: the
knowledge graph was two scenes of its own and "And more under the hood" was one; both are gone):

| Time (s) | Scene |
|---|---|
| 0–4 | "7 coding agents. 7 setups.": the seven harness logos, each with its config folder |
| 4–8.45 | "One layer under all of them.": the logos lock onto the buracle stack layer (Setup, Memory, Guards, Workflows, Tools) over your projects; at **drop 1** (6.0) the wordmark slams in from a larger size and the layer shakes; the camera zooms through the Memory module |
| 8.45–16.5 | "One memory for every agent.": one canvas with the knowledge graph in the middle. Codex CLI writes a Decision into it from the left and it joins the graph as a node; Claude Code reads from the right (`memory_search "decisions on totals"` with `about: ["billing"]`, the walk starts at the billing hub) and writes a finding of its own, a gotcha, that joins the graph as a new node |
| 16.5–25.5 | "Workflows that end in proof.": only `/plan-build` runs in detail, phase by phase, under a rail (Plan, Review, Approve, RED ⇄ GREEN, Verify). The plan file (its `status`, `approved` and two task lines change) and a terminal (`buracle plan validate --strict`, the review verdict, `buracle plan set approved true`, `bun test` failing and then passing for each task, `buracle plan verify`) show what each phase does, and RED and GREEN run twice, once per task, as a loop. The stamp VERIFIED is **drop 2** at 22.0. Then only the flow of `/bugfix`, `/goal-build` and `/requirements` lights up |
| 25.5–29.5 | "9 MCP servers, routed.": three questions routed to context7, codegraph and semble; lsp shows four of its language servers, web-search a globe |
| 29.5–33.5 | "Guards answer first.": `rm -rf ~` DENIED, a force push ASK, a token MASKED (the music keeps its full groove here) |
| 33.5–40 | The end card: the logos slam into a row, the wordmark slams in (**drop 3** at 34.0), the tagline, the install command and stack.buracle.dev; under them the colophon (photo, "Built by Burak Arslan", role, LinkedIn and GitHub), the same block as in the guide's footer |

The memory and workflow scenes show real outputs, not invented ones: `distillDecision` in `src/memory/distill.ts` gives
the three candidates new, update (title similarity 0.67 to the cents decision) and noop (1.0 to the release procedure);
`memQueryWords` and `memStemForms` (`src/core/memory/query.ts`, `stem.ts`) drop `on` / `için`; `cortexAbout`
(`src/core/memory/brain.ts`) turns `about` into a graph walk. The workflow commands and the plan file are those of
`src/cli/commands/plan.ts` and `canonical/skills/plan-build/references/plan.md` (`CREDITS.md` lists what is made up: the
test name, the counts and the line numbers).

There is no carried shape: each scene enters through an object of the previous one (the logos, the Memory module, a
slide, a cut on the beat). One accent (#c4b5fd) marks highlighted words, lit chips and lines; green marks proof and
rose marks denials. Only the wordmark keeps its violet gradient and amber eye, because that is the logo.

## The three drops

The film has three explosions, and the music has a drop on each one, on the exact frame and on the downbeat of a bar:
the logos lock onto the layer (6.0 s), `/plan-build` is VERIFIED (22.0 s) and the wordmark slams onto the end card
(34.0 s). Each drop comes after one sixteenth of silence (everything, reverb tails included, goes quiet), so its first
transient is unmistakable, and each has a crash, a sub boom and a slam that start on the very sample of the frame. The
ground also flashes on the drop frame. The numbers are `LOCK_T`, `T_V` and `T_WORD` in `index.html` and `LOCK`,
`VERIFIED` and `WORD` of the music score; change them together.

## Pace and legibility rules

- Every headline sits in one slot (top left) and is in place before the picture under it moves. One idea moves at a
  time.
- Every line of text stays still and readable for at least 2.0 s. Headline words are 96 px or larger, text the viewer
  must read is 32 px or larger, nothing readable is under 28 px.
- Nothing sits on top of a letter: logos, chips, badges, lines, cards and the stamp route around text or wait until
  it is gone. Text only fades and rises: no blur, glow or scale while it is read, and it rests at scale 1 on whole
  pixels. Ligatures are off so commands read literally (`--force`).

## Source only

This folder holds the film's source (`index.html` and `assets/`) and its credits. The tools that built it (the render
script with its audio sync and loudness mastering, the legibility gate, the logo and sound-effect writers and the
music score) and the HyperFrames project files are not kept in the repository; they are in the git history before the
commit that removed them. The rendered film, poster and GIF are in `../media/`.

The copy of both languages is the `COPY` object at the top of the script in `index.html`, and the beat sheet (every
timestamp with its picture and sound) is the comment at the top of it. The music is 120 BPM, so one beat is 0.5 s and
one bar 2 s.

Sources and licences of every audio, logo and font file: `CREDITS.md`.

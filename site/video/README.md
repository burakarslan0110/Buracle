# Launch film

The 55-second Buracle Stack launch film, as a [HyperFrames](https://hyperframes.heygen.com) project. One
composition (`index.html`) renders both languages: the root variable `lang` is `en` (the default) or `tr`.
Only the headlines and the plain-language lines (the layer modules, "your projects", the session lines, the outcome
pills, the query and its stems, the questions, the route labels, the feature cards and the tagline) change with the
language. Memory titles stay English in both, because the brain writes them in English. Project terms stay English in both: Plan, Review,
Approve, RED, GREEN, Verify, VERIFIED, repro, root cause, fix, proof, criteria, rounds, judged, research, PRD,
approved, about, cites, tag, DENIED, ASK, MASKED, MCP, the memory card, file names, commands, settings, statuses and
harness names.

The film tells one idea: Buracle Stack is the layer that brings coding agents together. It walks the landing page in
its order, then shows what the page does not. Nine scenes of 4 to 10 s each:

| Time (s) | Scene |
|---|---|
| 0–4 | "7 coding agents. 7 setups.": the seven harness logos, each with its config folder |
| 4–9 | "One layer under all of them.": the logos lock onto the buracle stack layer (Setup, Memory, Guards, Workflows, Tools) over your projects |
| 9–14.5 | "One memory for every agent.": a Decision written in Codex CLI, saved in brain.db, recalled in Claude Code |
| 14.5–19.5 | "Distilled into a knowledge graph.": a session, one bounded model call and three candidates with their real outcomes (new, update, known); the new gotcha joins the graph through its `about:` and `cites:` hubs |
| 19.5–24.5 | "Search interprets, then expands.": `memory_search "decisions on totals"` with `about: ["billing"]`; the stopword is dropped, the stems appear, the walk from the billing hub finds a gotcha that shares no word with the query |
| 24.5–32.5 | "Workflows that end in proof.": the `/plan-build` loop to VERIFIED, then the `/bugfix`, `/goal-build` and `/requirements` rows |
| 32.5–38 | "9 MCP servers, routed.": three questions routed to context7, codegraph and semble; lsp shows four of its language servers, web-search a globe |
| 38–43 | "Guards answer first.": `rm -rf ~` DENIED, a force push ASK, a token MASKED |
| 43–49 | "And more under the hood.": six cards that the landing page does not show: a second agent's review (`reviews.companion`), the handoff after a context reset, `buracle skills add` for every agent, the Console, `buracle doctor`, `buracle uninstall` |
| 49–55 | The end card: the logos, the wordmark, the tagline, the install command and stack.buracle.dev |

The knowledge graph scene shows real outputs, not invented ones: `distillDecision` in `src/memory/distill.ts` gives the
three candidates new, update (title similarity 0.67 to the cents decision) and noop (1.0 to the release procedure);
`memQueryWords` and `memStemForms` (`src/core/memory/query.ts`, `stem.ts`) drop `on` / `için` and give `decision`,
`total` / `toplam`, `karar`; `cortexAbout` (`src/core/memory/brain.ts`) turns `about` into a graph walk.

There is no carried shape: each scene enters through an object of the previous one (the logos, the Memory module, a
slide, a cut on the beat). One accent (#c4b5fd) marks highlighted words, lit chips and lines; green marks proof and
rose marks denials. Only the wordmark keeps its violet gradient and amber eye, because that is the logo.

## Pace and legibility rules

- Every headline sits in one slot (top left) and is in place before the picture under it moves. One idea moves at a
  time.
- Every line of text stays still and readable for at least 2.0 s. Headline words are 96 px or larger, text the viewer
  must read is 32 px or larger, nothing readable is under 28 px.
- Nothing sits on top of a letter: logos, chips, badges, lines, cards and the stamp route around text or wait until
  it is gone. Text only fades and rises: no blur, glow or scale while it is read, and it rests at scale 1 on whole
  pixels. Ligatures are off so commands read literally (`--force`).

## Check legibility

```sh
node tools/legibility-gate.mjs            # both languages, every 0.1 s; exit code 1 on any finding
node tools/legibility-gate.mjs --selftest # plants one violation of each kind; proves the gate catches them
```

The gate opens the film in the Chrome that HyperFrames renders with (`CHROME_PATH` overrides it), seeks every 0.1 s and
fails on: any decorative element (`data-deco`, `data-deco-line`) or other text intersecting a visible text box or the
wordmark, still readable text under 28 px, text readable for less than 2.0 s in one stretch, and still text resting
on a scale other than 1 or carrying a blur, drop-shadow or text-shadow. `--lang tr`, `--json <file>` and
`--shots 3,9.5 --out <dir>` (PNG frames) are there too. It needs Node 22+ and no packages.

## Render both languages

Needs Node 22 or newer, ffmpeg and ffprobe. From this folder:

```sh
./render.sh
```

The script runs the legibility gate, renders English and Turkish with the CLI version that `package.json` pins
(`hyperframes@0.9.65`) at 3840x2160 (device scale 2), downscales to 1920x1080 with Lanczos (H.264 CRF 18, so letters
stay sharp on the dark gradients), masters the audio (two-pass loudnorm to -16 LUFS, true peak target -6.5 dBFS so the
AAC file stays under -4 dBFS), adds `+faststart` and writes into `../media/`: `buracle-stack-en.mp4`,
`buracle-stack-tr.mp4`, `poster-en.jpg`, `poster-tr.jpg` (the end card at 54.0 s) and `preview.gif` (10 fps, 720 px,
six windows of the English film). It ends by printing each MP4's codec, size, duration and measured loudness. Intermediate renders go to a temporary folder; set `WORK=<folder>` to keep them,
`CRF=<n>` to change the video quality, `SKIP_GATE=1` to skip the gate and `HYPERFRAMES_BIN=<launcher>` to use another
CLI.

One language by hand:

```sh
npx --yes hyperframes@0.9.65 render --quality high --resolution landscape-4k --variables '{"lang":"tr"}' -o /tmp/raw-tr.mp4
```

## Edit

- Preview: `npx --yes hyperframes@0.9.65 preview`. Check: `npx --yes hyperframes@0.9.65 check`.
- The copy of both languages is the `COPY` object at the top of the script in `index.html`.
- The beat sheet (every timestamp with its picture and sound) is the comment at the top of `index.html`. The music is
  120 BPM, so one beat is 0.5 s and one bar 2 s. Scene changes, the two drops, VERIFIED and every reveal sit on a beat,
  an eighth or a sixteenth; whooshes start a few frames before the move they carry.
- `render(t)` draws every frame from the time alone. `layout()` measures the text once the fonts are loaded,
  `tileState(i, t)` places the seven harness tiles in every scene and `stackCam(t)` is the camera on the layer. The
  knowledge graph is `KN` (memories), `HUB` (the about, cites and tag hubs) and the edges `layKg()` draws between them;
  the distillation is `CANDS`, the search `KQ` and `HITS`. The feature cards are `CARDS` (titles in `COPY`, the product
  text in `CARD_CODE`).
- Mark every new decorative element `data-deco` (or `data-deco-line` for an SVG stroke) so the gate checks it, and
  run the gate after any change of timing or layout.
- Logos: the harness and MCP tiles are static markup with every logo inlined as SVG, so a render never waits on an image
  request. After changing `assets/logos/` or the lists, run `node tools/inline-logos.mjs`.
- Sound effects: the cue list (time, file, volume, what it marks) is in `tools/write-sfx.mjs`; run
  `node tools/write-sfx.mjs` to rewrite the `<audio>` clips at the end of `#root`. One CC0 sound per cue; overlapping
  clips get their own Studio lane.
- Music: `music/score.py` synthesizes the track (numpy and scipy). Its sections follow the beat sheet; rebuild the m4a
  as `CREDITS.md` says when you move a scene.

## Known check warnings

`npx hyperframes check` reports 0 errors. The warnings that stay are deliberate:

- One file, one `render(t)` engine instead of sub-compositions (`composition_file_too_large`,
  `nested_structure_needs_subcomposition`): the seven tiles cross scenes 1, 2, 3 and 8, so they live in one timeline.
- `gsap_callback_dom_measurement`: `layout()` measures the text once the fonts are loaded, with every scene shown, so
  the result does not depend on the seek order.
- `line_unread` on the H01 and H20 verdicts: they are the real hook texts (22 words each), on screen 4.0 s and 3.4 s
  against a 5.3 s heuristic floor. The badge (DENIED, ASK) and the first words carry the beat, and both stay past the
  2.0 s floor of the legibility gate.

Sources and licences of every audio, logo and font file: `CREDITS.md`.

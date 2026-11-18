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
`VERIFIED` and `WORD` in `music/score.py`; change them together.

The HyperFrames CLI (0.9.65) lets the audio of its render start one AAC frame (1024 samples, 21.3 ms) early, two thirds of
a frame, which is audible on a drop. `render.sh` delays the audio by the same amount (`AUDIO_LATE`), and

```sh
node tools/check-sync.mjs ../media/buracle-stack-en.mp4
```

The music has no sudden jump in loudness: `music/score.py` fades it in from silence over the first 4 s (and raises the
intro by 4 dB up to the first drop), and fades it out with a raised cosine over the last 4.5 s (`FADE_IN`, `INTRO_DB`,
`FADE_OUT_START`).

proves it: for each drop it prints the audio edge (the first loud sample after the silence) in ms against the drop time and
whether the picture flashes on the drop frame. It exits 1 when the audio is more than 3 ms off.

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

The script runs the legibility gate, renders English with the CLI version that `package.json` pins
(`hyperframes@0.9.65`) at 3840x2160 (device scale 2), downscales to 1920x1080 with Lanczos (H.264 CRF 18, so letters
stay sharp on the dark gradients), masters the audio (two-pass loudnorm to -16 LUFS, true peak target -7.0 dBFS so the
AAC file stays under -4 dBFS), adds `+faststart` and writes into `../media/`: `buracle-stack-en.mp4`,
`poster-en.jpg` (the end card at 39.0 s) and `preview.gif` (10 fps, 720 px,
six windows of the English film). It ends by printing each MP4's codec, size, duration and measured loudness, and runs `tools/check-sync.mjs` on it. Intermediate renders go to a temporary folder; set `WORK=<folder>` to keep them,
`CRF=<n>` to change the video quality, `REUSE_RAW=1` to master the raw renders already in `$WORK` without rendering again, `SKIP_GATE=1` to skip the gate and `HYPERFRAMES_BIN=<launcher>` to use another
CLI.

One language by hand:

```sh
npx --yes hyperframes@0.9.65 render --quality high --resolution landscape-4k --variables '{"lang":"tr"}' -o /tmp/raw-tr.mp4
```

## Edit

- Preview: `npx --yes hyperframes@0.9.65 preview`. Check: `npx --yes hyperframes@0.9.65 check`.
- The copy of both languages is the `COPY` object at the top of the script in `index.html`.
- The beat sheet (every timestamp with its picture and sound) is the comment at the top of `index.html`. The music is
  120 BPM, so one beat is 0.5 s and one bar 2 s. Scene changes, the three drops and every reveal sit on a beat, an
  eighth or a sixteenth; whooshes start a few frames before the move they carry.
- `render(t)` draws every frame from the time alone. `layout()` measures the text once the fonts are loaded,
  `tileState(i, t)` places the seven harness tiles in every scene and `stackCam(t)` is the camera on the layer. The
  memory scene's constants are `S3_IN` to `KG_WALK`: the graph is `KN` (memories), `HUB` (the about, cites and tag hubs)
  and the edges `layKg()` draws between them; the Decision that is written is node A (`SAVED_T`), the distillation is
  `CANDS`, the search `KQ` and `HITS`. The workflows scene is `PHASES` and `PH_T` (the rail), `PLAN_VALS` and `PLAN_ROWS`
  (the plan file), `TERM_ROWS` (the terminal: a command types, its result lands) and `WCARDS` (the other three workflows,
  their text in `COPY.wf`).
- Mark every new decorative element `data-deco` (or `data-deco-line` for an SVG stroke) so the gate checks it, and
  run the gate after any change of timing or layout.
- Logos: the harness and MCP tiles are static markup with every logo inlined as SVG, so a render never waits on an image
  request. After changing `assets/logos/` or the lists, run `node tools/inline-logos.mjs`.
- Sound effects: the cue list (time, file, volume, what it marks) is in `tools/write-sfx.mjs`; run
  `node tools/write-sfx.mjs` to rewrite the `<audio>` clips at the end of `#root`. One CC0 sound per cue; overlapping
  clips get their own Studio lane.
- Music: `music/score.py` synthesizes the track (numpy and scipy). Its sections follow the beat sheet; rebuild the m4a
  as `CREDITS.md` says when you move a scene, and keep `LOCK`, `VERIFIED` and `WORD` equal to `LOCK_T`, `T_V` and
  `T_WORD` in `index.html` (see *The three drops*).

## Known check warnings

`npx hyperframes check` reports 0 errors. The warnings that stay are deliberate:

- One file, one `render(t)` engine instead of sub-compositions (`composition_file_too_large`,
  `nested_structure_needs_subcomposition`): the seven tiles cross scenes 1, 2, 3 and 7, so they live in one timeline.
- `gsap_callback_dom_measurement`: `layout()` measures the text once the fonts are loaded, with every scene shown, so
  the result does not depend on the seek order.
- `line_unread` on the H01 and H20 verdicts: they are the real hook texts (22 words each), on screen 3.2 s and 2.9 s
  against a 5.3 s heuristic floor. The badge (DENIED, ASK) and the first words carry the beat, and both stay past the
  2.0 s floor of the legibility gate.

Sources and licences of every audio, logo and font file: `CREDITS.md`.

// Writes the sound-effect clips into index.html from the cue list below: one CC0 sound per cue, placed on the beat
// grid of the beat sheet (120 BPM, one beat = 0.5 s). The cues are sorted by time before they are written. Run from site/video after moving a cue:
//   node tools/write-sfx.mjs
// Each clip's length is the file's own length (ffprobe), cut to `dur` when a cue gives one. Clips that overlap in time
// get different Studio lanes (3, 4, 5, ...), so the timeline stays editable.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// [time, file in assets/sound/, volume, what it marks, options]
const CUES = [
  // S1 harnesses
  [0.25, "pop-kenney-interface-pluck-001.ogg", 0.5, "Claude Code pops"],
  [0.375, "pop-kenney-interface-drop-001.ogg", 0.5, "Codex CLI pops"],
  [0.5, "pop-kenney-interface-pluck-002.ogg", 0.5, "OpenCode pops"],
  [0.625, "pop-kenney-interface-drop-002.ogg", 0.5, "Oh My Pi pops"],
  [0.75, "pop-fs-824189-pop-in-sfx.ogg", 0.5, "Qwen Code pops"],
  [0.875, "pop-kenney-interface-drop-003.ogg", 0.5, "Pi pops"],
  [1.0, "kit-pop.ogg", 0.5, "AGY CLI pops"],
  [1.25, "impact-kenney-impact-impactsoft-heavy-001.ogg", 0.4, "\"7 setups.\" lands"],
  // S2 the layer
  [4.28, "whoosh-fs830856.ogg", 0.38, "the logos gather into a row"],
  [5.0, "transition-kenney-interface-maximize-006.ogg", 0.42, "the layer rises"],
  [6.0, "impact-fs524817.ogg", 0.72, "lock onto the layer (drop 1)"],
  [6.0, "tick-fs528561.ogg", 0.22, "connector 1"],
  [6.06, "tick-fs384187.ogg", 0.22, "connector 3"],
  [6.12, "tick-fs721514.ogg", 0.22, "connector 5"],
  [6.18, "tick-fs528561.ogg", 0.22, "connector 7"],
  [6.1, "pop-fs-447910-plop.ogg", 0.45, "your projects"],
  [6.6, "ui-blip-kenney-ui-rollover2.ogg", 0.4, "module Setup lights"],
  [6.85, "ui-blip-kenney-ui-rollover3.ogg", 0.4, "module Memory lights"],
  [7.1, "ui-blip-kenney-ui-rollover4.ogg", 0.4, "module Guards lights"],
  [7.35, "ui-blip-kenney-ui-rollover2.ogg", 0.4, "module Workflows lights"],
  [7.6, "ui-blip-kenney-ui-rollover3.ogg", 0.4, "module Tools lights"],
  [7.9, "whoosh-fs-683101-quick-woosh.ogg", 0.5, "zoom through the Memory module"],
  // S3 one memory and its knowledge graph
  [8.95, "whoosh-fs810485.ogg", 0.32, "Codex CLI slides in"],
  [9.4, "pop-kenney-interface-drop-002.ogg", 0.5, "the Decision is written in Codex"],
  [10.0, "whoosh-fs393811.ogg", 0.32, "the write line draws to the graph"],
  [10.45, "ding-fs-634690-lil-pip.ogg", 0.55, "saved in brain.db, the decision joins the graph"],
  [10.65, "tick-fs721514.ogg", 0.22, "edge to about: billing"],
  [11.25, "kit-whoosh.ogg", 0.3, "Claude Code slides in"],
  [11.7, "pop-kenney-interface-maximize-002.ogg", 0.35, "the search card"],
  [12.1, "typing-fs-447909-keyboard-typing.ogg", 0.36, "the query types", { dur: 0.4, mediaStart: 0.2 }],
  [12.55, "typing-fs-447909-keyboard-typing.ogg", 0.32, "about types", { dur: 0.2, mediaStart: 1.2 }],
  [12.9, "transition-kenney-interface-maximize-006.ogg", 0.34, "the walk leaves the billing hub"],
  [13.2, "whoosh-fs393811.ogg", 0.3, "the memory is read from the graph"],
  [13.5, "ding-kenney-interface-glass-002.ogg", 0.32, "found"],
  [13.7, "pop-fs527522.ogg", 0.45, "Claude Code's finding"],
  [14.2, "whoosh-fs393811.ogg", 0.3, "the finding is written to the graph"],
  [14.6, "ding-kenney-interface-confirmation-001.ogg", 0.42, "the gotcha joins the graph"],
  [14.8, "tick-fs721514.ogg", 0.22, "edge to about: billing"],
  [14.9, "tick-fs528561.ogg", 0.22, "edge to cites: src/billing/total.ts"],
  [16.15, "whoosh-fs-683101-quick-woosh.ogg", 0.36, "the memory scene leaves"],
  // S4 the workflows
  [16.85, "pop-kenney-interface-maximize-002.ogg", 0.35, "the two panels rise"],
  [17.5, "tick-fs528561.ogg", 0.4, "Plan"],
  [17.6, "typing-fs-447909-keyboard-typing.ogg", 0.3, "buracle plan validate types", { dur: 0.35, mediaStart: 0.2 }],
  [18.2, "tick-fs384187.ogg", 0.4, "Review"],
  [18.25, "pop-kenney-interface-pluck-001.ogg", 0.3, "the review report lands"],
  [18.8, "click-kenney-interface-click-001.ogg", 0.4, "Approve"],
  [18.85, "typing-fs-447909-keyboard-typing.ogg", 0.3, "buracle plan set approved types", { dur: 0.3, mediaStart: 1.0 }],
  [19.3, "glitch-kenney-interface-glitch-002.ogg", 0.45, "RED, task 1"],
  [19.3, "typing-fs-447909-keyboard-typing.ogg", 0.3, "bun test types", { dur: 0.2, mediaStart: 1.8 }],
  [20.0, "ding-kenney-interface-confirmation-003.ogg", 0.42, "GREEN, task 1"],
  [20.15, "glitch-kenney-interface-glitch-002.ogg", 0.35, "RED again, task 2"],
  [20.7, "ding-kenney-interface-glass-001.ogg", 0.36, "GREEN again, task 2"],
  [21.2, "tick-fs721514.ogg", 0.45, "Verify"],
  [21.4, "typing-fs-447909-keyboard-typing.ogg", 0.3, "buracle plan verify types", { dur: 0.3, mediaStart: 1.4 }],
  [22.0, "impact-kenney-impact-impactpunch-heavy-000.ogg", 0.68, "VERIFIED stamp (drop 2)"],
  [22.3, "pop-fs527522.ogg", 0.38, "/bugfix, /goal-build and /requirements start"],
  [23.0, "ding-kenney-interface-confirmation-002.ogg", 0.3, "judged"],
  [23.1, "ding-kenney-interface-glass-001.ogg", 0.32, "proof"],
  [23.3, "ding-kenney-interface-glass-002.ogg", 0.3, "approved"],
  [25.2, "kit-whoosh.ogg", 0.38, "scene out"],
  // S5 nine MCP servers
  [25.65, "pop-kenney-interface-maximize-001.ogg", 0.4, "the nine servers pop in"],
  [25.8, "typing-fs-447909-keyboard-typing.ogg", 0.38, "question 1 types", { dur: 0.25, mediaStart: 0.2 }],
  [26.0, "whoosh-fs393811.ogg", 0.32, "routed to context7"],
  [26.25, "pop-kenney-interface-pluck-001.ogg", 0.45, "context7 lights"],
  [26.1, "typing-fs-447909-keyboard-typing.ogg", 0.38, "question 2 types", { dur: 0.25, mediaStart: 1.0 }],
  [26.3, "whoosh-fs393811.ogg", 0.32, "routed to codegraph"],
  [26.55, "pop-kenney-interface-pluck-002.ogg", 0.45, "codegraph lights"],
  [26.4, "typing-fs-447909-keyboard-typing.ogg", 0.38, "question 3 types", { dur: 0.25, mediaStart: 1.8 }],
  [26.6, "whoosh-fs393811.ogg", 0.32, "routed to semble"],
  [26.85, "pop-kenney-interface-drop-001.ogg", 0.45, "semble lights"],
  [29.2, "whoosh-fs-683101-quick-woosh.ogg", 0.38, "scene out"],
  // S6 guards
  [29.6, "transition-kenney-interface-maximize-006.ogg", 0.32, "the terminal rises"],
  [29.9, "typing-fs-447909-keyboard-typing.ogg", 0.38, "rm -rf ~ types", { dur: 0.12, mediaStart: 0.2 }],
  [30.1, "impact-kenney-impact-impactsoft-heavy-001.ogg", 0.62, "DENIED"],
  [30.15, "typing-fs-447909-keyboard-typing.ogg", 0.38, "git push --force types", { dur: 0.25, mediaStart: 1.0 }],
  [30.45, "ding-kenney-interface-bong-001.ogg", 0.5, "ASK"],
  [30.5, "typing-fs-447909-keyboard-typing.ogg", 0.38, "gh auth token types", { dur: 0.1, mediaStart: 2.0 }],
  [30.62, "glitch-kenney-interface-glitch-002.ogg", 0.45, "the token scrambles"],
  [30.8, "ding-kenney-interface-glass-001.ogg", 0.45, "MASKED"],
  [33.28, "transition-kenney-interface-minimize-002.ogg", 0.42, "the terminal leaves"],
  // S7 end card
  [33.48, "transition-fs-786514-swoosh-v2.ogg", 0.42, "the logos slam into a row"],
  [33.62, "tick-fs528561.ogg", 0.22, "logo 2 lands"],
  [33.74, "tick-fs384187.ogg", 0.22, "logo 4 lands"],
  [33.86, "tick-fs721514.ogg", 0.22, "logo 6 lands"],
  [34.0, "impact-fs-177242-cinematic-impact.ogg", 0.62, "wordmark slam (the end drop)", { dur: 2.2, fadeOut: 0.8 }],
  [35.0, "typing-fs-447909-keyboard-typing.ogg", 0.34, "the install command types", { dur: 0.8, mediaStart: 0.2, fadeOut: 0.06 }],
  [36.0, "ding-fs-571513-soft-notifications-bell-ding-d.ogg", 0.45, "stack.buracle.dev"],
  [36.8, "pop-fs-447910-plop.ogg", 0.4, "the colophon: Built by Burak Arslan"],
];

const length = (file) => {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", new URL(`../assets/sound/${file}`, import.meta.url).pathname], { encoding: "utf8", env: { ...process.env } });
  const d = parseFloat(r.stdout);
  if (!(d > 0)) throw new Error(`no duration for ${file}`);
  return d;
};

const lanes = []; // end time of the last clip in each lane
const tags = [...CUES].sort((x, y) => x[0] - y[0]).map(([t, file, vol, what, o = {}], i) => {
  const full = length(file) - (o.mediaStart || 0);
  const dur = Math.round(Math.min(o.dur || full, full) * 1000) / 1000;
  let lane = lanes.findIndex((end) => end <= t + 1e-6);
  if (lane < 0) { lanes.push(0); lane = lanes.length - 1; }
  lanes[lane] = t + dur;
  const id = `sfx-${String(i + 1).padStart(2, "0")}`;
  const extra = [
    o.mediaStart ? ` data-media-start="${o.mediaStart}"` : "",
    o.fadeOut ? ` data-fade-out="${o.fadeOut}"` : o.dur ? ` data-fade-out="0.05"` : "",
  ].join("");
  return `      <audio id="${id}" class="clip" src="assets/sound/${file}" data-start="${t.toFixed(3)}" data-duration="${dur}" data-volume="${vol}"${extra} data-track-index="${3 + lane}" data-audio-group="sfx"></audio><!-- ${what} -->`;
});

const path = new URL("../index.html", import.meta.url);
let html = readFileSync(path, "utf8");
const re = /(<!-- sfx -->)[\s\S]*?(\s*<!-- \/sfx -->)/;
if (!re.test(html)) throw new Error("marker sfx not found");
html = html.replace(re, `$1\n${tags.join("\n")}$2`);
writeFileSync(path, html);
console.log(`wrote ${tags.length} sound cues in ${lanes.length} lanes`);

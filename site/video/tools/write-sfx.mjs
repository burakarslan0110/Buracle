// Writes the sound-effect clips into index.html from the cue list below: one CC0 sound per cue, placed on the beat
// grid of the beat sheet (120 BPM, one beat = 0.5 s). Run from site/video after moving a cue:
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
  [6.0, "impact-fs524817.ogg", 0.72, "lock onto the layer (the drop)"],
  [6.0, "tick-fs528561.ogg", 0.22, "connector 1"],
  [6.06, "tick-fs384187.ogg", 0.22, "connector 3"],
  [6.12, "tick-fs721514.ogg", 0.22, "connector 5"],
  [6.18, "tick-fs528561.ogg", 0.22, "connector 7"],
  [6.25, "pop-fs-447910-plop.ogg", 0.45, "your projects"],
  [7.0, "ui-blip-kenney-ui-rollover2.ogg", 0.4, "module Setup lights"],
  [7.25, "ui-blip-kenney-ui-rollover3.ogg", 0.4, "module Memory lights"],
  [7.5, "ui-blip-kenney-ui-rollover4.ogg", 0.4, "module Guards lights"],
  [7.75, "ui-blip-kenney-ui-rollover2.ogg", 0.4, "module Workflows lights"],
  [8.0, "ui-blip-kenney-ui-rollover3.ogg", 0.4, "module Tools lights"],
  [8.45, "whoosh-fs-683101-quick-woosh.ogg", 0.5, "zoom through the Memory module"],
  // S3 one memory
  [9.38, "whoosh-fs810485.ogg", 0.32, "Codex CLI and Claude Code slide in"],
  [10.4, "pop-kenney-interface-drop-002.ogg", 0.5, "the Decision is written in Codex"],
  [10.78, "whoosh-fs393811.ogg", 0.32, "the line to brain.db fills"],
  [11.25, "ding-fs-634690-lil-pip.ogg", 0.55, "saved in brain.db"],
  [11.33, "whoosh-fs-127197-fast-simple-chop-5-aif.ogg", 0.28, "the line to Claude Code fills"],
  [12.0, "ding-kenney-interface-confirmation-001.ogg", 0.55, "recalled in Claude Code"],
  [13.95, "transition-fs-702773-swipe-wav.ogg", 0.42, "the memory scene slides out, the graph slides in"],
  // S3b the knowledge graph
  [15.0, "pop-kenney-interface-drop-001.ogg", 0.4, "the session card"],
  [15.6, "tick-fs528561.ogg", 0.35, "one model call"],
  [15.9, "ui-blip-kenney-ui-rollover2.ogg", 0.4, "candidate: gotcha"],
  [16.15, "ding-kenney-interface-glass-001.ogg", 0.36, "new"],
  [16.2, "ui-blip-kenney-ui-rollover3.ogg", 0.4, "candidate: decision"],
  [16.45, "ding-kenney-interface-confirmation-002.ogg", 0.32, "update"],
  [16.5, "ui-blip-kenney-ui-rollover4.ogg", 0.4, "candidate: procedure"],
  [16.75, "tick-fs384187.ogg", 0.35, "known"],
  [17.0, "pop-fs527522.ogg", 0.45, "the new gotcha joins the graph"],
  [17.2, "tick-fs721514.ogg", 0.22, "edge to about: billing"],
  [17.3, "tick-fs528561.ogg", 0.22, "edge to cites: src/billing/total.ts"],
  [19.45, "kit-whoosh.ogg", 0.3, "the distillation leaves"],
  [19.6, "pop-kenney-interface-maximize-002.ogg", 0.35, "the search card"],
  [19.75, "typing-fs-447909-keyboard-typing.ogg", 0.36, "the query types", { dur: 0.4, mediaStart: 0.2 }],
  [20.25, "typing-fs-447909-keyboard-typing.ogg", 0.32, "about types", { dur: 0.2, mediaStart: 1.2 }],
  [20.6, "ui-blip-kenney-ui-rollover2.ogg", 0.36, "stopword struck"],
  [20.75, "ui-blip-kenney-ui-rollover3.ogg", 0.36, "stem 1"],
  [20.9, "ui-blip-kenney-ui-rollover4.ogg", 0.36, "stem 2"],
  [21.3, "transition-kenney-interface-maximize-006.ogg", 0.34, "the walk leaves the billing hub"],
  [21.5, "ding-kenney-interface-glass-002.ogg", 0.32, "found by its words"],
  [21.75, "ding-kenney-interface-confirmation-001.ogg", 0.42, "found through the graph"],
  [24.2, "whoosh-fs-683101-quick-woosh.ogg", 0.36, "the graph leaves"],
  // S4 the workflows
  [25.0, "pop-kenney-interface-maximize-002.ogg", 0.35, "the loop draws"],
  [25.5, "tick-fs528561.ogg", 0.4, "Plan"],
  [26.0, "tick-fs384187.ogg", 0.4, "Review"],
  [26.5, "click-kenney-interface-click-001.ogg", 0.4, "Approve"],
  [27.0, "glitch-kenney-interface-glitch-002.ogg", 0.45, "RED"],
  [27.5, "ding-kenney-interface-confirmation-003.ogg", 0.42, "GREEN"],
  [28.0, "tick-fs721514.ogg", 0.45, "Verify"],
  [28.5, "impact-kenney-impact-impactpunch-heavy-000.ogg", 0.68, "VERIFIED stamp"],
  [28.6, "pop-fs527522.ogg", 0.38, "/bugfix, /goal-build and /requirements rows"],
  [29.75, "ding-kenney-interface-glass-001.ogg", 0.32, "proof"],
  [30.35, "ding-kenney-interface-confirmation-002.ogg", 0.3, "judged"],
  [30.95, "ding-kenney-interface-glass-002.ogg", 0.3, "approved"],
  [32.18, "kit-whoosh.ogg", 0.38, "scene out"],
  // S5 nine MCP servers
  [32.8, "pop-kenney-interface-maximize-001.ogg", 0.4, "the nine servers pop in"],
  [33.3, "typing-fs-447909-keyboard-typing.ogg", 0.38, "question 1 types", { dur: 0.3, mediaStart: 0.2 }],
  [33.63, "whoosh-fs393811.ogg", 0.32, "routed to context7"],
  [33.85, "pop-kenney-interface-pluck-001.ogg", 0.45, "context7 lights"],
  [33.95, "typing-fs-447909-keyboard-typing.ogg", 0.38, "question 2 types", { dur: 0.3, mediaStart: 1.0 }],
  [34.28, "whoosh-fs393811.ogg", 0.32, "routed to codegraph"],
  [34.5, "pop-kenney-interface-pluck-002.ogg", 0.45, "codegraph lights"],
  [34.6, "typing-fs-447909-keyboard-typing.ogg", 0.38, "question 3 types", { dur: 0.3, mediaStart: 1.8 }],
  [34.93, "whoosh-fs393811.ogg", 0.32, "routed to semble"],
  [35.15, "pop-kenney-interface-drop-001.ogg", 0.45, "semble lights"],
  [37.68, "whoosh-fs-683101-quick-woosh.ogg", 0.38, "scene out"],
  // S6 guards
  [38.15, "transition-kenney-interface-maximize-006.ogg", 0.32, "the terminal rises"],
  [38.6, "typing-fs-447909-keyboard-typing.ogg", 0.38, "rm -rf ~ types", { dur: 0.12, mediaStart: 0.2 }],
  [38.8, "impact-kenney-impact-impactsoft-heavy-001.ogg", 0.62, "DENIED"],
  [38.95, "typing-fs-447909-keyboard-typing.ogg", 0.38, "git push --force types", { dur: 0.35, mediaStart: 1.0 }],
  [39.4, "ding-kenney-interface-bong-001.ogg", 0.5, "ASK"],
  [39.65, "typing-fs-447909-keyboard-typing.ogg", 0.38, "gh auth token types", { dur: 0.15, mediaStart: 2.0 }],
  [40.0, "glitch-kenney-interface-glitch-002.ogg", 0.45, "the token scrambles"],
  [40.3, "ding-kenney-interface-glass-001.ogg", 0.45, "MASKED"],
  [42.72, "transition-kenney-interface-minimize-002.ogg", 0.42, "the terminal leaves"],
  // S7 and more
  [43.4, "ui-blip-kenney-ui-rollover2.ogg", 0.42, "card: second opinion"],
  [43.6, "ui-blip-kenney-ui-rollover3.ogg", 0.42, "card: handoff"],
  [43.8, "ui-blip-kenney-ui-rollover4.ogg", 0.42, "card: skills add"],
  [44.0, "ui-blip-kenney-ui-rollover2.ogg", 0.42, "card: Console"],
  [44.2, "ui-blip-kenney-ui-rollover3.ogg", 0.42, "card: doctor"],
  [44.4, "ui-blip-kenney-ui-rollover4.ogg", 0.42, "card: uninstall"],
  // S8 end card
  [48.6, "transition-kenney-interface-minimize-002.ogg", 0.48, "the cards leave"],
  [48.98, "transition-fs-786514-swoosh-v2.ogg", 0.42, "the logos slam into a row"],
  [49.12, "tick-fs528561.ogg", 0.22, "logo 2 lands"],
  [49.24, "tick-fs384187.ogg", 0.22, "logo 4 lands"],
  [49.36, "tick-fs721514.ogg", 0.22, "logo 6 lands"],
  [49.5, "impact-fs-177242-cinematic-impact.ogg", 0.62, "wordmark slam (the end drop)", { dur: 2.2, fadeOut: 0.8 }],
  [50.5, "typing-fs-447909-keyboard-typing.ogg", 0.34, "the install command types", { dur: 0.8, mediaStart: 0.2, fadeOut: 0.06 }],
  [51.5, "ding-fs-571513-soft-notifications-bell-ding-d.ogg", 0.45, "stack.buracle.dev"],
  [52.3, "pop-fs-447910-plop.ogg", 0.4, "the colophon: Built by Burak Arslan"],
];

const length = (file) => {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", new URL(`../assets/sound/${file}`, import.meta.url).pathname], { encoding: "utf8", env: { ...process.env } });
  const d = parseFloat(r.stdout);
  if (!(d > 0)) throw new Error(`no duration for ${file}`);
  return d;
};

const lanes = []; // end time of the last clip in each lane
const tags = CUES.map(([t, file, vol, what, o = {}], i) => {
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

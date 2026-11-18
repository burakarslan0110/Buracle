// Sync check for the launch film: the three drops of the music must land on the exact frame of the picture.
// Reads a rendered MP4 and, for each drop time (6.0, 22.0, 34.0), finds
//   audio   the first sample louder than 0.05 after the sixteenth of silence the score puts before the drop
//   video   the first frame whose mean brightness jumps by more than 12 levels (the ground flashes on the drop frame)
// and prints both against the drop time. Exit code 1 when the audio is more than 3 ms off or the flash frame is not the
// drop frame. Needs Node 22+ and ffmpeg.
//   node tools/check-sync.mjs ../media/buracle-stack-en.mp4
import { spawnSync } from "node:child_process";

const file = process.argv[2];
if (!file) { console.error("usage: node tools/check-sync.mjs <film.mp4>"); process.exit(2); }
const DROPS = [6.0, 22.0, 34.0];
const FPS = 30, SR = 48000;
const run = (args, opts = {}) => spawnSync("ffmpeg", ["-hide_banner", "-v", "error", ...args], { env: { ...process.env }, maxBuffer: 1 << 30, ...opts });

const pcm = run(["-i", file, "-vn", "-f", "f32le", "-ac", "1", "-ar", String(SR), "-"]);
const audio = new Float32Array(pcm.stdout.buffer, pcm.stdout.byteOffset, Math.floor(pcm.stdout.byteLength / 4));
const stats = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-an", "-vf", "scale=320:180,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-f", "null", "-"], { env: { ...process.env }, encoding: "utf8", maxBuffer: 1 << 28 });
const yavg = [...stats.stdout.matchAll(/YAVG=([\d.]+)/g)].map((m) => parseFloat(m[1]));

let bad = false;
for (const d of DROPS) {
  // audio: skip the silent sixteenth, then take the first loud sample
  const from = Math.round((d - 0.1) * SR), to = Math.round((d + 0.1) * SR);
  let first = -1;
  for (let i = from; i < to; i++) if (Math.abs(audio[i]) > 0.1) { first = i; break; }
  // the score's gap is silent: the first loud sample after the last quiet stretch of 50 ms
  // (AAC smears a hair of pre-echo, under 0.05, before a hard edge: only a sample above 0.05 counts)
  let quiet = 0, edge = -1;
  for (let i = from; i < to; i++) { if (Math.abs(audio[i]) < 0.05) quiet++; else { if (quiet > 0.05 * SR) { edge = i; break; } quiet = 0; } }
  const aMs = ((edge >= 0 ? edge : first) / SR - d) * 1000;
  // video: the frame whose brightness jumps
  const f0 = Math.round(d * FPS);
  let flash = -1;
  for (let f = f0 - 3; f <= f0 + 3; f++) if (yavg[f] - yavg[f - 1] > 12) { flash = f; break; }
  const ok = Math.abs(aMs) <= 3 && flash === f0;
  if (!ok) bad = true;
  console.log(`drop ${d.toFixed(1)} s: audio edge ${aMs >= 0 ? "+" : ""}${aMs.toFixed(1)} ms, flash frame ${flash} (drop frame ${f0})  ${ok ? "OK" : "OFF"}`);
}
process.exit(bad ? 1 : 0);

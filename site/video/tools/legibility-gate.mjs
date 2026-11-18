// Legibility gate for the launch film. It opens index.html in headless Chrome (the browser HyperFrames renders with),
// seeks every 0.1 s through the whole film in each language and fails when:
//   overlap   any decorative element (logo tiles, chips, badges, the stamp, cards, bubbles, connectors, the
//             loop track, ...: everything marked data-deco or data-deco-line) or another block of text intersects the
//             glyph box of visible text (opacity >= 0.05), or a mark covers the wordmark (data-glyph)
//   small     text that is still and readable (opacity >= 0.5) renders under 28 px, or text never reaches 28 px
//   short     a text element is readable (opacity >= 0.5, not empty) for less than 2.0 s in one stretch
//   soft      still text (opacity >= 0.9) rests on a transform scale other than 1, or carries a blur/drop-shadow
//             filter or a text-shadow
// A deco is never checked against text inside itself (a chip's own label, the terminal's lines).
//
// Usage, from site/video (Node 22+, no packages to install):
//   node tools/legibility-gate.mjs                    both languages; exit code 1 on any finding
//   node tools/legibility-gate.mjs --lang tr --json report.json
//   node tools/legibility-gate.mjs --lang en --shots 3,9.5,15 --out /tmp/frames   PNG frames, no checks
//   node tools/legibility-gate.mjs --selftest         plants one violation of each kind and fails unless all are caught
// Chrome: $CHROME_PATH, else the one `hyperframes browser path` prints ($HYPERFRAMES_BIN overrides the CLI).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const LANGS = (opt("lang", "all") === "all" ? "en,tr" : opt("lang")).split(",");
const STEP = parseFloat(opt("step", "0.1"));
const FROM = parseFloat(opt("from", "0"));
const DURATION = 40;
const TO = parseFloat(opt("to", String(DURATION)));
const SHOTS = opt("shots", null);
const OUT = opt("out", null);
const JSON_OUT = opt("json", null);
const SELFTEST = args.includes("--selftest");
// planted after every seek in --selftest between 1.0 and 4.0 s: the Claude Code tile on the first headline word, a 20 px
// label and a headline word resting at scale 1.01; and a label that is readable for 1 s only
const PLANT = `(() => {
  const w = document.querySelector('#h1a .w'); const b = w.getBoundingClientRect(); const tile = document.getElementById('t-claude');
  tile.style.display = ''; tile.style.opacity = 1; tile.style.transform = 'translate(' + (b.left - 40) + 'px, ' + (b.top - 20) + 'px)';
  document.querySelector('#t-claude .tpath').style.fontSize = '20px';
  document.querySelectorAll('#h1a .w')[1].style.transform = 'scale(1.01)';
})()`;
const PLANT_SHORT = `document.querySelector('#t-codex .tpath').style.opacity = 0`;
const MIN_PX = 28, MIN_HOLD = 2.0;

// ---------- Chrome ----------
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cli = process.env.HYPERFRAMES_BIN ? [process.env.HYPERFRAMES_BIN] : ["npx", "--yes", "hyperframes@0.9.65"];
  const r = spawnSync(cli[0], [...cli.slice(1), "browser", "path"], { encoding: "utf8", env: { ...process.env } });
  const line = (r.stdout || "").trim().split("\n").filter((l) => l.startsWith("/")).pop();
  if (!line || !existsSync(line)) throw new Error(`no Chrome found; set CHROME_PATH (hyperframes said: ${r.stdout}${r.stderr})`);
  return line;
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".jpg": "image/jpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".json": "application/json" };
function serve() {
  const server = createServer((req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(ROOT, p === "/" ? "index.html" : p);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function launch() {
  const dir = mkdtempSync(join(tmpdir(), "hf-gate-"));
  const proc = spawn(chromePath(), ["--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "--force-color-profile=srgb", "--window-size=1920,1080", "about:blank"], { env: { ...process.env }, stdio: ["ignore", "ignore", "pipe"] });
  const ws = await new Promise((ok, fail) => {
    let buf = "";
    const timer = setTimeout(() => fail(new Error("Chrome did not start")), 30000);
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    proc.on("exit", (c) => fail(new Error(`Chrome exited (${c})`)));
  });
  return { proc, dir, ws };
}

function cdp(url) {
  const sock = new WebSocket(url);
  let id = 0;
  const pending = new Map(), waiters = [];
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(`${msg.error.message}`)) : ok(msg.result);
    } else if (msg.method) {
      for (const w of [...waiters]) if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.ok(msg.params); }
    }
  };
  const ready = new Promise((ok, fail) => { sock.onopen = ok; sock.onerror = fail; });
  return {
    ready,
    send: (method, params = {}, sessionId) => new Promise((ok, fail) => { const i = ++id; pending.set(i, { ok, fail }); sock.send(JSON.stringify({ id: i, method, params, sessionId })); }),
    once: (method) => new Promise((ok) => waiters.push({ method, ok })),
    close: () => sock.close(),
  };
}

// ---------- the in-page probe ----------
const PROBE = String.raw`(() => {
  const film = document.getElementById('film');
  const ids = new WeakMap(); let next = 1;
  const gid = (el) => { if (!ids.has(el)) ids.set(el, next++); return ids.get(el); };
  const desc = (el) => {
    let e = el; while (e && !e.id) e = e.parentElement;
    const cls = el.getAttribute && el.getAttribute('class') ? '.' + String(el.getAttribute('class')).split(' ')[0] : '';
    return (e && e !== el ? '#' + e.id + ' ' : '') + (el.id ? '#' + el.id : el.tagName.toLowerCase() + cls);
  };
  let cache;
  const style = (el) => { let s = cache.get(el); if (!s) { s = getComputedStyle(el); cache.set(el, s); } return s; };
  const opacity = (el) => {
    let o = 1;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = style(e);
      if (s.display === 'none' || s.visibility === 'hidden') return 0;
      o *= parseFloat(s.opacity);
      if (o < 0.001) return 0;
    }
    return o;
  };
  const inView = (r) => r.width > 0.5 && r.height > 0.5 && r.right > 0 && r.bottom > 0 && r.left < 1920 && r.top < 1080;
  const hit = (a, b) => { const w = Math.min(a.right, b.right) - Math.max(a.left, b.left); const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return w > 1 && h > 1 ? w * h : 0; };
  // the accumulated 2D scale of every transform from the element up to the page
  const scaleOf = (el) => {
    let k = 1;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const tf = style(e).transform;
      if (tf && tf !== 'none') { const m = new DOMMatrixReadOnly(tf); k *= Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)); }
    }
    return k;
  };
  const softFilter = (el) => { for (let e = el; e && e !== film; e = e.parentElement) { const f = style(e).filter; if (f && f !== 'none' && /blur|drop-shadow/.test(f)) return desc(e) + ' filter ' + f; } return null; };
  const prev = new Map();
  return function sample(t, plant) {
    window.dispatchEvent(new CustomEvent('hf-seek', { detail: { time: t } }));
    if (plant) (0, eval)(plant);
    cache = new Map();
    const texts = [], findings = [];
    const walker = document.createTreeWalker(film, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest('svg, style, script')) continue;
      const op = opacity(el);
      if (op < 0.05) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter(inView).map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }));
      if (!rects.length) continue;
      const block = el.closest('[data-block]') || el;
      const s = style(el);
      const scale = scaleOf(el);
      texts.push({ node: n, el, block, op, rects, size: parseFloat(s.fontSize) * scale, scale, shadow: s.textShadow !== 'none' ? s.textShadow : null, text: n.nodeValue.trim().slice(0, 48) });
    }
    // glyph regions: the wordmarks
    const glyphs = [...film.querySelectorAll('[data-glyph]')].filter((g) => opacity(g) >= 0.05).map((g) => ({ el: g, r: g.getBoundingClientRect() })).filter((g) => inView(g.r));
    // decorations
    const decos = [...film.querySelectorAll('[data-deco]')].filter((d) => opacity(d) >= 0.05).map((d) => ({ el: d, r: d.getBoundingClientRect() })).filter((d) => inView(d.r));
    const lines = [];
    for (const p of film.querySelectorAll('[data-deco-line]')) {
      if (opacity(p) < 0.05) continue;
      const total = p.getTotalLength();
      const s = style(p);
      let visible = total;
      if (s.strokeDasharray && s.strokeDasharray !== 'none') visible = Math.max(0, total - (parseFloat(s.strokeDashoffset) || 0));
      const m = p.getScreenCTM();
      const rad = (parseFloat(s.strokeWidth) || 1) / 2 * Math.hypot(m.a, m.b);
      const pts = [];
      for (let l = 0; l <= visible; l += 6) { const q = p.getPointAtLength(l); pts.push({ x: m.a * q.x + m.c * q.y + m.e, y: m.b * q.x + m.d * q.y + m.f }); }
      lines.push({ el: p, rad, pts });
    }
    const push = (type, a, b, area) => findings.push({ type, a, b, area: Math.round(area || 0) });
    for (const tx of texts) {
      const label = desc(tx.block === tx.el ? tx.el : tx.block) + ' "' + tx.text + '"';
      for (const d of decos) {
        if (d.el.contains(tx.el)) continue;
        for (const r of tx.rects) { const a = hit(r, d.r); if (a) { push('overlap', label, desc(d.el), a); break; } }
      }
      for (const ln of lines) {
        let found = false;
        for (const r of tx.rects) { for (const q of ln.pts) if (q.x + ln.rad > r.left && q.x - ln.rad < r.right && q.y + ln.rad > r.top && q.y - ln.rad < r.bottom) { found = true; break; } if (found) break; }
        if (found) push('overlap', label, desc(ln.el), 0);
      }
      for (const g of glyphs) { if (g.el.contains(tx.el)) continue; for (const r of tx.rects) { const a = hit(r, g.r); if (a) { push('overlap', label, desc(g.el) + ' (wordmark)', a); break; } } }
    }
    for (const g of glyphs) for (const d of decos) {
      if (d.el.contains(g.el)) continue;
      const a = hit(g.r, d.r); if (a) push('overlap', desc(g.el) + ' (wordmark)', desc(d.el), a);
    }
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const A = texts[i], B = texts[j];
      if (A.block === B.block || A.el.contains(B.el) || B.el.contains(A.el)) continue;
      for (const ra of A.rects) { let a = 0; for (const rb of B.rects) a = Math.max(a, hit(ra, rb)); if (a) { push('overlap', desc(A.block) + ' "' + A.text + '"', desc(B.block) + ' "' + B.text + '"', a); break; } }
    }
    // size, rest and softness; per element visibility for the hold check
    const seen = {};
    for (const tx of texts) {
      const key = gid(tx.el);
      const r0 = tx.rects[0];
      const p = prev.get(tx.node) || prev.get(tx.el);
      const still = p && Math.abs(p.left - r0.left) < 0.5 && Math.abs(p.top - r0.top) < 0.5 && Math.abs((p.right - p.left) - (r0.right - r0.left)) < 0.5;
      const label = desc(tx.el) + ' "' + tx.text + '"';
      if (tx.op >= 0.5) seen[key] = { label, size: tx.size };
      if (still && tx.op >= 0.5 && tx.size < ${MIN_PX} - 0.01) push('small', label, Math.round(tx.size * 10) / 10 + ' px', 0);
      if (still && tx.op >= 0.9) {
        if (Math.abs(tx.scale - 1) > 0.002) push('soft', label, 'rests at scale ' + tx.scale.toFixed(4), 0);
        const f = softFilter(tx.el); if (f) push('soft', label, f, 0);
        if (tx.shadow) push('soft', label, 'text-shadow ' + tx.shadow, 0);
      }
    }
    prev.clear();
    for (const tx of texts) { prev.set(tx.node, tx.rects[0]); prev.set(tx.el, tx.rects[0]); }
    return { findings, seen };
  };
})()`;

// ---------- run ----------
async function runLang(browser, server, lang) {
  const c = browser.c;
  const { targetId } = await c.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await c.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => c.send(m, p, sessionId);
  await s("Page.enable");
  await s("Runtime.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: `window.__hyperframes = { getVariables: () => ({ lang: ${JSON.stringify(lang)} }) };` });
  const loaded = c.once("Page.loadEventFired");
  await s("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/index.html` });
  await loaded;
  const ev = async (expression) => {
    const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${lang}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  await ev("Promise.all([...document.fonts].map((f) => f.load().catch(() => null))).then(() => document.fonts.ready).then(() => true)");
  const bad = await ev("[...document.fonts].filter((f) => f.status !== 'loaded').map((f) => f.family + ' ' + f.weight)");
  if (bad.length) throw new Error(`${lang}: fonts did not load: ${bad.join(", ")}`);
  await ev(`window.__gateSample = ${PROBE}; true`);

  if (SHOTS) {
    mkdirSync(OUT || ".", { recursive: true });
    for (const t of SHOTS.split(",").map(Number)) {
      await ev(`window.__gateSample(${t}); true`);
      const { data } = await s("Page.captureScreenshot", { format: "png" });
      const file = join(OUT || ".", `${lang}-${t.toFixed(2).padStart(5, "0")}.png`);
      writeFileSync(file, Buffer.from(data, "base64"));
      console.log("wrote", file);
    }
    await c.send("Target.closeTarget", { targetId });
    return { lang, findings: [] };
  }

  const agg = new Map(); // type|a|b -> { first, last, count, area }
  const runs = new Map(); // element key -> { label, start, last, windows: [], maxSize }
  const n = Math.round((TO - FROM) / STEP);
  for (let i = 0; i <= n; i++) {
    const t = Math.round((FROM + i * STEP) * 1000) / 1000;
    if (t > DURATION - 1e-6) break;
    const plant = !SELFTEST ? "" : [t >= 1 && t < 4 ? PLANT : "", t >= 2.1 ? PLANT_SHORT : ""].filter(Boolean).join(";");
    const { findings, seen } = await ev(`window.__gateSample(${t}, ${JSON.stringify(plant)})`);
    for (const f of findings) {
      const k = `${f.type}|${f.a}|${f.b}`;
      const g = agg.get(k) || { type: f.type, a: f.a, b: f.b, first: t, last: t, count: 0, area: 0 };
      g.last = t; g.count++; g.area = Math.max(g.area, f.area);
      agg.set(k, g);
    }
    for (const [key, v] of Object.entries(seen)) {
      const r = runs.get(key) || { label: v.label, start: null, last: null, windows: [], maxSize: 0 };
      if (r.last === null || t - r.last > STEP * 1.5) { if (r.start !== null) r.windows.push([r.start, r.last]); r.start = t; }
      r.last = t; r.label = v.label; r.maxSize = Math.max(r.maxSize, v.size);
      runs.set(key, r);
    }
  }
  const findings = [...agg.values()];
  for (const r of runs.values()) {
    r.windows.push([r.start, r.last]);
    for (const [a, b] of r.windows) {
      const held = Math.round((b - a + STEP) * 1000) / 1000;
      if (held < MIN_HOLD - 1e-6) findings.push({ type: "short", a: r.label, b: `readable ${held.toFixed(1)} s (${a.toFixed(1)}-${b.toFixed(1)})`, first: a, last: b, count: 1 });
    }
    if (r.maxSize < MIN_PX - 0.01) findings.push({ type: "small", a: r.label, b: `never larger than ${r.maxSize.toFixed(1)} px`, first: r.windows[0][0], last: r.windows[0][1], count: 1 });
  }
  await c.send("Target.closeTarget", { targetId });
  return { lang, samples: n + 1, texts: runs.size, findings };
}

if (SELFTEST) { LANGS.length = 0; LANGS.push("en"); }
const server = await serve();
const { proc, dir, ws } = await launch();
const browser = { c: cdp(ws) };
await browser.c.ready;
let failed = false;
const report = [];
try {
  for (const lang of LANGS) {
    const r = await runLang(browser, server, lang);
    report.push(r);
    if (SHOTS) continue;
    const order = { overlap: 0, small: 1, soft: 2, short: 3 };
    r.findings.sort((x, y) => order[x.type] - order[y.type] || x.first - y.first);
    console.log(`\n[${lang}] ${r.samples} samples every ${STEP} s, ${r.texts} text elements: ${r.findings.length ? r.findings.length + " finding(s)" : "PASS"}`);
    for (const f of r.findings) console.log(`  ${f.type.padEnd(7)} ${f.first.toFixed(1)}-${f.last.toFixed(1)} s  ${f.a}  <>  ${f.b}${f.area ? `  (${f.area} px²)` : ""}`);
    if (r.findings.length) failed = true;
  }
} finally {
  browser.c.close();
  const exited = new Promise((ok) => (proc.exitCode !== null ? ok() : proc.once("exit", ok)));
  proc.kill("SIGKILL");
  await exited;
  server.close();
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a leftover temp profile is harmless */ }
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report.map((r) => ({ lang: r.lang, samples: r.samples, texts: r.texts, findings: r.findings })), null, 2));
if (SELFTEST) {
  const f = report[0].findings;
  const want = { overlap: (x) => x.type === "overlap" && /#t-claude/.test(x.b) && /h1a/.test(x.a), small: (x) => x.type === "small" && /~\/\.claude/.test(x.a), soft: (x) => x.type === "soft" && /coding|kodlama/.test(x.a), short: (x) => x.type === "short" && /~\/\.codex/.test(x.a) };
  const missed = Object.entries(want).filter(([, ok]) => !f.some(ok)).map(([k]) => k);
  console.log(missed.length ? `\nSELFTEST: FAIL, not caught: ${missed.join(", ")}` : "\nSELFTEST: PASS, every planted violation was caught");
  process.exit(missed.length ? 1 : 0);
}
if (!SHOTS) console.log(failed ? "\nGATE: FAIL" : "\nGATE: PASS");
process.exit(failed ? 1 : 0);

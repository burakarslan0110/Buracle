// Writes the harness tiles and the MCP server tiles into index.html with every logo inlined as SVG markup, so a
// render never waits on (or loses) an image request. Run from site/video after changing assets/logos/ or the lists:
//   node tools/inline-logos.mjs
// Each logo's ids are prefixed with its file name so two inlined logos cannot clash.
import { readFileSync, writeFileSync } from "node:fs";

const HARNESS = [
  ["claude", "Claude Code", "claude-code.svg", "~/.claude"],
  ["codex", "Codex CLI", "codex.svg", "~/.codex"],
  ["opencode", "OpenCode", "opencode.svg", "~/.config/opencode"],
  ["omp", "Oh My Pi", "oh-my-pi.svg", "~/.omp/agent"],
  ["qwen", "Qwen Code", "qwen-code-mono.svg", "~/.qwen", "#ffffff"], // the white mark: it reads on the dark tiles
  ["pi", "Pi", "pi.svg", "~/.pi/agent"],
  ["agy", "AGY CLI", "agy.svg", "~/.gemini/config"],
];
// MCP servers in grid order (row by row). Two have no logo of their own and use the site's faces: "lsp" shows four of
// its six language servers in a 2x2 square, "web-search" (Open-WebSearch) shows Lucide's globe (ISC)
const ORBS = [
  ["context7", "context7.svg"],
  ["chrome-devtools", "chrome-devtools-mcp.svg"],
  ["lsp", "lsp"],
  ["codegraph", "codegraph-mono.svg"],
  ["web-fetch", "fetcher-mcp.svg"],
  ["buracle-memory", "cortexdb.svg"],
  ["semble", "semble.svg"],
  ["web-search", "globe"],
  ["grep", "grep-app-mono.svg"],
];

function logo(file, label, color) {
  const p = file.replace(/\.svg$/, "").replace(/[^a-z0-9]/gi, "");
  let s = readFileSync(new URL(`../assets/logos/${file}`, import.meta.url), "utf8").trim();
  s = s.replace(/\sid="([^"]+)"/g, ` id="${p}-$1"`).replace(/url\(#([^)]+)\)/g, `url(#${p}-$1)`).replace(/href="#([^"]+)"/g, `href="#${p}-$1"`);
  return s.replace(/^<svg /, `<svg role="img" aria-label="${label}" ${color ? `style="color:${color}" ` : ""}`);
}
const LSP = ["typescript.svg", "pyright.svg", "go.svg", "rust-light.svg"];
const GLOBE = '<svg role="img" aria-label="web-search" viewBox="0 0 24 24" fill="none" stroke="#e7edf5" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>';
const face = (id, file) => (file === "lsp" ? `<span class="lspgrid">${LSP.map((f) => logo(f, f.replace(/(-light)?\.svg$/, ""))).join("")}</span>` : file === "globe" ? GLOBE : logo(file, id));

const tiles = HARNESS.map(([id, name, file, path, color]) =>
  `          <div class="tile" id="t-${id}"><div class="tbox" data-deco>${logo(file, name, color)}<div class="tglow"></div></div><div class="tpath">${path}</div><div class="tname">${name}</div></div>`,
).join("\n");
const orbs = ORBS.map(([id, file]) =>
  `            <div class="orb" id="o-${id}"><div class="obox" data-deco>${face(id, file)}<div class="oglow"></div></div><div class="oname">${id}</div></div>`,
).join("\n");

const path = new URL("../index.html", import.meta.url);
let html = readFileSync(path, "utf8");
const put = (name, body) => {
  const re = new RegExp(`(<!-- logos:${name} -->)[\\s\\S]*?(\\s*<!-- /logos:${name} -->)`);
  if (!re.test(html)) throw new Error(`marker logos:${name} not found`);
  html = html.replace(re, `$1\n${body}$2`);
};
put("tiles", tiles);
put("orbs", orbs);
writeFileSync(path, html);
console.log(`inlined ${HARNESS.length} harness logos and ${ORBS.length} server faces`);

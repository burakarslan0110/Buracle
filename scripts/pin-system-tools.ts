// Pins the system tools Buracle downloads when no package manager can install them (node, uv, rg, jq).
//
//   bun scripts/pin-system-tools.ts            rewrite src/engine/toolchain/system-pins.ts from the newest releases
//   bun scripts/pin-system-tools.ts --node 26.13.0 --uv 0.13.6 --rg 15.2.0 --jq 1.8.2
//                                              the same for the versions given (any subset)
//   bun scripts/pin-system-tools.ts --verify   download every pinned tool of this platform into a temp folder with
//                                              Buracle's own download code, check its sha256, unpack it and run it
//
// The hashes come from the checksum files each project publishes next to its release (Node.js SHASUMS256.txt,
// uv's and ripgrep's <asset>.sha256, jq's sha256sum.txt). A Buracle release moves the pins; `toolchain.upgrade`
// never does. This is a development tool: `buracle install` never runs it.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

type Platform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win32-x64'
const PLATFORMS: readonly Platform[] = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']
type Tool = 'node' | 'uv' | 'rg' | 'jq'
const TOOLS: readonly Tool[] = ['node', 'uv', 'rg', 'jq']

const UA = { 'user-agent': 'buracle-pin-system-tools' }
const OUT = join(import.meta.dir, '..', 'src', 'engine', 'toolchain', 'system-pins.ts')

async function text(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return res.text()
}

async function latestTag(repo: string): Promise<string> {
  const url = `https://github.com/${repo}/releases/latest`
  const res = await fetch(url, { headers: UA, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
  const tag = /\/releases\/tag\/([^/?#]+)/.exec(res.headers.get('location') ?? '')?.[1]
  if (tag === undefined) throw new Error(`${url} did not redirect to a release (HTTP ${res.status})`)
  return decodeURIComponent(tag)
}

async function latestNodeLts(): Promise<string> {
  const index = JSON.parse(await text('https://nodejs.org/dist/index.json')) as Array<{ version: string, lts: string | false }>
  const lts = index.find(e => e.lts !== false)
  if (lts === undefined) throw new Error('nodejs.org lists no LTS release')
  return lts.version.replace(/^v/, '')
}

/** `<hash>  <name>` or `<hash> *<name>` lines; the hash of `name`. */
function hashIn(sums: string, name: string, source: string): string {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim())
    if (m !== null && m[2] === name) return (m[1] as string).toLowerCase()
  }
  throw new Error(`${source} has no sha256 for ${name}`)
}

interface Asset { url: string, sha256: string, format: 'tar.gz' | 'zip' | 'bin', bins: Record<string, string> }

const win = (p: Platform) => p === 'win32-x64'

async function nodeAssets(v: string): Promise<Record<Platform, Asset>> {
  const base = `https://nodejs.org/dist/v${v}`
  const sums = await text(`${base}/SHASUMS256.txt`)
  const name = (p: Platform) => (win(p) ? `node-v${v}-win-x64.zip` : `node-v${v}-${p}.tar.gz`)
  const out = {} as Record<Platform, Asset>
  for (const p of PLATFORMS) {
    out[p] = {
      url: `${base}/${name(p)}`, sha256: hashIn(sums, name(p), `${base}/SHASUMS256.txt`), format: win(p) ? 'zip' : 'tar.gz',
      bins: win(p) ? { node: 'node.exe', npm: 'npm.cmd', npx: 'npx.cmd' } : { node: 'bin/node', npm: 'bin/npm', npx: 'bin/npx' },
    }
  }
  return out
}

const TRIPLES: Record<'uv' | 'rg', Record<Platform, string>> = {
  uv: { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu', 'win32-x64': 'x86_64-pc-windows-msvc' },
  // ripgrep publishes no glibc build for x86_64 Linux; the static musl build runs everywhere.
  rg: { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-gnu', 'win32-x64': 'x86_64-pc-windows-msvc' },
}

// A per-asset file holds `<hash>  <name>`, or (ripgrep's Windows builds) PowerShell's "SHA256 hash of <name>:" with the
// hash on the next line: one 64-digit hash in a file that names the asset.
async function perAssetSha(url: string, name: string): Promise<string> {
  const body = await text(`${url}.sha256`)
  try { return hashIn(body, name, `${url}.sha256`) } catch (e) {
    const hashes = body.match(/\b[0-9a-f]{64}\b/gi) ?? []
    if (body.includes(name) && hashes.length === 1) return (hashes[0] as string).toLowerCase()
    throw e
  }
}

async function uvAssets(v: string): Promise<Record<Platform, Asset>> {
  const out = {} as Record<Platform, Asset>
  for (const p of PLATFORMS) {
    const name = `uv-${TRIPLES.uv[p]}.${win(p) ? 'zip' : 'tar.gz'}`
    const url = `https://github.com/astral-sh/uv/releases/download/${v}/${name}`
    out[p] = { url, sha256: await perAssetSha(url, name), format: win(p) ? 'zip' : 'tar.gz', bins: win(p) ? { uv: 'uv.exe', uvx: 'uvx.exe' } : { uv: 'uv', uvx: 'uvx' } }
  }
  return out
}

async function rgAssets(v: string): Promise<Record<Platform, Asset>> {
  const out = {} as Record<Platform, Asset>
  for (const p of PLATFORMS) {
    const name = `ripgrep-${v}-${TRIPLES.rg[p]}.${win(p) ? 'zip' : 'tar.gz'}`
    const url = `https://github.com/BurntSushi/ripgrep/releases/download/${v}/${name}`
    out[p] = { url, sha256: await perAssetSha(url, name), format: win(p) ? 'zip' : 'tar.gz', bins: { rg: win(p) ? 'rg.exe' : 'rg' } }
  }
  return out
}

const JQ_NAMES: Record<Platform, string> = { 'darwin-arm64': 'jq-macos-arm64', 'darwin-x64': 'jq-macos-amd64', 'linux-x64': 'jq-linux-amd64', 'linux-arm64': 'jq-linux-arm64', 'win32-x64': 'jq-windows-amd64.exe' }

async function jqAssets(v: string): Promise<Record<Platform, Asset>> {
  const base = `https://github.com/jqlang/jq/releases/download/jq-${v}`
  const sums = await text(`${base}/sha256sum.txt`)
  const out = {} as Record<Platform, Asset>
  for (const p of PLATFORMS) {
    out[p] = { url: `${base}/${JQ_NAMES[p]}`, sha256: hashIn(sums, JQ_NAMES[p], `${base}/sha256sum.txt`), format: 'bin', bins: { jq: win(p) ? 'jq.exe' : 'jq' } }
  }
  return out
}

function render(pins: Record<Tool, { version: string, assets: Record<Platform, Asset> }>): string {
  const lines: string[] = [
    '// Generated by scripts/pin-system-tools.ts: do not edit by hand. Run `bun scripts/pin-system-tools.ts` to move the pins.',
    '// node, uv, rg and jq at fixed versions, with the sha256 their projects published for each download. Buracle',
    '// downloads one only when it is missing and no package manager (Homebrew, winget, scoop) can install it.',
    '',
    "export type PinPlatform = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win32-x64'",
    "export type PinFormat = 'tar.gz' | 'zip' | 'bin'",
    "export type PinnedToolName = 'node' | 'uv' | 'rg' | 'jq'",
    '',
    '/** One download: its URL, its sha256, how it is packed and where each program sits in the unpacked tool folder. */',
    'export interface PinnedAsset { url: string, sha256: string, format: PinFormat, bins: Readonly<Record<string, string>> }',
    'export interface PinnedTool { version: string, assets: Readonly<Partial<Record<PinPlatform, PinnedAsset>>> }',
    '',
    'export const SYSTEM_TOOL_PINS: Readonly<Record<PinnedToolName, PinnedTool>> = {',
  ]
  for (const t of TOOLS) {
    lines.push(`  ${t}: {`, `    version: '${pins[t].version}',`, '    assets: {')
    for (const p of PLATFORMS) {
      const a = pins[t].assets[p]
      const bins = Object.entries(a.bins).map(([k, v]) => `${k}: '${v}'`).join(', ')
      lines.push(`      '${p}': { url: '${a.url}', sha256: '${a.sha256}', format: '${a.format}', bins: { ${bins} } },`)
    }
    lines.push('    },', '  },')
  }
  lines.push('}', '')
  return lines.join('\n')
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

async function pin(argv: string[]): Promise<void> {
  const versions: Record<Tool, string> = {
    node: flag(argv, 'node') ?? await latestNodeLts(),
    uv: flag(argv, 'uv') ?? await latestTag('astral-sh/uv'),
    rg: flag(argv, 'rg') ?? await latestTag('BurntSushi/ripgrep'),
    jq: flag(argv, 'jq') ?? (await latestTag('jqlang/jq')).replace(/^jq-/, ''),
  }
  const pins = {
    node: { version: versions.node, assets: await nodeAssets(versions.node) },
    uv: { version: versions.uv, assets: await uvAssets(versions.uv) },
    rg: { version: versions.rg, assets: await rgAssets(versions.rg) },
    jq: { version: versions.jq, assets: await jqAssets(versions.jq) },
  }
  writeFileSync(OUT, render(pins))
  for (const t of TOOLS) console.log(`${t} ${versions[t]}: ${PLATFORMS.length} platforms pinned`)
  console.log(`wrote ${OUT}`)
}

async function verify(): Promise<number> {
  const { installPinnedTool, pinPlatform } = await import('../src/engine/toolchain/system-download')
  const { SYSTEM_TOOL_PINS } = await import('../src/engine/toolchain/system-pins')
  const { readToolsCatalog } = await import('../src/engine/toolchain/lsp')
  const { spawnArgv, windowsVerbatim } = await import('../src/engine/platform')
  const catalog = readToolsCatalog(join(import.meta.dir, '..', 'canonical', 'tools.yaml'))
  const platform = pinPlatform()
  if (platform === undefined) { console.error(`no pins for ${process.platform}-${process.arch}`); return 1 }
  const root = mkdtempSync(join(tmpdir(), 'buracle-pins-'))
  let failed = 0
  try {
    for (const t of TOOLS) {
      const spec = catalog.tools.find(x => x.name === t)
      if (spec === undefined) { failed++; console.error(`FAIL ${t}: not in canonical/tools.yaml`); continue }
      const r = await installPinnedTool(t, { root, check: { argv: spec.check, regex: spec.version_regex } })
      if (!r.ok) { failed++; console.error(`FAIL ${t} ${SYSTEM_TOOL_PINS[t].version} (${platform}): ${r.error}`); continue }
      console.log(`ok   ${t} ${SYSTEM_TOOL_PINS[t].version} (${platform}): \`${spec.check.join(' ')}\` -> ${r.check}`)
      // npm is a node script: it runs only with the downloaded node first on PATH, as the toolchain starts it.
      const npm = r.bins['npm']
      const nodeBin = r.bins['node']
      if (t === 'node' && npm !== undefined && nodeBin !== undefined) {
        const PATH = `${dirname(nodeBin)}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH'] ?? ''}`
        // npm.cmd on Windows: the product's own launcher builds the cmd.exe line and keeps its quotes intact.
        const argv = spawnArgv([npm, '--version'])
        const out = Bun.spawnSync(argv, { env: { ...process.env, PATH }, stdout: 'pipe', stderr: 'pipe', windowsVerbatimArguments: windowsVerbatim(argv) })
        if (out.exitCode === 0) console.log(`ok   npm with node ${SYSTEM_TOOL_PINS[t].version}: ${out.stdout.toString().trim()}`)
        else { failed++; console.error(`FAIL npm with node ${SYSTEM_TOOL_PINS[t].version}: ${out.stderr.toString().trim()}`) }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  console.log(`${TOOLS.length - failed}/${TOOLS.length} pinned tools downloaded, verified and run on ${platform}`)
  return failed === 0 ? 0 : 1
}

const argv = process.argv.slice(2)
if (argv.includes('--verify')) process.exit(await verify())
await pin(argv)

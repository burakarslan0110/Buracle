import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

export const PROTECTED_TARGETS: readonly string[] = [
  '.claude/settings.json', '.claude/settings.local.json', '.claude/CLAUDE.md', '.claude/AGENTS.md',
  '.claude/rules', '.claude/skills', '.claude/agents', '.claude/commands', '.claude/hooks',
  '.claude/plugins/known_marketplaces.json', '.claude/plugins/installed_plugins.json', '.claude/plugins/config.json',
  '.codex/config.toml', '.codex/hooks.json', '.codex/AGENTS.md', '.codex/agents', '.codex/rules', '.codex/skills',
  '.config/opencode',
  '.omp/agent/config.yml', '.omp/agent/AGENTS.md', '.omp/agent/RULES.md', '.omp/agent/mcp.json',
  '.omp/agent/extensions', '.omp/agent/skills', '.omp/agent/rules', '.omp/plugins',
  '.agents/skills',
  '.buracle/config.yaml', '.buracle/bin', '.buracle/state/owned.json', '.buracle/state/runtime-config.json',
  '.buracle/journal', '.buracle/backups',
  '.local/bin/buracle',
  'Documents/Buracle',
]

const EXCLUDE: readonly RegExp[] = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /^\.config\/opencode\/(package\.json|package-lock\.json|bun\.lockb?|\.gitignore)$/,
  /^Documents\/Buracle\/\.obsidian\/workspace[^/]*\.json$/,
  /^Documents\/Buracle\/\.trash(\/|$)/,
]

const MAX_HASH_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 50_000

export type Fingerprint = Record<string, string>

function excluded(rel: string): boolean {
  return EXCLUDE.some(re => re.test(rel))
}

function visit(home: string, rel: string, out: Fingerprint, budget: { left: number }): void {
  if (excluded(rel) || budget.left <= 0) return
  budget.left--
  const abs = join(home, rel)
  let st
  try { st = lstatSync(abs) } catch { out[rel] = 'missing'; return }
  if (st.isSymbolicLink()) {
    let target = '?'
    try { target = readlinkSync(abs) } catch {  }
    out[rel] = `link:${target}`
    return
  }
  if (st.isDirectory()) {
    out[rel] = `dir:${(st.mode & 0o7777).toString(8)}`
    let names: string[] = []
    try { names = readdirSync(abs).sort() } catch { out[rel] += ':unreadable'; return }
    for (const n of names) visit(home, `${rel}/${n}`, out, budget)
    return
  }
  if (st.isFile()) {
    if (st.size > MAX_HASH_BYTES) { out[rel] = `big:${st.size}:${st.mtimeMs}`; return }
    let digest = 'unreadable'
    try { digest = createHash('sha256').update(readFileSync(abs)).digest('hex') } catch {  }
    out[rel] = `file:${(st.mode & 0o7777).toString(8)}:${digest}`
    return
  }
  out[rel] = 'other'
}

export function fingerprintHome(home: string, targets: readonly string[] = PROTECTED_TARGETS): Fingerprint {
  const out: Fingerprint = {}
  const budget = { left: MAX_ENTRIES }
  for (const t of targets) visit(home, t, out, budget)
  return out
}

export function diffFingerprints(before: Fingerprint, after: Fingerprint): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: string[] = []
  for (const k of [...keys].sort()) {
    const a = before[k]
    const b = after[k]
    if (a === b) continue
    out.push(`${k}: ${a ?? '(absent)'} -> ${b ?? '(absent)'}`)
  }
  return out
}

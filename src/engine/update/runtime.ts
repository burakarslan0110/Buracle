import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { isFailClosedReason } from '../hook-fail'
import { renameRetrySync, sha256 } from '../fsx'
import * as paths from '../paths'
import { readShim, type ShimInfo } from '../shim'
import { run } from '../proc'

export type RuntimeMode = 'frozen' | 'checkout'

export function runtimeModeFromEnv(): RuntimeMode {
  return (process.env['BURACLE_RUNTIME'] ?? '').trim().toLowerCase() === 'checkout' ? 'checkout' : 'frozen'
}

export interface RuntimeMarker {
  v: 1
  id: string
  checkout: string
  commit?: string
  dirty?: boolean
  fingerprint: string
  version: string
  createdAt: string
  verifiedAt?: string
  bun: string
}

export const RUNTIME_FILES: readonly string[] = ['package.json', 'bun.lock', 'tsconfig.json']
export const RUNTIME_DIRS: readonly string[] = ['src', 'canonical', 'harness']
const SKIP_NAMES = new Set(['.DS_Store', 'node_modules', '.git'])

interface Dep { name: string, version: string, dir: string }

export function runtimeFiles(checkout: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    let entries
    try { entries = readdirSync(join(checkout, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (SKIP_NAMES.has(e.name)) continue
      const r = join(rel, e.name)
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) out.push(r)
    }
  }
  for (const d of RUNTIME_DIRS) walk(d)
  for (const f of RUNTIME_FILES) if (existsSync(join(checkout, f))) out.push(f)
  return out.map(p => p.split(sep).join('/')).sort()
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
  } catch { return undefined }
}

function depsOf(pkg: Record<string, unknown> | undefined): Record<string, string> {
  const d = pkg?.['dependencies']
  const out: Record<string, string> = {}
  if (d !== null && typeof d === 'object') for (const [k, v] of Object.entries(d)) if (typeof v === 'string') out[k] = v
  return out
}

export function runtimePackages(checkout: string): { deps: Dep[] } | { error: string } {
  const root = readJson(join(checkout, 'package.json'))
  if (root === undefined) return { error: `${join(checkout, 'package.json')} cannot be read` }
  let lock = ''
  try { lock = readFileSync(join(checkout, 'bun.lock'), 'utf8') } catch {  }
  const locked = (name: string): string | undefined => {
    const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    return new RegExp(`"${esc}":\\s*\\["${esc}@([^"]+)"`).exec(lock)?.[1]
  }
  const found = new Map<string, Dep>()
  const queue: Array<[string, string]> = Object.entries(depsOf(root))
  const problems: string[] = []
  while (queue.length > 0) {
    const [name, want] = queue.shift() as [string, string]
    if (found.has(name)) continue
    const dir = join(checkout, 'node_modules', ...name.split('/'))
    const pkg = readJson(join(dir, 'package.json'))
    const have = typeof pkg?.['version'] === 'string' ? pkg['version'] : undefined
    if (have === undefined) { problems.push(`${name} is not installed`); continue }
    if (/^\d+\.\d+\.\d+/.test(want) && have !== want) problems.push(`${name} is ${have}, package.json pins ${want}`)
    const lv = locked(name)
    if (lv !== undefined && lv !== have) problems.push(`${name} is ${have}, bun.lock has ${lv}`)
    found.set(name, { name, version: have, dir })
    queue.push(...Object.entries(depsOf(pkg)))
  }
  if (problems.length > 0) return { error: `node_modules does not match package.json and bun.lock (${problems.join('; ')}); run \`bun install --frozen-lockfile\` in ${checkout}` }
  return { deps: [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1)) }
}

function fileEntry(rel: string, content: Uint8Array, mode: number): string {
  return `${rel}\0${mode & 0o111 ? 1 : 0}\0${sha256(content)}\n`
}

export function checkoutFingerprint(checkout: string, deps: readonly Dep[]): string {
  const parts: string[] = []
  for (const rel of runtimeFiles(checkout)) {
    const abs = join(checkout, rel)
    try { parts.push(fileEntry(rel, readFileSync(abs), statSync(abs).mode)) } catch { parts.push(`${rel}\0missing\n`) }
  }
  for (const d of deps) parts.push(`node_modules/${d.name}@${d.version}\n`)
  return sha256(parts.join(''))
}

export function runtimeDirFingerprint(dir: string): string | undefined {
  const pk = runtimePackages(dir)
  return 'error' in pk ? undefined : checkoutFingerprint(dir, pk.deps)
}

export interface RuntimePlan {
  checkout: string
  id: string
  dir: string
  main: string
  fingerprint: string
  deps: Dep[]
}

const RUNTIME_ID = /^[0-9a-f]{16}$/

export function planRuntime(checkout: string): RuntimePlan | { error: string } {
  if (!paths.isCheckout(checkout)) return { error: `${checkout} is not a Buracle checkout` }
  if (paths.isFrozenRuntime(checkout)) return { error: `${checkout} is a frozen runtime; run \`buracle install\` from the checkout` }
  if (!existsSync(join(checkout, 'src', 'cli', 'main.ts'))) return { error: `${checkout} has no src/cli/main.ts` }
  const pk = runtimePackages(checkout)
  if ('error' in pk) return pk
  const fingerprint = checkoutFingerprint(checkout, pk.deps)
  const id = fingerprint.slice(0, 16)
  const dir = join(paths.runtimeRoot(), id)
  return { checkout, id, dir, main: join(dir, 'src', 'cli', 'main.ts'), fingerprint, deps: pk.deps }
}

export function readMarker(dir: string): RuntimeMarker | undefined {
  const m = readJson(join(dir, paths.RUNTIME_MARKER))
  if (m === undefined || m['v'] !== 1 || typeof m['id'] !== 'string' || typeof m['fingerprint'] !== 'string' || typeof m['checkout'] !== 'string') return undefined
  return m as unknown as RuntimeMarker
}

function git(dir: string, args: string[]): string | undefined {
  try {
    const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } })
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined
  } catch { return undefined }
}

export function checkoutGitState(checkout: string): { commit?: string, dirty?: boolean } {
  const commit = git(checkout, ['rev-parse', 'HEAD'])
  if (commit === undefined) return {}
  const st = git(checkout, ['status', '--porcelain', '--untracked-files=no'])
  return st === undefined ? { commit } : { commit, dirty: st !== '' }
}

function copyRuntime(plan: RuntimePlan, dest: string): string {
  const parts: string[] = []
  for (const rel of runtimeFiles(plan.checkout)) {
    const src = join(plan.checkout, rel)
    const out = join(dest, rel)
    const content = readFileSync(src)
    const mode = statSync(src).mode
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, content)
    chmodSync(out, mode & 0o777)
    parts.push(fileEntry(rel, content, mode))
  }
  for (const d of plan.deps) {
    cpSync(d.dir, join(dest, 'node_modules', ...d.name.split('/')), { recursive: true, dereference: true })
    parts.push(`node_modules/${d.name}@${d.version}\n`)
  }
  return sha256(parts.join(''))
}

function probePayload(harness: 'claude' | 'codex', command: string): string {
  const base = { session_id: 'buracle-runtime-probe', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: paths.home(), permission_mode: 'bypassPermissions' }
  return JSON.stringify(harness === 'codex' ? { ...base, turn_id: 't0', transcript_path: null, model: 'probe', tool_use_id: 'probe' } : base)
}

const PROBE_ENV = { BURACLE_NO_CAPTURE: '1', BURACLE_NO_MEMORY: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_NOTIFY: '1', BURACLE_HOOK_TIMEOUT_MS: undefined }

function decisionOf(stdout: string): { decision?: unknown, reason?: unknown } {
  try {
    const o = JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown, permissionDecisionReason?: unknown } }
    return { decision: o.hookSpecificOutput?.permissionDecision, reason: o.hookSpecificOutput?.permissionDecisionReason }
  } catch { return {} }
}

export async function verifyRuntime(main: string, bun: string, timeoutMs = 30_000): Promise<string[]> {
  const problems: string[] = []
  const first = (s: string) => (s.trim().split('\n')[0] ?? '').slice(0, 200)
  const v = await run([bun, main, '--version'], { timeoutMs, cwd: paths.home(), env: PROBE_ENV })
  if (v.code !== 0 || !/^buracle \S+/.test(v.stdout.trim())) problems.push(`\`buracle --version\` failed (exit ${v.code}${v.stderr.trim() !== '' ? `: ${first(v.stderr)}` : ''})`)
  for (const h of ['claude', 'codex'] as const) {
    const deny = await run([bun, main, 'hook', h, 'PreToolUse'], { stdin: probePayload(h, 'rm -rf ~'), timeoutMs, cwd: paths.home(), env: PROBE_ENV })
    const d = decisionOf(deny.stdout)
    if (d.decision !== 'deny') problems.push(`the ${h} PreToolUse hook did not deny \`rm -rf ~\` (exit ${deny.code}${deny.timedOut ? ', timed out' : ''}${deny.stderr.trim() !== '' ? `: ${first(deny.stderr)}` : ''})`)
    else if (isFailClosedReason(d.reason)) problems.push(`the ${h} PreToolUse hook cannot run: ${String(d.reason).slice(0, 300)}`)
    const allow = await run([bun, main, 'hook', h, 'PreToolUse'], { stdin: probePayload(h, 'ls'), timeoutMs, cwd: paths.home(), env: PROBE_ENV })
    const a = decisionOf(allow.stdout)
    if (allow.code !== 0 || a.decision === 'deny') problems.push(`the ${h} PreToolUse hook did not let \`ls\` through (exit ${allow.code}${a.reason !== undefined ? `: ${String(a.reason).slice(0, 300)}` : ''})`)
  }
  for (const h of ['claude', 'codex'] as const) {
    try { rmSync(paths.sessionDir(h, 'buracle-runtime-probe'), { recursive: true, force: true }) } catch {  }
  }
  return problems
}

export interface StagedRuntime { plan: RuntimePlan; marker: RuntimeMarker; reused: boolean }

export async function stageRuntime(plan: RuntimePlan, opts: { bun: string, version: string, nowIso: string }): Promise<StagedRuntime> {
  const existing = readMarker(plan.dir)
  if (existing !== undefined && existing.fingerprint === plan.fingerprint && existing.verifiedAt !== undefined && existsSync(plan.main)
    && runtimeDirFingerprint(plan.dir) === existing.fingerprint && (await verifyRuntime(plan.main, opts.bun)).length === 0) {
    return { plan, marker: existing, reused: true }
  }
  const root = paths.runtimeRoot()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const staging = join(root, `.staging-${process.pid}-${Math.floor(Math.random() * 0xffffff).toString(16)}`)
  try {
    const fingerprint = copyRuntime(plan, staging)
    const g = checkoutGitState(plan.checkout)
    const marker: RuntimeMarker = { v: 1, id: plan.id, checkout: plan.checkout, fingerprint, version: opts.version, createdAt: opts.nowIso, bun: opts.bun }
    if (g.commit !== undefined) marker.commit = g.commit
    if (g.dirty !== undefined) marker.dirty = g.dirty
    writeFileSync(join(staging, paths.RUNTIME_MARKER), JSON.stringify(marker, null, 2) + '\n')
    const problems = await verifyRuntime(join(staging, 'src', 'cli', 'main.ts'), opts.bun)
    if (problems.length > 0) throw new Error(`the new runtime failed its check, so the shim still runs the old one: ${problems.join('; ')}`)
    marker.verifiedAt = opts.nowIso
    writeFileSync(join(staging, paths.RUNTIME_MARKER), JSON.stringify(marker, null, 2) + '\n')
    if (existsSync(plan.dir)) rmSync(plan.dir, { recursive: true, force: true })
    renameRetrySync(staging, plan.dir)
    return { plan, marker, reused: false }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

export { parseShimText, readShim, type ShimInfo } from '../shim'

export function runtimeDirOf(info: ShimInfo | undefined): string | undefined {
  if (info === undefined || info.mode !== 'frozen') return undefined
  const dir = resolve(info.main, '..', '..', '..')
  const rel = relative(paths.runtimeRoot(), dir)
  return rel !== '' && !rel.startsWith('..') && !rel.includes(sep) ? dir : undefined
}

export function pruneRuntimes(keep: readonly string[]): string[] {
  const root = paths.runtimeRoot()
  let names: string[]
  try { names = readdirSync(root) } catch { return [] }
  const keepIds = new Set(keep.filter(k => resolve(dirname(k)) === resolve(root)).map(k => basename(k)))
  const others = names.filter(n => RUNTIME_ID.test(n) && !keepIds.has(n)).map(n => ({ n, m: readMarker(join(root, n)) }))
  const previous = others.filter(o => o.m?.verifiedAt !== undefined).sort((a, b) => ((a.m?.createdAt ?? '') < (b.m?.createdAt ?? '') ? 1 : -1))
    .find(o => runtimeDirFingerprint(join(root, o.n)) === o.m?.fingerprint)
  const removed: string[] = []
  for (const o of others) {
    if (o.n === previous?.n) continue
    try { rmSync(join(root, o.n), { recursive: true, force: true }); removed.push(o.n) } catch {  }
  }
  for (const n of names) if (n.startsWith('.staging-')) { try { rmSync(join(root, n), { recursive: true, force: true }) } catch {  } }
  return removed
}

export function discardRuntime(dir: string): void {
  if (runtimeDirOf(readShim()) === resolve(dir)) return
  if (resolve(dirname(dir)) !== resolve(paths.runtimeRoot()) || !RUNTIME_ID.test(basename(dir))) return
  try { rmSync(dir, { recursive: true, force: true }) } catch {  }
}

export type RuntimeDrift = 'current' | 'behind' | 'ahead' | 'diverged' | 'modified' | 'unknown'

export interface RuntimeHealth {
  shim?: ShimInfo
  dir?: string
  marker?: RuntimeMarker
  problems: string[]
  checkout?: string
  drift?: RuntimeDrift
  detail?: string
}

export function runtimeHealth(checkout: string | undefined, shim: ShimInfo | undefined = readShim()): RuntimeHealth {
  const h: RuntimeHealth = { problems: [] }
  if (shim !== undefined) h.shim = shim
  if (checkout !== undefined) h.checkout = checkout
  if (shim?.mode !== 'frozen') return h
  const dir = runtimeDirOf(shim)
  if (dir === undefined) { h.problems.push(`the shim runs ${shim.main}, which is not under ${paths.runtimeRoot()}`); return h }
  h.dir = dir
  if (!existsSync(shim.main)) { h.problems.push(`the live runtime ${dir} is missing: Claude Code and Codex hooks deny every tool call (fail closed) until \`buracle install\` (or \`bun src/cli/main.ts install\` in the checkout) restores it`); return h }
  const marker = readMarker(dir)
  if (marker === undefined) { h.problems.push(`the live runtime ${dir} has no readable ${paths.RUNTIME_MARKER}; run \`buracle install\``); return h }
  h.marker = marker
  if (marker.verifiedAt === undefined) h.problems.push(`the live runtime ${dir} never passed its guard probe; run \`buracle install\``)
  else if (runtimeDirFingerprint(dir) !== marker.fingerprint) h.problems.push(`the files of the live runtime ${dir} changed after it was checked (damaged or edited by hand); run \`buracle install\` to replace it`)
  if (checkout === undefined) return h
  const pk = runtimePackages(checkout)
  if ('error' in pk) { h.drift = 'unknown'; h.detail = `the checkout cannot be compared: ${pk.error}`; return h }
  if (checkoutFingerprint(checkout, pk.deps) === marker.fingerprint) {
    h.drift = 'current'
    h.detail = `runtime ${marker.id} matches the checkout${marker.commit !== undefined ? ` (${marker.commit.slice(0, 10)}${marker.dirty === true ? ' with uncommitted changes' : ''})` : ''}`
    return h
  }
  const g = checkoutGitState(checkout)
  if (g.commit === undefined || marker.commit === undefined) { h.drift = 'modified'; h.detail = 'the checkout differs from the live runtime; run `buracle install` to make the changes live'; return h }
  const short = (c: string) => c.slice(0, 10)
  if (g.commit === marker.commit) { h.drift = 'modified'; h.detail = `the checkout (${short(g.commit)}) has changes the live runtime does not have; run \`buracle install\` to make them live`; return h }
  const count = (range: string) => { const n = Number(git(checkout, ['rev-list', '--count', range])); return Number.isFinite(n) ? n : undefined }
  const behind = count(`${marker.commit}..${g.commit}`)
  const ahead = count(`${g.commit}..${marker.commit}`)
  if (behind === undefined || ahead === undefined) { h.drift = 'unknown'; h.detail = `the live runtime was copied from ${short(marker.commit)}, which the checkout (${short(g.commit)}) does not know; run \`buracle install\``; return h }
  h.drift = ahead === 0 ? 'behind' : behind === 0 ? 'ahead' : 'diverged'
  h.detail = h.drift === 'behind' ? `the live runtime is ${behind} commit(s) behind the checkout (${short(marker.commit)} to ${short(g.commit)}); run \`buracle install\``
    : h.drift === 'ahead' ? `the live runtime is ${ahead} commit(s) ahead of the checkout (${short(marker.commit)}; the checkout is at ${short(g.commit)}); run \`buracle install\` to run the checkout's code`
    : `the live runtime (${short(marker.commit)}) and the checkout (${short(g.commit)}) have diverged; run \`buracle install\``
  return h
}

export function packagesProblem(dir: string): string | undefined {
  const r = runtimePackages(dir)
  return 'error' in r ? r.error : undefined
}

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export type Dict = Record<string, string>
export type Stream = 'stdout' | 'stderr' | 'both'
export type Op = '>=' | '<=' | '>' | '<' | '==' | '!='

export interface PatternSpec { pattern: string; stream: Stream; flags: string }
export interface Compiled { name: string; re: RegExp; stream: Stream }
export interface CountCond { op: Op; n: number }
export type ExitCond = { kind: 'code'; code: number } | { kind: 'nonzero' } | { kind: 'any' }

export interface GraderSpec {
  argv: string[]
  env: Dict
  timeoutMs: number | undefined
  output: string | undefined
  model: string | undefined
  effort: string | undefined
}

export interface Profile {
  argv: string[] | undefined
  cwd: string | undefined
  env: Dict
  timeoutMs: number | undefined
  probes: Record<string, PatternSpec>
  metrics: Record<string, PatternSpec>
  grader: GraderSpec | undefined
}

export interface FileCheck { path: string; exists: boolean; matches: string | undefined }

export interface Case {
  id: string
  prompt: string
  tags: string[]
  expect: Record<string, CountCond>
  exit: ExitCond
  files: FileCheck[]
  fixture: string | undefined
  git: boolean
  allowTimeout: boolean
  argv: string[] | undefined
  cwd: string | undefined
  env: Dict
  stdin: string | undefined
  timeoutMs: number | undefined
  probes: Record<string, PatternSpec>
  rubric: string[]
}

export interface Prepared { c: Case; argv: string[]; probes: Compiled[]; metrics: Compiled[] }

export interface RunRecord {
  v: 1
  ts: string
  arm: string
  case: string
  run: number
  tags: string[]
  argv: string[]
  cwd: string
  exit: number | null
  signal: string | null
  timedOut: boolean
  startError: string | null
  streamsLeftOpen: boolean
  durationMs: number
  stdoutBytes: number
  stderrBytes: number
  stdoutPath: string
  stderrPath: string
  tail: string
  probes: Record<string, number>
  metrics: Record<string, number | null>
  files: Array<{ path: string; ok: boolean; detail: string }>
  checks: Record<string, boolean>
  pass: boolean
}

export class InputError extends Error {}

export const ID_RE = /^[A-Za-z0-9._-]{1,80}$/
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
export const DEFAULT_TIMEOUT_MS = 600_000
export const KILL_GRACE_MS = 5_000
export const STREAM_GRACE_MS = 5_000
export const TAIL_CHARS = 1_500
export const SESSION_VARS = new Set([
  'BURACLE_SESSION_ID', 'BURACLE_HARNESS', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'OPENCODE_SESSION_ID', 'OMP_SESSION_ID',
])
export const SECRET_RE = /(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})/g
export const SECRET_FLAG_RE = /^(--?(?:api-key|token|password|secret))(=.*)?$/i

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

export function str(x: unknown, where: string): string {
  if (typeof x !== 'string') throw new InputError(`${where} must be a string`)
  return x
}

export function optStr(x: unknown, where: string): string | undefined {
  return x === undefined ? undefined : str(x, where)
}

export function strArray(x: unknown, where: string): string[] {
  if (!Array.isArray(x)) throw new InputError(`${where} must be an array of strings`)
  return x.map((v, i) => str(v, `${where}[${i}]`))
}

export function bool(x: unknown, where: string): boolean {
  if (x === undefined) return false
  if (typeof x !== 'boolean') throw new InputError(`${where} must be true or false`)
  return x
}

export function dict(x: unknown, where: string): Dict {
  if (x === undefined) return {}
  if (!isObject(x)) throw new InputError(`${where} must be an object of strings`)
  const out: Dict = {}
  for (const [k, v] of Object.entries(x)) out[k] = str(v, `${where}.${k}`)
  return out
}

export function optPositiveInt(x: unknown, where: string): number | undefined {
  if (x === undefined) return undefined
  if (typeof x !== 'number' || !Number.isInteger(x) || x <= 0) throw new InputError(`${where} must be a positive integer`)
  return x
}

export function patternSpec(x: unknown, where: string): PatternSpec {
  if (typeof x === 'string') return { pattern: x, stream: 'stdout', flags: '' }
  if (!isObject(x)) throw new InputError(`${where} must be a regex string or {pattern, stream?, flags?}`)
  const stream = x.stream === undefined ? 'stdout' : str(x.stream, `${where}.stream`)
  if (stream !== 'stdout' && stream !== 'stderr' && stream !== 'both') throw new InputError(`${where}.stream must be stdout, stderr or both`)
  const flags = x.flags === undefined ? '' : str(x.flags, `${where}.flags`)
  if (/[^imsu]/.test(flags)) throw new InputError(`${where}.flags may contain only i, m, s and u`)
  return { pattern: str(x.pattern, `${where}.pattern`), stream, flags }
}

export function patternMap(x: unknown, where: string): Record<string, PatternSpec> {
  if (x === undefined) return {}
  if (!isObject(x)) throw new InputError(`${where} must be an object`)
  const out: Record<string, PatternSpec> = {}
  for (const [k, v] of Object.entries(x)) out[k] = patternSpec(v, `${where}.${k}`)
  return out
}

export function countCond(v: unknown, where: string): CountCond {
  if (v === true) return { op: '>=', n: 1 }
  if (v === false) return { op: '==', n: 0 }
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return { op: '==', n: v }
  if (typeof v === 'string') {
    const m = /^\s*(>=|<=|==|!=|>|<)?\s*(\d+)\s*$/.exec(v)
    if (m) return { op: (m[1] ?? '==') as Op, n: Number(m[2]) }
  }
  throw new InputError(`${where} must be true, false, a count, or ">=n", "<=n", ">n", "<n", "==n", "!=n"`)
}

export function exitCond(v: unknown, where: string): ExitCond {
  if (v === undefined) return { kind: 'code', code: 0 }
  if (typeof v === 'number' && Number.isInteger(v)) return { kind: 'code', code: v }
  if (v === 'nonzero') return { kind: 'nonzero' }
  if (v === 'any') return { kind: 'any' }
  throw new InputError(`${where} must be an exit code, "nonzero" or "any"`)
}

function parseGrader(x: unknown, where: string): GraderSpec | undefined {
  if (x === undefined) return undefined
  if (!isObject(x)) throw new InputError(`${where} must be an object`)
  const argv = strArray(x.argv, `${where}.argv`)
  if (argv.length === 0) throw new InputError(`${where}.argv must not be empty`)
  return {
    argv,
    env: dict(x.env, `${where}.env`),
    timeoutMs: optPositiveInt(x.timeoutMs, `${where}.timeoutMs`),
    output: optStr(x.output, `${where}.output`),
    model: optStr(x.model, `${where}.model`),
    effort: optStr(x.effort, `${where}.effort`),
  }
}

export function parseProfile(x: unknown, where: string): Profile {
  if (!isObject(x)) throw new InputError(`${where} must be a JSON object`)
  return {
    argv: x.argv === undefined ? undefined : strArray(x.argv, `${where}.argv`),
    cwd: optStr(x.cwd, `${where}.cwd`),
    env: dict(x.env, `${where}.env`),
    timeoutMs: optPositiveInt(x.timeoutMs, `${where}.timeoutMs`),
    probes: patternMap(x.probes, `${where}.probes`),
    metrics: patternMap(x.metrics, `${where}.metrics`),
    grader: parseGrader(x.grader, `${where}.grader`),
  }
}

export function parseFileCheck(x: unknown, where: string): FileCheck {
  if (!isObject(x)) throw new InputError(`${where} must be an object`)
  return {
    path: str(x.path, `${where}.path`),
    exists: x.exists === undefined ? true : bool(x.exists, `${where}.exists`),
    matches: optStr(x.matches, `${where}.matches`),
  }
}

export function parseCase(x: unknown, where: string, casesDir: string): Case {
  if (!isObject(x)) throw new InputError(`${where} must be an object`)
  const id = str(x.id, `${where}.id`)
  if (!ID_RE.test(id)) throw new InputError(`${where}.id must match ${ID_RE}`)
  const rawExpect = x.expect === undefined ? {} : x.expect
  if (!isObject(rawExpect)) throw new InputError(`${where}.expect must be an object`)
  const expect: Record<string, CountCond> = {}
  for (const [k, v] of Object.entries(rawExpect)) {
    if (k === 'exit') continue
    expect[k] = countCond(v, `${where}.expect["${k}"]`)
  }
  const rawFiles = x.files === undefined ? [] : x.files
  if (!Array.isArray(rawFiles)) throw new InputError(`${where}.files must be an array`)
  const fixture = optStr(x.fixture, `${where}.fixture`)
  return {
    id,
    prompt: x.prompt === undefined ? '' : str(x.prompt, `${where}.prompt`),
    tags: x.tags === undefined ? [] : strArray(x.tags, `${where}.tags`),
    expect,
    exit: exitCond(rawExpect.exit, `${where}.expect.exit`),
    files: rawFiles.map((f, i) => parseFileCheck(f, `${where}.files[${i}]`)),
    fixture: fixture === undefined ? undefined : resolve(casesDir, fixture),
    git: bool(x.git, `${where}.git`),
    allowTimeout: bool(x.allowTimeout, `${where}.allowTimeout`),
    argv: x.argv === undefined ? undefined : strArray(x.argv, `${where}.argv`),
    cwd: optStr(x.cwd, `${where}.cwd`),
    env: dict(x.env, `${where}.env`),
    stdin: optStr(x.stdin, `${where}.stdin`),
    timeoutMs: optPositiveInt(x.timeoutMs, `${where}.timeoutMs`),
    probes: patternMap(x.probes, `${where}.probes`),
    rubric: rubricOf(x.rubric, `${where}.rubric`),
  }
}

function rubricOf(x: unknown, where: string): string[] {
  if (x === undefined) return []
  const list = strArray(x, where).map(e => e.trim())
  if (list.some(e => e === '')) throw new InputError(`${where} must not hold empty expectations`)
  return list
}

export function parseCases(x: unknown, where: string, casesDir: string): Case[] {
  if (!isObject(x) || !Array.isArray(x.cases)) throw new InputError(`${where} must be an object with a "cases" array`)
  const cases = x.cases.map((c, i) => parseCase(c, `${where}: cases[${i}]`, casesDir))
  const seen = new Set<string>()
  for (const c of cases) {
    if (seen.has(c.id)) throw new InputError(`${where}: duplicate case id "${c.id}"`)
    seen.add(c.id)
  }
  return cases
}

export async function readJson(path: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    throw new InputError(`cannot read ${path}: ${message(e)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch (e) {
    throw new InputError(`${path} is not valid JSON: ${message(e)}`)
  }
}

export interface Args { positionals: string[]; values: Map<string, string[]>; flags: Set<string> }

export const VALUE_OPTIONS = new Set([
  '--cases', '--profile', '--arm', '--out', '--runs', '--timeout-ms', '--concurrency', '--case',
  '--tag', '--set', '--env', '--append-arg', '--baseline', '--candidate',
])
export const FLAG_OPTIONS = new Set(['--dry-run', '--keep-session-env', '--json', '--help', '-h', '--allow-mixed', '--regrade'])

export function parseArgs(argv: string[]): Args {
  const out: Args = { positionals: [], values: new Map(), flags: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (FLAG_OPTIONS.has(a)) {
      out.flags.add(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a
    if (VALUE_OPTIONS.has(name)) {
      let value: string | undefined
      if (name !== a) value = a.slice(eq + 1)
      else {
        i += 1
        value = argv[i]
        if (value === undefined) throw new InputError(`${a} needs a value`)
      }
      const list = out.values.get(name) ?? []
      list.push(value)
      out.values.set(name, list)
      continue
    }
    if (a.startsWith('-')) throw new InputError(`unknown option ${a} (see --help)`)
    out.positionals.push(a)
  }
  return out
}

export function last(args: Args, name: string): string | undefined {
  const list = args.values.get(name)
  return list === undefined ? undefined : list[list.length - 1]
}

export function every(args: Args, name: string): string[] {
  return args.values.get(name) ?? []
}

export function required(args: Args, name: string): string {
  const v = last(args, name)
  if (v === undefined || v === '') throw new InputError(`${name} is required (see --help)`)
  return v
}

export function intOption(args: Args, name: string, fallback: number, min: number, max: number): number {
  const v = last(args, name)
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${name} must be an integer from ${min} to ${max}`)
  return n
}

export function keyValues(list: string[], name: string): Dict {
  const out: Dict = {}
  for (const item of list) {
    const eq = item.indexOf('=')
    const key = eq > 0 ? item.slice(0, eq) : ''
    if (!KEY_RE.test(key)) throw new InputError(`${name} expects KEY=VALUE, got "${item}"`)
    out[key] = item.slice(eq + 1)
  }
  return out
}

export function expand(template: string, vars: Dict, where: string, warnings: Set<string>): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole: string, key: string) => {
    const value = vars[key]
    if (value !== undefined) return value
    warnings.add(`${where}: unknown template variable ${whole} left as is`)
    return whole
  })
}

export function expandPrompt(template: string, vars: Dict): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole: string, key: string) => vars[key] ?? whole)
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function resolveSpec(name: string, local: Record<string, PatternSpec>, shared: Record<string, PatternSpec>): PatternSpec | undefined {
  const direct = local[name] ?? shared[name]
  if (direct !== undefined) return direct
  const colon = name.indexOf(':')
  if (colon <= 0) return undefined
  const wildcard = `${name.slice(0, colon)}:*`
  const spec = local[wildcard] ?? shared[wildcard]
  if (spec === undefined) return undefined
  return { ...spec, pattern: spec.pattern.split('{arg}').join(escapeRegExp(name.slice(colon + 1))) }
}

export function compile(name: string, spec: PatternSpec, where: string): Compiled {
  try {
    return { name, re: new RegExp(spec.pattern, `${spec.flags}g`), stream: spec.stream }
  } catch (e) {
    throw new InputError(`${where}: invalid regex for "${name}": ${message(e)}`)
  }
}

export function prepare(c: Case, profile: Profile, where: string): Prepared {
  const argv = c.argv ?? profile.argv
  if (argv === undefined || argv.length === 0) throw new InputError(`${where}: case "${c.id}" has no argv and the profile has none`)
  const names = new Set<string>()
  for (const n of [...Object.keys(profile.probes), ...Object.keys(c.probes)]) if (!n.endsWith(':*')) names.add(n)
  for (const n of Object.keys(c.expect)) names.add(n)
  const probes: Compiled[] = []
  for (const n of names) {
    const spec = resolveSpec(n, c.probes, profile.probes)
    if (spec === undefined) {
      const known = [...Object.keys(profile.probes), ...Object.keys(c.probes)].join(', ') || 'none'
      throw new InputError(`${where}: case "${c.id}" expects probe "${n}", which neither the case nor the profile defines (known: ${known})`)
    }
    probes.push(compile(n, spec, `${where}: case "${c.id}"`))
  }
  const metrics = Object.entries(profile.metrics).map(([n, spec]) => compile(n, spec, `${where}: metrics`))
  return { c, argv, probes, metrics }
}

export function baseEnv(keepSession: boolean): Dict {
  const out: Dict = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (!keepSession && (SESSION_VARS.has(k) || k.startsWith('CLAUDE_CODE_'))) continue
    out[k] = v
  }
  return out
}

export function redactArgv(argv: string[]): string[] {
  const out: string[] = []
  let hideNext = false
  for (const a of argv) {
    if (hideNext) {
      out.push('[REDACTED]')
      hideNext = false
      continue
    }
    const flag = SECRET_FLAG_RE.exec(a)
    if (flag) {
      if (flag[2] === undefined) {
        hideNext = true
        out.push(a)
      } else out.push(`${flag[1] ?? ''}=[REDACTED]`)
      continue
    }
    out.push(a.replace(SECRET_RE, '[REDACTED]'))
  }
  return out
}

export function textOf(stream: Stream, stdout: string, stderr: string): string {
  if (stream === 'stdout') return stdout
  if (stream === 'stderr') return stderr
  return `${stdout}\n${stderr}`
}

export function countMatches(re: RegExp, text: string): number {
  let n = 0
  for (const _ of text.matchAll(re)) n += 1
  return n
}

export function lastCapture(re: RegExp, text: string): number | null {
  let value: string | undefined
  for (const m of text.matchAll(re)) value = m[1]
  if (value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function compare(count: number, cond: CountCond): boolean {
  switch (cond.op) {
    case '>=': return count >= cond.n
    case '<=': return count <= cond.n
    case '>': return count > cond.n
    case '<': return count < cond.n
    case '==': return count === cond.n
    case '!=': return count !== cond.n
  }
}

export interface Drained { done: Promise<void>; chunks: Uint8Array[]; stop: () => void }

export function drain(stream: ReadableStream<Uint8Array>): Drained {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  const done = (async () => {
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) return
        chunks.push(r.value)
      }
    } catch {
    }
  })()
  return { done, chunks, stop: () => { void reader.cancel().catch(() => undefined) } }
}

export async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>((r) => { timer = setTimeout(() => r(false), ms) })
  const ok = await Promise.race([p.then(() => true), late])
  if (timer !== undefined) clearTimeout(timer)
  return ok
}

export interface Exec {
  exit: number | null
  signal: string | null
  timedOut: boolean
  startError: string | null
  streamsLeftOpen: boolean
  durationMs: number
  stdout: Buffer
  stderr: Buffer
}

export function spawnPiped(argv: string[], cwd: string, env: Dict, stdin: string | undefined) {
  return Bun.spawn({
    cmd: argv,
    cwd,
    env,
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin, 'utf8'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

export async function execute(argv: string[], cwd: string, env: Dict, stdin: string | undefined, timeoutMs: number): Promise<Exec> {
  const started = Bun.nanoseconds()
  let proc: ReturnType<typeof spawnPiped>
  try {
    proc = spawnPiped(argv, cwd, env, stdin)
  } catch (e) {
    return { exit: null, signal: null, timedOut: false, startError: message(e), streamsLeftOpen: false, durationMs: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
  }
  let timedOut = false
  let hardKill: ReturnType<typeof setTimeout> | undefined
  const softKill = setTimeout(() => {
    timedOut = true
    proc.kill('SIGTERM')
    hardKill = setTimeout(() => proc.kill('SIGKILL'), KILL_GRACE_MS)
  }, timeoutMs)
  const out = drain(proc.stdout)
  const err = drain(proc.stderr)
  await proc.exited
  clearTimeout(softKill)
  if (hardKill !== undefined) clearTimeout(hardKill)
  const closed = await within(Promise.all([out.done, err.done]), STREAM_GRACE_MS)
  if (!closed) {
    out.stop()
    err.stop()
  }
  return {
    exit: proc.exitCode,
    signal: proc.signalCode ?? null,
    timedOut,
    startError: null,
    streamsLeftOpen: !closed,
    durationMs: Math.round((Bun.nanoseconds() - started) / 1e6),
    stdout: Buffer.concat(out.chunks),
    stderr: Buffer.concat(err.chunks),
  }
}

export async function gitInit(dir: string): Promise<void> {
  const steps = [
    ['git', '-c', 'init.defaultBranch=main', 'init', '-q'],
    ['git', 'add', '-A'],
    ['git', '-c', 'user.name=buracle-bench', '-c', 'user.email=bench@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'fixture'],
  ]
  for (const cmd of steps) {
    const p = Bun.spawn({ cmd, cwd: dir, stdout: 'ignore', stderr: 'pipe' })
    const [code, text] = await Promise.all([p.exited, new Response(p.stderr).text()])
    if (code !== 0) throw new Error(`${cmd.join(' ')} failed in ${dir}: ${text.trim()}`)
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function checkFile(f: FileCheck, cwd: string): Promise<{ path: string; ok: boolean; detail: string }> {
  const abs = isAbsolute(f.path) ? f.path : join(cwd, f.path)
  const present = await exists(abs)
  if (!f.exists) return { path: f.path, ok: !present, detail: present ? 'exists, expected absent' : 'absent' }
  if (!present) return { path: f.path, ok: false, detail: 'missing' }
  if (f.matches === undefined) return { path: f.path, ok: true, detail: 'exists' }
  let re: RegExp
  try {
    re = new RegExp(f.matches)
  } catch (e) {
    return { path: f.path, ok: false, detail: `invalid regex: ${message(e)}` }
  }
  try {
    const text = await readFile(abs, 'utf8')
    return re.test(text) ? { path: f.path, ok: true, detail: 'matches' } : { path: f.path, ok: false, detail: `no match for /${f.matches}/` }
  } catch (e) {
    return { path: f.path, ok: false, detail: `unreadable: ${message(e)}` }
  }
}

export async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    for (;;) {
      const item = items[next]
      next += 1
      if (item === undefined) return
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

export function isRunRecord(x: unknown): x is RunRecord {
  return isObject(x) && typeof x.arm === 'string' && typeof x.case === 'string' && typeof x.pass === 'boolean' &&
    typeof x.durationMs === 'number' && typeof x.timedOut === 'boolean' && isObject(x.probes) && isObject(x.metrics)
}

export function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const hi = s[mid] ?? 0
  return s.length % 2 === 1 ? hi : ((s[mid - 1] ?? hi) + hi) / 2
}

export function stddev(xs: number[]): number | null {
  const m = mean(xs)
  if (m === null || xs.length < 2) return xs.length === 1 ? 0 : null
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export async function sha256File(path: string): Promise<string | null> {
  try { return sha256(await readFile(path)) } catch { return null }
}

async function treeFiles(dir: string, base: string, out: string[]): Promise<void> {
  const names = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of names) {
    if (e.name === '.git' || e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) await treeFiles(p, base, out)
    else if (e.isFile()) out.push(relative(base, p))
  }
}

export async function sha256Tree(path: string): Promise<string | null> {
  try {
    const st = await stat(path)
    if (st.isFile()) return await sha256File(path)
    const files: string[] = []
    await treeFiles(path, path, files)
    const parts: string[] = []
    for (const f of files) parts.push(`${f.split('\\').join('/')}\0${await sha256File(join(path, f)) ?? ''}`)
    return sha256(parts.join('\n'))
  } catch { return null }
}

export const FIXED_TMP_RE = /(?:^|[\s"'`=(])(\/(?:private\/)?tmp\/|\/var\/folders\/)/

export interface MetaLine {
  v: 1
  kind?: 'run' | 'grade'
  ts: string
  arm: string
  cases: string
  casesSha256?: string | null
  profile: string | null
  profileSha256?: string | null
  fixtures?: Record<string, string | null>
  runs: number
  caseIds: string[]
  appendArgs: string[]
  envKeys?: string[]
}

export async function readJsonLines(path: string): Promise<{ items: unknown[], skipped: number }> {
  let text: string
  try { text = await readFile(path, 'utf8') } catch { return { items: [], skipped: 0 } }
  const items: unknown[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try { items.push(JSON.parse(line) as unknown) } catch { skipped += 1 }
  }
  return { items, skipped }
}

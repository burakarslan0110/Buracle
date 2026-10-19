#!/usr/bin/env bun

import { appendFile, cp, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { gradeCommand } from './grade'
import {
  baseEnv, checkFile, compare, countMatches, DEFAULT_TIMEOUT_MS, every, execute, exists, expand, expandPrompt, FIXED_TMP_RE, gitInit,
  ID_RE, InputError, intOption, keyValues, last, lastCapture, parseArgs, parseCases, parseProfile, pool, prepare, readJson, redactArgv,
  required, SECRET_RE, sha256File, sha256Tree, TAIL_CHARS, textOf,
  type Args, type Dict, type Prepared, type Profile, type RunRecord,
} from './lib'
import { summarizeCommand } from './summarize'

const HELP = `Buracle benchmark runner

Commands
  run        Run every case N times for one arm and append results to <out>/results.jsonl
  grade      Grade the rubric of judged cases with a model grader, blind to the arm (grades.jsonl)
  summarize  Compare arms from a results directory (or a results.jsonl file)

run options
  --cases <file>        Cases file (JSON). Required.
  --profile <file>      Harness profile: argv template, cwd, env, timeoutMs, probes, metrics.
                        Optional when every case has its own "argv".
  --arm <name>          Arm label, e.g. baseline or candidate. Required. [A-Za-z0-9._-]
  --out <dir>           Output directory, shared by all arms of one benchmark. Required.
  --runs <n>            Runs per case (default 3, max 100).
  --timeout-ms <ms>     Override every case's timeout (default: case, then profile, then 600000).
  --concurrency <n>     Parallel runs (default 1, max 8). Runs share the user's rate limits.
  --case <glob>         Only cases whose id matches (repeatable).
  --tag <tag>           Only cases carrying the tag (repeatable).
  --set key=value       Template variable for argv, cwd, env, stdin and prompts (repeatable).
  --env KEY=VALUE       Environment override for the child (repeatable, applied last).
  --append-arg <value>  Extra argument appended to every argv; the next token is taken verbatim,
                        so "--append-arg --model --append-arg sonnet" works (repeatable).
  --keep-session-env    Do not strip the parent session's environment variables.
  --dry-run             Print the expanded commands for run 1 of each case; run nothing.

grade options (bun run.ts grade <out> --profile <file> ...)
  --profile <file>      A profile with a "grader" block (argv template with {prompt}). Required.
  --cases <file>        Cases file with the rubrics (default: the one meta.jsonl recorded; it must
                        be unchanged, or the grade would use another rubric).
  --arm <name>          Only these arms (repeatable). --case <glob>, --env, --set, --append-arg,
                        --concurrency, --timeout-ms and --dry-run work as for run.
  --regrade             Grade runs that already have a grade again (the newest grade wins).

summarize options
  --baseline <arm> --candidate <arm>   Arms to compare (default: the two arms in the file).
  --allow-mixed                        Compare arms that ran different cases, runs, profiles
                                       or fixtures, or a graded case with ungraded runs
                                       (refused otherwise; listed as caveats).
  --json                               Machine-readable output instead of Markdown.

Template variables
  {prompt} {case} {run} {arm} {out} {work} {cases_dir}, plus every --set key.
  {work} is the run's fresh working directory: <out>/<arm>/<case>/run-<n>/work.

Environment
  The child inherits this process's environment, minus BURACLE_SESSION_ID, BURACLE_HARNESS,
  CLAUDECODE, CLAUDE_PID, CLAUDE_EFFORT, every CLAUDE_CODE_* variable, CODEX_THREAD_ID, CODEX_SESSION_ID,
  OPENCODE_SESSION_ID and OMP_SESSION_ID. Then profile env, case env and --env are applied.
  Pass credentials with --env (e.g. CLAUDE_CODE_OAUTH_TOKEN), never through files.

Output (under --out)
  results.jsonl                         one record per run (see references/runner.md)
  meta.jsonl                            one line per invocation (cases, profile, fixtures with
                                        sha256, runs, flags)
  grades.jsonl                          one line per graded run (grade); grading/<id>/ holds the
                                        blinded transcript the grader read
  <arm>/<case>/run-<n>/stdout.txt       full stdout; stderr.txt next to it
  <arm>/<case>/run-<n>/work/            the run's working directory

Exit codes: 0 ok, 1 bad input or I/O error, 2 finished but some runs could not start (grade: some
grades failed; summarize: arms differ or a graded case has ungraded runs, and --allow-mixed was
not given).
`


interface Job { p: Prepared; run: number }

interface RunContext {
  arm: string
  out: string
  casesDir: string
  profile: Profile
  vars: Dict
  envOverrides: Dict
  appendArgs: string[]
  baseEnv: Dict
  timeoutOverride: number | undefined
  warnings: Set<string>
}

function runDirOf(ctx: RunContext, caseId: string, run: number): string {
  return join(ctx.out, ctx.arm, caseId, `run-${run}`)
}

function materialize(job: Job, ctx: RunContext) {
  const c = job.p.c
  const runDir = runDirOf(ctx, c.id, job.run)
  const work = join(runDir, 'work')
  const vars: Dict = { ...ctx.vars, case: c.id, run: String(job.run), arm: ctx.arm, out: ctx.out, work, cases_dir: ctx.casesDir }
  vars.prompt = expandPrompt(c.prompt, vars)
  const where = `case ${c.id}`
  const argv = [...job.p.argv, ...ctx.appendArgs].map((a) => expand(a, vars, `${where} argv`, ctx.warnings))
  const cwd = resolve(expand(c.cwd ?? ctx.profile.cwd ?? '{work}', vars, `${where} cwd`, ctx.warnings))
  const env: Dict = { ...ctx.baseEnv }
  const layers: Dict[] = [ctx.profile.env, c.env, ctx.envOverrides]
  for (const layer of layers) for (const [k, v] of Object.entries(layer)) env[k] = expand(v, vars, `${where} env ${k}`, ctx.warnings)
  const stdin = c.stdin === undefined ? undefined : expand(c.stdin, vars, `${where} stdin`, ctx.warnings)
  const timeoutMs = ctx.timeoutOverride ?? c.timeoutMs ?? ctx.profile.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return { runDir, work, argv, cwd, env, stdin, timeoutMs }
}

async function runJob(job: Job, ctx: RunContext): Promise<RunRecord> {
  const c = job.p.c
  const m = materialize(job, ctx)
  await mkdir(m.runDir, { recursive: true })
  if (c.fixture !== undefined) await cp(c.fixture, m.work, { recursive: true })
  else await mkdir(m.work, { recursive: true })
  if (c.git) await gitInit(m.work)

  const exec = await execute(m.argv, m.cwd, m.env, m.stdin, m.timeoutMs)
  const stdoutPath = join(m.runDir, 'stdout.txt')
  const stderrPath = join(m.runDir, 'stderr.txt')
  await writeFile(stdoutPath, exec.stdout)
  await writeFile(stderrPath, exec.stderr)
  const stdout = exec.stdout.toString('utf8')
  const stderr = exec.stderr.toString('utf8')

  const probes: Record<string, number> = {}
  for (const p of job.p.probes) probes[p.name] = countMatches(p.re, textOf(p.stream, stdout, stderr))
  const metrics: Record<string, number | null> = {}
  for (const p of job.p.metrics) metrics[p.name] = lastCapture(p.re, textOf(p.stream, stdout, stderr))
  const files = await Promise.all(c.files.map((f) => checkFile(f, m.cwd)))

  const checks: Record<string, boolean> = {}
  for (const [name, cond] of Object.entries(c.expect)) checks[name] = compare(probes[name] ?? 0, cond)
  const timeoutForgiven = exec.timedOut && c.allowTimeout
  if (exec.startError !== null) checks.start = false
  if (!timeoutForgiven) {
    checks.exit = c.exit.kind === 'any' ? true : c.exit.kind === 'nonzero' ? exec.exit !== null && exec.exit !== 0 : exec.exit === c.exit.code
    if (exec.timedOut) checks.timeout = false
  }
  for (const f of files) checks[`file:${f.path}`] = f.ok

  return {
    v: 1,
    ts: new Date().toISOString(),
    arm: ctx.arm,
    case: c.id,
    run: job.run,
    tags: c.tags,
    argv: redactArgv(m.argv),
    cwd: m.cwd,
    exit: exec.exit,
    signal: exec.signal,
    timedOut: exec.timedOut,
    startError: exec.startError,
    streamsLeftOpen: exec.streamsLeftOpen,
    durationMs: exec.durationMs,
    stdoutBytes: exec.stdout.byteLength,
    stderrBytes: exec.stderr.byteLength,
    stdoutPath,
    stderrPath,
    tail: stdout.slice(-TAIL_CHARS).replace(SECRET_RE, '[REDACTED]'),
    probes,
    metrics,
    files,
    checks,
    pass: Object.values(checks).every(Boolean),
  }
}

async function runCommand(args: Args): Promise<number> {
  const casesPath = resolve(required(args, '--cases'))
  const arm = required(args, '--arm')
  if (!ID_RE.test(arm)) throw new InputError(`--arm must match ${ID_RE}`)
  const out = resolve(required(args, '--out'))
  const runs = intOption(args, '--runs', 3, 1, 100)
  const concurrency = intOption(args, '--concurrency', 1, 1, 8)
  const timeoutOverride = last(args, '--timeout-ms') === undefined ? undefined : intOption(args, '--timeout-ms', 0, 1, 86_400_000)
  const profilePath = last(args, '--profile')
  const profile: Profile = profilePath === undefined
    ? { argv: undefined, cwd: undefined, env: {}, timeoutMs: undefined, probes: {}, metrics: {}, grader: undefined }
    : parseProfile(await readJson(resolve(profilePath)), profilePath)
  const casesDir = dirname(casesPath)
  const caseGlobs = every(args, '--case').map((g) => new Bun.Glob(g))
  const tags = every(args, '--tag')
  const cases = parseCases(await readJson(casesPath), casesPath, casesDir).filter((c) =>
    (caseGlobs.length === 0 || caseGlobs.some((g) => g.match(c.id))) &&
    (tags.length === 0 || c.tags.some((t) => tags.includes(t))))
  if (cases.length === 0) throw new InputError('no case matches the --case/--tag filters')

  const prepared = cases.map((c) => prepare(c, profile, casesPath))
  for (const c of cases) {
    if (c.fixture !== undefined && !(await exists(c.fixture))) throw new InputError(`case "${c.id}": fixture ${c.fixture} does not exist`)
  }
  for (const c of cases) {
    if (FIXED_TMP_RE.test(c.prompt)) process.stderr.write(`warning: case "${c.id}": the prompt names a fixed temp path; use {work} so every run gets its own folder\n`)
  }

  const ctx: RunContext = {
    arm, out, casesDir, profile,
    vars: keyValues(every(args, '--set'), '--set'),
    envOverrides: keyValues(every(args, '--env'), '--env'),
    appendArgs: every(args, '--append-arg'),
    baseEnv: baseEnv(args.flags.has('--keep-session-env')),
    timeoutOverride,
    warnings: new Set(),
  }

  const jobs: Job[] = []
  for (let run = 1; run <= runs; run++) for (const p of prepared) jobs.push({ p, run })

  if (args.flags.has('--dry-run')) {
    for (const p of prepared) {
      const m = materialize({ p, run: 1 }, ctx)
      const envKeys = Object.keys({ ...profile.env, ...p.c.env, ...ctx.envOverrides }).sort()
      process.stdout.write(`${JSON.stringify({ case: p.c.id, argv: redactArgv(m.argv), cwd: m.cwd, envOverrides: envKeys, timeoutMs: m.timeoutMs, probes: p.probes.map((x) => x.name) })}\n`)
    }
    for (const w of ctx.warnings) process.stderr.write(`warning: ${w}\n`)
    return 0
  }

  for (const job of jobs) {
    const dir = runDirOf(ctx, job.p.c.id, job.run)
    if (await exists(dir)) throw new InputError(`${dir} already exists; use a fresh --out or another --arm name`)
  }
  await mkdir(out, { recursive: true })
  const resultsPath = join(out, 'results.jsonl')
  const fixtures: Record<string, string | null> = {}
  for (const c of cases) if (c.fixture !== undefined && !(c.fixture in fixtures)) fixtures[c.fixture] = await sha256Tree(c.fixture)
  await appendFile(join(out, 'meta.jsonl'), `${JSON.stringify({
    v: 1, kind: 'run', ts: new Date().toISOString(), arm, cases: casesPath, casesSha256: await sha256File(casesPath),
    profile: profilePath === undefined ? null : resolve(profilePath),
    profileSha256: profilePath === undefined ? null : await sha256File(resolve(profilePath)), fixtures,
    runs, caseIds: cases.map((c) => c.id),
    set: Object.fromEntries(Object.entries(ctx.vars).map(([k, v]) => [k, v.replace(SECRET_RE, '[REDACTED]')])),
    envKeys: Object.keys(ctx.envOverrides).sort(),
    appendArgs: redactArgv(ctx.appendArgs), keepSessionEnv: args.flags.has('--keep-session-env'),
  })}\n`)

  let writing: Promise<void> = Promise.resolve()
  let passed = 0
  let startErrors = 0
  let done = 0
  await pool(jobs, concurrency, async (job) => {
    const rec = await runJob(job, ctx)
    writing = writing.then(() => appendFile(resultsPath, `${JSON.stringify(rec)}\n`))
    await writing
    done += 1
    if (rec.pass) passed += 1
    if (rec.startError !== null) startErrors += 1
    const shown = Object.entries(rec.probes).map(([k, v]) => `${k}=${v}`).join(' ')
    const state = rec.startError !== null ? `start error: ${rec.startError}` : rec.timedOut ? 'timeout' : `exit ${rec.exit ?? rec.signal ?? '?'}`
    process.stderr.write(`[${arm}] ${done}/${jobs.length} ${rec.case} #${rec.run} ${rec.pass ? 'PASS' : 'FAIL'} ${(rec.durationMs / 1000).toFixed(1)}s ${state}${shown ? ` | ${shown}` : ''}\n`)
  })
  for (const w of ctx.warnings) process.stderr.write(`warning: ${w}\n`)
  process.stderr.write(`[${arm}] ${jobs.length} runs, ${passed} passed, ${startErrors} could not start → ${resultsPath}\n`)
  return startErrors > 0 ? 2 : 0
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP)
    return command === undefined ? 1 : 0
  }
  const args = parseArgs(rest)
  if (args.flags.has('--help') || args.flags.has('-h')) {
    process.stdout.write(HELP)
    return 0
  }
  if (command === 'run') return await runCommand(args)
  if (command === 'grade') return await gradeCommand(args)
  if (command === 'summarize') return await summarizeCommand(args)
  throw new InputError(`unknown command "${command}" (expected run, grade or summarize; see --help)`)
}

function finish(code: number): void {
  process.exitCode = code
  setTimeout(() => process.exit(code), 2_000).unref()
}

main(Bun.argv.slice(2)).then(finish, (e: unknown) => {
  if (e instanceof InputError) process.stderr.write(`run.ts: ${e.message}\n`)
  else process.stderr.write(`run.ts: unexpected error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
  finish(1)
})

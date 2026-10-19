import { randomUUID } from 'node:crypto'
import { appendFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  baseEnv, DEFAULT_TIMEOUT_MS, escapeRegExp, every, execute, exists, expand, expandPrompt, InputError, intOption, isObject, isRunRecord, keyValues, last,
  message, parseCases, parseProfile, pool, readJson, readJsonLines, redactArgv, sha256File,
  type Args, type Dict, type MetaLine, type RunRecord,
} from './lib'

export interface Verdict { index: number; pass: boolean; evidence: string }
export interface GradeAnswer { expectations: Verdict[]; feedback: string[] }

const TEMPLATE = join(import.meta.dir, 'grader.md')
const EVIDENCE_MAX = 300
const PLACEHOLDER = '<quote and where it is>'

function balancedObject(s: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return undefined
}

function texts(raw: string): string[] {
  const out = [raw]
  const docs: unknown[] = []
  try { docs.push(JSON.parse(raw) as unknown) } catch {
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try { docs.push(JSON.parse(line) as unknown) } catch {  }
    }
  }
  const walk = (x: unknown): void => {
    if (typeof x === 'string') out.push(x)
    else if (Array.isArray(x)) for (const v of x) walk(v)
    else if (isObject(x)) for (const v of Object.values(x)) walk(v)
  }
  for (const d of docs) walk(d)
  return out
}

function validAnswer(x: unknown, n: number): GradeAnswer | undefined {
  if (!isObject(x) || !Array.isArray(x.expectations) || x.expectations.length !== n) return undefined
  const verdicts: Verdict[] = []
  for (let i = 0; i < n; i++) {
    const e = x.expectations[i] as unknown
    if (!isObject(e) || typeof e.pass !== 'boolean') return undefined
    const index = typeof e.index === 'number' ? e.index : i + 1
    if (index !== i + 1) return undefined
    if (e.evidence === PLACEHOLDER) return undefined
    verdicts.push({ index, pass: e.pass, evidence: typeof e.evidence === 'string' ? e.evidence.slice(0, EVIDENCE_MAX) : '' })
  }
  const fb = Array.isArray(x.eval_feedback) ? x.eval_feedback.filter((f): f is string => typeof f === 'string') : []
  return { expectations: verdicts, feedback: fb }
}

export function findGrade(raw: string, n: number): GradeAnswer | undefined {
  const all = texts(raw)
  for (let t = all.length - 1; t >= 0; t--) {
    const s = all[t] as string
    const starts = [...s.matchAll(/\{\s*"expectations"\s*:/g)].map((m) => m.index ?? 0).reverse()
    for (const at of starts) {
      const obj = balancedObject(s, at)
      if (obj === undefined) continue
      try {
        const answer = validAnswer(JSON.parse(obj) as unknown, n)
        if (answer !== undefined) return answer
      } catch {  }
    }
  }
  return undefined
}

export function blind(text: string, runDir: string, out: string, arm: string): string {
  let t = text.split(runDir).join('<run>').split(join(out, arm)).join('<arm-dir>')
  for (const sep of ['/', '\\']) t = t.split(`${sep}${arm}${sep}`).join(`${sep}<arm>${sep}`)
  if (arm.length >= 3) t = t.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(arm)}(?![A-Za-z0-9_-])`, 'g'), '<arm>')
  return t
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = a[i] as T
    a[i] = a[j] as T
    a[j] = tmp
  }
  return a
}

function isMeta(x: unknown): x is MetaLine {
  return isObject(x) && typeof x.arm === 'string' && typeof x.cases === 'string' && (x.kind === undefined || x.kind === 'run')
}

async function casesFile(args: Args, meta: MetaLine[]): Promise<string> {
  const explicit = last(args, '--cases')
  const recorded = [...new Set(meta.map((m) => m.cases))]
  const path = explicit !== undefined ? resolve(explicit) : recorded[0]
  if (path === undefined) throw new InputError('meta.jsonl names no cases file; pass --cases')
  if (explicit === undefined && recorded.length > 1) throw new InputError(`meta.jsonl names ${recorded.length} cases files; pass --cases`)
  const now = await sha256File(path)
  for (const m of meta) {
    if (typeof m.casesSha256 === 'string' && m.casesSha256 !== now) {
      throw new InputError(`${path} changed since the ${m.arm} runs (sha256 differs), so grading would use another rubric; restore it or start a fresh --out`)
    }
  }
  return path
}

interface GradeJob { r: RunRecord; rubric: string[]; prompt: string }

export async function gradeCommand(args: Args): Promise<number> {
  const target = args.positionals[0]
  if (target === undefined) throw new InputError('grade needs the results directory (the --out of run)')
  const out = resolve(target)
  const profilePath = last(args, '--profile')
  if (profilePath === undefined) throw new InputError('grade needs --profile with a "grader" block')
  const profile = parseProfile(await readJson(resolve(profilePath)), profilePath)
  const grader = profile.grader
  if (grader === undefined) throw new InputError(`${profilePath} has no "grader" block`)
  const results = await readJsonLines(join(out, 'results.jsonl'))
  const latest = new Map<string, RunRecord>()
  for (const r of results.items) if (isRunRecord(r)) latest.set(`${r.arm}\0${r.case}\0${r.run}`, r)
  if (latest.size === 0) throw new InputError(`${join(out, 'results.jsonl')} holds no run records`)
  const meta = (await readJsonLines(join(out, 'meta.jsonl'))).items.filter(isMeta)
  const casesPath = await casesFile(args, meta)
  const cases = new Map(parseCases(await readJson(casesPath), casesPath, dirname(casesPath)).map((c) => [c.id, c]))
  const arms = every(args, '--arm')
  const globs = every(args, '--case').map((g) => new Bun.Glob(g))
  const graded = new Set<string>()
  if (!args.flags.has('--regrade')) {
    for (const g of (await readJsonLines(join(out, 'grades.jsonl'))).items) {
      if (isObject(g) && typeof g.arm === 'string' && typeof g.case === 'string' && typeof g.run === 'number' && g.graderError === undefined) graded.add(`${g.arm}\0${g.case}\0${g.run}`)
    }
  }
  const jobs: GradeJob[] = []
  for (const [key, r] of latest) {
    const c = cases.get(r.case)
    if (c === undefined || c.rubric.length === 0 || graded.has(key)) continue
    if (arms.length > 0 && !arms.includes(r.arm)) continue
    if (globs.length > 0 && !globs.some((g) => g.match(r.case))) continue
    jobs.push({ r, rubric: c.rubric, prompt: c.prompt })
  }
  if (jobs.length === 0) {
    process.stderr.write('grade: no run left to grade (no case has a rubric, or every run is graded; --regrade grades again)\n')
    return 0
  }
  const template = await readFile(TEMPLATE, 'utf8')
  const envOverrides = keyValues(every(args, '--env'), '--env')
  const vars = keyValues(every(args, '--set'), '--set')
  const appendArgs = every(args, '--append-arg')
  const timeoutMs = last(args, '--timeout-ms') !== undefined ? intOption(args, '--timeout-ms', 0, 1, 86_400_000) : grader.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const concurrency = intOption(args, '--concurrency', 1, 1, 8)
  const parent = baseEnv(args.flags.has('--keep-session-env'))
  const warnings = new Set<string>()
  const isolation: Dict = { BURACLE_HOME: join(out, 'grading', 'buracle-home'), BURACLE_NO_CAPTURE: '1' }

  const plan = shuffle(jobs).map((j) => ({ ...j, id: randomUUID().replace(/-/g, '').slice(0, 12) }))
  if (args.flags.has('--dry-run')) {
    for (const j of plan) {
      const gradeDir = join(out, 'grading', j.id)
      const argv = [...grader.argv, ...appendArgs].map((a) => expand(a, { ...vars, prompt: '<grader prompt>', grade_dir: gradeDir }, 'grader argv', warnings))
      process.stdout.write(`${JSON.stringify({ grade: j.id, expectations: j.rubric.length, argv: redactArgv(argv), cwd: gradeDir })}\n`)
    }
    return 0
  }
  await appendFile(join(out, 'meta.jsonl'), `${JSON.stringify({
    v: 1, kind: 'grade', ts: new Date().toISOString(), profile: resolve(profilePath), profileSha256: await sha256File(resolve(profilePath)),
    cases: casesPath, casesSha256: await sha256File(casesPath), model: grader.model ?? null, effort: grader.effort ?? null,
    appendArgs: redactArgv(appendArgs), envKeys: Object.keys(envOverrides).sort(), runs: plan.length,
  })}\n`)
  let failures = 0
  let done = 0
  let writing: Promise<void> = Promise.resolve()
  await pool(plan, concurrency, async (j) => {
    const runDir = dirname(j.r.stdoutPath)
    const gradeDir = join(out, 'grading', j.id)
    await mkdir(gradeDir, { recursive: true })
    let transcript = ''
    try { transcript = await readFile(j.r.stdoutPath, 'utf8') } catch {  }
    await writeFile(join(gradeDir, 'transcript.txt'), blind(transcript, runDir, out, j.r.arm))
    const work = join(runDir, 'work')
    const hasWork = await exists(work)
    if (hasWork) await cp(work, join(gradeDir, 'work'), { recursive: true })
    const expectations = j.rubric.map((e, i) => `${i + 1}. ${e}`).join('\n')
    const prompt = expandPrompt(template, {
      case_prompt: blind(j.prompt, runDir, out, j.r.arm), expectations,
      work_note: hasWork ? 'the agent\'s working directory as it left it' : 'this run left no files',
    })
    const local: Dict = { ...vars, prompt, grade_dir: gradeDir }
    const argv = [...grader.argv, ...appendArgs].map((a) => expand(a, local, 'grader argv', warnings))
    const env: Dict = { ...parent, ...isolation }
    for (const [k, v] of Object.entries({ ...grader.env, ...envOverrides })) env[k] = expand(v, local, `grader env ${k}`, warnings)
    const exec = await execute(argv, gradeDir, env, undefined, timeoutMs)
    await writeFile(join(gradeDir, 'grader-stdout.txt'), exec.stdout)
    await writeFile(join(gradeDir, 'grader-stderr.txt'), exec.stderr)
    let raw = exec.stdout.toString('utf8')
    const outFile = grader.output !== undefined ? expand(grader.output, local, 'grader output', warnings) : undefined
    if (outFile !== undefined) { try { raw = await readFile(outFile, 'utf8') } catch {  } }
    const answer = exec.startError === null && !exec.timedOut ? findGrade(raw, j.rubric.length) : undefined
    const graderError = exec.startError !== null ? `the grader could not start: ${exec.startError}`
      : exec.timedOut ? `the grader timed out after ${timeoutMs} ms`
      : answer === undefined ? `no valid grade in the grader output (exit ${exec.exit ?? exec.signal ?? '?'}); see ${join(gradeDir, 'grader-stdout.txt')}`
      : undefined
    const checks: Record<string, boolean> = {}
    if (answer !== undefined) for (const v of answer.expectations) checks[`judge:${v.index}`] = v.pass
    const record = {
      v: 1, ts: new Date().toISOString(), grade: j.id, arm: j.r.arm, case: j.r.case, run: j.r.run,
      model: grader.model ?? null, effort: grader.effort ?? null, argv: redactArgv(argv).map((a) => (a === prompt ? '<grader prompt>' : a)),
      expectations: j.rubric.map((text, i) => ({ text, pass: answer?.expectations[i]?.pass ?? null, evidence: answer?.expectations[i]?.evidence ?? '' })),
      evalFeedback: answer?.feedback ?? [], exit: exec.exit, durationMs: exec.durationMs,
      ...(graderError !== undefined ? { graderError } : {}),
    }
    await writeFile(join(runDir, 'grading.json'), `${JSON.stringify(record, null, 2)}\n`)
    const line = { v: 1, ts: record.ts, grade: j.id, arm: j.r.arm, case: j.r.case, run: j.r.run, checks, ...(graderError !== undefined ? { graderError } : {}) }
    writing = writing.then(() => appendFile(join(out, 'grades.jsonl'), `${JSON.stringify(line)}\n`))
    await writing
    done += 1
    if (graderError !== undefined) failures += 1
    const passed = Object.values(checks).filter(Boolean).length
    process.stderr.write(`[grade] ${done}/${plan.length} ${j.id} ${graderError !== undefined ? `ERROR ${graderError}` : `${passed}/${j.rubric.length} expectations`}\n`)
  }).catch((e: unknown) => { throw new InputError(`grading stopped: ${message(e)}`) })
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`)
  process.stderr.write(`[grade] ${plan.length} runs graded, ${failures} grader error(s) -> ${join(out, 'grades.jsonl')}\n`)
  return failures > 0 ? 2 : 0
}

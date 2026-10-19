import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  InputError, isObject, isRunRecord, last, mean, median, message, readJsonLines, stddev,
  type Args, type MetaLine, type RunRecord,
} from './lib'

export interface Agg { runs: number; passes: number; timeouts: number; nonzero: number; startErrors: number; graderErrors: number; durations: number[]; probes: Map<string, number[]>; metrics: Map<string, number[]> }
export type CaseClass = 'improved' | 'regressed' | 'both-pass' | 'both-fail' | 'unclear'

export interface GradeLine { arm: string; case: string; run: number; checks: Record<string, boolean>; graderError?: string }

type Graded = RunRecord & { graderError?: string, judged?: boolean }

export function newAgg(): Agg {
  return { runs: 0, passes: 0, timeouts: 0, nonzero: 0, startErrors: 0, graderErrors: 0, durations: [], probes: new Map(), metrics: new Map() }
}

export function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key) ?? []
  list.push(value)
  map.set(key, list)
}

export function addRecord(a: Agg, r: Graded): void {
  if (r.graderError !== undefined) { a.graderErrors += 1; return }
  a.runs += 1
  if (r.pass) a.passes += 1
  if (r.timedOut) a.timeouts += 1
  if (r.exit !== null && r.exit !== 0) a.nonzero += 1
  if (typeof r.startError === 'string') a.startErrors += 1
  a.durations.push(r.durationMs)
  for (const [k, v] of Object.entries(r.probes)) if (typeof v === 'number') push(a.probes, k, v)
  for (const [k, v] of Object.entries(r.metrics)) if (typeof v === 'number') push(a.metrics, k, v)
}

export function classify(base: number, cand: number): CaseClass {
  const d = cand - base
  if (d >= 0.5) return 'improved'
  if (d <= -0.5) return 'regressed'
  if (base >= 0.66 && cand >= 0.66) return 'both-pass'
  if (base <= 0.34 && cand <= 0.34) return 'both-fail'
  return 'unclear'
}

export function verdictOf(meanDelta: number): string {
  if (meanDelta >= 0.4) return 'clear gain'
  if (meanDelta >= 0.15) return 'likely gain'
  if (meanDelta > -0.15) return 'no measurable effect'
  return 'regression'
}

export const num = (x: number | null, digits = 2): string => (x === null ? '–' : x.toFixed(digits))
export const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`

function isGradeLine(x: unknown): x is GradeLine {
  return isObject(x) && typeof x.arm === 'string' && typeof x.case === 'string' && typeof x.run === 'number' && isObject(x.checks)
}

export function applyGrades(records: RunRecord[], grades: unknown[]): Graded[] {
  const latest = new Map<string, GradeLine>()
  for (const g of grades) if (isGradeLine(g)) latest.set(`${g.arm}\0${g.case}\0${g.run}`, g)
  return records.map((r) => {
    const g = latest.get(`${r.arm}\0${r.case}\0${r.run}`)
    if (g === undefined) return r
    if (typeof g.graderError === 'string') return { ...r, judged: true, graderError: g.graderError }
    const checks = { ...r.checks, ...g.checks }
    return { ...r, judged: true, checks, pass: Object.values(checks).every(Boolean) }
  })
}

export function ungradedProblems(graded: Graded[], arms: readonly string[]): string[] {
  const judged: string[] = []
  for (const r of graded) if (r.judged === true && !judged.includes(r.case)) judged.push(r.case)
  const out: string[] = []
  for (const id of judged) {
    for (const arm of arms) {
      const missing = graded.filter((r) => r.case === id && r.arm === arm && r.judged !== true).length
      if (missing > 0) out.push(`${id}: ${arm} has ${missing} ungraded run(s) of a graded case, so its pass rate mixes judged and unjudged runs`)
    }
  }
  return out
}

interface ArmMeta { cases: Set<string>; profiles: Set<string>; fixtures: Set<string>; runs: Set<number>; caseIds: Set<string>; appendArgs: Set<string>; unhashed: boolean; lines: number }

function isMetaLine(x: unknown): x is MetaLine {
  return isObject(x) && typeof x.arm === 'string' && (x.kind === undefined || x.kind === 'run') && Array.isArray(x.caseIds)
}

function armMeta(lines: MetaLine[], arm: string): ArmMeta {
  const m: ArmMeta = { cases: new Set(), profiles: new Set(), fixtures: new Set(), runs: new Set(), caseIds: new Set(), appendArgs: new Set(), unhashed: false, lines: 0 }
  for (const l of lines) {
    if (l.arm !== arm) continue
    m.lines += 1
    if (typeof l.casesSha256 === 'string') m.cases.add(l.casesSha256)
    else m.unhashed = true
    if (typeof l.profileSha256 === 'string') m.profiles.add(l.profileSha256)
    else if (l.profile !== null) m.unhashed = true
    m.fixtures.add(JSON.stringify(Object.entries(l.fixtures ?? {}).sort()))
    m.runs.add(l.runs)
    for (const id of l.caseIds) m.caseIds.add(id)
    m.appendArgs.add(JSON.stringify(l.appendArgs ?? []))
  }
  return m
}

const same = <T>(a: Set<T>, b: Set<T>): boolean => a.size === b.size && [...a].every((x) => b.has(x))

export function metaProblems(lines: MetaLine[], baseline: string, candidate: string): { hard: string[]; soft: string[] } {
  const b = armMeta(lines, baseline)
  const c = armMeta(lines, candidate)
  const hard: string[] = []
  const soft: string[] = []
  if (b.lines === 0 || c.lines === 0) {
    soft.push(`meta.jsonl has no line for ${b.lines === 0 ? baseline : candidate}; the runner cannot prove both arms ran the same cases`)
    return { hard, soft }
  }
  for (const [arm, m] of [[baseline, b], [candidate, c]] as const) {
    if (m.cases.size > 1) hard.push(`${arm} ran ${m.cases.size} different versions of the cases file`)
    if (m.profiles.size > 1) hard.push(`${arm} ran ${m.profiles.size} different versions of the profile`)
  }
  if (!same(b.cases, c.cases) && b.cases.size > 0 && c.cases.size > 0) hard.push('the arms ran different versions of the cases file (sha256 differs)')
  if (!same(b.profiles, c.profiles) && b.profiles.size > 0 && c.profiles.size > 0) hard.push('the arms ran different versions of the profile (sha256 differs)')
  if (!same(b.fixtures, c.fixtures)) hard.push('the arms ran different fixtures (sha256 differs)')
  if (!same(b.runs, c.runs)) hard.push(`the arms ran different run counts (${[...b.runs].join(', ')} against ${[...c.runs].join(', ')})`)
  if (!same(b.caseIds, c.caseIds)) hard.push('the arms ran different case sets')
  if (!same(b.appendArgs, c.appendArgs)) soft.push('the arms differ in --append-arg; fine when that is the declared variant (a plugin dir, a rules file), not when it is the model or effort')
  if (b.unhashed || c.unhashed) soft.push('meta.jsonl lines without hashes (an older runner): the cases, profile and fixtures could not be compared')
  return { hard, soft }
}

function spread(xs: number[]): { min: number | null; max: number | null; stddev: number | null } {
  return xs.length === 0 ? { min: null, max: null, stddev: null } : { min: Math.min(...xs), max: Math.max(...xs), stddev: stddev(xs) }
}

export async function summarizeCommand(args: Args): Promise<number> {
  const target = args.positionals[0]
  if (target === undefined) throw new InputError('summarize needs a results directory or a results.jsonl file')
  const path = target.endsWith('.jsonl') ? resolve(target) : join(resolve(target), 'results.jsonl')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    throw new InputError(`cannot read ${path}: ${message(e)}`)
  }
  const records: RunRecord[] = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const r: unknown = JSON.parse(line)
      if (isRunRecord(r)) records.push(r)
      else skipped += 1
    } catch {
      skipped += 1
    }
  }
  if (records.length === 0) throw new InputError(`${path} holds no run records`)
  const graded = applyGrades(records, (await readJsonLines(join(dirname(path), 'grades.jsonl'))).items)
  const judgedCases = new Set(graded.filter((r) => r.judged === true).map((r) => r.case))

  const arms: string[] = []
  const caseIds: string[] = []
  const perArm = new Map<string, Agg>()
  const perCell = new Map<string, Agg>()
  const cell = (arm: string, id: string) => `${arm}\u0000${id}`
  for (const r of graded) {
    if (!arms.includes(r.arm)) arms.push(r.arm)
    if (!caseIds.includes(r.case)) caseIds.push(r.case)
    const a = perArm.get(r.arm) ?? newAgg()
    addRecord(a, r)
    perArm.set(r.arm, a)
    const c = perCell.get(cell(r.arm, r.case)) ?? newAgg()
    addRecord(c, r)
    perCell.set(cell(r.arm, r.case), c)
  }

  let baseline = last(args, '--baseline')
  let candidate = last(args, '--candidate')
  if ((baseline === undefined) !== (candidate === undefined)) throw new InputError('pass both --baseline and --candidate, or neither')
  if (baseline === undefined && arms.length === 2) {
    baseline = arms[0]
    candidate = arms[1]
  }
  for (const a of [baseline, candidate]) {
    if (a !== undefined && !arms.includes(a)) throw new InputError(`arm "${a}" is not in ${path} (arms: ${arms.join(', ')})`)
  }
  const caveats: string[] = []
  if (baseline !== undefined && candidate !== undefined) {
    const meta = (await readJsonLines(join(dirname(path), 'meta.jsonl'))).items.filter(isMetaLine)
    const problems = metaProblems(meta, baseline, candidate)
    const ungraded = ungradedProblems(graded, [baseline, candidate])
    if ((problems.hard.length > 0 || ungraded.length > 0) && !args.flags.has('--allow-mixed')) {
      for (const p of [...problems.hard, ...ungraded]) process.stderr.write(`run.ts: ${p}\n`)
      if (problems.hard.length > 0) process.stderr.write('run.ts: the comparison would not isolate the variant; rerun the arms with the same frozen cases into a fresh --out, or pass --allow-mixed to list it as a caveat\n')
      if (ungraded.length > 0) process.stderr.write('run.ts: run `run.ts grade` for every run of both arms (without --arm or --case), or pass --allow-mixed to list it as a caveat\n')
      return 2
    }
    caveats.push(...problems.hard.map((p) => `mixed arms (--allow-mixed): ${p}`), ...ungraded.map((p) => `partly graded (--allow-mixed): ${p}`), ...problems.soft)
  } else {
    caveats.push(...ungradedProblems(graded, arms).map((p) => `partly graded: ${p}`))
  }
  if (judgedCases.size > 0) caveats.push(`${judgedCases.size} case(s) are graded by a model against their rubric (${[...judgedCases].join(', ')}): the grade is a judgment, blinded only partly, since a transcript can name the target`)
  const graderErrors = [...perArm.values()].reduce((s, a) => s + a.graderErrors, 0)
  if (graderErrors > 0) caveats.push(`${graderErrors} run(s) have a grader error and are left out of the pass rates (not counted as failures); grade them again with --regrade`)

  const armRows = arms.map((arm) => {
    const a = perArm.get(arm) ?? newAgg()
    const d = spread(a.durations.map((x) => x / 1000))
    return {
      arm, runs: a.runs, passRate: a.runs === 0 ? 0 : a.passes / a.runs, timeouts: a.timeouts, nonzeroExits: a.nonzero,
      startErrors: a.startErrors, graderErrors: a.graderErrors, medianSeconds: (median(a.durations) ?? 0) / 1000,
      seconds: { mean: (mean(a.durations) ?? 0) / 1000, ...d },
      probes: Object.fromEntries([...a.probes].map(([k, v]) => [k, mean(v)])),
      metrics: Object.fromEntries([...a.metrics].map(([k, v]) => [k, mean(v)])),
      metricSpread: Object.fromEntries([...a.metrics].map(([k, v]) => [k, spread(v)])),
    }
  })

  const caseRows = caseIds.map((id) => {
    const cells: Record<string, { runs: number; passes: number; passRate: number; unanimous: boolean; graderErrors: number }> = {}
    for (const arm of arms) {
      const a = perCell.get(cell(arm, id))
      if (a !== undefined && a.runs > 0) cells[arm] = { runs: a.runs, passes: a.passes, passRate: a.passes / a.runs, unanimous: a.passes === 0 || a.passes === a.runs, graderErrors: a.graderErrors }
    }
    let delta: number | null = null
    let klass: CaseClass | null = null
    if (baseline !== undefined && candidate !== undefined) {
      const b = cells[baseline]
      const c = cells[candidate]
      if (b !== undefined && c !== undefined) {
        delta = c.passRate - b.passRate
        klass = classify(b.passRate, c.passRate)
      }
    }
    return { case: id, judged: judgedCases.has(id), arms: cells, delta, class: klass }
  })
  const split = caseRows.filter((r) => Object.values(r.arms).some((c) => !c.unanimous))

  let comparison: null | { baseline: string; candidate: string; meanDelta: number; verdict: string; counts: Record<CaseClass, number>; minRunsPerCase: number } = null
  if (baseline !== undefined && candidate !== undefined) {
    const paired = caseRows.filter((r) => r.delta !== null)
    const counts: Record<CaseClass, number> = { improved: 0, regressed: 0, 'both-pass': 0, 'both-fail': 0, unclear: 0 }
    for (const r of paired) if (r.class !== null) counts[r.class] += 1
    const meanDelta = mean(paired.map((r) => r.delta ?? 0)) ?? 0
    const minRuns = Math.min(...paired.flatMap((r) => [r.arms[baseline]?.runs ?? 0, r.arms[candidate]?.runs ?? 0]))
    comparison = { baseline, candidate, meanDelta, verdict: verdictOf(meanDelta), counts, minRunsPerCase: Number.isFinite(minRuns) ? minRuns : 0 }
  }

  if (args.flags.has('--json')) {
    process.stdout.write(`${JSON.stringify({ file: path, skippedLines: skipped, arms: armRows, cases: caseRows, nonUnanimous: split.map((r) => r.case), comparison, caveats }, null, 2)}\n`)
    return 0
  }

  const lines: string[] = [`# Benchmark summary`, ``, `Source: \`${path}\`${skipped > 0 ? ` (${skipped} unreadable lines skipped)` : ''}`, ``, `## Arms`, ``,
    `| Arm | Runs | Pass rate | Timeouts | Non-zero exits | Start errors | Grader errors | Median time | Time min-max (sd) |`, `|---|---|---|---|---|---|---|---|---|`]
  for (const r of armRows) lines.push(`| ${r.arm} | ${r.runs} | ${num(r.passRate)} | ${r.timeouts} | ${r.nonzeroExits} | ${r.startErrors} | ${r.graderErrors} | ${num(r.medianSeconds, 1)} s | ${num(r.seconds.min, 1)}-${num(r.seconds.max, 1)} s (${num(r.seconds.stddev, 1)}) |`)

  lines.push(``, comparison === null ? `## Cases` : `## Cases: ${comparison.baseline} → ${comparison.candidate}`, ``)
  if (comparison === null) {
    lines.push(`| Case | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---|').join('')}`)
    for (const r of caseRows) lines.push(`| ${r.case} | ${arms.map((a) => { const c = r.arms[a]; return c === undefined ? '–' : `${c.passes}/${c.runs}` }).join(' | ')} |`)
  } else {
    lines.push(`| Case | ${comparison.baseline} | ${comparison.candidate} | Δ | Class |`, `|---|---|---|---|---|`)
    for (const r of caseRows) {
      const b = r.arms[comparison.baseline]
      const c = r.arms[comparison.candidate]
      lines.push(`| ${r.case} | ${b === undefined ? '–' : `${b.passes}/${b.runs}`} | ${c === undefined ? '–' : `${c.passes}/${c.runs}`} | ${r.delta === null ? '–' : signed(r.delta)} | ${r.class ?? 'unpaired'} |`)
    }
  }

  const probeNames = [...new Set(armRows.flatMap((r) => Object.keys(r.probes)))].sort()
  if (probeNames.length > 0) {
    lines.push(``, `## Probes (mean count per run)`, ``, `| Probe | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---|').join('')}`)
    for (const n of probeNames) lines.push(`| ${n} | ${armRows.map((r) => num(r.probes[n] ?? null)).join(' | ')} |`)
  }
  const metricNames = [...new Set(armRows.flatMap((r) => Object.keys(r.metrics)))].sort()
  if (metricNames.length > 0) {
    lines.push(``, `## Metrics (mean per run)`, ``, `| Metric | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---|').join('')}`)
    for (const n of metricNames) lines.push(`| ${n} | ${armRows.map((r) => num(r.metrics[n] ?? null, 4)).join(' | ')} |`)
    lines.push(``, `| Metric spread (min-max, sd) | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---|').join('')}`)
    for (const n of metricNames) lines.push(`| ${n} | ${armRows.map((r) => { const s = r.metricSpread[n]; return s === undefined ? '-' : `${num(s.min, 4)}-${num(s.max, 4)} (${num(s.stddev, 4)})` }).join(' | ')} |`)
  }
  if (split.length > 0) {
    lines.push(``, `## Non-unanimous cases`, ``, `Runs of the same arm disagreed on these cases; read one passing and one failing transcript of each:`, ``)
    for (const r of split) lines.push(`- ${r.case}: ${Object.entries(r.arms).map(([a, c]) => `${a} ${c.passes}/${c.runs}`).join(', ')}`)
  }
  if (caveats.length > 0) {
    lines.push(``, `## Caveats`, ``)
    for (const c of caveats) lines.push(`- ${c}`)
  }

  if (comparison !== null) {
    const k = comparison.counts
    const step = comparison.minRunsPerCase > 0 ? 1 / comparison.minRunsPerCase : 1
    lines.push(``, `## Verdict`, ``,
      `Mean Δ ${signed(comparison.meanDelta)} over ${caseRows.filter((r) => r.delta !== null).length} paired cases → **${comparison.verdict}**.`,
      `Improved ${k.improved} · regressed ${k.regressed} · both pass ${k['both-pass']} · both fail ${k['both-fail']} · unclear ${k.unclear}.`,
      `At least ${comparison.minRunsPerCase} runs per case per arm: one run moves a pass rate by ${step.toFixed(2)}, so treat smaller differences as noise.`)
    if (k.regressed > 0) lines.push(`At least one case regressed: inspect its transcripts before keeping the change.`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

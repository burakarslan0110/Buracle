// The waves of a plan: the topological levels of its task graph, the way the board runs it.
//
// deps(t) = every earlier task that shares a path with t (an equal path, or a directory path ending in `/` that
// prefixes the other, as `filesOverlap` in ../board/model.ts) + the explicit `**Depends on:**` tasks. Unit durations:
// level(t) = 1 + max(level(d) for d in deps(t)), level 1 without deps. The width is the largest level, the critical
// path one longest chain. The module imports nothing, so format.ts can import it without a cycle.

export interface WaveTask { n: number; files: ReadonlyArray<{ path: string }>; dependsOn?: readonly number[] }
export interface WavePlan {
  /** Wave numbers start at 1; the tasks of a wave are ascending. */
  waves: Array<{ wave: number; tasks: number[] }>
  /** The most tasks in one wave (0 for no tasks). */
  width: number
  /** The task numbers along one longest chain, in order; ties go to the lowest task numbers from the start. */
  criticalPath: number[]
  /** The deps used, implicit + explicit, ascending; unknown, later and self references are dropped. */
  depsOf: Record<number, number[]>
}

export const DEFAULT_MAX_WORKERS = 6

const TASK_NUMBER = /(?:task\s*)?(\d+)/gi
const FENCE = /^ {0,3}(?:`{3,}|~{3,})/

/**
 * The repository-relative paths a Files entry names, as ../board/model.ts reads them (`pathsOf`): backticks gone,
 * `./` and backslashes normalized, both sides of a `a -> b` rename. The verb is unknown here, so the arrow splits
 * every entry; a real path never holds ` -> `.
 */
export function wavePaths(files: ReadonlyArray<{ path: string }>): string[] {
  const out: string[] = []
  for (const f of files) {
    for (const part of f.path.trim().replace(/`/g, '').split(/\s*->\s*/)) {
      let s = part.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
      while (s.startsWith('./')) s = s.slice(2)
      if (s !== '') out.push(s)
    }
  }
  return out
}

function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  if (a.endsWith('/') && b.startsWith(a)) return true
  if (b.endsWith('/') && a.startsWith(b)) return true
  return false
}

/** The first path the two lists share (the shorter one of a directory match), or undefined: `sharedPath` in ../board/model.ts. */
export function sharedPathOf(a: ReadonlyArray<{ path: string }>, b: ReadonlyArray<{ path: string }>): string | undefined {
  const right = wavePaths(b)
  for (const p of wavePaths(a)) {
    const hit = right.find(q => pathsOverlap(p, q))
    if (hit !== undefined) return p.length <= hit.length ? p : hit
  }
  return undefined
}

/** One card per task number (the first wins), ascending. */
function ordered(tasks: readonly WaveTask[]): WaveTask[] {
  const seen = new Set<number>()
  const out: WaveTask[] = []
  for (const t of tasks) {
    if (seen.has(t.n)) continue
    seen.add(t.n)
    out.push(t)
  }
  return out.sort((a, b) => a.n - b.n)
}

function depsOfOrdered(tasks: readonly WaveTask[]): Record<number, number[]> {
  const known = new Set(tasks.map(t => t.n))
  const out: Record<number, number[]> = {}
  for (const t of tasks) {
    const deps = new Set<number>()
    for (const earlier of tasks) {
      if (earlier.n >= t.n) break
      if (sharedPathOf(earlier.files, t.files) !== undefined) deps.add(earlier.n)
    }
    for (const d of t.dependsOn ?? []) if (known.has(d) && d < t.n) deps.add(d)
    out[t.n] = [...deps].sort((a, b) => a - b)
  }
  return out
}

/** The dependencies the board derives for every task: implicit (a shared path with an earlier task) plus the valid explicit ones. */
export function taskDeps(tasks: readonly WaveTask[]): Record<number, number[]> {
  return depsOfOrdered(ordered(tasks))
}

export function wavesOf(tasks: readonly WaveTask[]): WavePlan {
  const list = ordered(tasks)
  const depsOf = depsOfOrdered(list)
  // Every dep has a lower number, so one ascending pass gives the levels.
  const level = new Map<number, number>()
  for (const t of list) {
    let max = 0
    for (const d of depsOf[t.n] ?? []) max = Math.max(max, level.get(d) ?? 0)
    level.set(t.n, max + 1)
  }
  const depth = list.length === 0 ? 0 : Math.max(...list.map(t => level.get(t.n) ?? 1))
  const waves: WavePlan['waves'] = []
  for (let w = 1; w <= depth; w++) waves.push({ wave: w, tasks: list.filter(t => level.get(t.n) === w).map(t => t.n) })
  const width = waves.reduce((m, w) => Math.max(m, w.tasks.length), 0)
  // The longest chain that starts at each task, from the highest number down (successors have higher numbers).
  const successors = new Map<number, number[]>()
  for (const t of list) for (const d of depsOf[t.n] ?? []) successors.set(d, [...(successors.get(d) ?? []), t.n])
  const ahead = new Map<number, number>()
  for (const t of [...list].reverse()) {
    let max = 0
    for (const s of successors.get(t.n) ?? []) max = Math.max(max, ahead.get(s) ?? 0)
    ahead.set(t.n, max + 1)
  }
  // The lexicographically lowest longest chain: the lowest start that begins one, then the lowest successor that keeps it longest.
  const criticalPath: number[] = []
  let cursor = list.find(t => ahead.get(t.n) === depth)?.n
  while (cursor !== undefined) {
    criticalPath.push(cursor)
    const remaining = (ahead.get(cursor) ?? 1) - 1
    cursor = remaining <= 0 ? undefined : (successors.get(cursor) ?? []).sort((a, b) => a - b).find(s => ahead.get(s) === remaining)
  }
  return { waves, width, criticalPath, depsOf }
}

function taskList(ns: readonly number[]): string {
  return ns.map(n => `Task ${n}`).join(', ')
}

/** The `## Swarm Plan` block, heading included, without a trailing newline. */
export function renderSwarmPlan(plan: WavePlan, o?: { maxWorkers?: number }): string {
  const maxWorkers = o?.maxWorkers ?? DEFAULT_MAX_WORKERS
  const total = plan.waves.reduce((n, w) => n + w.tasks.length, 0)
  const path = plan.criticalPath.length === 0 ? 'none' : plan.criticalPath.map(n => `Task ${n}`).join(' → ')
  return [
    '## Swarm Plan',
    '| Wave | Tasks | Width |',
    '|---|---|---|',
    ...plan.waves.map(w => `| ${w.wave} | ${taskList(w.tasks)} | ${w.tasks.length} |`),
    '',
    `Critical path: ${path} (${plan.criticalPath.length} of ${total} task${total === 1 ? '' : 's'}).`,
    `Workers: up to ${plan.width} at the widest wave; the lead scales from 1 to ${maxWorkers}.`,
  ].join('\n')
}

/** The task → wave mapping of a `## Swarm Plan` table (rows `| <wave> | Task a, Task b | … |`); undefined when the lines hold no table row. */
export function parseSwarmPlan(lines: readonly string[]): Map<number, number> | undefined {
  const out = new Map<number, number>()
  let rows = 0
  let fenced = false
  for (const raw of lines) {
    if (FENCE.test(raw)) { fenced = !fenced; continue }
    if (fenced) continue
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    const cells = line.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    if (cells.length < 2 || cells.every(c => /^:?-+:?$/.test(c))) continue
    const wave = /^\d+$/.test(cells[0] as string) ? Number(cells[0]) : undefined
    if (wave === undefined || wave < 1) continue
    rows++
    for (const m of (cells[1] as string).matchAll(TASK_NUMBER)) {
      const n = Number(m[1])
      if (Number.isInteger(n) && n > 0 && !out.has(n)) out.set(n, wave)
    }
  }
  return rows === 0 ? undefined : out
}

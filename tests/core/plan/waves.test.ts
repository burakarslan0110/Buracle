import { describe, expect, test } from 'bun:test'
import { filesOverlap, type BoardFile } from '../../../src/core/board/model'
import { parseSwarmPlan, renderSwarmPlan, sharedPathOf, taskDeps, wavePaths, wavesOf, type WaveTask } from '../../../src/core/plan/waves'

const task = (n: number, files: string[], dependsOn?: number[]): WaveTask => ({ n, files: files.map(path => ({ path })), ...(dependsOn !== undefined ? { dependsOn } : {}) })

// A foundation task, three disjoint tasks that depend on it, one integration task after them.
const STAR: WaveTask[] = [
  task(1, ['src/import/types.ts', 'src/import/registry.ts', 'tests/import/registry.test.ts']),
  task(2, ['src/import/csv.ts', 'tests/import/csv.test.ts'], [1]),
  task(3, ['src/import/json.ts', 'tests/import/json.test.ts'], [1]),
  task(4, ['src/import/xml.ts', 'tests/import/xml.test.ts'], [1]),
  task(5, ['src/import/index.ts', 'README.md', 'tests/import/index.test.ts'], [2, 3, 4]),
]

const STAR_BLOCK = [
  '## Swarm Plan',
  '| Wave | Tasks | Width |',
  '|---|---|---|',
  '| 1 | Task 1 | 1 |',
  '| 2 | Task 2, Task 3, Task 4 | 3 |',
  '| 3 | Task 5 | 1 |',
  '',
  'Critical path: Task 1 → Task 2 → Task 5 (3 of 5 tasks).',
  'Workers: up to 3 at the widest wave; the lead scales from 1 to 6.',
].join('\n')

describe('wavesOf', () => {
  test('a chain of shared files gives one task per wave, width 1 and the whole chain as the critical path', () => {
    const plan = wavesOf([task(1, ['src/a.ts']), task(2, ['src/a.ts', 'src/b.ts']), task(3, ['src/b.ts'])])
    expect(plan).toEqual({
      waves: [{ wave: 1, tasks: [1] }, { wave: 2, tasks: [2] }, { wave: 3, tasks: [3] }],
      width: 1,
      criticalPath: [1, 2, 3],
      depsOf: { 1: [], 2: [1], 3: [2] },
    })
  })

  test('a star (foundation, three disjoint tasks, integration) gives three waves of width 3 with the lowest-numbered longest chain', () => {
    const plan = wavesOf(STAR)
    expect(plan.waves).toEqual([{ wave: 1, tasks: [1] }, { wave: 2, tasks: [2, 3, 4] }, { wave: 3, tasks: [5] }])
    expect(plan.width).toBe(3)
    expect(plan.criticalPath).toEqual([1, 2, 5])
    expect(plan.depsOf).toEqual({ 1: [], 2: [1], 3: [1], 4: [1], 5: [2, 3, 4] })
  })

  test('a diamond joins in the third wave; two separate chains tie-break on the lowest task numbers from the start', () => {
    const diamond = wavesOf([task(1, ['src/core.ts']), task(2, ['src/a.ts'], [1]), task(3, ['src/b.ts'], [1]), task(4, ['src/a.ts', 'src/b.ts'])])
    expect(diamond.waves).toEqual([{ wave: 1, tasks: [1] }, { wave: 2, tasks: [2, 3] }, { wave: 3, tasks: [4] }])
    expect(diamond.width).toBe(2)
    expect(diamond.criticalPath).toEqual([1, 2, 4])
    expect(diamond.depsOf[4]).toEqual([2, 3])
    const chains = wavesOf([task(1, ['src/a.ts']), task(2, ['src/b.ts']), task(3, ['src/b.ts']), task(4, ['src/a.ts'])])
    expect(chains.waves).toEqual([{ wave: 1, tasks: [1, 2] }, { wave: 2, tasks: [3, 4] }])
    expect(chains.criticalPath).toEqual([1, 4])
  })

  test('tasks without any dependency form one wave; an empty plan has width 0 and no critical path', () => {
    expect(wavesOf([task(1, ['a.ts']), task(2, ['b.ts']), task(3, [])])).toEqual({ waves: [{ wave: 1, tasks: [1, 2, 3] }], width: 3, criticalPath: [1], depsOf: { 1: [], 2: [], 3: [] } })
    expect(wavesOf([])).toEqual({ waves: [], width: 0, criticalPath: [], depsOf: {} })
  })

  test('a directory path ending in / serializes every task under it, as the board does', () => {
    const plan = wavesOf([task(1, ['src/x/']), task(2, ['src/x/a.ts']), task(3, ['src/y/b.ts']), task(4, ['src/x/deep/c.ts'])])
    expect(plan.depsOf).toEqual({ 1: [], 2: [1], 3: [], 4: [1] })
    expect(plan.waves).toEqual([{ wave: 1, tasks: [1, 3] }, { wave: 2, tasks: [2, 4] }])
    expect(wavesOf([task(1, ['src/x']), task(2, ['src/x/a.ts'])]).depsOf[2]).toEqual([])
  })

  test('unknown, later and self references in dependsOn are dropped; explicit and implicit deps merge, deduplicated and ascending', () => {
    const plan = wavesOf([task(1, ['a.ts']), task(2, ['b.ts'], [2, 3, 9, 1, 1]), task(3, ['b.ts'], [1, 2])])
    expect(plan.depsOf).toEqual({ 1: [], 2: [1], 3: [1, 2] })
    expect(plan.waves).toEqual([{ wave: 1, tasks: [1] }, { wave: 2, tasks: [2] }, { wave: 3, tasks: [3] }])
    expect(taskDeps([task(1, ['a.ts']), task(2, ['b.ts'], [7])])).toEqual({ 1: [], 2: [] })
  })

  test('the input order does not matter and a duplicate task number keeps its first card', () => {
    expect(wavesOf([...STAR].reverse())).toEqual(wavesOf(STAR))
    expect(wavesOf([task(1, ['a.ts']), task(1, ['b.ts']), task(2, ['a.ts'])]).depsOf).toEqual({ 1: [], 2: [1] })
  })
})

describe('sharedPathOf and wavePaths', () => {
  const files = (paths: string[], verb: BoardFile['verb'] = 'Modify'): BoardFile[] => paths.map(path => ({ verb, path }))

  test('equal paths and a directory prefix overlap, nothing else; the shorter path is named', () => {
    expect(sharedPathOf([{ path: 'src/a.ts' }], [{ path: 'src/b.ts' }, { path: 'src/a.ts' }])).toBe('src/a.ts')
    expect(sharedPathOf([{ path: 'src/x/a.ts' }], [{ path: 'src/x/' }])).toBe('src/x/')
    expect(sharedPathOf([{ path: 'src/x/' }], [{ path: 'src/x/a.ts' }])).toBe('src/x/')
    expect(sharedPathOf([{ path: 'src/x' }], [{ path: 'src/x/a.ts' }])).toBeUndefined()
    expect(sharedPathOf([{ path: 'src/a.ts' }], [{ path: 'src/a.tsx' }])).toBeUndefined()
    expect(sharedPathOf([], [{ path: 'src/a.ts' }])).toBeUndefined()
  })

  test('backticks, ./ prefixes, backslashes and both sides of a rename are read as the board reads them', () => {
    expect(wavePaths([{ path: '`src/a.ts`' }, { path: './src/b.ts' }, { path: 'src\\c.ts' }, { path: '`docs/old.md` -> `docs/new.md`' }, { path: '  ' }])).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'docs/old.md', 'docs/new.md'])
    expect(sharedPathOf([{ path: '`docs/old.md` -> `docs/new.md`' }], [{ path: 'docs/new.md' }])).toBe('docs/new.md')
  })

  test('agrees with filesOverlap in src/core/board/model.ts on every pair', () => {
    const cases: Array<[BoardFile[], BoardFile[]]> = [
      [files(['src/a.ts']), files(['src/a.ts'])],
      [files(['src/a.ts']), files(['src/b.ts'])],
      [files(['src/x/']), files(['src/x/a.ts'])],
      [files(['src/x/a.ts']), files(['src/x/'])],
      [files(['src/x']), files(['src/x/a.ts'])],
      [files(['./src/a.ts']), files(['`src/a.ts`'])],
      [files(['docs/old.md -> docs/new.md'], 'Rename'), files(['docs/new.md'])],
      [files(['docs/old.md -> docs/new.md'], 'Rename'), files(['docs/other.md'])],
      [files([]), files(['src/a.ts'])],
      [files(['a.ts', 'b.ts']), files(['c.ts', 'b.ts'])],
    ]
    for (const [a, b] of cases) {
      expect({ a, b, shared: sharedPathOf(a, b) !== undefined }).toEqual({ a, b, shared: filesOverlap(a, b) })
    }
  })
})

describe('renderSwarmPlan and parseSwarmPlan', () => {
  test('renders the exact block of the contract, deterministically, with the worker cap', () => {
    expect(renderSwarmPlan(wavesOf(STAR))).toBe(STAR_BLOCK)
    expect(renderSwarmPlan(wavesOf(STAR))).toBe(renderSwarmPlan(wavesOf([...STAR].reverse())))
    expect(renderSwarmPlan(wavesOf(STAR), { maxWorkers: 4 })).toBe(STAR_BLOCK.replace('from 1 to 6', 'from 1 to 4'))
  })

  test('one task and no task render without a plural slip', () => {
    const one = renderSwarmPlan(wavesOf([task(1, ['a.ts'])]))
    expect(one).toContain('| 1 | Task 1 | 1 |')
    expect(one).toContain('Critical path: Task 1 (1 of 1 task).')
    expect(one).toContain('Workers: up to 1 at the widest wave; the lead scales from 1 to 6.')
    const none = renderSwarmPlan(wavesOf([]))
    expect(none).toBe('## Swarm Plan\n| Wave | Tasks | Width |\n|---|---|---|\n\nCritical path: none (0 of 0 tasks).\nWorkers: up to 0 at the widest wave; the lead scales from 1 to 6.')
  })

  test('parse round-trips render into the task → wave mapping', () => {
    const map = parseSwarmPlan(STAR_BLOCK.split('\n'))
    expect(map).toEqual(new Map([[1, 1], [2, 2], [3, 2], [4, 2], [5, 3]]))
    for (const plan of [wavesOf(STAR), wavesOf([task(1, ['a.ts']), task(2, ['a.ts'])]), wavesOf([task(1, ['a.ts'])])]) {
      const expected = new Map(plan.waves.flatMap(w => w.tasks.map(n => [n, w.wave] as [number, number])))
      expect(parseSwarmPlan(renderSwarmPlan(plan).split('\n'))).toEqual(expected)
    }
  })

  test('accepts bare numbers and spacing variants, skips a fenced table, and gives undefined without a table', () => {
    expect(parseSwarmPlan(['|Wave|Tasks|Width|', '|:-:|---|--:|', '| 1 | 1, 2 | 2 |', '| 2 | Task 3 and Task 4 | 2 |'])).toEqual(new Map([[1, 1], [2, 1], [3, 2], [4, 2]]))
    expect(parseSwarmPlan(['## Swarm Plan', 'Nothing here yet.'])).toBeUndefined()
    expect(parseSwarmPlan([])).toBeUndefined()
    expect(parseSwarmPlan(['```', '| 1 | Task 1 | 1 |', '```'])).toBeUndefined()
    expect(parseSwarmPlan(['| Wave | Tasks | Width |', '|---|---|---|'])).toBeUndefined()
  })
})

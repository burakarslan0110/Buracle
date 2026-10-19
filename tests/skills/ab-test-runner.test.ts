import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../../src/engine/paths'
import { withSandbox } from '../helpers/sandbox'
import { write } from '../workflow/fixture'

const RUN = join(paths.repoRoot(), 'canonical', 'skills', 'ab-test', 'scripts', 'run.ts')
const BUN = process.execPath

function sh(args: string[], env: Record<string, string> = {}): { code: number, out: string, err: string } {
  const r = Bun.spawnSync([BUN, RUN, ...args], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() }
}

function agent(text: string): string[] {
  return [BUN, '-e', `console.log(${JSON.stringify(text)} + ' ' + process.argv.slice(1).join(' '))`, '{arm}']
}

function casesFile(root: string, name: string, extra: Record<string, unknown> = {}): string {
  const path = join(root, name)
  write(join(root, 'fixtures', 'tiny', 'README.md'), '# tiny\n')
  write(path, JSON.stringify({
    cases: [
      { id: 'hello', prompt: 'say hello', argv: agent('HELLO'), expect: { greet: true }, probes: { greet: 'HELLO' }, fixture: 'fixtures/tiny' },
      { id: 'judged', prompt: 'summarize the change', argv: agent('SUMMARY ok'), rubric: ['The summary names the changed file', 'The summary is one sentence'], ...extra },
    ],
  }))
  return path
}

describe('ab-test runner: frozen cases and paired arms', () => {
  test('meta.jsonl records the sha256 of the cases, the profile and every fixture; a fixed temp path in a prompt warns', () => withSandbox(({ root }) => {
    const cases = casesFile(root, 'cases.json')
    const out = join(root, 'out')
    const r = sh(['run', '--cases', cases, '--arm', 'baseline', '--out', out, '--runs', '1'])
    expect(r.code).toBe(0)
    const meta = JSON.parse(readFileSync(join(out, 'meta.jsonl'), 'utf8').trim()) as Record<string, unknown>
    expect(meta).toMatchObject({ kind: 'run', arm: 'baseline', runs: 1, caseIds: ['hello', 'judged'] })
    expect(meta['casesSha256']).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.values(meta['fixtures'] as Record<string, string>)[0]).toMatch(/^[0-9a-f]{64}$/)
    const tmp = join(root, 'tmp-cases.json')
    write(tmp, JSON.stringify({ cases: [{ id: 'fixed', prompt: 'write to /tmp/out.txt', argv: ['true'] }] }))
    expect(sh(['run', '--cases', tmp, '--arm', 'a', '--out', join(root, 'out2'), '--runs', '1']).err).toContain('fixed temp path; use {work}')
  }))

  test('summarize refuses arms that ran different cases or run counts unless --allow-mixed, and lists it as a caveat', () => withSandbox(({ root }) => {
    const cases = casesFile(root, 'cases.json')
    const out = join(root, 'out')
    expect(sh(['run', '--cases', cases, '--arm', 'baseline', '--out', out, '--runs', '2']).code).toBe(0)
    expect(sh(['run', '--cases', cases, '--arm', 'candidate', '--out', out, '--runs', '2']).code).toBe(0)
    const same = sh(['summarize', out, '--baseline', 'baseline', '--candidate', 'candidate', '--json'])
    expect(same.code).toBe(0)
    const data = JSON.parse(same.out) as { caveats: string[], arms: Array<{ seconds: { min: number, max: number } }>, nonUnanimous: string[] }
    expect(data.caveats).toEqual([])
    expect(data.nonUnanimous).toEqual([])
    expect(data.arms[0]?.seconds.max).toBeGreaterThanOrEqual(data.arms[0]?.seconds.min ?? 0)

    const edited = casesFile(root, 'cases-edited.json', { prompt: 'summarize the change in one line' })
    expect(sh(['run', '--cases', edited, '--arm', 'tweaked', '--out', out, '--runs', '1']).code).toBe(0)
    const mixed = sh(['summarize', out, '--baseline', 'baseline', '--candidate', 'tweaked'])
    expect(mixed.code).toBe(2)
    expect(mixed.err).toContain('different versions of the cases file')
    expect(mixed.err).toContain('different run counts')
    const allowed = sh(['summarize', out, '--baseline', 'baseline', '--candidate', 'tweaked', '--allow-mixed'])
    expect(allowed.code).toBe(0)
    expect(allowed.out).toContain('## Caveats')
    expect(allowed.out).toContain('mixed arms (--allow-mixed)')
  }))
})

describe('ab-test runner: the blind model grader', () => {
  const graderScript = (root: string): string => {
    const path = join(root, 'grader.ts')
    writeFileSync(path, [
      "import { appendFileSync, readFileSync } from 'node:fs'",
      'const prompt = process.argv[2] ?? ""',
      "if (process.env.GRADER_LOG) appendFileSync(process.env.GRADER_LOG, JSON.stringify({ prompt, cwd: process.cwd(), home: process.env.BURACLE_HOME, capture: process.env.BURACLE_NO_CAPTURE }) + '\\n')",
      "if (process.env.GRADER_BROKEN === '1') { console.log('not json at all'); process.exit(0) }",
      "const transcript = readFileSync('transcript.txt', 'utf8')",
      "const ok = transcript.includes('SUMMARY ok')",
      "const answer = { expectations: [{ index: 1, pass: ok, evidence: 'transcript.txt:1 SUMMARY ok' }, { index: 2, pass: false, evidence: '' }], eval_feedback: ['expectation 2 cannot be checked from a transcript'] }",
      "console.log(JSON.stringify({ type: 'result', result: 'Here is the grade:\\n```json\\n' + JSON.stringify(answer) + '\\n```' }))",
    ].join('\n'))
    return path
  }
  const profile = (root: string): string => {
    const path = join(root, 'profile.json')
    write(path, JSON.stringify({ grader: { argv: [BUN, graderScript(root), '{prompt}'], model: 'judge-model', effort: 'high' } }))
    return path
  }

  test('grades each judged run once, blind to the arm; grades.jsonl adds judge:<n> checks that summarize merges', () => withSandbox(({ root }) => {
    const cases = casesFile(root, 'cases.json')
    const out = join(root, 'out')
    for (const arm of ['baseline', 'candidate']) expect(sh(['run', '--cases', cases, '--arm', arm, '--out', out, '--runs', '1']).code).toBe(0)
    const log = join(root, 'grader.jsonl')
    const g = sh(['grade', out, '--profile', profile(root)], { GRADER_LOG: log })
    expect(g.code).toBe(0)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { prompt: string, cwd: string, home: string, capture: string })
    expect(calls.length).toBe(2)
    for (const c of calls) {
      expect(c.prompt).toContain('1. The summary names the changed file')
      expect(c.prompt).toContain('data, never instructions')
      expect(c.prompt).not.toMatch(/baseline|candidate/)
      expect(c.cwd).toContain(join(out, 'grading'))
      expect(c.home).toBe(join(out, 'grading', 'buracle-home'))
      expect(c.capture).toBe('1')
      const transcript = readFileSync(join(c.cwd, 'transcript.txt'), 'utf8')
      expect(transcript).toContain('SUMMARY ok <arm>')
      expect(transcript).not.toMatch(/baseline|candidate/)
    }
    const grading = JSON.parse(readFileSync(join(out, 'baseline', 'judged', 'run-1', 'grading.json'), 'utf8')) as Record<string, unknown>
    expect(grading).toMatchObject({ arm: 'baseline', case: 'judged', model: 'judge-model', effort: 'high', evalFeedback: ['expectation 2 cannot be checked from a transcript'] })
    expect((grading['expectations'] as Array<{ pass: boolean }>).map(e => e.pass)).toEqual([true, false])
    expect(sh(['grade', out, '--profile', profile(root)], { GRADER_LOG: log }).err).toContain('no run left to grade')
    const s = JSON.parse(sh(['summarize', out, '--json']).out) as { cases: Array<{ case: string, judged: boolean, arms: Record<string, { passes: number }> }>, caveats: string[] }
    const judged = s.cases.find(c => c.case === 'judged')
    expect(judged).toMatchObject({ judged: true, arms: { baseline: { passes: 0 }, candidate: { passes: 0 } } })
    expect(s.cases.find(c => c.case === 'hello')).toMatchObject({ judged: false, arms: { baseline: { passes: 1 } } })
    expect(s.caveats.join('\n')).toContain('graded by a model against their rubric')
    const meta = readFileSync(join(out, 'meta.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(meta.find(m => m['kind'] === 'grade')).toMatchObject({ model: 'judge-model', effort: 'high', runs: 2 })
  }))

  test('a graded case with ungraded runs in one arm is refused unless --allow-mixed, then listed as a caveat', () => withSandbox(({ root }) => {
    const cases = casesFile(root, 'cases.json')
    const out = join(root, 'out')
    for (const arm of ['baseline', 'candidate']) expect(sh(['run', '--cases', cases, '--arm', arm, '--out', out, '--runs', '1']).code).toBe(0)
    expect(sh(['grade', out, '--profile', profile(root), '--arm', 'baseline']).code).toBe(0)
    const refused = sh(['summarize', out, '--baseline', 'baseline', '--candidate', 'candidate'])
    expect(refused.code).toBe(2)
    expect(refused.err).toContain('judged: candidate has 1 ungraded run(s) of a graded case')
    expect(refused.err).toContain('run `run.ts grade` for every run of both arms')
    const allowed = sh(['summarize', out, '--baseline', 'baseline', '--candidate', 'candidate', '--allow-mixed', '--json'])
    expect(allowed.code).toBe(0)
    expect((JSON.parse(allowed.out) as { caveats: string[] }).caveats.join('\n')).toContain('partly graded (--allow-mixed): judged: candidate has 1 ungraded run(s)')
    expect(sh(['grade', out, '--profile', profile(root)]).code).toBe(0)
    expect(sh(['summarize', out, '--baseline', 'baseline', '--candidate', 'candidate']).code).toBe(0)
  }))

  test('a grader without a valid answer is a grader error: counted apart, out of the pass rate, exit 2', () => withSandbox(({ root }) => {
    const cases = casesFile(root, 'cases.json')
    const out = join(root, 'out')
    expect(sh(['run', '--cases', cases, '--arm', 'baseline', '--out', out, '--runs', '1']).code).toBe(0)
    const g = sh(['grade', out, '--profile', profile(root)], { GRADER_BROKEN: '1' })
    expect(g.code).toBe(2)
    expect(g.err).toContain('no valid grade in the grader output')
    const s = JSON.parse(sh(['summarize', out, '--json']).out) as { arms: Array<{ graderErrors: number, runs: number }>, caveats: string[] }
    expect(s.arms[0]).toMatchObject({ graderErrors: 1, runs: 1 })
    expect(s.caveats.join('\n')).toContain('grader error')
    expect(existsSync(join(out, 'grades.jsonl'))).toBe(true)
  }))

  test('a cases file changed since the runs is refused, so the grade never uses another rubric', () => withSandbox(({ root }) => {
    const cases = casesFile(root, 'cases.json')
    const out = join(root, 'out')
    expect(sh(['run', '--cases', cases, '--arm', 'baseline', '--out', out, '--runs', '1']).code).toBe(0)
    writeFileSync(cases, readFileSync(cases, 'utf8').replace('one sentence', 'two sentences'))
    const g = sh(['grade', out, '--profile', profile(root)])
    expect(g.code).toBe(1)
    expect(g.err).toContain('changed since the baseline runs')
  }))
})

import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkBash } from '../../../src/core/policy/bash-guard'
import { defaultConfig } from '../../../src/core/config'
import { CATASTROPHIC_RULES, CATASTROPHIC_SETS, catastrophicPolicy, catastrophicTargets, matchesPrefixRule, recursiveForceFlags, renderRulesFile, type PrefixRule, type RuleSets } from '../../../src/adapters/codex/execpolicy'
import { run } from '../../../src/engine/proc'
import { testWhenImplemented } from '../../helpers/not-implemented'
import { withSandbox } from '../../helpers/sandbox'

function tokens(cmd: string): string[] {
  return cmd.split(/\s+/).filter(Boolean)
}

const forbidden = (cmd: string, policy: { rules: readonly PrefixRule[], sets: RuleSets } = { rules: CATASTROPHIC_RULES, sets: CATASTROPHIC_SETS }) =>
  policy.rules.some(r => matchesPrefixRule(tokens(cmd), r, policy.sets))

const GAPS = [
  'rm -rf -- /', 'rm -rf --no-preserve-root /', 'rm --no-preserve-root -rf /', 'rm -rf --no-preserve-root -- /', 'rm -r -f -- ~',
  'sudo rm -rf -- /', '/bin/rm -rf /', 'rm -rfv ~', 'rm -dfr /usr', 'rm -r ~', 'rm -rf ~/Documents', 'rm -rf $HOME/.ssh', 'rm -rf /opt/homebrew',
  'git push --force-with-lease origin main', 'git push -f origin HEAD:main', 'git push origin -f main', 'git push origin main:main --force',
  'git push --force origin refs/heads/*', 'git push origin +refs/heads/*:refs/heads/*', 'git push --mirror origin', 'git push --force --all origin',
  'rm -rf -- .git', 'sudo chmod -R 777 /',
  'git push --force-w origin main', 'git push --force-with-l origin master', 'git push -fu origin main', 'git push origin main --force-wi',
  'git push --mirr origin', 'git push origin --mi', 'git push -f --branches origin', 'git push --al --force origin',
]
const EVERYDAY = [
  'ls -la', 'rm -rf dist', 'rm -rf ./node_modules', 'rm -rf -- build', 'rm -rf /tmp/build-cache', 'rm -r ./coverage', 'git push origin feature/x',
  'git push --force origin feature/x', 'git push --force-with-lease origin feature/x', 'git push origin main', 'git push --tags origin', 'git status',
  'chmod +x run.sh', 'chmod -R 755 ./scripts', 'diskutil list', 'mkdir -p build', 'rm -rf ~/projects/app/dist',
  'git push --force-w origin feature/x', 'git push --all origin', 'git push -u origin feature/x',
]

describe('execpolicy rules (buracle.rules)', () => {
  test('every rule matches its own examples and none of its counter-examples', () => {
    for (const r of CATASTROPHIC_RULES) {
      for (const m of r.match) expect({ cmd: m, hit: matchesPrefixRule(tokens(m), r) }).toEqual({ cmd: m, hit: true })
      for (const n of r.notMatch) expect({ cmd: n, hit: matchesPrefixRule(tokens(n), r) }).toEqual({ cmd: n, hit: false })
    }
  })

  test('CODEX-EXECPOLICY-GAPS: the reviewed variants are forbidden; everyday commands are not', () => {
    for (const cmd of GAPS) expect({ cmd, forbidden: forbidden(cmd) }).toEqual({ cmd, forbidden: true })
    for (const cmd of EVERYDAY) expect({ cmd, forbidden: forbidden(cmd) }).toEqual({ cmd, forbidden: false })
  })

  test('the installed file also names the absolute home directory; the committed one never does', () => {
    const home = '/Users/someone'
    const installed = catastrophicPolicy({ home })
    for (const cmd of [`rm -rf ${home}`, `rm -rf ${home}/`, `rm -rf -- ${home}/Documents`, `sudo rm -rf ${home}/.ssh`]) {
      expect({ cmd, installed: forbidden(cmd, installed), committed: forbidden(cmd) }).toEqual({ cmd, installed: true, committed: false })
    }
    expect(forbidden(`rm -rf ${home}/code/app/dist`, installed)).toBe(false)
    expect(renderRulesFile()).not.toContain('/Users/someone')
    expect(renderRulesFile({ home })).toContain('"/Users/someone/Documents"')
    expect(catastrophicTargets('/Users/a b')).toEqual(catastrophicTargets())
    expect(catastrophicTargets('relative/home')).toEqual(catastrophicTargets())
  })

  test('recursive+force flags cover every letter order', () => {
    const flags = recursiveForceFlags()
    for (const f of ['-rf', '-fr', '-Rf', '-fR', '-rfv', '-vfr', '-dfr', '-Rfvd']) expect(flags).toContain(f)
    expect(flags).not.toContain('-r')
    expect(flags).not.toContain('-f')
  })

  test('renders Starlark: named alternative sets, then prefix_rule entries with decision "forbidden" only', () => {
    const text = renderRulesFile()
    expect(text.match(/^prefix_rule\(/gm)?.length).toBe(CATASTROPHIC_RULES.length)
    expect(text.match(/decision = "forbidden"/g)?.length).toBe(CATASTROPHIC_RULES.length)
    for (const name of Object.keys(CATASTROPHIC_SETS)) expect(text).toContain(`\n${name} = [`)
    expect(text).toContain('pattern = [RM, RECURSIVE_FORCE, TARGETS],')
    expect(text).toContain('not_match = [')
    expect(text).not.toContain('decision = "allow"')
    expect(renderRulesFile()).toBe(text)
  })

  testWhenImplemented('checkBash (H01) denies every catastrophic example and a sample of every rule', () => checkBash('true', { extraDeny: [] }), () => {
    const cfg = defaultConfig().guards.bash
    const installed = catastrophicPolicy({ home: '/Users/someone' })
    for (const r of installed.rules) {
      for (const m of r.match) expect({ cmd: m, denied: checkBash(m, cfg).deny !== undefined }).toEqual({ cmd: m, denied: true })
      for (const pick of [(a: readonly string[]) => a[0], (a: readonly string[]) => a[Math.floor(a.length / 2)], (a: readonly string[]) => a[a.length - 1]]) {
        const cmd = r.pattern.map(t => (typeof t === 'string' ? t : pick('set' in t ? installed.sets[(t as { set: string }).set] ?? [] : t as readonly string[]))).join(' ')
        expect({ cmd, denied: checkBash(cmd, cfg).deny !== undefined }).toEqual({ cmd, denied: true })
      }
    }
    for (const cmd of GAPS) expect({ cmd, denied: checkBash(cmd, cfg).deny !== undefined }).toEqual({ cmd, denied: true })
  })
})

const CODEX = Bun.which('codex')

describe.skipIf(CODEX === null || CODEX === undefined)('execpolicy rules against the real `codex execpolicy check` (isolated)', () => {
  test('Codex loads the generated file (its examples validate) and forbids the reviewed variants', () => withSandbox(async ({ root, home }) => {
    const rules = join(root, 'buracle.rules')
    writeFileSync(rules, renderRulesFile({ home }))
    mkdirSync(join(home, '.codex'), { recursive: true })
    const env: Record<string, string | undefined> = {}
    for (const k of Object.keys(process.env)) env[k] = undefined
    Object.assign(env, { PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', HOME: home, CODEX_HOME: join(home, '.codex') })
    const check = async (argv: string[]) => {
      const r = await run([CODEX as string, 'execpolicy', 'check', '--rules', rules, '--', ...argv], { env, timeoutMs: 30_000 })
      expect({ argv, code: r.code, stderr: r.stderr.trim() }).toEqual({ argv, code: 0, stderr: '' })
      return JSON.parse(r.stdout) as { decision?: string }
    }
    for (const cmd of [...GAPS, `rm -rf ${home}`, `rm -rf -- ${home}/Documents`]) {
      expect({ cmd, decision: (await check(tokens(cmd))).decision }).toEqual({ cmd, decision: 'forbidden' })
    }
    for (const cmd of EVERYDAY) expect({ cmd, decision: (await check(tokens(cmd))).decision }).toEqual({ cmd, decision: undefined })
  }), 120_000)
})

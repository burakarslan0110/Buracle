import { describe, expect, test } from 'bun:test'
import { checkBash } from '../../../src/core/policy/bash-guard'
import type { CatastrophicRule } from '../../../src/core/policy/catastrophic'
import { CATASTROPHIC_COMMAND_RULES, catastrophicCommandRules, matchesCatastrophicRule } from '../../../src/core/policy/catastrophic'

const tokens = (cmd: string): string[] => cmd.split(/\s+/).filter(Boolean)
const forbidden = (rules: readonly CatastrophicRule[], cmd: string): boolean => rules.some(r => matchesCatastrophicRule(tokens(cmd), r))

function expansions(rule: CatastrophicRule): string[] {
  let out: string[][] = [[]]
  for (const p of rule.pattern) {
    const alts = typeof p === 'string' ? [p] : [...p]
    out = out.flatMap(prefix => alts.map(a => [...prefix, a]))
  }
  return out.map(a => a.join(' '))
}

describe('catastrophic command catalogue', () => {
  test('ids are unique kebab-case; every rule has a justification and examples', () => {
    const ids = CATASTROPHIC_COMMAND_RULES.map(r => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of CATASTROPHIC_COMMAND_RULES) {
      expect(r.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      expect(r.justification.trim().endsWith('.')).toBe(true)
      expect(r.match.length).toBeGreaterThan(0)
      expect(r.notMatch.length).toBeGreaterThan(0)
      expect(r.pattern.length).toBeGreaterThan(0)
    }
  })

  test('each rule matches its own examples and none of its counter-examples', () => {
    for (const r of catastrophicCommandRules({ home: '/Users/burak' })) {
      for (const m of r.match) expect({ rule: r.id, cmd: m, hit: matchesCatastrophicRule(tokens(m), r) }).toEqual({ rule: r.id, cmd: m, hit: true })
      for (const n of r.notMatch) expect({ rule: r.id, cmd: n, hit: matchesCatastrophicRule(tokens(n), r) }).toEqual({ rule: r.id, cmd: n, hit: false })
    }
  })

  test('consistent with H01: checkBash denies every command any pattern spells out', () => {
    const missed: string[] = []
    let n = 0
    for (const r of catastrophicCommandRules({ home: '/Users/burak' })) {
      for (const cmd of expansions(r)) {
        n++
        if (checkBash(cmd, { extraDeny: [] }).deny === undefined) missed.push(`${r.id}: ${cmd}`)
      }
      for (const m of r.match) if (checkBash(m, { extraDeny: [] }).deny === undefined) missed.push(`${r.id} example: ${m}`)
    }
    expect(missed).toEqual([])
    expect(n).toBeGreaterThan(5000)
  })

  test('covers the variants the review found missing from buracle.rules', () => {
    const rules = catastrophicCommandRules({ home: '/Users/burak' })
    for (const cmd of ['rm -rf -- /', 'rm -rf --no-preserve-root /', 'rm --no-preserve-root -rf /', 'rm -rf /Users/burak', 'rm -rf /Users/burak/',
      'rm -rf /Users/burak/Documents', 'git push --force-with-lease origin main', 'git push -f origin HEAD:main', 'git push --force-w origin main',
      'git push --mirr origin', 'git push origin --delet main', 'git push --force origin refs/heads/*', 'git push origin +refs/heads/*:refs/heads/*', 'sudo rm -rf -- /',
      'rm -rf ~/Documents/Buracle', 'kill -9 -1', 'crontab -r', 'gh repo delete me/x --yes']) {
      expect({ cmd, forbidden: forbidden(rules, cmd) }).toEqual({ cmd, forbidden: true })
    }
  })

  test('everyday commands are never forbidden', () => {
    const rules = catastrophicCommandRules({ home: '/Users/burak' })
    for (const cmd of ['ls -la', 'rm -rf dist', 'rm -rf ./node_modules', 'rm -rf /tmp/build-cache', 'rm -rf ~/.cache/x', 'git push origin feature/x', 'git push --force origin feature/x',
      'git push --force-with-lease origin spec/rate-limit', 'git push origin main', 'git push -u origin HEAD', 'git status', 'chmod +x run.sh', 'chmod -r file', 'diskutil list',
      'mkdir -p build', 'kill -9 1234', 'kill -1 4321', 'killall node', 'crontab -l', 'gh repo view', 'security find-generic-password -s x', 'rm -rf /Users/burak/project/build']) {
      expect({ cmd, forbidden: forbidden(rules, cmd) }).toEqual({ cmd, forbidden: false })
      expect({ cmd, h01: checkBash(cmd, { extraDeny: [] }).deny }).toEqual({ cmd, h01: undefined })
    }
  })

  test('the home path is added only when given and standard; the default catalogue is machine-independent', () => {
    const plain = JSON.stringify(catastrophicCommandRules())
    expect(plain).toBe(JSON.stringify(CATASTROPHIC_COMMAND_RULES))
    expect(plain).toBe(JSON.stringify(catastrophicCommandRules({})))
    expect(plain).not.toContain('/Users/burak')
    expect(JSON.stringify(catastrophicCommandRules({ home: '/Users/burak/' }))).toContain('"/Users/burak"')
    expect(JSON.stringify(catastrophicCommandRules({ home: '/home/dev' }))).toContain('"/home/dev/Documents"')
    expect(JSON.stringify(catastrophicCommandRules({ home: '/opt/me' }))).toBe(plain)
    expect(JSON.stringify(catastrophicCommandRules({ home: 'relative' }))).toBe(plain)
  })

  test('prefix matching follows execpolicy semantics', () => {
    const rule = CATASTROPHIC_COMMAND_RULES.find(r => r.id === 'rm-recursive-force') as CatastrophicRule
    expect(matchesCatastrophicRule(['rm', '-rf', '/', 'extra'], rule)).toBe(true)
    expect(matchesCatastrophicRule(['rm', '-rf'], rule)).toBe(false)
    expect(matchesCatastrophicRule(['rm', '-rf', '/tmp'], rule)).toBe(true)
    expect(matchesCatastrophicRule(['rm', '-rf', '/tmp/x'], rule)).toBe(false)
    expect(matchesCatastrophicRule(undefined as unknown as string[], rule)).toBe(false)
  })
})

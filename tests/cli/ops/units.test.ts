import { describe, expect, test } from 'bun:test'
import { itemText } from '../../../src/cli/ui/toolchain-live'
import { makeStyle } from '../../../src/cli/ui/style'
import type { ToolchainItem } from '../../../src/engine/toolchain/index'
import { parseFlags } from '../../../src/engine/update/args'
import { bumpRisk, compareVersions, isStable, pickUpdate } from '../../../src/engine/update/versions'
import { setYamlValue } from '../../../src/engine/update/yaml-edit'
import { parseKeyPath, yamlParse } from '../../../src/engine/merge'
import { daysAgo } from './helpers'

describe('parseFlags', () => {
  const spec = { flags: { harness: 'list', 'dry-run': 'bool', yes: 'bool', timeout: 'string' } as const, aliases: { y: 'yes' } }

  test('bools, aliases, lists (repeated and comma-separated), strings and positionals', () => {
    const p = parseFlags(['--harness', 'claude,codex', '-y', '--harness=omp', 'pos', '--timeout', '500', '--dry-run'], spec)
    expect([...p.bools].sort()).toEqual(['dry-run', 'yes'])
    expect(p.lists.get('harness')).toEqual(['claude', 'codex', 'omp'])
    expect(p.strings.get('timeout')).toBe('500')
    expect(p.positionals).toEqual(['pos'])
    expect(p.errors).toEqual([])
  })

  test('global --json/--verbose are accepted; unknown options and missing values are errors; -- ends options', () => {
    const p = parseFlags(['--json', '-v', '--nope', '--timeout'], spec)
    expect(p.bools.has('json')).toBe(true)
    expect(p.bools.has('verbose')).toBe(true)
    expect(p.errors).toEqual(['unknown option --nope', '--timeout needs a value'])
    expect(parseFlags(['--', '--yes'], spec).positionals).toEqual(['--yes'])
    expect(parseFlags(['-x'], spec).errors).toEqual(['unknown option -x'])
  })
})

describe('versions', () => {
  test('ordering handles semver, prereleases and PEP 440 forms', () => {
    const sorted = ['1.10.0', '1.2.0', '1.2.0-beta.2', '1.2.0-beta.10', 'v1.2.1', '1.2.0rc1', '1.2.0.post1', '0.9'].sort(compareVersions)
    expect(sorted).toEqual(['0.9', '1.2.0-beta.2', '1.2.0-beta.10', '1.2.0rc1', '1.2.0', '1.2.0.post1', 'v1.2.1', '1.10.0'])
    expect(isStable('2.0.0')).toBe(true)
    expect(isStable('2.0.0-alpha.1')).toBe(false)
    expect(isStable('0.6.2rc1')).toBe(false)
    expect(isStable('0.6.2.post1')).toBe(true)
  })

  test('risk: patch low, minor medium, major (and 0.x minor) high', () => {
    expect(bumpRisk('4.2.0', '4.2.1')).toBe('low')
    expect(bumpRisk('4.2.0', '4.3.0')).toBe('medium')
    expect(bumpRisk('4.2.0', '5.0.0')).toBe('high')
    expect(bumpRisk('0.3.9', '0.4.0')).toBe('high')
  })

  test('pickUpdate honors the release cooldown, the latest tag, deprecations and prereleases', () => {
    const now = Date.parse('2026-10-08T12:00:00Z')
    const versions = [
      { version: '4.2.0', publishedAt: daysAgo(now, 30) },
      { version: '4.2.1', publishedAt: daysAgo(now, 10) },
      { version: '4.3.0', publishedAt: daysAgo(now, 5), deprecated: true },
      { version: '4.4.0', publishedAt: daysAgo(now, 4) },
      { version: '4.5.0', publishedAt: daysAgo(now, 1) },
      { version: '4.6.0-beta.1', publishedAt: daysAgo(now, 9) },
      { version: '9.0.0', publishedAt: daysAgo(now, 50) },
    ]
    const pick = pickUpdate('4.2.0', versions, { latestTag: '4.5.0', minAgeDays: 3, nowMs: now })
    expect(pick.latest).toBe('4.5.0')
    expect(pick.candidate).toBe('4.4.0')
    expect(pick.held).toEqual({ version: '4.5.0', publishedAt: daysAgo(now, 1), ageDays: 1 })
    expect(pickUpdate('4.5.0', versions, { latestTag: '4.5.0', minAgeDays: 3, nowMs: now })).toEqual({ latest: '4.5.0' })
    expect(pickUpdate('4.2.0', versions, { latestTag: '4.5.0', minAgeDays: 0, nowMs: now }).candidate).toBe('4.5.0')
  })
})

describe('setYamlValue', () => {
  const text = [
    '# servers',
    'servers:',
    '  context7:',
    '    package: { registry: npm, name: "@upstash/context7-mcp", version: 4.2.0 }   # pinned',
    '    args: ["-y", "x@{version}"]',
    '  other:',
    '    package: { registry: npm, name: o, version: "1.0.0" }',
    '',
  ].join('\n')

  test('replaces only the bytes of an existing scalar (flow spacing and comments stay)', () => {
    const out = setYamlValue(text, ['servers', 'context7', 'package', 'version'], '4.3.0')
    expect(out).toBe(text.replace('version: 4.2.0 }', 'version: 4.3.0 }'))
    const quoted = setYamlValue(text, parseKeyPath('servers.other.package.version'), '1.1.0')
    expect(quoted).toBe(text.replace('version: "1.0.0"', 'version: "1.1.0"'))
  })

  test('quotes values that would otherwise change type, and falls back to yamlSet for new keys', () => {
    const out = setYamlValue(text, ['servers', 'context7', 'package', 'version'], '1.10')
    expect((yamlParse(out) as { servers: { context7: { package: { version: unknown } } } }).servers.context7.package.version).toBe('1.10')
    const added = setYamlValue('a: 1\n', ['b', 'c'], true)
    expect(yamlParse(added)).toEqual({ a: 1, b: { c: true } })
  })
})

describe('toolchain terminal lines', () => {
  const item = (status: ToolchainItem['status'], required = true): ToolchainItem => ({ id: 'tool:rg', group: 'cli', label: 'rg', required, status, detail: '' })

  test('every status reads as an English tag after the label', () => {
    const st = makeStyle(0)
    expect(itemText(st, item('ok'))).toBe('rg')
    expect(itemText(st, item('installed'))).toBe('rg installed')
    expect(itemText(st, item('upgraded'))).toBe('rg upgraded')
    expect(itemText(st, item('outdated'))).toBe('rg outdated')
    expect(itemText(st, item('missing'))).toBe('rg missing')
    expect(itemText(st, item('missing', false))).toBe('rg missing (optional)')
    expect(itemText(st, item('failed'))).toBe('rg failed')
    expect(itemText(st, { ...item('ok'), detail: '14.1.1' })).toBe('rg  14.1.1')
  })
})

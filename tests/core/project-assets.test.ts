import { describe, expect, test } from 'bun:test'
import {
  ASSETS_CONTEXT_MAX_RULES, assetsContextText, claudeImportNote, claudeOnlySkillNote, claudeParityText, importsAgentsMd, indexEditNote, parityDrift, parseScopedRules, ruleEditNote,
  ruleGlobsOf, ruleParity, sameGlobs, type RuleFacts,
} from '../../src/core/project-assets'

const AGENTS = [
  '# Demo',
  '',
  '## Commands',
  '',
  '- `bun test` runs the tests; see `.claude/rules/not-here.md` for nothing',
  '',
  '## Scoped rules',
  '',
  'Read the matching rule before editing those files.',
  '',
  '- `.claude/rules/sql.md` \u2014 `db/**/*.sql` \u2014 migration naming and the `db` folder',
  '- `./.claude/rules/web.md` \u2014 `src/**/*.tsx`, `src/**/*.css` \u2014 components',
  '- [testing](.claude/rules/nested/tests.md) - `tests/**` - test layout',
  '- not a rule line',
  '',
  '```markdown',
  '- `.claude/rules/fenced.md` \u2014 `x` \u2014 inside a fence',
  '```',
  '',
  '## Project tools',
  '',
  '- `.claude/rules/after.md` \u2014 `y` \u2014 a later section',
].join('\n')

describe('parseScopedRules', () => {
  test('reads the path and globs of each list item in the section only', () => {
    const idx = parseScopedRules(AGENTS)
    expect(idx.found).toBe(true)
    expect(idx.entries.map(e => [e.path, e.globs, e.line])).toEqual([
      ['.claude/rules/sql.md', ['db/**/*.sql'], 11],
      ['.claude/rules/web.md', ['src/**/*.tsx', 'src/**/*.css'], 12],
      ['.claude/rules/nested/tests.md', ['tests/**'], 13],
    ])
  })

  test('no section, no entries; a deeper heading stays inside the section', () => {
    expect(parseScopedRules('# x\n\n- `.claude/rules/a.md` \u2014 `a`\n')).toEqual({ found: false, entries: [] })
    const nested = parseScopedRules('## Scoped rules\n\n### Backend\n\n- `.claude/rules/a.md` \u2014 `a/**`\n\n## Next\n- `.claude/rules/b.md` \u2014 `b`\n')
    expect(nested.entries.map(e => e.path)).toEqual(['.claude/rules/a.md'])
  })
})

describe('ruleGlobsOf', () => {
  test('a list, a single string, quotes; problems for missing or empty paths', () => {
    expect(ruleGlobsOf('---\npaths: ["src/**/*.ts", "src/**/*.{ts,tsx}"]\n---\nbody')).toEqual({ globs: ['src/**/*.ts', 'src/**/*.{ts,tsx}'] })
    expect(ruleGlobsOf('---\npaths: "db/**"\n---\n')).toEqual({ globs: ['db/**'] })
    expect(ruleGlobsOf('---\npaths:\n  - "a/**"\n  - b/**\n---\n')).toEqual({ globs: ['a/**', 'b/**'] })
    expect(ruleGlobsOf('no frontmatter').problem).toContain('no `paths:` frontmatter')
    expect(ruleGlobsOf('---\ntitle: x\n---\n').problem).toContain('no `paths:` key')
    expect(ruleGlobsOf('---\npaths: []\n---\n').problem).toBe('`paths:` is empty')
  })
})

describe('ruleParity', () => {
  const rules: RuleFacts[] = [
    { path: '.claude/rules/sql.md', globs: ['db/**/*.sql'] },
    { path: '.claude/rules/web.md', globs: ['src/**/*.css', 'src/**/*.tsx'] },
    { path: '.claude/rules/nested/tests.md', globs: ['tests/**/*.ts'] },
    { path: '.claude/rules/new.md', globs: ['new/**'] },
    { path: '.claude/rules/mine.md', globs: ['src/**'], private: true },
    { path: '.claude/rules/broken.md', globs: [], problem: '`paths:` is empty' },
  ]

  test('unindexed, private, other globs (order-insensitive), dangling, invalid', () => {
    const p = ruleParity(rules, parseScopedRules(AGENTS.replace('- [testing]', '- `.claude/rules/gone.md` \u2014 `g` \u2014 gone\n- [testing]')))
    expect(p.unindexed.map(r => r.path)).toEqual(['.claude/rules/new.md', '.claude/rules/broken.md'])
    expect(p.privateUnindexed.map(r => r.path)).toEqual(['.claude/rules/mine.md'])
    expect(p.mismatched).toEqual([{ path: '.claude/rules/nested/tests.md', rule: ['tests/**/*.ts'], index: ['tests/**'] }])
    expect(p.dangling.map(d => d.path)).toEqual(['.claude/rules/gone.md'])
    expect(p.invalid.map(r => r.path)).toEqual(['.claude/rules/broken.md'])
    expect(parityDrift(p)).toBe(true)
    expect(sameGlobs(['a', 'b'], ['b', 'a', 'a'])).toBe(true)
  })

  test('an index that matches the rules is no drift', () => {
    const idx = parseScopedRules('## Scoped rules\n\n- `.claude/rules/a.md` \u2014 `a/**` \u2014 a\n')
    expect(parityDrift(ruleParity([{ path: '.claude/rules/a.md', globs: ['a/**'] }], idx))).toBe(false)
  })
})

describe('assetsContextText', () => {
  const rules: RuleFacts[] = [{ path: '.claude/rules/sql.md', globs: ['db/**'] }, { path: '.claude/rules/all.md', globs: [], problem: 'x' }]
  const skills = [{ id: 'deploy', description: 'Deploy the app to the staging cluster' }, { id: 'bare' }]

  test('empty for Claude Code (it loads .claude/rules natively) and when there is nothing to say', () => {
    expect(assetsContextText({ harness: 'claude', rules, claudeOnly: skills })).toBe('')
    for (const h of ['codex', 'opencode', 'omp'] as const) expect(assetsContextText({ harness: h, rules: [], claudeOnly: [] })).toBe('')
  })

  test('the rule list for Codex, OpenCode and omp; Claude-only skills on Codex alone', () => {
    const codex = assetsContextText({ harness: 'codex', rules, claudeOnly: skills })
    expect(codex).toContain('- `.claude/rules/sql.md` \u2014 `db/**`')
    expect(codex).toContain('- `.claude/rules/all.md` \u2014 every file (no `paths:`)')
    expect(codex).toContain('- `deploy`: Deploy the app to the staging cluster')
    expect(codex).toContain('- `bare`')
    for (const h of ['opencode', 'omp'] as const) {
      const text = assetsContextText({ harness: h, rules, claudeOnly: skills })
      expect(text).toContain('.claude/rules/sql.md')
      expect(text).not.toContain('deploy')
    }
  })

  test('at most 40 rules, then a pointer to the check; byte-stable for the same input', () => {
    const many: RuleFacts[] = Array.from({ length: 45 }, (_, i) => ({ path: `.claude/rules/r${String(i).padStart(2, '0')}.md`, globs: ['x/**'] }))
    const text = assetsContextText({ harness: 'omp', rules: many, claudeOnly: [] })
    expect(text.split('\n').filter(l => l.startsWith('- `.claude/rules/')).length).toBe(ASSETS_CONTEXT_MAX_RULES)
    expect(text).toContain('and 5 more: `buracle project check`')
    expect(assetsContextText({ harness: 'omp', rules: many, claudeOnly: [] })).toBe(text)
  })
})

describe('edit notes', () => {
  const idx = parseScopedRules('## Scoped rules\n\n- `.claude/rules/a.md` \u2014 `a/**` \u2014 a\n')

  test('a rule missing from the index, with other globs, or without paths gets a note; a private or matching rule none', () => {
    expect(ruleEditNote({ path: '.claude/rules/b.md', globs: ['b/**'] }, idx)).toContain('Add the line - `.claude/rules/b.md` \u2014 `b/**` \u2014 <purpose>')
    expect(ruleEditNote({ path: '.claude/rules/a.md', globs: ['a/**/*.ts'] }, idx)).toContain('AGENTS.md:3')
    expect(ruleEditNote({ path: '.claude/rules/a.md', globs: [], problem: '`paths:` is empty' }, idx)).toContain('`paths:` is empty')
    expect(ruleEditNote({ path: '.claude/rules/a.md', globs: ['a/**'] }, idx)).toBeUndefined()
    expect(ruleEditNote({ path: '.claude/rules/b.md', globs: ['b/**'], private: true }, idx)).toBeUndefined()
  })

  test('an AGENTS.md edit lists what is out of step, capped', () => {
    const p = ruleParity([{ path: '.claude/rules/c.md', globs: ['c/**'] }], idx)
    const note = indexEditNote(p) ?? ''
    expect(note).toContain('AGENTS.md:3 lists .claude/rules/a.md, which does not exist')
    expect(note).toContain('.claude/rules/c.md is missing')
    expect(indexEditNote(ruleParity([{ path: '.claude/rules/a.md', globs: ['a/**'] }], idx))).toBeUndefined()
  })

  test('the CLAUDE.md import line', () => {
    expect(importsAgentsMd('# notes\n@AGENTS.md\n')).toBe(true)
    expect(importsAgentsMd('@./AGENTS.md')).toBe(true)
    expect(importsAgentsMd('see @AGENTS.md for more')).toBe(false)
    expect(claudeImportNote('CLAUDE.md')).toContain('`@AGENTS.md`')
  })

  test('.claude/CLAUDE.md imports the root AGENTS.md as @../AGENTS.md; a bare @AGENTS.md resolves inside .claude', () => {
    expect(importsAgentsMd('@../AGENTS.md\nnotes\n', '.claude/CLAUDE.md')).toBe(true)
    expect(importsAgentsMd('@AGENTS.md\n', '.claude/CLAUDE.md')).toBe(false)
    expect(importsAgentsMd('@../AGENTS.md\n')).toBe(false)
    const note = claudeImportNote('.claude/CLAUDE.md')
    expect(note).toContain('`@../AGENTS.md`')
    expect(note).toContain('Claude Code and omp read it')
  })

  test('Claude Code gets one parity line when the index is out of step, nothing when it is in step', () => {
    const idx = parseScopedRules('## Scoped rules\n\n- `.claude/rules/a.md` — `a/**` — a\n')
    const text = claudeParityText(ruleParity([{ path: '.claude/rules/a.md', globs: ['b/**'] }, { path: '.claude/rules/c.md', globs: ['c/**'] }, { path: '.claude/rules/p.md', globs: ['p/**'], private: true }], idx))
    expect(text).toContain('2 path rule(s) in .claude/rules are out of step')
    expect(text).not.toContain('a.md')
    expect(claudeParityText(ruleParity([{ path: '.claude/rules/a.md', globs: ['a/**'] }], idx))).toBe('')
  })

  test('a skill that lives only in .claude/skills gets a note naming both ways out', () => {
    const note = claudeOnlySkillNote('review')
    expect(note).toContain('.claude/skills/review exists only in .claude/skills, so Codex cannot see it')
    expect(note).toContain('.agents/skills/review')
    expect(note).toContain('`buracle project sync --adopt`')
  })
})

describe('assetsContextText size', () => {
  test('a block stays within ASSETS_BLOCK_MAX_CHARS and says how many it left out', async () => {
    const { ASSETS_BLOCK_MAX_CHARS } = await import('../../src/core/project-assets')
    const long: RuleFacts[] = Array.from({ length: 40 }, (_, i) => ({ path: `.claude/rules/${'deep/'.repeat(8)}rule-${i}.md`, globs: [`packages/${'x'.repeat(40)}/**/*.ts`] }))
    const text = assetsContextText({ harness: 'opencode', rules: long, claudeOnly: [] })
    expect(text.length).toBeLessThanOrEqual(ASSETS_BLOCK_MAX_CHARS + 80)
    expect(text).toMatch(/and \d+ more: `buracle project check`/)
  })
})

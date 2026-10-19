import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalBundle, RuleDoc } from '../../../src/core/catalog'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { PATH_RULES_OWNER, pathGlobs, pathRuleFile, pathRuleFiles } from '../../../src/adapters/shared/rules'
import { codexBuildFiles } from '../../../src/adapters/codex/generate'

const REPO = join(import.meta.dir, '..', '..', '..')
const canonical: CanonicalBundle = loadCanonicalSync(join(REPO, 'canonical'))

const rule = (frontmatter: Record<string, unknown>, body: string): RuleDoc => ({ id: 'x', scope: 'paths', file: 'rules/paths/x.md', frontmatter, body } as RuleDoc)

describe('path rules (shared)', () => {
  test('one file per canonical path rule, sorted, owned by the core plan', () => {
    const files = pathRuleFiles(canonical)
    const ids = canonical.rules.filter(r => r.scope === 'paths').map(r => r.id).sort()
    expect(files.map(f => f.id)).toEqual(ids)
    expect(files.map(f => f.file)).toEqual(ids.map(id => `${id}.md`))
    expect(PATH_RULES_OWNER).toBe('core')
    expect(ids.length).toBeGreaterThan(0)
  })

  test('frontmatter keeps the globs; the body is rendered neutrally', () => {
    const warnings: string[] = []
    const text = pathRuleFile(rule({ paths: ['**/*.py', 'scripts/**'] }, '\n\n# Python\n\nAsk with {{ask_user}}.\n<!-- harness:claude -->\nClaude only.\n<!-- /harness -->\n'), {}, warnings)
    expect(text).toBe('---\npaths:\n  - "**/*.py"\n  - "scripts/**"\n---\n# Python\n\nAsk with your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi).\n')
    expect(warnings).toEqual([])
    expect(pathGlobs(rule({ paths: '**/*.go' }, ''))).toEqual(['**/*.go'])
    expect(pathRuleFile(rule({}, '# No globs\n'))).toBe('# No globs\n')
  })

  test('the codex build reference copy renders the same bytes as the installer', () => {
    const build = new Map(codexBuildFiles(canonical).files.map(f => [f.path, f.content]))
    for (const f of pathRuleFiles(canonical)) {
      expect(build.get(`rules/paths/${f.file}`)).toBe(f.content)
      expect(readFileSync(join(REPO, 'harness', 'codex', 'rules', 'paths', f.file), 'utf8')).toBe(f.content)
    }
  })
})

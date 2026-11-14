import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { renderRule as renderClaudeRule } from '../../src/adapters/claude/install'
import { codexBuildFiles } from '../../src/adapters/codex/generate'
import { renderRule as renderOmpRule } from '../../src/adapters/omp/build'
import { ompCommandNames } from '../../src/adapters/omp/generated'
import { agentsPointer } from '../../src/adapters/omp/install'
import { agentsBlock } from '../../src/adapters/opencode/render'
import { pathRulesPointer } from '../../src/adapters/shared/rules'
import { loadCanonicalSync } from '../../src/engine/canonical'
import { ALWAYS_TOTAL_BYTES } from '../../src/workflow/rules'

const REPO = join(import.meta.dir, '..', '..')
const canonical = loadCanonicalSync(join(REPO, 'canonical'))
const always = canonical.rules.filter(r => r.scope === 'always')
const bytes = (s: string): number => new TextEncoder().encode(s).length

// What each harness puts in front of the model in every session, before the user types: the rendered always-on
// rules with everything the adapter wraps around them. The canonical source alone is not the measure.
function alwaysLoaded(): Record<string, number> {
  const codex = codexBuildFiles(canonical).files.find(f => f.path === 'AGENTS.md')?.content
  if (codex === undefined) throw new Error('the codex build has no AGENTS.md')
  return {
    claude: always.reduce((n, r) => n + bytes(renderClaudeRule(r)), 0),
    codex: bytes(codex),
    opencode: bytes(agentsBlock(canonical, '~/.buracle/rules/paths')),
    omp: always.reduce((n, r) => n + bytes(renderOmpRule(r).content), 0) + bytes(agentsPointer({ commands: ompCommandNames(canonical) })),
  }
}

describe('what every session loads', () => {
  test('the rendered always-on rules stay under 8,000 bytes on every harness', () => {
    expect(ALWAYS_TOTAL_BYTES).toBe(8000)
    expect(always.map(r => r.id).sort()).toEqual(['core', 'explain', 'memory', 'tooling'])
    const sizes = alwaysLoaded()
    for (const [harness, n] of Object.entries(sizes)) {
      expect({ harness, bytes: n, fits: n < ALWAYS_TOTAL_BYTES }).toEqual({ harness, bytes: n, fits: true })
    }
    expect(Math.min(...Object.values(sizes))).toBeGreaterThan(2000)
  })

  test('the path rules cost one line there: their names and their folder, not their globs', () => {
    const pointer = pathRulesPointer(['python', 'backend'], '~/.buracle/rules/paths')
    expect(pointer).toBe('# Path-scoped rules\n\nWhen you first edit a file that a path rule covers (backend, python), Buracle hands you the rule: follow it. The rules are in `~/.buracle/rules/paths`.')
    expect(pathRulesPointer([], '~/.buracle/rules/paths')).toBeUndefined()
    const codex = codexBuildFiles(canonical).files.find(f => f.path === 'AGENTS.md')?.content ?? ''
    for (const text of [codex, agentsBlock(canonical, '~/.buracle/rules/paths')]) {
      expect(text).toContain('# Path-scoped rules')
      expect(text).not.toContain('**/*.py')
    }
  })

  test('the always-on rules name what the hooks enforce and point at the detail in the skills', () => {
    const text = always.map(r => r.body).join('\n')
    for (const s of ['Stop guard:', 'Approvals:', 'Routing:', 'Self-protection:', '## Parallel agents', '# Plain language', '## Language', '# Tool routing (strict)', '| Need | Use first | Fallback |',
      '`references/working-rules.md`', '`references/lanes.md`', '`references/plain-language.md`', 'Load the `memory` skill']) {
      expect({ has: s, ok: text.includes(s) }).toEqual({ has: s, ok: true })
    }
    for (const file of ['buracle/references/working-rules.md', 'buracle/references/lanes.md', 'buracle/references/plain-language.md', 'memory/references/memory-rules.md']) {
      const [skill, , name] = file.split('/')
      const doc = canonical.skills.find(s => s.id === skill)
      expect({ file, shipped: doc?.files.some(f => f.path === `references/${name}`), linked: doc?.body.includes(`(references/${name})`) }).toEqual({ file, shipped: true, linked: true })
    }
  })
})

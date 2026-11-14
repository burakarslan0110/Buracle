import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AgentDoc } from '../../../src/core/catalog'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { expandIncludes, partialParts, resolveAgents } from '../../../src/adapters/shared/agents'

const REPO = join(import.meta.dir, '..', '..', '..')
const agent = (id: string, body: string): AgentDoc => ({ id, file: `agents/${id}.md`, frontmatter: { output: 'json' }, body })
const PARTIAL = '<!-- a note for maintainers -->\n\n<!-- part: rules -->\n- One.\n- Two.\n\n<!-- part: output -->\n## Output\n\nJSON only.\n'
const read = (id: string) => (id === 'shared' ? PARTIAL : undefined)

describe('the shared body of the review agents', () => {
  test('a partial is split into named parts; text before the first part belongs to none', () => {
    const parts = partialParts(PARTIAL)
    expect([...parts.keys()]).toEqual(['rules', 'output'])
    expect(parts.get('rules')).toBe('- One.\n- Two.')
    expect(parts.get('output')).toBe('## Output\n\nJSON only.')
  })

  test('an include line is replaced by the part, and the lines around it stay', () => {
    const body = '## Constraints\n\n{{include:shared#rules}}\n- Three.\n\n  {{include:shared#output}}\n\nTail.\n'
    expect(expandIncludes(body, 'agents/x.md', read)).toBe('## Constraints\n\n- One.\n- Two.\n- Three.\n\n## Output\n\nJSON only.\n\nTail.\n')
    expect(expandIncludes('No include here.\n', 'agents/x.md', () => { throw new Error('never read') })).toBe('No include here.\n')
  })

  test('an include that names nothing, or sits inside a line, is an error with the file and the line', () => {
    expect(() => expandIncludes('a\n{{include:shared#nope}}\n', 'agents/x.md', read)).toThrow('agents/x.md:2: {{include:shared#nope}} names no part')
    expect(() => expandIncludes('{{include:other#rules}}\n', 'agents/x.md', read)).toThrow('agents/x.md:1:')
    expect(() => expandIncludes('{{include:shared}}\n', 'agents/x.md', read)).toThrow('names no part')
    expect(() => expandIncludes('See {{include:shared#rules}} here.\n', 'agents/x.md', read)).toThrow('an include takes a whole line')
  })

  test('resolveAgents keeps the list and the frontmatter and completes only the bodies', () => {
    const plain = agent('plain', 'Nothing shared.\n')
    const out = resolveAgents({ agents: [agent('a', '{{include:shared#rules}}\n'), plain] }, read)
    expect(out.map(a => [a.id, a.file, a.frontmatter])).toEqual([['a', 'agents/a.md', { output: 'json' }], ['plain', 'agents/plain.md', { output: 'json' }]])
    expect(out[0]?.body).toBe('- One.\n- Two.\n')
    expect(out[1]).toBe(plain)
    expect(() => resolveAgents({ agents: [agent('a', '{{include:shared#rules}}\n')] })).toThrow('names no part')
  })

  test('the canonical review agents write the shared parts once and every resolved agent is complete', () => {
    const canonical = loadCanonicalSync(join(REPO, 'canonical'))
    expect(canonical.agents.map(a => a.id).sort()).toEqual(['changes-review', 'goal-build-review', 'plan-build-review'])
    for (const a of canonical.agents) {
      expect({ id: a.id, includes: a.body.includes('{{include:review-shared#constraints}}') && a.body.includes('{{include:review-shared#output}}') }).toEqual({ id: a.id, includes: true })
      expect({ id: a.id, copied: a.body.includes('Return exactly one JSON object') }).toEqual({ id: a.id, copied: false })
    }
    for (const a of resolveAgents(canonical)) {
      expect(a.body).not.toContain('{{include:')
      expect(a.body).not.toContain('<!-- part:')
      for (const s of ['- Read-only. Never create, edit, move or delete files.', '## Output', 'Return exactly one JSON object as your final message', '"goal_score": number', 'Report at most 15', 'For this review, ', 'Example:']) {
        expect({ id: a.id, has: s, ok: a.body.includes(s) }).toEqual({ id: a.id, has: s, ok: true })
      }
      expect(a.body.indexOf('## Constraints')).toBeLessThan(a.body.indexOf('## Procedure'))
      expect(a.body.indexOf('## Categories')).toBeLessThan(a.body.indexOf('## Output'))
    }
  })
})

import { describe, expect, test } from 'bun:test'
import { placeholderLiteral, renderHarnessBlocks, renderMarkdown, renderPlaceholders, RenderError } from '../../../src/adapters/shared/render'

const blocks = [
  'Intro line:',
  '<!-- harness:claude -->',
  '`${CLAUDE_SKILL_DIR}`',
  '<!-- /harness -->',
  '<!-- harness:codex -->',
  '`~/.agents/skills/x`',
  '<!-- /harness -->',
  '<!-- harness:opencode -->',
  '`~/.agents/skills/x`',
  '<!-- /harness -->',
  '<!-- harness:omp -->',
  '`~/.agents/skills/x`',
  '<!-- /harness -->',
  'After.',
].join('\n')

describe('harness blocks', () => {
  test('a single-harness render keeps only its own blocks, unlabelled', () => {
    expect(renderHarnessBlocks(blocks, 'codex')).toBe('Intro line:\n`~/.agents/skills/x`\nAfter.')
    expect(renderHarnessBlocks(blocks, 'claude')).toBe('Intro line:\n`${CLAUDE_SKILL_DIR}`\nAfter.')
  })

  test('the neutral render drops claude blocks and merges identical blocks under one bold label', () => {
    expect(renderHarnessBlocks(blocks, 'neutral')).toBe('Intro line:\n**Codex, OpenCode and Oh My Pi:** `~/.agents/skills/x`\nAfter.')
  })

  test('different contents keep one labelled block per harness, in canonical order', () => {
    const text = [
      '<!-- harness:omp -->', 'omp text', '<!-- /harness -->',
      '<!-- harness:codex -->', 'codex text', '<!-- /harness -->',
      '<!-- harness:opencode -->', 'codex text', '<!-- /harness -->',
    ].join('\n')
    expect(renderHarnessBlocks(text, 'neutral')).toBe('**Oh My Pi:** omp text\n**Codex and OpenCode:** codex text')
  })

  test('labels go on their own line before code fences and lists, keeping indentation', () => {
    const text = [
      '1. Run it.',
      '<!-- harness:codex -->',
      '   ```bash',
      '   bun x.ts',
      '   ```',
      '<!-- /harness -->',
      '<!-- harness:omp -->',
      '- a list item',
      '<!-- /harness -->',
    ].join('\n')
    expect(renderHarnessBlocks(text, 'neutral')).toBe([
      '1. Run it.', '   **Codex:**', '   ```bash', '   bun x.ts', '   ```', '**Oh My Pi:**', '', '- a list item',
    ].join('\n'))
  })

  test('a claude-only block between blank lines leaves a single blank line', () => {
    const text = 'Para.\n\n<!-- harness:claude -->\nClaude only.\n<!-- /harness -->\n\n## Next'
    expect(renderHarnessBlocks(text, 'neutral')).toBe('Para.\n\n## Next')
    expect(renderHarnessBlocks(text, 'claude')).toBe('Para.\n\nClaude only.\n\n## Next')
  })

  test('inline blocks', () => {
    const line = 'Use <!-- harness:claude -->ToolSearch<!-- /harness --><!-- harness:codex -->tool search<!-- /harness -->.'
    expect(renderHarnessBlocks(line, 'codex')).toBe('Use tool search.')
    expect(renderHarnessBlocks(line, 'neutral')).toBe('Use **Codex:** tool search.')
  })

  test('nested, unclosed and stray markers are errors with file:line', () => {
    expect(() => renderHarnessBlocks('<!-- harness:codex -->\nx', 'neutral', { file: 'a.md' })).toThrow(/a\.md:1: harness block is not closed/)
    expect(() => renderHarnessBlocks('<!-- harness:codex -->\n<!-- harness:omp -->\n<!-- /harness -->', 'neutral', { file: 'b.md' })).toThrow(RenderError)
    expect(() => renderHarnessBlocks('text\n<!-- /harness -->', 'neutral', { file: 'c.md' })).toThrow(/c\.md:2/)
  })
})

describe('placeholders', () => {
  test('per-harness literals follow the CONTRACTS §8.1 table (OpenCode v2.0.24 names)', () => {
    expect(placeholderLiteral({ name: 'ask_user' }, 'codex')).toBe('request_user_input')
    expect(placeholderLiteral({ name: 'ask_user' }, 'opencode')).toBe('question')
    expect(placeholderLiteral({ name: 'ask_user' }, 'omp')).toBe('ask')
    expect(placeholderLiteral({ name: 'todo' }, 'codex')).toBe('update_plan')
    expect(placeholderLiteral({ name: 'todo' }, 'omp')).toBe('todo')
    expect(placeholderLiteral({ name: 'spawn_agent' }, 'codex')).toBe('spawn_agent')
    expect(placeholderLiteral({ name: 'spawn_agent' }, 'opencode')).toBe('subagent')
    expect(placeholderLiteral({ name: 'spawn_agent' }, 'omp')).toBe('task')
    expect(placeholderLiteral({ name: 'skill', arg: 'plan-build' }, 'codex')).toBe('$plan-build')
    expect(placeholderLiteral({ name: 'skill', arg: 'plan-build' }, 'opencode')).toBe('/plan-build')
    expect(placeholderLiteral({ name: 'todo' }, 'opencode')).toBeUndefined()
    expect(placeholderLiteral({ name: 'skill', arg: 'plan-build' }, 'omp')).toBe('/plan-build')
    expect(placeholderLiteral({ name: 'skill', arg: 'plan-build' }, 'claude')).toBe('/plan-build')
    expect(placeholderLiteral({ name: 'skill', arg: 'memory' }, 'opencode', false)).toBe('@memory')
    expect(placeholderLiteral({ name: 'skill', arg: 'memory' }, 'omp', false)).toBe('/skill:memory')
    expect(placeholderLiteral({ name: 'skill', arg: 'memory' }, 'codex', false)).toBe('$memory')
    expect(placeholderLiteral({ name: 'agent', arg: 'changes-review' }, 'codex')).toBe('changes-review')
    expect(placeholderLiteral({ name: 'agent', arg: 'changes-review' }, 'claude')).toBe('buracle:changes-review')
  })

  test('neutral prose names every harness', () => {
    expect(renderPlaceholders('Ask with {{ask_user}} first.', 'neutral')).toBe('Ask with your structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi) first.')
    expect(renderPlaceholders('Then {{skill:requirements}}.', 'neutral')).toBe('Then `/requirements` (Codex: `$requirements`).')
    expect(renderPlaceholders('the idea is still vague ({{skill:requirements}}), or', 'neutral')).toBe('the idea is still vague (`/requirements`; Codex: `$requirements`), or')
    expect(renderPlaceholders('Then {{skill:memory}}.', 'neutral', { protocols: ['memory'] })).toBe('Then the `memory` skill (read `~/.agents/skills/memory/SKILL.md` in Codex, load it with the `skill` tool in OpenCode, read `skill://memory` in Oh My Pi).')
    expect(renderPlaceholders('A pass ({{skill:memory}}): three queries.', 'neutral', { protocols: ['memory'] })).toBe('A pass (the `memory` skill: read `~/.agents/skills/memory/SKILL.md` in Codex, load it with the `skill` tool in OpenCode, read `skill://memory` in Oh My Pi): three queries.')
    expect(renderPlaceholders('Track it with {{todo}}.', 'neutral')).toBe('Track it with your plan/todo tool where available (`update_plan` in Codex, the todo tool in Oh My Pi; OpenCode v2 has none).')
    expect(renderPlaceholders('Launch {{agent:plan-build-review}} with {{spawn_agent}}.', 'neutral')).toBe('Launch plan-build-review with your subagent tool (`spawn_agent` in Codex, `subagent` in OpenCode, `task` in Oh My Pi).')
  })

  test('sentence starts are capitalised; determiners drop "your"/"the"', () => {
    expect(renderPlaceholders('5. {{todo}}: one item per step.', 'neutral')).toMatch(/^5\. Your plan\/todo tool where available \(`update_plan` in Codex/)
    expect(renderPlaceholders('Each {{ask_user}} call holds one question.', 'neutral')).toBe('Each structured-question tool (`request_user_input` in Codex, `question` in OpenCode, `ask` in Oh My Pi) call holds one question.')
    expect(renderPlaceholders('ask once with\n{{ask_user}} or answer both.', 'neutral')).toMatch(/\nyour structured-question tool/)
    expect(renderPlaceholders('Done.\n\n{{skill:plan-build}} comes next.', 'neutral')).toBe('Done.\n\n`/plan-build` (Codex: `$plan-build`) comes next.')
    expect(renderPlaceholders('Done.\n\n{{skill:memory}} comes next.', 'neutral', { protocols: ['memory'] })).toMatch(/\n\nThe `memory` skill \(read/)
  })

  test('inside inline code a placeholder becomes per-harness code variants', () => {
    expect(renderPlaceholders('User: `{{skill:requirements}} idea` here', 'neutral')).toBe('User: `$requirements idea` in Codex, `/requirements idea` in OpenCode and Oh My Pi here')
    expect(renderPlaceholders('User: `{{skill:memory}} x` here', 'neutral', { protocols: ['memory'] })).toBe('User: `$memory x` in Codex, `@memory x` in OpenCode, `/skill:memory x` in Oh My Pi here')
    expect(renderPlaceholders('`{{agent:changes-review}}`', 'neutral')).toBe('`changes-review`')
    expect(renderPlaceholders('Run `{{skill:plan-build}} x`.', 'codex')).toBe('Run `$plan-build x`.')
  })

  test('fenced code is repeated per harness only when the literals differ', () => {
    const same = '```text\n{{agent:changes-review}}\nplan_file: x\n```'
    expect(renderPlaceholders(same, 'neutral')).toBe('```text\nchanges-review\nplan_file: x\n```')
    const differs = '```text\n{{skill:plan-build}} go\n```'
    expect(renderPlaceholders(differs, 'neutral')).toBe([
      '**Codex:**', '```text', '$plan-build go', '```', '**OpenCode and Oh My Pi:**', '```text', '/plan-build go', '```',
    ].join('\n'))
  })

  test('single-harness prose uses the literal tool name', () => {
    expect(renderPlaceholders('Ask with {{ask_user}}; track with {{todo}}; run {{skill:bugfix}}.', 'codex')).toBe('Ask with `request_user_input`; track with `update_plan`; run `$bugfix`.')
    expect(renderPlaceholders('Track with {{todo}}.', 'opencode')).toBe('Track with a short checklist in your replies.')
  })

  test('\\{{…}} renders a literal placeholder and unknown placeholders stay with a warning', () => {
    const warnings: string[] = []
    expect(renderPlaceholders('Write \\{{ask_user}} literally; {{nope}} stays.', 'neutral', { file: 'f.md' }, warnings)).toBe('Write {{ask_user}} literally; {{nope}} stays.')
    expect(warnings).toEqual(['f.md:1: unknown placeholder {{nope}} left as is'])
  })

  test('unknown skill and agent references are reported', () => {
    const warnings: string[] = []
    renderPlaceholders('{{skill:ghost}} and {{agent:phantom}}', 'neutral', { file: 'g.md', skills: ['plan-build'], agents: ['changes-review'] }, warnings)
    expect(warnings).toEqual(['g.md:1: {{skill:ghost}} names an unknown skill', 'g.md:1: {{agent:phantom}} names an unknown agent'])
  })

  test('renderMarkdown applies blocks first, then placeholders inside them', () => {
    const text = '<!-- harness:codex -->\nUse {{todo}}.\n<!-- /harness -->\n<!-- harness:claude -->\nUse {{todo}}.\n<!-- /harness -->'
    expect(renderMarkdown(text, 'codex')).toBe('Use `update_plan`.')
    expect(renderMarkdown(text, 'claude')).toBe('Use `TodoWrite`.')
    expect(renderMarkdown(text, 'neutral')).toBe('**Codex:** Use your plan/todo tool where available (`update_plan` in Codex, the todo tool in Oh My Pi; OpenCode v2 has none).')
  })
})

import { describe, expect, test } from 'bun:test'
import { parse as parseYaml } from 'yaml'
import {
  RenderError, applyHarnessBlocks, claudePlaceholder, claudePlaceholderFor, expandPlaceholders, renderClaudeMarkdown, withFrontmatter, yamlScalar,
} from '../../../src/adapters/claude/render'

describe('applyHarnessBlocks', () => {
  const doc = [
    'before',
    '<!-- harness:claude -->',
    'claude line',
    '<!-- /harness -->',
    '<!-- harness:codex -->',
    'codex line',
    '<!-- /harness -->',
    'after',
    '',
  ].join('\n')

  test('keeps the target block without its markers and drops the others with their lines', () => {
    expect(applyHarnessBlocks(doc, 'claude')).toBe('before\nclaude line\nafter\n')
    expect(applyHarnessBlocks(doc, 'codex')).toBe('before\ncodex line\nafter\n')
    expect(applyHarnessBlocks(doc, 'omp')).toBe('before\nafter\n')
  })

  test('inline markers remove only the marker text', () => {
    const t = 'A <!-- harness:claude -->c<!-- /harness --><!-- harness:omp -->o<!-- /harness --> B\n'
    expect(applyHarnessBlocks(t, 'claude')).toBe('A c B\n')
    expect(applyHarnessBlocks(t, 'omp')).toBe('A o B\n')
  })

  test('tolerates spacing inside markers and a final block without a trailing newline', () => {
    expect(applyHarnessBlocks('x\n<!--harness:claude-->\ny\n<!--   /harness   -->', 'claude')).toBe('x\ny\n')
    expect(applyHarnessBlocks('x\n  <!-- harness:codex -->  \ny\n<!-- /harness -->', 'claude')).toBe('x\n')
  })

  test('text without markers is returned unchanged', () => {
    expect(applyHarnessBlocks('plain «harness:claude» text\n', 'claude')).toBe('plain «harness:claude» text\n')
  })

  test('malformed blocks fail loudly', () => {
    expect(() => applyHarnessBlocks('<!-- harness:claude -->\nopen\n', 'claude', 'x.md')).toThrow(RenderError)
    expect(() => applyHarnessBlocks('<!-- /harness -->\n', 'claude')).toThrow(/without an opening/)
    expect(() => applyHarnessBlocks('<!-- harness:claude -->\n<!-- harness:codex -->\n<!-- /harness -->\n', 'claude')).toThrow(/inside/)
    expect(() => applyHarnessBlocks('<!-- harness:claud -->\nx\n<!-- /harness -->\n', 'claude')).toThrow(/unknown harness/)
  })
})

describe('placeholders (Claude column)', () => {
  const r = (t: string) => expandPlaceholders(t, claudePlaceholder)

  test('prose expansions name the Claude tools', () => {
    expect(r('Ask with {{ask_user}}.')).toBe('Ask with `AskUserQuestion`.')
    expect(r('Launch {{agent:changes-review}} with {{spawn_agent}}.')).toBe('Launch `buracle:changes-review` with the `Agent` tool.')
    expect(r('Continue in {{skill:plan-build}}.')).toBe('Continue in `/plan-build`.')
  })

  test('{{todo}} names TodoWrite and the task tools without promising either, and stays a noun phrase', () => {
    expect(r('Track with {{todo}}.')).toBe('Track with `TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any).')
    expect(r('complete the {{todo}} item')).toBe('complete the `TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any) item')
  })

  test('a workflow is its bare /<id>; an agent protocol keeps the plugin prefix (/memory is Claude Code\'s own)', () => {
    const rp = (s: string) => expandPlaceholders(s, claudePlaceholderFor(['memory', 'buracle']))
    expect(rp('Start {{skill:bugfix}}; read {{skill:memory}} and {{skill:buracle}}.')).toBe('Start `/bugfix`; read `/buracle:memory` and `/buracle:buracle`.')
    expect(rp('`{{skill:plan-build}} <task>` and `{{skill:memory}}`')).toBe('`/plan-build <task>` and `/buracle:memory`')
    expect(renderClaudeMarkdown('Use {{skill:memory}}.\n', 'text', ['memory'])).toBe('Use `/buracle:memory`.\n')
  })

  test('inside inline code and fenced blocks the bare name keeps the span intact', () => {
    expect(r('User: `{{skill:inspect}} Neden?` and `{{ask_user}}`')).toBe('User: `/inspect Neden?` and `AskUserQuestion`')
    expect(r('```text\n{{agent:plan-build-review}}\n{{todo}}\n```\nafter {{todo}}')).toBe('```text\nburacle:plan-build-review\nTodoWrite\n```\nafter `TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any)')
    expect(r('~~~\n{{spawn_agent}}\n~~~')).toBe('~~~\nAgent\n~~~')
    expect(r('``a `{{ask_user}}` b`` then {{ask_user}}')).toBe('``a `AskUserQuestion` b`` then `AskUserQuestion`')
  })

  test('an unmatched backtick is literal, so the placeholder is prose', () => {
    expect(r('it`s {{ask_user}}')).toBe('it`s `AskUserQuestion`')
  })

  test('escaped placeholders render literally, unknown ones stay as written', () => {
    expect(r('\\{{ask_user}} and \\{{skill:plan-build}}')).toBe('{{ask_user}} and {{skill:plan-build}}')
    expect(r('{{nope}} {{skill}} {{skill:Bad}} {{ask_user:x}}')).toBe('{{nope}} {{skill}} {{skill:Bad}} {{ask_user:x}}')
  })

  test('renderClaudeMarkdown applies blocks before placeholders', () => {
    const t = '<!-- harness:claude -->\nUse {{ask_user}}.\n<!-- /harness -->\n<!-- harness:codex -->\nUse {{ask_user}} too.\n<!-- /harness -->\n'
    expect(renderClaudeMarkdown(t)).toBe('Use `AskUserQuestion`.\n')
  })
})

describe('frontmatter', () => {
  test('yamlScalar quotes only when YAML could misread the value', () => {
    expect(yamlScalar('plan-build')).toBe('plan-build')
    expect(yamlScalar('docs/plans')).toBe('docs/plans')
    expect(yamlScalar('true')).toBe('"true"')
    expect(yamlScalar('1.5')).toBe('"1.5"')
    expect(yamlScalar('a: b')).toBe('"a: b"')
    expect(yamlScalar('<task>')).toBe('"<task>"')
    expect(yamlScalar(true)).toBe('true')
    expect(yamlScalar(3)).toBe('3')
  })

  test('withFrontmatter round-trips through a YAML parser', () => {
    const text = withFrontmatter([
      ['name', 'x'],
      ['description', 'Say "hi": then # stop, ç ğ ı ş'],
      ['skip', undefined],
      ['flag', true],
      ['paths', ['**/*.py', 'a b']],
    ], '\n\nBody\n')
    expect(text.startsWith('---\nname: x\n')).toBe(true)
    expect(text.endsWith('---\n\nBody\n')).toBe(true)
    const fm = parseYaml(text.split('---\n')[1] as string) as Record<string, unknown>
    expect(fm).toEqual({ name: 'x', description: 'Say "hi": then # stop, ç ğ ı ş', flag: true, paths: ['**/*.py', 'a b'] })
  })
})

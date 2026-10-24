import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { checkMention, findMentions } from '../../src/workflow/cli-contract'
import {
  checkBuracleMentions, checkHarnessBlocks, checkLinks, checkPlaceholders, scanMarkdown, type LintFinding,
} from '../../src/workflow/lint'
import { lintSkillDir, scaffoldSkill, skillsLint, skillsList, skillsNew } from '../../src/workflow/skills'
import { globProblems, lintRulesDir, rulesLint } from '../../src/workflow/rules'
import { withSandbox } from '../helpers/sandbox'
import { ctxAt, write } from './fixture'

const TARGETS = { skills: new Set(['plan-build', 'goal-build']), agents: new Set(['changes-review']) }
const codes = (fs: LintFinding[]) => fs.map(f => f.code)

describe('buracle command mentions', () => {
  const okMentions = [
    'buracle plan init --type feature|bugfix|build --title "<t>" [--slug <s>] [--dir <d>] [--json]',
    'buracle plan capture [--title "<t>"] [--file <path>] [--draft] [--harness <h>] [--json]',
    'buracle plan review companion collect --role <r> [--wait <seconds>] [--json]',
    'buracle plan set status APPROVED|IN_PROGRESS',
    'buracle plan set phase implement|verify',
    'buracle plan set approved true',
    'buracle plan pause --kind discussion|decision --reason "<r>"',
    'buracle plan …',
    'buracle plan',
    'buracle worktree create|diff|sync|cleanup <slug>',
    'buracle worktree create <slug> --lane [--prefix plan-build|goal-build|bugfix] --json',
    'buracle review-scope [--slug <s>] --json',
    'buracle notify plan_approval|attention_needed|verification_complete|info "<title>" "<message>" [--plan <path>]',
    'buracle notify <type> "<title>"',
    'buracle skills list\\|new\\|lint',
    'buracle mem search|get|remember|status',
    'buracle mem capture --pending',
    'buracle mem finalize',
    'buracle mem ui --open',
    'buracle config get plan.branchIsolation',
    'buracle doctor <harness>',
    'buracle install <h> --dry-run',
    'buracle update --check',
    'buracle update --yes',
    'buracle update mcp',
    'buracle update harness tools --yes',
    'buracle rollback 20261008-1',
    'buracle --help',
  ]
  for (const m of okMentions) {
    test(`allowed: ${m}`, () => {
      const found = findMentions(m)
      expect(found.length).toBe(1)
      expect(checkMention(found[0]?.tokens ?? [])).toEqual([])
    })
  }

  test('undocumented commands, subcommands and set fields are reported', () => {
    const bad = (s: string) => checkMention(findMentions(s)[0]?.tokens ?? []).map(p => p.message)
    expect(bad('buracle spec register x')[0]).toContain("'buracle spec'")
    expect(bad('buracle plan show')[0]).toContain("'buracle plan show'")
    expect(bad('buracle plan set owner me')[0]).toContain("'buracle plan set owner'")
    expect(bad('buracle usage refresh')[0]).toContain('takes no subcommand')
    expect(bad('buracle update everything')[0]).toContain("'buracle update everything' is not a documented subcommand")
    expect(bad('buracle sync')[0]).toContain("'buracle sync' is not a documented helper command")
    expect(bad('buracle install claude --dry-run')).toEqual([])
    expect(bad('buracle install vscode')[0]).toContain("'buracle install vscode' is not a documented subcommand")
    expect(bad('buracle worktree create|merge x')).toHaveLength(1)
    expect(bad('buracle hook claude Stop')[0]).toContain("'buracle hook'")
    expect(bad('buracle config set a b')[0]).toContain("'buracle config set'")
    expect(bad('buracle mem obsidian status')[0]).toContain("'buracle mem obsidian'")
    expect(bad('buracle mem consolidate')[0]).toContain("'buracle mem consolidate'")
    for (const gone of ['sweep', 'heal', 'reflect', 'verify', 'jobs', 'tick', 'kick', 'profile drop "x"']) expect(bad(`buracle mem ${gone}`)[0]).toContain(`'buracle mem ${gone.split(' ')[0]}'`)
  })

  test('only real invocations count: paths, placeholders and prose are ignored; pipes end a command', () => {
    expect(findMentions('<buracle repo>/canonical/skills')).toEqual([])
    expect(findMentions('BURACLE_HOME=x bun <root>/candidate/buracle bun main.ts build')).toEqual([])
    expect(findMentions('buracle: command not found')).toEqual([])
    expect(findMentions('buracle-memory')).toEqual([])
    expect(findMentions('buracle plan status --json | jq .plan')[0]?.tokens).toEqual(['plan', 'status', '--json'])
    expect(findMentions('x && buracle doctor && y').map(m => m.tokens[0])).toEqual(['doctor'])
  })
})

describe('markdown checks', () => {
  test('placeholders: allowed forms, escapes, unknown names and missing targets', () => {
    const text = [
      'Ask with {{ask_user}}, track with {{todo}}, delegate with {{spawn_agent}}.',
      'Run {{skill:plan-build}} or {{agent:changes-review}}.',
      'Literal \\{{ .Values.name }} stays.',
      '```', '{{agent:changes-review}}', '```',
      'Bad: {{ask-user}} {{skill:nope}} {{agent:ghost}} {{ todo }} {{unclosed',
    ].join('\n')
    const f = checkPlaceholders('x.md', scanMarkdown(text), TARGETS, 'canonical skills')
    expect(codes(f)).toEqual(['placeholder-unknown', 'placeholder-target', 'placeholder-target', 'placeholder-unknown', 'placeholder-malformed'])
    expect(f.every(x => x.line === 7)).toBe(true)
  })

  test('placeholders in files nothing renders: only Buracle placeholders are errors', () => {
    const f = checkPlaceholders('r.md', scanMarkdown('Use {{ask_user}} here.\n```\n{{ .Name }}\n```\n'), null, 'rules')
    expect(codes(f)).toEqual(['placeholder-not-rendered'])
  })

  test('harness blocks: balanced, known names, exact syntax', () => {
    const good = '<!-- harness:claude -->\nx\n<!-- /harness -->\n<!-- harness:omp -->y<!-- /harness -->\n<!-- a normal comment -->\n'
    expect(checkHarnessBlocks('a.md', scanMarkdown(good), true, 'skills')).toEqual([])
    const bad = '<!-- harness:claude -->\n<!-- harness:codex -->\n<!-- /harness -->\n<!-- /harness -->\n<!-- harness:cursor -->\n<!--harness:omp-->\n'
    expect(codes(checkHarnessBlocks('b.md', scanMarkdown(bad), true, 'skills'))).toEqual(['harness-block-nested', 'harness-block-unopened', 'harness-unknown', 'harness-marker-malformed', 'harness-block-unclosed'])
    expect(codes(checkHarnessBlocks('c.md', scanMarkdown(good), false, 'rules'))).toEqual(['harness-block-not-rendered', 'harness-block-not-rendered', 'harness-block-not-rendered', 'harness-block-not-rendered'])
  })

  test('mentions are checked in code spans and fences only', () => {
    const text = 'Prose about buracle plan show is ignored.\nRun `buracle plan show`.\n```sh\nburacle worktree merge x\n```\n'
    const f = checkBuracleMentions('m.md', scanMarkdown(text))
    expect(f.map(x => x.line)).toEqual([2, 4])
  })

  test('relative links must resolve; code, URLs and anchors are skipped', () => withSandbox(({ root }) => {
    const dir = join(root, 'skill')
    write(join(dir, 'references', 'ok.md'), '# ok\n')
    write(join(root, 'outside.md'), '# out\n')
    const text = '[a](references/ok.md) [b](references/missing.md) [c](https://x.y) [d](#top) `[e](nope.md)` [f](../outside.md)\n[ref]: references/ok.md#part\n'
    write(join(dir, 'SKILL.md'), text)
    const f = checkLinks('SKILL.md', join(dir, 'SKILL.md'), scanMarkdown(text), { containWithin: dir })
    expect(f.map(x => [x.code, x.level])).toEqual([['link-broken', 'error'], ['link-outside-skill', 'warning']])
    const r = checkLinks('r.md', join(dir, 'SKILL.md'), scanMarkdown(text), { noRelative: 'rules are installed elsewhere' })
    expect(r.every(x => x.code === 'link-relative')).toBe(true)
  }))
})

const GOOD_SKILL = `---
name: sample
description: >-
  Sample skill for tests. Use when the test suite needs a valid skill ("sample skill").
when_to_use: Tests only.
invocation: implicit
argument-hint: "<x>"
mcp: [context7]
short-description: A valid sample skill
---

# Sample

Track work with {{todo}}; ask with {{ask_user}}; hand off to {{skill:plan-build}} or {{agent:changes-review}}.
Run \`buracle plan status --json\` first. Details: [references/more.md](references/more.md).
<!-- harness:codex -->
Codex only.
<!-- /harness -->
`

describe('skill lint', () => {
  test('a valid skill has no findings; evals/ fixtures are not linted', () => withSandbox(({ root }) => {
    const dir = join(root, 'skills', 'sample')
    write(join(dir, 'SKILL.md'), GOOD_SKILL)
    write(join(dir, 'references', 'more.md'), 'More, see `buracle worktree detect --json`.\n')
    write(join(dir, 'evals', 'cases.json'), '{"cases": [{"id": "a", "prompt": "p", "expect": {}}]}\n')
    write(join(dir, 'evals', 'fixtures', 'repo', 'README.md'), 'Handlebars {{name}} and buracle frobnicate are fine here.\n')
    write(join(dir, 'scripts', 'run.ts'), 'console.log(1)\n')
    const f = lintSkillDir(dir, { displayRoot: root, targets: TARGETS, mcp: new Set(['context7']), profile: 'canonical' })
    expect(f).toEqual([])
  }))

  test('frontmatter keys and limits, scaffold leftovers, MCP ids, orphans, evals JSON', () => withSandbox(({ root }) => {
    const dir = join(root, 'skills', 'Bad_Name')
    const long = 'x'.repeat(1100)
    write(join(dir, 'SKILL.md'), `---\nname: other\ndescription: ${long}\ninvocation: sometimes\nmcp: [context7, nope]\nshort-description: ${'y'.repeat(81)}\ncolor: blue\n---\n\n# Bad\n\n${'word '.repeat(3100)}\n`)
    write(join(dir, 'references', 'lonely.md'), '# nobody links here\n')
    write(join(dir, 'evals', 'cases.json'), '{not json')
    write(join(dir, 'notes.txt'), 'stray\n')
    const f = lintSkillDir(dir, { displayRoot: root, targets: TARGETS, mcp: new Set(['context7']), profile: 'canonical' })
    const c = codes(f)
    for (const want of ['skill-id', 'frontmatter-unknown-key', 'frontmatter-name', 'description-too-long', 'frontmatter-invocation', 'mcp-unknown', 'frontmatter-short-description', 'reference-orphan', 'evals-json', 'unexpected-file']) {
      expect(c).toContain(want)
    }
  }))

  test('a SKILL.md of any length is accepted: no size finding, as error or warning', () => withSandbox(({ root }) => {
    const dir = join(root, 'skills', 'sample')
    write(join(dir, 'SKILL.md'), `${GOOD_SKILL}\n${'word '.repeat(9000)}\n`)
    write(join(dir, 'references', 'more.md'), 'More.\n')
    const f = lintSkillDir(dir, { displayRoot: root, targets: TARGETS, mcp: new Set(['context7']), profile: 'canonical' })
    expect(f).toEqual([])
    const project = join(root, 'repo', '.agents', 'skills', 'deploy')
    write(join(project, 'SKILL.md'), `---\nname: deploy\ndescription: Deploy the app when asked.\n---\n# Deploy\n${'word '.repeat(9000)}\n`)
    expect(lintSkillDir(project, { displayRoot: root, targets: TARGETS, mcp: new Set(), profile: 'project' })).toEqual([])
  }))

  test('missing SKILL.md and broken YAML are reported', () => withSandbox(({ root }) => {
    write(join(root, 'skills', 'empty', 'references', 'x.md'), 'x')
    expect(codes(lintSkillDir(join(root, 'skills', 'empty'), { displayRoot: root, targets: TARGETS, mcp: new Set(), profile: 'canonical' }))).toEqual(['skill-md-missing'])
    write(join(root, 'skills', 'yaml', 'SKILL.md'), '---\nname: [unclosed\n---\n# x\n')
    expect(codes(lintSkillDir(join(root, 'skills', 'yaml'), { displayRoot: root, targets: TARGETS, mcp: new Set(), profile: 'canonical' }))).toContain('frontmatter-parse')
  }))

  test('project skills (.agents/skills) get the portable subset: no placeholders or harness blocks', () => withSandbox(({ root }) => {
    const dir = join(root, 'repo', '.agents', 'skills', 'deploy')
    write(join(dir, 'SKILL.md'), '---\nname: deploy\ndescription: Deploy the app when asked.\ndisable-model-invocation: true\n---\n# Deploy\nAsk with {{ask_user}}.\n<!-- harness:claude -->\nx\n<!-- /harness -->\n')
    const r = skillsLint([join(root, 'repo', '.agents', 'skills')], false, ctxAt(root))
    expect(r.code).toBe(1)
    const c = (r.data['findings'] as LintFinding[]).map(x => x.code)
    expect(c).toEqual(['placeholder-not-rendered', 'harness-block-not-rendered', 'harness-block-not-rendered'])
  }))

  test('skills new scaffolds into the configured source; lint then flags the scaffold text', () => withSandbox(({ root, buracleHome }) => {
    const src = join(root, 'my-skills')
    write(join(buracleHome, 'config.yaml'), `skills:\n  sources:\n    - name: mine\n      path: ${src}\n`)
    const r = skillsNew('release-notes', undefined)
    expect(r.code).toBe(0)
    expect(r.data['path']).toBe(join(src, 'release-notes'))
    expect(existsSync(join(src, 'release-notes', 'evals', 'cases.json'))).toBe(true)
    expect(skillsNew('release-notes', undefined).data['error']).toBe('exists')
    expect(skillsNew('Bad Id', undefined).code).toBe(1)
    expect(skillsNew('x', 'nope').data['error']).toBe('no_source')
    const lint = skillsLint([], false, ctxAt(root))
    expect(lint.code).toBe(1)
    const c = (lint.data['findings'] as LintFinding[]).map(x => x.code)
    expect(c).toContain('scaffold-left')
    expect(c).not.toContain('frontmatter-parse')
    expect(scaffoldSkill('a-b').skill).toContain('# A B')
  }))

  test('skills list shows sources and project skills', () => withSandbox(async ({ root, buracleHome }) => {
    const src = join(root, 'my-skills')
    write(join(src, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: A.\ninvocation: explicit\nmcp: []\nshort-description: Alpha\n---\n# A\n')
    write(join(buracleHome, 'config.yaml'), `skills:\n  sources:\n    - name: mine\n      path: ${src}\n    - name: remote\n      git: https://example.com/x.git\n`)
    const r = await skillsList(ctxAt(root))
    expect(r.data['skills']).toMatchObject([{ id: 'alpha', source: 'mine', invocation: 'explicit', shortDescription: 'Alpha' }])
    expect(r.data['sources']).toMatchObject([{ name: 'mine', exists: true }, { name: 'remote', exists: false }])
  }))

  test('lists the Claude-only project skills and the user folders Buracle does not own, with the harnesses that see them', () => withSandbox(async ({ root, home, buracleHome }) => {
    const { makeRepo } = await import('./fixture')
    const src = join(root, 'mine')
    write(join(src, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: A.\ninvocation: explicit\nmcp: []\nshort-description: Alpha\n---\n# A\n')
    write(join(buracleHome, 'config.yaml'), `skills:\n  sources:\n    - name: mine\n      path: ${src}\n`)
    const repo = await makeRepo(root)
    write(join(repo, '.claude', 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a diff\n---\n')
    write(join(home, '.agents', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: rendered by buracle\n---\n')
    write(join(home, '.agents', 'skills', 'hand', 'SKILL.md'), '---\nname: hand\ndescription: Placed by hand\n---\n')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    symlinkSync(join(home, '.agents', 'skills', 'hand'), join(home, '.claude', 'skills', 'hand'))
    write(join(home, '.claude', 'skills', 'solo', 'SKILL.md'), '---\nname: solo\ndescription: Claude only\n---\n')
    const r = await skillsList(ctxAt(repo))
    const extra = (r.data['skills'] as Array<Record<string, unknown>>).filter(s => s['kind'] === 'claude-only' || s['kind'] === 'unmanaged').map(s => [s['id'], s['kind'], s['harnesses']])
    expect(extra).toEqual([
      ['review', 'claude-only', ['claude', 'opencode', 'omp']],
      ['hand', 'unmanaged', ['claude', 'codex', 'omp', 'opencode']],
      ['solo', 'unmanaged', ['claude', 'opencode']],
    ])
    expect(r.lines.join('\n')).toContain('[claude-only: claude, opencode, omp]')
  }))

  test('the real canonical tree lints without crashing', () => {
    const r = skillsLint([], false, ctxAt(process.cwd()))
    expect([0, 1]).toContain(r.code)
    expect(r.data['skills'] as number).toBeGreaterThan(5)
    for (const f of r.data['findings'] as LintFinding[]) expect(['error', 'warning']).toContain(f.level)
  })
})

describe('rules lint', () => {
  test('budgets, frontmatter and unrendered syntax', () => withSandbox(({ root }) => {
    const rules = join(root, 'rules')
    write(join(rules, 'always', 'core.md'), '# Core\nRun `buracle plan pause --kind decision`.\n')
    write(join(rules, 'always', 'fm.md'), '---\npaths: ["x"]\n---\n# has frontmatter\n')
    write(join(rules, 'always', 'big.md'), 'line\n'.repeat(450))
    write(join(rules, 'always', 'more.md'), 'line\n'.repeat(100))
    write(join(rules, 'paths', 'py.md'), '---\npaths:\n  - "**/*.py"\n---\n# Python\n')
    write(join(rules, 'paths', 'none.md'), '# no frontmatter\n')
    write(join(rules, 'paths', 'bad.md'), '---\npaths: ["src/{a,b"]\nextra: 1\n---\n# Bad\nUse {{ask_user}}.\n<!-- harness:claude -->\nx\n<!-- /harness -->\nSee [x](../x.md). Run `buracle plan show`.\n')
    write(join(rules, 'stray.txt'), 'x')
    const { findings, counts } = lintRulesDir(rules, root)
    const c = codes(findings)
    for (const want of ['always-frontmatter', 'rule-file-lines', 'always-budget', 'paths-frontmatter', 'glob-invalid', 'frontmatter-unknown-key', 'placeholder-not-rendered', 'harness-block-not-rendered', 'link-relative', 'buracle-command', 'unexpected-file']) {
      expect(c).toContain(want)
    }
    expect(counts).toMatchObject({ always: 4, paths: 3 })
    expect(findings.filter(f => f.file === 'rules/paths/py.md')).toEqual([])
  }))

  test('glob sanity', () => {
    expect(globProblems('**/*.{ts,tsx}')).toEqual([])
    expect(globProblems('/abs/**')).toHaveLength(1)
    expect(globProblems('a\\b')).toHaveLength(1)
    expect(globProblems('[ab')).toEqual(['unbalanced [ ]'])
  })

  test('the real canonical rules lint without crashing; a missing dir is an error', () => withSandbox(({ root }) => {
    const r = rulesLint(undefined, false, ctxAt(process.cwd()))
    expect([0, 1]).toContain(r.code)
    expect(r.data['always'] as number).toBeGreaterThan(0)
    expect(rulesLint('nope', false, ctxAt(root)).code).toBe(1)
    const text = readFileSync(join(process.cwd(), 'canonical', 'rules', 'always', 'core.md'), 'utf8')
    expect(text.length).toBeGreaterThan(0)
  }))
})

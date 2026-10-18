import { describe, expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import type { CanonicalBundle, SkillDoc } from '../../../src/core/catalog'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import { parseFrontmatter } from '../../../src/engine/canonical'
import { buildAgentsSkills, neutralDescription, openaiYaml, renderNeutralSkills } from '../../../src/adapters/shared/skills'

const REPO = join(import.meta.dir, '..', '..', '..')
const canonical: CanonicalBundle = loadCanonicalSync(join(REPO, 'canonical'))
const rendered = renderNeutralSkills(canonical)
const byPath = new Map(rendered.files.map(f => [f.path, f]))

function skill(fm: Record<string, unknown>, files: SkillDoc['files'] = [], body = '# X\n'): SkillDoc {
  return { id: 'x', dir: 'skills/x', frontmatter: fm, body, files: [{ path: 'SKILL.md', content: '', mode: 0o644 }, ...files] }
}

describe('neutral skill render (harness/agents-skills)', () => {
  test('renders every canonical skill without warnings', () => {
    expect(rendered.warnings).toEqual([])
    for (const s of canonical.skills) {
      expect(byPath.has(`${s.id}/SKILL.md`)).toBe(true)
      expect(byPath.has(`${s.id}/agents/openai.yaml`)).toBe(true)
    }
  })

  test('the committed harness/agents-skills tree is up to date (byte for byte)', () => {
    for (const f of rendered.files) {
      const committed = readFileSync(join(REPO, 'harness', 'agents-skills', f.path), 'utf8')
      expect({ path: f.path, content: committed }).toEqual({ path: f.path, content: f.content })
    }
  })

  test('is deterministic', () => {
    expect(renderNeutralSkills(canonical)).toEqual(rendered)
    expect(buildAgentsSkills({ canonical })).toEqual(rendered.files)
  })

  test('SKILL.md frontmatter: name, folded description, short-description; explicit skills disable model invocation', () => {
    for (const s of canonical.skills) {
      const { frontmatter } = parseFrontmatter((byPath.get(`${s.id}/SKILL.md`) as { content: string }).content)
      const explicit = s.frontmatter['invocation'] === 'explicit'
      expect(Object.keys(frontmatter).sort()).toEqual(explicit ? ['description', 'disable-model-invocation', 'metadata', 'name'] : ['description', 'metadata', 'name'])
      expect(frontmatter['name']).toBe(s.id)
      const d = frontmatter['description'] as string
      expect(d.length).toBeLessThanOrEqual(1024)
      expect(d).not.toMatch(/\n/)
      if (typeof s.frontmatter['when_to_use'] === 'string') expect(d).toContain('When to use: ')
      if (explicit) {
        expect(d).toMatch(/only when the user/i)
        expect(frontmatter['disable-model-invocation']).toBe(true)
      }
      expect(frontmatter['metadata']).toEqual({ 'short-description': s.frontmatter['short-description'] as string })
    }
    expect(canonical.skills.some(s => s.frontmatter['invocation'] === 'explicit')).toBe(true)
  })

  test('every .md is rendered: no live placeholders or harness markers remain, claude blocks are gone', () => {
    for (const f of rendered.files) {
      if (!f.path.endsWith('.md')) continue
      expect({ path: f.path, live: f.content.match(/(?<!\\)\{\{(?:ask_user|todo|spawn_agent|skill:|agent:)[^}]*\}\}/g) }).toEqual({ path: f.path, live: null })
      expect(f.content).not.toMatch(/<!--\s*\/?harness/)
    }
    for (const p of ['ab-test/SKILL.md', 'dead-code/SKILL.md']) expect((byPath.get(p) as { content: string }).content).not.toContain('CLAUDE_SKILL_DIR')
    expect((byPath.get('research/SKILL.md') as { content: string }).content).not.toContain('ToolSearch')
    expect((byPath.get('ab-test/SKILL.md') as { content: string }).content).toContain('**Codex, OpenCode and Oh My Pi:** `~/.agents/skills/ab-test`')
    expect((byPath.get('plan-build/references/plan.md') as { content: string }).content).toContain('`request_user_input` in Codex')
    expect((byPath.get('inspect/SKILL.md') as { content: string }).content).toContain('suggest `/bugfix` (Codex: `$bugfix`)')
    expect((byPath.get('project-rules/SKILL.md') as { content: string }).content).toContain('the `memory` skill: read `~/.agents/skills/memory/SKILL.md` in Codex')
    for (const f of rendered.files) if (f.path.endsWith('.md')) expect({ path: f.path, oldForm: /`@(?:spec|build|fix|prd|research)`|`\/skill:(?:spec|build|fix|prd)`/.test(f.content) }).toEqual({ path: f.path, oldForm: false })
  })

  test('evals/ is skipped; scripts/ and other files are copied verbatim', () => {
    expect(rendered.files.some(f => f.path.includes('/evals/'))).toBe(false)
    const run = byPath.get('ab-test/scripts/run.ts')
    expect(run?.content).toBe(readFileSync(join(REPO, 'canonical', 'skills', 'ab-test', 'scripts', 'run.ts'), 'utf8'))
    expect(byPath.get('ab-test/scripts/profiles/codex.json')?.content).toBe(readFileSync(join(REPO, 'canonical', 'skills', 'ab-test', 'scripts', 'profiles', 'codex.json'), 'utf8'))
  })

  test('executable scripts keep mode 0755', () => {
    const doc = skill({ name: 'x', description: 'd' }, [{ path: 'scripts/go.sh', content: '#!/bin/sh\n', mode: 0o755 }, { path: 'scripts/data.json', content: '{}', mode: 0o644 }])
    const out = renderNeutralSkills({ mcp: canonical.mcp, skills: [doc], agents: [] }).files
    expect(out.find(f => f.path === 'x/scripts/go.sh')?.mode).toBe(0o755)
    expect(out.find(f => f.path === 'x/scripts/data.json')?.mode).toBeUndefined()
  })

  test('agents/openai.yaml: interface, policy from invocation; only URL MCP servers are Codex dependencies (CODEX-OPENAI-YAML-STDIO-DEPS)', () => {
    for (const s of canonical.skills) {
      const text = (byPath.get(`${s.id}/agents/openai.yaml`) as { content: string }).content
      const y = parseYaml(text) as Record<string, any>
      expect(y['interface']['display_name']).toBeString()
      expect(y['interface']['short_description']).toBe(s.frontmatter['short-description'])
      expect(y['policy']['allow_implicit_invocation']).toBe(s.frontmatter['invocation'] !== 'explicit')
      const mcp = ((s.frontmatter['mcp'] as string[] | undefined) ?? []).filter(id => canonical.mcp.servers[id]?.harnesses.some(h => h !== 'claude'))
      const remote = mcp.filter(id => canonical.mcp.servers[id]?.transport === 'http')
      const local = mcp.filter(id => canonical.mcp.servers[id]?.transport !== 'http')
      if (remote.length === 0) expect(y['dependencies']).toBeUndefined()
      else {
        expect(y['dependencies']['tools'].map((t: any) => t.value)).toEqual(remote)
        for (const t of y['dependencies']['tools']) expect(t).toEqual({ type: 'mcp', value: t.value, description: t.description, transport: 'streamable_http', url: canonical.mcp.servers[t.value]?.url })
      }
      if (local.length > 0) expect(text).toContain(`# Local MCP servers this skill uses (installed by \`buracle install\`, not declared below): ${local.join(', ')}.`)
      else expect(text).not.toContain('# Local MCP servers')
    }
    expect(openaiYaml(skill({ name: 'x', description: 'd', invocation: 'explicit', mcp: ['nope'] }), canonical.mcp, [])).toContain('allow_implicit_invocation: false')
  })

  test('descriptions: explicit skills say so once; a user-invocable skill says how the user starts it (PLAN §2.2); overlong when_to_use is shortened to fit 1,024 characters', () => {
    expect(neutralDescription(skill({ description: 'Does X.', invocation: 'explicit' }))).toBe('Does X. Use it only when the user asks for it explicitly. The user starts it with /x (Codex: $x).')
    expect(neutralDescription(skill({ description: 'Run only when the user explicitly asks for x.', invocation: 'explicit' }))).toBe('Run only when the user explicitly asks for x. The user starts it with /x (Codex: $x).')
    expect(neutralDescription(skill({ description: 'Protocol for y.', 'user-invocable': false }))).toBe('Protocol for y.')
    for (const s of canonical.skills) {
      const d = neutralDescription(s)
      expect({ skill: s.id, start: d.includes(`The user starts it with /${s.id} (Codex: $${s.id}).`) }).toEqual({ skill: s.id, start: s.frontmatter['user-invocable'] !== false })
    }
    const warnings: string[] = []
    const d = neutralDescription(skill({ description: 'a'.repeat(600), when_to_use: 'word '.repeat(200) }), warnings)
    expect(d.length).toBeLessThanOrEqual(1024)
    expect(d).toEndWith('…')
    expect(warnings).toHaveLength(1)
  })

  test('no absolute user paths in the rendered tree', () => {
    const home = homedir()
    for (const f of rendered.files) expect({ path: f.path, hasHome: f.content.includes(home) || /\/Users\/[a-z]/.test(f.content) }).toEqual({ path: f.path, hasHome: false })
  })

  test('committed files have the generated modes', () => {
    for (const f of rendered.files) {
      const mode = statSync(join(REPO, 'harness', 'agents-skills', f.path)).mode & 0o777
      expect({ path: f.path, mode }).toEqual({ path: f.path, mode: f.mode ?? 0o644 })
    }
  })
})

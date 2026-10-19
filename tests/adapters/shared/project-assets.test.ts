import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSETS_SPAWN_THROTTLE_MS, assetsAfterEdit, assetsContext, assetsContextCached, assetsSessionStart, clearAssetsContextCache, startLinkRun,
} from '../../../src/adapters/shared/project-assets'
import { projectSync } from '../../../src/workflow/project'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctxAt, g, makeRepo, write } from '../../workflow/fixture'

const T0 = Date.UTC(2026, 9, 17, 9, 0, 0)
const ARGV = ['buracle']
const SKILL = '---\nname: deploy\ndescription: Deploy the app\n---\n# Deploy\n'
const AGENTS = '# Demo\n\n## Scoped rules\n\nRead the matching rule before editing those files.\n\n- `.claude/rules/sql.md` \u2014 `db/**/*.sql` \u2014 migrations\n'

function recorder(): { calls: Array<{ argv: string[], cwd: string }>, spawn: (argv: string[], cwd: string) => void } {
  const calls: Array<{ argv: string[], cwd: string }> = []
  return { calls, spawn: (argv, cwd) => { calls.push({ argv, cwd }) } }
}

async function repoWith(root: string, files: Record<string, string>): Promise<string> {
  const repo = await makeRepo(root)
  for (const [rel, text] of Object.entries(files)) write(join(repo, rel), text)
  return repo
}

describe('H28 link run', () => {
  test('starts `buracle project sync --auto --quiet` in the root when a skill has no link, at most once per 30 s', () => withSandbox(async ({ root }) => {
    const repo = await repoWith(root, { 'AGENTS.md': '# Demo\n', '.agents/skills/deploy/SKILL.md': SKILL })
    const r = recorder()
    expect(startLinkRun(repo, { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBe(true)
    expect(r.calls).toEqual([{ argv: ['buracle', 'project', 'sync', '--auto', '--quiet'], cwd: repo }])
    expect(startLinkRun(repo, { nowMs: T0 + 1_000, spawn: r.spawn, argv: ARGV })).toBe(false)
    expect(startLinkRun(repo, { nowMs: T0 + ASSETS_SPAWN_THROTTLE_MS + 1, spawn: r.spawn, argv: ARGV })).toBe(true)
    expect(r.calls.length).toBe(2)
  }))

  test('the run itself links the skill and keeps the link out of git; afterwards nothing is pending', () => withSandbox(async ({ root }) => {
    const repo = await repoWith(root, { 'AGENTS.md': '# Demo\n', '.agents/skills/deploy/SKILL.md': SKILL })
    const auto = await withEnv({ BURACLE_NO_MEMORY: '1' }, () => projectSync('sync', ctxAt(repo), undefined, { auto: true }))
    expect(auto.code).toBe(0)
    expect(auto.data['links']).toMatchObject({ created: ['deploy'] })
    expect(lstatSync(join(repo, '.claude', 'skills', 'deploy')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.claude/skills/deploy')
    expect(await g(repo, 'status', '--porcelain', '--', '.claude')).toBe('')
    const r = recorder()
    expect(startLinkRun(repo, { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBe(false)
    expect(r.calls).toEqual([])
  }))

  test('nothing starts without link work, outside a project, through an outside symlink, or with autostart off and no spawner', () => withSandbox(async ({ root, home }) => {
    const r = recorder()
    const plain = await repoWith(root, { 'AGENTS.md': '# Demo\n' })
    expect(startLinkRun(plain, { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBe(false)
    write(join(home, '.agents', 'skills', 'x', 'SKILL.md'), SKILL)
    expect(startLinkRun(home, { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBe(false)
    const outside = await repoWith(join(root, 'o'), { '.agents/skills/deploy/SKILL.md': SKILL })
    mkdirSync(join(root, 'elsewhere'), { recursive: true })
    mkdirSync(join(outside, '.claude'), { recursive: true })
    symlinkSync(join(root, 'elsewhere'), join(outside, '.claude', 'skills'))
    expect(startLinkRun(outside, { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBe(false)
    expect(startLinkRun(undefined, { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBe(false)
    expect(r.calls).toEqual([])
    const pending = await repoWith(join(root, 'p'), { '.agents/skills/deploy/SKILL.md': SKILL })
    expect(process.env['BURACLE_NO_AUTOSTART']).toBe('1')
    expect(startLinkRun(pending, { nowMs: T0, argv: ARGV })).toBe(false)
    expect(existsSync(join(root, 'elsewhere', 'deploy'))).toBe(false)
  }))
})

describe('H28 session-start context', () => {
  test('lists the rules the index lacks (private ones too) for Codex, OpenCode and omp; Claude Code gets only a parity warning', () => withSandbox(async ({ root }) => {
    const repo = await repoWith(root, {
      'AGENTS.md': AGENTS,
      '.gitignore': '.claude/rules/mine.md\n',
      '.claude/rules/sql.md': '---\npaths: ["db/**/*.sql"]\n---\nMigrations.\n',
      '.claude/rules/web.md': '---\npaths: ["src/**/*.tsx"]\n---\nComponents.\n',
      '.claude/rules/mine.md': '---\npaths: ["src/**"]\n---\nMy notes.\n',
      '.claude/rules/README.md': 'not a rule\n',
    })
    const claude = assetsContext(repo, 'claude')
    expect(claude).toContain('1 path rule(s) in .claude/rules are out of step')
    expect(claude).toContain('`buracle project check`')
    expect(claude).not.toContain('web.md')
    for (const h of ['codex', 'opencode', 'omp'] as const) {
      const text = assetsContext(repo, h)
      expect(text).toContain('`.claude/rules/web.md` \u2014 `src/**/*.tsx`')
      expect(text).toContain('`.claude/rules/mine.md` \u2014 `src/**`')
      expect(text).not.toContain('sql.md')
      expect(text).not.toContain('README')
    }
  }))

  test('Codex also learns the skills that live only in .claude/skills; an in-sync repo gets no text', () => withSandbox(async ({ root }) => {
    const repo = await repoWith(root, { 'AGENTS.md': '# Demo\n', '.claude/skills/review/SKILL.md': '---\nname: review\ndescription: Review a diff\n---\n' })
    expect(assetsContext(repo, 'codex')).toContain('- `review`: Review a diff')
    expect(assetsContext(repo, 'omp')).toBe('')
    expect(assetsContext(repo, 'opencode')).toBe('')
    const clean = await repoWith(join(root, 'c'), { 'AGENTS.md': AGENTS, '.claude/rules/sql.md': '---\npaths: ["db/**/*.sql"]\n---\n' })
    for (const h of ['claude', 'codex', 'opencode', 'omp'] as const) expect(assetsContext(clean, h)).toBe('')
    const r = recorder()
    write(join(clean, '.agents', 'skills', 'deploy', 'SKILL.md'), SKILL)
    expect(assetsSessionStart(clean, 'codex', { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBe('')
    expect(r.calls.length).toBe(1)
  }))

  test('the cached form serves OpenCode requests for 60 s', () => withSandbox(async ({ root }) => {
    clearAssetsContextCache()
    const repo = await repoWith(root, { 'AGENTS.md': AGENTS })
    expect(assetsContextCached(repo, 'opencode', T0)).toBe('')
    write(join(repo, '.claude', 'rules', 'new.md'), '---\npaths: ["n/**"]\n---\n')
    expect(assetsContextCached(repo, 'opencode', T0 + 1_000)).toBe('')
    expect(assetsContextCached(repo, 'opencode', T0 + 61_000)).toContain('.claude/rules/new.md')
    clearAssetsContextCache()
  }))
})

describe('H28 after an edit', () => {
  test('a new skill starts the link run; a CLAUDE.md without the import gets a note', () => withSandbox(async ({ root }) => {
    const repo = await repoWith(root, { 'AGENTS.md': '# Demo\n' })
    const r = recorder()
    write(join(repo, '.agents', 'skills', 'deploy', 'SKILL.md'), SKILL)
    expect(assetsAfterEdit(repo, [join(repo, '.agents', 'skills', 'deploy', 'SKILL.md')], { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBeUndefined()
    expect(r.calls.length).toBe(1)
    write(join(repo, 'CLAUDE.md'), '# Claude notes\n')
    expect(assetsAfterEdit(repo, [join(repo, 'CLAUDE.md')], { nowMs: T0 })).toContain('CLAUDE.md does not import AGENTS.md')
    write(join(repo, 'CLAUDE.md'), '@AGENTS.md\n\n- a Claude note\n')
    expect(assetsAfterEdit(repo, [join(repo, 'CLAUDE.md')], { nowMs: T0 })).toBeUndefined()
    expect(assetsAfterEdit(repo, [join(root, 'outside.md')], { nowMs: T0 })).toBeUndefined()
    write(join(repo, '.claude', 'CLAUDE.md'), '@AGENTS.md\n')
    expect(assetsAfterEdit(repo, [join(repo, '.claude', 'CLAUDE.md')], { nowMs: T0 })).toContain('Keep the line `@../AGENTS.md` in it')
    write(join(repo, '.claude', 'CLAUDE.md'), '@../AGENTS.md\n')
    expect(assetsAfterEdit(repo, [join(repo, '.claude', 'CLAUDE.md')], { nowMs: T0 })).toBeUndefined()
  }))

  test('a rule edit asks for its index line unless it is gitignored; an AGENTS.md edit lists what is out of step', () => withSandbox(async ({ root }) => {
    const repo = await repoWith(root, { 'AGENTS.md': AGENTS, '.gitignore': '.claude/rules/mine.md\n' })
    write(join(repo, '.claude', 'rules', 'web.md'), '---\npaths: ["src/**/*.tsx"]\n---\n')
    expect(assetsAfterEdit(repo, [join(repo, '.claude', 'rules', 'web.md')], { nowMs: T0 })).toContain('Add the line - `.claude/rules/web.md` \u2014 `src/**/*.tsx` \u2014 <purpose>')
    write(join(repo, '.claude', 'rules', 'mine.md'), '---\npaths: ["src/**"]\n---\n')
    expect(assetsAfterEdit(repo, [join(repo, '.claude', 'rules', 'mine.md')], { nowMs: T0 })).toBeUndefined()
    write(join(repo, '.claude', 'rules', 'sql.md'), '---\npaths: ["db/**"]\n---\n')
    expect(assetsAfterEdit(repo, [join(repo, '.claude', 'rules', 'sql.md')], { nowMs: T0 })).toContain('names `db/**/*.sql`, but its `paths:` are `db/**`')
    const note = assetsAfterEdit(repo, [join(repo, 'AGENTS.md')], { nowMs: T0 }) ?? ''
    expect(note).toContain('.claude/rules/web.md is missing')
    expect(note).not.toContain('mine.md')
  }))

  test('deleting a rule the index lists names the line that now points nowhere; an unlisted one stays quiet', () => withSandbox(async ({ root }) => {
    const repo = await repoWith(root, { 'AGENTS.md': AGENTS, '.claude/rules/sql.md': '---\npaths: ["db/**/*.sql"]\n---\n', '.claude/rules/old.md': '---\npaths: ["old/**"]\n---\n' })
    rmSync(join(repo, '.claude', 'rules', 'sql.md'))
    expect(assetsAfterEdit(repo, [join(repo, '.claude', 'rules', 'sql.md')], { nowMs: T0 })).toContain('AGENTS.md:7 lists .claude/rules/sql.md, which does not exist')
    rmSync(join(repo, '.claude', 'rules'), { recursive: true })
    expect(assetsAfterEdit(repo, [join(repo, '.claude', 'rules', 'old.md')], { nowMs: T0 })).toBeUndefined()
  }))

  test('a SKILL.md written only in .claude/skills gets a note that Codex cannot see it; a linked or adopted skill does not', () => withSandbox(async ({ root }) => {
    const repo = await repoWith(root, { 'AGENTS.md': '# Demo\n' })
    const md = join(repo, '.claude', 'skills', 'review', 'SKILL.md')
    write(md, '---\nname: review\ndescription: Review a diff\n---\n')
    const note = assetsAfterEdit(repo, [md], { nowMs: T0 }) ?? ''
    expect(note).toContain('.claude/skills/review exists only in .claude/skills, so Codex cannot see it')
    expect(note).toContain('`buracle project sync --adopt`')
    expect(assetsAfterEdit(repo, [join(repo, '.claude', 'skills', 'review', 'references', 'x.md')], { nowMs: T0 })).toBeUndefined()
    await withEnv({ BURACLE_NO_MEMORY: '1' }, () => projectSync('sync', ctxAt(repo), undefined, { adopt: {} }))
    expect(assetsAfterEdit(repo, [md], { nowMs: T0 })).toBeUndefined()
    write(join(repo, '.agents', 'skills', 'deploy', 'SKILL.md'), SKILL)
    await withEnv({ BURACLE_NO_MEMORY: '1' }, () => projectSync('sync', ctxAt(repo), undefined, { auto: true }))
    expect(assetsAfterEdit(repo, [join(repo, '.claude', 'skills', 'deploy', 'SKILL.md')], { nowMs: T0 })).toBeUndefined()
  }))
})

describe('H28 refuses the folders memory never treats as projects', () => {
  test('a scratchpad repository and a Claude Code job folder start nothing and get no context', () => withSandbox(async ({ root, home }) => {
    const r = recorder()
    const scratch = await repoWith(join(root, 'work', 'scratchpad'), { '.agents/skills/deploy/SKILL.md': SKILL, '.claude/rules/x.md': '---\npaths: ["x/**"]\n---\n' })
    expect(startLinkRun(scratch, { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBe(false)
    expect(assetsContext(scratch, 'omp')).toBe('')
    const job = await repoWith(join(home, '.claude', 'jobs', 'abc'), { '.agents/skills/deploy/SKILL.md': SKILL })
    expect(startLinkRun(job, { nowMs: T0, spawn: r.spawn, argv: ARGV })).toBe(false)
    expect(r.calls).toEqual([])
  }))
})

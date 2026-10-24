import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyPlans } from '../../src/engine/txn'
import { MemoryError, write } from '../../src/memory/api'
import { contextText } from '../../src/memory/context'
import { finalize } from '../../src/memory/finalize'
import { brainDir, projectsFile } from '../../src/memory/layout'
import { loadConfigSync, writeRuntimeConfig } from '../../src/engine/config'
import { forgetProject, isNonProjectDir, memoryExcludeConfig, oldVaultDir, projectExclusion, readProjectsCache, repoDisplay, resolveProject, slugExclusion } from '../../src/memory/project'
import { projectInit } from '../../src/memory/project-init'
import { memoryStatusReport } from '../../src/memory/status-report'
import { sessionStart } from '../../src/memory/session-record'
import { appendSpool, readSpool, spoolFiles } from '../../src/memory/spool'
import { listAll, projectRef } from '../../src/memory/store'
import { main } from '../../src/cli/router'
import { agentCtx, git, makeRepo, withBrain } from './helpers'

async function cli(argv: string[]): Promise<{ code: number, out: string, err: string }> {
  let out = ''
  let err = ''
  const code = await main(argv, {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: true, text: async () => '' },
  })
  return { code, out, err }
}

describe('resolveProject', () => {
  test('slug from origin, cached, worktrees unified', async () => {
    await withBrain(async ({ repo, root }) => {
      const p = await resolveProject(join(repo, 'src'))
      expect(p?.slug).toBe('demo')
      expect(p?.scope).toBe('project')
      expect(p?.ownerRepo).toBe('me/demo')
      expect(p?.remote).toBe('github.com/me/demo')
      expect(readProjectsCache().projects['demo']?.roots).toContain(repo)
      const wt = join(root, 'wt-feature')
      git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt)
      expect((await resolveProject(wt))?.slug).toBe('demo')
      expect(readProjectsCache().projects['demo']?.roots).toContain(wt)
    })
  })

  test('two repositories with the same name get owner-repo slugs', async () => {
    await withBrain(async ({ root }) => {
      const a = makeRepo(join(root, 'a', 'tools'), 'git@github.com:alice/tools.git')
      const b = makeRepo(join(root, 'b', 'tools'), 'https://github.com/bob/tools.git')
      expect((await resolveProject(a))?.slug).toBe('tools')
      expect((await resolveProject(b))?.slug).toBe('bob-tools')
      expect((await resolveProject(a))?.slug).toBe('tools')
    })
  })

  test('folders outside git are adhoc; home, the old vault and the brain are not projects', async () => {
    await withBrain(async ({ root, home }) => {
      const dir = join(root, 'scratch notes')
      mkdirSync(dir, { recursive: true })
      const p = await resolveProject(dir)
      expect(p?.scope).toBe('adhoc')
      expect(p?.slug).toMatch(/^scratch-notes-[0-9a-f]{6}$/)
      expect(await resolveProject(home)).toBeUndefined()
      mkdirSync(join(oldVaultDir(), 'projects'), { recursive: true })
      expect(await resolveProject(oldVaultDir())).toBeUndefined()
      mkdirSync(brainDir(), { recursive: true })
      expect(await resolveProject(brainDir())).toBeUndefined()
      expect(isNonProjectDir('/')).toBe(true)
    })
  })

  test('a folder whose other repository is excluded by index.exclude maps to the remaining one', async () => {
    await withBrain(async ({ root, buracleHome }) => {
      const folder = join(root, 'Workspace')
      const app = makeRepo(join(folder, 'app'), '')
      const reference = makeRepo(join(folder, 'reference'), '')
      const before = await resolveProject(folder)
      if (before === undefined) throw new Error('the folder did not resolve')
      expect(before.scope).toBe('adhoc')
      writeFileSync(join(buracleHome, 'config.yaml'), `index:\n  exclude:\n    - ${realpathSync(reference)}\n`)
      const cache = JSON.parse(readFileSync(projectsFile(), 'utf8'))
      cache.projects[before.slug].checkedMs = 0
      writeFileSync(projectsFile(), JSON.stringify(cache))
      const after = await resolveProject(folder)
      expect(after?.slug).toBe('app')
      expect(after?.parents).toEqual([folder])
      expect(after?.merged).toEqual([before.slug])
      expect(readProjectsCache().projects[before.slug]?.roots).toEqual([])
      expect((await resolveProject(app))?.slug).toBe('app')
    })
  })

  test('a forgotten project leaves the cache and every merged list; the folder registers again as new', async () => {
    await withBrain(async ({ repo, root }) => {
      const folder = join(root, 'Workspace')
      makeRepo(join(folder, 'one'), '')
      makeRepo(join(folder, 'two'), '')
      expect((await resolveProject(repo))?.slug).toBe('demo')
      const adhoc = await resolveProject(folder)
      if (adhoc === undefined) throw new Error('the folder did not resolve')
      const cache = JSON.parse(readFileSync(projectsFile(), 'utf8'))
      cache.projects['demo'].merged = [adhoc.slug]
      writeFileSync(projectsFile(), JSON.stringify(cache))
      expect(forgetProject(adhoc.slug)).toBe(true)
      expect(readProjectsCache().projects[adhoc.slug]).toBeUndefined()
      expect(readProjectsCache().projects['demo']?.merged).toBeUndefined()
      expect(forgetProject(adhoc.slug)).toBe(false)
      expect(forgetProject('../demo')).toBe(false)
      expect(readProjectsCache().projects['demo']?.roots).toContain(repo)
      expect(forgetProject('demo')).toBe(true)
      expect(readProjectsCache().projects['demo']).toBeUndefined()
      expect((await resolveProject(repo))?.slug).toBe('demo')
    })
  })

  test('a broken cache is rebuilt instead of failing', async () => {
    await withBrain(async ({ repo }) => {
      mkdirSync(join(projectsFile(), '..'), { recursive: true })
      writeFileSync(projectsFile(), '{ nope')
      expect((await resolveProject(repo))?.slug).toBe('demo')
      expect(JSON.parse(readFileSync(projectsFile(), 'utf8')).v).toBe(1)
    })
  })

  test('repoDisplay strips users and credentials', () => {
    expect(repoDisplay('git@github.com:me/demo.git')).toBe('github.com/me/demo')
    expect(repoDisplay('https://user:tok3n@github.com/me/demo.git')).toBe('github.com/me/demo')
    expect(repoDisplay('ssh://git@host.example:2222/team/repo')).toBe('host.example/team/repo')
  })
})

describe('memory.exclude', () => {
  const exclude = (buracleHome: string, ...patterns: string[]) => {
    mkdirSync(buracleHome, { recursive: true })
    writeFileSync(join(buracleHome, 'config.yaml'), patterns.length === 0 ? 'memory:\n  exclude: []\n' : `memory:\n  exclude:\n${patterns.map(p => `    - '${p}'`).join('\n')}\n`)
  }

  test('a path, a bare name, an owner/repo and a glob keep a project out; its neighbors stay', async () => {
    await withBrain(async ({ repo, root, buracleHome }) => {
      const other = makeRepo(join(root, 'clients', 'acme-app'), 'git@github.com:acme/app.git')
      for (const patterns of [[repo], ['repo'], ['me/demo'], ['ME/*'], [`${root}/**/repo`]]) {
        exclude(buracleHome, ...patterns)
        expect(await resolveProject(join(repo, 'src'))).toBeUndefined()
        expect(await projectExclusion(repo)).toBe(`excluded by memory.exclude (${patterns[0]})`)
        expect((await resolveProject(other))?.slug).toBe('app')
      }
      exclude(buracleHome, 'clients')
      expect(await resolveProject(other)).toBeUndefined()
      expect((await resolveProject(repo))?.slug).toBe('demo')
      expect(await projectExclusion(join(root, 'home'))).toBeUndefined()
    })
  })

  test('a project resolved before is kept out once excluded, worktrees too; projectInit refuses it', async () => {
    await withBrain(async ({ repo, root, buracleHome }) => {
      expect((await resolveProject(repo))?.slug).toBe('demo')
      const wt = join(root, 'wt-feature')
      git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt)
      exclude(buracleHome, repo)
      expect(await resolveProject(repo)).toBeUndefined()
      expect(await resolveProject(wt)).toBeUndefined()
      const fresh = join(root, 'wt-fresh')
      git(repo, 'worktree', 'add', '-q', '-b', 'fresh', fresh)
      expect(await resolveProject(fresh)).toBeUndefined()
      await expect(projectInit(repo)).rejects.toThrow('excluded by memory.exclude')
      exclude(buracleHome)
      expect((await resolveProject(wt))?.slug).toBe('demo')
    })
  })

  test('the start text, the status and memory_write say the project memory is off; the person memory stays', async () => {
    await withBrain(async ({ repo, buracleHome }) => {
      await write(agentCtx(repo), { type: 'preference', title: 'Answer in short paragraphs', summary: 'brevity', body: '' })
      exclude(buracleHome, 'me/demo')
      const text = await contextText({ cwd: repo })
      expect(text).toContain('## Project memory: off for this folder (excluded by memory.exclude (me/demo))')
      expect(text).toContain('Answer in short paragraphs')
      const e = await write(agentCtx(repo), { type: 'decision', title: 'Keep the client code apart', summary: 'x', body: '' }).catch(x => x)
      expect((e as MemoryError).code).toBe('no_project')
      expect((e as MemoryError).message).toContain('excluded by memory.exclude (me/demo)')
      const st = await memoryStatusReport(agentCtx(repo))
      expect(st.excluded).toBe('excluded by memory.exclude (me/demo)')
      expect(st.text).toContain('Project memory off here (excluded by memory.exclude (me/demo))')
      expect((await sessionStart('codex', '0199a213-81c0-7800-8aa1-bbab2a035a90', repo)).skipped).toBe('not-a-project')
    })
  })

  test('a plain folder whose one repository is excluded is kept out with it; a folder of several stays its own project', async () => {
    await withBrain(async ({ root, buracleHome }) => {
      const wrapper = join(root, 'clients', 'beta-wrapper')
      const app = makeRepo(join(wrapper, 'app'), 'git@github.com:beta/app.git')
      for (const pattern of ['beta/*', realpathSync(app)]) {
        exclude(buracleHome, pattern)
        expect(await resolveProject(wrapper)).toBeUndefined()
        expect(await projectExclusion(wrapper)).toBe(`excluded by memory.exclude (${pattern}) for app, the one repository in this folder`)
        expect(Object.values(readProjectsCache().projects).filter(r => r.roots.includes(wrapper) || r.parents?.includes(wrapper))).toEqual([])
      }
      const later = join(root, 'later')
      mkdirSync(later, { recursive: true })
      exclude(buracleHome)
      const adhoc = await resolveProject(later)
      expect(adhoc?.scope).toBe('adhoc')
      makeRepo(join(later, 'client'), 'git@github.com:beta/client.git')
      exclude(buracleHome, 'beta/*')
      expect(await resolveProject(later)).toBeUndefined()
      expect(await slugExclusion(adhoc?.slug as string)).toBe('excluded by memory.exclude (beta/*) for client, the one repository in this folder')
      const several = join(root, 'several')
      makeRepo(join(several, 'app'), 'git@github.com:beta/app2.git')
      makeRepo(join(several, 'tool'), 'git@github.com:gamma/tool.git')
      const folder = await resolveProject(several)
      expect(folder?.scope).toBe('adhoc')
      expect(await projectExclusion(several)).toBeUndefined()
      expect(await resolveProject(join(several, 'app'))).toBeUndefined()
      expect((await resolveProject(join(several, 'tool')))?.slug).toBe('tool')
      expect(Object.values(readProjectsCache().projects).some(r => r.ownerRepo === 'beta/app2')).toBe(false)
    })
  })

  test('a config.yaml that stops reading keeps the last good memory.exclude in force and says so', async () => {
    await withBrain(async ({ repo, buracleHome }) => {
      await write(agentCtx(repo), { type: 'preference', title: 'Answer in short paragraphs', summary: 'brevity', body: '' })
      exclude(buracleHome, 'me/demo')
      await writeRuntimeConfig(loadConfigSync().config)
      const file = join(buracleHome, 'config.yaml')
      writeFileSync(file, 'memory:\n  exclude: [me/demo, other\nindex: {}\n')
      expect(memoryExcludeConfig().problem).toStartWith('invalid YAML')
      expect(await resolveProject(repo)).toBeUndefined()
      expect(await projectExclusion(repo)).toBe('excluded by memory.exclude (me/demo)')
      const note = /memory\.exclude may be unreadable \([^()]*config\.yaml: invalid YAML[^\n]*\); the projects of the last good list stay out until the file reads cleanly/
      const text = await contextText({ cwd: repo })
      expect(text).toMatch(new RegExp(`Memory config: ${note.source}\\. Only the user can fix the file; tell them\\.`))
      expect(text).toContain('Answer in short paragraphs')
      const st = await memoryStatusReport(agentCtx(repo))
      expect(st.excludeProblem).toStartWith('invalid YAML')
      expect(st.text).toMatch(new RegExp(`  config: ${note.source}; fix the file by hand`))
      const e = await write(agentCtx(repo), { type: 'decision', title: 'Keep the client code apart', summary: 'x', body: '' }).catch(x => x)
      expect((e as MemoryError).code).toBe('no_project')
      writeFileSync(file, 'memory:\n  exclude: 7\n')
      expect(memoryExcludeConfig()).toEqual({ patterns: ['me/demo'], problem: expect.stringMatching(/^memory\.exclude: /) })
      writeFileSync(file, 'memory:\n  exclude: [acme/*]\nmemroy: {}\n')
      expect(memoryExcludeConfig()).toEqual({ patterns: ['acme/*'] })
      expect((await resolveProject(repo))?.slug).toBe('demo')
      expect(await contextText({ cwd: repo })).not.toContain('Memory config:')
    })
  })

  test('mem import --project refuses a project memory.exclude keeps out', async () => {
    await withBrain(async ({ repo, root, buracleHome }) => {
      await write(agentCtx(repo), { type: 'reference', title: 'The runbook is in the wiki', summary: 'ops wiki', body: '' })
      const file = join(root, 'demo.jsonl')
      expect((await cli(['mem', 'export', '--cwd', repo, '--out', file])).code).toBe(0)
      const other = makeRepo(join(root, 'other'), 'git@github.com:acme/other.git')
      expect((await resolveProject(other))?.slug).toBe('other')
      exclude(buracleHome, 'acme/*')
      const r = await cli(['mem', 'import', file, '--cwd', root, '--project', 'other'])
      expect(r.code).toBe(2)
      expect(r.err).toContain('the project other is excluded by memory.exclude (acme/*); nothing was imported')
      expect(await listAll(projectRef('other'))).toEqual([])
    })
  })

  test('a session started before the exclusion leaves no session memory', async () => {
    await withBrain(async ({ repo, buracleHome }) => {
      const sid = '0199a213-81c0-7800-8aa1-bbab2a035a91'
      expect((await sessionStart('codex', sid, repo)).slug).toBe('demo')
      appendSpool('codex', sid, [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: 'Changed the client code.' }])
      expect(spoolFiles('codex', sid).active).toHaveLength(1)
      exclude(buracleHome, repo)
      const r = await finalize('codex', sid)
      expect(r.memoryId).toBeUndefined()
      expect((await listAll(projectRef('demo'))).filter(i => i.kind === 'session')).toEqual([])
      expect(spoolFiles('codex', sid)).toEqual({ active: [], done: [] })
    })
  })

  test('a session that starts in an excluded folder records no prompt, reply, command or file path', async () => {
    await withBrain(async ({ repo, home, buracleHome }) => {
      exclude(buracleHome, repo)
      const sid = '0199a213-81c0-7800-8aa1-bbab2a035a92'
      expect(await sessionStart('claude', sid, repo)).toEqual({ skipped: 'not-a-project' })
      const entries = [
        { ts: Date.now(), ev: 'prompt' as const, excerpt: 'Draft the acquisition term sheet for Acme' },
        { ts: Date.now() + 1, ev: 'tool' as const, tool: 'Bash', cmd: 'git push origin main' },
        { ts: Date.now() + 2, ev: 'stop' as const, excerpt: 'Drafted the term sheet.' },
      ]
      appendSpool('claude', sid, entries)
      expect(spoolFiles('claude', sid)).toEqual({ active: [], done: [] })
      expect(readSpool('claude', sid)).toEqual([])
      const other = '0199a213-81c0-7800-8aa1-bbab2a035a93'
      expect((await sessionStart('claude', other, home)).skipped).toBe('not-a-project')
      appendSpool('claude', other, entries)
      expect(spoolFiles('claude', other).active).toHaveLength(1)
      exclude(buracleHome)
      const late = '0199a213-81c0-7800-8aa1-bbab2a035a94'
      expect((await sessionStart('claude', late, repo)).slug).toBe('demo')
      appendSpool('claude', late, entries)
      expect(spoolFiles('claude', late).active).toHaveLength(1)
    })
  })
})

describe('projectInit', () => {
  test('maps the folder to its project and writes no memory: the core pages are no longer created', async () => {
    await withBrain(async ({ repo }) => {
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'bun test', build: 'bun build' } }))
      const r = await projectInit(repo)
      expect(r.slug).toBe('demo')
      expect(r.scope).toBe('project')
      expect(r).not.toHaveProperty('core')
      expect(await listAll(projectRef('demo'))).toEqual([])
      expect((await projectInit(repo)).slug).toBe('demo')
    })
  })

  test('takes back the autoMemoryDirectory an older Buracle wrote, and keeps a value the user set', async () => {
    await withBrain(async ({ repo, root }) => {
      const settings = join(repo, '.claude', 'settings.local.json')
      await applyPlans([{ id: 'memory-project-demo', harness: 'claude', ops: [{ kind: 'json-merge', path: settings, set: { autoMemoryDirectory: '/old/vault/projects/demo/claude' }, owner: 'memory' }] }])
      expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ autoMemoryDirectory: '/old/vault/projects/demo/claude' })
      expect((await projectInit(repo)).claudeRedirect).toBe('removed')
      expect(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8'))['autoMemoryDirectory'] : undefined).toBeUndefined()
      const other = makeRepo(join(root, 'other'), 'git@github.com:me/other.git')
      const theirs = join(other, '.claude', 'settings.local.json')
      mkdirSync(join(other, '.claude'), { recursive: true })
      writeFileSync(theirs, JSON.stringify({ autoMemoryDirectory: '/mine' }))
      expect((await projectInit(other)).claudeRedirect).toBe('none')
      expect(JSON.parse(readFileSync(theirs, 'utf8'))['autoMemoryDirectory']).toBe('/mine')
    })
  })

  test('refuses the home directory', async () => {
    await withBrain(async ({ home }) => {
      await expect(projectInit(home)).rejects.toThrow('not a project directory')
      expect(existsSync(join(home, '.claude', 'settings.local.json'))).toBe(false)
    })
  })
})

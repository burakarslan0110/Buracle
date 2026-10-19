import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterContext } from '../../src/adapters/registry'
import { run as buildRun } from '../../src/cli/commands/build'
import { createContext, dispatchHook, loadAdapter } from '../../src/cli/commands/hook'
import { HOOK_DATA_REL, hookBundle, hookData, readHookData, renderHookData } from '../../src/cli/hook-data'
import { catalogMcp, catalogSkills, type CanonicalBundle } from '../../src/core/catalog'
import { pathRuleIndex } from '../../src/core/policy/path-rules'
import type { Harness } from '../../src/core/events'
import { loadCanonicalSync } from '../../src/engine/canonical'
import * as paths from '../../src/engine/paths'
import { MANIFEST_REL } from '../../src/engine/update/build'
import { KEEPS_MODES } from '../helpers/fake-exe'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { git } from '../memory/helpers'
import { fakeAdapter, makeRepo, memoryIO, withDeps } from './ops/helpers'

const REPO = join(import.meta.dir, '..', '..')
const full = loadCanonicalSync(join(REPO, 'canonical'))

function counting(bundle: CanonicalBundle): { load: (root: string) => CanonicalBundle, calls: string[] } {
  const calls: string[] = []
  return { calls, load: root => { calls.push(root); return bundle } }
}

describe('hookBundle', () => {
  test('serves every field the command hooks read from the snapshot, equal to the full tree, without loading canonical/', () => {
    const { load, calls } = counting(full)
    const b = hookBundle(REPO, load)
    expect(b.root).toBe(join(REPO, 'canonical'))
    expect(b.mcp).toEqual(full.mcp)
    expect(b.plugins).toEqual(full.plugins)
    expect(b.tools).toEqual(full.tools)
    expect(b.routing).toEqual(full.routing)
    expect(b.missing).toEqual(full.missing)
    expect(b.warnings).toEqual(full.warnings)
    expect(b.skills.map(s => ({ id: s.id, dir: s.dir, frontmatter: s.frontmatter, triggers: s.triggers }))).toEqual(full.skills.map(s => ({ id: s.id, dir: s.dir, frontmatter: s.frontmatter, triggers: s.triggers })))
    expect(b.agents.map(a => ({ id: a.id, file: a.file, frontmatter: a.frontmatter }))).toEqual(full.agents.map(a => ({ id: a.id, file: a.file, frontmatter: a.frontmatter })))
    expect(catalogSkills(b.skills)).toEqual(catalogSkills(full.skills))
    for (const h of ['claude', 'codex'] as Harness[]) expect(catalogMcp(b.mcp, h)).toEqual(catalogMcp(full.mcp, h))
    expect(b.skills.some(s => s.triggers !== undefined)).toBe(true)
    expect(b.routing.categories.some(c => c.triggers !== undefined)).toBe(true)
    expect(b.agents.filter(a => a.frontmatter['output'] === 'json').map(a => a.id)).toEqual(full.agents.filter(a => a.frontmatter['output'] === 'json').map(a => a.id))
    expect(b.rules.map(r => ({ id: r.id, scope: r.scope, file: r.file, frontmatter: r.frontmatter }))).toEqual(full.rules.map(r => ({ id: r.id, scope: r.scope, file: r.file, frontmatter: r.frontmatter })))
    expect(pathRuleIndex(b.rules)).toEqual(pathRuleIndex(full.rules))
    expect(pathRuleIndex(b.rules).map(r => r.id)).toContain('mobile')
    expect(calls).toEqual([])
  })

  test('a field outside the snapshot loads the full tree once, on first access, and holds what canonical/ holds', () => {
    const { load, calls } = counting(full)
    const b = hookBundle(REPO, load)
    expect(b.hooks).toEqual(full.hooks)
    expect(calls).toEqual([join(REPO, 'canonical')])
    expect(b.rules.find(r => r.id === 'core')?.body).toBe(full.rules.find(r => r.id === 'core')?.body)
    expect(b.config).toEqual(full.config)
    expect(b.statusline).toEqual(full.statusline)
    expect(b.pricing).toEqual(full.pricing)
    expect(b.triggers).toEqual(full.triggers)
    const spec = b.skills.find(s => s.id === 'plan-build')
    expect(spec?.body).toBe(full.skills.find(s => s.id === 'plan-build')?.body)
    expect(spec?.files).toEqual(full.skills.find(s => s.id === 'plan-build')?.files)
    const agent = b.agents[0]
    expect(agent?.body).toBe(full.agents.find(a => a.id === agent?.id)?.body)
    expect(calls.length).toBe(1)
    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(full)))
  })

  test('without a valid snapshot the bundle comes from canonical/; a snapshot naming a skill canonical/ lacks fails on reading it', () => withSandbox(({ root }) => {
    const repo = join(root, 'checkout')
    const file = join(repo, HOOK_DATA_REL)
    mkdirSync(join(repo, 'harness'), { recursive: true })
    const sentinel = { root: 'sentinel' } as unknown as CanonicalBundle
    const fallsBack = (): boolean => { const { load, calls } = counting(sentinel); return hookBundle(repo, load) === sentinel && calls.length === 1 }
    expect(fallsBack()).toBe(true)
    writeFileSync(file, '{')
    expect(fallsBack()).toBe(true)
    writeFileSync(file, JSON.stringify({ ...hookData(full), v: 2 }))
    expect(fallsBack()).toBe(true)
    writeFileSync(file, JSON.stringify({ ...hookData(full), skills: [{ id: 'plan-build', dir: 'skills/plan-build' }] }))
    expect(fallsBack()).toBe(true)
    writeFileSync(file, JSON.stringify({ ...hookData(full), routing: { strictness: 'enforce' } }))
    expect(fallsBack()).toBe(true)
    expect(readHookData(repo)).toBeUndefined()

    const data = hookData(full)
    writeFileSync(file, JSON.stringify({ ...data, skills: [...data.skills, { id: 'gone', dir: 'skills/gone', frontmatter: {} }] }))
    const { load } = counting(full)
    const b = hookBundle(repo, load)
    expect(b.skills.map(s => s.id)).toContain('gone')
    expect(() => b.skills.find(s => s.id === 'gone')?.body).toThrow('run `buracle build`')
  }))

  test('a hook context serves its canonical bundle from the snapshot', () => withSandbox(() => {
    const c = createContext()
    expect(c.canonical).toBe(c.canonical)
    expect(c.canonical.mcp).toEqual(full.mcp)
    expect(Object.getOwnPropertyDescriptor(c.canonical, 'hooks')?.get).toBeDefined()
    expect(Object.getOwnPropertyDescriptor(c.canonical.rules[0] ?? {}, 'body')?.get).toBeDefined()
  }))
})

describe('the hooks answer the same from the snapshot as from canonical/', () => {
  const sid = (h: Harness) => (h === 'codex' ? '019a0000-0000-7000-8000-00000000c0de' : '5d1c2a8e-1111-4c2b-9a77-00000000c0de')
  const cases: Array<{ harness: Harness, event: string, payload: Record<string, unknown> }> = [
    { harness: 'claude', event: 'SessionStart', payload: { source: 'startup', model: 'claude-opus-5-5' } },
    { harness: 'claude', event: 'UserPromptSubmit', payload: { prompt: 'why did we decide to use yaml last time? compare zod and valibot for the config schema', permission_mode: 'bypassPermissions' } },
    { harness: 'claude', event: 'UserPromptSubmit', payload: { prompt: 'please run the plan-build workflow for a health endpoint', permission_mode: 'bypassPermissions' } },
    { harness: 'claude', event: 'PreToolUse', payload: { tool_name: 'WebSearch', tool_input: { query: 'bun release notes' }, tool_use_id: 't1' } },
    { harness: 'codex', event: 'SessionStart', payload: { source: 'startup' } },
    { harness: 'codex', event: 'UserPromptSubmit', payload: { prompt: 'why did we decide to use yaml last time? compare zod and valibot for the config schema', turn_id: 'turn-1' } },
    { harness: 'codex', event: 'PreToolUse', payload: { tool_name: 'mcp__semble__search', tool_input: { query: 'where is the config parsed' }, tool_use_id: 'c1', turn_id: 'turn-1' } },
    { harness: 'codex', event: 'PreToolUse', payload: { tool_name: 'Bash', tool_input: { command: 'grep -rn parseConfig src' }, tool_use_id: 'c2', turn_id: 'turn-1' } },
    { harness: 'codex', event: 'PreToolUse', payload: { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: cmd/main.go\n+package main\n*** End Patch' }, tool_use_id: 'c3', turn_id: 'turn-1' } },
  ]

  async function answer(root: string, tag: string, c: typeof cases[number], context: (ctx: AdapterContext) => AdapterContext): Promise<{ stdout: string, exitCode: number }> {
    const home = join(root, tag)
    mkdirSync(join(home, '.buracle', 'rules', 'paths'), { recursive: true })
    writeFileSync(join(home, '.buracle', 'rules', 'paths', 'go.md'), '# Go\n\n- gofmt every file.\n')
    return withEnv({ HOME: home, BURACLE_HOME: join(home, '.buracle') }, () => {
      const stdin = JSON.stringify({ session_id: sid(c.harness), transcript_path: null, cwd: join(root, 'project'), hook_event_name: c.event, ...(c.harness === 'codex' ? { model: 'gpt-5.5', permission_mode: 'bypassPermissions' } : {}), ...c.payload })
      return dispatchHook(c.harness, c.event, stdin, { loadAdapter, loadContext: () => context(createContext()) })
    })
  }

  for (const c of cases) {
    test(`${c.harness} ${c.event}${typeof c.payload['prompt'] === 'string' ? ` "${String(c.payload['prompt']).slice(0, 32)}..."` : typeof c.payload['tool_name'] === 'string' ? ` ${String(c.payload['tool_name'])}` : ''}`, () => withSandbox(async ({ root }) => {
      const project = join(root, 'project')
      mkdirSync(join(project, 'src'), { recursive: true })
      writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { zod: '3.0.0', valibot: '1.0.0', yaml: '2.9.1' } }) + '\n')
      writeFileSync(join(project, 'src', 'config.ts'), 'export function parseConfig(text: string) { return text }\n')
      git(project, 'init', '-q')
      const fromSnapshot = await answer(root, 'snapshot', c, ctx => ctx)
      const fromTree = await answer(root, 'tree', c, ctx => ({ repoRoot: ctx.repoRoot, config: ctx.config, paths: ctx.paths, buracleBin: ctx.buracleBin, canonical: loadCanonicalSync(join(ctx.repoRoot, 'canonical')) }))
      expect(fromSnapshot).toEqual(fromTree)
      if (c.payload['tool_use_id'] === 'c3') {
        expect(fromSnapshot.stdout).toContain('matches the path rule `go`')
        expect(fromSnapshot.stdout).toContain('gofmt every file.')
      }
    }), 30_000)
  }
})

describe('buracle build', () => {
  test('writes the snapshot; --check reports it missing, changed or with the wrong mode; a broken tree is reported once', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const file = join(repo, HOOK_DATA_REL)
    await withDeps({ repoRoot: () => repo, adapters: async () => [fakeAdapter('claude', { build: () => [{ path: 'x.md', content: 'x\n' }] })] }, async () => {
      const check = memoryIO({ json: true })
      expect(await buildRun(['--check', '--json'], check)).toBe(1)
      expect((JSON.parse(check.out()) as { drift: unknown[] }).drift).toContainEqual({ path: HOOK_DATA_REL, kind: 'missing', by: 'hook-data' })

      const w = memoryIO({ json: true })
      expect(await buildRun(['--json'], w)).toBe(0)
      expect((JSON.parse(w.out()) as { written: string[] }).written).toContain(HOOK_DATA_REL)
      expect(readFileSync(file, 'utf8')).toBe(renderHookData(loadCanonicalSync(join(repo, 'canonical'))))
      const clean = memoryIO({ json: true })
      expect(await buildRun(['--check', '--json'], clean)).toBe(0)
      expect(JSON.parse(clean.out())).toMatchObject({ ok: true, drift: [] })

      const mcp = join(repo, 'canonical', 'mcp.yaml')
      writeFileSync(mcp, readFileSync(mcp, 'utf8').replace('Up-to-date library and framework documentation', 'Library documentation'))
      const changed = memoryIO({ json: true })
      expect(await buildRun(['--check', '--json'], changed)).toBe(1)
      expect((JSON.parse(changed.out()) as { drift: unknown[] }).drift).toEqual([{ path: HOOK_DATA_REL, kind: 'changed', by: 'hook-data' }, { path: MANIFEST_REL, kind: 'manifest' }])
      expect(await buildRun([], memoryIO())).toBe(0)
      expect(readHookData(repo)?.mcp.servers['context7']?.description).toBe('Library documentation')

      // A mode can drift only where the file system keeps one.
      if (KEEPS_MODES) {
        chmodSync(file, 0o755)
        const mode = memoryIO({ json: true })
        expect(await buildRun(['--check', '--json'], mode)).toBe(1)
        expect((JSON.parse(mode.out()) as { drift: unknown[] }).drift).toEqual([{ path: HOOK_DATA_REL, kind: 'mode', by: 'hook-data' }])
      }

      writeFileSync(mcp, 'servers: [')
      const broken = memoryIO({ json: true })
      expect(await buildRun(['--json'], broken)).toBe(1)
      const report = JSON.parse(broken.out()) as { errors: Array<{ source: string }> }
      expect(report.errors.map(e => e.source)).toEqual(['canonical'])
    })
    expect(paths.repoRoot()).toBe(REPO)
  }))
})

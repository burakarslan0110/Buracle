import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, posix, relative, win32 } from 'node:path'
import { run as buildRun } from '../../../src/cli/commands/build'
import { MANIFEST_REL, normalizeOutputPath, runBuild, type BuildOptions } from '../../../src/engine/update/build'
import { KEEPS_MODES } from '../../helpers/fake-exe'
import { withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, makeRepo, memoryIO, withDeps } from './helpers'

const REGISTRY = { commands: [{ name: 'demo', summary: 'Demo command <x>', usage: 'Usage: buracle demo' }], exitCodes: { ok: 0, error: 1, partial: 2 } }

function opts(repo: string, over: Partial<BuildOptions> = {}): BuildOptions {
  return { repoRoot: repo, check: false, adapters: [], commands: REGISTRY, sharedSkills: false, hookData: false, ...over }
}

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('runBuild', () => {
  test('writes adapter output under harness/, records the manifest, and is idempotent', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const claude = fakeAdapter('claude', {
      build: () => [
        { path: 'hooks/hooks.json', content: '{"hooks":{}}\n' },
        { path: 'harness/claude/bin/buracle-hook', content: '#!/bin/sh\n', mode: 0o755 },
        { path: join(repo, 'harness', 'claude', 'abs.txt'), content: 'abs\n' },
      ],
    })
    const codex = fakeAdapter('codex', { build: () => [{ path: 'harness/agents-skills/plan-build/SKILL.md', content: '# spec\n' }, { path: 'config.toml', content: 'a = 1\n' }] })
    const r = await runBuild(opts(repo, { adapters: [claude, codex] }))
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.producers).toEqual(['claude', 'codex', 'docs'])
    expect(read(join(repo, 'harness/claude/hooks/hooks.json'))).toBe('{"hooks":{}}\n')
    if (KEEPS_MODES) expect(statSync(join(repo, 'harness/claude/bin/buracle-hook')).mode & 0o111).not.toBe(0)
    expect(read(join(repo, 'harness/claude/abs.txt'))).toBe('abs\n')
    expect(read(join(repo, 'harness/agents-skills/plan-build/SKILL.md'))).toBe('# spec\n')
    expect(read(join(repo, 'harness/codex/config.toml'))).toBe('a = 1\n')
    for (const d of ['hooks', 'cli', 'config', 'statusline', 'plan-format', 'install']) expect(existsSync(join(repo, 'docs/reference', `${d}.md`))).toBe(true)
    const manifest = JSON.parse(read(join(repo, MANIFEST_REL))) as { files: Record<string, { by: string, exec: boolean }> }
    expect(Object.keys(manifest.files)).toContain('harness/agents-skills/plan-build/SKILL.md')
    expect(manifest.files['harness/claude/bin/buracle-hook']).toMatchObject({ by: 'claude', exec: true })
    expect(manifest.files['docs/reference/cli.md']).toBeUndefined()
    expect(Object.keys(manifest.files)).toEqual([...Object.keys(manifest.files)].sort())

    const before = read(join(repo, MANIFEST_REL))
    const again = await runBuild(opts(repo, { adapters: [claude, codex] }))
    expect(again.written).toEqual([])
    expect(again.unchanged).toBe(again.generated)
    expect(read(join(repo, MANIFEST_REL))).toBe(before)
    const check = await runBuild(opts(repo, { adapters: [claude, codex], check: true }))
    expect(check).toMatchObject({ ok: true, drift: [], errors: [] })
  }))

  test('removes only stale files listed in the manifest and prunes empty directories', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    let files = [{ path: 'skills/a/SKILL.md', content: 'a\n' }, { path: 'skills/b/SKILL.md', content: 'b\n' }]
    const claude = fakeAdapter('claude', { build: () => files })
    await runBuild(opts(repo, { adapters: [claude] }))
    mkdirSync(join(repo, 'harness/claude/.claude-plugin/types'), { recursive: true })
    writeFileSync(join(repo, 'harness/claude/.claude-plugin/types/x.d.ts'), 'x')
    files = [{ path: 'skills/a/SKILL.md', content: 'a\n' }]
    const r = await runBuild(opts(repo, { adapters: [claude] }))
    expect(r.removed).toEqual(['harness/claude/skills/b/SKILL.md'])
    expect(existsSync(join(repo, 'harness/claude/skills/b'))).toBe(false)
    expect(existsSync(join(repo, 'harness/claude/skills/a/SKILL.md'))).toBe(true)
    expect(existsSync(join(repo, 'harness/claude/.claude-plugin/types/x.d.ts'))).toBe(true)
  }))

  test('--check reports changed, missing, stale and mode drift without writing', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    let files: Array<{ path: string, content: string, mode?: number }> = [
      { path: 'a.txt', content: 'a\n' }, { path: 'b.txt', content: 'b\n' }, { path: 'c.sh', content: 'c\n', mode: 0o755 }, { path: 'd.txt', content: 'd\n' },
    ]
    const omp = fakeAdapter('omp', { build: () => files })
    await runBuild(opts(repo, { adapters: [omp] }))
    writeFileSync(join(repo, 'harness/omp/a.txt'), 'edited by hand\n')
    chmodSync(join(repo, 'harness/omp/c.sh'), 0o644)
    files = [{ path: 'a.txt', content: 'a\n' }, { path: 'c.sh', content: 'c\n', mode: 0o755 }, { path: 'd.txt', content: 'd\n' }, { path: 'e.txt', content: 'e\n' }]
    const r = await runBuild(opts(repo, { adapters: [omp], check: true }))
    expect(r.ok).toBe(false)
    expect(r.drift).toEqual([
      { path: 'harness/omp/a.txt', kind: 'changed', by: 'omp' },
      // Windows reads an executable bit only from the git index, and this repo's index does not track c.sh.
      ...(KEEPS_MODES ? [{ path: 'harness/omp/c.sh', kind: 'mode' as const, by: 'omp' }] : []),
      { path: 'harness/omp/e.txt', kind: 'missing', by: 'omp' },
      { path: 'harness/omp/b.txt', kind: 'stale', by: 'omp' },
      { path: MANIFEST_REL, kind: 'manifest' },
    ])
    expect(read(join(repo, 'harness/omp/a.txt'))).toBe('edited by hand\n')
    expect(existsSync(join(repo, 'harness/omp/b.txt'))).toBe(true)
    expect(existsSync(join(repo, 'harness/omp/e.txt'))).toBe(false)
  }))

  test('an adapter that fails keeps its previous files and manifest entries; others are written', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    let broken = false
    const codex = fakeAdapter('codex', { build: () => { if (broken) throw new Error('not implemented: build'); return [{ path: 'x.txt', content: 'x\n' }] } })
    const omp = fakeAdapter('omp', { build: () => [{ path: 'y.txt', content: broken ? 'y2\n' : 'y\n' }] })
    await runBuild(opts(repo, { adapters: [codex, omp] }))
    broken = true
    const r = await runBuild(opts(repo, { adapters: [codex, omp] }))
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual([{ source: 'codex', error: 'not implemented: build' }])
    expect(read(join(repo, 'harness/codex/x.txt'))).toBe('x\n')
    expect(read(join(repo, 'harness/omp/y.txt'))).toBe('y2\n')
    const manifest = JSON.parse(read(join(repo, MANIFEST_REL))) as { files: Record<string, unknown> }
    expect(Object.keys(manifest.files)).toContain('harness/codex/x.txt')
  }))

  test('an absolute output path is native: on Windows it may use backslashes, a path inside the tree may not', () => {
    const repo = 'C:\\work\\buracle'
    expect(normalizeOutputPath('C:\\work\\buracle\\.claude-plugin\\marketplace.json', 'claude', repo, win32)).toEqual({ rel: '.claude-plugin/marketplace.json' })
    expect(normalizeOutputPath('C:\\work\\buracle\\harness\\claude\\abs.txt', 'claude', repo, win32)).toEqual({ rel: 'harness/claude/abs.txt' })
    expect('error' in normalizeOutputPath('harness\\claude\\x', 'claude', repo, win32)).toBe(true)
    expect('error' in normalizeOutputPath('C:\\elsewhere\\x', 'claude', repo, win32)).toBe(true)
    expect('error' in normalizeOutputPath('/repo/harness/claude/a\\b', 'claude', '/repo', posix)).toBe(true)
  })

  test('rejects unsafe paths, foreign trees, machine-specific content and conflicting duplicates', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    expect('error' in normalizeOutputPath('../escape', 'claude', repo)).toBe(true)
    expect('error' in normalizeOutputPath('../../../etc/passwd', 'claude', repo)).toBe(true)
    expect('error' in normalizeOutputPath('harness/codex/x', 'claude', repo)).toBe(true)
    expect('error' in normalizeOutputPath('harness/.manifest.json', 'codex', repo)).toBe(true)
    expect('error' in normalizeOutputPath('/etc/passwd', 'claude', repo)).toBe(true)
    expect(normalizeOutputPath('.claude-plugin/plugin.json', 'claude', repo)).toEqual({ rel: 'harness/claude/.claude-plugin/plugin.json' })
    expect(normalizeOutputPath(join(repo, '.claude-plugin/marketplace.json'), 'claude', repo)).toEqual({ rel: '.claude-plugin/marketplace.json' })
    expect('error' in normalizeOutputPath(join(repo, '.claude-plugin/marketplace.json'), 'codex', repo)).toBe(true)
    expect(normalizeOutputPath('../agents-skills/s/SKILL.md', 'codex', repo)).toEqual({ rel: 'harness/agents-skills/s/SKILL.md' })
    expect(normalizeOutputPath('./skills//a.md', 'opencode', repo)).toEqual({ rel: 'harness/opencode/skills/a.md' })

    const leaky = fakeAdapter('claude', { build: () => [{ path: 'mcp.json', content: JSON.stringify({ cmd: join(home, '.buracle/bin/buracle') }) }] })
    const r = await runBuild(opts(repo, { adapters: [leaky] }))
    expect(r.errors[0]?.error).toContain('machine-specific absolute path')
    expect(existsSync(join(repo, 'harness/claude/mcp.json'))).toBe(false)
    const quoted = await runBuild(opts(repo, { adapters: [fakeAdapter('omp', { build: () => [{ path: 'a.json', content: `{"home":"${home}"}` }] })] }))
    expect(quoted.errors[0]?.error).toContain('machine-specific absolute path')
    const similar = await runBuild(opts(repo, { adapters: [fakeAdapter('omp', { build: () => [{ path: 'b.txt', content: `${home}-like and x${home}/y` }] })] }))
    expect(similar.errors).toEqual([])

    const a = fakeAdapter('codex', { build: () => [{ path: 'harness/agents-skills/s/SKILL.md', content: 'one\n' }] })
    const b = fakeAdapter('opencode', { build: () => [{ path: 'harness/agents-skills/s/SKILL.md', content: 'two\n' }] })
    const d = await runBuild(opts(repo, { adapters: [a, b] }))
    expect(d.errors.map(e => e.source).sort()).toEqual(['opencode'])
    expect(d.errors[0]?.error).toContain('also generated by codex')
    expect(existsSync(join(repo, 'harness/agents-skills/s/SKILL.md'))).toBe(false)
  }))

  test('--harness limits the adapters; the other producers keep their manifest entries', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const claude = fakeAdapter('claude', { build: () => [{ path: 'c.txt', content: 'c\n' }] })
    const omp = fakeAdapter('omp', { build: () => [{ path: 'o.txt', content: 'o\n' }] })
    await runBuild(opts(repo, { adapters: [claude, omp] }))
    const r = await runBuild(opts(repo, { adapters: [claude, omp], harnesses: ['omp'] }))
    expect(claude.calls.filter(c => c === 'build').length).toBe(1)
    expect(r.producers).toEqual(['docs', 'omp'])
    const manifest = JSON.parse(read(join(repo, MANIFEST_REL))) as { files: Record<string, unknown> }
    expect(Object.keys(manifest.files)).toContain('harness/claude/c.txt')
  }))

  test('the shared Agent Skills render is its own producer, scoped to Codex/OpenCode/omp builds', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    let files = [{ path: 'plan-build/SKILL.md', content: '# spec\n' }, { path: 'plan-build/scripts/run.sh', content: '#!/bin/sh\n', mode: 0o755 }, { path: 'old/SKILL.md', content: 'old\n' }]
    const sharedSkills = () => files
    const r = await runBuild(opts(repo, { sharedSkills }))
    expect(r.producers).toEqual(['agents-skills', 'docs'])
    expect(read(join(repo, 'harness/agents-skills/plan-build/SKILL.md'))).toBe('# spec\n')
    if (KEEPS_MODES) expect(statSync(join(repo, 'harness/agents-skills/plan-build/scripts/run.sh')).mode & 0o111).not.toBe(0)
    files = files.filter(f => !f.path.startsWith('old/'))
    const claudeOnly = await runBuild(opts(repo, { sharedSkills, harnesses: ['claude'] }))
    expect(claudeOnly.producers).toEqual(['docs'])
    expect(existsSync(join(repo, 'harness/agents-skills/old/SKILL.md'))).toBe(true)
    const codex = await runBuild(opts(repo, { sharedSkills, harnesses: ['codex'] }))
    expect(codex.removed).toEqual(['harness/agents-skills/old/SKILL.md'])
    const bad = await runBuild(opts(repo, { sharedSkills: () => [{ path: '../../etc/x', content: '' }] }))
    expect(bad.errors[0]).toMatchObject({ source: 'agents-skills' })
    expect(existsSync(join(repo, 'harness/agents-skills/plan-build/SKILL.md'))).toBe(true)
  }))

  test('the command hooks\' snapshot (harness/hook-data.json) is a producer of its own: listed in the manifest, drift-checked, built for every --harness scope', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const snapshot = 'harness/hook-data.json'
    let content = '{"v":1}\n'
    const seen: string[] = []
    const hookData = (canonical: { mcp: { servers: Record<string, unknown> } }) => {
      seen.push(`hook-data:${Object.keys(canonical.mcp.servers).length}`)
      return { path: snapshot, content }
    }
    const omp = fakeAdapter('omp', { build: ctx => { seen.push('omp'); ctx.canonical.mcp.servers = {}; return [{ path: 'o.txt', content: 'o\n' }] } })
    const r = await runBuild(opts(repo, { adapters: [omp], hookData }))
    expect(r.errors).toEqual([])
    expect(r.producers).toEqual(['docs', 'hook-data', 'omp'])
    expect(seen[0]).toMatch(/^hook-data:[1-9]/)
    expect(seen[1]).toBe('omp')
    expect(read(join(repo, snapshot))).toBe('{"v":1}\n')
    expect(statSync(join(repo, snapshot)).mode & 0o111).toBe(0)
    const manifest = () => JSON.parse(read(join(repo, MANIFEST_REL))) as { files: Record<string, { by: string, exec: boolean }> }
    expect(manifest().files[snapshot]).toMatchObject({ by: 'hook-data', exec: false })
    expect(await runBuild(opts(repo, { adapters: [omp], hookData, check: true }))).toMatchObject({ ok: true, drift: [] })

    content = '{"v":1,"changed":true}\n'
    const check = await runBuild(opts(repo, { adapters: [omp], hookData, check: true, harnesses: ['omp'] }))
    expect(check.drift).toEqual([{ path: snapshot, kind: 'changed', by: 'hook-data' }, { path: MANIFEST_REL, kind: 'manifest' }])
    const scoped = await runBuild(opts(repo, { adapters: [omp], hookData, harnesses: ['claude'] }))
    expect(scoped.producers).toEqual(['docs', 'hook-data'])
    expect(scoped.written).toEqual([snapshot])
    expect(read(join(repo, snapshot))).toBe(content)
    if (KEEPS_MODES) {
      chmodSync(join(repo, snapshot), 0o755)
      expect((await runBuild(opts(repo, { adapters: [omp], hookData, check: true }))).drift).toEqual([{ path: snapshot, kind: 'mode', by: 'hook-data' }])
    }

    for (const bad of [() => { throw new Error('boom') }, () => ({ path: 'harness/codex/hook-data.json', content: '{}' }), () => ({ path: MANIFEST_REL, content: '{}' })]) {
      const failed = await runBuild(opts(repo, { hookData: bad }))
      expect(failed.errors.map(e => e.source)).toEqual(['hook-data'])
      expect(failed.producers).toEqual(['docs'])
      expect(read(join(repo, snapshot))).toBe(content)
      expect(manifest().files[snapshot]).toMatchObject({ by: 'hook-data' })
    }
    expect(existsSync(join(repo, 'harness/codex/hook-data.json'))).toBe(false)
    await runBuild(opts(repo))
    expect(existsSync(join(repo, snapshot))).toBe(true)
  }))

  test('a generated path that is a symlink is replaced by a regular file; its target is untouched', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'keep me\n')
    mkdirSync(join(repo, 'harness/codex'), { recursive: true })
    symlinkSync(outside, join(repo, 'harness/codex/link.txt'))
    const r = await runBuild(opts(repo, { adapters: [fakeAdapter('codex', { build: () => [{ path: 'link.txt', content: 'generated\n' }] })] }))
    expect(r.errors).toEqual([])
    expect(lstatSync(join(repo, 'harness/codex/link.txt')).isSymbolicLink()).toBe(false)
    expect(read(join(repo, 'harness/codex/link.txt'))).toBe('generated\n')
    expect(read(outside)).toBe('keep me\n')
    expect(() => readlinkSync(join(repo, 'harness/codex/link.txt'))).toThrow()
  }))

  test('producers run from the checkout whatever the cwd (Bun.build labels modules relative to it); the cwd is restored', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const seen: string[] = []
    const omp = fakeAdapter('omp', { build: () => { seen.push(process.cwd()); return [{ path: 'cwd.txt', content: `${relative(realpathSync(repo), process.cwd()) || '.'}\n` }] } })
    const before = process.cwd()
    process.chdir(elsewhere)
    try {
      const r = await runBuild(opts(repo, { adapters: [omp], sharedSkills: () => { seen.push(process.cwd()); return [] } }))
      expect(r.errors).toEqual([])
      expect(process.cwd()).toBe(realpathSync(elsewhere))
    } finally {
      process.chdir(before)
    }
    expect(seen).toEqual([realpathSync(repo), realpathSync(repo)])
    expect(read(join(repo, 'harness/omp/cwd.txt'))).toBe('.\n')
  }))

  test('the output is byte-identical across runs and machines (HOME does not leak in)', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const a = await runBuild(opts(repo, { check: true }))
    expect(a.errors).toEqual([])
    await runBuild(opts(repo))
    const first = read(join(repo, 'docs/reference/install.md'))
    process.env['HOME'] = join(root, 'other-home')
    mkdirSync(process.env['HOME'], { recursive: true })
    const b = await runBuild(opts(repo, { check: true }))
    expect(b.drift).toEqual([])
    expect(first).not.toContain(root)
  }))
})

describe('buracle build (command)', () => {
  test('--check exits 1 with a drift list; build writes and refreshes runtime-config.json', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    const adapters = [fakeAdapter('claude', { build: () => [{ path: 'x.md', content: 'x\n' }] })]
    await withDeps({ repoRoot: () => repo, adapters: async () => adapters }, async () => {
      const io = memoryIO()
      expect(await buildRun(['--check'], io)).toBe(1)
      expect(io.out()).toContain('missing   harness/claude/x.md')
      expect(existsSync(join(buracleHome, 'state/runtime-config.json'))).toBe(false)

      const w = memoryIO()
      expect(await buildRun([], w)).toBe(0)
      expect(w.out()).toMatch(/^build: \d+ file\(s\) from agents-skills, claude, docs, hook-data; wrote \d+/)
      expect(existsSync(join(repo, 'harness/hook-data.json'))).toBe(true)
      expect(Object.keys((JSON.parse(readFileSync(join(repo, MANIFEST_REL), 'utf8')) as { files: Record<string, unknown> }).files)).toContain('harness/hook-data.json')
      expect(existsSync(join(buracleHome, 'state/runtime-config.json'))).toBe(true)

      const j = memoryIO()
      expect(await buildRun(['--check', '--json'], j)).toBe(0)
      expect(JSON.parse(j.out())).toMatchObject({ ok: true, check: true, drift: [], code: 0 })

      const bad = memoryIO()
      expect(await buildRun(['--harness', 'nope'], bad)).toBe(1)
      expect(bad.err()).toContain('unknown harness nope')
    })
  }))
})

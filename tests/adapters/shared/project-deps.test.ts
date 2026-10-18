import { describe, expect, test } from 'bun:test'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectDeps, WORKSPACE_MEMBERS_MAX } from '../../../src/adapters/shared/project-deps'
import { withSandbox } from '../../helpers/sandbox'

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

describe('projectDeps', () => {
  test('reads every root manifest kind and returns sorted unique names', () => withSandbox(async ({ root }) => {
    const p = join(root, 'proj')
    write(join(p, 'package.json'), JSON.stringify({ name: 'app', dependencies: { zod: '^3', react: '^19' }, devDependencies: { typescript: '6.0.3', zod: '^3' } }))
    write(join(p, 'requirements.txt'), 'Requests>=2\n# a comment\nfastapi[all]==0.1\n')
    write(join(p, 'requirements-dev.txt'), 'pytest\n')
    write(join(p, 'go.mod'), 'module x\n\nrequire (\n\tgithub.com/spf13/cobra v1.8.0\n)\n')
    write(join(p, 'Cargo.toml'), '[dependencies]\nserde = "1"\n')
    expect(projectDeps(p)).toEqual(['fastapi', 'github.com/spf13/cobra', 'pytest', 'react', 'requests', 'serde', 'typescript', 'zod'])
  }))

  test('a folder without manifests, a missing folder and an empty argument give []', () => withSandbox(async ({ root }) => {
    mkdirSync(join(root, 'empty'))
    expect(projectDeps(join(root, 'empty'))).toEqual([])
    expect(projectDeps(join(root, 'missing'))).toEqual([])
    expect(projectDeps('')).toEqual([])
  }))

  test('npm and pnpm workspaces add their members\' package.json (dir/* and plain folders only)', () => withSandbox(async ({ root }) => {
    const p = join(root, 'mono')
    write(join(p, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*', 'tools/cli', 'odd/**/x', '!packages/skip'], devDependencies: { turbo: '2' } }))
    write(join(p, 'packages', 'web', 'package.json'), JSON.stringify({ dependencies: { next: '15' } }))
    write(join(p, 'packages', 'api', 'package.json'), JSON.stringify({ dependencies: { hono: '4' } }))
    write(join(p, 'tools', 'cli', 'package.json'), JSON.stringify({ dependencies: { commander: '12' } }))
    write(join(p, 'odd', 'deep', 'x', 'package.json'), JSON.stringify({ dependencies: { never: '1' } }))
    expect(projectDeps(p)).toEqual(['commander', 'hono', 'next', 'turbo'])
    const q = join(root, 'pnpm')
    write(join(q, 'package.json'), JSON.stringify({ private: true }))
    write(join(q, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'   # the apps\n  - \"libs/core\"\nonlyBuiltDependencies:\n  - esbuild\n")
    write(join(q, 'apps', 'site', 'package.json'), JSON.stringify({ dependencies: { astro: '5' } }))
    write(join(q, 'libs', 'core', 'package.json'), JSON.stringify({ dependencies: { effect: '3' } }))
    expect(projectDeps(q)).toEqual(['astro', 'effect'])
  }))

  test('at most WORKSPACE_MEMBERS_MAX member manifests are read', () => withSandbox(async ({ root }) => {
    const p = join(root, 'big')
    write(join(p, 'package.json'), JSON.stringify({ workspaces: ['pkgs/*'] }))
    for (let i = 0; i < WORKSPACE_MEMBERS_MAX + 5; i++) write(join(p, 'pkgs', `m${String(i).padStart(3, '0')}`, 'package.json'), JSON.stringify({ dependencies: { [`dep-${String(i).padStart(3, '0')}`]: '1' } }))
    const deps = projectDeps(p)
    expect(deps.length).toBe(WORKSPACE_MEMBERS_MAX)
    expect(deps[0]).toBe('dep-000')
  }))

  test('a changed manifest is read again; an unchanged one comes from the cache', () => withSandbox(async ({ root }) => {
    const p = join(root, 'cached')
    const pkg = join(p, 'package.json')
    write(pkg, JSON.stringify({ dependencies: { zod: '3' } }))
    expect(projectDeps(p)).toEqual(['zod'])
    const t = new Date('2026-10-01T00:00:00Z')
    utimesSync(pkg, t, t)
    expect(projectDeps(p)).toEqual(['zod'])
    writeFileSync(pkg, JSON.stringify({ dependencies: { yup: '3' } }))
    utimesSync(pkg, t, t)
    expect(projectDeps(p)).toEqual(['zod'])
    utimesSync(pkg, new Date('2026-10-02T00:00:00Z'), new Date('2026-10-02T00:00:00Z'))
    expect(projectDeps(p)).toEqual(['yup'])
    write(join(p, 'requirements.txt'), 'django\n')
    expect(projectDeps(p)).toEqual(['django', 'yup'])
  }))

  test('unparsable manifests are skipped, the others still count', () => withSandbox(async ({ root }) => {
    const p = join(root, 'broken')
    write(join(p, 'package.json'), '{ not json')
    write(join(p, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 8'\n")
    expect(projectDeps(p)).toEqual(['rails'])
  }))
})

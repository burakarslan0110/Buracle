import { describe, expect, test } from 'bun:test'
import { parseManifestDeps, patchDeletes, patchEdits } from '../../../src/core/policy/code-facts'

describe('parseManifestDeps', () => {
  test('package.json and composer.json', () => {
    expect(parseManifestDeps('package.json', JSON.stringify({ dependencies: { zod: '^3' }, devDependencies: { vitest: '1' }, peerDependencies: { react: '*' }, optionalDependencies: { fsevents: '*' }, scripts: { x: 'y' } }))).toEqual(['fsevents', 'react', 'vitest', 'zod'])
    expect(parseManifestDeps('/a/b/composer.json', JSON.stringify({ require: { php: '>=8', 'ext-json': '*', 'laravel/framework': '^11' } }))).toEqual(['laravel/framework'])
    expect(parseManifestDeps('package.json', '{ not json')).toEqual([])
  })

  test('requirements.txt and pyproject.toml (PEP 621, optional groups, Poetry)', () => {
    expect(parseManifestDeps('requirements-dev.txt', '# tools\nrequests>=2.31 # http\nPyYAML==6.0\n-r base.txt\n-e .\ngit+https://x/y.git#egg=my_pkg\nuvicorn[standard]; python_version>"3.8"\n')).toEqual(['my-pkg', 'pyyaml', 'requests', 'uvicorn'])
    const pyproject = [
      '[project]', 'name = "app"', 'dependencies = [', '  "httpx>=0.27",', '  "pydantic[email]",  # with extras', ']',
      '[project.optional-dependencies]', 'dev = ["pytest", "ruff>=0.5"]',
      '[tool.poetry.dependencies]', 'python = "^3.12"', 'Django = "^5"',
      '[tool.poetry.group.test.dependencies]', 'hypothesis = "*"',
      '[dependency-groups]', 'lint = ["mypy"]',
    ].join('\n')
    expect(parseManifestDeps('pyproject.toml', pyproject)).toEqual(['django', 'httpx', 'hypothesis', 'mypy', 'pydantic', 'pytest', 'ruff'])
  })

  test('go.mod, Cargo.toml and Gemfile', () => {
    expect(parseManifestDeps('go.mod', 'module x\n\ngo 1.23\n\nrequire github.com/a/b v1.2.3\nrequire (\n\tgo.uber.org/zap v1.27.0 // indirect\n\tgolang.org/x/sync v0.8.0\n)\n')).toEqual(['github.com/a/b', 'go.uber.org/zap', 'golang.org/x/sync'])
    const cargo = '[package]\nname = "x"\n\n[dependencies]\nserde = { version = "1", features = ["derive"] }\ntokio = "1"\n\n[dev-dependencies]\ninsta = "1"\n\n[dependencies.reqwest]\nversion = "0.12"\n\n[target.\'cfg(unix)\'.dependencies]\nnix = "0.29"\n'
    expect(parseManifestDeps('Cargo.toml', cargo)).toEqual(['insta', 'nix', 'reqwest', 'serde', 'tokio'])
    expect(parseManifestDeps('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem \"pg\"\n")).toEqual(['pg', 'rails'])
    expect(parseManifestDeps('unknown.txt', 'x')).toEqual([])
  })
})

describe('patchEdits', () => {
  test('Codex patches and unified diffs per file', () => {
    const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '@@', '-export function f(a) {', '+export function f(a, b) {', ' body', '*** Add File: src/b.ts', "+import { z } from 'zod'", '*** Delete File: src/c.ts', '*** End Patch'].join('\n')
    expect(patchEdits(patch)).toEqual([
      { path: 'src/a.ts', removed: 'export function f(a) {', added: 'export function f(a, b) {' },
      { path: 'src/b.ts', removed: '', added: "import { z } from 'zod'" },
    ])
    const diff = ['--- a/x.py', '+++ b/x.py', '@@ -1 +1 @@', '-def g(a):', '+def g(a, b):'].join('\n')
    expect(patchEdits(diff)).toEqual([{ path: 'x.py', removed: 'def g(a):', added: 'def g(a, b):' }])
    expect(patchEdits('')).toEqual([])
  })
})

describe('patchDeletes', () => {
  test('the files a Codex patch or a unified diff deletes, and nothing else', () => {
    const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '@@', '-x', '+y', '*** Delete File: src/c.ts', "*** Delete File: 'cmd/old.go'", '*** Add File: src/b.ts', '+z', '*** End Patch'].join('\n')
    expect(patchDeletes(patch)).toEqual(['src/c.ts', 'cmd/old.go'])
    const diff = ['--- a/x.py', '+++ /dev/null', '@@ -1 +0,0 @@', '-def g(a):', '--- a/y.py', '+++ b/y.py', '@@ -1 +1 @@', '-a', '+b', '--- /dev/null', '+++ b/z.py', '@@ -0,0 +1 @@', '+c'].join('\n')
    expect(patchDeletes(diff)).toEqual(['x.py'])
    expect(patchDeletes(['*** Begin Patch', '*** Add File: n.go', '+package n', '*** End Patch'].join('\n'))).toEqual([])
    expect(patchDeletes('')).toEqual([])
  })
})

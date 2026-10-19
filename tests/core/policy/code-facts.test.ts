import { describe, expect, test } from 'bun:test'
import { changedExports, importedPackages, languageOf, parseManifestDeps, patchDeletes, patchEdits } from '../../../src/core/policy/code-facts'

describe('changedExports', () => {
  test('TS/JS: changed or removed exported declarations, not bodies or private names', () => {
    expect(changedExports('export function parse(text: string): Ast {', 'export function parse(text: string, opts: Opts): Ast {', 'a.ts')).toEqual(['parse'])
    expect(changedExports('export async function load(\n  path: string,\n): Promise<X> {', 'export async function load(\n  path: string,\n  force = false,\n): Promise<X> {', 'a.ts')).toEqual(['load'])
    expect(changedExports('export const add = (a: number, b: number) => a + b', 'export const add = (a: number, b: number) => b + a', 'a.ts')).toEqual([])
    expect(changedExports('export const add = (a: number) => a', 'export const add = (a: string) => a', 'a.mjs')).toEqual(['add'])
    expect(changedExports('export const LIMIT = 5', 'export const LIMIT = 6', 'a.ts')).toEqual([])
    expect(changedExports('export type Kind = "a" | "b"', 'export type Kind = "a" | "b" | "c"', 'a.ts')).toEqual(['Kind'])
    expect(changedExports('export class Store<T> extends Base {', 'export class Store<T> extends Other {', 'a.ts')).toEqual(['Store'])
    expect(changedExports('export interface Opts {\n  a: string\n}', 'export interface Options {\n  a: string\n}', 'a.ts')).toEqual(['Opts'])
    expect(changedExports('export { a, b as c }', 'export { a }', 'index.ts')).toEqual(['c'])
    expect(changedExports('export function f(a) {\n  return 1\n}', 'export function f(a) {\n  return 2\n}', 'a.js')).toEqual([])
    expect(changedExports('function helper(a) {', 'function helper(a, b) {', 'a.ts')).toEqual([])
    expect(changedExports('export function on(cb: (e: Event) => void): () => void {', 'export function on(cb: (e: Event) => void, once?: boolean): () => void {', 'a.ts')).toEqual(['on'])
  })

  test('TS/JS: export declarations quoted in a template literal or a comment are not the file\'s exports', () => {
    const before = 'const fixture = `\nexport function parse(text: string): Ast {\n`\n/*\nexport const LIMIT: number = 5\n*/'
    const after = 'const fixture = `\nexport function parse(text: string, opts: Opts): Ast {\n`\n/*\nexport const LIMIT: string = "5"\n*/'
    expect(changedExports(before, after, 'tests/parse.test.ts')).toEqual([])
  })

  test('Python, Go and Rust public declarations', () => {
    expect(changedExports('def fetch(url):\n    pass', 'def fetch(url, timeout=5):\n    pass', 'api.py')).toEqual(['fetch'])
    expect(changedExports('def _private(a):', 'def _private(a, b):', 'api.py')).toEqual([])
    expect(changedExports('class Client:\n    def get(self):', 'class Client(Base):\n    def get(self):', 'api.py')).toEqual(['Client'])
    expect(changedExports('    def method(self, a):', '    def method(self, a, b):', 'api.py')).toEqual([])
    expect(changedExports('func (s *Server) Start(ctx context.Context) error {', 'func (s *Server) Start(ctx context.Context, port int) error {', 'srv.go')).toEqual(['Start'])
    expect(changedExports('func helper(a int) {', 'func helper(a, b int) {', 'srv.go')).toEqual([])
    expect(changedExports('pub fn new(cfg: Config) -> Self {', 'pub fn new(cfg: Config, log: Logger) -> Self {', 'lib.rs')).toEqual(['new'])
    expect(changedExports('anything', 'else', 'README.md')).toEqual([])
  })

  test('languageOf', () => {
    expect(['a.ts', 'a.tsx', 'a.mjs', 'a.py', 'a.go', 'a.rs', 'a.md', 'Makefile'].map(languageOf)).toEqual(['ts', 'ts', 'ts', 'py', 'go', 'rs', 'other', 'other'])
  })
})

describe('importedPackages', () => {
  test('TS/JS bare specifiers only', () => {
    const code = [
      "import { z } from 'zod'", "import type { Q } from '@tanstack/react-query/build'", "import React, { useState } from \"react\"", "import './styles.css'",
      "import fs from 'node:fs'", "import path from 'path'", "import x from './x'", "import y from '@/lib/y'", "import z2 from '~/z'", "import h from '#internal'",
      "export * from 'lodash/fp'", "const c = require('chalk')", "const d = await import('dayjs')", "import b from 'bun:sqlite'", "import n from 'npm:nanoid@5'",
    ].join('\n')
    expect(importedPackages(code, 'a.ts')).toEqual(['@tanstack/react-query', 'chalk', 'dayjs', 'lodash', 'nanoid', 'react', 'zod'])
  })

  test('TS/JS: imports quoted in strings, templates and comments are not imports (test fixtures, examples)', () => {
    const Q = "'"
    const quoted = [
      `const input = { newString: "import { z } from ${Q}zod${Q}\\n" }`,
      `// e.g. import dayjs from ${Q}dayjs${Q} would also work`,
      `/* const c = require(${Q}chalk${Q}) */`,
      ' * import { x } from \'lodash-es\'',
      `const s = ${Q}await import("nanoid")${Q}`,
      'const fixture = `',
      "import React from 'react'",
      "export * from 'rxjs'",
      '`',
    ].join('\n')
    expect(importedPackages(quoted, 'tests/x.test.ts')).toEqual([])
    const real = [
      'const re = /[\'"`]/g',
      "import {\n  a,\n  b,\n} from 'zod'",
      'const t = `${await import(\'dayjs\')}`',
      "const s = 'it\\'s'; const c = require('chalk')",
      "export { x } from '@scope/pkg/sub'",
      'if (a) return /import x from "nope"/.test(s)',
    ].join('\n')
    expect(importedPackages(real, 'a.ts')).toEqual(['@scope/pkg', 'chalk', 'dayjs', 'zod'])
  })

  test('Python: imports inside docstrings and other triple-quoted strings are not imports', () => {
    expect(importedPackages('"""Example:\n\n    import requests\n    from httpx import Client\n"""\nimport numpy as np\n', 'app.py')).toEqual(['numpy'])
    expect(importedPackages("SRC = '''\nimport flask\n'''\nfrom fastapi import APIRouter", 'gen.py')).toEqual(['fastapi'])
  })

  test('Python modules outside the standard library, Go modules, Rust crates', () => {
    expect(importedPackages('import os, sys\nimport requests\nfrom pathlib import Path\nfrom fastapi.routing import APIRouter\nfrom . import x\nfrom .y import z', 'app.py')).toEqual(['fastapi', 'requests'])
    expect(importedPackages('import "fmt"\nimport (\n  "net/http"\n  gin "github.com/gin-gonic/gin/binding"\n  "go.uber.org/zap"\n)', 'main.go')).toEqual(['github.com/gin-gonic/gin', 'go.uber.org/zap'])
    expect(importedPackages('use std::io;\nuse serde::Deserialize;\nuse crate::x;\nextern crate rand;', 'lib.rs')).toEqual(['rand', 'serde'])
    expect(importedPackages('', 'a.ts')).toEqual([])
  })
})

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

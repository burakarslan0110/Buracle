import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { memIsSlug } from '../core/memory/note'
import { profileLanguageOf } from '../core/memory/profile'
import type { MemRepoScan, MemStackItem } from '../core/memory/repo'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { scanStateDir } from './layout'

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '.next', '.nuxt', '.svelte-kit', '.venv', 'venv',
  '__pycache__', '.worktrees', '.codegraph', '.turbo', '.cache', 'Pods', 'DerivedData', 'bin', 'obj', '.gradle', '.idea', '.vscode',
  '.pytest_cache', '.mypy_cache', '.tox', 'tmp', 'logs',
])

const MANIFESTS = [
  'package.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'tsconfig.json', 'deno.json', 'deno.jsonc',
  'pyproject.toml', 'requirements.txt', 'setup.py', 'uv.lock', 'poetry.lock', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Package.swift', 'mix.exs', 'Makefile', 'justfile', 'Dockerfile', 'docker-compose.yml',
  'compose.yaml', 'CMakeLists.txt',
]

const ITEMS: Readonly<Record<string, MemStackItem>> = {
  bun: { slug: 'bun', name: 'Bun', kind: 'runtime', description: 'JavaScript runtime, package manager and test runner' },
  nodejs: { slug: 'nodejs', name: 'Node.js', kind: 'runtime', description: 'JavaScript runtime' },
  deno: { slug: 'deno', name: 'Deno', kind: 'runtime', description: 'JavaScript and TypeScript runtime' },
  typescript: { slug: 'typescript', name: 'TypeScript', kind: 'language', description: 'Typed superset of JavaScript' },
  javascript: { slug: 'javascript', name: 'JavaScript', kind: 'language', description: 'Programming language of the web' },
  python: { slug: 'python', name: 'Python', kind: 'language', description: 'Programming language' },
  rust: { slug: 'rust', name: 'Rust', kind: 'language', description: 'Systems programming language (built with Cargo)' },
  go: { slug: 'go', name: 'Go', kind: 'language', description: 'Programming language with its own toolchain' },
  ruby: { slug: 'ruby', name: 'Ruby', kind: 'language', description: 'Programming language' },
  php: { slug: 'php', name: 'PHP', kind: 'language', description: 'Programming language' },
  java: { slug: 'java', name: 'Java', kind: 'language', description: 'Programming language for the JVM' },
  kotlin: { slug: 'kotlin', name: 'Kotlin', kind: 'language', description: 'Programming language for the JVM' },
  swift: { slug: 'swift', name: 'Swift', kind: 'language', description: 'Programming language' },
  elixir: { slug: 'elixir', name: 'Elixir', kind: 'language', description: 'Programming language on the Erlang VM' },
  dotnet: { slug: 'dotnet', name: '.NET', kind: 'platform', description: 'Microsoft application platform' },
  cpp: { slug: 'cpp', name: 'C++', kind: 'language', description: 'Programming language (built with CMake)' },
  npm: { slug: 'npm', name: 'npm', kind: 'package-manager', description: 'Node.js package manager' },
  pnpm: { slug: 'pnpm', name: 'pnpm', kind: 'package-manager', description: 'Node.js package manager' },
  yarn: { slug: 'yarn', name: 'Yarn', kind: 'package-manager', description: 'Node.js package manager' },
  uv: { slug: 'uv', name: 'uv', kind: 'package-manager', description: 'Python package and project manager' },
  poetry: { slug: 'poetry', name: 'Poetry', kind: 'package-manager', description: 'Python packaging and dependency manager' },
  react: { slug: 'react', name: 'React', kind: 'framework', description: 'UI library' },
  nextjs: { slug: 'nextjs', name: 'Next.js', kind: 'framework', description: 'React framework' },
  vue: { slug: 'vue', name: 'Vue', kind: 'framework', description: 'UI framework' },
  svelte: { slug: 'svelte', name: 'Svelte', kind: 'framework', description: 'UI framework' },
  astro: { slug: 'astro', name: 'Astro', kind: 'framework', description: 'Web framework' },
  express: { slug: 'express', name: 'Express', kind: 'framework', description: 'Node.js web framework' },
  hono: { slug: 'hono', name: 'Hono', kind: 'framework', description: 'Web framework' },
  fastify: { slug: 'fastify', name: 'Fastify', kind: 'framework', description: 'Node.js web framework' },
  vite: { slug: 'vite', name: 'Vite', kind: 'tool', description: 'Frontend build tool' },
  vitest: { slug: 'vitest', name: 'Vitest', kind: 'test-runner', description: 'Test runner' },
  jest: { slug: 'jest', name: 'Jest', kind: 'test-runner', description: 'Test runner' },
  playwright: { slug: 'playwright', name: 'Playwright', kind: 'test-runner', description: 'Browser automation and end-to-end tests' },
  electron: { slug: 'electron', name: 'Electron', kind: 'framework', description: 'Desktop apps with web technology' },
  tailwindcss: { slug: 'tailwindcss', name: 'Tailwind CSS', kind: 'framework', description: 'Utility-first CSS framework' },
  prisma: { slug: 'prisma', name: 'Prisma', kind: 'database', description: 'Database toolkit and ORM' },
  django: { slug: 'django', name: 'Django', kind: 'framework', description: 'Python web framework' },
  flask: { slug: 'flask', name: 'Flask', kind: 'framework', description: 'Python web framework' },
  fastapi: { slug: 'fastapi', name: 'FastAPI', kind: 'framework', description: 'Python web framework' },
  pytest: { slug: 'pytest', name: 'pytest', kind: 'test-runner', description: 'Python test runner' },
  docker: { slug: 'docker', name: 'Docker', kind: 'tool', description: 'Containers' },
  make: { slug: 'make', name: 'Make', kind: 'tool', description: 'Build automation' },
}

const JS_DEPS: Readonly<Record<string, string>> = {
  react: 'react', next: 'nextjs', vue: 'vue', svelte: 'svelte', '@sveltejs/kit': 'svelte', astro: 'astro', express: 'express', hono: 'hono',
  fastify: 'fastify', vite: 'vite', vitest: 'vitest', jest: 'jest', '@playwright/test': 'playwright', playwright: 'playwright',
  electron: 'electron', tailwindcss: 'tailwindcss', prisma: 'prisma', '@prisma/client': 'prisma', typescript: 'typescript',
}

const PY_DEPS: Readonly<Record<string, string>> = { django: 'django', flask: 'flask', fastapi: 'fastapi', pytest: 'pytest' }

const SCRIPT_ORDER = ['test', 'build', 'lint', 'typecheck', 'check', 'format', 'dev', 'start']

function readText(path: string, max = 512 * 1024): string | undefined {
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > max) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  const t = readText(path)
  if (t === undefined) return undefined
  try {
    const v = JSON.parse(t) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

function nodePackageManager(root: string, pkg: Record<string, unknown>): 'bun' | 'pnpm' | 'yarn' | 'npm' {
  const declared = typeof pkg['packageManager'] === 'string' ? pkg['packageManager'].split('@')[0] : undefined
  if (declared === 'bun' || declared === 'pnpm' || declared === 'yarn' || declared === 'npm') return declared
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun'
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function scriptCommand(pm: string, name: string): string {
  if (pm === 'npm') return name === 'test' || name === 'start' ? `npm ${name}` : `npm run ${name}`
  if (pm === 'yarn') return `yarn ${name}`
  return `${pm} run ${name}`
}

function makeTargets(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line)
    if (m && !out.includes(m[1] as string) && !(m[1] as string).includes('.')) out.push(m[1] as string)
  }
  return out
}

function justRecipes(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^@?([a-z][a-z0-9_-]*)(?:\s+[^:=]*)?:(?!=)/.exec(line)
    if (m && !out.includes(m[1] as string)) out.push(m[1] as string)
  }
  return out
}

function walk(root: string, maxFiles: number, maxDepth: number): { dirs: Map<string, number>, langs: Map<string, number>, files: number, truncated: boolean } {
  const dirs = new Map<string, number>()
  const langs = new Map<string, number>()
  let files = 0
  let truncated = false
  const visit = (dir: string, top: string | undefined, depth: number) => {
    if (truncated) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (files >= maxFiles) { truncated = true; return }
      if (e.name.startsWith('.') && e.name !== '.github') continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || depth >= maxDepth) continue
        visit(join(dir, e.name), top ?? e.name, depth + 1)
      } else if (e.isFile()) {
        files++
        if (top !== undefined) dirs.set(top, (dirs.get(top) ?? 0) + 1)
        const lang = profileLanguageOf(e.name)
        if (lang !== undefined) langs.set(lang, (langs.get(lang) ?? 0) + 1)
      }
    }
  }
  visit(root, undefined, 0)
  return { dirs, langs, files, truncated }
}

export function scanRepo(root: string, opts: { maxFiles?: number, maxDepth?: number } = {}): MemRepoScan {
  const stack: string[] = []
  const add = (id: string) => { if (ITEMS[id] !== undefined && !stack.includes(id)) stack.push(id) }
  const commands: Array<{ cmd: string, source: string }> = []
  const cmd = (c: string, source: string) => { if (commands.length < 16 && !commands.some(x => x.cmd === c)) commands.push({ cmd: c, source }) }
  const manifests = MANIFESTS.filter(m => existsSync(join(root, m)))
  const pkg = readJson(join(root, 'package.json'))
  if (pkg !== undefined) {
    const pm = nodePackageManager(root, pkg)
    add(pm === 'bun' ? 'bun' : 'nodejs')
    if (pm !== 'bun') add(pm)
    const deps = { ...obj(pkg['dependencies']), ...obj(pkg['devDependencies']), ...obj(pkg['peerDependencies']) }
    for (const [dep, id] of Object.entries(JS_DEPS)) if (dep in deps) add(id)
    const scripts = obj(pkg['scripts'])
    const names = Object.keys(scripts).filter(n => typeof scripts[n] === 'string')
    const ordered = [...SCRIPT_ORDER.filter(n => names.includes(n)), ...names.filter(n => !SCRIPT_ORDER.includes(n)).sort()]
    for (const n of ordered.slice(0, 10)) cmd(scriptCommand(pm, n), `package.json "${n}"`)
  }
  if (existsSync(join(root, 'tsconfig.json'))) add('typescript')
  if (existsSync(join(root, 'deno.json')) || existsSync(join(root, 'deno.jsonc'))) {
    add('deno')
    const deno = readJson(join(root, 'deno.json'))
    for (const t of Object.keys(obj(deno?.['tasks'])).slice(0, 8)) cmd(`deno task ${t}`, `deno.json "${t}"`)
  }
  const pyproject = readText(join(root, 'pyproject.toml'))
  const requirements = readText(join(root, 'requirements.txt'))
  if (pyproject !== undefined || requirements !== undefined || existsSync(join(root, 'setup.py'))) {
    add('python')
    if (existsSync(join(root, 'uv.lock'))) add('uv')
    if (existsSync(join(root, 'poetry.lock')) || /\[tool\.poetry\]/.test(pyproject ?? '')) add('poetry')
    const text = `${pyproject ?? ''}\n${requirements ?? ''}`.toLowerCase()
    for (const [dep, id] of Object.entries(PY_DEPS)) if (new RegExp(`(^|[\\s"'\\[,])${dep}([\\s"'<>=~!\\],]|$)`, 'm').test(text)) add(id)
    if (stack.includes('pytest')) cmd(existsSync(join(root, 'uv.lock')) ? 'uv run pytest' : 'pytest', 'pyproject.toml')
  }
  if (existsSync(join(root, 'Cargo.toml'))) { add('rust'); cmd('cargo build', 'Cargo.toml'); cmd('cargo test', 'Cargo.toml') }
  if (existsSync(join(root, 'go.mod'))) { add('go'); cmd('go build ./...', 'go.mod'); cmd('go test ./...', 'go.mod') }
  if (existsSync(join(root, 'Gemfile'))) add('ruby')
  if (existsSync(join(root, 'composer.json'))) add('php')
  if (existsSync(join(root, 'pom.xml'))) { add('java'); cmd('mvn test', 'pom.xml') }
  if (existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) {
    add(existsSync(join(root, 'build.gradle.kts')) ? 'kotlin' : 'java')
    cmd(existsSync(join(root, 'gradlew')) ? './gradlew test' : 'gradle test', 'build.gradle')
  }
  if (existsSync(join(root, 'Package.swift'))) { add('swift'); cmd('swift build', 'Package.swift'); cmd('swift test', 'Package.swift') }
  if (existsSync(join(root, 'mix.exs'))) { add('elixir'); cmd('mix test', 'mix.exs') }
  if (existsSync(join(root, 'CMakeLists.txt'))) add('cpp')
  const make = readText(join(root, 'Makefile'))
  if (make !== undefined) { add('make'); for (const t of makeTargets(make).slice(0, 8)) cmd(`make ${t}`, 'Makefile') }
  const just = readText(join(root, 'justfile'))
  if (just !== undefined) for (const r of justRecipes(just).slice(0, 8)) cmd(`just ${r}`, 'justfile')
  if (existsSync(join(root, 'Dockerfile')) || existsSync(join(root, 'docker-compose.yml')) || existsSync(join(root, 'compose.yaml'))) add('docker')
  let csharp = false
  try { csharp = readdirSync(root).some(n => /\.(?:csproj|sln|fsproj)$/i.test(n)) } catch {  }
  if (csharp) { add('dotnet'); cmd('dotnet build', '.NET project'); cmd('dotnet test', '.NET project') }
  const w = walk(root, opts.maxFiles ?? 4000, opts.maxDepth ?? 6)
  const languages = [...w.langs.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
  const total = languages.reduce((n, l) => n + l.files, 0)
  for (const l of languages) {
    const id = l.name.toLowerCase().replace('c++', 'cpp').replace(/[^a-z0-9]/g, '')
    if (total > 0 && l.files / total >= 0.1 && ITEMS[id] !== undefined) add(id)
  }
  const scan: MemRepoScan = {
    stack: stack.slice(0, 12).map(id => ITEMS[id] as MemStackItem),
    languages,
    commands,
    dirs: [...w.dirs.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)),
    manifests,
    files: w.files,
  }
  if (w.truncated) scan.truncated = true
  return scan
}

interface ScanRecord { v: 1, root: string, at: number, signature: string, scan: MemRepoScan, entities?: string[] }

function signatureOf(root: string): string {
  const parts: string[] = []
  for (const p of ['', ...MANIFESTS]) {
    try { parts.push(`${p}:${Math.floor(statSync(join(root, p)).mtimeMs)}`) } catch {  }
  }
  return parts.join('|')
}

function recordFile(slug: string): string {
  return join(scanStateDir(), `${slug}.json`)
}

export function dropScanRecord(slug: string): void {
  if (!memIsSlug(slug)) return
  rmSync(recordFile(slug), { force: true })
}

export function readScanRecord(slug: string): ScanRecord | undefined {
  if (!memIsSlug(slug)) return undefined
  const r = readJsonSafeSync<ScanRecord>(recordFile(slug))
  return r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 1 && typeof r.value.scan === 'object' ? r.value : undefined
}

export function projectScan(slug: string, root: string, nowMs: number, opts: { force?: boolean } = {}): { scan: MemRepoScan, fresh: boolean, added: string[] } | undefined {
  if (!memIsSlug(slug) || !existsSync(root)) return undefined
  const prev = readScanRecord(slug)
  const signature = signatureOf(root)
  if (!opts.force && prev !== undefined && prev.root === root && prev.signature === signature && nowMs - prev.at < 24 * 3600_000) {
    return { scan: prev.scan, fresh: false, added: [] }
  }
  let scan: MemRepoScan
  try { scan = scanRepo(root) } catch (e) { log('warn', 'memory: repository scan failed', { root, error: e }); return prev !== undefined ? { scan: prev.scan, fresh: false, added: [] } : undefined }
  const before = new Set((prev?.scan.stack ?? []).map(s => s.slug))
  const added = scan.stack.map(s => s.slug).filter(s => prev === undefined || !before.has(s))
  try {
    atomicWriteSync(recordFile(slug), JSON.stringify({ v: 1, root, at: nowMs, signature, scan } satisfies ScanRecord, null, 2) + '\n')
  } catch (e) { log('warn', 'memory: cannot record the repository scan', { slug, error: e }) }
  return { scan, fresh: true, added }
}

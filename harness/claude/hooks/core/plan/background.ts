import { reportsWaiting } from '../policy/intents'
import type { ShellWord } from '../policy/shell'
import { commandName, parseShell, unwrap } from '../policy/shell'

const LIVE = new Set(['running', 'pending', 'queued', 'in_progress', 'in-progress', 'started'])
const WAKING = new Set(['subagent', 'monitor', 'workflow', 'mcp task', 'cloud session'])

const FINITE_SCRIPT = /^(?:test|tests|build|check|checks|typecheck|type-check|types|lint|ci|verify|e2e|(?:test|build|lint|check|e2e|typecheck|verify)[:-][\w:.-]+)$/
const LONG_LIVED = /(?:^|[:-])(?:dev|serve|server|start|watch|preview|storybook)(?:$|[:-])/
const FINITE_TOOLS = new Set([
  'tsc', 'jest', 'pytest', 'py.test', 'mypy', 'pyright', 'ruff', 'eslint', 'biome', 'tox', 'nox', 'phpunit', 'rspec', 'ctest', 'mocha', 'ava',
  'playwright', 'cypress', 'golangci-lint', 'shellcheck', 'hadolint', 'stylelint', 'rubocop',
])
const SUBCOMMAND_TOOLS: Readonly<Record<string, ReadonlySet<string>>> = {
  cargo: new Set(['test', 'build', 'check', 'clippy', 'nextest', 'bench', 'doc']),
  go: new Set(['test', 'build', 'vet']),
  swift: new Set(['build', 'test']),
  dotnet: new Set(['build', 'test']),
  mix: new Set(['test', 'compile']),
  deno: new Set(['test', 'check', 'lint']),
  gradle: new Set(['test', 'build', 'check', 'assemble', 'compileJava', 'verify']),
  gradlew: new Set(['test', 'build', 'check', 'assemble', 'compileJava', 'verify']),
  mvn: new Set(['test', 'verify', 'package', 'compile', 'install']),
  mvnw: new Set(['test', 'verify', 'package', 'compile', 'install']),
  vitest: new Set(['run']),
  bazel: new Set(['test', 'build']),
}
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx'])

function positional(words: readonly string[]): string[] {
  return words.filter(w => !w.startsWith('-'))
}

function finiteArgv(argv: readonly string[]): boolean {
  const name = (argv[0] ?? '').replace(/^.*\//, '').toLowerCase()
  const rest = argv.slice(1)
  if (rest.some(w => /^--watch(?:=|$)|^-w$|^--watchAll(?:=|$)|^--serve(?:=|$)/.test(w))) return false
  const pos = positional(rest)
  if (PACKAGE_RUNNERS.has(name)) return pos[0] !== undefined && finiteArgv(rest.slice(rest.indexOf(pos[0])))
  if (PACKAGE_MANAGERS.has(name)) {
    const sub = pos[0]
    if (sub === undefined) return false
    if (sub === 'test' || sub === 't') return true
    if (name === 'bun' && sub === 'x') return pos[1] !== undefined && finiteArgv(rest.slice(rest.indexOf(pos[1])))
    if (name === 'pnpm' && sub === 'exec') return pos[1] !== undefined && finiteArgv(rest.slice(rest.indexOf(pos[1])))
    const script = sub === 'run' || sub === 'run-script' ? pos[1] : name === 'yarn' || name === 'pnpm' || name === 'bun' ? sub : undefined
    return script !== undefined && FINITE_SCRIPT.test(script) && !LONG_LIVED.test(script)
  }
  if (FINITE_TOOLS.has(name)) return true
  const subs = SUBCOMMAND_TOOLS[name]
  if (subs !== undefined) return pos[0] !== undefined && subs.has(pos[0])
  if (name === 'make' || name === 'just') return pos.every(t => !LONG_LIVED.test(t) && t !== 'run')
  return false
}

export function finiteRunner(command: string): boolean {
  if (typeof command !== 'string' || command.trim() === '' || command.length > 1000) return false
  let parsed: ReturnType<typeof parseShell>
  try { parsed = parseShell(command) } catch { return false }
  if (parsed.truncated === true || parsed.subs.length > 0) return false
  const pipelines = parsed.script.pipelines
  const stage = pipelines.length === 1 && pipelines[0]?.stages.length === 1 ? pipelines[0].stages[0] : undefined
  if (stage === undefined || stage.kind !== 'cmd') return false
  const u = unwrap(stage.cmd.words)
  if (u.tooDeep === true || u.scripts.length > 0 || u.argv.length === 0) return false
  if (u.argv.some((w: ShellWord) => w.dynamic)) return false
  if (commandName(u.argv[0]) === undefined) return false
  return finiteArgv(u.argv.map(w => w.text))
}

function rec(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined
}

function text(x: unknown): string {
  return typeof x === 'string' ? x.trim().toLowerCase() : ''
}

function endsWithQuestion(message: string): boolean {
  return /[?？]\s*(?:[*_)"'\]]+)?\s*$/.test(message.trim())
}

function wakes(task: unknown): boolean {
  const t = rec(task)
  if (t === undefined || !LIVE.has(text(t['status']))) return false
  const type = text(t['type'])
  if (WAKING.has(type)) return true
  return type === 'shell' && typeof t['command'] === 'string' && finiteRunner(t['command'])
}

export function backgroundWait(lastMessage: string | undefined, tasks: unknown, crons?: unknown): boolean {
  if (typeof lastMessage !== 'string' || endsWithQuestion(lastMessage) || !reportsWaiting(lastMessage)) return false
  if (Array.isArray(tasks) && tasks.some(wakes)) return true
  return Array.isArray(crons) && crons.some(c => rec(c)?.['recurring'] === false)
}

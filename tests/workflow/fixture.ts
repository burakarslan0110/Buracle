import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runPlan } from '../../src/cli/commands/plan'
import type { CommandIO } from '../../src/cli/router'
import { userConfigFile } from '../../src/engine/paths'
import { run } from '../../src/engine/proc'
import type { ResolvedSession } from '../../src/workflow/session-store'
import type { WorkflowCtx } from '../../src/workflow/result'

export const GIT_TEST_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
}

export async function g(cwd: string, ...args: string[]): Promise<string> {
  const r = await run(['git', ...args], { cwd, env: GIT_TEST_ENV })
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed (${r.code}): ${r.stderr}`)
  return r.stdout.trim()
}

export async function gRaw(cwd: string, ...args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  return run(['git', ...args], { cwd, env: GIT_TEST_ENV })
}

export function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

export async function makeRepo(root: string, name = 'repo'): Promise<string> {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  await g(repo, 'init', '-q', '-b', 'main')
  await g(repo, 'config', 'user.name', 'Test')
  await g(repo, 'config', 'user.email', 'test@example.com')
  await g(repo, 'config', 'commit.gpgsign', 'false')
  write(join(repo, 'README.md'), '# demo\n')
  write(join(repo, 'src', 'app.ts'), 'export const a = 1\n')
  await g(repo, 'add', '.')
  await g(repo, 'commit', '-q', '-m', 'init')
  return repo
}

export function ctxAt(cwd: string, now = Date.UTC(2026, 9, 8, 12, 0, 0), env: Record<string, string | undefined> = {}): WorkflowCtx {
  return { cwd, now, env: { BURACLE_NO_NOTIFY: '1', BURACLE_NO_MEMORY: '1', ...env } }
}

export const SESSION: ResolvedSession = { harness: 'claude', sessionId: 'test-session-1', source: '--session' }

export interface MemIO extends CommandIO { out(): string, err(): string, json<T = Record<string, unknown>>(): T }

export function memIO(json = false): MemIO {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: false, text: async () => '' },
    flags: { json, verbose: false },
    out: () => out,
    err: () => err,
    json: <T>() => JSON.parse(out) as T,
  }
}

export function evidenceSections(type = 'Feature'): string[] {
  const out = ['## Evidence', '| Check | Command | Result |', '|---|---|---|', '| Tests | `bun test` | pass, 12 tests |', '']
  if (type === 'Feature') out.push('## DoD Audit', '| Task | Result | Evidence or gap |', '|---|---|---|', '| 1 | met | Evidence row 1 |', '')
  if (type === 'Bugfix') out.push('## RED Evidence', '`bun test tests/s1.test.ts` failed: expected 35, got 20', '')
  return out
}

export function planDoc(o: { type?: string, status?: string, approved?: boolean, n?: number, done?: number, extraFm?: string, title?: string, evidence?: boolean } = {}): string {
  const n = o.n ?? 2
  const done = o.done ?? 0
  const type = o.type ?? 'Feature'
  const counter = type === 'Build' ? 'rounds: 0' : 'iterations: 0'
  const tasks: string[] = []
  for (let i = 1; i <= n; i++) {
    tasks.push(`### Task ${i}: Step ${i}`, '', `**Objective:** Do step ${i}.`, '', '**Files:**', `- Modify: \`src/s${i}.ts\``, '', '**Definition of Done:**', `- Verify: \`bun test tests/s${i}.test.ts\``, '', `- [${i <= done ? 'x' : ' '}] Task ${i} done`, '')
  }
  if (o.evidence === true) tasks.push(...evidenceSections(type))
  return [
    '---',
    'created: 2026-10-08',
    `status: ${o.status ?? 'PENDING'}`,
    `approved: ${o.approved ?? false}`,
    'worktree: false',
    `type: ${type}`,
    counter,
    ...(o.extraFm !== undefined ? [o.extraFm] : []),
    '---',
    `# ${o.title ?? 'Rate-limit the public API'}`,
    '',
    '## Goal',
    'Clients get 429 instead of overloading the server.',
    '',
    '## Tasks',
    '',
    ...tasks,
    '## Risks',
    '- A restart resets counters.',
    '',
  ].join('\n')
}

export const NATIVE_PLAN_BODY = planDoc({ title: 'Add a cache' }).replace(/^---\n[\s\S]*?\n---\n/, '')

export async function prepareNativePlan(cwd: string, harness: string, sid: string, o: { title?: string, config?: string } = {}): Promise<string> {
  write(userConfigFile(), o.config ?? 'version: 1\nplan:\n  nativePlanMode: "on"\n')
  const session = ['--session', sid, '--harness', harness]
  const init = memIO(true)
  if (await runPlan(['init', '--type', 'feature', '--title', o.title ?? 'Add a cache', ...session], init, ctxAt(cwd)) !== 0) throw new Error(`plan init failed: ${init.err()}`)
  const path = init.json<{ path: string }>().path
  const register = memIO(true)
  if (await runPlan(['register', path, '--phase', 'plan', ...session], register, ctxAt(cwd)) !== 0) throw new Error(`plan register failed: ${register.err()}`)
  const prepare = memIO(true)
  if (await runPlan(['prepare-native', path, ...session], prepare, ctxAt(cwd)) !== 0) throw new Error(`plan prepare-native failed: ${prepare.err()}`)
  return path
}

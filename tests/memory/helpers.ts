import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../../src/engine/paths'
import type { MemoryCtx } from '../../src/memory/api'
import { closeAllCortex } from '../../src/memory/cortex'
import { withEnv, withSandbox, type Sandbox } from '../helpers/sandbox'

export function withCapture<T>(fn: () => T | Promise<T>): Promise<T> {
  return withEnv({ BURACLE_NO_CAPTURE: undefined }, fn)
}

export interface BrainSandbox extends Sandbox {
  repo: string
}

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, LC_ALL: 'C' } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

export function makeRepo(dir: string, remote = 'git@github.com:me/demo.git'): string {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  if (remote !== '') git(dir, 'remote', 'add', 'origin', remote)
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

export async function withBrain<T>(fn: (sb: BrainSandbox) => T | Promise<T>, opts: { capture?: boolean } = {}): Promise<T> {
  const run = () => withSandbox(async sb => {
    try {
      const repo = makeRepo(join(sb.root, 'repo'))
      return await fn({ ...sb, repo })
    } finally {
      await closeAllCortex()
    }
  })
  return opts.capture === false ? withEnv({ BURACLE_NO_CAPTURE: '1' }, run) : withCapture(run)
}

export function agentCtx(cwd: string, harness = 'codex', session = '0199a213-81c0-7800-8aa1-bbab2a035a53'): MemoryCtx {
  return { cwd, harness, generatedBy: `${harness}/0.161.0`, agent: true, session }
}

export function humanCtx(cwd: string): MemoryCtx {
  return { cwd, harness: 'human', generatedBy: 'human:tester', agent: false }
}

// The legacy fixture and a few tests drive the fake CortexDB's file format; a run against the real binary (BURACLE_CORTEXDB_SMOKE) skips them.
export const REAL_CORTEXDB = (process.env['BURACLE_CORTEXDB_SMOKE'] ?? '') !== ''

const LEGACY_FIXTURE = join(import.meta.dir, '..', 'fixtures', 'legacy-brain')

/**
 * Puts a Buracle 0.5 brain in the sandbox: the files the baseline code wrote under the fake CortexDB (a person brain with 3
 * memories, a `demo` project brain with 5, one of them superseded and one pinned, an absorbed archive) and the profile
 * claims and job state 0.5 kept next to them.
 */
export function installLegacyBrain(): void {
  cpSync(join(LEGACY_FIXTURE, 'brain'), paths.brainDir(), { recursive: true })
  cpSync(join(LEGACY_FIXTURE, 'state', 'memory'), paths.memoryStateDir(), { recursive: true })
}

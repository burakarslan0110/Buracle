// Shared by the board-panes tests: a published board in a throwaway repository, and fake multiplexer CLIs.
import { join } from 'node:path'
import { workPublish } from '../../src/workflow/board'
import type { MuxExec, MuxExecResult } from '../../src/workflow/mux'
import type { ResolvedSession } from '../../src/workflow/session-store'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { ctxAt, makeRepo, planDoc, write } from './fixture'

export const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)
export const LEAD: ResolvedSession = { harness: 'claude', sessionId: 'lead-1', source: '--session' }
export const HERDR_ENV = { HERDR_ENV: '1', HERDR_PANE_ID: 'w2:p0', HERDR_TAB_ID: 'w2:t1', HERDR_WORKSPACE_ID: 'w2', HERDR_SOCKET_PATH: '/Users/me/.config/herdr/herdr.sock' }

export function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_NO_MEMORY: '1', BURACLE_LOCK_TIMEOUT_MS: '2000' }, () => fn(root)))
}

/** `dep`: Task 3 also modifies the file of Task 1 (`true`) or of the task named, so it cannot start while that task is active. */
export async function published(root: string, o: { n?: number, dep?: boolean | number, maxWorkers?: number, name?: string } = {}): Promise<{ repo: string, plan: string, path: string, commonDir: string }> {
  const repo = await makeRepo(root, o.name ?? 'repo')
  const plan = join(repo, 'docs', 'plan-build', '2026-11-08-rate-limit.md')
  let doc = planDoc({ n: o.n ?? 3, status: 'IN_PROGRESS', approved: true })
  if (o.dep !== undefined && o.dep !== false) doc = doc.replace('- Modify: `src/s3.ts`', `- Modify: \`src/s${o.dep === true ? 1 : o.dep}.ts\`\n- Modify: \`src/s3.ts\``)
  write(plan, doc)
  const pub = await workPublish({ planPath: plan, ...(o.maxWorkers !== undefined ? { maxWorkers: o.maxWorkers } : {}) }, ctxAt(repo, NOW), LEAD)
  if (pub.code !== 0) throw new Error(pub.errors.join('; '))
  const path = String(pub.data['path'])
  return { repo, plan, path, commonDir: join(path, '..', '..', '..') }
}

/**
 * A fake herdr: `pane split` hands out w2:p1, w2:p2, …; `pane get` answers for the panes in `live`; `failSplit` breaks the n-th split.
 * `from` starts the numbering later, and ids are written in base 36 like the real herdr's (w2:p9, w2:pA, … w2:pH, …).
 */
export function fakeHerdr(o: { live?: Set<string>, failSplit?: number, getCode?: number, from?: number } = {}): { exec: MuxExec, calls: string[][], lines: () => string[], reset: () => void } {
  const calls: string[][] = []
  let splits = 0
  const exec: MuxExec = async argv => {
    calls.push(argv)
    const r: MuxExecResult = { code: 0, stdout: '', stderr: '' }
    if (argv[1] === 'pane' && argv[2] === 'split') {
      splits++
      if (o.failSplit === splits) return { code: 1, stdout: '', stderr: '{"error":{"code":"layout_full"}}' }
      const id = `w2:p${((o.from ?? 1) + splits - 1).toString(36).toUpperCase()}`
      o.live?.add(id)
      return { ...r, stdout: JSON.stringify({ ok: true, result: { pane: { pane_id: id } } }) }
    }
    if (argv[1] === 'pane' && argv[2] === 'get') {
      if (o.getCode !== undefined) return { code: o.getCode, stdout: '', stderr: 'timed out' }
      return o.live === undefined || o.live.has(argv[3] ?? '') ? r : { code: 1, stdout: '', stderr: '{"error":{"code":"not_found"}}' }
    }
    return r
  }
  return { exec, calls, lines: () => calls.map(c => c.join(' ')), reset: () => { calls.length = 0 } }
}

export const CMUX_ENV = { CMUX_SURFACE_ID: '0f6b2e2a-1111-4222-8333-444455556666', CMUX_WORKSPACE_ID: 'workspace:2', CMUX_SOCKET_PATH: '/Users/me/.local/state/cmux/cmux.sock' }
export const CU = (n: number): string => `aaaaaaaa-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`

/** A fake cmux: every `new-split` makes the next surface (surface:2 with CU(2), …) and `list-panels` lists them all. */
export function fakeCmux(): { exec: MuxExec, lines: () => string[] } {
  const calls: string[][] = []
  const made: string[] = []
  const exec: MuxExec = async argv => {
    calls.push(argv)
    const r: MuxExecResult = { code: 0, stdout: '', stderr: '' }
    if (argv[1] === '--id-format') return { ...r, stdout: `workspace:2\nsurface:1 ${CU(1)} "zsh"\n${made.join('\n')}\n` }
    if (argv[1] === 'new-split') {
      const n = made.length + 2
      made.push(`surface:${n} ${CU(n)} "worker"`)
      return { ...r, stdout: `OK surface:${n} ${CU(n)}\n` }
    }
    return r
  }
  return { exec, lines: () => calls.map(c => c.join(' ')) }
}

export const which = (bin: string): boolean => ['claude', 'codex', 'opencode', 'omp'].includes(bin)

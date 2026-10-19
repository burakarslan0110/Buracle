import { sep } from 'node:path'
import * as core from '../../core/index'
import type { BuracleConfig } from '../../core/config'
import type { Harness } from '../../core/events'
import { ledgerOnce } from '../../core/policy/usage'
import { toplevel } from '../../engine/git'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import type { RunOptions, RunResult } from '../../engine/proc'
import { updateLedger } from '../../workflow/ledger'
import { checkOneFile, nodeCheckFs, type CheckerApi, type CheckFs, type FileCheckEnv } from './checker-scan'

async function safe<T>(what: string, fallback: T, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) { log('warn', `file checks: ${what} failed`, { error: e }); return fallback }
}

export interface FileCheckDeps {
  now(): number
  run(argv: string[], opts?: RunOptions): Promise<RunResult>
  core?: CheckerApi
  fs?: CheckFs
  once?(key: string): boolean
  resolve?(argv: readonly string[]): string[]
}

export function sessionOnce(harness: Harness, sid: string): (key: string) => boolean {
  return key => {
    let fresh = false
    try {
      updateLedger(harness, sid, l => { const r = ledgerOnce(l, key); fresh = r.fresh; return r.next }, { timeoutMs: 250 })
    } catch (e) {
      log('warn', 'file checks: the session ledger could not be updated', { error: e })
      return true
    }
    return fresh
  }
}

export async function fileCheckNotes(files: readonly string[], added: Readonly<Record<string, string>>, cwd: string, cfg: BuracleConfig['checkers'], deps: FileCheckDeps, deadlineMs: number, removed: Readonly<Record<string, string>> = {}): Promise<string[]> {
  if (!cfg.enabled) return []
  const root = (await safe('git toplevel', undefined as string | undefined, () => toplevel(cwd))) ?? cwd
  const fs = deps.fs ?? nodeCheckFs
  const home = await safe('home', undefined as string | undefined, () => paths.home())
  const env: FileCheckEnv = {
    api: deps.core ?? core,
    fs,
    now: deps.now,
    run: async (plan, timeoutMs) => {
      const r = await deps.run(plan.argv, { cwd: plan.cwd, timeoutMs, ...(plan.env !== undefined ? { env: plan.env } : {}) })
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
    },
    guard: safe,
    ...(deps.once !== undefined ? { once: deps.once } : {}),
    ...(deps.resolve !== undefined ? { resolve: deps.resolve } : {}),
  }
  const perFile = [...new Set(files)].filter(p => fs.exists(p)).map(async file => {
    const notes = await checkOneFile(env, { file, cwd, root, ...(home !== undefined ? { home } : {}), ...(added[file] !== undefined ? { added: added[file] } : {}), ...(removed[file] !== undefined ? { removed: removed[file] } : {}), deadlineMs }, cfg)
    const shown = file.startsWith(cwd + '/') || file.startsWith(cwd + sep) ? file.slice(cwd.length + 1).split(sep).join('/') : file
    return notes.length > 0 ? `${shown}:\n${notes.map(n => `- ${n.text.trim().replace(/\n/g, '\n  ')}`).join('\n')}` : undefined
  })
  return (await Promise.all(perFile)).filter((x): x is string => x !== undefined)
}

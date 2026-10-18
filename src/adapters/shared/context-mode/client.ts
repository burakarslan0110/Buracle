import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CmEvent } from '../../../core/context-mode'
import { cmBun, cmHome } from '../../../engine/context-mode'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import { spawnArgv } from '../../../engine/platform'
import type { CmOp, CmOpOutcome, CmTarget } from './session'

export function cmTmpDir(): string {
  return join(cmHome(), 'tmp')
}

export function writeCmInput(text: string): string | undefined {
  try {
    mkdirSync(cmTmpDir(), { recursive: true, mode: 0o700 })
    const file = join(cmTmpDir(), `in-${process.pid}-${randomBytes(6).toString('hex')}.json`)
    const fd = openSync(file, 'wx', 0o600)
    try { writeSync(fd, text) } finally { closeSync(fd) }
    return file
  } catch (e) {
    log('debug', 'context-mode: cannot write a session input file', { error: e })
    return undefined
  }
}

function realOr(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

export function takeCmInput(file: string): string | undefined {
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return undefined }
  if (realOr(dirname(file)) === realOr(cmTmpDir()) && /^in-[\w-]+\.json$/.test(file.split(/[\\/]/).pop() ?? '')) {
    try { unlinkSync(file) } catch {  }
  }
  return text
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

export function cmCliArgv(): string[] {
  const shim = paths.shimPath()
  const haveShim = isFile(shim)
  if (haveShim && paths.findCheckout(import.meta.dir) === undefined) return [shim]
  const main = join(paths.repoRoot(), 'src', 'cli', 'main.ts')
  const bun = cmBun()
  if (bun !== undefined && isFile(main)) return [bun, main]
  if (haveShim) return [shim]
  return [bun ?? process.execPath, main]
}

export interface CmChildRequest {
  op: CmOp
  target: CmTarget
  events?: readonly CmEvent[]
  source?: 'compact' | 'resume'
  maxBytes?: number
}

export function cmChildArgs(req: CmChildRequest, input?: string): string[] {
  const t = req.target
  return [
    'ctx', 'session', req.op, '--harness', t.harness, '--session', t.sessionId, '--project-dir', t.projectDir,
    ...(input !== undefined ? ['--input', input] : []),
    ...(req.source !== undefined ? ['--source', req.source] : []),
    ...(req.maxBytes !== undefined ? ['--max-bytes', String(req.maxBytes)] : []),
    '--json',
  ]
}

function childCwd(): string {
  const home = paths.home()
  return existsSync(home) ? home : '/'
}

export type CmSpawner = (argv: string[], opts: { cwd: string }) => void

const spawnDetached: CmSpawner = (argv, opts) => {
  const child = Bun.spawn(spawnArgv(argv), { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, cwd: opts.cwd, env: { ...process.env } })
  child.unref()
}

export function cmSpawnSession(req: CmChildRequest, spawn: CmSpawner = spawnDetached): boolean {
  let input: string | undefined
  try {
    if (req.events !== undefined && req.events.length > 0) {
      input = writeCmInput(JSON.stringify({ events: req.events }))
      if (input === undefined) return false
    }
    spawn([...cmCliArgv(), ...cmChildArgs(req, input)], { cwd: childCwd() })
    return true
  } catch (e) {
    log('warn', `context-mode: cannot start the session ${req.op} child`, { error: e })
    if (input !== undefined) { try { unlinkSync(input) } catch {  } }
    return false
  }
}

export function parseCmOutcome(stdout: string): CmOpOutcome | undefined {
  const lines = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{'))
  const last = lines[lines.length - 1]
  if (last === undefined) return undefined
  try {
    const v = JSON.parse(last) as unknown
    if (v === null || typeof v !== 'object' || typeof (v as { ok?: unknown }).ok !== 'boolean') return undefined
    return v as CmOpOutcome
  } catch {
    return undefined
  }
}

export async function cmRunSessionChild(req: CmChildRequest, opts: { timeoutMs: number }): Promise<CmOpOutcome | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const body = req.events !== undefined && req.events.length > 0 ? JSON.stringify({ events: req.events }) : undefined
    const proc = Bun.spawn(spawnArgv([...cmCliArgv(), ...cmChildArgs(req)]), {
      stdin: body !== undefined ? new Blob([body]) : 'ignore', stdout: 'pipe', stderr: 'ignore', cwd: childCwd(), env: { ...process.env },
    })
    let timedOut = false
    timer = setTimeout(() => { timedOut = true; try { proc.kill() } catch {  } }, opts.timeoutMs)
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return timedOut ? undefined : parseCmOutcome(out)
  } catch (e) {
    log('warn', `context-mode: the session ${req.op} child failed`, { error: e })
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

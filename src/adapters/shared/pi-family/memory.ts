import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../../../core/events'
import type { SpoolEntry } from '../../../core/memory/spool'
import type { MemoryStatus } from '../../../core/memory/status'
import * as paths from '../../../engine/paths'
import { log } from '../../../engine/log'
import { run } from '../../../engine/proc'
import { shimLaunch } from '../../../engine/shim'
import { appendSpool as memoryAppendSpool } from '../../../memory/spool'
import { promptSeen as memoryPromptSeen, sessionStart as memorySessionStart } from '../../../memory/session-record'
import { uiBuildId } from '../../../memory/ui-build'
import { sessionClosed, sessionOpened, sessionSeen, startUiSoon } from '../../../memory/ui-presence'

export type { SpoolEntry }

export interface MemoryBridge {
  appendSpool(sid: string, entries: SpoolEntry[]): Promise<void>
  promptSeen?(sid: string): void
  sessionStart(sid: string, cwd: string): Promise<void>
  spawnFinalizer(sid: string): Promise<void>
  contextText(cwd: string): Promise<string | undefined>
  writeHandoff(sid: string, cwd: string, note: { slug: string, markdown: string, branch?: string }): Promise<string | undefined>
  /** The memory web UI's session record and start (memory.ui.autostart), independent of the capture. */
  ui?: UiBridge
}

export interface UiBridge {
  started(sid: string): void
  seen(sid: string): void
  ended(sid: string): void
}

export interface MemoryBridgeOptions {
  /** The harness the bridge records for. */
  harness: Harness
  cli(): string[] | undefined
  append?: (h: Harness, sid: string, entries: SpoolEntry[]) => void
  spawnDetached?: (argv: string[], env?: Record<string, string>) => boolean
  /** Records a started session in this process (default: the memory module's own). */
  recordStart?: (sid: string, cwd: string) => Promise<unknown>
  touch?: (sid: string) => void
  run?: (argv: string[], opts: { timeoutMs: number, stdin?: string }) => Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>
  ui?: UiBridge
}

/** The memory UI's session record and start, in this process: a few file operations, never waits for the UI. */
export function uiBridgeFor(harness: Harness): UiBridge {
  return {
    started(sid) {
      sessionOpened(harness, sid)
      const build = uiBuildId()
      startUiSoon(build !== undefined ? { build } : {})
    },
    seen(sid) { if (sessionSeen(harness, sid) === 'revived') startUiSoon() },
    ended(sid) { sessionClosed(harness, sid) },
  }
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

export function buracleCli(shim: string, repoRoot: string | undefined): string[] | undefined {
  const viaShim = shimLaunch(shim)
  if (viaShim !== undefined) return viaShim
  const main = repoRoot !== undefined ? join(repoRoot, 'src', 'cli', 'main.ts') : undefined
  const bun = Bun.which('bun')
  return main !== undefined && bun !== null && isFile(main) ? [bun, main] : undefined
}

export function spawnDetached(argv: string[], env: Record<string, string> = {}): boolean {
  try {
    const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, ...env }, detached: true })
    p.unref()
    return true
  } catch (e) {
    log('warn', 'pi-family: detached spawn failed', { argv: argv.slice(0, 3), error: e instanceof Error ? e.message : String(e) })
    return false
  }
}

export function createMemoryBridge(opts: MemoryBridgeOptions): MemoryBridge {
  const h = opts.harness
  const append = opts.append ?? memoryAppendSpool
  const spawn = opts.spawnDetached ?? spawnDetached
  const exec = opts.run ?? ((argv: string[], o: { timeoutMs: number, stdin?: string }) => run(argv, o))
  const logged = new Set<string>()
  const once = (key: string, msg: string, data?: unknown) => {
    if (logged.has(key)) return
    logged.add(key)
    log('warn', msg, data)
  }
  const detached = (args: string[], env?: Record<string, string>) => {
    const cli = opts.cli()
    if (cli === undefined) { once('cli', 'pi-family: the buracle CLI was not found; memory capture runs without it'); return }
    spawn([...cli, ...args], env)
  }
  const recordStart = opts.recordStart ?? ((sid: string, cwd: string) => memorySessionStart(h, sid, cwd))
  const touch = opts.touch ?? ((sid: string) => { memoryPromptSeen(h, sid) })
  const ui = opts.ui ?? uiBridgeFor(h)
  const uiCall = (what: keyof UiBridge, sid: string): void => {
    try { ui[what](sid) } catch (e) { once(`ui-${what}`, `pi-family: memory ui ${what} failed`, { error: e instanceof Error ? e.message : String(e) }) }
  }
  return {
    ui: { started: sid => uiCall('started', sid), seen: sid => uiCall('seen', sid), ended: sid => uiCall('ended', sid) },
    async appendSpool(sid, entries) {
      if (entries.length === 0) return
      try { append(h, sid, entries) } catch (e) { once('spool', 'pi-family: appendSpool failed', { error: e instanceof Error ? e.message : String(e) }) }
    },
    promptSeen(sid) {
      try { touch(sid) } catch (e) { once('touch', 'pi-family: the session record was not touched', { error: e instanceof Error ? e.message : String(e) }) }
    },
    async sessionStart(sid, cwd) {
      try { await recordStart(sid, cwd) } catch (e) { once('start', 'pi-family: the session was not recorded', { error: e instanceof Error ? e.message : String(e) }) }
    },
    async spawnFinalizer(sid) {
      detached(['mem', 'finalize', '--harness', h, '--session', sid], { BURACLE_FINALIZER: '1' })
    },
    async contextText(cwd) {
      const cli = opts.cli()
      if (cli === undefined) return undefined
      const r = await exec([...cli, 'mem', 'context', '--harness', h, '--cwd', cwd, '--json'], { timeoutMs: 10_000 })
      if (r.code !== 0) { once(`context:${r.code}`, 'pi-family: `buracle mem context` failed; the session starts without memory text', { code: r.code, stderr: r.stderr.slice(0, 300) }); return undefined }
      try {
        const j = JSON.parse(r.stdout) as { text?: unknown }
        return typeof j.text === 'string' && j.text.trim() !== '' ? j.text.trim() : undefined
      } catch {
        return undefined
      }
    },
    async writeHandoff(sid, cwd, note) {
      const cli = opts.cli()
      if (cli === undefined) return undefined
      const args = [...cli, 'mem', 'handoff', '--harness', h, '--session', sid, '--cwd', cwd, '--slug', note.slug, '--trigger', 'compaction', '--json']
      if (note.branch !== undefined) args.push('--branch', note.branch)
      const r = await exec(args, { timeoutMs: 8_000, stdin: note.markdown })
      if (r.code !== 0) { once(`handoff:${r.code}`, 'pi-family: `buracle mem handoff` failed', { code: r.code, stderr: r.stderr.slice(0, 300) }); return undefined }
      try {
        const j = JSON.parse(r.stdout) as { id?: unknown }
        return typeof j.id === 'string' ? j.id : undefined
      } catch {
        return undefined
      }
    },
  }
}

function readIf(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

export function capText(text: string, maxLines: number, maxBytes: number): { text: string, truncated: boolean } {
  const lines = text.split('\n')
  const out: string[] = []
  let bytes = 0
  for (const line of lines) {
    const b = Buffer.byteLength(line, 'utf8') + 1
    if (out.length >= maxLines || bytes + b > maxBytes) return { text: out.join('\n'), truncated: true }
    out.push(line)
    bytes += b
  }
  return { text: out.join('\n'), truncated: false }
}

export function readMemoryStatus(slug: string | undefined): MemoryStatus | undefined {
  const dir = join(paths.memoryStateDir(), 'status')
  for (const name of slug !== undefined ? [`${slug}.json`, '_global.json'] : ['_global.json']) {
    const t = readIf(join(dir, name))
    if (t === undefined) continue
    try {
      const v = JSON.parse(t) as unknown
      if (v !== null && typeof v === 'object' && (v as { v?: unknown }).v === 3) return v as MemoryStatus
    } catch {  }
  }
  return undefined
}

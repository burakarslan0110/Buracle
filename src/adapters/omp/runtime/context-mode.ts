import type { BuracleConfig } from '../../../core/config'
import type { CmEvent, CmOmpToolResult } from '../../../core/context-mode'
import { cmCaptureBlocked, cmOmpEvents, cmPromptEvent } from '../../../core/context-mode'
import type { HookId, ToolCall } from '../../../core/events'
import { memExclusion } from '../../../core/memory/project'
import type { BashGuardOptions } from '../../../core/policy/bash-guard'
import { laneStateDenialAll } from '../../../core/policy/lane-guard'
import { checkSandbox, cmCall, cmReviewerDenial, cmToolOfName, looksLikeCmExecTool, sandboxShellCommands } from '../../../core/policy/sandbox'
import type { WriteGuardContext } from '../../../core/policy/write-guard'
import { cmPackage, cmProjectDir } from '../../../engine/context-mode'
import { home, isValidSessionId } from '../../../engine/paths'
import { canonicalDir, caseInsensitivePaths } from '../../../workflow/workspace'
import type { CmChildRequest } from '../../shared/context-mode/client'
import { cmRunSessionChild, cmSpawnSession } from '../../shared/context-mode/client'
import type { CmOpOutcome, CmTarget } from '../../shared/context-mode/session'

export const CM_SNAPSHOT_TIMEOUT_MS = 3_000
export const CM_RESTORE_TIMEOUT_MS = 5_000
export const CM_FLUSH_AT = 100
export const CM_RESTORE_MESSAGE_TYPE = 'buracle.context-mode-restore'
const INSTALLED_TTL_MS = 60_000

export function isCmToolName(name: unknown): boolean {
  return typeof name === 'string' && (cmToolOfName('omp', name) !== undefined || looksLikeCmExecTool(name))
}

function deviceArgs(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const content = input['content']
  if (typeof content !== 'string') return undefined
  let v: unknown
  try { v = JSON.parse(content) } catch { return undefined }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined
  const { i: _intent, ...args } = v as Record<string, unknown>
  return args
}

export function cmPinnedInput(call: ToolCall, cwd: string): Record<string, unknown> | undefined {
  const c = cmCall(call)
  if (c === undefined || (c.tool !== 'ctx_execute' && c.tool !== 'ctx_batch_execute')) return undefined
  if (c.input['cwd'] !== undefined || typeof cwd !== 'string' || cwd === '') return undefined
  return { ...c.input, cwd }
}

export interface CmGuardEnv {
  bash(): BashGuardOptions
  write(): WriteGuardContext
  serverDir(): string
  cwd: string
  agent: string | undefined
  device: boolean
  consent(commands: string[]): string | undefined
  closed(hook: 'H01' | 'H02', fn: () => { deny?: string }): { deny?: string }
  lane?: boolean
}

export interface CmGuardResult {
  deny?: string
  hook?: HookId
  input?: Record<string, unknown>
}

export function cmGuard(call: ToolCall, env: CmGuardEnv): CmGuardResult | undefined {
  if (cmCall(call) === undefined) return undefined
  let judged = call
  if (env.device) {
    const args = deviceArgs(call.input)
    if (args === undefined) return {}
    judged = { ...call, input: args }
  }
  let hook: 'H01' | 'H02' = 'H01'
  const r = env.closed('H01', () => {
    const v = checkSandbox(judged, { bash: env.bash(), write: env.write(), serverDir: env.serverDir(), pinnedDir: env.cwd })
    if (v.hook === 'H02') hook = 'H02'
    return v
  })
  if (r.deny !== undefined) return { deny: r.deny, hook }
  const reviewer = env.closed('H01', () => {
    const d = cmReviewerDenial(env.agent, judged)
    return d !== undefined ? { deny: d } : {}
  })
  if (reviewer.deny !== undefined) return { deny: reviewer.deny, hook: 'H01' }
  const lane = env.lane === true ? laneStateDenialAll(sandboxShellCommands(judged)) : undefined
  if (lane !== undefined) return { deny: lane, hook: 'H01' }
  if (env.device) return {}
  const consent = env.consent(sandboxShellCommands(judged))
  if (consent !== undefined) return { deny: consent, hook: 'H20' }
  const input = cmPinnedInput(judged, env.cwd)
  return input !== undefined ? { input } : {}
}

export interface CmDeps {
  projectDir(): string
  installed(): boolean
  spawn(req: CmChildRequest): boolean
  run(req: CmChildRequest, opts: { timeoutMs: number }): Promise<CmOpOutcome | undefined>
  env(): Readonly<Record<string, string | undefined>>
}

const LOAD_CWD: string | undefined = (() => {
  try { return process.cwd() } catch { return undefined }
})()

export function defaultCmDeps(now: () => number = Date.now): CmDeps {
  let dir: string | undefined
  let known: { at: number, value: boolean } | undefined
  return {
    projectDir: () => (dir ??= cmProjectDir('omp', { cwd: LOAD_CWD ?? process.cwd() })),
    installed: () => {
      const t = now()
      if (known === undefined || t - known.at > INSTALLED_TTL_MS) known = { at: t, value: cmPackage() !== undefined }
      return known.value
    },
    spawn: req => cmSpawnSession(req),
    run: (req, opts) => cmRunSessionChild(req, opts),
    env: () => process.env,
  }
}

export interface CmBridgeHost {
  deps: CmDeps
  config(): BuracleConfig
  report(what: string, e: unknown): void
  send(text: string): void
}

export function cmFolderExclusion(dir: string, patterns: readonly string[]): string | undefined {
  if (patterns.length === 0) return undefined
  return memExclusion({ dirs: [...new Set([dir, canonicalDir(dir)])] }, patterns, { home: canonicalDir(home()), caseInsensitive: caseInsensitivePaths() })
}

export interface CmBridge {
  blocked(): string | undefined
  prompt(sid: string, text: string): void
  toolResult(sid: string, e: CmOmpToolResult, opts: { cwd: string, paths?: readonly string[] }): void
  flush(sid: string): void
  startup(sid: string): void
  beforeCompaction(sid: string): Promise<string | undefined>
  afterCompaction(sid: string, sent: boolean): void
  resume(sid: string): void
}

interface CmSession {
  events: CmEvent[]
  started?: boolean
  resumed?: boolean
  compaction?: { answered: boolean, text?: string }
}

export function createCmBridge(host: CmBridgeHost): CmBridge {
  const sessions = new Map<string, CmSession>()
  const session = (sid: string): CmSession => {
    let s = sessions.get(sid)
    if (s === undefined) { s = { events: [] }; sessions.set(sid, s) }
    return s
  }
  const target = (sid: string): CmTarget => ({ harness: 'omp', sessionId: sid, projectDir: host.deps.projectDir() })
  const excluded = (patterns: readonly string[]): string | undefined => {
    if (patterns.length === 0) return undefined
    try { return cmFolderExclusion(host.deps.projectDir(), patterns) } catch { return undefined }
  }
  const blocked = (): string | undefined => {
    const config = host.config()
    const why = cmCaptureBlocked({ config, env: host.deps.env() }) ?? excluded(config.memory.exclude)
    if (why !== undefined) return why
    return host.deps.installed() ? undefined : 'context-mode is not installed in the toolchain'
  }
  const safe = (what: string, fn: () => void): void => {
    try { fn() } catch (e) { host.report(what, e) }
  }
  const spawn = (req: CmChildRequest): void => {
    if (!host.deps.spawn(req)) host.report(`H27 ${req.op}`, new Error('the `buracle ctx session` child did not start'))
  }
  const textOf = (out: CmOpOutcome | undefined): string | undefined => (out?.ok === true && typeof out.text === 'string' && out.text.trim() !== '' ? out.text : undefined)

  const flush = (sid: string): void => {
    const s = sessions.get(sid)
    if (s === undefined || s.events.length === 0) return
    const events = s.events
    s.events = []
    if (blocked() !== undefined) return
    spawn({ op: 'capture', target: target(sid), events })
  }
  const add = (sid: string, events: readonly CmEvent[]): void => {
    if (events.length === 0 || !isValidSessionId(sid)) return
    const s = session(sid)
    s.events.push(...events)
    if (s.events.length >= CM_FLUSH_AT) flush(sid)
  }
  const restoreLater = (req: CmChildRequest, eventsFile: boolean): void => {
    host.deps.run(req, { timeoutMs: CM_RESTORE_TIMEOUT_MS }).then(out => {
      const text = textOf(out)
      if (out === undefined) host.report(`H27 ${req.op}`, new Error(`no answer within ${CM_RESTORE_TIMEOUT_MS} ms`))
      if (text === undefined) return
      host.send(text)
      if (eventsFile) spawn({ op: 'restore', target: req.target, source: 'compact' })
    }).catch(e => host.report(`H27 ${req.op}`, e))
  }

  return {
    blocked,
    prompt(sid, text) {
      safe('H27 prompt', () => {
        if (blocked() !== undefined) return
        const ev = cmPromptEvent(text)
        if (ev !== undefined) add(sid, [ev])
      })
    },
    toolResult(sid, e, opts) {
      safe('H27 tool result', () => {
        if (blocked() !== undefined) return
        add(sid, cmOmpEvents(e, opts))
      })
    },
    flush(sid) {
      safe('H27 flush', () => flush(sid))
    },
    startup(sid) {
      safe('H27 startup', () => {
        if (!isValidSessionId(sid)) return
        const s = session(sid)
        if (s.started === true || blocked() !== undefined) return
        s.started = true
        spawn({ op: 'startup', target: target(sid) })
      })
    },
    async beforeCompaction(sid) {
      try {
        if (!isValidSessionId(sid)) return undefined
        const s = session(sid)
        const events = s.events
        s.events = []
        s.compaction = undefined
        if (blocked() !== undefined) return undefined
        const out = await host.deps.run({ op: 'snapshot', target: target(sid), events }, { timeoutMs: CM_SNAPSHOT_TIMEOUT_MS })
        if (out === undefined) {
          host.report('H27 snapshot', new Error(`no answer within ${CM_SNAPSHOT_TIMEOUT_MS} ms`))
          return undefined
        }
        const text = textOf(out)
        s.compaction = text !== undefined ? { answered: true, text } : { answered: true }
        return text
      } catch (e) {
        host.report('H27 snapshot', e)
        return undefined
      }
    },
    afterCompaction(sid, sent) {
      safe('H27 after compaction', () => {
        if (!isValidSessionId(sid)) return
        const s = session(sid)
        const c = s.compaction
        s.compaction = undefined
        if (blocked() !== undefined) return
        const eventsFile: CmChildRequest = { op: 'restore', target: target(sid), source: 'compact' }
        if (sent) { spawn(eventsFile); return }
        if (c?.answered === true) {
          if (c.text === undefined) return
          host.send(c.text)
          spawn(eventsFile)
          return
        }
        const events = s.events
        s.events = []
        restoreLater({ op: 'snapshot', target: target(sid), events }, true)
      })
    },
    resume(sid) {
      safe('H27 resume', () => {
        if (!isValidSessionId(sid)) return
        const s = session(sid)
        if (s.resumed === true || blocked() !== undefined) return
        s.resumed = true
        restoreLater({ op: 'restore', target: target(sid), source: 'resume' }, false)
      })
    },
  }
}

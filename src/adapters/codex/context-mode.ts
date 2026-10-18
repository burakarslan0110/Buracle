import type { BuracleConfig } from '../../core/config'
import * as core from '../../core/index'
import type { Harness, ToolCall } from '../../core/events'
import { normalizePath } from '../../core/events'
import type { BashGuardOptions } from '../../core/policy/bash-guard'
import type { CmCall } from '../../core/policy/sandbox'
import type { WriteGuardContext } from '../../core/policy/write-guard'
import { cmProjectDir } from '../../engine/context-mode'
import { log } from '../../engine/log'
import { consentGateAll } from '../shared/consent-store'
import type { CmBridgeOptions, CmForwardResult } from '../shared/context-mode/bridge'
import { denyReason, errText, rec, step, str, type Payload } from './hook-io'
import { shellApplyPatch } from './shell-patch'

type CoreFns = typeof core
const H: Harness = 'codex'
const EV = 'PreToolUse'

export interface ContextModeFns {
  forward?: (event: string, payload: Payload, opts: CmBridgeOptions) => Promise<CmForwardResult>
  prune?: (nowMs: number) => unknown
}

export async function loadContextModeFns(): Promise<ContextModeFns> {
  const out: ContextModeFns = {}
  try {
    const { cmForward } = await import('../shared/context-mode/bridge')
    out.forward = (event, payload, opts) => cmForward('codex', event, payload, opts)
  } catch (e) {
    log('warn', 'codex hook: the context-mode session bridge is unavailable', { error: e })
  }
  try {
    out.prune = (await import('../shared/context-mode/maint')).cmPrune
  } catch (e) {
    log('warn', 'codex hook: the context-mode housekeeping is unavailable', { error: e })
  }
  return out
}

function quote(s: string): string {
  return '`' + s.replace(/`/g, "'").slice(0, 80) + '`'
}

export function cmGuardFailed(e: unknown): string {
  return denyReason('H01', `the guards could not check this context-mode call (${errText(e)}), so it is blocked: Buracle's guards fail closed. Run the step in the shell, where the guards see it, or have the user check \`buracle doctor\`.`)
}

export function isContextModeName(tool: string): boolean {
  return core.looksLikeCmExecTool(tool) || core.cmToolOfName(H, tool) !== undefined
}

export function cmClassifyFailed(tool: string, e: unknown): string | undefined {
  return isContextModeName(tool) ? cmGuardFailed(e) : undefined
}

export function sandboxPatchDenial(commands: readonly string[]): string | undefined {
  for (const command of commands) {
    const sp = shellApplyPatch(command)
    if (sp.kind === 'none') continue
    return `context-mode's sandbox would run Codex's apply_patch${sp.kind === 'opaque' ? ` (${sp.why})` : ''}, which writes files where the write guard cannot check them; make the change with the apply_patch tool instead.`
  }
  return undefined
}

export interface CmGuardInput {
  payload: Payload
  call: ToolCall
  sid: string
  cwd: string
  core: CoreFns
  now: number
  bash: () => BashGuardOptions
  write: () => Promise<WriteGuardContext>
  lane?: boolean
}

export async function contextModeDenial(i: CmGuardInput): Promise<string | undefined> {
  const tool = typeof i.call.tool === 'string' ? i.call.tool : ''
  try {
    let cm: CmCall | undefined
    try {
      cm = i.core.cmCall(i.call)
    } catch (e) {
      log('error', 'codex hook PreToolUse: cannot read a context-mode call; denying (fail closed)', { tool, error: e })
      return cmClassifyFailed(tool, e)
    }
    if (cm === undefined) {
      if (!core.looksLikeCmExecTool(tool)) return undefined
      log('warn', 'codex hook PreToolUse: a context-mode execution tool outside Buracle\'s server; denying', { tool })
      return denyReason('H01', `${quote(tool)} looks like a context-mode execution tool, but not one of Buracle's context-mode server, so the guards cannot check what it would run. Use Buracle's \`mcp__context_mode__\` tools or the shell (\`buracle doctor context-mode\` lists other context-mode installs).`)
    }
    let commands: string[] = []
    try {
      const verdict = i.core.checkSandbox(i.call, { bash: i.bash(), write: await i.write(), serverDir: cmProjectDir(H, { cwd: i.cwd }) })
      if (verdict.deny !== undefined) return denyReason(verdict.hook ?? 'H01', verdict.deny)
      commands = i.core.sandboxShellCommands(i.call)
      const patch = sandboxPatchDenial(commands)
      if (patch !== undefined) return denyReason('H02', patch)
    } catch (e) {
      log('error', 'codex hook PreToolUse: the context-mode guard failed; denying (fail closed)', { tool, error: e })
      return cmGuardFailed(e)
    }
    const agentType = str(i.payload['agent_type'])
    try {
      const reviewer = i.core.cmReviewerDenial(agentType, i.call)
      if (reviewer !== undefined) return reviewer
    } catch (e) {
      log('error', 'codex hook PreToolUse: the reviewer check of a context-mode call failed', { tool, agentType, error: e })
      if (agentType !== undefined) return cmGuardFailed(e)
    }
    const lane = i.lane === true ? await step(EV, 'H01 lane guard (context-mode)', undefined as string | undefined, () => i.core.laneStateDenialAll(commands)) : undefined
    if (lane !== undefined) return lane
    const consent = await step(EV, 'H20 consent (context-mode)', undefined as string | undefined, () => consentGateAll(H, i.sid, commands, i.now, i.core.consentVerdictAll))
    return consent !== undefined ? denyReason('H20', consent) : undefined
  } catch (e) {
    log('error', 'codex hook PreToolUse: the context-mode guards failed', { tool, error: e })
    return cmClassifyFailed(tool, e)
  }
}

export interface CmForwardInput {
  config: BuracleConfig
  env: Readonly<Record<string, string | undefined>>
  load: (() => Promise<ContextModeFns>) | undefined
  maxBytes?: number
}

export async function contextModeForward(event: string, payload: Payload, o: CmForwardInput): Promise<CmForwardResult | undefined> {
  const load = o.load
  if (load === undefined) return undefined
  return step(event, 'H27 context-mode', undefined as CmForwardResult | undefined, async () => {
    const forward = (await load()).forward
    if (forward === undefined) return undefined
    const opts: CmBridgeOptions = { config: o.config, env: o.env }
    if (o.maxBytes !== undefined) opts.maxBytes = o.maxBytes
    return forward(event, payload, opts)
  })
}

export async function contextModePrune(load: (() => Promise<ContextModeFns>) | undefined, nowMs: number): Promise<void> {
  if (load === undefined) return
  await step('SessionStart', 'H16 context-mode prune', undefined, async () => { (await load()).prune?.(nowMs) })
}

function anchorHeaders(body: string, cd: string | undefined): string {
  if (cd === undefined || !cd.startsWith('/')) return body
  const base = normalizePath(cd)
  return body.replace(/^([ \t]*\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*)(\S.*?)[ \t]*$/gm, (line: string, head: string, path: string) => (path.startsWith('/') ? line : `${head}${normalizePath(`${base}/${path}`)}`))
}

export function bridgePostPayload(p: Payload): Payload | undefined {
  if (p['tool_name'] !== 'Bash') return p
  const sp = shellApplyPatch(rec(p['tool_input'])['command'])
  if (sp.kind === 'none') return p
  if (sp.kind === 'opaque') return undefined
  return { ...p, tool_name: 'apply_patch', tool_input: { command: anchorHeaders(sp.body, sp.cd) } }
}

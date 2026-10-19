import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { CONSENT_RUN_REASON } from '../../core/policy/self-disable'
import { valueHash } from '../../engine/merge'
import { dropAnsweredAsks, markConsentAsked, postConsentAsk, unaskedConsent } from '../shared/consent-asks'
import type { AdapterContext } from '../registry'
import { BYPASS_APPROVAL_POLICY } from './config'
import { CONSENT_RUN, literalProgram } from './execpolicy'
import { json, NOTHING, rec, str, type HookOutcome, type Payload } from './hook-io'
import { callAnswered, readTail } from './rollout'
import { isSubagentPayload } from './subagents'

const H = 'codex' as const

export const MAX_PROMPT_COMMAND = 8_000
const PROMPT_SHELLS = new Set(['bash', 'zsh', 'sh'])

export function singleQuoted(text: string): string {
  return `'${text.replace(/'/g, `'"'"'`)}'`
}

export function consentRunCommand(shim: string, id: string, command: string): string {
  return `${shim} ${CONSENT_RUN.join(' ')} ${id} ${singleQuoted(command)}`
}

export function parseConsentRun(command: string): { id: string, quoted: string } | undefined {
  const m = /^(\S+) consent run ([a-f0-9]{12,64}) ('[\s\S]*')$/.exec(command)
  if (m === null || basename(m[1] as string) !== 'buracle') return undefined
  return { id: m[2] as string, quoted: m[3] as string }
}

export function unquoteSingle(quoted: string): string | undefined {
  let out = ''
  let i = 0
  while (i < quoted.length) {
    if (quoted[i] === "'") {
      const end = quoted.indexOf("'", i + 1)
      if (end < 0) return undefined
      out += quoted.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (quoted.startsWith(`"'"`, i)) { out += "'"; i += 3; continue }
    return undefined
  }
  return out
}

export interface PromptEnv { platform: string, shell: string | undefined }

export function userAnswersApprovals(ctx: Pick<AdapterContext, 'paths'>): boolean {
  let text: string
  try {
    text = readFileSync(join(ctx.paths.codexHome(), 'config.toml'), 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
  try {
    const toml = Bun.TOML.parse(text) as Record<string, unknown>
    const active = str(toml['profile'])
    const reviewer = rec(rec(toml['profiles'])[active ?? ''])['approvals_reviewer'] ?? toml['approvals_reviewer']
    return reviewer === undefined || reviewer === 'user'
  } catch {
    return false
  }
}

export function canPromptConsent(p: Payload, ctx: Pick<AdapterContext, 'buracleBin' | 'paths'>, command: string, env: PromptEnv): boolean {
  if (isSubagentPayload(p) || str(p['permission_mode']) === 'bypassPermissions' || str(p['permission_mode']) === undefined) return false
  if (!userAnswersApprovals(ctx)) return false
  if (env.platform === 'win32' || !literalProgram(ctx.buracleBin)) return false
  if (env.shell !== undefined && env.shell !== '' && !PROMPT_SHELLS.has(basename(env.shell))) return false
  return command.length <= MAX_PROMPT_COMMAND && !command.includes('\u0000')
}

export function consentPromptInput(p: Payload, sid: string, command: string, ctx: Pick<AdapterContext, 'buracleBin' | 'paths'>, now: number, id: string, env: PromptEnv): Record<string, unknown> | undefined {
  if (!canPromptConsent(p, ctx, command, env) || unaskedConsent(sid, command, now)) return undefined
  if (postConsentAsk(H, sid, command, id, now, str(p['tool_use_id'])) === undefined) return undefined
  return { ...rec(p['tool_input']), command: consentRunCommand(ctx.buracleBin, id, command) }
}

export const UNKNOWN_CONSENT_RUN = `Buracle H20: ${CONSENT_RUN_REASON}`

export function settleConsentAsks(sid: string, rollout: string | undefined, turnOver: boolean): number {
  let text: string | undefined
  let read = false
  return dropAnsweredAsks(sid, r => {
    if (turnOver || r.call === undefined || rollout === undefined) return true
    if (!read) { text = readTail(rollout); read = true }
    return text === undefined || callAnswered(text, r.call)
  })
}

function decision(behavior: 'allow' | 'deny', message?: string): HookOutcome {
  return json({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: message !== undefined ? { behavior, message } : { behavior } } })
}

export function buracleApprovalPolicy(ctx: Pick<AdapterContext, 'paths'>): boolean {
  try {
    const toml = Bun.TOML.parse(readFileSync(join(ctx.paths.codexHome(), 'config.toml'), 'utf8')) as Record<string, unknown>
    return toml['approval_policy'] !== undefined && valueHash(toml['approval_policy']) === valueHash(BYPASS_APPROVAL_POLICY)
  } catch {
    return false
  }
}

export function onPermissionRequest(p: Payload, sid: string, ctx: Pick<AdapterContext, 'config' | 'paths'>, now: number): HookOutcome {
  const tool = str(p['tool_name']) ?? ''
  if (tool.startsWith('mcp__')) return ctx.config.permissions.bypass && buracleApprovalPolicy(ctx) ? decision('allow') : NOTHING
  if (tool !== 'Bash') return NOTHING
  const command = str(rec(p['tool_input'])['command'])
  const parsed = command !== undefined ? parseConsentRun(command) : undefined
  if (command === undefined || parsed === undefined) return NOTHING
  const inner = unquoteSingle(parsed.quoted)
  if (inner !== undefined && markConsentAsked(parsed.id, sid, inner, now)) return NOTHING
  return decision('deny', UNKNOWN_CONSENT_RUN)
}

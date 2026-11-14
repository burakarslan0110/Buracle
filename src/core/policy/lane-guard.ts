import { visitShellCommands } from './bash-guard'
import { codeLang, scanCode } from './code-scan'
import { buracleArgs } from './self-disable'

export const LANE_PLAN_COMMANDS: readonly string[] = ['pause', 'resume', 'set', 'complete', 'verify', 'register', 'unregister', 'approve-result', 'review', 'prepare-native']
export const LANE_FLOW_COMMANDS: readonly string[] = ['start', 'phase', 'end']
export const LANE_WORKTREE_COMMANDS: readonly string[] = ['sync', 'cleanup']

const LANE_VALUE_FLAGS: readonly string[] = ['session', 'harness', 'kind', 'reason', 'phase', 'base', 'prefix', 'slug', 'type', 'title', 'dir', 'outcome', 'note', 'done', 'total', 'lane', 'role', 'handle', 'provider', 'verdict', 'on', 'input', 'goal', 'timeout-min', 'wait', 'job']
const MENTIONS_BURACLE = /buracle|src\/cli\/main\.ts|bin\/buracle/

function positionals(args: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--') { out.push(...args.slice(i + 1)); break }
    if (!a.startsWith('-')) { out.push(a); continue }
    if (a.startsWith('--') && !a.includes('=') && LANE_VALUE_FLAGS.includes(a.slice(2))) i++
  }
  return out
}

function flagGiven(args: readonly string[], name: string): boolean {
  const end = args.indexOf('--')
  const flags = end < 0 ? args : args.slice(0, end)
  return flags.some((a, i) => (a === `--${name}` && !(flags[i + 1] ?? '-').startsWith('-')) || (a.startsWith(`--${name}=`) && a.length > name.length + 3))
}

function userApproval(sub: string, rest: readonly string[]): boolean {
  return sub === 'approve-result' || (sub === 'set' && rest[0] === 'approved')
}

function stateCommand(args: readonly string[]): string | undefined {
  const [group, sub, ...rest] = positionals(args)
  if (sub === undefined) return undefined
  if (group === 'plan' && LANE_PLAN_COMMANDS.includes(sub)) {
    if (sub === 'review' && rest[0] === 'status') return undefined
    const approval = userApproval(sub, rest)
    if (!approval && flagGiven(args, 'lane') && !flagGiven(args, 'session')) return undefined
    return `buracle plan ${sub}${approval && sub === 'set' ? ' approved' : ''}`
  }
  if (group === 'flow' && LANE_FLOW_COMMANDS.includes(sub)) return `buracle flow ${sub}`
  if (group === 'worktree' && LANE_WORKTREE_COMMANDS.includes(sub)) return `buracle worktree ${sub}`
  return undefined
}

export function laneStateDenial(command: string): string | undefined {
  if (typeof command !== 'string' || !MENTIONS_BURACLE.test(command)) return undefined
  let hit: string | undefined
  visitShellCommands(command, argv => {
    const args = buracleArgs(argv)
    hit = args !== undefined ? stateCommand(args) : undefined
    return hit !== undefined
  })
  if (hit === undefined) return undefined
  return `Buracle lane guard: a lane (subagent) does not run \`${hit}\`, because the plan, the workflow state and the worktree merges belong to the lead. Return status \`blocked\` with the question and its options; the lead asks the user and changes the state. Read-only commands such as \`buracle plan status\`, \`buracle plan review status\` and \`buracle plan validate\` stay allowed, and so does a plan lane's own binding: \`buracle plan <command> --lane <slug>\` for the lane worktree the lead created (the user's approvals, \`set approved\` and \`approve-result\`, stay with the lead).`
}

export function laneStateDenialAll(commands: readonly string[]): string | undefined {
  try {
    for (const c of Array.isArray(commands) ? commands : []) {
      const d = laneStateDenial(c)
      if (d !== undefined) return d
    }
  } catch {
    return undefined
  }
  return undefined
}

export function laneCodeDenial(code: string, language: string): string | undefined {
  if (typeof code !== 'string' || !MENTIONS_BURACLE.test(code)) return undefined
  try {
    return laneStateDenialAll(scanCode(code, codeLang(typeof language === 'string' ? language : 'js')).flatMap(s => s.kind === 'shell' ? [s.command] : []))
  } catch {
    return undefined
  }
}
